import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('embedding progress is saved before job termination and restored by the next run', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sync-data.yml',import.meta.url),'utf8');
  const python = await readFile(new URL('../scripts/embed-missing-cloud-evidence.py',import.meta.url),'utf8');
  const restore = workflow.indexOf('uses: actions/cache/restore@');
  const compute = workflow.indexOf('id: cloud_sync');
  const save = workflow.indexOf('uses: actions/cache/save@');
  assert.ok(restore >= 0 && restore < compute && compute < save);
  const saveStep = workflow.slice(workflow.lastIndexOf('- name:', save), save);
  assert.match(saveStep, /always\(\)/);
  assert.match(workflow, /CLOUD_EMBED_CACHE_DIR:/);
  assert.match(workflow, /CLOUD_EMBED_MAX_SECONDS:/);
  assert.match(python, /cache\.save\(/);
  assert.match(python, /cache\.load\(/);
});
