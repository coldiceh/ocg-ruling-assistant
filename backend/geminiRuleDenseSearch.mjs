import crypto from 'node:crypto';

import { loadEvidenceVectorIndex } from './evidenceVectorIndex.mjs';

export const RULE_EMBEDDING_MODEL = 'gemini-embedding-2';
export const RULE_EMBEDDING_DIMENSION = 768;

export const RULE_EMBEDDING_CONTRACT = Object.freeze({
  dimension: RULE_EMBEDDING_DIMENSION,
  documentTemplate: "title: ${unit.sourceSection.titlePath.join(' / ') || unit.title || 'none'} | text: ${unit.text}",
  model: RULE_EMBEDDING_MODEL,
  queryTemplate: 'task: question answering | query: ${query}',
});

function check(condition, code) {
  if (!condition) throw new Error(code);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function ruleEmbeddingText(unit) {
  check(unit && typeof unit === 'object' && typeof unit.text === 'string',
    'gemini_rule_dense_unit_text_invalid');
  const titlePath = unit.sourceSection?.titlePath;
  check(titlePath === undefined || Array.isArray(titlePath),
    'gemini_rule_dense_title_path_invalid');
  const title = titlePath?.join(' / ') || unit.title || 'none';
  return `title: ${title} | text: ${unit.text}`;
}

export function queryEmbeddingText(query) {
  check(typeof query === 'string', 'gemini_rule_dense_query_invalid');
  return `task: question answering | query: ${query}`;
}

function currentUnits(rules) {
  check(rules && typeof rules === 'object' && rules.units instanceof Map,
    'gemini_rule_dense_rules_invalid');
  check(typeof rules.ruleRevision === 'string' && rules.ruleRevision.length > 0,
    'gemini_rule_dense_rule_revision_invalid');
  const seen = new Set();
  return [...rules.units.entries()].map(([mapId, unit]) => {
    const id = unit?.id;
    check(typeof id === 'string' && id.length > 0 && mapId === id && !seen.has(id),
      'gemini_rule_dense_unit_identity_invalid');
    seen.add(id);
    return Object.freeze({ id, textSha256: sha256(ruleEmbeddingText(unit)), unit });
  });
}

function vectorFor(index, entry) {
  const shard = index.shards[entry.shardIndex];
  const start = entry.rowIndex * index.manifest.dimension;
  return shard.subarray(start, start + index.manifest.dimension);
}

function norm(vector) {
  let squared = 0;
  for (const component of vector) {
    check(Number.isFinite(component), 'gemini_rule_dense_vector_nonfinite');
    squared += component * component;
  }
  const value = Math.sqrt(squared);
  check(value > 0 && Number.isFinite(value), 'gemini_rule_dense_vector_zero');
  return value;
}

export async function loadRuleDenseSearch({ rules, dataDir } = {}) {
  const units = currentUnits(rules);
  const index = await loadEvidenceVectorIndex({ dataDir, dataRevision: rules.ruleRevision });
  const { manifest } = index;
  check(manifest.model?.id === RULE_EMBEDDING_MODEL
    && manifest.model?.revision === RULE_EMBEDDING_MODEL,
  'gemini_rule_dense_model_changed');
  check(manifest.dimension === RULE_EMBEDDING_DIMENSION,
    'gemini_rule_dense_dimension_changed');
  check(manifest.inputContractSha256 === sha256(canonicalJson(RULE_EMBEDDING_CONTRACT)),
    'gemini_rule_dense_contract_changed');
  const uniqueHashes = [...new Set(units.map(unit => unit.textSha256))];
  check(manifest.entries.length === uniqueHashes.length
    && uniqueHashes.every((textSha256, position) => (
      manifest.entries[position]?.textSha256 === textSha256
      && manifest.orderedContentHashes[position] === textSha256
    )), 'gemini_rule_dense_unit_binding_changed');

  const rows = units.map((current, position) => {
    const entry = index.entries.get(current.textSha256);
    check(entry, 'gemini_rule_dense_unit_binding_changed');
    const vector = vectorFor(index, entry);
    check(vector.length === RULE_EMBEDDING_DIMENSION,
      'gemini_rule_dense_vector_shape_invalid');
    return Object.freeze({ ...current, vector, vectorNorm: norm(vector), position });
  });

  function search(queryVector) {
    check(Array.isArray(queryVector) || ArrayBuffer.isView(queryVector),
      'gemini_rule_dense_query_vector_invalid');
    check(queryVector.length === RULE_EMBEDDING_DIMENSION,
      'gemini_rule_dense_query_vector_dimension_invalid');
    const queryNorm = norm(queryVector);
    return Object.freeze(rows.map((row) => {
      let dot = 0;
      for (let component = 0; component < RULE_EMBEDDING_DIMENSION; component += 1) {
        dot += queryVector[component] * row.vector[component];
      }
      return { unit: row.unit, score: dot / (queryNorm * row.vectorNorm), position: row.position };
    }).sort((left, right) => right.score - left.score || left.position - right.position)
      .map(result => result.unit));
  }

  return Object.freeze({ search });
}
