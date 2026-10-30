// EVIDENCE_PLANNING_PROFILE pointed at a GPT-6 Luna profile: the plan call uses
// the official Responses channel (RAG_EVIDENCE_LUNA_CHANNEL=official) and the
// official daily ledger, while query vectors still come from Gemini embeddings
// and the plan output is normalized exactly as the Gemini plan. Offline: every
// request is answered by the fetchImpl below.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGeminiBoundedEvidenceProvider } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { loadEvidenceGenerationContract } from '../backend/evidenceGenerationContract.mjs';
import { CLOUD_BUDGET_RESERVE, CLOUD_BUDGET_SETTLE, gpt6LunaUsageCostUsd } from '../backend/cloudRequestBudget.mjs';
import { fixtureEnv, fixturePlan, fixtureRetrieveInput, ruleTocAssets } from './helpers/rule-toc-fixture.mjs';

const LUNA_MEDIUM = 'bai-gpt-6-luna-medium-theoretical';
const LUNA_LOW = 'bai-gpt-6-luna-low-theoretical';
const lunaEnv = { ...fixtureEnv, EVIDENCE_PLANNING_PROFILE: LUNA_MEDIUM };
const PLAN_USAGE = Object.freeze({ input_tokens: 2400, output_tokens: 900, total_tokens: 3300,
  input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 600 } });

const responsesPayload = (text, usage) => Response.json({ id: 'fixture', model: 'gpt-6-luna-2026-10-01',
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage });

// plan(body, attempt): the plan output object, raw text, or a Response.
function planningProvider({ plan = () => fixturePlan, budgetStore } = {}) {
  const assets = ruleTocAssets();
  const calls = [];
  let planAttempts = 0;
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => assets,
    loadDenseSearch: async ({ rules }) => ({ searchAsync: async () => [...rules.units.values()] }),
    loadQaSearch: async ({ items }) => ({ searchAsync: async () => items }),
    remainingBudget: async () => Infinity,
    ...(budgetStore ? {} : { budgetedRequest: request => request.invoke() }),
    fetchImpl: async (url, init) => {
      const href = String(url);
      const body = JSON.parse(init.body);
      if (budgetStore && href === budgetStore.url) return budgetStore.respond(body);
      if (href.endsWith(':embedContent') || href.endsWith(':batchEmbedContents')) {
        calls.push({ kind: 'embedding', url: href });
        return href.endsWith(':embedContent')
          ? Response.json({ embedding: { values: Array(768).fill(1) }, usageMetadata: { promptTokenCount: 10 } })
          : Response.json({ embeddings: body.requests.map(() => ({ values: Array(768).fill(1) })),
            usageMetadata: { promptTokenCount: 10 } });
      }
      if (href.endsWith(':generateContent')) {
        calls.push({ kind: 'gemini_plan', url: href, body });
        const output = plan(body, ++planAttempts);
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 600 } });
      }
      if (!href.startsWith('https://api.openai.com/')) throw new Error(`unexpected request ${href}`);
      const firstUser = body.input.find(message => message.role === 'user').content;
      const delivered = JSON.parse(firstUser.split('\n').at(-1));
      if (Array.isArray(delivered.groups)) {
        calls.push({ kind: 'selection', url: href, body });
        return responsesPayload(JSON.stringify({ selectedIds: delivered.groups.flatMap(group => [
          ...(group.units || []).map(row => row[0]), ...(group.items || []).map(item => item.handle)]).slice(0, 2),
        note: '' }), { input_tokens: 4000, output_tokens: 300, total_tokens: 4300, input_tokens_details: { cached_tokens: 0 } });
      }
      calls.push({ kind: 'plan', url: href, body, headers: init.headers });
      const output = plan(body, ++planAttempts);
      if (output instanceof Response) return output;
      return responsesPayload(typeof output === 'string' ? output : JSON.stringify(output), PLAN_USAGE);
    },
  });
  return { provider, calls, assets };
}

async function run(env, options) {
  const fixture = planningProvider(options);
  const result = await fixture.provider.retrieve(fixtureRetrieveInput(fixture.assets, env));
  return { ...fixture, result, bounded: result.telemetry.bounded };
}

test('the Luna medium and low profiles load as planning contracts', () => {
  for (const [profile, effort] of [[LUNA_MEDIUM, 'medium'], [LUNA_LOW, 'low']]) {
    const contract = loadEvidenceGenerationContract('planning', { env: { EVIDENCE_PLANNING_PROFILE: profile,
      EVIDENCE_GENERATION_OUTPUT_LIMIT: 'provider' } });
    assert.equal(contract.providerId, 'bai');
    assert.equal(contract.modelId, 'gpt-6-luna');
    assert.deepEqual(contract.reasoningConfig.responses, { effort });
    assert.deepEqual(contract.responseFormatConfig.responses, { type: 'json_object' });
    assert.equal(contract.outputLimitConfig.omitFromRequest, true);
    assert.equal(contract.measurementContract.status, 'user_authorized_theoretical');
  }
});

