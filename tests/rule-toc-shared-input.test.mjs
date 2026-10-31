import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureEnv, fixtureRetrieveInput, ruleTocAssets, ruleTocProvider,
  sha256 } from './helpers/rule-toc-fixture.mjs';

// All traffic is served by ruleTocProvider's fetchImpl. These tests never use
// a provider tokenizer or model; usage matches this deterministic text count.
globalThis.fetch = async () => { throw new Error('shared_input_test_network_forbidden'); };
const countInput = body => Math.ceil(body.input.reduce((sum, message) => sum + message.content.length, 0) / 2) + 20;
const usage = body => ({ input_tokens: countInput(body), output_tokens: 100,
  total_tokens: countInput(body) + 100, input_tokens_details: { cached_tokens: 0 } });
const selectionInput = body => JSON.parse(body.input.find(message => message.role === 'user').content.split('\n').at(-1));
const isSelection = body => Array.isArray(selectionInput(body).groups);
const selectFirst = input => ({ selectedIds: input.groups.flatMap(group => [
  ...(group.units || []).map(row => row[0]), ...(group.items || []).map(item => item.handle),
]).slice(0, 1), note: '' });
const strictEnv = { ...fixtureEnv, RULE_TOC_ADMIT_ENABLED: 'true', RULE_TOC_SHARED_INPUT_BUDGET: 'baseline',
  GEMINI_EVIDENCE_READING_TARGET_CHARS: '50000' };
const roomyAssets = (length = 12000) => ruleTocAssets({ extraRuleRecords: [{ id: 'rule-doc-extra',
  recordType: 'rule-doc', title: 'extra budget material', sourceAuthority: 'community_reference', official: false,
  text: `gamma retained original paragraph ${'x'.repeat(length)}` }] });

async function run(options = {}, env = {}) {
  const fixture = ruleTocProvider({ assets: roomyAssets(), inputTokenCounter: countInput,
    tocUsage: usage, selectionUsage: usage, toc: () => ({ unitIndexes: [5], note: '' }),
    select: selectFirst, ...options });
  try {
    const result = await fixture.provider.retrieve(fixtureRetrieveInput(fixture.assets, { ...strictEnv, ...env }));
    return { ...fixture, result, bounded: result.telemetry.bounded, error: null };
  } catch (error) {
    return { ...fixture, result: null, bounded: error.boundedRetrieval, error };
  }
}

function completed(result) {
  assert.equal(result.error, null, result.error?.stack);
  assert.equal(result.calls.filter(call => call.kind === 'selection').length >= 1, true);
}

function withinBaseline(result) {
  const budget = result.bounded.ruleToc.sharedInputBudget;
  assert.ok(budget, 'strict mode establishes a provider-counted baseline');
  const paidCalls = result.calls.filter(call => ['toc', 'selection'].includes(call.kind));
  const sentInput = paidCalls.reduce((sum, call) => sum + countInput(call.body), 0);
  assert.ok(sentInput <= budget.baselineTokens, `${sentInput} sent > ${budget.baselineTokens} baseline`);
  assert.ok(budget.accountedInputTokens >= sentInput, 'every sent attempt retains its input charge');
  assert.ok(budget.accountedInputTokens <= budget.baselineTokens);
  for (const call of paidCalls) {
    assert.ok(result.countCalls.some(body => JSON.stringify(body.input) === JSON.stringify(call.body.input)
      && JSON.stringify(body.reasoning) === JSON.stringify(call.body.reasoning)), 'sent input was counted');
  }
  return budget;
}

test('directory plus selection fit the exact original request baseline and preserve chosen originals', async () => {
  const assets = roomyAssets();
  const original = await run({ assets }, { RULE_TOC_ADMIT_ENABLED: 'false', RULE_TOC_SHARED_INPUT_BUDGET: '' });
  completed(original);
  const result = await run({ assets });
  completed(result);
  const budget = withinBaseline(result);
  const originalBody = original.calls.find(call => call.kind === 'selection').body;
  assert.equal(budget.baselineTokens, countInput(originalBody));
  assert.equal(budget.baselineRequestSha256, sha256(JSON.stringify(originalBody)));
  assert.deepEqual(result.calls.map(call => call.kind), ['plan', 'toc', 'selection']);
  assert.equal(result.bounded.ruleToc.admittedCount, 1);
  assert.ok(result.result.packing.prompt.includes('beta timing paragraph two'));
  assert.ok(result.bounded.reading.omitted.length > 0);
  assert.ok(countInput(result.calls.find(call => call.kind === 'selection').body) < budget.baselineTokens);
  for (const body of result.countCalls) {
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(Object.hasOwn(body, 'max_output_tokens'), false);
    assert.equal(Object.hasOwn(body, 'prompt_cache_options'), false);
  }
});

