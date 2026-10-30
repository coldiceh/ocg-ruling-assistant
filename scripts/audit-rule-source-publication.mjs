import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRuleStructureMapping } from '../backend/evidenceSourceStructure.mjs';
import { applyRuleSourceAllowlist, loadRuleSourceAllowlist } from '../backend/ruleSourcePublication.mjs';
import { loadGeminiRuleQaAssets } from '../backend/geminiRuleQaAssets.mjs';
import { prepareBoundedEvidenceSnapshot } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { loadRuleDenseSearch, RULE_EMBEDDING_DIMENSION } from '../backend/geminiRuleDenseSearch.mjs';
import { mapRankedUnits } from '../backend/evidenceReadingScheduler.mjs';
import { buildRuleToc } from '../backend/ruleTocAdmission.mjs';
import { DEFAULT_RULE_SOURCE_ALLOWLIST } from './build-gemini-rule-qa-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const konami = value => String(value || '').startsWith('konami:');
const sorted = values => [...values].sort();

// A deterministic local probe, NOT a semantic query embedding. This exercises
// the real vector search and candidate mapping without calling any provider.
// Exhaustive membership checks below are independent of the vector's ranking.
function queryProbe(question) {
  const vector = new Float32Array(RULE_EMBEDDING_DIMENSION);
  for (let offset = 0; offset < vector.length; offset += 32) {
    const bytes = createHash('sha256').update(`${offset}\0${question}`).digest();
    for (let index = 0; index < bytes.length && offset + index < vector.length; index++) {
      vector[offset + index] = (bytes[index] - 127.5) / 127.5;
    }
  }
  return vector;
}

