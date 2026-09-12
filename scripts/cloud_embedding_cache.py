"""Persist completed vectors across interrupted synchronization jobs.

Mechanical invariant: a cached row belongs to the same model revision, input
contract, dimension and source-text hash, and its serialized bytes are intact.
The namespace, row identity, byte count and checksum are directly observable;
no evidence meaning is assessed. A false rejection stops this sync and retains
the files. Existing final-index checks cannot validate a partial job cache.
"""
import base64
import hashlib
import json
import os
from pathlib import Path


class CloudEmbeddingCache:
    def __init__(self, directory, scope, dimension):
        self.dimension = dimension
        key = json.dumps({"format": 1, "scope": scope, "dimension": dimension},
                         ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        self.directory = Path(directory) / hashlib.sha256(key.encode()).hexdigest() if directory else None
        if self.directory:
            self.directory.mkdir(parents=True, exist_ok=True)

    def path(self, text_hash):
        if len(text_hash) != 64 or any(c not in "0123456789abcdef" for c in text_hash):
            raise RuntimeError("cloud_sync_cached_text_hash_invalid")
        return self.directory / f"{text_hash}.json"

    def load(self, text_hash):
        if not self.directory:
            return None
        file = self.path(text_hash)
        if not file.exists():
            return None
        try:
            record = json.loads(file.read_text(encoding="utf-8"))
            raw = base64.b64decode(record["vector"], validate=True)
            if record["textSha256"] != text_hash or len(raw) != self.dimension * 4 \
                    or hashlib.sha256(raw).hexdigest() != record["vectorSha256"]:
                raise ValueError("row binding")
            return raw
        except (KeyError, ValueError, TypeError) as error:
            raise RuntimeError("cloud_sync_cached_vector_binding_invalid") from error

    def save(self, text_hash, raw):
        if not self.directory:
            return
        if len(raw) != self.dimension * 4:
            raise RuntimeError("cloud_sync_cached_vector_size_invalid")
        file = self.path(text_hash)
        temporary = file.with_suffix(".tmp")
        record = {"textSha256": text_hash, "vectorSha256": hashlib.sha256(raw).hexdigest(),
                  "vector": base64.b64encode(raw).decode("ascii")}
        temporary.write_text(json.dumps(record, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, file)