test('insufficient room for directory and a readable unit sends only the original selection', async () => {
  const assets = ruleTocAssets();
  const original = await run({ assets }, { RULE_TOC_ADMIT_ENABLED: 'false', RULE_TOC_SHARED_INPUT_BUDGET: '' });
  completed(original);
  const baselineTokens = countInput(original.calls.at(-1).body);
  // Keep the original selection readable, then make the directory leave only
  // one token. This tests shared headroom without assuming a fixed prompt length.
  const result = await run({ assets, inputTokenCounter: body =>
    isSelection(body) ? countInput(body) : baselineTokens - 1 });
  completed(result);
  assert.deepEqual(result.calls.map(call => call.kind), ['plan', 'selection']);
  assert.deepEqual(result.calls.at(-1).body, original.calls.at(-1).body);
  assert.match(result.bounded.ruleToc.error, /shared_input_budget_exceeded/u);
  assert.deepEqual(withinBaseline(result).attempts.map(row => row.stage), ['selection']);
});

test('small complete corpus remains readable after directory selection changes the first unit', async () => {
  // The original integration reserved a one-unit prompt without its later
  // omitted-title overhead, then removed every unit after spending on ToC.
  const result = await run({ assets: ruleTocAssets() }, { GEMINI_EVIDENCE_READING_TARGET_CHARS: '8000' });
  completed(result);
  withinBaseline(result);
  assert.equal(result.bounded.reading.offered.length >= 1, true);
});

test('a large directory choice cannot crowd out every affordable ordinary unit', async () => {
  const result = await run({ assets: roomyAssets(30000), toc: () => ({ unitIndexes: [6], note: '' }) },
    { GEMINI_EVIDENCE_READING_TARGET_CHARS: '8000' });
  completed(result);
  withinBaseline(result);
  assert.equal(result.bounded.reading.offered.length >= 1, true);
  assert.equal(result.bounded.reading.offered.some(row => row.unitKey.startsWith('rule-doc-extra:')), false);
});

test('both directory format attempts consume the same baseline', async () => {
  let attempt = 0;
  const result = await run({ toc: () => ++attempt === 1 ? 'not json' : { unitIndexes: [5], note: '' } });
  completed(result);
  const budget = withinBaseline(result);
  assert.deepEqual(result.calls.map(call => call.kind), ['plan', 'toc', 'toc', 'selection']);
  assert.deepEqual(budget.attempts.map(row => row.stage), ['rule_toc', 'rule_toc', 'selection']);
  assert.ok(budget.attempts[1].inputTokens > budget.attempts[0].inputTokens, 'retry instruction also costs input');
});

test('a sent transient failure keeps its charge when the directory is retried', async () => {
  let attempt = 0;
  const result = await run({ toc: () => ++attempt === 1
    ? Response.json({ error: { code: 503 } }, { status: 503 }) : { unitIndexes: [5], note: '' } });
  completed(result);
  const budget = withinBaseline(result);
  assert.equal(result.calls.filter(call => call.kind === 'toc').length, 2);
  assert.equal(budget.attempts[0].status, 'reserved');
  assert.equal(budget.attempts[0].reportedInputTokens, null);
  assert.equal(budget.reservedInputTokens, countInput(result.calls.find(call => call.kind === 'toc').body));
});

test('two malformed directory responses stop retrying and leave a bounded selection', async () => {
  const result = await run({ toc: () => ({ indexes: [5] }) });
  completed(result);
  withinBaseline(result);
  assert.equal(result.calls.filter(call => call.kind === 'toc').length, 2);
  assert.equal(result.bounded.ruleToc.status, 'failed');
  assert.match(result.bounded.ruleToc.error, /rule_toc_output_invalid/u);
});

