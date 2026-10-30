import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createGeminiBoundedEvidenceProvider,
  prepareBoundedEvidenceSnapshot } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { buildRuleStructureMapping, makeQaSourceUnits, stableJson } from '../backend/evidenceSourceStructure.mjs';
import { createFocusedQaView } from '../backend/geminiFocusedQaView.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';
import { loadGeminiRuleQaAssets } from '../backend/geminiRuleQaAssets.mjs';

// The navigation lanes of the production provider are partitioned by source
// kind, and rule units further by source family (the namespace of the rule
// document id). Released ocg-rule navigation records carry no sourceKind field
// (the Konami and QA/FAQ records do), so these tests exercise the provider
// itself rather than a caller that passes its own sourceKindForUnit.

const digest = value => createHash('sha256').update(value).digest('hex');
const offlineStop = () => Object.assign(new Error('offline_stop_before_selection'), { offlineStop: true });

function releaseShapedAssets() {
  const ruleRecords = [{ id: 'ocg-rule:doc-a', recordType: 'rule-doc', title: 'fixture rule source',
    text: 'first rule paragraph\n\nsecond rule paragraph', sourceAuthority: 'community_reference', official: false },
  { id: 'konami:doc-b', recordType: 'rule-doc', title: 'fixture official source',
    text: 'official rule paragraph', sourceAuthority: 'official_reference', official: true }];
  const qaRecords = [{ id: 'qa-a', recordType: 'qa', title: 'fixture QA', question: 'fixture question',
    answer: 'fixture answer', official: true }];
  const qaRevision = digest(stableJson(qaRecords));
  const parentTools = createQaTools({ records: qaRecords, qaRevision });
  const focused = createFocusedQaView({ qaRevision,
    items: parentTools.readSelected(parentTools.snapshotHandles) });
  const focusedByHandle = new Map(focused.items.map(item => [item.handle, item]));
  const qaUnits = makeQaSourceUnits(focused.items).map(unit => ({ ...unit, item: focusedByHandle.get(unit.handle) }));
  const { structureMappingRevision: _old, ...mappingBody } = buildRuleStructureMapping(ruleRecords);
  const structureMapping = { ...mappingBody, qaUnits };
  structureMapping.structureMappingRevision = digest(stableJson(structureMapping));
  const ruleUnits = structureMapping.sources.flatMap(source => source.readingUnits);
  // Same field shape as the release: no sourceKind on rule records, present on QA records.
  const navigationRecords = [
    ...ruleUnits.map(unit => ({ unitKey: unit.unitKey, sourceId: unit.sourceId,
      canonicalBodySha256: unit.sourceCanonicalSha256, titlePath: unit.titlePath || [],
      descriptionZh: 'fixture rule description', descriptionJa: '', searchQuestions: [],
      navigationStatus: 'generated', contextRefs: [], explicitRefs: [] })),
    ...qaUnits.map(unit => ({ unitKey: unit.unitKey, sourceId: unit.sourceId, sourceKind: unit.sourceKind,
      canonicalBodySha256: unit.canonicalBodySha256, titlePath: [], descriptionZh: '', descriptionJa: '',
      searchQuestions: [], navigationStatus: 'not_generated_in_scope', contextRefs: [], explicitRefs: [] })),
  ];
  return { schemaVersion: 3, manifest: { schemaVersion: 3 }, dataRevision: 'd', bundleRevision: 'b',
    qaRevision, ruleContentRevision: digest(stableJson(ruleRecords)), navigationRevision: 'n',
    structureMappingRevision: structureMapping.structureMappingRevision, ruleDenseRevision: 'rd',
    qaDenseRevision: 'qd', rulesRecords: ruleRecords, structureMapping, navigationRecords,
    createQaTools: options => createQaTools({ records: qaRecords, qaRevision, ...options }), ruleUnits };
}

