import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { bindQaSourceDisplay, projectQaSourceDisplay, QA_SOURCE_DISPLAY_SCHEMA } from '../backend/qaSourceDisplay.mjs';

const source = { title: '属性が複数ある場合？', question: '「<<123>>」の②を発動できますか？', answer: '発動できません。\n「<<999>>」も同様です。' };
const legacyTitle = source.question.normalize('NFKC');
const record = { id: 'ygoresources-qa-900001', recordType: 'qa', title: legacyTitle,
  text: `${source.question.normalize('NFKC')} ${legacyTitle} ${source.answer.normalize('NFKC')}`,
  cardIds: ['123'], customMetadata: { notice: 'retain <<123>> here', count: 0 } };
const references = { '123': { id: '123', jaName: 'テストカード', cnName: '测试卡' } };
const bind = () => bindQaSourceDisplay(record, source, { sourceUrl: 'https://db.ygoresources.com/data/qa/900001',
  sourceLocale: 'ja', cards: references });
const mappingFor = entry => ({ schema: QA_SOURCE_DISPLAY_SCHEMA, records: { [record.id]: entry } });

test('verified legacy projection groups source text and leaves original bytes and unknown metadata intact', () => {
  const before = JSON.stringify(record), entry = bind();
  const result = projectQaSourceDisplay(record, { mapping: mappingFor(entry) });
  assert.equal(result.title, source.title);
  assert.equal(result.display.question, '「テストカード」の2を発動できますか?');
  assert.equal(result.display.answer, '発動できません。\n「<<999>>」も同様です。');
  assert.equal(Object.hasOwn(result.display, 'text'), false);
  assert.deepEqual(result.display.customMetadata, record.customMetadata);
  assert.deepEqual(result.diagnostics.unknownCardIds, ['999']);
  assert.deepEqual(result.diagnostics.replacedCardIds, ['123']);
  assert.equal(JSON.stringify(record), before);
  result.display.customMetadata.count = 5;
  assert.equal(record.customMetadata.count, 0);
});

test('unmapped or changed source records and tampered source fields return the legacy fallback', () => {
  assert.equal(projectQaSourceDisplay(record), null);
  assert.equal(projectQaSourceDisplay({ ...record, text: `${record.text}!` }, { mapping: mappingFor(bind()) }), null);
  const entry = bind(); entry.source.answer = 'changed';
  assert.equal(projectQaSourceDisplay(record, { mapping: mappingFor(entry) }), null);
  const wrongRecipe = bind(); wrongRecipe.reconstruction.separator = '\t';
  assert.equal(projectQaSourceDisplay(record, { mapping: mappingFor(wrongRecipe) }), null);
  assert.equal(bindQaSourceDisplay(record, { ...source, question: `${source.question}!` }), null);
});

test('a unique legacy title cannot be dropped just because the old composite body can be split', () => {
  const uniqueTitle = 'A unique extra condition that is not in the source question or title';
  const changed = { ...record, title: uniqueTitle,
    text: `${source.question.normalize('NFKC')} ${uniqueTitle} ${source.answer.normalize('NFKC')}` };
  assert.equal(bindQaSourceDisplay(changed, source), null);
  assert.equal(projectQaSourceDisplay(changed), null);
  const sourceTitleRecord = { ...record, title: source.title,
    text: `${source.question.normalize('NFKC')} ${source.title} ${source.answer.normalize('NFKC')}` };
  assert.ok(bindQaSourceDisplay(sourceTitleRecord, source));
  const longSource = { ...source, question: `${source.question} ${'長い場面の説明'.repeat(20)}` };
  const title = `${longSource.question.normalize('NFKC').replace(/\s+/gu, ' ').slice(0, 89)}…`;
  const truncatedRecord = { ...record, title,
    text: `${longSource.question.normalize('NFKC')} ${title} ${source.answer.normalize('NFKC')}` };
  assert.ok(bindQaSourceDisplay(truncatedRecord, longSource));
});

test('structured records preserve distinct body versions and remove only exact concatenation duplicates', () => {
  const structured = { id: 'structured', recordType: 'qa', title: 'heading', question: 'heading',
    rawQuestion: 'heading', rawDetailedQuestion: 'scene', answer: 'answer', conclusion: 'different answer',
    text: 'heading\nscene\nheading\nanswer', unknown: { text: 'additional source text' } };
  const before = JSON.stringify(structured);
  const result = projectQaSourceDisplay(structured);
  assert.equal(result.display.question, 'scene');
  assert.deepEqual(result.display.answer, { answer: 'answer', conclusion: 'different answer' });
  assert.equal(Object.hasOwn(result.display, 'text'), false);
  assert.deepEqual(result.display.unknown, structured.unknown);
  assert.equal(JSON.stringify(structured), before);
  const additional = projectQaSourceDisplay({ ...structured, text: 'unique full source text' });
  assert.equal(additional.display.text, 'unique full source text');
});

test('heading recovery is exact and malformed grouping values cannot be overwritten', () => {
  const heading = 'long original heading '.repeat(7);
  const structured = { id: 'structured', recordType: 'qa', title: `${heading.slice(0, 89)}…`,
    rawQuestion: heading, rawDetailedQuestion: 'scene', conclusion: 'answer' };
  assert.equal(projectQaSourceDisplay(structured).title, heading);
  assert.equal(projectQaSourceDisplay({ ...structured, title: 'different title' }).title, 'different title');
  assert.equal(projectQaSourceDisplay({ ...structured, question: { additional: 'unknown structure' } }), null);
  assert.equal(bindQaSourceDisplay({ ...record, question: 'must not overwrite' }, source), null);
});

test('CID rendering uses exact IDs and authoritative supplied card names, leaving unresolved IDs untouched', () => {
  const result = projectQaSourceDisplay(record, { mapping: mappingFor(bind()),
    cards: new Map([['123', { id: '123', jaName: '更新された名前', cnName: '另一中文名' }]]) });
  assert.match(result.display.question, /更新された名前/u);
  assert.ok(result.display.answer.includes('<<999>>'));
  const unknown = projectQaSourceDisplay(record, { mapping: mappingFor({ ...bind(), cards: {} }) });
  assert.ok(unknown.display.question.includes('<<123>>'));
});

test('captured source mapping binds the checked-in canonical body without editing the asset', async () => {
  const mapping = JSON.parse(await readFile(new URL('../config/qa-source-display-v1.json', import.meta.url), 'utf8'));
  const bytes = await readFile(new URL('../data/gemini-rule-qa-v1/qa-records.json.gz', import.meta.url));
  const records = new Map(JSON.parse(gunzipSync(bytes)).map(value => [value.id, value]));
  assert.ok(Object.keys(mapping.records).length);
  for (const id of Object.keys(mapping.records)) {
    const original = records.get(id), before = JSON.stringify(original);
    const result = projectQaSourceDisplay(original, { mapping });
    assert.ok(result, `source binding failed for ${id}`);
    assert.equal(result.diagnostics.mode, 'verified_source_mapping');
    assert.equal(JSON.stringify(original), before);
    assert.equal(result.display.title, mapping.records[id].source.title);
  }
});
