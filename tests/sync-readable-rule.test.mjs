import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { renderReadableData } from '../backend/readableEvidenceText.mjs';

test('actual OCG sync refreshes the readable corpus after every source update', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ocg-readable-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['scripts/lib', 'backend', 'data/fixed-rule-sources']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  for (const file of ['scripts/sync-ocg-rule.mjs', 'scripts/export-readable-sources.mjs',
    'scripts/lib/ocg-rule-source-policy.mjs', 'scripts/lib/ocg-rule-structure.mjs',
    'backend/readableEvidenceText.mjs']) {
    await fs.copyFile(new URL('../' + file, import.meta.url), path.join(root, file));
  }
  await fs.writeFile(path.join(root, 'data/fixed-rule-sources/manifest.json'), JSON.stringify({ schemaVersion: 1, sources: [] }));
  const mock = path.join(root, 'mock-source.mjs');
  await fs.writeFile(mock, `
    globalThis.fetch = async url => {
      if (String(url).endsWith('searchindex.js')) return new Response('Search.setIndex(' + JSON.stringify({
        docnames: Array.from({length: 10}, (_, i) => 'chapter-' + i),
        titles: Array.from({length: 10}, (_, i) => 'Heading ' + i),
      }) + ')');
      return new Response('<article><h1>Heading</h1><p>' + process.env.READABLE_SYNC_ROUND + '正文<br>第二行 &quot;引用&quot;</p></article>');
    };
  `);
  let previousDisplay;
  for (const round of ['旧', '新']) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(mock).href, path.join(root, 'scripts/sync-ocg-rule.mjs')], {
        cwd: root, windowsHide: true, env: { ...process.env, READABLE_SYNC_ROUND: round }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(output)));
    });
    const source = JSON.parse(await fs.readFile(path.join(root, 'data/ocg-rule-corpus.json'), 'utf8'));
    const text = await fs.readFile(path.join(root, 'data/readable-sources/ocg-rule-corpus.txt'), 'utf8');
    assert.equal(text, renderReadableData({ source: source.source, generatedAt: source.generatedAt,
      records: source.records.map(({ structure, ...record }) => record) }) + '\n');
    assert.ok(text.includes(round + '正文\n第二行 "引用"'));
    assert.equal(text.includes('canonicalSha256:'), false);
    assert.equal(source.records.length, 10);
    assert.ok(source.records.every(record => record.structure));
    if (previousDisplay) assert.notEqual(text, previousDisplay);
    previousDisplay = text;
  }
});
