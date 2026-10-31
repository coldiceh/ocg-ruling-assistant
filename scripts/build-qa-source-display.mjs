import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bindQaSourceDisplay, QA_SOURCE_DISPLAY_SCHEMA } from '../backend/qaSourceDisplay.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const rows = value => Array.isArray(value) ? value : value.records;

/** Explicit, bounded public-source capture. Never edits canonical records or embeddings. */
export async function buildQaSourceDisplay({ ids, sourceDir = resolve(root, 'data'),
  output = resolve(root, 'config/qa-source-display-v1.json'), locale = 'ja', fetchImpl = fetch } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 50
      || ids.some(id => !/^\d{1,10}$/u.test(String(id)))) throw new Error('qa_display_ids_invalid');
  const recordPath = resolve(sourceDir, 'gemini-rule-qa-v1/qa-records.json.gz');
  const cardPath = resolve(sourceDir, 'cards.json');
  const [recordBytes, cardBytes] = await Promise.all([readFile(recordPath), readFile(cardPath)]);
  const records = new Map(rows(JSON.parse(gunzipSync(recordBytes))).map(record => [record.id, record]));
  const cards = new Map(rows(JSON.parse(cardBytes)).map(card => [String(card.id), card]));
  let previous;
  try { previous = JSON.parse(await readFile(output, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && previous.schema !== QA_SOURCE_DISPLAY_SCHEMA) throw new Error('qa_display_schema_invalid');
  const result = {
    schema: QA_SOURCE_DISPLAY_SCHEMA,
    generatedAt: new Date().toISOString(),
    sourceFiles: {
      records: { path: 'data/gemini-rule-qa-v1/qa-records.json.gz', sha256: sha256(recordBytes) },
      cards: { path: 'data/cards.json', sha256: sha256(cardBytes) },
    },
    records: { ...(previous?.records || {}) },
  };
  for (const id of [...new Set(ids.map(String))]) {
    const recordId = `ygoresources-qa-${id}`;
    const record = records.get(recordId);
    if (!record) throw new Error(`qa_display_record_missing:${id}`);
    const sourceUrl = `https://db.ygoresources.com/data/qa/${id}`;
    const response = await fetchImpl(sourceUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`qa_display_fetch_failed:${id}:${response.status}`);
    const raw = await response.text();
    const source = JSON.parse(raw)?.qaData?.[locale];
    if (!source) throw new Error(`qa_display_locale_missing:${id}:${locale}`);
    const usedIds = [...new Set(Array.from(JSON.stringify([source.title, source.question, source.answer])
      .matchAll(/<<(\d{1,10})>>/gu), match => match[1]))];
    const references = Object.fromEntries(usedIds.filter(cid => cards.has(cid)).map(cid => {
      const card = cards.get(cid);
      return [cid, { id: cid, jaName: card.jaName || '', cnName: card.cnName || '', enName: card.enName || '' }];
    }));
    const entry = bindQaSourceDisplay(record, source, { sourceUrl, sourceLocale: locale,
      fetchedAt: new Date().toISOString(), responseSha256: sha256(raw), cards: references });
    if (!entry) throw new Error(`qa_display_source_does_not_reconstruct_record:${id}`);
    result.records[recordId] = entry;
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { output, records: Object.keys(result.records).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const ids = value('--ids')?.split(',').filter(Boolean);
  buildQaSourceDisplay({ ids, sourceDir: value('--source-dir') && resolve(value('--source-dir')),
    output: value('--output') && resolve(value('--output')), locale: value('--locale') || 'ja' })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
