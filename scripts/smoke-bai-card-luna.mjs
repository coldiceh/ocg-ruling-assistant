import {
  callCardNameExtractionModel,
  callCardIdentitySelectionModel,
} from "../backend/ragModelClient.mjs";
import {
  CLOUD_BUDGET_RESERVE,
  CLOUD_BUDGET_SETTLE,
  createCloudRequestBudget,
  runCloudBudgetedQuestion,
} from "../backend/cloudRequestBudget.mjs";
import { DEFAULT_PUBLIC_BAI_BASE_URL } from "../backend/publicRulingModelConfig.mjs";

// One manual run, two public synthetic inputs, no persistent or production ledger.
const model = "gpt-6-luna";
const maxRequests = 2;
const maxTheoreticalUsd = 1;
const unit = 1_000_000_000;
const env = {
  BAI_CARD_ENABLED: "true",
  BAI_CARD_API_KEY: process.env.BAI_API_KEY || "",
  BAI_CARD_BASE_URL: DEFAULT_PUBLIC_BAI_BASE_URL,
  BAI_CARD_MODEL: model,
  RAG_CARD_MODEL_PROVIDER: "bai",
  RAG_CARD_MODEL_REASONING_EFFORT: "none",
  RAG_CARD_MODEL_MAX_OUTPUT_TOKENS: "800",
  RAG_CARD_MODEL_TIMEOUT_MS: "45000",
  CLOUD_BUDGET_RUN_ID: "one-off-bai-card-luna-smoke",
  CLOUD_BUDGET_ACTUAL_LIMIT_CNY: "0",
  CLOUD_BUDGET_THEORETICAL_LIMIT_USD: String(maxTheoreticalUsd),
};
if (!env.BAI_CARD_API_KEY) throw new Error("bai_card_smoke_key_missing");

const ledger = new Map();
let actualNano = 0;
let theoreticalNano = 0;
let reserveCount = 0;
let settlementCount = 0;
async function command(args) {
  if (args[0] === "HGETALL") return ["actualNano", String(actualNano), "theoreticalNano", String(theoreticalNano)];
  if (args[0] !== "EVAL" || String(args[2]) !== "1") throw new Error("smoke_ledger_command_unexpected");
  const [id, actual, theoretical, ...rest] = args.slice(4);
  if (args[1] === CLOUD_BUDGET_RESERVE) {
    const nextActual = actualNano + Number(actual);
    const nextTheoretical = theoreticalNano + Number(theoretical);
    if (nextActual > Number(rest[0]) || nextTheoretical > Number(rest[1])
      || nextTheoretical > maxTheoreticalUsd * unit) return ["blocked"];
    actualNano = nextActual;
    theoreticalNano = nextTheoretical;
    ledger.set(id, JSON.parse(rest[4]));
    reserveCount += 1;
    return ["reserved", String(actualNano), String(theoreticalNano)];
  }
  if (args[1] === CLOUD_BUDGET_SETTLE) {
    const prior = ledger.get(id);
    if (!prior) return ["missing"];
    if (prior.status !== "reserved") return ["settled"];
    actualNano += Number(actual) - prior.actualNano;
    theoreticalNano += Number(theoretical) - prior.theoreticalNano;
    ledger.set(id, JSON.parse(rest[0]));
    settlementCount += 1;
    return ["settled", String(actualNano), String(theoreticalNano)];
  }
  throw new Error("smoke_ledger_command_unexpected");
}
const budget = createCloudRequestBudget({ env, command });
const cases = [
  {
    task: "card_name_extraction",
    invoke: callCardNameExtractionModel,
    input: { userQuery: "我场上有黑魔术师，手牌有死者苏生。这句话提到了哪些单张卡？" },
  },
  {
    task: "card_identity_selection",
    invoke: callCardIdentitySelectionModel,
    input: {
      userQuery: "我说的是那张等级7、攻击力2500的黑魔术师。请确认这一个卡名指的是哪张卡。",
      candidateSets: [{
        mentionId: "M1",
        surface: "黑魔术师",
        candidates: [
          { candidateId: "C1", passcode: "46986414", name: "黑魔术师",
            aliases: ["Dark Magician", "ブラック・マジシャン"],
            typeLine: "魔法师族／通常", attribute: "暗", level: 7, atk: 2500, def: 2100 },
          { candidateId: "C2", passcode: "38033121", name: "黑魔术少女",
            aliases: ["Dark Magician Girl", "ブラック・マジシャン・ガール"],
            typeLine: "魔法师族／效果", attribute: "暗", level: 6, atk: 2000, def: 1700 },
        ],
      }],
    },
  },
];
let requestCount = 0;
let failures = 0;
console.log(JSON.stringify({ kind: "bai-card-luna-smoke-budget", model, reasoningEffort: "none",
  maxOutputTokens: 800, maxRequests, maxTheoreticalUsd, ledger: "isolated_memory",
  actualProviderChargeKnown: false }));

