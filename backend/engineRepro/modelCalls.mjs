// Model calls for the engine-reproduction experiment: official OpenAI Responses API only
// (same provider and account as the main answer), file cache keyed by question id + request
// hash, a per-run cost ledger and a hard budget cap. The request body mirrors the Luna card
// transport (ragModelClient.mjs callBaiCard, official channel): json_object output,
// fixed endpoint, redirects refused.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OFFICIAL_PROMPT_CACHE_OPTIONS } from "../officialPromptCache.mjs";

export const OFFICIAL_RESPONSES_URL = "https://api.openai.com/v1/responses";

// Official list prices per 1M tokens (developers.openai.com model pages, checked 2026-10-16).
// Above 272k input tokens: input x2, output x1.5 for the whole request.
export const PRICES_USD_PER_MTOK = Object.freeze({
  "gpt-6-astra": { input: 10, cached: 1, cacheWrite: 12.5, output: 50 },
  "gpt-6-luna": { input: 0.10, cached: 0.01, cacheWrite: 0.125, output: 0.50 },
  "gpt-6-sol": { input: 2, cached: 0.20, cacheWrite: 2.5, output: 10 },
  "gpt-6.1-sol": { input: 2, cached: 0.10, cacheWrite: 2.5, output: 10 },
});

export function usageCostUsd(model, usage) {
  const price = PRICES_USD_PER_MTOK[model];
  if (!price || !usage) return null;
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const cached = Math.min(input, Number(usage.input_tokens_details?.cached_tokens || 0));
  const written = Math.min(input - cached, Number(usage.input_tokens_details?.cache_write_tokens || 0));
  const long = input > 272000;
  return (((input - cached - written) * price.input + cached * price.cached + written * price.cacheWrite) * (long ? 2 : 1)
    + output * price.output * (long ? 1.5 : 1)) / 1e6;
}

// Mechanical upper bound used only for the budget guard: every character counts as one token.
export function worstCaseCostUsd(model, inputText, maxOutputTokens) {
  const price = PRICES_USD_PER_MTOK[model];
  if (!price) return Infinity;
  return (Array.from(inputText).length * price.input + maxOutputTokens * price.output) / 1e6;
}

// Rough estimate for the soft context target (CJK ~1 token/char, other ~1 token/3 chars).
// Not a tokenizer or a billing count; observed provider usage is recorded separately.
export function estimateTokens(text) {
  const chars = Array.from(String(text));
  const cjk = chars.filter((c) => /[　-鿿＀-￯]/u.test(c)).length;
  return Math.ceil(cjk + (chars.length - cjk) / 3);
}

export function createModelRunner({ outDir, apiKey = null, mock = null, budgetUsd, fetchImpl = globalThis.fetch, log = () => {} }) {
  const cacheDir = join(outDir, "cache");
  const ledgerPath = join(outDir, "ledger.jsonl");
  mkdirSync(cacheDir, { recursive: true });
  let spent = 0;
  if (existsSync(ledgerPath)) {
    for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (!row.cacheHit && Number.isFinite(row.costUsd)) spent += row.costUsd;
    }
  }

  async function call({ qid, stage, model, instructions = null, input, reasoningEffort, maxOutputTokens, maxInputTokens = null }) {
    const body = {
      model,
      ...(instructions ? { instructions } : {}),
      input,
      reasoning: { effort: reasoningEffort },
      text: { format: { type: "json_object" } },
      max_output_tokens: maxOutputTokens,
      stream: false,
      prompt_cache_options: OFFICIAL_PROMPT_CACHE_OPTIONS,
    };
    const bodyHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const cachePath = join(cacheDir, qid, `${stage}-${bodyHash.slice(0, 16)}.json`);
    const inputText = `${instructions || ""}\n${input}`;
    const row = { at: new Date().toISOString(), qid, stage, model, reasoningEffort, maxOutputTokens, bodyHash,
      inputTokensEstimate: estimateTokens(inputText), maxInputTokens };
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      appendFileSync(ledgerPath, JSON.stringify({ ...row, cacheHit: true, usage: cached.usage, costUsd: cached.costUsd,
        ms: 0, status: cached.status }) + "\n");
      return { ...cached, cacheHit: true, bodyHash };
    }
    // Reproduction trims optional context before this call. Essential card text
    // can still exceed its soft target; only the monetary budget rejects a call.
    if (!mock) {
      const worst = worstCaseCostUsd(model, inputText, maxOutputTokens);
      if (!(spent + worst <= budgetUsd)) {
        const error = new Error(`budget cap: spent ${spent.toFixed(4)} + worst ${worst.toFixed(4)} > ${budgetUsd}`);
        error.code = "budget_cap";
        throw error;
      }
      if (!apiKey) {
        const error = new Error("no API key configured for paid calls");
        error.code = "no_api_key";
        throw error;
      }
    }
    const started = Date.now();
    let payload;
    if (mock) {
      payload = await mock({ qid, stage, model, body });
    } else {
      const response = await fetchImpl(OFFICIAL_RESPONSES_URL, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) {
        let code = "";
        try { code = JSON.parse(text)?.error?.code || ""; } catch {}
        const error = new Error(`openai_http_${response.status}${code ? `:${code}` : ""}`);
        error.code = "openai_http_error";
        error.httpStatus = response.status;
        appendFileSync(ledgerPath, JSON.stringify({ ...row, cacheHit: false, error: error.message, ms: Date.now() - started }) + "\n");
        throw error;
      }
      payload = JSON.parse(text);
      // Non-secret routing facts, so the owner can confirm which organization/project paid.
      payload.__routing = { organization: response.headers.get("openai-organization"),
        project: response.headers.get("openai-project"), requestId: response.headers.get("x-request-id") };
    }
    const ms = Date.now() - started;
    const outputText = (payload.output || []).flatMap((item) => item?.type === "message" ? (item.content || []) : [])
      .filter((part) => part?.type === "output_text").map((part) => part.text).join("");
    const usage = payload.usage || null;
    const costUsd = mock ? 0 : usageCostUsd(model, usage);
    if (!mock && Number.isFinite(costUsd)) spent += costUsd;
    const record = { status: payload.status || null, incomplete: payload.incomplete_details || null,
      returnedModel: payload.model || null, responseId: payload.id || null, routing: payload.__routing || null, outputText, usage, costUsd, ms, mock: Boolean(mock) };
    mkdirSync(dirname(cachePath), { recursive: true });
    // Only completed responses are cached; an incomplete one is recorded in the ledger and returned.
    if (record.status === "completed") writeFileSync(cachePath, JSON.stringify(record, null, 1));
    appendFileSync(ledgerPath, JSON.stringify({ ...row, cacheHit: false, usage, costUsd, ms, status: record.status, routing: record.routing,
      incomplete: record.incomplete, mock: Boolean(mock) }) + "\n");
    log(`${qid} ${stage} ${model} status=${record.status} in=${usage?.input_tokens ?? "?"} out=${usage?.output_tokens ?? "?"} $${(costUsd ?? 0).toFixed(4)} ${ms}ms`);
    return { ...record, cacheHit: false, bodyHash };
  }

  return { call, spentUsd: () => spent };
}

