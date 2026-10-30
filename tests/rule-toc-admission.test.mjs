import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOUD_BUDGET_RESERVE } from '../backend/cloudRequestBudget.mjs';
import { buildRuleToc, normalizeRuleTocOutput, resolveRuleTocConfig, ruleTocRequestBody,
  RULE_TOC_DESCRIPTION_CHARS } from '../backend/ruleTocAdmission.mjs';
import { fixtureEnv, fixtureQuestion, fixtureRetrieveInput, ruleTocAssets, ruleTocProvider,
  sha256 } from './helpers/rule-toc-fixture.mjs';

// Golden values of this fixture with the flag off, computed on the unmodified
// provider (commit 483b000, before the ToC stage existed). If an unrelated change
// to the plan or selection prompt changes them, recompute them from the new
// baseline with the flag off; they must never differ between flag off and absent.
const OFF_GOLDEN = Object.freeze({
  plan: '69904c77cb6d896fe9603a64676a7faf5d722279e8d8ca2dfe381ca49638217f',
  selection: '3d278e1fda5bb4a351caf614b3be70f980229455ee7478958bfa009c00aa7285',
  selectionChars: 5301,
  prompt: '162c240096815233fa88015d4b107a6790f769903369db9547b6b09eb94b8467',
  profileHash: 'ffa7a00fc2f0b6e60a15c64ff9ad195b784a1edd3a3e9e18675b991ea5af8500',
});
const V2 = 'original-support-need-unseen-whole-bundle-v2';
const V3 = 'priority-whole-unit-then-original-support-need-unseen-whole-bundle-v3';
const onEnv = { ...fixtureEnv, RULE_TOC_ADMIT_ENABLED: 'true' };
const selectionBodies = calls => calls.filter(call => call.kind === 'selection').map(call => JSON.stringify(call.body));
const delivered = call => JSON.parse(call.body.input.find(message => message.role === 'user').content.split('\n').at(-1));
// ToC index 5 is the second unit of rule-doc-b; the flag-off window omits it.
const OMITTED_KEY = 'rule-doc-b:reading:rule-doc-b:root:2';

async function run(env, options) {
  const fixture = ruleTocProvider(options);
  const result = await fixture.provider.retrieve(fixtureRetrieveInput(fixture.assets, env));
  return { ...fixture, result, bounded: result.telemetry.bounded };
}

test('flag off or absent: plan and selection requests are byte-identical to the unmodified provider', async () => {
  for (const env of [fixtureEnv, { ...fixtureEnv, RULE_TOC_ADMIT_ENABLED: 'false' }]) {
    const { calls, result, bounded } = await run(env, { toc: () => assert.fail('no ToC call when off') });
    assert.deepEqual(calls.map(call => call.kind), ['plan', 'selection']);
    assert.equal(sha256(JSON.stringify(calls[0].body)), OFF_GOLDEN.plan);
    const [selection] = selectionBodies(calls);
    assert.equal(selection.length, OFF_GOLDEN.selectionChars);
    assert.equal(sha256(selection), OFF_GOLDEN.selection);
    assert.equal(sha256(result.packing.prompt), OFF_GOLDEN.prompt);
    assert.equal(result.telemetry.generationProfileHash, OFF_GOLDEN.profileHash);
    assert.equal(bounded.schedulerContract, V2);
    assert.equal(Object.hasOwn(bounded, 'ruleToc'), false);
    assert.equal(bounded.reading.offered.some(bundle => bundle.unitKey === OMITTED_KEY), false);
  }
});

