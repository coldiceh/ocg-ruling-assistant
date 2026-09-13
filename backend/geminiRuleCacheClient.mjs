import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256, GEMINI_RULE_QA_MODEL, RULE_QA_TOOLS, RULE_QA_TOOL_CONFIG } from './geminiRuleContext.mjs';
import { runCloudGeminiRequest } from './cloudRequestBudget.mjs';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TTL = 180;
const pendingCaches = new Map();

export function createGeminiRuleCacheClient({ env = {}, fetchImpl = globalThis.fetch, signal,
  budgetedRequest = runCloudGeminiRequest, now = () => Date.now() } = {}) {
  const apiKey = env.GEMINI_RULE_QA_API_KEY || env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('gemini_rule_qa_api_key_required');
  const model = GEMINI_RULE_QA_MODEL;
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKey };
  async function api(resource, method, body) {
    const response = await fetchImpl(`${BASE}/${resource}`, { method, headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000) });
    if (!response.ok) {
      const error = new Error(`gemini_rule_qa_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  function redisConfig() {
    for (const [url, token] of [
      ['UPSTASH_BUDGET_KV_REST_API_URL', 'UPSTASH_BUDGET_KV_REST_API_TOKEN'],
      ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'], ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
      ['REDIS_REST_API_URL', 'REDIS_REST_API_TOKEN'],
    ]) if (env[url] && env[token]) return { url: env[url], token: env[token] };
    if (env.VERCEL) throw new Error('gemini_rule_qa_shared_cache_store_required');
    return null;
  }
  const redis = redisConfig();
  async function command(args) {
    const response = await fetchImpl(redis.url, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${redis.token}` },
      body: JSON.stringify(args), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`gemini_rule_cache_store_http_${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error('gemini_rule_cache_store_error');
    return payload.result;
  }
  async function getCache(rules) {
    const fixed = { model: `models/${model}`, contents: [{ role: 'user', parts: [{ text: rules.prefix }] }],
      tools: RULE_QA_TOOLS, toolConfig: RULE_QA_TOOL_CONFIG };
    // Only public prefix/contract identity and a one-way credential namespace.
    const digest = sha256(JSON.stringify(fixed));
    const key = `ocg:gemini-rule-cache:v1:${sha256(apiKey).slice(0, 24)}:${digest}`;
    const prior = pendingCaches.get(key);
    if (prior) {
      const cached = await prior;
      if (Date.parse(cached.expireTime) > now() + 30000) return { ...cached, reused: true };
      pendingCaches.delete(key);
    }
    const pending = (async () => {
      const owner = randomUUID(), lock = `${key}:lock`;
      let locked = false;
      if (redis) {
        for (let attempt = 0; attempt < 65; attempt++) {
          signal?.throwIfAborted();
          const stored = await command(['GET', key]);
          if (stored) {
            const cache = JSON.parse(stored);
            if (cache.contractHash === digest && typeof cache.name === 'string'
                && Date.parse(cache.expireTime) > now() + 30000) return { ...cache, reused: true };
          }
          if (await command(['SET', lock, owner, 'NX', 'EX', '65']) === 'OK') { locked = true; break; }
          await delay(1000, undefined, { signal });
        }
        if (!locked) throw new Error('gemini_rule_cache_creation_busy');
      }
      try {
        const body = { ...fixed, displayName: `ocg-rules-${digest.slice(0, 20)}`, ttl: `${TTL}s` };
        const raw = await budgetedRequest({ body, model, operation: 'cached_contents_create', cacheTtlSeconds: TTL,
          invoke: () => api('cachedContents', 'POST', body) });
        const tokenCount = raw.usageMetadata?.totalTokenCount;
        if (typeof raw.name !== 'string' || !Number.isFinite(Date.parse(raw.expireTime))
            || !Number.isSafeInteger(tokenCount) || tokenCount <= 0) throw new Error('gemini_rule_cache_metadata_absent');
        const cache = { name: raw.name, expireTime: raw.expireTime, tokenCount, contractHash: digest };
        if (redis) await command(['SET', key, JSON.stringify(cache), 'EX', String(TTL)]);
        return { ...cache, reused: false };
      } finally {
        if (locked) await command(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", '1', lock, owner]);
      }
    })();
    pendingCaches.set(key, pending);
    try { return await pending; } catch (error) { pendingCaches.delete(key); throw error; }
  }
  async function generate(cache, contents) {
    const body = { cachedContent: cache.name, contents,
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' }, maxOutputTokens: 4096 } };
    const invoke = () => api(`models/${model}:generateContent`, 'POST', body);
    return budgetedRequest({ body, model, operation: 'generate_content', cachedTokenCount: cache.tokenCount, invoke });
  }
  return { getCache, generate, model, deleteCache: name => api(name, 'DELETE') };
}