test('Luna planning uses the official Responses channel with the same prompt; embeddings stay on Gemini', async () => {
  const gemini = await run(fixtureEnv);
  const luna = await run(lunaEnv);
  assert.deepEqual(gemini.calls.filter(call => call.kind !== 'embedding').map(call => call.kind), ['gemini_plan', 'selection']);
  assert.deepEqual(luna.calls.filter(call => call.kind !== 'embedding').map(call => call.kind), ['plan', 'selection']);
  assert.ok(!luna.calls.some(call => /generativelanguage.*:(?:countTokens|generateContent)$/u.test(call.url)));
  assert.deepEqual(luna.calls.filter(call => call.kind === 'embedding').map(call => call.url.split(':').at(-1)),
    ['embedContent', 'batchEmbedContents'], 'original and planned query vectors still come from Gemini');

  const plan = luna.calls.find(call => call.kind === 'plan');
  assert.equal(plan.url, 'https://api.openai.com/v1/responses');
  assert.equal(plan.headers.authorization, 'Bearer fixture-official');
  assert.equal(plan.body.model, 'gpt-6-luna');
  assert.deepEqual(plan.body.reasoning, { effort: 'medium' });
  assert.deepEqual(plan.body.text, { format: { type: 'json_object' } });
  assert.equal(Object.hasOwn(plan.body, 'max_output_tokens'), false, 'provider output limit, as for the selection');
  assert.equal(Object.hasOwn(plan.body, 'generationConfig'), false);
  assert.ok(plan.body.prompt_cache_options, 'official request does not write the paid prompt cache');
  assert.deepEqual(plan.body.input[0], { role: 'system', content: 'Return the response as JSON.' });
  // The user message is the Gemini plan request's text, unchanged.
  const geminiPlan = gemini.calls.find(call => call.kind === 'gemini_plan');
  assert.equal(plan.body.input[1].content, geminiPlan.body.contents[0].parts.map(part => part.text).join('\n\n'));

  // Same model output → same normalized plan, and the selection reads the same queryPlan.
  assert.deepEqual(luna.result.telemetry.queryPlan, gemini.result.telemetry.queryPlan);
  const selectionPlan = fixture => JSON.parse(fixture.calls.find(call => call.kind === 'selection').body.input
    .find(message => message.role === 'user').content.split('\n').at(-1)).queryPlan;
  assert.deepEqual(selectionPlan(luna), selectionPlan(gemini));

  assert.deepEqual(luna.result.telemetry.stageTelemetry.planning, { provider: 'bai', model: 'gpt-6-luna',
    reasoningEffort: 'medium', channel: 'official', endpointProvider: 'openai' });
  assert.deepEqual(gemini.result.telemetry.stageTelemetry.planning, { provider: 'gemini', model: 'gemini-3.8-flash',
    reasoningEffort: 'medium' });
  const row = luna.bounded.calls.find(call => call.stage === 'plan');
  assert.equal(row.channel, 'official');
  assert.equal(row.status, 'success');
  assert.equal(row.model, 'gpt-6-luna');
  assert.equal(luna.bounded.tokenCounts.find(count => count.stage === 'plan').basis, 'user_authorized_theoretical');
});

test('the Luna plan call is reserved and settled in the official daily ledger', async () => {
  const commands = [];
  const budgetStore = { url: 'https://budget.example.invalid', respond: command => {
    commands.push(command);
    const reserve = command[1] === CLOUD_BUDGET_RESERVE;
    return Response.json({ result: reserve ? ['reserved', '0', '1'] : ['settled', '0', '1'] });
  } };
  const env = { ...lunaEnv, PUBLIC_OPENAI_BUDGET_RUN_ID: 'public-official',
    UPSTASH_BUDGET_KV_REST_API_URL: budgetStore.url, UPSTASH_BUDGET_KV_REST_API_TOKEN: 'budget-token' };
  const { calls } = await run(env, { budgetStore });
  assert.deepEqual(calls.filter(call => call.kind !== 'embedding').map(call => call.kind), ['plan', 'selection']);
  assert.deepEqual(commands.map(command => command[1] === CLOUD_BUDGET_RESERVE ? 'reserve'
    : command[1] === CLOUD_BUDGET_SETTLE ? 'settle' : 'other'), ['reserve', 'settle', 'reserve', 'settle']);
  assert.ok(commands.every(command => /^ruling-cloud-budget:v1:public-official:\d{4}-\d{2}-\d{2}$/u.test(command[3])));
  const ticket = commands[0].map(value => { try { return JSON.parse(value); } catch { return null; } })
    .find(value => value && typeof value === 'object' && value.provider);
  assert.equal(ticket.provider, 'openai');
  assert.equal(ticket.model, 'gpt-6-luna');
  assert.equal(ticket.operation, 'generate_content');
  // Settled from the reported usage at the official GPT-6 Luna list prices.
  assert.equal(Number(commands[1][6]), Math.ceil(gpt6LunaUsageCostUsd(PLAN_USAGE) * 1e9));
});

test('a malformed Luna plan gets the same single format retry and the same normalization', async () => {
  const { calls, bounded, result } = await run(lunaEnv, { plan: (_body, attempt) => attempt === 1
    ? 'not json' : { needs: [{ id: 'x', question: 'q', ruleQuery: 'r', qaQuery: 'a' }] } });
  const plans = calls.filter(call => call.kind === 'plan');
  assert.equal(plans.length, 2);
  assert.match(plans[1].body.input.at(-1).content, /只返回JSON对象，包含needs数组/u);
  assert.deepEqual(bounded.calls.filter(call => call.stage === 'plan').map(call => [call.status, call.retry]),
    [['failed', false], ['success', true]]);
  assert.deepEqual(result.telemetry.queryPlan, { needs: [{ id: 'n1', sourceId: 'x', question: 'q',
    ruleQuery: 'r', qaQuery: 'a' }] });
});
