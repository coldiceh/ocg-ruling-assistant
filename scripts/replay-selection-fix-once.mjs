import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createGeminiBoundedEvidenceProvider } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { runCloudBudgetedQuestion, runCloudBaiRequest } from '../backend/cloudRequestBudget.mjs';
import { createPublicAnswerModelEnv } from '../backend/ragModelClient.mjs';
import { finalizePreparedRagRulingQuestion } from '../backend/ragRulingPipeline.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
Object.assign(process.env, JSON.parse(await readFile('vercel.json', 'utf8')).env,
  { CLOUD_BUDGET_RUN_ID: 'selection-failure-fix-20261002',
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '3.5', CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '0.50' });
const env = createPublicAnswerModelEnv(process.env, 'bai-astra-low');
const frozen = JSON.parse(await readFile('frozen-input/frozen.json', 'utf8'));
const baseline = JSON.parse(await readFile('frozen-input/prepared.json', 'utf8'));
const continuation = structuredClone(baseline.answer.continuation);
const oldRequest = frozen.events.find(event => event.type === 'request' && event.stage === 'selection');
const inputJson = body => body.input.find(message => message.role === 'user').content.split('\n').at(-1);
const sourceInput = inputJson(oldRequest.body);
const plannedInput = JSON.parse(frozen.events.find(event => event.type === 'request' && event.stage === 'plan').body.contents[0].parts[1].text);
for (const [index, card] of continuation.cardResolution.resolvedCards.entries()) {
  assert.equal(String(card.id || card.cardId), String(plannedInput.confirmedCards[index].id));
  card.aliases = plannedInput.confirmedCards[index].aliases;
}
const question = JSON.parse(sourceInput).question;
const cache = new Map(frozen.cachedResponses.map(response => [response.key, response]));
const nativeFetch = globalThis.fetch;
const events = [], summary = { reusedUpstreamResponses: 0, newSelectionCalls: 0, newFinalCalls: 0 };
const replayFetch = async (url, options = {}) => {
  const address = new URL(String(url));
  const body = String(options.body || '');
  if (address.hostname === 'generativelanguage.googleapis.com') {
    const key = hash(address.origin + address.pathname + '\n' + body);
    const response = cache.get(key);
    if (!response) throw new Error('frozen_upstream_request_miss');
    summary.reusedUpstreamResponses++;
    return new Response(response.text, { status: response.status, headers: { 'content-type': 'application/json' } });
  }
  if (address.hostname === 'api.b.ai') {
    const request = JSON.parse(body);
    assert.equal(request.model, 'gpt-6-luna');
    const actual = JSON.parse(inputJson(request)), expected = JSON.parse(sourceInput);
    const withoutRequestSize = value => ({ ...value, unread: value.unread.map(({ size, ...entry }) => entry) });
    assert.deepEqual(withoutRequestSize(actual), withoutRequestSize(expected), 'question, card text, offered IDs, source bodies and their order remain identical');
    summary.unreadRequestSizeDeltas = actual.unread.map((entry, index) => entry.size - expected.unread[index].size);
    assert.equal(++summary.newSelectionCalls, 1, 'this diagnostic does not issue a second selection');
  }
  return nativeFetch(url, options);
};
await mkdir('selection-replay', { recursive: true });
try {
  const provider = createGeminiBoundedEvidenceProvider({ fetchImpl: replayFetch,
    budgetedRequest: request => request.generationContract?.providerId === 'bai'
      ? runCloudBaiRequest(request) : request.invoke(),
    onEvent: event => { events.push(event); },
  });
  const selected = await runCloudBudgetedQuestion({ env }, () => provider.retrieve({
    userQuery: question, answerLocale: 'zh-CN', cardResolution: continuation.cardResolution,
    retrievedEvidence: { cardTexts: plannedInput.cardTexts, userProvidedCardTexts: plannedInput.userProvidedCardTexts }, dataRevision: continuation.dataRevision, env,
    signal: AbortSignal.timeout(180000),
  }));
  summary.selection = { entries: selected.packing.selectedEntryChars.length,
    promptChars: selected.packing.promptChars, candidateInputSha256: hash(sourceInput),
    newCosts: selected.debug.cloudCosts };
  continuation.promptBundle = selected.packing;
  continuation.evidence = selected.evidence;
  continuation.ruleQueryModel = selected.telemetry;
  continuation.finalPromptSha256 = hash(selected.packing.prompt);
  continuation.evidenceFingerprint = hash(JSON.stringify(selected.evidence));
  await writeFile('selection-replay/prepared.json', JSON.stringify(continuation, null, 2));
  const finalFetch = async (url, options = {}) => {
    const address = new URL(String(url));
    if (address.hostname === 'api.b.ai' && String(options.body || '').includes('gpt-6-astra')) {
      assert.equal(++summary.newFinalCalls, 1);
    }
    return nativeFetch(url, options);
  };
  const answer = await finalizePreparedRagRulingQuestion({ continuation, env,
    fetchImpl: finalFetch, signal: AbortSignal.timeout(240000) });
  summary.answer = { shortAnswer: answer.shortAnswer, riskFlags: answer.riskFlags,
    model: answer.debug?.modelUsed, newCosts: answer.debug?.cloudCosts };
  await writeFile('selection-replay/answer.json', JSON.stringify(answer, null, 2));
  summary.status = 'completed';
} catch (error) {
  summary.status = 'failed'; summary.error = error.code || error.message;
  summary.boundedRetrieval = error.boundedRetrieval;
  summary.cloudCosts = error.cloudCosts;
}
await writeFile('selection-replay/events.json', JSON.stringify(events, null, 2));
await writeFile('selection-replay/summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ status: summary.status, error: summary.error,
  reusedUpstreamResponses: summary.reusedUpstreamResponses,
  newSelectionCalls: summary.newSelectionCalls, newFinalCalls: summary.newFinalCalls }));
