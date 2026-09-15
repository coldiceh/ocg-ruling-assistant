import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertGenerationCapacity,
  buildEvidenceInputMeasurement,
  estimateGenerationUpperBoundUsd,
  loadEvidenceGenerationContract,
  normalizeEvidenceGenerationUsage,
} from '../backend/evidenceGenerationContract.mjs';
import { convertEvidenceGenerationRequest } from '../backend/evidenceGenerationTransport.mjs';

const profiles = [
  new URL(
    '../config/evidence-generation/bai-gpt-5.6-luna-low-theoretical.json',
    import.meta.url,
  ),
  new URL(
    '../config/evidence-generation/bai-deepseek-v4.1-flash-low-theoretical.json',
    import.meta.url,
  ),
];

function semanticBody(contract, text = 'public fixture') {
  return {
    systemInstruction: { parts: [{ text: 'return json' }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      maxOutputTokens: contract.maxBillableOutputTokens,
      responseMimeType: 'application/json',
    },
  };
}

test('B.AI theoretical profiles are ready with low effort and the pilot output allocations', () => {
  for (const profileUrl of profiles) {
    const navigation = loadEvidenceGenerationContract('navigation', { profileUrl });
    const planning = loadEvidenceGenerationContract('planning', { profileUrl });
    const selection = loadEvidenceGenerationContract('selection', { profileUrl });
    assert.equal(navigation.providerId, 'bai');
    assert.deepEqual(navigation.reasoningConfig.responses, { effort: 'low' });
    assert.equal(navigation.maxBillableOutputTokens, 2048);
    assert.equal(planning.maxBillableOutputTokens, 4096);
    assert.equal(selection.maxBillableOutputTokens, 4096);
    assert.equal(navigation.measurementContract.status, 'user_authorized_theoretical');
    assert.equal(navigation.measurementContract.exact, false);
  }
});

test('B.AI measurement estimates the complete converted Responses wire and keeps exact binding', async () => {
  const contract = loadEvidenceGenerationContract('navigation', { profileUrl: profiles[0] });
  const wire = convertEvidenceGenerationRequest(semanticBody(contract), contract);
  const serialized = JSON.stringify(wire);
  const measurement = await buildEvidenceInputMeasurement({ body: wire, contract });
  const expected = Math.ceil(Buffer.byteLength(serialized, 'utf8') / 3) + 256;
  assert.equal(measurement.inputTokensUpperBound, expected);
  assert.equal(measurement.contextInputTokensUpperBound, expected);
  assert.equal(measurement.inputTokenAllocationKind, 'theoretical_estimate');
  assert.equal(measurement.basis, 'user_authorized_theoretical');
  assert.equal(measurement.exact, false);
  assertGenerationCapacity({ body: wire, contract, measurement });
  assert.throws(
    () => assertGenerationCapacity({
      body: { ...wire, input: [{ role: 'user', content: 'changed' }] },
      contract,
      measurement,
    }),
    /evidence_generation_measurement_binding_error/u,
  );
  const reservation = estimateGenerationUpperBoundUsd({ measurement, contract });
  assert.equal(reservation.basis,
    'user_authorized_theoretical_estimated_input_and_max_billable_output');
  assert.equal(reservation.amountUsd,
    (expected * 0.25 + contract.maxBillableOutputTokens * 1.2) / 1_000_000);
});

test('B.AI usage normalization prices reported input, cache write, cache read, and reasoning output', () => {
  const contract = loadEvidenceGenerationContract('navigation', { profileUrl: profiles[0] });
  const normalized = normalizeEvidenceGenerationUsage({
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 5 },
    total_tokens: 120,
  }, contract);
  assert.deepEqual(normalized.billableUsage, {
    status: 'known',
    inputTokens: 100,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 5,
    candidatesTokens: 15,
    thinkingTokens: 5,
    totalTokens: 120,
    billableOutputTokens: 20,
  });
  assert.equal(normalized.billableCost.amountUsd,
    (85 * 0.2 + 10 * 0.02 + 5 * 0.25 + 20 * 1.2) / 1_000_000);
  assert.equal(normalized.billableCost.basis,
    'provider_reported_usage_theoretical_usd_not_supplier_charge');
});

test('missing B.AI usage stays unknown so the theoretical reservation can remain', () => {
  const contract = loadEvidenceGenerationContract('navigation', { profileUrl: profiles[1] });
  const normalized = normalizeEvidenceGenerationUsage({ input_tokens: 100 }, contract);
  assert.equal(normalized.billableUsage.status, 'unknown');
  assert.equal(normalized.billableCost.status, 'unknown');
  assert.equal(normalized.billableCost.amountUsd, null);
});

test('production environment selects planning and selection profiles independently', () => {
  const env = {
    EVIDENCE_PLANNING_PROFILE: 'bai-deepseek-v4.1-flash-none-theoretical',
    EVIDENCE_SELECTION_PROFILE: 'bai-gpt-5.6-luna-low-theoretical',
  };
  const planning = loadEvidenceGenerationContract('planning', { env });
  const selection = loadEvidenceGenerationContract('selection', { env });
  assert.equal(planning.modelId, 'deepseek-v4.1-flash');
  assert.deepEqual(planning.reasoningConfig.responses, { effort: 'none' });
  assert.equal(selection.modelId, 'gpt-5.6-luna');
  assert.deepEqual(selection.reasoningConfig.responses, { effort: 'low' });
});