test('flag on: the chosen unit is offered whole before the rotation, labelled and accounted', async () => {
  let tocLines;
  const { calls, bounded, result } = await run(onEnv, { toc: lines => { tocLines = lines; return { unitIndexes: [5], note: 'needs the timing rule' }; },
    select: input => ({ selectedIds: input.groups.find(group => group.groupId === OMITTED_KEY).units.map(row => row[0]), note: '' }) });
  assert.deepEqual(calls.map(call => call.kind), ['plan', 'toc', 'selection']);
  // The table lists every rule reading unit; the question and card names come last.
  assert.equal(tocLines.length, 5);
  assert.match(tocLines[4], /^5\trule-doc-b\tfixture rule B\tfixture navigation description 5$/u);
  const toc = calls.find(call => call.kind === 'toc');
  assert.equal(toc.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(toc.body.reasoning, { effort: 'low' });
  assert.deepEqual(toc.body.prompt_cache_options, { mode: 'explicit' });
  assert.deepEqual(JSON.parse(toc.body.input.at(-1).content.split('\n').at(-1)),
    { question: fixtureQuestion, confirmedCards: [{ cnName: '测试卡甲', jaName: 'テストカード甲' }] });
  // Window: admitted first, labelled, still within the window.
  assert.equal(bounded.reading.offered[0].unitKey, OMITTED_KEY);
  assert.equal(bounded.reading.offered[0].admittedBy, 'rule_toc');
  assert.ok(bounded.reading.offered[0].hits.some(hit => hit.channel === 'rule_toc'));
  assert.ok(bounded.reading.lanes.some(lane => lane.channel === 'rule_toc' && lane.hits[0].unitKey === OMITTED_KEY));
  assert.equal(bounded.schedulerContract, V3);
  // The selector sees the admitted unit first, serialized exactly like any other group.
  const groups = delivered(calls.find(call => call.kind === 'selection')).groups;
  assert.equal(groups[0].groupId, OMITTED_KEY);
  assert.ok(groups.every(group => Object.keys(group).join() === (group.kind === 'rule' ? 'groupId,kind,units' : 'groupId,kind,items')));
  assert.ok(bounded.ruleToc.window.measuredChars <= 5000);
  // Telemetry.
  const toCTelemetry = bounded.ruleToc;
  assert.equal(toCTelemetry.status, 'selected');
  assert.deepEqual(toCTelemetry.selectedUnitKeys, [OMITTED_KEY]);
  assert.equal(toCTelemetry.inBaselineWindowCount, 0);
  assert.equal(toCTelemetry.admittedCount, 1);
  assert.equal(toCTelemetry.selectedIntoPackCount, 1);
  assert.equal(toCTelemetry.inputTokens, 9000);
  assert.equal(toCTelemetry.outputTokens, 150);
  assert.ok(toCTelemetry.contractUsd > 0 && toCTelemetry.officialListUsd > 0);
  assert.equal(toCTelemetry.pricingFileStatus, 'model_not_in_pricing_file');
  assert.ok(Number.isFinite(toCTelemetry.elapsedMs));
  assert.equal(result.telemetry.stageTelemetry.ruleToc.model, 'gpt-6-luna');
  const row = bounded.calls.find(call => call.stage === 'rule_toc');
  assert.equal(row.status, 'success');
  assert.equal(row.channel, 'official');
  assert.ok(result.packing.prompt.includes('beta timing paragraph two'));
});

test('the ToC call is reserved and settled in the official daily ledger like the selection', async () => {
  const order = [], keys = [];
  const budgetStore = { url: 'https://budget.example.invalid', respond: command => {
    const reserve = command[1] === CLOUD_BUDGET_RESERVE;
    order.push(reserve ? 'reserve' : 'settle'); keys.push(command[3]);
    return Response.json({ result: reserve ? ['reserved', '0', '1'] : ['settled', '0', '1'] });
  } };
  const env = { ...onEnv, PUBLIC_OPENAI_BUDGET_RUN_ID: 'public-official',
    UPSTASH_BUDGET_KV_REST_API_URL: budgetStore.url, UPSTASH_BUDGET_KV_REST_API_TOKEN: 'budget-token' };
  const { bounded } = await run(env, { budgetStore, toc: () => { order.push('toc'); return { unitIndexes: [5], note: '' }; },
    select: input => { order.push('selection'); return { selectedIds: input.groups[0].units.map(row => row[0]), note: '' }; } });
  assert.deepEqual(order, ['reserve', 'toc', 'settle', 'reserve', 'selection', 'settle']);
  assert.ok(keys.every(key => /^ruling-cloud-budget:v1:public-official:\d{4}-\d{2}-\d{2}$/u.test(key)));
  assert.equal(bounded.ruleToc.status, 'selected');
  assert.ok(Number.isFinite(bounded.ruleToc.elapsedMs) && Number.isFinite(bounded.ruleToc.assetWaitMs));
});

test('invalid and repeated indexes are dropped without a retry', async () => {
  const { calls, bounded } = await run(onEnv, { toc: () => ({ unitIndexes: [0, 6, -1, 2.5, 'abc', null, '3', 3, 5], note: '' }) });
  assert.equal(calls.filter(call => call.kind === 'toc').length, 1);
  assert.deepEqual(bounded.ruleToc.indexes, [3, 5]);
  assert.deepEqual(bounded.ruleToc.invalidIndexes, ['0', '6', '-1', '2.5', 'abc', 'null']);
  assert.deepEqual(bounded.ruleToc.duplicateIndexes, [3]);
  assert.deepEqual(bounded.reading.offered.slice(0, 2).map(bundle => bundle.admittedBy), ['rule_toc', 'rule_toc']);
});

test('RULE_TOC_ADMIT_MAX_UNITS keeps the first indexes in the returned order', async () => {
  const { calls, bounded } = await run({ ...onEnv, RULE_TOC_ADMIT_MAX_UNITS: '2' },
    { toc: () => ({ unitIndexes: [5, 4, 3, 2], note: '' }) });
  assert.match(calls.find(call => call.kind === 'toc').body.input.at(-1).content, /最多选2个/u);
  assert.deepEqual(bounded.ruleToc.indexes, [5, 4]);
  assert.deepEqual(bounded.ruleToc.truncatedIndexes, [3, 2]);
  assert.equal(bounded.reading.offered.filter(bundle => bundle.admittedBy === 'rule_toc').length, 2);
});

test('malformed output is retried once with the format instruction', async () => {
  let attempt = 0;
  const { calls, bounded } = await run(onEnv, { toc: () => (++attempt === 1 ? 'not json' : { unitIndexes: [5], note: '' }) });
  const tocCalls = calls.filter(call => call.kind === 'toc');
  assert.equal(tocCalls.length, 2);
  assert.match(tocCalls[1].body.input.at(-1).content, /只返回JSON对象，包含unitIndexes整数数组/u);
  assert.equal(bounded.ruleToc.status, 'selected');
  assert.deepEqual(bounded.ruleToc.attempts.map(row => [row.status, row.retry]), [['failed', false], ['success', true]]);
});

for (const [label, toc, env, status] of [
  ['malformed twice', () => ({ indexes: [5] }), onEnv, 'failed'],
  ['HTTP 500', () => Response.json({ error: { code: 'server_error' } }, { status: 500 }), onEnv, 'failed'],
  ['timeout', (_lines, _body, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }), { ...onEnv, RULE_TOC_ADMIT_TIMEOUT_MS: '30' }, 'timeout'],
]) {
  test(`a ToC failure (${label}) leaves the main chain and its selection request unchanged`, async () => {
    const { calls, bounded, result } = await run(env, { toc });
    assert.equal(bounded.ruleToc.status, status);
    assert.deepEqual(bounded.ruleToc.selectedUnitKeys, []);
    // No unit is admitted by the ToC, so the selector reads the flag-off window.
    const [selection] = selectionBodies(calls);
    assert.equal(sha256(selection), OFF_GOLDEN.selection);
    assert.ok(result.packing.prompt.length > 0);
  });
}

