import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

function verifyEmbeddingCacheSteps(workflow) {
  const steps = workflow.split(/(?=^      - name:)/m).slice(1);
  const isEmbeddingCache = step => /^\s+path: \.cache\/cloud-embeddings\s*$/m.test(step);
  const restore = steps.findIndex(step => isEmbeddingCache(step) && /uses: actions\/cache\/restore@/.test(step));
  const compute = steps.findIndex(step => /^\s+id: cloud_sync\s*$/m.test(step));
  const save = steps.findIndex(step => isEmbeddingCache(step) && /uses: actions\/cache\/save@/.test(step));
  assert.ok(restore >= 0 && restore < compute && compute < save);
  assert.match(steps[save], /^\s+if:.*always\(\)/m);
}

test('embedding progress is saved before job termination and restored by the next run', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sync-data.yml',import.meta.url),'utf8');
  const python = await readFile(new URL('../scripts/embed-missing-cloud-evidence.py',import.meta.url),'utf8');
  verifyEmbeddingCacheSteps(workflow);
  assert.match(workflow, /CLOUD_EMBED_CACHE_DIR:/);
  assert.match(workflow, /CLOUD_EMBED_MAX_SECONDS:/);
  assert.match(python, /cache\.save\(/);
  assert.match(python, /cache\.load\(/);
});

test('other caches cannot hide missing or misordered embedding cache steps', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sync-data.yml',import.meta.url),'utf8');
  const steps = workflow.split(/(?=^      - name:)/m);
  const restore = steps.findIndex(step => /uses: actions\/cache\/restore@/.test(step) && step.includes('path: .cache/cloud-embeddings'));
  const save = steps.findIndex(step => /uses: actions\/cache\/save@/.test(step) && step.includes('path: .cache/cloud-embeddings'));
  assert.ok(restore > 0 && save > restore);
  assert.throws(() => verifyEmbeddingCacheSteps(steps.filter((_, i) => i !== restore).join('')), assert.AssertionError);
  assert.throws(() => verifyEmbeddingCacheSteps(steps.filter((_, i) => i !== save).join('')), assert.AssertionError);
  const reordered = [...steps];
  [reordered[restore], reordered[save]] = [reordered[save], reordered[restore]];
  assert.throws(() => verifyEmbeddingCacheSteps(reordered.join('')), assert.AssertionError);
  const conditionalSave = [...steps];
  conditionalSave[save] = conditionalSave[save].replace('always()', 'success()');
  assert.throws(() => verifyEmbeddingCacheSteps(conditionalSave.join('')), assert.AssertionError);
});
