#!/usr/bin/env node
// Engine-reproduction batch (stage 2 experiment). Not used by the public answer path, but it runs
// the same code: scope check and card resolution are the production functions (with the model
// call injected so every response is cached), and the reproduction itself is
// backend/engineRepro/reproduce.mjs, exactly what the answer path runs.
//
//   OPENAI key: read from ENGINE_REPRO_OPENAI_API_KEY / OPENAI_DECISIONS_API_KEY / RAG_CARD_OPENAI_API_KEY
//   node scripts/engine-repro-batch.mjs --questions FILE --out DIR --only S01,S02 \
//        (--engine-repo PATH_TO_OCG_SIM_CORE | --engine-url URL with ENGINE_REPRO_SECRET) [--mock DIR] \
//        [--budget-usd 2] [--planner-model gpt-6.1-sol] [--planner-effort low] [--planner-max-output 1600] \
//        [--skip-conclusion]   (the conclusion sentence, conclusion.mjs, runs by default like in production;
//                               with --mock it reads DIR/<qid>/conclusion.json)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { classifyPublicQueryScope } from "../backend/publicQueryScopeClassifier.mjs";
import { startCardNameExtraction } from "../backend/ragRulingPipeline.mjs";
import { createModelRunner, engineReproApiKey } from "../backend/engineRepro/modelCalls.mjs";
import { createHttpEngineClient, createLocalEngineClient } from "../backend/engineRepro/engineClient.mjs";
import { DEFAULT_PLANNER, identityFromCardResolution, runEngineReproduction } from "../backend/engineRepro/reproduce.mjs";
import { STATUS } from "../backend/engineRepro/aggregate.mjs";
import { CONCLUSION_MODEL } from "../backend/engineRepro/conclusion.mjs";

const HERE = resolve(new URL(".", import.meta.url).pathname, "..");
const { values: args } = parseArgs({ options: {
  questions: { type: "string" }, out: { type: "string" }, only: { type: "string" },
  "engine-repo": { type: "string" }, "engine-root": { type: "string" }, "engine-url": { type: "string" },
  mock: { type: "string" }, "budget-usd": { type: "string", default: "0" },
  "planner-model": { type: "string", default: DEFAULT_PLANNER.model },
  "planner-effort": { type: "string", default: DEFAULT_PLANNER.effort },
  "planner-max-output": { type: "string", default: String(DEFAULT_PLANNER.maxOutput) },
  "planner-max-input": { type: "string", default: String(DEFAULT_PLANNER.maxInput) },
  "include-official-qa": { type: "boolean", default: false },
  "skip-conclusion": { type: "boolean", default: false },
} });

const outDir = resolve(args.out);
mkdirSync(join(outDir, "results"), { recursive: true });
const questionSet = JSON.parse(readFileSync(args.questions, "utf8"));
const only = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;
const cidMap = JSON.parse(readFileSync(join(HERE, "data", "engine-repro", "cid-passcode-map.json"), "utf8")).map;
const allCards = JSON.parse(readFileSync(join(HERE, "data", "cards.json"), "utf8")).records;
const planner = { model: args["planner-model"], effort: args["planner-effort"],
  maxOutput: Number(args["planner-max-output"]), maxInput: Number(args["planner-max-input"]) };
const LUNA = "gpt-6-luna";
const engine = args["engine-url"]
  ? createHttpEngineClient({ baseUrl: args["engine-url"], secret: process.env.ENGINE_REPRO_SECRET })
  : createLocalEngineClient({ repo: resolve(args["engine-repo"]),
    root: resolve(args["engine-root"] || join(resolve(args["engine-repo"]), "build", "out")) });

let mock = null;
if (args.mock) {
  const dir = resolve(args.mock);
  mock = async ({ qid, stage }) => {
    let text;
    try { text = readFileSync(join(dir, qid, `${stage}.json`), "utf8"); } catch {
      if (stage === "scope") text = JSON.stringify({ scope: "in_scope", confidence: "high", reasonCode: "mock" });
      else if (stage === "identity_select") text = "{}";
      else throw new Error(`mock missing: ${qid}/${stage}.json`);
    }
    return { status: "completed", model: "mock", output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 0, output_tokens: 0 } };
  };
}
const runner = createModelRunner({ outDir, apiKey: engineReproApiKey(process.env) || null, mock,
  budgetUsd: Number(args["budget-usd"]), log: (s) => console.error(s) });

// Only ygocdb.com (Baige, used by the reused identity confirmation) may be reached by the reused
// modules; every model call goes through the injected invokers, never through env keys.
const guardedFetch = (input, init) => {
  const url = new URL(String(input?.url || input));
  if (url.hostname !== "ygocdb.com") throw new Error(`blocked host in batch: ${url.hostname}`);
  return fetch(input, init);
};
const reusedEnv = { PUBLIC_QUERY_SCOPE_PROVIDER: "bai", RAG_CARD_MODEL_PROVIDER: "bai", RAG_CARD_LUNA_CHANNEL: "official",
  RAG_CARD_OPENAI_API_KEY: "injected-invoker-only" };

