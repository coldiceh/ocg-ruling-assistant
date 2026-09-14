import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildQaDenseContext,
  loadQaDenseSearch,
} from '../backend/geminiQaDenseSearch.mjs';
import {
  RULE_EMBEDDING_CONTRACT,
  RULE_EMBEDDING_DIMENSION,
  RULE_EMBEDDING_MODEL,
  ruleEmbeddingText,
} from '../backend/geminiRuleDenseSearch.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function vector(x, y) {
  const value = Array(RULE_EMBEDDING_DIMENSION).fill(0);
  value[0] = x;
  value[1] = y;
  return value;
}

function writeIndex(root, rules, vectors) {
  const texts = [...rules.units.values()].map(ruleEmbeddingText);
  const hashes = texts.map(hash);
  const bytes = Buffer.from(new Float32Array(vectors.flat()).buffer);
  const descriptor = {
    index: 0,
    file: 'qa-vectors-000.f32',
    rowCount: vectors.length,
    byteLength: bytes.length,
    sha256: hash(bytes),
  };
  fs.writeFileSync(path.join(root, descriptor.file), bytes);
  const manifest = {
    schemaVersion: 1,
    kind: 'evidence-vector-index',
    encoding: 'raw-little-endian-float32',
    model: { id: RULE_EMBEDDING_MODEL, revision: RULE_EMBEDDING_MODEL },
    inputContractSha256: hash(canonicalJson(RULE_EMBEDDING_CONTRACT)),
    dataRevision: rules.ruleRevision,
    dimension: RULE_EMBEDDING_DIMENSION,
    uniqueContentCount: hashes.length,
    orderedContentHashes: hashes,
    orderedContentHashesSha256: hash(JSON.stringify(hashes)),
    entries: hashes.map((textSha256, rowIndex) => ({ textSha256, shardIndex: 0, rowIndex })),
    shards: [descriptor],
    vectorByteLength: bytes.length,
    shardSetSha256: hash(JSON.stringify([{
      index: descriptor.index,
      byteLength: descriptor.byteLength,
      sha256: descriptor.sha256,
    }])),
  };
  fs.writeFileSync(path.join(root, 'evidence-vector-index.json'), `${JSON.stringify(manifest)}\n`);
}

function fixtureItems() {
  return [
    Object.freeze({
      handle: 'handle-a',
      record: Object.freeze({
        recordType: 'qa',
        title: 'First source',
        question: 'Complete question text',
        answer: 'Complete answer text',
        raw: Object.freeze({ nested: ['kept', 2] }),
      }),
      sourceAuthority: 'official_database',
    }),
    Object.freeze({
      handle: 'handle-b',
      record: Object.freeze({
        recordType: 'qa',
        title: 'Second source',
        text: 'Another complete record',
        official: true,
      }),
      official: true,
    }),
    Object.freeze({
      handle: 'excluded-source-type',
      record: Object.freeze({ recordType: 'card-faq', title: 'Excluded', text: 'Other source' }),
    }),
  ];
}

test('builds the reused rule context from QA handles and complete record JSON only', () => {
  const items = fixtureItems();
  const context = buildQaDenseContext({ qaRevision: 'qa-revision-test', items });

  assert.equal(context.ruleRevision, 'qa-revision-test');
  assert.deepEqual([...context.units.keys()], ['handle-a', 'handle-b']);
  assert.deepEqual(context.units.get('handle-a'), {
    id: 'handle-a',
    title: 'First source',
    text: JSON.stringify(items[0].record),
  });
  assert.deepEqual(JSON.parse(context.units.get('handle-a').text), items[0].record);
});

test('returns original QA items in reused cosine order with authority fields intact', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-qa-dense-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const items = fixtureItems();
  const rules = buildQaDenseContext({ qaRevision: 'qa-revision-test', items });
  writeIndex(root, rules, [vector(0, 1), vector(1, 0)]);

  const dense = await loadQaDenseSearch({
    qaRevision: 'qa-revision-test',
    items,
    dataDir: root,
  });
  const ranked = dense.search(vector(1, 0));
  assert.deepEqual(ranked.map(item => item.handle), ['handle-b', 'handle-a']);
  assert.equal(ranked[0], items[1]);
  assert.equal(ranked[1], items[0]);
  assert.equal(ranked[1].sourceAuthority, 'official_database');
});
