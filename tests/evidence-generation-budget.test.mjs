import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCloudRequestBudget,
  currentCloudPreparationRemainingUsd,
  runCloudBudgetedQuestion,
} from '../backend/cloudRequestBudget.mjs';
import {
  assertGenerationCapacity,
  buildGeminiInputMeasurement,
  estimateGenerationUpperBoundUsd,
  loadEvidenceGenerationContract,
  normalizeGeminiGenerationUsage,
} from '../backend/evidenceGenerationContract.mjs';

function bodyFor(contract, text = 'public fixture') {
  return {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: 'low' },
      maxOutputTokens: contract.maxBillableOutputTokens,
      responseMimeType: 'application/json',
    },
  };
}

function fixtureBudget() {
  const commands = [];
  const budget = createCloudRequestBudget({
    env: {
      CLOUD_BUDGET_RUN_ID: 'generation-contract-test',
      CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '10',
      CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '10',
    },
    command: async (command) => {
      commands.push(command);
      return [command[1].includes("status ~= 'reserved'") ? 'settled' : 'reserved'];
    },
  });
  return { budget, commands };
}

test('frozen Gemini profile derives the two generation stages and navigation output bounds', () => {
  const planning = loadEvidenceGenerationContract('planning');
  const selection = loadEvidenceGenerationContract('selection');
  const navigation = loadEvidenceGenerationContract('navigation');
  assert.equal(planning.modelId, 'gemini-3.8-flash');
  assert.deepEqual(planning.reasoningConfig, { thinkingConfig: { thinkingLevel: 'low' } });
  assert.equal(planning.maxBillableOutputTokens, 2048);
  assert.equal(selection.maxBillableOutputTokens, 2048);
  assert.equal(navigation.maxBillableOutputTokens, 1024);
  assert.equal(planning.capacityContract.maxInputTokens, 1_048_576);
  assert.equal(planning.capacityContract.maxRequestBodyBytes, 20_000_000);
  assert.equal(Object.isFrozen(planning), true);
  assert.equal(Object.isFrozen(planning.capacityContract), true);
});

test('Gemini measurement counts the complete generateContent request and binds its exact body', async () => {
  const contract = loadEvidenceGenerationContract('planning');
  const body = bodyFor(contract);
  let counted;
  const measurement = await buildGeminiInputMeasurement({
    body,
    contract,
    countTokens: async (request) => {
      counted = request;
      return { totalTokens: 987 };
    },
  });
  assert.equal(counted.generateContentRequest.model, 'models/gemini-3.8-flash');
  assert.deepEqual(counted.generateContentRequest.contents, body.contents);
  assert.equal(measurement.inputTokensUpperBound, 987);
  assert.equal(measurement.contextInputTokensUpperBound, 987);
  assert.equal(measurement.basis, 'provider_count');
  assert.equal(measurement.exact, true);
  assertGenerationCapacity({ body, contract, measurement });
  assert.throws(
    () => assertGenerationCapacity({
      body: bodyFor(contract, 'changed after countTokens'),
      contract,
      measurement,
    }),
    /evidence_generation_measurement_binding_error/,
  );
});

test('capacity checks reject a measured shared-window overflow before generation', async () => {
  const source = loadEvidenceGenerationContract('planning');
  const contract = structuredClone(source);
  contract.capacityContract.maxSharedContextTokens = 2_100;
  const body = bodyFor(contract);
  await assert.rejects(
    () => buildGeminiInputMeasurement({
      body,
      contract,
      countTokens: async () => ({ totalTokens: 100 }),
    }),
    /provider_shared_context_capacity_exceeded/,
  );
});

test('capacity checks enforce provider input and request-body limits independently', async () => {
  const inputContract = structuredClone(loadEvidenceGenerationContract('planning'));
  inputContract.capacityContract.maxInputTokens = 50;
  inputContract.capacityContract.maxSharedContextTokens = 10_000;
  await assert.rejects(
    () => buildGeminiInputMeasurement({
      body: bodyFor(inputContract),
      contract: inputContract,
      countTokens: async () => ({ totalTokens: 51 }),
    }),
    /provider_input_capacity_exceeded/,
  );

  const byteContract = structuredClone(loadEvidenceGenerationContract('planning'));
  byteContract.capacityContract.maxRequestBodyBytes = 1;
  await assert.rejects(
    () => buildGeminiInputMeasurement({
      body: bodyFor(byteContract),
      contract: byteContract,
      countTokens: async () => ({ totalTokens: 1 }),
    }),
    /provider_request_body_capacity_exceeded/,
  );
});

