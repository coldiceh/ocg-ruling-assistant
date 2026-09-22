import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

// Run the actual static audit against source fixtures, without loading data or models.
async function auditSource(context, source) {
  const root = await fs.mkdtemp(fileURLToPath(new URL('.audit-identity-', import.meta.url)));
  context.after(() => fs.rm(root, {recursive: true, force: true}));
  for (const dir of ['scripts', 'backend', 'api', 'src']) await fs.mkdir(path.join(root, dir));
  await fs.copyFile(new URL('../scripts/audit-no-special-case-branches.mjs', import.meta.url), path.join(root, 'scripts/audit-no-special-case-branches.mjs'));
  await fs.writeFile(path.join(root, 'backend/example.mjs'), source);
  const result = spawnSync(process.execPath, ['scripts/audit-no-special-case-branches.mjs'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.ifError(result.error);
  return {status: result.status, output: result.stdout + result.stderr};
}

test('audit accepts ordinary numeric capacity settings', async context => {
  const result = await auditSource(context, 'const limit = profile.reasoningEffort === "max" ? 131072 : 65536;');
  assert.equal(result.status, 0, result.output);
});

test('audit rejects a structurally declared fixed-answer map', async context => {
  const result = await auditSource(context, 'const fixedAnswerMap = new Map();');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /fixed-answer-map/);
});

test('audit rejects the local deterministic answer shortcut', async context => {
  const result = await auditSource(context, 'const result = buildDeterministicModelResult(input);');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /local-deterministic-answer-shortcut/);
});

test('audit permits ordinary source records without embedded answer routing', async context => {
  const result = await auditSource(context, 'export const record = { id: "synthetic-source", title: "Synthetic title" };');
  assert.equal(result.status, 0, result.output);
});
