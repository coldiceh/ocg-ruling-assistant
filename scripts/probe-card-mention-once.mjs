import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  buildCardNameExtractionPrompt, callCardNameExtractionModel,
  createPublicAnswerModelEnv, modelNameForCardExtractionProvider,
  resolveCardExtractionProvider,
} from '../backend/ragModelClient.mjs';
import { extractRagCards } from '../backend/ragCardExtractor.mjs';
import { getCloudEvidenceBudgetStatus, runCloudBudgetedQuestion } from '../backend/cloudRequestBudget.mjs';

const question = '场上有 完美电子多元驱动蛇·神龙 ，四花缭乱之灵使加多少攻击力？';
const outputDir = 'card-mention-diagnostic';
const save = (name, value) => writeFile(`${outputDir}/${name}.json`, JSON.stringify(value, null, 2));
const hash = text => createHash('sha256').update(text).digest('hex');
await mkdir(outputDir, { recursive: true });
const summary = { question, status: 'started', providerPostCalls: 0, blockedProviderPostCalls: 0,
  ruleCalls: 0, finalCalls: 0, runId: 'selection-failure-fix-20261002' };
let env;
let guardedFetch;
try {
  const config = JSON.parse(await readFile('vercel.json', 'utf8'));
  const sourceEnv = { ...process.env, ...config.env, BAI_CARD_ENABLED: 'true',
    CLOUD_BUDGET_RUN_ID: summary.runId, CLOUD_BUDGET_PERIOD: 'run',
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '3.5', CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '0.50' };
  for (const name of ['BAI_API_KEY', 'UPSTASH_BUDGET_KV_REST_API_URL', 'UPSTASH_BUDGET_KV_REST_API_TOKEN']) {
    assert.ok(String(sourceEnv[name] || '').trim(), `missing_required_${name}`);
  }
  env = createPublicAnswerModelEnv(sourceEnv, 'bai-astra-low');
  assert.equal(env.RAG_EVIDENCE_PIPELINE, 'cloud_evidence_v1');
  const provider = resolveCardExtractionProvider(env).provider;
  assert.equal(provider, 'bai', 'production_card_provider_must_be_bai');
  assert.equal(modelNameForCardExtractionProvider(provider, env), 'gpt-6-luna');
  const expectedPrompt = buildCardNameExtractionPrompt(question, { typed: true });
  const redisUrl = new URL(env.UPSTASH_BUDGET_KV_REST_API_URL).href;
  const nativeFetch = globalThis.fetch;
  guardedFetch = async (url, options = {}) => {
    const address = new URL(String(url));
    if (address.href === redisUrl) return nativeFetch(url, { ...options, redirect: 'error' });
    assert.equal(address.origin, 'https://api.b.ai', 'unexpected_network_origin');
    assert.equal(address.pathname, '/v1/responses', 'only_card_responses_endpoint_allowed');
    assert.equal(String(options.method).toUpperCase(), 'POST');
    const request = JSON.parse(String(options.body || ''));
    assert.equal(request.model, 'gpt-6-luna');
    assert.equal(request.reasoning?.effort, 'none');
    assert.equal(request.input, expectedPrompt, 'only_the_original_card_extraction_prompt_allowed');
    if (summary.providerPostCalls !== 0) {
      summary.blockedProviderPostCalls++;
      throw new Error('second_provider_post_forbidden');
    }
    await save('request', { endpoint: address.origin + address.pathname, body: request });
    summary.providerPostCalls++;
    const response = await nativeFetch(url, { ...options, redirect: 'error' });
    await save('response', { status: response.status, body: await response.clone().text() });
    return response;
  };
  const cardsBytes = await readFile('data/cards.json');
  const cards = JSON.parse(cardsBytes.toString('utf8')).records;
  assert.ok(Array.isArray(cards));
  const manifest = JSON.parse(await readFile('data/rag-data-revision-manifest.json', 'utf8'));
  summary.configuration = { provider, model: 'gpt-6-luna', reasoningEffort: 'none',
    profile: env.PUBLIC_RULING_MODEL_PROFILE, dataRevision: manifest.revision,
    cardsSha256: hash(cardsBytes), promptSha256: hash(expectedPrompt),
    budgetPeriod: env.CLOUD_BUDGET_PERIOD, theoreticalCapUsd: 0.50, actualCapCny: 3.5 };
  summary.budgetBefore = await getCloudEvidenceBudgetStatus({ env, fetchImpl: guardedFetch });
  assert.ok(summary.budgetBefore.legacyCloudAccountedUsd > 0, 'existing_budget_scope_required_no_fresh_budget');
  const startedAt = performance.now();
  const extraction = await runCloudBudgetedQuestion({ env, fetchImpl: guardedFetch }, () =>
    callCardNameExtractionModel({ userQuery: question, dataRevision: manifest.revision, env,
      fetchImpl: guardedFetch, signal: AbortSignal.timeout(90000) }));
  summary.elapsedMs = performance.now() - startedAt;
  const local = extractRagCards(question, { cards });
  const resolved = extraction.typedMentionSetProvided === true
    ? extractRagCards(question, { cards, modelCardNameCandidates: extraction.candidates || [], mentionSetSource: 'typed_model' })
    : (extraction.candidates || []).length
      ? extractRagCards(question, { cards, modelCardNameCandidates: extraction.candidates })
      : local;
  await save('extraction', extraction);
  await save('resolution', { local, resolved });
  summary.cloudCosts = extraction.debug?.cloudCosts;
  summary.result = { provider: extraction.providerUsed, model: extraction.modelUsed,
    dryRun: extraction.dryRun, typedMentionSetProvided: extraction.typedMentionSetProvided,
    candidates: extraction.candidates, groupMentions: extraction.groupMentions,
    invalidTypedMentions: extraction.invalidTypedMentions, warnings: extraction.warnings,
    tokenUsage: extraction.tokenUsage, resolvedCardIds: resolved.resolvedCards.map(card => card.id) };
  assert.equal(summary.providerPostCalls, 1, 'expected_exactly_one_provider_post');
  assert.equal(extraction.providerUsed, 'bai');
  assert.equal(extraction.dryRun, false);
  assert.ok(extraction.rawText, 'no_card_extraction_response_text');
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
  console.log(JSON.stringify({ status: summary.status, providerPostCalls: summary.providerPostCalls,
    blockedProviderPostCalls: summary.blockedProviderPostCalls, ruleCalls: 0, finalCalls: 0,
    resolvedCardIds: summary.result?.resolvedCardIds }));
}