test('a chosen unit outside every lane is materialized with its packing cost', async () => {
  const extraRuleRecords = [{ id: 'rule-doc-c', recordType: 'rule-doc', title: 'fixture rule C',
    sourceAuthority: 'community_reference', official: false,
    text: Array.from({ length: 160 }, (_, index) => `gamma clause ${index} text`).join('\n\n') }];
  const first = await run(onEnv, { assets: ruleTocAssets({ extraRuleRecords }), toc: () => ({ unitIndexes: [], note: '' }) });
  assert.equal(first.bounded.ruleToc.status, 'empty');
  const inLanes = new Set(first.bounded.reading.lanes.flatMap(lane => lane.hits.map(hit => hit.unitKey)));
  const ordered = first.assets.ruleUnits.map(unit => unit.unitKey);
  const outside = ordered.findIndex(key => !inLanes.has(key));
  assert.ok(outside >= 0, 'fixture has a rule unit in no lane');
  const second = await run(onEnv, { assets: ruleTocAssets({ extraRuleRecords }), toc: () => ({ unitIndexes: [outside + 1], note: '' }),
    select: input => ({ selectedIds: input.groups.find(group => group.groupId === ordered[outside]).units.map(row => row[0]), note: '' }) });
  assert.deepEqual(second.bounded.ruleToc.inOtherLanesUnitKeys, []);
  assert.equal(second.bounded.reading.offered[0].unitKey, ordered[outside]);
  const input = delivered(second.calls.find(call => call.kind === 'selection'));
  const ids = input.groups.find(group => group.groupId === ordered[outside]).units.map(row => row[0]);
  assert.equal(input.groups.some(group => Object.hasOwn(group, 'channel')), false);
  for (const id of ids) assert.ok(Number.isSafeInteger(input.packingBudget.ruleUnitChars[id]), id);
  assert.equal(second.bounded.ruleToc.selectedIntoPackCount, 1);
});

