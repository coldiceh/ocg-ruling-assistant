import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadEvidenceGenerationContract, buildEvidenceInputMeasurement,
  estimateGenerationUpperBoundUsd, normalizeEvidenceGenerationUsage,
} from '../backend/evidenceGenerationContract.mjs';
import { convertEvidenceGenerationRequest } from '../backend/evidenceGenerationTransport.mjs';

const env = {
  EVIDENCE_PLANNING_PROFILE: 'gemini-3.8-flash-medium-planning-room',
  EVIDENCE_SELECTION_PROFILE: 'bai-gpt-5.6-luna-high-theoretical',
  EVIDENCE_GENERATION_OUTPUT_LIMIT: 'provider',
};

test('Luna high omits the request output cap and reserves the provider maximum', async () => {
  const contract = loadEvidenceGenerationContract('selection', { env });
  const body = convertEvidenceGenerationRequest({
    contents: [{ role: 'user', parts: [{ text: 'Return fixture JSON.' }] }],
    generationConfig: { maxOutputTokens: 4096 },
  }, contract);
  assert.equal(Object.hasOwn(body, 'max_output_tokens'), false);
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(contract.maxBillableOutputTokens, contract.capacityContract.maxOutputTokens);
  const measurement = await buildEvidenceInputMeasurement({ body, contract });
  const reserve = estimateGenerationUpperBoundUsd({ measurement, contract });
  assert.equal(reserve.amountUsd, (measurement.inputTokensUpperBound * 0.25 + 128000 * 1.2) / 1e6);
  const usage = normalizeEvidenceGenerationUsage({ input_tokens: 100, output_tokens: 6000,
    output_tokens_details: { reasoning_tokens: 5800 }, total_tokens: 6100 }, contract);
  assert.equal(usage.billableCost.status, 'known');
  assert.equal(usage.billableUsage.candidatesTokens, 200);
});

test('Gemini planning accepts an omitted output parameter and reserves provider capacity', async () => {
  const contract = loadEvidenceGenerationContract('planning', { env });
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Return fixture JSON.' }] }],
    generationConfig: { thinkingConfig: { thinkingLevel: 'medium' }, responseMimeType: 'application/json' },
  };
  assert.equal(contract.maxBillableOutputTokens, 65536);
  const measurement = await buildEvidenceInputMeasurement({ body, contract,
    countTokens: async () => ({ totalTokens: 100 }) });
  assert.equal(estimateGenerationUpperBoundUsd({ measurement, contract }).amountUsd,
    (100 * 0.75 + 65536 * 3.75) / 1e6);
});