test('budget.gemini reserves from measured input and stores normalized billable usage', async () => {
  const contract = loadEvidenceGenerationContract('selection');
  const body = bodyFor(contract, 'x');
  const measurement = await buildGeminiInputMeasurement({
    body,
    contract,
    countTokens: async () => ({ totalTokens: 1_000 }),
  });
  const upper = estimateGenerationUpperBoundUsd({ measurement, contract });
  assert.equal(upper.amountUsd, (1_000 * 0.75 + 2_048 * 3.75) / 1_000_000);

  const { budget, commands } = fixtureBudget();
  let invoked = false;
  await budget.gemini({
    operation: 'generate_content',
    model: contract.modelId,
    body,
    measurement,
    generationContract: contract,
    invoke: async () => {
      invoked = true;
      return {
        modelVersion: contract.modelId,
        usageMetadata: {
          promptTokenCount: 1_000,
          cachedContentTokenCount: 0,
          candidatesTokenCount: 30,
          totalTokenCount: 1_100,
        },
      };
    },
  });
  assert.equal(invoked, true);
  assert.equal(commands.length, 2);
  const call = budget.snapshot().calls[0];
  assert.equal(call.status, 'usage_settled');
  assert.equal(call.reservationMetadata.inputTokensUpperBound, 1_000);
  assert.equal(call.reservationMetadata.requestSha256, measurement.requestSha256);
  assert.equal(call.billableUsage.thinkingTokens, null);
  assert.equal(call.billableUsage.billableOutputTokens, 100);
  assert.equal(call.billableUsage.status, 'known');
  assert.equal(call.billableCost.amountUsd, (1_000 * 0.75 + 100 * 3.75) / 1_000_000);
});

test('budget.gemini rejects stale measurement before reserve and invoke', async () => {
  const contract = loadEvidenceGenerationContract('planning');
  const body = bodyFor(contract);
  const measurement = await buildGeminiInputMeasurement({
    body,
    contract,
    countTokens: async () => ({ totalTokens: 100 }),
  });
  const changedBody = bodyFor(contract, 'different request');
  const { budget, commands } = fixtureBudget();
  let invoked = false;
  await assert.rejects(
    () => budget.gemini({
      operation: 'generate_content',
      model: contract.modelId,
      body: changedBody,
      measurement,
      generationContract: contract,
      invoke: async () => { invoked = true; },
    }),
    /evidence_generation_measurement_binding_error/,
  );
  assert.equal(commands.length, 0);
  assert.equal(invoked, false);
});

test('missing Gemini usage stays unknown and retains the conservative reservation', async () => {
  const contract = loadEvidenceGenerationContract('navigation');
  const body = bodyFor(contract);
  const measurement = await buildGeminiInputMeasurement({
    body,
    contract,
    countTokens: async () => ({ totalTokens: 400 }),
  });
  const normalized = normalizeGeminiGenerationUsage({ promptTokenCount: 400 }, contract);
  assert.equal(normalized.billableUsage.status, 'unknown');
  assert.equal(normalized.billableUsage.billableOutputTokens, null);
  assert.equal(normalized.billableCost.amountUsd, null);

  const { budget, commands } = fixtureBudget();
  await budget.gemini({
    operation: 'generate_content',
    model: contract.modelId,
    body,
    measurement,
    generationContract: contract,
    invoke: async () => ({
      modelVersion: contract.modelId,
      usageMetadata: { promptTokenCount: 400 },
    }),
  });
  const call = budget.snapshot().calls[0];
  assert.equal(commands.length, 1);
  assert.equal(call.status, 'reserved');
  assert.equal(call.billableUsage.status, 'unknown');
  assert.deepEqual(call.usageNormalization.missingOrInvalidFields, [
    'totalTokenCount',
    'billableOutputTokenCount',
  ]);
  assert.equal(call.uncertainty, 'provider_usage_missing_or_settlement_uncertain_reservation_retained');
});