async function readingBeforeSelection({ assets, userQuery, env, loadDenseSearch, loadQaSearch, needs = [] }) {
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => assets, remainingBudget: async () => Infinity,
    loadDenseSearch, loadQaSearch,
    budgetedRequest: async (request) => {
      if (request.operation === 'embed_content') throw new Error('budget exceeded (offline test: dense lanes skipped)');
      if (request.generationContract?.stage === 'planning') {
        return { candidates: [{ content: { parts: [{ text: JSON.stringify({ needs }) }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 110 } };
      }
      throw offlineStop();
    },
  });
  const error = await provider.retrieve({ userQuery, dataRevision: assets.dataRevision, env,
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    retrievedEvidence: { cardTexts: [], userProvidedCardTexts: [] }, assetsPromise: Promise.resolve(assets),
  }).then(() => null, value => value);
  assert.ok(error?.offlineStop, error?.stack || 'selection was expected to be reached');
  return error.boundedRetrieval.reading;
}

const fixtureEnv = { GEMINI_API_KEY: 'fixture', EVIDENCE_PLANNING_PROFILE: 'gemini-3.8-flash-medium-planning-room-theoretical',
  EVIDENCE_SELECTION_PROFILE: 'bai-gpt-6-luna-high-theoretical', BAI_API_KEY: 'fixture',
  EVIDENCE_GENERATION_OUTPUT_LIMIT: 'provider', GEMINI_EVIDENCE_DEADLINE_MS: '0', GEMINI_EVIDENCE_MAX_CNY: '0',
  GEMINI_EVIDENCE_MAX_PROMPT_CHARS: '15000', GEMINI_EVIDENCE_READING_TARGET_CHARS: '60000' };
const noDense = {
  loadDenseSearch: async () => ({ searchAsync: async () => [] }),
  loadQaSearch: async () => ({ searchAsync: async () => [] }),
};

test('navigation lanes return rule reading units per source family even without a record sourceKind', async () => {
  const assets = releaseShapedAssets();
  const reading = await readingBeforeSelection({ assets, userQuery: 'fixture rule description',
    env: fixtureEnv, ...noDense });
  const lane = (kind, channel) => reading.lanes.find(row => row.needId === 'original'
    && row.sourceKind === kind && row.channel === channel);
  for (const family of ['ocg-rule', 'konami']) {
    assert.deepEqual(lane('rule', `navigation_lexical:${family}`).hits.map(hit => hit.unitKey).sort(),
      assets.ruleUnits.filter(unit => unit.sourceId.startsWith(`${family}:`)).map(unit => unit.unitKey).sort(), family);
  }
  assert.equal(reading.lanes.filter(row => row.needId === 'original' && row.sourceKind === 'rule'
    && row.channel.startsWith('navigation_lexical')).length, 2);
  assert.deepEqual(lane('qa', 'navigation_lexical').hits.map(hit => hit.unitKey),
    assets.structureMapping.qaUnits.filter(unit => unit.sourceKind === 'qa').map(unit => unit.unitKey));
  // The admitted window may now carry a rule unit reached only by navigation.
  assert.ok(reading.offered.some(bundle => assets.ruleUnits.some(unit => unit.unitKey === bundle.unitKey)));
});

test('production release: navigation lanes are partitioned by source kind and rule source family', async () => {
  const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
  const assets = await loadGeminiRuleQaAssets({ dataDir });
  const { snapshot } = prepareBoundedEvidenceSnapshot(assets);
  // A query taken from the release itself: the first generated rule navigation
  // record without its own sourceKind field (if the release has one).
  const record = assets.navigationRecords.find(row => row.navigationStatus === 'generated'
    && row.sourceKind === undefined && row.searchQuestions?.some(question => question.text))
    || assets.navigationRecords.find(row => row.navigationStatus === 'generated'
      && snapshot.units.get(row.unitKey)?.sourceKind === 'rule' && row.searchQuestions?.some(question => question.text));
  assert.ok(record, 'release has a generated rule navigation record');
  const userQuery = record.searchQuestions.find(question => question.text).text;
  const reading = await readingBeforeSelection({ assets, userQuery, env: fixtureEnv, ...noDense });
  const full = snapshot.navigationSearch.search(userQuery);
  const family = unit => String(unit.sourceId).split(':')[0];
  const families = [...new Set([...snapshot.rules.readingUnits.values()].map(family))];
  assert.deepEqual(families, ['ocg-rule', 'konami']);
  const partitions = [...families.map(name => ['rule', `navigation_lexical:${name}`,
    unit => unit?.sourceKind === 'rule' && family(unit) === name]),
  ...['qa', 'faq'].map(kind => [kind, 'navigation_lexical', unit => unit?.sourceKind === kind])];
  for (const [kind, channel, member] of partitions) {
    const lane = reading.lanes.find(row => row.needId === 'original' && row.sourceKind === kind && row.channel === channel);
    const expected = full.filter(hit => member(snapshot.units.get(hit.unitKey))).slice(0, 32).map(hit => hit.unitKey);
    assert.deepEqual(lane.hits.map(hit => hit.unitKey), expected, channel);
    assert.equal(lane.hits.length, 32, channel);
  }
  const ruleLane = reading.lanes.find(row => row.needId === 'original'
    && row.sourceKind === 'rule' && row.channel === `navigation_lexical:${family(snapshot.units.get(record.unitKey))}`);
  assert.ok(ruleLane.hits.some(hit => hit.unitKey === record.unitKey),
    'the record found by its own search question is in the rule navigation lane');
  assert.ok(ruleLane.hits.some(hit => assets.navigationRecordsByUnit.get(hit.unitKey)?.sourceKind === undefined)
    || assets.navigationRecords.every(row => row.sourceKind !== undefined));
});