// Production path: same request body, no file cache; every paid call reserves its worst case
// in the reproduction's own daily bucket first and settles the measured cost afterwards.
export function engineReproApiKey(env = {}) {
  return String(env.ENGINE_REPRO_OPENAI_API_KEY || env.OPENAI_DECISIONS_API_KEY || env.RAG_CARD_OPENAI_API_KEY
    || env.OCG_CARD_OPENAI_API_KEY || "").trim();
}

export function createOfficialModelCall({ env, limits, fetchImpl = globalThis.fetch }) {
  const apiKey = engineReproApiKey(env);
  // timeoutMs bounds one call (default 120 s); the official-Q&A judge passes a shorter one.
  return async function modelCall({ model, instructions = null, input, reasoningEffort, maxOutputTokens, maxInputTokens = null,
    timeoutMs = 120000 }) {
    if (!apiKey) throw Object.assign(new Error("engine_repro_api_key_missing"), { code: "engine_repro_not_configured" });
    const body = { model, ...(instructions ? { instructions } : {}), input, reasoning: { effort: reasoningEffort },
      text: { format: { type: "json_object" } }, max_output_tokens: maxOutputTokens, stream: false,
      prompt_cache_options: OFFICIAL_PROMPT_CACHE_OPTIONS };
    const inputText = `${instructions || ""}\n${input}`;
    // maxInputTokens is a soft trimming target, never a second rejection gate.
    const reservation = await limits.reserve(worstCaseCostUsd(model, inputText, maxOutputTokens));
    const started = Date.now();
    let payload;
    let routing;
    try {
      const response = await fetchImpl(OFFICIAL_RESPONSES_URL, {
        method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        let code = "";
        try { code = JSON.parse(text)?.error?.code || ""; } catch { /* plain-text error */ }
        throw Object.assign(new Error(`openai_http_${response.status}${code ? `:${code}` : ""}`), { code: "engine_repro_model_error" });
      }
      payload = JSON.parse(text);
      routing = { organization: response.headers.get("openai-organization"), project: response.headers.get("openai-project") };
    } catch (error) {
      // Unknown outcome: the reservation stays as charged.
      throw error;
    }
    const usage = payload.usage || null;
    const costUsd = usageCostUsd(model, usage);
    await limits.settle(reservation, costUsd).catch(() => null);
    const outputText = (payload.output || []).flatMap((item) => item?.type === "message" ? (item.content || []) : [])
      .filter((part) => part?.type === "output_text").map((part) => part.text).join("");
    return { status: payload.status || null, incomplete: payload.incomplete_details || null, outputText, usage, costUsd,
      ms: Date.now() - started, routing, cacheHit: false };
  };
}
