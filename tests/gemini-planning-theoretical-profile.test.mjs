import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertGenerationCapacity,
  buildEvidenceInputMeasurement,
  buildGeminiInputMeasurement,
  estimateGenerationUpperBoundUsd,
  loadEvidenceGenerationContract,
  usesTheoreticalMeasurement,
} from '../backend/evidenceGenerationContract.mjs';

const THEORETICAL = 'gemini-3.8-flash-medium-planning-room-theoretical';
const PROVIDER_COUNT = 'gemini-3.8-flash-medium-planning-room';

function planningBody(contract) {
  return {
    contents: [{ role: 'user', parts: [{ text: '为原题规划证据检索' }, { text: JSON.stringify({ question: '连锁处理时对象离场，效果是否处理？', confirmedCards: [] }) }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: 'medium' },
      maxOutputTokens: contract.maxBillableOutputTokens,
      candidateCount: 1,
      responseMimeType: 'application/json',
    },
  };
}

test('the theoretical planning profile keeps the planning-room generation profile and only changes counting', () => {
  const theoretical = loadEvidenceGenerationContract('planning', { env: { EVIDENCE_PLANNING_PROFILE: THEORETICAL } });
  const counted = loadEvidenceGenerationContract('planning', { env: { EVIDENCE_PLANNING_PROFILE: PROVIDER_COUNT } });
  assert.equal(usesTheoreticalMeasurement(theoretical), true);
  assert.equal(usesTheoreticalMeasurement(counted), false);
  for (const key of ['providerId', 'modelId', 'apiContractVersion', 'priceVersion', 'maxBillableOutputTokens']) {
    assert.deepEqual(theoretical[key], counted[key], key);
  }
  assert.deepEqual(theoretical.reasoningConfig, counted.reasoningConfig);
  assert.deepEqual(theoretical.pricingContract, counted.pricingContract);
  assert.deepEqual(theoretical.capacityContract, counted.capacityContract);
  assert.notEqual(theoretical.countingContractVersion, counted.countingContractVersion);
  assert.equal(theoretical.measurementContract.estimator.bytesPerToken, 2);
});

test('the theoretical planning profile measures locally without a countTokens round trip and binds the ledger metadata', async () => {
  const contract = loadEvidenceGenerationContract('planning', { env: { EVIDENCE_PLANNING_PROFILE: THEORETICAL } });
  const body = planningBody(contract);
  let countCalls = 0;
  const measurement = await buildEvidenceInputMeasurement({ body, contract,
    countTokens: async () => { countCalls++; return { totalTokens: 1 }; } });
  assert.equal(countCalls, 0);
  assert.equal(measurement.basis, 'user_authorized_theoretical');
  assert.equal(measurement.exact, false);
  assert.equal(measurement.inputTokenAllocationKind, 'theoretical_estimate');
  assert.equal(measurement.estimatorVersion, 'google-utf8-bytes-theoretical-v1');
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  assert.equal(measurement.requestBodyBytes, bytes);
  assert.equal(measurement.inputTokensUpperBound, Math.ceil(bytes / 2) + 256);
  const capacity = assertGenerationCapacity({ body, contract, measurement });
  assert.equal(capacity.inputTokensUpperBound, measurement.inputTokensUpperBound);
  const upper = estimateGenerationUpperBoundUsd({ measurement, contract });
  assert.equal(upper.basis, 'user_authorized_theoretical_estimated_input_and_max_billable_output');
  assert.ok(upper.amountUsd > 0);
  // The provider-count builder refuses a theoretical contract, so a profile can
  // never silently mix a remote count with a theoretical estimator.
  await assert.rejects(buildGeminiInputMeasurement({ body, contract, countTokens: async () => ({ totalTokens: 1 }) }),
    /evidence_generation_measurement_provider_unsupported/u);
});

test('the provider-count planning profile still requires the remote count and rejects theoretical measurements', async () => {
  const contract = loadEvidenceGenerationContract('planning', { env: { EVIDENCE_PLANNING_PROFILE: PROVIDER_COUNT } });
  const body = planningBody(contract);
  let countCalls = 0;
  const measurement = await buildEvidenceInputMeasurement({ body, contract,
    countTokens: async () => { countCalls++; return { totalTokens: 321 }; } });
  assert.equal(countCalls, 1);
  assert.equal(measurement.basis, 'provider_count');
  assert.equal(measurement.inputTokensUpperBound, 321);
  assert.throws(() => assertGenerationCapacity({ body, contract,
    measurement: { ...measurement, basis: 'user_authorized_theoretical', exact: false } }),
  /evidence_generation_measurement_invalid|evidence_generation_measurement_binding_error/u);
});
