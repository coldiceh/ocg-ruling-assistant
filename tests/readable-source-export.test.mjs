import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportReadableSources } from '../scripts/export-readable-sources.mjs';
import { renderReadableData } from '../backend/readableEvidenceText.mjs';

test('display encoding preserves quotes, real whitespace, Unicode and literal backslashes', () => {
  const source = { body: '第一行\n\n"引用"\t末行\n', literal: String.raw`C:\tierra\qliphoth.exe\n\u4e2d`,
    fields: { empty: '', nil: null, zero: 0, values: ['日本語', false] } };
  assert.equal(renderReadableData(source),
    '{\nbody: 第一行\n\n"引用"\t末行\n\nliteral: ' + source.literal +
    '\nfields: {\nempty: ""\nnil: null\nzero: 0\nvalues: [\n日本語\n,\nfalse\n]\n}\n}');
});

test('current and later synchronized records share the same reading export; raw bytes remain unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'readable-sources-'));
  try {
    const path = join(dir, 'rulings.json');
    for (const answer of ['旧正文\n原句', '新正文\n"引号"\n日本語']) {
      const source = { schemaVersion: 1, sync: { technicalCounter: 99 },
        records: [{ id: 'source', question: '完整问题', answer, extra: { note: '额外原文字段' } }] };
      const bytes = JSON.stringify(source);
      await writeFile(path, bytes);
      const result = await exportReadableSources({ dataDir: dir, names: ['rulings.json'] });
      const displayed = await readFile(join(dir, 'readable-sources/rulings.txt'), 'utf8');
      assert.equal(displayed, renderReadableData({ records: source.records }) + '\n');
      assert.equal(await readFile(path, 'utf8'), bytes);
      assert.equal(result.files[0].records, 1);
      assert.equal(result.files[0].outputChars, displayed.length);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
