import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from cloud_embedding_cache import CloudEmbeddingCache


class CompletedVectorCacheTests(unittest.TestCase):
    def test_completed_rows_survive_interruption_and_source_order_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            scope = {"model": {"id": "fixture", "revision": "1"}, "contract": "one"}
            first = hashlib.sha256(b"first").hexdigest()
            second = hashlib.sha256(b"second").hexdigest()
            raw = struct.pack("<ff", 0.25, 0.75)
            writer = CloudEmbeddingCache(directory, scope, 2)
            writer.save(first, raw)
            # An interrupted write of the next row is never a completed entry.
            writer.path(second).with_suffix(".tmp").write_text("partial")
            resumed = CloudEmbeddingCache(directory, scope, 2)
            self.assertIsNone(resumed.load(second))
            self.assertEqual(resumed.load(first), raw)
            for changed in ({**scope, "contract": "two"}, {**scope, "model": {"id":"fixture", "revision":"2"}}):
                self.assertIsNone(CloudEmbeddingCache(directory, changed, 2).load(first))
            self.assertIsNone(CloudEmbeddingCache(directory, scope, 3).load(first))

    def test_corrupted_completed_row_is_rejected_without_deleting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = CloudEmbeddingCache(directory, {"model":"fixture"}, 2)
            key = hashlib.sha256(b"text").hexdigest()
            cache.save(key, struct.pack("<ff", 1, 0))
            file = cache.path(key)
            payload = json.loads(file.read_text())
            payload["vectorSha256"] = "0" * 64
            file.write_text(json.dumps(payload))
            with self.assertRaisesRegex(RuntimeError, "cached_vector_binding_invalid"):
                cache.load(key)
            self.assertTrue(file.exists())


if __name__ == "__main__":
    unittest.main()
