import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadRuleDenseSearch,
  queryEmbeddingText,
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

function writeIndex(root, rules, vectors, texts = [...rules.units.values()].map(ruleEmbeddingText)) {
  const uniqueRows = [];
  const seen = new Set();
  texts.forEach((text, position) => {
    const textSha256 = hash(text);
    if (seen.has(textSha256)) return;
    seen.add(textSha256);
    uniqueRows.push({ textSha256, vector: vectors[position] });
  });
  const bytes = Buffer.from(new Float32Array(uniqueRows.flatMap(row => row.vector)).buffer);
  const vectorFile = 'rule-vectors-000.f32';
  fs.writeFileSync(path.join(root, vectorFile), bytes);
  const hashes = uniqueRows.map(row => row.textSha256);
  const descriptor = {
    index: 0,
    file: vectorFile,
    rowCount: uniqueRows.length,
    byteLength: bytes.length,
    sha256: hash(bytes),
  };
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
    entries: uniqueRows.map(({ textSha256 }, rowIndex) => ({
      textSha256,
      shardIndex: 0,
      rowIndex,
    })),
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

function vector(x, y) {
  const value = Array(RULE_EMBEDDING_DIMENSION).fill(0);
  value[0] = x;
  value[1] = y;
  return value;
}

function fixtureRules() {
  const units = [
    { id: 'unit-1', title: 'Fallback title', text: 'First complete body.',
      sourceSection: { titlePath: ['Root', 'Leaf'] } },
    { id: 'unit-2', title: 'Second title', text: 'Second complete body.' },
    { id: 'unit-3', text: 'Third complete body.', sourceSection: { titlePath: [] } },
  ];
  return { ruleRevision: 'rule-revision-test', units: new Map(units.map(unit => [unit.id, unit])) };
}

test('defines exact embedding inputs and ranks every canonical unit by cosine with stable ties', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-rule-dense-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rules = fixtureRules();
  writeIndex(root, rules, [vector(0, 2), vector(1, 0), vector(1, 0)]);

  assert.equal(ruleEmbeddingText(rules.units.get('unit-1')),
    'title: Root / Leaf | text: First complete body.');
  assert.equal(ruleEmbeddingText(rules.units.get('unit-2')),
    'title: Second title | text: Second complete body.');
  assert.equal(ruleEmbeddingText(rules.units.get('unit-3')),
    'title: none | text: Third complete body.');
  assert.equal(queryEmbeddingText('How does this resolve?'),
    'task: question answering | query: How does this resolve?');

  const dense = await loadRuleDenseSearch({ rules, dataDir: root });
  const ranked = dense.search(vector(3, 0));
  assert.deepEqual(ranked.map(unit => unit.id), ['unit-2', 'unit-3', 'unit-1']);
  assert.equal(ranked[0], rules.units.get('unit-2'));
  assert.equal(ranked.length, rules.units.size);
});

test('rejects an index row whose exact current embedding text hash is stale', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-rule-dense-stale-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rules = fixtureRules();
  const texts = [...rules.units.values()].map(ruleEmbeddingText);
  texts[1] = `${texts[1]} changed`;
  writeIndex(root, rules, [vector(1, 0), vector(0, 1), vector(-1, 0)], texts);

  await assert.rejects(loadRuleDenseSearch({ rules, dataDir: root }),
    /gemini_rule_dense_unit_binding_changed/u);
});

test('reuses one exact input vector for duplicate canonical unit bodies', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-rule-dense-duplicate-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repeated = { title: 'Shared', text: 'Same complete body.' };
  const units = [
    { id: 'unit-a', ...repeated },
    { id: 'unit-b', ...repeated },
    { id: 'unit-c', title: 'Different', text: 'Another complete body.' },
  ];
  const rules = {
    ruleRevision: 'duplicate-revision',
    units: new Map(units.map(unit => [unit.id, unit])),
  };
  writeIndex(root, rules, [vector(1, 0), vector(1, 0), vector(0, 1)]);

  const dense = await loadRuleDenseSearch({ rules, dataDir: root });
  assert.deepEqual(dense.search(vector(1, 0)).map(unit => unit.id),
    ['unit-a', 'unit-b', 'unit-c']);
});