const calls = [];
async function cachedCall(qid, opts) {
  const result = await runner.call({ qid, ...opts });
  calls.push({ qid, stage: opts.stage, model: opts.model, cacheHit: result.cacheHit, bodyHash: result.bodyHash,
    status: result.status, usage: result.usage, costUsd: result.costUsd, ms: result.ms });
  return result;
}

function parseJsonObject(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
  return value;
}

async function processQuestion(q) {
  const t0 = Date.now();
  const clock = () => Date.now() - t0;
  const base = { qid: q.qid, source: q.source };
  // 1. scope check: the production classifier
  const scope = await classifyPublicQueryScope({ question: q.text, env: reusedEnv, fetchImpl: guardedFetch,
    invoke: async ({ prompt, modelName, maxTokens }) => {
      const r = await cachedCall(q.qid, { stage: "scope", model: modelName || LUNA, input: prompt, reasoningEffort: "none",
        maxOutputTokens: maxTokens });
      if (r.status !== "completed") throw new Error(`scope_response_${r.status}`);
      return { ...parseJsonObject(r.outputText), rawText: r.outputText, usage: r.usage, returnedModel: r.returnedModel,
        estimatedCostUsd: r.costUsd || 0 };
    } });
  if (scope.scope !== "in_scope") {
    return finish({ ...base, text: q.text, scope, preStatus: { status: STATUS.SKIPPED, reason: "scope",
      detail: `范围检查结果：${scope.scope}（${scope.reasonCode || ""}）` }, summary: { status: STATUS.SKIPPED,
      reasonCodes: ["scope"], flags: [] }, rendered: "" }, t0);
  }
  // 2. card resolution: the production function, for every question (no second resolver)
  const work = await startCardNameExtraction({ question: q.text, env: reusedEnv, dataDir: join(HERE, "data"),
    fetchImpl: guardedFetch, cardModelInvoker: async ({ prompt, maxTokens, reasoningEffort, task }) => {
      const stage = task === "card_name_extraction" ? "extract" : task === "card_identity_selection" ? "identity_select" : String(task);
      const r = await cachedCall(q.qid, { stage, model: LUNA, input: prompt, reasoningEffort: reasoningEffort || "none",
        maxOutputTokens: maxTokens });
      if (r.status !== "completed") throw new Error(`${stage}_response_${r.status}`);
      return r.outputText;
    } });
  const identity = identityFromCardResolution(work.cardResolution, work.cardNameModel?.groupMentions || []);
  const wanted = new Set(identity.resolved.map((c) => c.cid));
  const cardsById = new Map(allCards.filter((c) => wanted.has(String(c.id))).map((c) => [String(c.id), c]));
  // 3. the reproduction itself: the shared module
  const record = await runEngineReproduction({ question: q.text, identity, cardsById, cidMap, engine, clock, planner,
    includeOfficialQa: args["include-official-qa"], record: { ...base, scope },
    conclusion: args["skip-conclusion"] ? null : { ...CONCLUSION_MODEL, enabled: true },
    modelCall: (opts) => cachedCall(q.qid, opts) });
  return finish(record, t0);
}

function finish(record, t0) {
  const mine = calls.filter((c) => c.qid === record.qid);
  record.metrics = {
    totalMs: Date.now() - t0,
    modelCalls: mine.map((c) => ({ stage: c.stage, model: c.model, cacheHit: c.cacheHit, bodyHash: c.bodyHash, status: c.status,
      input: c.usage?.input_tokens ?? null, cached: c.usage?.input_tokens_details?.cached_tokens ?? null,
      output: c.usage?.output_tokens ?? null, reasoning: c.usage?.output_tokens_details?.reasoning_tokens ?? null,
      costUsd: c.costUsd, ms: c.ms })),
    plannerCalls: mine.filter((c) => c.stage === "plan" || c.stage === "repair").length,
    engineMs: record.timings?.engineMs ?? 0,
  };
  writeFileSync(join(outDir, "results", `${record.qid}.json`), JSON.stringify(record, null, 1));
  writeFileSync(join(outDir, "results", `${record.qid}.txt`), (record.rendered || "") + "\n");
  console.error(`${record.qid}: ${record.summary.status} ${record.summary.reasonCodes.join(",")} [${record.summary.flags.join(",")}]`);
  return record;
}

const selected = questionSet.questions.filter((q) => !only || only.has(q.qid));
for (const q of selected) {
  try { await processQuestion(q); } catch (error) {
    const record = { qid: q.qid, source: q.source, text: q.text, error: { code: error.code || null, message: String(error.message || error) } };
    writeFileSync(join(outDir, "results", `${q.qid}.json`), JSON.stringify(record, null, 1));
    console.error(`${q.qid}: ERROR ${record.error.code || ""} ${record.error.message}`);
    if (["budget_cap", "no_api_key", "openai_http_error"].includes(error.code)) break;
  }
}
console.error(`spent (ledger, non-cache): $${runner.spentUsd().toFixed(4)}`);
