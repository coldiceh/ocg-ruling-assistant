import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { answerRagRulingQuestion } from '../backend/ragRulingPipeline.mjs';
import {
  createPublicAnswerModelEnv, modelNameForCardExtractionProvider,
  parseCardNameExtractionOutput, resolveCardExtractionProvider,
} from '../backend/ragModelClient.mjs';
import { getCloudEvidenceBudgetStatus } from '../backend/cloudRequestBudget.mjs';

const question = '场上有 完美电子多元驱动蛇·神龙 ，四花缭乱之灵使加多少攻击力？';
const outputDir = 'card-mention-verification';
const save = (name, value) => writeFile(`${outputDir}/${name}.json`, JSON.stringify(value, null, 2));
const hash = value => createHash('sha256').update(value).digest('hex');
await mkdir(outputDir, { recursive: true });
const summary = { question, status: 'started', scope: 'card_name_extraction_and_local_identity_only',
  providerPostCalls: 0, blockedProviderPostCalls: 0, ruleCalls: 0, finalCalls: 0,
  evidenceBoundaryVisits: 0, blockedExternalRequests: 0, runId: 'selection-failure-fix-20261002' };
let env;
let guardedFetch;
let observedResolution;
let parsedProviderOutput;
try {
  const config = JSON.parse(await readFile('vercel.json', 'utf8'));
  const sourceEnv = { ...process.env, ...config.env, BAI_CARD_ENABLED: 'true',
    CLOUD_BUDGET_RUN_ID: summary.runId, CLOUD_BUDGET_PERIOD: 'run',
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '3.5', CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '0.50' };
  for (const name of ['BAI_API_KEY', 'UPSTASH_BUDGET_KV_REST_API_URL', 'UPSTASH_BUDGET_KV_REST_API_TOKEN']) {
    assert.ok(String(sourceEnv[name] || '').trim(), `missing_required_${name}`);
  }
  env = createPublicAnswerModelEnv(sourceEnv, 'bai-astra-low');
  // This diagnostic ends at local identity; it intentionally does not hydrate external card metadata.
  env.RAG_LIVE_OFFICIAL_QA = 'false';
  assert.equal(env.RAG_EVIDENCE_PIPELINE, 'cloud_evidence_v1');
  assert.equal(env.GEMINI_RULE_QA_ENABLED, 'true');
  const provider = resolveCardExtractionProvider(env).provider;
  assert.equal(provider, 'bai', 'production_card_provider_must_be_bai');
  assert.equal(modelNameForCardExtractionProvider(provider, env), 'gpt-6-luna');
  const redisUrl = new URL(env.UPSTASH_BUDGET_KV_REST_API_URL).href;
  const nativeFetch = globalThis.fetch;
  guardedFetch = async (url, options = {}) => {
    const address = new URL(String(url));
    if (address.href === redisUrl) return nativeFetch(url, { ...options, redirect: 'error' });
    if (address.origin !== 'https://api.b.ai' || address.pathname !== '/v1/responses') {
      summary.blockedExternalRequests++;
      throw new Error('external_lookup_or_other_provider_forbidden');
    }
    assert.equal(String(options.method).toUpperCase(), 'POST');
    const request = JSON.parse(String(options.body || ''));
    assert.equal(request.model, 'gpt-6-luna');
    assert.equal(request.reasoning?.effort, 'none');
    assert.equal(request.text?.format?.type, 'json_object');
    assert.equal(typeof request.input, 'string');
    assert.ok(request.input.endsWith(`玩家问题：\n${question}`), 'original_question_must_remain_at_prompt_end');
    if (summary.providerPostCalls !== 0) {
      summary.blockedProviderPostCalls++;
      throw new Error('second_provider_post_forbidden');
    }
    // Preserve the actual pipeline-built input; do not independently rebuild its reference projection.
    await save('request', { endpoint: address.origin + address.pathname, body: request });
    summary.promptSha256 = hash(request.input);
    summary.providerPostCalls++;
    const response = await nativeFetch(url, { ...options, redirect: 'error' });
    const responseText = await response.clone().text();
    await save('response', { status: response.status, body: responseText });
    try {
      const payload = JSON.parse(responseText);
      const rawText = (Array.isArray(payload.output) ? payload.output : [])
        .filter(item => item?.type === 'message')
        .flatMap(item => Array.isArray(item.content) ? item.content : [])
        .filter(part => part?.type === 'output_text').map(part => String(part.text || '')).join('');
      parsedProviderOutput = { rawText, ...parseCardNameExtractionOutput(rawText),
        responseStatus: payload.status, responseId: payload.id, model: payload.model, usage: payload.usage };
      await save('extraction', parsedProviderOutput);
    } catch { summary.rawResponseParsingUnavailable = true; }
    return response;
  };
  const cardsBytes = await readFile('data/cards.json');
  const cards = JSON.parse(cardsBytes.toString('utf8')).records;
  assert.ok(Array.isArray(cards));
  const manifest = JSON.parse(await readFile('data/rag-data-revision-manifest.json', 'utf8'));
  summary.configuration = { provider, model: 'gpt-6-luna', reasoningEffort: 'none',
    profile: env.PUBLIC_RULING_MODEL_PROFILE, repositoryDataRevision: manifest.revision,
    cardsSha256: hash(cardsBytes), budgetPeriod: env.CLOUD_BUDGET_PERIOD,
    theoreticalCapUsd: 0.50, actualCapCny: 3.5,
    scopeOverrides: { records: [], qaRecords: [], RAG_LIVE_OFFICIAL_QA: 'false',
      officialQaExactAlreadyChecked: true, evidenceProvider: 'capture_identity_then_return_empty_packing' } };
  summary.budgetBefore = await getCloudEvidenceBudgetStatus({ env, fetchImpl: guardedFetch });
  assert.ok(summary.budgetBefore.legacyCloudAccountedUsd > 0, 'existing_budget_scope_required_no_fresh_budget');
  const startedAt = performance.now();
  const result = await answerRagRulingQuestion({
    question, cards, records: [], qaRecords: [], prepareForContinuation: true,
    officialQaExactAlreadyChecked: true, env, fetchImpl: guardedFetch,
    signal: AbortSignal.timeout(90000),
    ruleModelInvoker: async () => { summary.ruleCalls++; throw new Error('rule_call_forbidden'); },
    modelInvoker: async () => { summary.finalCalls++; throw new Error('final_call_forbidden'); },
    geminiEvidenceProvider: { async retrieve({ cardResolution, retrievedEvidence, dataRevision }) {
      summary.evidenceBoundaryVisits++;
      observedResolution = cardResolution;
      await save('pipeline-card-resolution', { cardResolution, dataRevision,
        retrievalWarnings: retrievedEvidence.retrievalWarnings, retrievalDebug: retrievedEvidence.debug });
      const prompt = 'Diagnostic stops after card-name extraction and local identity; no evidence selection or final answer.';
      return { evidence: { cardTexts: [], cardResolution },
        packing: { prompt, promptChars: prompt.length, modelEvidence: {}, allowedEvidenceIds: [], warnings: [] },
        telemetry: {} };
    } },
  });
  summary.elapsedMs = performance.now() - startedAt;
  summary.cloudCosts = result.debug?.cloudCosts;
  summary.pipeline = { status: result.status, dataRevision: result.continuation?.dataRevision,
    cardNameModel: result.continuation?.cardNameModel, timingsMs: result.continuation?.timingsMs,
    cardResolution: result.continuation?.cardResolution };
  summary.result = { resolvedCardIds: observedResolution?.resolvedCards?.map(card => card.id),
    candidates: parsedProviderOutput?.candidates, groupMentions: parsedProviderOutput?.groupMentions };
  assert.equal(summary.providerPostCalls, 1, 'expected_exactly_one_provider_post');
  assert.equal(summary.evidenceBoundaryVisits, 1);
  assert.equal(summary.blockedExternalRequests, 0, 'local_identity_needed_an_external_lookup');
  assert.equal(result.status, 'evidence_prepared');
  assert.equal(result.continuation.cardNameModel.providerUsed, 'bai');
  assert.equal(result.continuation.cardNameModel.dryRun, false);
  assert.ok(parsedProviderOutput?.rawText, 'no_card_extraction_response_text');
  summary.status = 'completed';
} catch (error) {
  summary.status = 'failed';
  let message = String(error.code || error.message || error.name);
  for (const name of ['BAI_API_KEY', 'BAI_CARD_API_KEY', 'UPSTASH_BUDGET_KV_REST_API_TOKEN']) {
    const secret = String(env?.[name] || process.env[name] || '');
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  summary.error = message;
  if (error.cloudCosts) summary.cloudCosts = error.cloudCosts;
  process.exitCode = 1;
} finally {
  if (env && guardedFetch) {
    try { summary.budgetAfter = await getCloudEvidenceBudgetStatus({ env, fetchImpl: guardedFetch }); }
    catch { summary.budgetAfterUnavailable = true; }
  }
  await save('summary', summary);
  console.log(JSON.stringify({ status: summary.status, scope: summary.scope,
    providerPostCalls: summary.providerPostCalls, ruleCalls: summary.ruleCalls, finalCalls: summary.finalCalls,
    resolvedCardIds: summary.result?.resolvedCardIds }));
}
