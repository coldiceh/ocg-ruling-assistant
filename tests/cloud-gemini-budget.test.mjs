import test from 'node:test';
import assert from 'node:assert/strict';

import { createCloudRequestBudget } from '../backend/cloudRequestBudget.mjs';

function fixtureBudget() {
  const commands = [];
  const budget = createCloudRequestBudget({
    env: {
      CLOUD_BUDGET_RUN_ID: 'gemini-test',
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

test('Gemini cached generation settles normal, cached, candidate and thought tokens', async () => {
  const { budget, commands } = fixtureBudget();
  const response = {
    modelVersion: 'gemini-2.5-flash',
    usageMetadata: {
      promptTokenCount: 1100,
      cachedContentTokenCount: 1000,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 30,
      totalTokenCount: 1150,
    },
  };
  assert.equal(await budget.gemini({
    operation: 'generate_content',
    model: 'gemini-2.5-flash',
    body: { contents: [], generationConfig: { maxOutputTokens: 100 } },
    cachedTokenCount: 1000,
    invoke: async () => response,
  }), response);

  const snapshot = budget.snapshot();
  assert.equal(commands.length, 2);
  assert.equal(snapshot.calls[0].status, 'usage_settled');
  assert.equal(snapshot.calls[0].provider, 'gemini');
  assert.equal(snapshot.calls[0].operation, 'generate_content');
  assert.equal(snapshot.calls[0].theoreticalUsd, 0.0003375);
  assert.equal(snapshot.reservedTheoreticalUsd, 0);
});

test('Gemini cache creation accounts fixed TTL storage and labels input as a provision', async () => {
  const { budget } = fixtureBudget();
  await budget.gemini({
    operation: 'cached_contents_create',
    model: 'gemini-2.5-flash',
    body: { model: 'models/gemini-2.5-flash', contents: [{ parts: [{ text: 'rules' }] }] },
    cacheTtlSeconds: 180,
    contentTokenEstimate: 2500,
    invoke: async () => ({
      name: 'cachedContents/rules',
      usageMetadata: { totalTokenCount: 2000 },
    }),
  });

  const snapshot = budget.snapshot();
  assert.equal(snapshot.calls[0].pricingBasis, 'google_list_theoretical_cache_create_input_provision_unknown');
  assert.equal(snapshot.calls[0].theoreticalUsd, 0.00155);
  assert.equal(snapshot.actualCostKnown, false);
});

test('Gemini response without usage retains the conservative reservation', async () => {
  const { budget, commands } = fixtureBudget();
  await budget.gemini({
    operation: 'generate_content',
    model: 'gemini-2.5-flash',
    body: { contents: [], generationConfig: { maxOutputTokens: 100 } },
    cachedTokenCount: 1000,
    invoke: async () => ({ candidates: [] }),
  });

  const snapshot = budget.snapshot();
  assert.equal(commands.length, 1);
  assert.equal(snapshot.calls[0].status, 'reserved');
  assert.equal(snapshot.calls[0].uncertainty, 'provider_usage_missing_or_settlement_uncertain_reservation_retained');
  assert.ok(snapshot.reservedTheoreticalUsd > 0);
});