export async function auditRuleSourcePublication({ dataDir = join(root, 'data'),
  setPath = join(root, 'scripts/bench/sets/ocg-50-20260924.json'),
  allowlistPath = DEFAULT_RULE_SOURCE_ALLOWLIST } = {}) {
  const [loaded, assets, corpusBytes, setBytes] = await Promise.all([
    loadRuleSourceAllowlist(allowlistPath), loadGeminiRuleQaAssets({ dataDir }),
    readFile(join(dataDir, 'ocg-rule-corpus.json')), readFile(setPath),
  ]);
  const records = JSON.parse(corpusBytes).records.filter(record => record.recordType === 'rule-doc');
  const expected = buildRuleStructureMapping(applyRuleSourceAllowlist(records, loaded.allowlist).records);
  const expectedKeys = new Set(expected.sources.filter(source => konami(source.sourceId))
    .flatMap(source => source.readingUnits.map(unit => unit.unitKey)));
  const set = JSON.parse(setBytes);
  assert.equal(set.items.length, 50, 'the publication audit requires all 50 benchmark questions');
  const { snapshot } = prepareBoundedEvidenceSnapshot(assets);
  const { rules } = snapshot;
  const dense = await loadRuleDenseSearch({ rules, dataDir: join(dataDir, 'rule-embedding-v1'),
    denseRevision: assets.ruleDenseRevision });
  const ruleKeys = result => rules.denseMapping.get(result.id) || [];
  const actualKeys = [...rules.readingUnits.keys()].filter(konami);
  assert.deepEqual(sorted(actualKeys), sorted(expectedKeys), 'published reading units must equal the allowlist units');
  const expectedSections = new Map(loaded.allowlist.sources.map(source => [source.sourceId,
    new Set(source.sections.map(section => section.sectionKey))]));
  for (const unit of rules.units.values()) if (konami(unit.sourceId)) {
    assert.ok(expectedSections.get(unit.sourceId)?.has(unit.sourceSection?.sourceSectionKey),
      `unlisted dense/lexical paragraph: ${unit.id}`);
  }
  const navigationKeys = assets.navigationRecords.filter(record => konami(record.sourceId) || konami(record.unitKey))
    .map(record => record.unitKey);
  assert.deepEqual(sorted(navigationKeys), sorted(expectedKeys), 'navigation records must equal the allowlist units');
  const toc = buildRuleToc({ rules, navigationRecordsByUnit: assets.navigationRecordsByUnit });
  const tocKeys = toc.unitKeys.filter(konami);
  const tocKonamiLines = toc.text.split('\n').filter(line => konami(line.split('\t')[1]));
  assert.deepEqual(sorted(tocKeys), sorted(expectedKeys));
  assert.equal(tocKonamiLines.length, expectedKeys.size, 'rendered ToC line count must match the allowed units');

  function inspect(hits) {
    const keys = hits.map(hit => hit.unitKey);
    for (const key of keys) assert.ok(rules.readingUnits.has(key), `unknown rule candidate: ${key}`);
    const official = keys.filter(key => konami(rules.readingUnits.get(key)?.sourceId) || konami(key));
    assert.ok(official.every(key => expectedKeys.has(key)), 'a hidden unit reached a retrieval channel');
    return { candidates: keys.length, konami: official.length, konamiUnitKeys: official };
  }
  const rows = [];
  for (const item of set.items) {
    assert.ok(typeof item.question === 'string' && item.question.trim());
    const denseResults = dense.search(queryProbe(item.question));
    const lexicalResults = snapshot.ruleSearch.search([item.question]);
    // Inspect the entire navigation queue, including records that legacy
    // sourceKind partitioning would omit. Then inspect each production mode.
    const navigationResults = snapshot.navigationSearch.search(item.question)
      .filter(hit => rules.readingUnits.has(hit.unitKey));
    const legacy = snapshot.navigationSearch.searchBySourceKind(item.question, { sourceKinds: ['rule'], limit: 32 });
    const byUnit = snapshot.navigationSearch.searchBySourceKind(item.question, { sourceKinds: ['rule'], limit: 32,
      sourceKindForUnit: key => snapshot.units.get(key)?.sourceKind });
    const families = [...new Set([...rules.readingUnits.values()].map(unit => String(unit.sourceId).split(':')[0]))];
    const byFamily = snapshot.navigationSearch.searchBySourceKind(item.question, {
      sourceKinds: families.map(family => `rule:${family}`), limit: 32,
      sourceKindForUnit: key => {
        const unit = rules.readingUnits.get(key);
        return unit ? `rule:${String(unit.sourceId).split(':')[0]}` : null;
      } });
    rows.push({ qid: item.qid, questionSha256: sha256(item.question),
      fullQueues: {
        ruleVector: inspect(mapRankedUnits(denseResults, ruleKeys, Infinity)),
        ruleLexical: inspect(mapRankedUnits(lexicalResults, ruleKeys, Infinity)),
        navigation: inspect(navigationResults),
      },
      productionCandidates: {
        ruleVector: inspect(mapRankedUnits(denseResults, ruleKeys)),
        ruleLexical: inspect(mapRankedUnits(lexicalResults, ruleKeys)),
        navigationLegacy: inspect(legacy.rule),
        navigationUnitSourceKind: inspect(byUnit.rule),
        navigationSourceFamily: inspect(Object.values(byFamily).flat()),
      } });
  }
  const totals = property => Object.fromEntries(Object.keys(rows[0][property]).map(channel => {
    const values = rows.map(row => row[property][channel]);
    return [channel, { candidates: values.reduce((sum, row) => sum + row.candidates, 0),
      konami: values.reduce((sum, row) => sum + row.konami, 0),
      minKonamiPerQuestion: Math.min(...values.map(row => row.konami)),
      maxKonamiPerQuestion: Math.max(...values.map(row => row.konami)),
      uniqueKonamiUnits: new Set(values.flatMap(row => row.konamiUnitKeys)).size, violations: 0 }];
  }));
  return { schemaVersion: 1, ok: true, questionCount: rows.length, setSha256: sha256(setBytes),
    queryVectorMode: 'deterministic-local-sha256-probe-not-semantic-embedding',
    scope: 'publication membership only; no relevance or answer-quality claim',
    externalCalls: 0, bundleRevision: assets.bundleRevision, allowlistSha256: loaded.sha256,
    allowlistSections: loaded.allowlist.sources.reduce((sum, source) => sum + source.sections.length, 0),
    allowedKonamiReadingUnits: expectedKeys.size,
    indexes: { ruleReadingUnits: rules.readingUnits.size, ruleDenseAndLexicalParagraphs: rules.units.size,
      ruleVectorRows: JSON.parse(await readFile(join(dataDir, 'rule-embedding-v1/evidence-vector-index.json'))).entries.length,
      navigationRecords: assets.navigationRecords.length, konamiNavigationRecords: navigationKeys.length },
    toc: { totalRows: toc.lineCount, konamiRows: tocKonamiLines.length, exactUnitSetMatch: true },
    fullQueueTotals: totals('fullQueues'), productionCandidateTotals: totals('productionCandidates'), rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Fail if a future dependency ever attempts a network request. This CLI only
  // reads source/release files and prints its report; it never writes assets.
  globalThis.fetch = async () => { throw new Error('publication_audit_network_forbidden'); };
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--data-dir': 'dataDir', '--set': 'setPath', '--allowlist': 'allowlistPath' }[args[index]];
    if (!key || !args[index + 1]) throw new Error('publication_audit_arguments_invalid');
    options[key] = resolve(args[index + 1]);
  }
  console.log(JSON.stringify(await auditRuleSourcePublication(options), null, 2));
}
