// Environment construction for the retrieval comparison runner. The two arms
// share one base environment and differ only in RULE_TOC_ADMIT_ENABLED; the
// runner asserts that after the production public-answer env transform.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const PRODUCTION_PROFILE_ID = "official-astra-low";
export const ARM_FLAG = "RULE_TOC_ADMIT_ENABLED";
export const ARMS = Object.freeze({ baseline: "false", toc: "true" });
export const MEMORY_LEDGER_URL = "https://bench-ledger.invalid/";
export const MEMORY_LEDGER_TOKEN = "bench-memory-ledger";
export const NON_BINDING_LIMIT = "100000";

// Settings that the brief states are live in production but that live in the
// Vercel dashboard rather than vercel.json. They are applied explicitly and
// listed in the run manifest so they can be checked against the dashboard.
export const ASSUMED_DASHBOARD_ENV = Object.freeze({
  // RAG_CARD_LUNA_CHANNEL=official (vercel.json) only takes effect with this.
  BAI_CARD_ENABLED: "true",
});

// Each job prepares its own evidence: the process-level extraction, 百鸽 and
// live-Q&A caches would otherwise let the second arm of a question reuse the
// first arm's lookups and model calls. A 1 ms TTL keeps every job fresh.
export const FRESH_CACHE_ENV = Object.freeze({
  RAG_EXTRACTION_CACHE_TTL_MS: "1",
  BAIGE_CACHE_TTL_MS: "1",
  RAG_LIVE_QA_CACHE_TTL_MS: "1",
});

export const UPSTASH_ENV_PAIRS = Object.freeze([
  ["UPSTASH_BUDGET_KV_REST_API_URL", "UPSTASH_BUDGET_KV_REST_API_TOKEN"],
  ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
  ["REDIS_REST_API_URL", "REDIS_REST_API_TOKEN"],
]);

// Placeholder credentials for --mock. They are never sent anywhere: the mock
// router answers every request in-process.
export const MOCK_KEYS = Object.freeze({
  GEMINI_RULE_QA_API_KEY: "mock-gemini-key",
  OCG_FINAL_OPENAI_API_KEY: "mock-final-openai-key",
  RAG_CARD_OPENAI_API_KEY: "mock-card-openai-key",
  RAG_EVIDENCE_OPENAI_API_KEY: "mock-evidence-openai-key",
});

const RELEVANT_PREFIX = /^(?:RAG_|GEMINI_|OCG_|EVIDENCE_|CLOUD_|PUBLIC_|BAI_|OPENAI_|RELAY_|DEEPSEEK_|GLM_|UPSTASH_|KV_|REDIS_|BAIGE_|ENGINE_REPRO|QUERY_AUDIT_|API_|RULE_|DECISIONS_|MODEL_|PRIVATE_EVALUATION_|SOURCE_TRANSLATION_|ADMIN_MODEL_LAB_|NODE_OPTIONS$)/u;
const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/u;

export function readVercelProductionEnv(vercelJsonPath) {
  const parsed = JSON.parse(readFileSync(vercelJsonPath, "utf8"));
  if (!parsed?.env || typeof parsed.env !== "object") throw new Error("vercel_json_env_missing");
  return Object.fromEntries(Object.entries(parsed.env).map(([key, value]) => [key, String(value)]));
}

export function upstashConfigured(env) {
  return UPSTASH_ENV_PAIRS.some(([url, token]) => String(env[url] || "").trim() && String(env[token] || "").trim());
}

export function resolveLedgerMode(requested, env) {
  if (requested === "memory" || requested === "upstash") return requested;
  if (requested && requested !== "auto") throw new Error(`--ledger must be auto|memory|upstash, got ${requested}`);
  return upstashConfigured(env) ? "upstash" : "memory";
}

export function benchRunNamespace(runId) {
  const namespace = `bench_${String(runId).replace(/[^A-Za-z0-9_-]/gu, "_")}`.slice(0, 100);
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(namespace)) throw new Error("bench_run_namespace_invalid");
  return namespace;
}

/**
 * Builds the shared base environment (before the arm flag).
 * Precedence: inherited (real mode only) < vercel.json production env <
 * assumed dashboard flags < fresh caches < --set-env < bench-owned ledger keys.
 */
