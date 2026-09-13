import { fileURLToPath } from 'node:url';
import { loadGeminiRuleQaAssets } from './geminiRuleQaAssets.mjs';
import { buildRuleContext } from './geminiRuleContext.mjs';
import { createGeminiRuleCacheClient } from './geminiRuleCacheClient.mjs';
import { resolveGeminiSelection, packGeminiSelection } from './geminiRuleQaPacking.mjs';

const ruleContexts = new WeakMap();
const FINAL_SUBMISSION_INSTRUCTION = '补查结束，现在用已读资料submit_evidence，提交 ruleUnitIds 和 qaHandles；不得编造缺失依据。';
function normalizeCalls(content) {
  const calls = (content?.parts || []).flatMap(part => part.functionCall ? [part.functionCall] : []);
  if (calls.length) return calls;
  const raw = (content?.parts || []).filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('\n');
  try {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (value && Object.hasOwn(value, 'ruleUnitIds') && Object.hasOwn(value, 'qaHandles')) return [{ name: 'submit_evidence', args: value }];
  } catch { /* One simple output-contract reminder is allowed below. */ }
  return [];
}

export function createGeminiRuleQaEvidenceProvider({ fetchImpl = globalThis.fetch,
  loadAssets = loadGeminiRuleQaAssets, clientFactory = createGeminiRuleCacheClient,
  onEvent = async () => {} } = {}) {
  return { async retrieve({ userQuery, cardResolution, retrievedEvidence, dataRevision, env = {}, signal, assetsPromise }) {
    const start = performance.now(), timingsMs = {}, usage = [];
    const assets = await (assetsPromise || loadAssets({ dataDir: env.GEMINI_RULE_QA_DATA_DIR || fileURLToPath(new URL('../data', import.meta.url)) }));
    timingsMs.assetLoadWait = performance.now() - start;
    if (assets.dataRevision !== dataRevision) throw new Error('gemini_rule_qa_asset_revision_mismatch');
    let preparationStep = performance.now();
    let rules = ruleContexts.get(assets);
    if (!rules) { rules = buildRuleContext(assets.rulesRecords); ruleContexts.set(assets, rules); }
    timingsMs.ruleContext = performance.now() - preparationStep;
    preparationStep = performance.now();
    const qaTools = assets.createQaTools({ cardIds: (cardResolution.resolvedCards || []).map(card => card.id), pageSize: 4 });
    timingsMs.qaRequestView = performance.now() - preparationStep;
    preparationStep = performance.now();
    const initialQa = qaTools.search({ queries: [userQuery] });
    timingsMs.initialQaSearch = performance.now() - preparationStep;
    timingsMs.assets = performance.now() - start;
    const client = clientFactory({ env, fetchImpl, signal });
    let step = performance.now();
    const cache = await client.getCache(rules);
    timingsMs.cache = performance.now() - step;
    const contents = [{ role: 'user', parts: [{ text: JSON.stringify({ question: userQuery,
      confirmedCards: cardResolution.resolvedCards, userProvidedCardTexts: retrievedEvidence.userProvidedCardTexts || [],
      unresolvedMentions: cardResolution.unresolvedMentions || [], ambiguousMentions: cardResolution.ambiguousMentions || [],
      ruleRevision: rules.ruleRevision, qaRevision: qaTools.qaRevision, initialQa }) }] }];
    await onEvent({ type: 'initial', rules, qaTools, initialQa, cache, contents });
    let reminderUsed = false, searchCount = 0;
    timingsMs.model = 0;
    timingsMs.qaSearch = 0;
    for (let round = 1; round <= 4; round++) {
      signal?.throwIfAborted();
      step = performance.now();
      const raw = await client.generate(cache, contents);
      timingsMs.model += performance.now() - step;
      usage.push(raw.usageMetadata || null);
      await onEvent({ type: 'model', round, raw });
      const content = raw.candidates?.[0]?.content;
      if (!content) throw new Error('gemini_rule_qa_content_absent');
      // Preserve complete native Content/Part, including thoughtSignature, across turns.
      contents.push(content);
      const receivedCalls = normalizeCalls(content);
      const calls = round === 4
        ? receivedCalls.filter((call) => call.name === 'submit_evidence')
        : receivedCalls;
      if (!calls.length) {
        if (round === 4) throw new Error(receivedCalls.length
          ? 'gemini_rule_qa_final_submission_required'
          : 'gemini_rule_qa_no_submission');
        if (reminderUsed) throw new Error('gemini_rule_qa_no_submission');
        if (round === 3) {
          contents.push({ role: 'user', parts: [{ text: FINAL_SUBMISSION_INSTRUCTION }] });
          continue;
        }
        reminderUsed = true;
        contents.push({ role: 'user', parts: [{ text: '请使用 search_qa 补查，或用 submit_evidence 的 ruleUnitIds 和 qaHandles 两个数组提交完整条目。不要输出裁定。' }] });
        continue;
      }
      const responses = [];
      for (const call of calls) {
        let args = call.args;
        if (typeof args === 'string') args = JSON.parse(args);
        if (call.name === 'search_qa') {
          step = performance.now();
          const result = qaTools.search(args);
          timingsMs.qaSearch += performance.now() - step;
          searchCount++;
          await onEvent({ type: 'search', round, args, result });
          responses.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: result } });
        } else if (call.name === 'submit_evidence') {
          step = performance.now();
          const selection = resolveGeminiSelection({ args, rules, qaTools });
          const result = packGeminiSelection({ selection, userQuery, cardResolution, retrievedEvidence });
          await onEvent({ type: 'selection', round, selection, ...result });
          if (result.packing.capacityExceeded) {
            responses.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: {
              capacityExceeded: true, actualPromptChars: result.packing.promptChars, limit: 36000,
              selectedEntryChars: result.packing.selectedEntryChars,
              instruction: '请重新选择完整条目；不可截断正文。',
            } } });
            continue;
          }
          timingsMs.packing = performance.now() - step;
          timingsMs.total = performance.now() - start;
          const tokenUsage = usage.reduce((sum, row) => ({
            prompt_tokens: sum.prompt_tokens + (row?.promptTokenCount || 0),
            completion_tokens: sum.completion_tokens + (row?.candidatesTokenCount || 0) + (row?.thoughtsTokenCount || 0),
            cached_input_tokens: sum.cached_input_tokens + (row?.cachedContentTokenCount || 0),
          }), { prompt_tokens: 0, completion_tokens: 0, cached_input_tokens: 0 });
          const generationEstimatedCostUsd = ((tokenUsage.prompt_tokens - tokenUsage.cached_input_tokens) * 0.75
            + tokenUsage.cached_input_tokens * 0.075 + tokenUsage.completion_tokens * 3.75) / 1e6;
          const cacheProvisionUsd = cache.reused ? 0 : (cache.tokenCount || 0) * (0.75 + 0.50 * 180 / 3600) / 1e6;
          const telemetry = { provider: 'gemini', model: client.model, providerUsed: 'gemini', modelUsed: client.model, reasoningEffort: 'low',
            dryRun: false, warnings: [], tokenUsage, cacheHit: cache.reused,
            estimatedCostUsd: generationEstimatedCostUsd + cacheProvisionUsd,
            generationEstimatedCostUsd, cacheProvisionUsd, costBasis: 'google_list_theoretical_cache_creation_input_provision_unknown',
            strategy: 'gemini_rule_cache_card_linked_bm25', dataRevision,
            ruleRevision: rules.ruleRevision, qaRevision: qaTools.qaRevision,
            rounds: round, searchCount, selectedCount: selection.ruleUnitIds.length + selection.qaHandles.length,
            promptChars: result.packing.promptChars, cacheReused: cache.reused,
            cacheExpireTime: cache.expireTime, cacheTokenCount: cache.tokenCount,
            usage, timingsMs, elapsedMs: timingsMs.total };
          result.evidence.debug = { ...retrievedEvidence.debug, cloudEvidence: telemetry };
          return { ...result, telemetry };
        } else throw new Error('gemini_rule_qa_unknown_tool');
      }
      contents.push({ role: 'user', parts: responses });
      if (round === 3) contents.push({ role: 'user', parts: [{ text: FINAL_SUBMISSION_INSTRUCTION }] });
    }
    throw new Error('gemini_rule_qa_round_limit');
  } };
}
