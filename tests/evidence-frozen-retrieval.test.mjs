import assert from 'node:assert/strict';
import test from 'node:test';
import { ruleTocProvider, fixtureEnv, fixtureRetrieveInput } from './helpers/rule-toc-fixture.mjs';

test('frozen paid upstream results reproduce the original selection bytes without upstream calls', async () => {
  const original = ruleTocProvider();
  const prior = await original.provider.retrieve(fixtureRetrieveInput(original.assets, fixtureEnv));
  const replay = ruleTocProvider({ assets: original.assets, frozenRetrieval: {
    queryPlan: prior.telemetry.queryPlan, lanes: prior.telemetry.bounded.reading.lanes,
  }, plan: () => assert.fail('must not run the paid plan again') });
  const result = await replay.provider.retrieve(fixtureRetrieveInput(replay.assets, fixtureEnv));
  assert.deepEqual(replay.calls.map(row => row.kind), ['selection']);
  assert.deepEqual(replay.calls[0].body, original.calls.find(row => row.kind === 'selection').body);
  assert.deepEqual(result.telemetry.bounded.calls.map(row => row.stage), ['selection']);
  assert.equal(result.packing.prompt, prior.packing.prompt);
});

test('frozen baseline mismatch stops before token counting or any new generation', async () => {
  const original = ruleTocProvider();
  const prior = await original.provider.retrieve(fixtureRetrieveInput(original.assets, fixtureEnv));
  const replay = ruleTocProvider({ assets: original.assets, frozenRetrieval: {
    queryPlan: prior.telemetry.queryPlan, lanes: prior.telemetry.bounded.reading.lanes,
    expectedBaselineRequestSha256: '0'.repeat(64),
  }, toc: () => assert.fail('no directory before binding check'),
  inputTokenCounter: () => assert.fail('no count before binding check') });
  await assert.rejects(replay.provider.retrieve(fixtureRetrieveInput(replay.assets, {
    ...fixtureEnv, RULE_TOC_ADMIT_ENABLED: 'true', RULE_TOC_SHARED_INPUT_BUDGET: 'baseline',
  })), /evidence_frozen_baseline_request_mismatch/);
  assert.equal(replay.calls.length, 0);
});