test('directory retry is not submitted when it would consume selection headroom', async () => {
  const result = await run({ assets: ruleTocAssets(), toc: () => 'not json' },
    { GEMINI_EVIDENCE_READING_TARGET_CHARS: '8000' });
  completed(result);
  withinBaseline(result);
  assert.equal(result.calls.filter(call => call.kind === 'toc').length, 1);
  assert.match(result.bounded.ruleToc.error, /shared_input_budget_exceeded/u);
});

test('unavailable baseline counting skips directory before any extra generation', async () => {
  const assets = roomyAssets();
  const result = await run({ assets, inputTokenCounter: () => Response.json({ error: {} }, { status: 500 }) });
  completed(result);
  const original = await run({ assets }, { RULE_TOC_ADMIT_ENABLED: 'false', RULE_TOC_SHARED_INPUT_BUDGET: '' });
  completed(original);
  assert.deepEqual(result.calls.map(call => call.kind), ['plan', 'selection']);
  assert.equal(result.countCalls.length, 1);
  assert.deepEqual(result.calls.at(-1).body, original.calls.at(-1).body);
  assert.equal(result.bounded.ruleToc.skipReason, 'input_count_unavailable');
  assert.equal(result.bounded.ruleToc.sharedInputBudget, null);
});

test('directory count failure spends nothing and keeps the original bounded selection', async () => {
  const result = await run({ inputTokenCounter: body => {
    if (!isSelection(body)) throw new Error('fixture_directory_count_failed');
    return countInput(body);
  } });
  completed(result);
  assert.deepEqual(result.calls.map(call => call.kind), ['plan', 'selection']);
  assert.match(result.bounded.ruleToc.error, /fixture_directory_count_failed/u);
  withinBaseline(result);
});

test('counting failure after a paid directory never sends an uncounted selection', async () => {
  let directorySent = false;
  const result = await run({ toc: () => { directorySent = true; return { unitIndexes: [5], note: '' }; },
    inputTokenCounter: body => {
      if (directorySent && isSelection(body)) throw new Error('fixture_selection_count_failed');
      return countInput(body);
    } });
  assert.match(result.error?.message || '', /fixture_selection_count_failed/u);
  assert.deepEqual(result.calls.map(call => call.kind), ['plan', 'toc']);
  withinBaseline(result);
});

test('selection retry is charged and can run only when the original baseline can afford it', async () => {
  let attempt = 0;
  const result = await run({ select: input => ++attempt === 1 ? {} : selectFirst(input) });
  completed(result);
  const budget = withinBaseline(result);
  assert.deepEqual(budget.attempts.map(row => row.stage), ['rule_toc', 'selection', 'selection']);
  assert.equal(result.calls.filter(call => call.kind === 'selection').length, 2);
});

test('an unaffordable selection retry stops before another generation call', async () => {
  const result = await run({ assets: roomyAssets(5000), select: () => ({}) });
  assert.match(result.error?.message || '', /shared_input_budget_exceeded/u);
  assert.equal(result.calls.filter(call => call.kind === 'selection').length, 1);
  withinBaseline(result);
});

test('missing directory usage never refunds its provider-counted input', async () => {
  const result = await run({ tocUsage: null });
  completed(result);
  const budget = withinBaseline(result);
  assert.equal(budget.attempts[0].reportedInputTokens, null);
  assert.equal(budget.attempts[0].accountedInputTokens,
    countInput(result.calls.find(call => call.kind === 'toc').body));
});

test('a provider count mismatch freezes future generation even with remaining room', async () => {
  const result = await run({ tocUsage: body => ({ ...usage(body), input_tokens: countInput(body) + 1 }) });
  assert.match(result.error?.message || '', /shared_input_count_mismatch/u);
  assert.deepEqual(result.calls.map(call => call.kind), ['plan', 'toc']);
  const budget = withinBaseline(result);
  assert.equal(budget.frozen, true);
  assert.equal(budget.accountedInputTokens, countInput(result.calls.at(-1).body) + 1);
});
