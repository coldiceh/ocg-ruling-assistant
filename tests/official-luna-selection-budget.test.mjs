import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudRequestBudget, CLOUD_BUDGET_RESERVE } from '../backend/cloudRequestBudget.mjs';
import { buildEvidenceInputMeasurement, loadEvidenceGenerationContract } from '../backend/evidenceGenerationContract.mjs';
import { createEvidenceGenerationTransport } from '../backend/evidenceGenerationTransport.mjs';

const env = { CLOUD_BUDGET_RUN_ID: 'official-luna-selection-test', CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '0',
  CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '5' };
const contract = loadEvidenceGenerationContract('selection', { env: {
  EVIDENCE_SELECTION_PROFILE: 'bai-gpt-6-luna-high-theoretical', EVIDENCE_GENERATION_OUTPUT_LIMIT: 'provider' } });
const transport = createEvidenceGenerationTransport({ contract, fetchImpl: async () => {},
  env: { RAG_EVIDENCE_LUNA_CHANNEL: 'official', RAG_EVIDENCE_OPENAI_API_KEY: 'fixture-key' } });
const body = transport.prepareRequest({ systemInstruction: { parts: [{ text: 'synthetic selection instructions' }] },
  contents: [{ role: 'user', parts: [{ text: 'synthetic selection input' }] }] });
const measurement = await buildEvidenceInputMeasurement({ body, contract, checkCapacity: false });
const usage = { input_tokens: 115_378, output_tokens: 3_722, total_tokens: 119_100,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };

function controller(block = false) {
  const commands = [];
  return { commands, budget: createCloudRequestBudget({ env, command: async args => {
    commands.push(args);
    return [args[1] === CLOUD_BUDGET_RESERVE ? (block ? 'blocked' : 'reserved') : 'settled'];
  } }) };
}
const request = (invoke) => ({ body, invoke, operation: 'generate_content', model: contract.modelId,
  measurement, generationContract: contract });

test('official Luna selection reserves the contract upper bound and settles at official GPT-6 Luna prices', async () => {
  const { budget } = controller();
  await budget.officialLunaGeneration(request(async () => ({ model: 'gpt-6-luna-2026-10-01', usage })));
  const call = budget.snapshot().calls[0];
  assert.equal(call.provider, 'openai');
  assert.equal(call.stage, 'evidence_preparation');
  assert.equal(call.model, 'gpt-6-luna');
  assert.match(call.pricingBasis, /official_channel/u);
  assert.ok(Math.abs(budget.snapshot().theoreticalUsd - 0.0133988) < 1e-9, 'input $0.10 and output $0.50 per 1M');
  assert.equal(budget.snapshot().reservedTheoreticalUsd, 0);
});

test('official Luna selection keeps failed reservations and blocks dispatch when the ledger is exhausted', async () => {
  const failed = controller();
  await assert.rejects(failed.budget.officialLunaGeneration(request(async () => { throw new Error('timeout'); })), /timeout/u);
  assert.ok(failed.budget.snapshot().reservedTheoreticalUsd > 0);
  const blocked = controller(true);
  let dispatched = 0;
  await assert.rejects(blocked.budget.officialLunaGeneration(request(async () => { dispatched += 1; })), /total_exceeded/u);
  assert.equal(dispatched, 0);
});

test('official Luna selection accepts only the priced GPT-6 Luna generation contract', async () => {
  const { budget, commands } = controller();
  await assert.rejects(budget.officialLunaGeneration({ ...request(async () => ({})), generationContract: { ...contract, modelId: 'gpt-6-astra' } }),
    /official_luna_generation_contract_required/u);
  await assert.rejects(budget.officialLunaGeneration({ ...request(async () => ({})), model: 'gpt-6-astra' }),
    /official_luna_generation_model_mismatch/u);
  assert.equal(commands.length, 0, 'rejected before any reservation');
});