export function buildBaseEnv({
  mode, inheritedEnv = {}, productionEnv, setEnv = {}, ledgerMode, runId,
}) {
  const base = mode === "mock" ? { ...MOCK_KEYS } : { ...inheritedEnv };
  Object.assign(base, productionEnv, ASSUMED_DASHBOARD_ENV, FRESH_CACHE_ENV, setEnv);
  const namespace = benchRunNamespace(runId);
  Object.assign(base, {
    PUBLIC_RULING_MODEL_PROFILE: PRODUCTION_PROFILE_ID,
    ENGINE_REPRO_ENABLED: "false",
    // Bench-only ledger namespace: never the production daily keys, and
    // limits high enough that production's own caps never shape evidence.
    CLOUD_BUDGET_RUN_ID: namespace,
    CLOUD_BUDGET_PERIOD: "run",
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY: NON_BINDING_LIMIT,
    CLOUD_BUDGET_THEORETICAL_LIMIT_USD: NON_BINDING_LIMIT,
    CLOUD_BUDGET_INITIAL_ACTUAL_CNY: "0",
    CLOUD_BUDGET_INITIAL_THEORETICAL_USD: "0",
    PUBLIC_OPENAI_BUDGET_RUN_ID: namespace,
    PUBLIC_OPENAI_DAILY_LIMIT_USD: NON_BINDING_LIMIT,
    PUBLIC_OPENAI_BUDGET_LIMIT_USD: NON_BINDING_LIMIT,
    PUBLIC_OPENAI_BUDGET_INITIAL_USD: "0",
  });
  if (ledgerMode === "memory") {
    for (const [url, token] of UPSTASH_ENV_PAIRS) {
      delete base[url];
      delete base[token];
    }
    base.UPSTASH_BUDGET_KV_REST_API_URL = MEMORY_LEDGER_URL;
    base.UPSTASH_BUDGET_KV_REST_API_TOKEN = MEMORY_LEDGER_TOKEN;
  }
  delete base[ARM_FLAG];
  return base;
}

export function armEnv(baseEnv, arm) {
  if (!Object.hasOwn(ARMS, arm)) throw new Error(`unknown arm: ${arm}`);
  return { ...baseEnv, [ARM_FLAG]: ARMS[arm] };
}

export function relevantEnvEntries(env) {
  return Object.keys(env).filter((key) => RELEVANT_PREFIX.test(key)).sort()
    .map((key) => [key, String(env[key])]);
}

function maskValue(key, value) {
  if (SECRET_NAME.test(key)) {
    if (!value) return "";
    const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
    return `<set len=${value.length} sha256:${digest}>`;
  }
  if (/_URL$/u.test(key) && value) {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      url.search = "";
      return url.toString();
    } catch {
      return "<unparsed url>";
    }
  }
  return value;
}

export function maskedEnvSnapshot(env) {
  return Object.fromEntries(relevantEnvEntries(env).map(([key, value]) => [key, maskValue(key, value)]));
}

export function envDifference(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => left[key] !== right[key]).sort();
}

// Credentials that the production configuration needs; checked before any
// real-mode job so a missing key cannot silently fall back to a mock path.
export function missingRealModeEnv(env) {
  const any = (...names) => names.some((name) => String(env[name] || "").trim());
  const missing = [];
  if (!any("GEMINI_RULE_QA_API_KEY", "GEMINI_API_KEY")) missing.push("GEMINI_RULE_QA_API_KEY 或 GEMINI_API_KEY");
  if (!any("OCG_FINAL_OPENAI_API_KEY")) missing.push("OCG_FINAL_OPENAI_API_KEY");
  if (!any("RAG_CARD_OPENAI_API_KEY", "OCG_CARD_OPENAI_API_KEY", "OPENAI_DECISIONS_API_KEY")) {
    missing.push("RAG_CARD_OPENAI_API_KEY 或 OCG_CARD_OPENAI_API_KEY（卡名 Luna 官方通道）");
  }
  if (!any("RAG_EVIDENCE_OPENAI_API_KEY", "OCG_EVIDENCE_OPENAI_API_KEY", "OPENAI_DECISIONS_API_KEY",
    "RAG_CARD_OPENAI_API_KEY", "OCG_CARD_OPENAI_API_KEY")) {
    missing.push("RAG_EVIDENCE_OPENAI_API_KEY 或 OCG_EVIDENCE_OPENAI_API_KEY（选证 Luna 官方通道）");
  }
  return missing;
}
