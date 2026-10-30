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

// RULE_NAVIGATION_PARTITION decides how navigation hits become lanes:
// legacy (default, identical to main), unit-source-kind (69af952: the bound
// reading unit's sourceKind) and source-family (734af32: rule units further per
// source family, the namespace of the rule document id). Released ocg-rule
// navigation records carry no sourceKind field (the Konami and QA/FAQ records
// do), so these tests exercise the provider itself rather than a caller that
// passes its own sourceKindForUnit.

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
const familyEnv = { ...fixtureEnv, RULE_NAVIGATION_PARTITION: 'source-family' };
const noDense = {
  loadDenseSearch: async () => ({ searchAsync: async () => [] }),
  loadQaSearch: async () => ({ searchAsync: async () => [] }),
};

test('source-family: navigation lanes return rule reading units per source family even without a record sourceKind', async () => {
  const assets = releaseShapedAssets();
  const reading = await readingBeforeSelection({ assets, userQuery: 'fixture rule description',
    env: familyEnv, ...noDense });
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

test('unit-source-kind: one rule navigation lane with both families; legacy and unset: only records with their own sourceKind', async () => {
  const assets = releaseShapedAssets();
  const ruleNavigation = reading => reading.lanes.filter(row => row.needId === 'original' && row.sourceKind === 'rule'
    && row.channel.startsWith('navigation_lexical'));
  const unitKind = ruleNavigation(await readingBeforeSelection({ assets, userQuery: 'fixture rule description',
    env: { ...fixtureEnv, RULE_NAVIGATION_PARTITION: 'unit-source-kind' }, ...noDense }));
  assert.deepEqual(unitKind.map(lane => lane.channel), ['navigation_lexical']);
  assert.deepEqual(unitKind[0].hits.map(hit => hit.unitKey).sort(), assets.ruleUnits.map(unit => unit.unitKey).sort());
  for (const env of [fixtureEnv, { ...fixtureEnv, RULE_NAVIGATION_PARTITION: 'legacy' }]) {
    const legacy = ruleNavigation(await readingBeforeSelection({ assets, userQuery: 'fixture rule description',
      env, ...noDense }));
    assert.deepEqual(legacy.map(lane => lane.channel), ['navigation_lexical']);
    assert.deepEqual(legacy[0].hits, [], 'no released-shape rule record carries its own sourceKind');
  }
  await assert.rejects(readingBeforeSelection({ assets, userQuery: 'q',
    env: { ...fixtureEnv, RULE_NAVIGATION_PARTITION: 'family' }, ...noDense }),
  /evidence_config_invalid_RULE_NAVIGATION_PARTITION/u);
});

// Golden values of the fixture below computed on the unmodified provider of
// main (483b000, before the navigation fix): the plan and selection request
// bodies, the final prompt and the reading lanes. legacy and an unset
// RULE_NAVIGATION_PARTITION must reproduce them byte for byte; the two fixed
// modes change the window order on this fixture, so it is sensitive to the
// partition. If an unrelated prompt change moves them, recompute them on main.
const MAIN_GOLDEN = Object.freeze({
  plan: '2aba4bc4f3ccaf8e5b8b5ad1b927935f3c2f2dabf0e6cd3aa7fa320ee1d3c44b',
  selection: 'e32525455860c1b5bc2db4fd57dcc05a49f4aa4271951f0b8a2a3a25d7cd5d91',
  selectionChars: 11840,
  prompt: '1efc5a3bf72d81997e4bbdc50ca002451badd464fc04bc724c26b68e09bd9c0e',
  lanes: '29c0353a7686bf0e1ba7ecd7665512eeb4d27bb01c3aa555fb00b49ad6472f35',
});

// Four rule documents whose text does not match the query; only the navigation
// descriptions do, and only the Konami record carries its own sourceKind.
function navigationOnlyAssets() {
  const filler = mark => Array.from({ length: 40 }, (_, index) => `${mark} sentence ${index} of the fixture rule body.`).join(' ');
  const ruleRecords = ['one', 'two', 'three', 'four'].map((mark, index) => ({
    id: index === 3 ? 'konami:doc-4' : `ocg-rule:doc-${index + 1}`, recordType: 'rule-doc', title: `source ${mark}`,
    text: filler(mark), sourceAuthority: index === 3 ? 'official_reference' : 'community_reference', official: index === 3 }));
  const descriptions = { 'ocg-rule:doc-1': 'unrelated words', 'ocg-rule:doc-2': 'unrelated words',
    'ocg-rule:doc-3': 'zebra zebra navigation', 'konami:doc-4': 'zebra navigation' };
  const qaRecords = [{ id: 'qa-a', recordType: 'qa', title: 'fixture QA', question: 'fixture question',
    answer: 'fixture answer', official: true }];
  const qaRevision = digest(stableJson(qaRecords));
  const parentTools = createQaTools({ records: qaRecords, qaRevision });
  const focused = createFocusedQaView({ qaRevision, items: parentTools.readSelected(parentTools.snapshotHandles) });
  const focusedByHandle = new Map(focused.items.map(item => [item.handle, item]));
  const qaUnits = makeQaSourceUnits(focused.items).map(unit => ({ ...unit, item: focusedByHandle.get(unit.handle) }));
  const { structureMappingRevision: _old, ...mappingBody } = buildRuleStructureMapping(ruleRecords);
  const structureMapping = { ...mappingBody, qaUnits };
  structureMapping.structureMappingRevision = digest(stableJson(structureMapping));
  const ruleUnits = structureMapping.sources.flatMap(source => source.readingUnits);
  const navigationRecords = [
    ...ruleUnits.map(unit => ({ unitKey: unit.unitKey, sourceId: unit.sourceId,
      ...(unit.sourceId.startsWith('konami:') ? { sourceKind: 'rule' } : {}),
      canonicalBodySha256: unit.sourceCanonicalSha256, titlePath: unit.titlePath || [],
      descriptionZh: descriptions[unit.sourceId], descriptionJa: '', searchQuestions: [],
      navigationStatus: 'generated', contextRefs: [], explicitRefs: [] })),
    ...qaUnits.map(unit => ({ unitKey: unit.unitKey, sourceId: unit.sourceId, sourceKind: unit.sourceKind,
      canonicalBodySha256: unit.canonicalBodySha256, titlePath: [], descriptionZh: '', descriptionJa: '',
      searchQuestions: [], navigationStatus: 'not_generated_in_scope', contextRefs: [], explicitRefs: [] })),
  ];
  return { schemaVersion: 3, manifest: { schemaVersion: 3 }, dataRevision: 'd', bundleRevision: 'b',
    qaRevision, ruleContentRevision: digest(stableJson(ruleRecords)), navigationRevision: 'n',
    structureMappingRevision: structureMapping.structureMappingRevision, ruleDenseRevision: 'rd',
    qaDenseRevision: 'qd', rulesRecords: ruleRecords, structureMapping, navigationRecords,
    createQaTools: options => createQaTools({ records: qaRecords, qaRevision, ...options }) };
}

async function navigationOnlyRun(partition) {
  const assets = navigationOnlyAssets();
  const requests = [];
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => assets, remainingBudget: async () => Infinity, ...noDense,
    budgetedRequest: async (request) => {
      if (request.operation === 'embed_content') throw new Error('budget exceeded (offline test: dense lanes skipped)');
      requests.push(request.body);
      if (request.generationContract?.stage === 'planning') {
        return { candidates: [{ content: { parts: [{ text: JSON.stringify({ needs: [] }) }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 110 } };
      }
      const delivered = JSON.parse(request.body.input.find(message => message.role === 'user').content.split('\n').at(-1));
      const selectedIds = delivered.groups.flatMap(group => [...(group.units || []).map(row => row[0]),
        ...(group.items || []).map(item => item.handle)]);
      return { id: 's', model: 'gpt-6-luna', status: 'completed', output: [{ type: 'message', content: [{
        type: 'output_text', text: JSON.stringify({ selectedIds, note: '' }) }] }],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 } } };
    },
  });
  const env = { ...fixtureEnv, ...(partition === undefined ? {} : { RULE_NAVIGATION_PARTITION: partition }) };
  const result = await provider.retrieve({ userQuery: 'zebra navigation', dataRevision: 'd', env,
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    retrievedEvidence: { cardTexts: [], userProvidedCardTexts: [] }, assetsPromise: Promise.resolve(assets) });
  assert.equal(requests.length, 2);
  return { plan: digest(JSON.stringify(requests[0])), selection: digest(JSON.stringify(requests[1])),
    selectionChars: JSON.stringify(requests[1]).length, prompt: digest(result.packing.prompt),
    lanes: digest(JSON.stringify(result.telemetry.bounded.reading.lanes)), bounded: result.telemetry.bounded };
}

test('legacy and an unset partition reproduce main byte for byte; the fixed modes do not', async () => {
  for (const partition of [undefined, 'legacy']) {
    const { bounded, ...observed } = await navigationOnlyRun(partition);
    assert.deepEqual(observed, MAIN_GOLDEN, String(partition));
    assert.equal(Object.hasOwn(bounded, 'navigationPartition'), false);
  }
  for (const partition of ['unit-source-kind', 'source-family']) {
    const { bounded, ...observed } = await navigationOnlyRun(partition);
    assert.equal(observed.plan, MAIN_GOLDEN.plan, partition);
    assert.notEqual(observed.selection, MAIN_GOLDEN.selection, partition);
    assert.notEqual(observed.lanes, MAIN_GOLDEN.lanes, partition);
    assert.equal(bounded.navigationPartition, partition);
  }
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
  const reading = await readingBeforeSelection({ assets, userQuery, env: familyEnv, ...noDense });
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
    // A publication allowlist can leave a source family with fewer than 32
    // units. The lane contains the whole available pool up to its usual cap.
    const available = [...snapshot.units.values()].filter(member).length;
    assert.equal(lane.hits.length, Math.min(32, available), channel);
  }
  const ruleLane = reading.lanes.find(row => row.needId === 'original'
    && row.sourceKind === 'rule' && row.channel === `navigation_lexical:${family(snapshot.units.get(record.unitKey))}`);
  assert.ok(ruleLane.hits.some(hit => hit.unitKey === record.unitKey),
    'the record found by its own search question is in the rule navigation lane');
  assert.ok(ruleLane.hits.some(hit => assets.navigationRecordsByUnit.get(hit.unitKey)?.sourceKind === undefined)
    || assets.navigationRecords.every(row => row.sourceKind !== undefined));
  // legacy (the default): the rule lane only holds units whose record has its own sourceKind.
  const legacy = await readingBeforeSelection({ assets, userQuery, env: fixtureEnv, ...noDense });
  const legacyRule = legacy.lanes.find(row => row.needId === 'original' && row.sourceKind === 'rule'
    && row.channel === 'navigation_lexical');
  assert.deepEqual(legacyRule.hits.map(hit => hit.unitKey), full.filter(hit => hit.sourceKind === 'rule')
    .slice(0, 32).map(hit => hit.unitKey));
  assert.ok(legacyRule.hits.every(hit => assets.navigationRecordsByUnit.get(hit.unitKey)?.sourceKind === 'rule'));
});
