import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('progress',Path(__file__).parents[1]/'scripts/cloud_embedding_progress.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ProgressTests(unittest.TestCase):
    def test_atomic_counts(self):
        with tempfile.TemporaryDirectory() as d:
            file=Path(d)/'progress.json'
            module.save_progress(file,total=100,cached=40,computed=20,status='paused_time')
            row=json.loads(file.read_text())
            self.assertEqual(row['remainingRows'],40)
            self.assertEqual(row['status'],'paused_time')
            self.assertFalse(file.with_suffix('.tmp').exists())
    def test_invalid_counts(self):
        with self.assertRaises(ValueError):module.save_progress('unused',total=2,cached=2,computed=1,status='running')
    def test_disabled(self):
        module.save_progress(None,total=1,cached=0,computed=1,status='complete')

if __name__=='__main__':unittest.main()