for (const item of cases) {
  let dispatches = 0;
  let wire = null;
  let returned = null;
  const started = performance.now();
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const endpoint = `${DEFAULT_PUBLIC_BAI_BASE_URL.replace(/\/$/u, "")}/responses`;
    // Mechanical bounds only. Forward the exact request from the real module.
    if (String(url) !== endpoint || options.method !== "POST" || body.model !== model
      || body.reasoning?.effort !== "none" || body.max_output_tokens !== 800
      || dispatches >= 1 || requestCount >= maxRequests) throw new Error("smoke_request_contract_rejected");
    dispatches += 1;
    requestCount += 1;
    wire = { model: body.model, reasoningEffort: body.reasoning.effort, maxOutputTokens: body.max_output_tokens };
    const response = await fetch(url, options);
    returned = { httpStatus: response.status };
    const raw = await response.clone().json().catch(() => null);
    if (raw && typeof raw === "object") returned = { ...returned, model: raw.model || null,
      status: raw.status || null, usage: raw.usage || null };
    return response;
  };
  try {
    const result = await runCloudBudgetedQuestion({ env, budget }, () => item.invoke({
      ...item.input, dataRevision: "public-synthetic-bai-card-smoke-v1", env, fetchImpl,
      signal: AbortSignal.timeout(50_000),
    }));
    const parsedResult = item.task === "card_name_extraction"
      ? { candidates: result.candidates || [], groupMentions: result.groupMentions || [] }
      : { selections: result.selections || [] };
    const warningCodes = (result.warnings || []).map(value => String(value).split(":")[0]);
    const accountedCall = budget.snapshot().calls.at(-1);
    const completed = dispatches === 1 && returned?.httpStatus === 200
      && returned.model === model && returned.status === "completed"
      && result.dryRun === false && result.cacheHit !== true
      && accountedCall?.provider === "bai" && accountedCall.stage === "evidence_preparation"
      && accountedCall.status === "usage_settled"
      && (item.task === "card_name_extraction" ? result.candidates?.length > 0 : result.selections?.length > 0);
    if (!completed) failures += 1;
    console.log(JSON.stringify({ kind: "bai-card-luna-smoke-result", task: item.task,
      status: completed ? "completed_with_parsed_result" : "request_or_parsing_incomplete",
      request: wire, returned, result: parsedResult, warningCodes,
      theoreticalUsd: accountedCall?.theoreticalUsd ?? null,
      budgetStatus: accountedCall?.status || "no_budget_record",
      tokenUsage: result.tokenUsage || null, elapsedMs: Math.round(performance.now() - started), requestCount: dispatches }));
  } catch (error) {
    failures += 1;
    console.log(JSON.stringify({ kind: "bai-card-luna-smoke-result", task: item.task,
      status: "failed", errorType: error?.name === "TimeoutError" ? "timeout" : "request_failed",
      request: wire, returned, elapsedMs: Math.round(performance.now() - started), requestCount: dispatches }));
  }
}
const snapshot = budget.snapshot();
console.log(JSON.stringify({ kind: "bai-card-luna-smoke-summary", requestCount, failures,
  actualProviderChargeKnown: false, theoreticalUsd: snapshot.theoreticalUsd,
  reservedTheoreticalUsd: snapshot.reservedTheoreticalUsd,
  ledger: { storage: "isolated_memory", limitUsd: maxTheoreticalUsd, reserveCount, settlementCount,
    accountedTheoreticalUsd: theoreticalNano / unit, accountedActualCny: actualNano / unit },
  calls: snapshot.calls.map(call => ({ provider: call.provider, stage: call.stage,
    operation: call.operation, model: call.model, returnedModel: call.returnedModel || null,
    status: call.status, pricingBasis: call.pricingBasis, theoreticalUsd: call.theoreticalUsd,
    usage: call.usage || null, elapsedMs: call.elapsedMs ?? null, uncertainty: call.uncertainty || null })) }));
if (failures || requestCount !== maxRequests) process.exitCode = 1;