test('invalid settings fail before any model call', async () => {
  for (const [key, value] of [['RULE_TOC_ADMIT_MAX_UNITS', '0'], ['RULE_TOC_ADMIT_MAX_UNITS', 'many'],
    ['RULE_TOC_ADMIT_PROFILE', '../secret'], ['RULE_TOC_ADMIT_TIMEOUT_MS', '-5']]) {
    const fixture = ruleTocProvider({ toc: () => ({ unitIndexes: [] }) });
    await assert.rejects(fixture.provider.retrieve(fixtureRetrieveInput(fixture.assets, { ...onEnv, [key]: value })),
      new RegExp(`evidence_config_invalid_${key}`, 'u'));
    assert.equal(fixture.calls.length, 0);
  }
  assert.equal(resolveRuleTocConfig({}), null);
  assert.deepEqual({ ...resolveRuleTocConfig({ RULE_TOC_ADMIT_ENABLED: 'on' }) }, { profile: 'bai-gpt-6-luna-low-theoretical',
    maxUnits: 8, timeoutMs: 30000, descriptionChars: RULE_TOC_DESCRIPTION_CHARS });
});

test('table lines keep identity order, one line per unit, and clip descriptions', () => {
  const long = `第一行\n${'描'.repeat(200)}`;
  const rules = { readingUnits: new Map([
    ['u1', { sourceId: 'ocg-rule:c02/页', titlePath: ['页 ¶', '小节 ¶'] }],
    ['u2', { sourceId: 'konami:book', titlePath: [], title: '章' }],
  ]) };
  const toc = buildRuleToc({ rules, navigationRecordsByUnit: new Map([['u1', { descriptionZh: long }]]) });
  const lines = toc.text.split('\n');
  assert.deepEqual(toc.unitKeys, ['u1', 'u2']);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], `1\tocg-rule:c02/页\t页 ¶ > 小节 ¶\t第一行 ${'描'.repeat(RULE_TOC_DESCRIPTION_CHARS - 4)}…`);
  assert.equal(lines[1], '2\tkonami:book\t章');
  const empty = new Map();
  assert.equal(buildRuleToc({ rules, navigationRecordsByUnit: empty }), buildRuleToc({ rules, navigationRecordsByUnit: empty }));
  assert.equal(buildRuleToc({ rules, navigationRecordsByUnit: empty }).text, '1\tocg-rule:c02/页\t页 ¶ > 小节 ¶\n2\tkonami:book\t章');
  assert.throws(() => normalizeRuleTocOutput({ selectedIds: [1] }, { unitKeys: toc.unitKeys, maxUnits: 8 }), /rule_toc_output_invalid/u);
  const body = ruleTocRequestBody({ toc, question: 'q', maxUnits: 3, resolvedCards: [
    { name: '甲', cnName: '甲', jaName: 'カ', enName: 'A', effectText: 'not sent' }, { name: '乙' }, { id: 'no-name' }] });
  assert.deepEqual(body.contents[0].parts.map(part => part.text).slice(1), [toc.text,
    JSON.stringify({ question: 'q', confirmedCards: [{ cnName: '甲', jaName: 'カ', enName: 'A' }, { name: '乙' }] })]);
  assert.deepEqual(normalizeRuleTocOutput({ result: { unitIndexes: [2] } }, { unitKeys: toc.unitKeys, maxUnits: 8 }).unitKeys, ['u2']);
});