test('usage above the frozen billable-output bound remains unknown', () => {
  const contract = loadEvidenceGenerationContract('navigation');
  const normalized = normalizeGeminiGenerationUsage({
    promptTokenCount: 10,
    cachedContentTokenCount: 0,
    candidatesTokenCount: 1_025,
    thoughtsTokenCount: 0,
    totalTokenCount: 1_035,
  }, contract);
  assert.equal(normalized.billableUsage.status, 'unknown');
  assert.equal(normalized.billableCost.amountUsd, null);
  assert.ok(normalized.usageNormalization.missingOrInvalidFields
    .includes('billableOutputTokensExceedContract'));
});

test('optional omitted cache usage settles conservatively for a no-cache request contract', () => {
  const contract = loadEvidenceGenerationContract('planning');
  const normalized = normalizeGeminiGenerationUsage({
    promptTokenCount: 100,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 10,
    totalTokenCount: 130,
  }, contract);
  assert.equal(normalized.billableUsage.status, 'known');
  assert.equal(normalized.billableUsage.cachedInputTokens, 0);
  assert.equal(normalized.usageNormalization.cachedInputRule,
    'omitted_optional_cache_count_treated_as_zero_upper_bound');
  assert.equal(normalized.billableCost.amountUsd,
    (100 * contract.pricingContract.inputUsdPerMillion
      + 30 * contract.pricingContract.outputUsdPerMillion) / 1_000_000);
  assert.equal(normalized.billableCost.basis, 'all_input_priced_uncached_conservative_upper_bound');
});

test('an explicit invalid cache count remains unknown', () => {
  const contract = loadEvidenceGenerationContract('planning');
  const normalized = normalizeGeminiGenerationUsage({
    promptTokenCount: 100,
    cachedContentTokenCount: -1,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 10,
    totalTokenCount: 130,
  }, contract);
  assert.equal(normalized.billableUsage.status, 'unknown');
  assert.equal(normalized.billableCost.amountUsd, null);
  assert.ok(normalized.usageNormalization.missingOrInvalidFields.includes('cachedContentTokenCount'));
});

test('returned-model mismatch is a hard binding failure with reservation retained', async () => {
  const contract = loadEvidenceGenerationContract('planning');
  const body = bodyFor(contract);
  const measurement = await buildGeminiInputMeasurement({
    body,
    contract,
    countTokens: async () => ({ totalTokens: 100 }),
  });
  const { budget, commands } = fixtureBudget();
  await assert.rejects(
    () => budget.gemini({
      operation: 'generate_content',
      model: contract.modelId,
      body,
      measurement,
      generationContract: contract,
      invoke: async () => ({
        modelVersion: 'gemini-other-model',
        usageMetadata: { promptTokenCount: 100, totalTokenCount: 101 },
      }),
    }),
    /cloud_budget_gemini_returned_model_mismatch/,
  );
  assert.equal(commands.length, 1);
  assert.equal(budget.snapshot().calls[0].status, 'reserved');
  assert.equal(
    budget.snapshot().calls[0].uncertainty,
    'provider_model_binding_mismatch_reservation_retained',
  );
});

test('remaining preparation USD reads the cumulative run ledger while atomic reserve stays authoritative', async () => {
  const budget = createCloudRequestBudget({
    env: {
      CLOUD_BUDGET_RUN_ID: 'remaining-generation-budget-test',
      CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '10',
      CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '6',
    },
    command: async (command) => command[0] === 'HGETALL'
      ? [
        'actualNano', '0',
        'theoreticalNano', '4343913598',
        'settled-fixture', JSON.stringify({
          provider: 'gemini',
          status: 'usage_settled',
          actualNano: 0,
          theoreticalNano: 4_343_913_598,
        }),
      ]
      : ['reserved'],
  });
  const result = await runCloudBudgetedQuestion({
    env: { RAG_MODEL_PROVIDER: 'deepseek' },
    budget,
  }, async () => ({ remaining: await currentCloudPreparationRemainingUsd() }));
  assert.ok(Math.abs(result.remaining - 1.656086402) < 1e-12);
  assert.equal(await currentCloudPreparationRemainingUsd(), Number.POSITIVE_INFINITY);
});
