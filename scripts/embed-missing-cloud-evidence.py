import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as functional
from transformers import AutoModel, AutoTokenizer

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

    torch.set_num_threads(max(1, int(os.environ.get("CLOUD_EMBED_CPU_THREADS", os.cpu_count() or 2))))
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID, revision=MODEL_REVISION, padding_side="left", trust_remote_code=False
    )
    model = AutoModel.from_pretrained(
        MODEL_ID, revision=MODEL_REVISION, trust_remote_code=False,
        torch_dtype=torch.float32, low_cpu_mem_usage=True, attn_implementation="sdpa"
    )
    model.eval()
    max_length = int(contract.get("tokenizerMaxLength") or 8192)
    batch_size = max(1, int(os.environ.get("CLOUD_EMBED_BATCH_SIZE", "8")))
    output = np.lib.format.open_memmap(
        f"{args.output}.npy", mode="w+", dtype=np.float32,
        shape=(len(texts), int(model.config.hidden_size))
    )
    # Length grouping reduces batch padding without changing any input text.
    # Write each vector back to its original request row before serialization.
    row_order = sorted(range(len(texts)), key=lambda index: len(texts[index]))
    for start in range(0, len(texts), batch_size):
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
        print(f"missing-cloud-embeddings:{start + len(current)}/{len(texts)}", flush=True)
    finish_output(output, args.output)


if __name__ == "__main__":
    main()
