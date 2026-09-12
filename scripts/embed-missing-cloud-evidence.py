import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as functional
from transformers import AutoModel, AutoTokenizer
from cloud_embedding_cache import CloudEmbeddingCache

MODEL_ID = "Qwen/Qwen3-Embedding-0.6B"
MODEL_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"


def fail(code):
    raise RuntimeError(code)


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def last_token_pool(hidden, attention_mask):
    if bool(attention_mask[:, -1].sum() == attention_mask.shape[0]):
        return hidden[:, -1]
    lengths = attention_mask.sum(dim=1) - 1
    return hidden[torch.arange(hidden.shape[0]), lengths]


def finish_output(output, destination):
    output.flush()
    raw = np.asarray(output, dtype="<f4").tobytes(order="C")
    Path(destination).write_bytes(raw)
    output._mmap.close()
    Path(f"{destination}.npy").unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding="utf-8"))
    contract = request.get("inputContract") or {}
    if request.get("schemaVersion") != 1 or request.get("model") != {
        "id": MODEL_ID, "revision": MODEL_REVISION
    }:
        fail("cloud_sync_embedding_model_binding_invalid")
    if request.get("inputContractSha256") != sha256_text(canonical_json(contract)):
        fail("cloud_sync_embedding_contract_hash_invalid")
    if contract.get("tokenizerPaddingSide") != "left" \
            or contract.get("pooling") != "last_non_padding_token" \
            or contract.get("normalization") != "l2" \
            or contract.get("vectorDtype") != "float32":
        fail("cloud_sync_embedding_contract_unsupported")
    rows = request.get("rows")
    if not isinstance(rows, list) or not rows:
        fail("cloud_sync_embedding_rows_invalid")
    texts = []
    for row in rows:
        text = row.get("text")
        if not isinstance(text, str) or sha256_text(text) != row.get("textSha256"):
            fail("cloud_sync_embedding_text_binding_invalid")
        texts.append(text)

    dimension = request["dimension"]
    if not isinstance(dimension, int) or dimension <= 0:
        fail("cloud_sync_embedding_dimension_invalid")
    cache = CloudEmbeddingCache(os.environ.get("CLOUD_EMBED_CACHE_DIR"),
                               {"model": request["model"], "contract": request["inputContractSha256"]}, dimension)
    output = np.lib.format.open_memmap(
        f"{args.output}.npy", mode="w+", dtype=np.float32, shape=(len(texts), dimension)
    )
    pending = []
    for index, row in enumerate(rows):
        cached = cache.load(row["textSha256"])
        if cached is None:
            pending.append(index)
        else:
            output[index] = np.frombuffer(cached, dtype="<f4")
    print(f"cloud-embedding-cache:reused={len(texts)-len(pending)} pending={len(pending)}", flush=True)
    if not pending:
        finish_output(output, args.output)
        return
    started = time.monotonic()
    max_seconds = float(os.environ.get("CLOUD_EMBED_MAX_SECONDS", "0"))
    torch.set_num_threads(max(1, int(os.environ.get("CLOUD_EMBED_CPU_THREADS", os.cpu_count() or 2))))
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID, revision=MODEL_REVISION, padding_side="left", trust_remote_code=False
    )
    model = AutoModel.from_pretrained(
        MODEL_ID, revision=MODEL_REVISION, trust_remote_code=False,
        torch_dtype=torch.float32, low_cpu_mem_usage=True, attn_implementation="sdpa"
    )
    model.eval()
    if int(model.config.hidden_size) != dimension:
        fail("cloud_sync_embedding_dimension_mismatch")
    max_length = int(contract.get("tokenizerMaxLength") or 8192)
    batch_size = max(1, int(os.environ.get("CLOUD_EMBED_BATCH_SIZE", "8")))
    # Length grouping reduces batch padding without changing any input text.
    # Write each vector back to its original request row before serialization.
    row_order = sorted(pending, key=lambda index: len(texts[index]))
    for start in range(0, len(pending), batch_size):
        if max_seconds and time.monotonic() - started >= max_seconds:
            print("cloud_sync_embedding_checkpoint_saved:resume_next_run", flush=True)
            output._mmap.close()
            sys.exit(75)
        row_indices = row_order[start:start + batch_size]
        current = [texts[index] for index in row_indices]
        lengths = tokenizer(current, padding=False, truncation=False, add_special_tokens=True,
                            return_length=True)["length"]
        if any(int(value) > max_length for value in lengths):
            fail("cloud_sync_embedding_input_exceeds_max_length")
        batch = tokenizer(current, padding=True, truncation=True, max_length=max_length,
                          return_tensors="pt")
        with torch.inference_mode():
            hidden = model(**batch).last_hidden_state
            vectors = functional.normalize(last_token_pool(hidden, batch["attention_mask"]).float(), p=2, dim=1)
        output[row_indices] = vectors.numpy().astype(np.float32, copy=False)
        for index in row_indices:
            cache.save(rows[index]["textSha256"], np.asarray(output[index], dtype="<f4").tobytes())
        print(f"missing-cloud-embeddings:{start + len(current)}/{len(pending)}", flush=True)
    finish_output(output, args.output)


if __name__ == "__main__":
    main()
