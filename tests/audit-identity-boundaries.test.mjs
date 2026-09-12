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

test('audit does not mistake a larger output limit for a numeric identity', async context => {
  const result = await auditSource(context, 'const limit = profile.reasoningEffort === "max" ? 131072 : 65536;');
  assert.equal(result.status, 0, result.output);
});

test('audit still rejects exact numeric identity branches', async context => {
  const result = await auditSource(context, 'if (cardId === 13107) return selected;');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /benchmark-identity-branch/);
});

test('audit still rejects string and prefixed identity branches', async context => {
  for (const source of ['if (cardId === "13107") return selected;', 'if (sourceId === "qa:13107") return selected;']) {
    const result = await auditSource(context, source);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /benchmark-identity-branch/);
  }
});

test('audit does not match an identity inside a longer digit run', async context => {
  const result = await auditSource(context, 'const first = enabled ? 913107 : 0; const second = enabled ? 9131072 : 0;');
  assert.equal(result.status, 0, result.output);
});
