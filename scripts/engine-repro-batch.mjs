#!/usr/bin/env node
// Engine-reproduction batch (stage 2 experiment). Not used by the public answer path.
//
//   node scripts/engine-repro-batch.mjs --questions FILE --out DIR --only S01,S02 \
//        --engine-repo PATH_TO_OCG_SIM_CORE [--key-file FILE | --mock DIR] [--budget-usd 8] \
//        [--planner-model gpt-6-luna] [--planner-effort low] [--planner-max-output 2000] \
//        [--planner-max-input 8000] [--include-official-qa]
//
// Per question: scope check (reused) -> card extraction + canonical names (reused; official Q&A
// samples use the official CID placeholders instead) -> CID->passcode -> planner (1 call) ->
// engine -> one repair call only if something failed -> question status -> files.
// Every model response is cached by (question id, request hash); reruns do not pay again.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { classifyPublicQueryScope } from "../backend/publicQueryScopeClassifier.mjs";
import { startCardNameExtraction } from "../backend/ragRulingPipeline.mjs";
import { createModelRunner } from "../backend/engineRepro/modelCalls.mjs";
import { FILLER_CARDS, PLANNER_INSTRUCTIONS, PROMPT_VERSION, TOOL_CARD_CODES, buildPlannerInput, buildRepairInput } from "../backend/engineRepro/plannerPrompt.mjs";
import { STATUS, aggregateQuestion, renderQuestion } from "../backend/engineRepro/aggregate.mjs";

const HERE = resolve(new URL(".", import.meta.url).pathname, "..");
const { values: args } = parseArgs({ options: {
  questions: { type: "string" }, out: { type: "string" }, only: { type: "string" },
  "engine-repo": { type: "string" }, "engine-root": { type: "string" },
  "key-file": { type: "string" }, mock: { type: "string" }, "budget-usd": { type: "string", default: "0" },
  "planner-model": { type: "string", default: "gpt-6-luna" }, "planner-effort": { type: "string", default: "low" },
  "planner-max-output": { type: "string", default: "2000" }, "planner-max-input": { type: "string", default: "8000" },
  "include-official-qa": { type: "boolean", default: false }, "cid-map": { type: "string" },
} });

const outDir = resolve(args.out);
mkdirSync(join(outDir, "results"), { recursive: true });
const engineRepo = resolve(args["engine-repo"]);
const engineRoot = resolve(args["engine-root"] || join(engineRepo, "build", "out"));
const questionSet = JSON.parse(readFileSync(args.questions, "utf8"));
const only = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;
const cidMap = JSON.parse(readFileSync(args["cid-map"] || join(HERE, "data", "engine-repro", "cid-passcode-map.json"), "utf8")).map;
const cardsById = new Map(JSON.parse(readFileSync(join(HERE, "data", "cards.json"), "utf8")).records.map((c) => [String(c.id), c]));
const planner = { model: args["planner-model"], effort: args["planner-effort"],
  maxOutput: Number(args["planner-max-output"]), maxInput: Number(args["planner-max-input"]) };
const LUNA = "gpt-6-luna";

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
const apiKey = args["key-file"] ? readFileSync(args["key-file"], "utf8").trim() : null;
const runner = createModelRunner({ outDir, apiKey, mock, budgetUsd: Number(args["budget-usd"]), log: (s) => console.error(s) });

// Only ygocdb.com (Baige, used by the reused identity confirmation) may be reached by the reused
// modules; every model call goes through the injected invokers above, never through env keys.
const guardedFetch = (input, init) => {
  const url = new URL(String(input?.url || input));
  if (url.hostname !== "ygocdb.com") throw new Error(`blocked host in batch: ${url.hostname}`);
  return fetch(input, init);
};
const reusedEnv = { PUBLIC_QUERY_SCOPE_PROVIDER: "bai", RAG_CARD_MODEL_PROVIDER: "bai", RAG_CARD_LUNA_CHANNEL: "official",
  RAG_CARD_OPENAI_API_KEY: "injected-invoker-only" };

function engine(request) {
  const started = Date.now();
  const proc = spawnSync("python3", ["-m", "ocgrepro", "api"], { cwd: engineRepo, input: JSON.stringify(request),
    env: { PATH: process.env.PATH, OCG_REPRO_ROOT: engineRoot, LANG: "C.UTF-8" }, maxBuffer: 256 * 1024 * 1024 });
  if (proc.status !== 0) throw new Error(`engine api failed (${proc.status}): ${String(proc.stderr).slice(-800)}`);
  return { ...JSON.parse(String(proc.stdout)), wallMs: Date.now() - started };
}

const calls = [];
async function modelCall(opts) {
  const result = await runner.call(opts);
  calls.push({ qid: opts.qid, stage: opts.stage, model: opts.model, cacheHit: result.cacheHit, bodyHash: result.bodyHash, status: result.status,
    usage: result.usage, costUsd: result.costUsd, ms: result.ms });
  return result;
}

function parseJsonObject(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
  return value;
}

async function scopeCheck(q) {
  return classifyPublicQueryScope({ question: q.text, env: reusedEnv, fetchImpl: guardedFetch,
    invoke: async ({ prompt, modelName, maxTokens }) => {
      const r = await modelCall({ qid: q.qid, stage: "scope", model: modelName || LUNA, input: prompt,
        reasoningEffort: "none", maxOutputTokens: maxTokens });
      if (r.status !== "completed") throw new Error(`scope_response_${r.status}`);
      return { ...parseJsonObject(r.outputText), rawText: r.outputText, usage: r.usage, returnedModel: r.returnedModel,
        estimatedCostUsd: r.costUsd || 0 };
    } });
}

async function identity(q) {
  if (q.card_identity_input === "official_cid_placeholders") {
    const cids = q.card_cids.map(String);
    return { method: "official_cid_placeholders", resolved: cids.map((cid) => ({ cid, mentionedAs: [] })),
      unresolved: [], groupMentions: [] };
  }
  const work = await startCardNameExtraction({ question: q.text, env: reusedEnv, dataDir: join(HERE, "data"),
    fetchImpl: guardedFetch, cardModelInvoker: async ({ prompt, maxTokens, reasoningEffort, task }) => {
      const stage = task === "card_name_extraction" ? "extract" : task === "card_identity_selection" ? "identity_select" : String(task);
      const r = await modelCall({ qid: q.qid, stage, model: LUNA, input: prompt, reasoningEffort: reasoningEffort || "none",
        maxOutputTokens: maxTokens });
      if (r.status !== "completed") throw new Error(`${stage}_response_${r.status}`);
      return r.outputText;
    } });
  const cr = work.cardResolution || {};
  const byCid = new Map();
  for (const c of cr.resolvedCards || []) {
    const entry = byCid.get(String(c.id)) || { cid: String(c.id), mentionedAs: [], resolutionSources: [] };
    entry.mentionedAs.push(c.input);
    entry.resolutionSources.push(c.resolutionSource);
    byCid.set(String(c.id), entry);
  }
  return { method: "reused_extraction", resolved: [...byCid.values()],
    unresolved: [...(cr.unresolvedMentions || []), ...(cr.ambiguousMentions || [])].map((m) => ({ input: m.input, reason: m.reason })),
    groupMentions: work.cardNameModel?.groupMentions || [], warnings: (work.cardNameModel?.warnings || []).slice(0, 20) };
}

function collectCodes(scenario, actions) {
  const codes = [];
  for (const p of scenario?.players || []) {
    for (const key of ["hand", "deck", "extra", "extra_faceup", "grave"]) codes.push(...(p[key] || []));
    for (const r of p.removed || []) codes.push(r.code);
    for (const m of p.mzone || []) { codes.push(m.code); codes.push(...(m.overlay || [])); }
    for (const s of p.szone || []) codes.push(s.code);
    if (p.fzone) codes.push(p.fzone.code);
    for (const z of p.pzone || []) if (z) codes.push(z.code);
  }
  for (const step of actions?.setup || []) {
    if (step?.choose?.card !== undefined) codes.push(step.choose.card);
    for (const c of step?.choose?.cards || []) codes.push(c.card);
  }
  for (const probe of actions?.probes || []) if (probe?.target?.card !== undefined) codes.push(probe.target.card);
  return codes;
}

// Mechanical plan checks: field shapes, allowed card codes, exact names of extra cards.
function checkPlan(plan, allowedCodes) {
  const problems = [];
  if (!["applicable", "not_applicable"].includes(plan.applicability)) problems.push("applicability 取值无效");
  if (plan.applicability === "not_applicable"
      && !["pure_rule", "archetype_level", "tournament_policy", "ruleset_version"].includes(plan.reason_code)) {
    problems.push("not_applicable 需要有效的 reason_code");
  }
  if (plan.applicability === "applicable" && !(Array.isArray(plan.sub_questions) && plan.sub_questions.length)) {
    problems.push("applicable 时 sub_questions 不能为空");
  }
  const allowed = new Set(allowedCodes);
  const extra = Array.isArray(plan.extra_cards) ? plan.extra_cards : [];
  const extraCodes = extra.map((c) => Number(c?.code)).filter(Number.isSafeInteger);
  let extraInfo = [];
  if (extraCodes.length) extraInfo = engine({ op: "cards", codes: extraCodes }).cards;
  for (const [i, c] of extra.entries()) {
    const info = extraInfo.find((x) => x.code === Number(c?.code));
    if (!info?.exists) problems.push(`extra_cards[${i}] 卡号 ${c?.code} 不在卡库`);
    else if (info.name !== c?.name) problems.push(`extra_cards[${i}] 卡号 ${c?.code} 在卡库中名为「${info.name}」，与所写「${c?.name}」不一致`);
    else allowed.add(info.code);
  }
  const branchProblems = new Map();
  for (const field of ["reason_code", "archetype_name"]) {
    if (plan[field] === "null") problems.push(`${field} 写成了字符串 "null"，应为 JSON null`);
  }
  for (const sq of plan.sub_questions || []) {
    if (!sq || typeof sq.id !== "string") { problems.push("sub_question 缺少 id"); continue; }
    if (sq.unrepresentable === "null") problems.push(`${sq.id}: unrepresentable 写成了字符串 "null"，应为 JSON null`);
    for (const b of sq.branches || []) if (b?.assumption === "null") problems.push(`${sq.id}/${b?.id}: assumption 写成了字符串 "null"，应为 JSON null`);
    const branches = Array.isArray(sq.branches) ? sq.branches : [];
    if (!sq.unrepresentable && (branches.length < 1 || branches.length > 2)) problems.push(`${sq.id}: branches 需要 1–2 个`);
    for (const b of branches) {
      const bp = [];
      if (!b || typeof b.id !== "string") { problems.push(`${sq.id}: branch 缺少 id`); continue; }
      if (!b.scenario || typeof b.scenario !== "object") bp.push("缺少 scenario");
      if (!b.actions || typeof b.actions !== "object") bp.push("缺少 actions");
      for (const code of collectCodes(b.scenario, b.actions)) {
        if (!allowed.has(code)) bp.push(`卡号 ${code} 不在允许的卡号列表中（题目中的卡、填充卡、extra_cards）`);
      }
      if (bp.length) branchProblems.set(`${sq.id}/${b.id}`, [...new Set(bp)]);
    }
  }
  return { problems, branchProblems };
}

function compactFailure(sq, b) {
  const r = b.engine;
  const failure = { sub_question: sq.id, branch: b.id };
  if (b.planProblems) return { ...failure, reason_code: "invalid_input", problems: b.planProblems };
  failure.reason_code = r?.reason_code || r?.status;
  if (r?.errors) failure.problems = r.errors;
  const f = r?.failure;
  if (f) {
    failure.failure = { reason: f.reason, step: f.step, step_spec: f.step_spec, detail: f.detail };
    const d = f.decision;
    if (d) {
      failure.decision = { kind: d.kind, player: d.player, phase: d.phase, turn: d.turn, hint: d.hint?.text || null,
        options: (d.options || []).slice(0, 40).map((o) => ({ cmd: o.cmd, card: o.card, name: o.name, controller: o.controller,
          from: o.from, seq: o.seq, desc: o.desc, desc_text: o.desc_text, forced: o.forced, position: o.position,
          place: o.place })) };
    }
  }
  if (r?.probes) failure.probes = r.probes.map((p) => ({ result: p.result, note: p.note }));
  return failure;
}

function runBranches(record, onlyKeys = null) {
  for (const sq of record.subQuestions) {
    if (sq.unrepresentable) continue;
    for (const b of sq.branches) {
      const key = `${sq.id}/${b.id}`;
      if (onlyKeys && !onlyKeys.has(key)) continue;
      if (b.planProblems) { b.engine = null; continue; }
      const res = engine({ op: "reproduce", scenario: b.scenario, actions: b.actions });
      b.engine = res.result;
      b.engineWallMs = (b.engineWallMs || 0) + res.wallMs;
    }
  }
}

function adoptPlan(record, plan, allowed) {
  const check = checkPlan(plan, allowed);
  record.plan = plan;
  record.planProblems = check.problems;
  record.subQuestions = (plan.sub_questions || []).map((sq) => ({ id: sq.id, quoted_span: sq.quoted_span,
    unrepresentable: sq.unrepresentable || null,
    branches: (sq.unrepresentable ? [] : (sq.branches || [])).map((b) => ({ id: b.id, assumption: b.assumption || null,
      observe: b.observe || null, scenario: b.scenario, actions: b.actions, planProblems: check.branchProblems.get(`${sq.id}/${b.id}`) || null })) }));
  return check;
}

async function processQuestion(q) {
  const t0 = Date.now();
  const record = { qid: q.qid, source: q.source, text: q.text, promptVersion: PROMPT_VERSION, planner,
    includeOfficialQa: args["include-official-qa"], plannerCalled: false };
  // 1. scope check (reused unchanged)
  const scope = await scopeCheck(q);
  record.scope = { scope: scope.scope, confidence: scope.confidence, reasonCode: scope.reasonCode, failure: scope.failure || null };
  if (scope.scope !== "in_scope") {
    record.preStatus = { status: STATUS.SKIPPED, reason: "scope", detail: `范围检查结果：${scope.scope}（${scope.reasonCode || ""}）` };
    return finish(record, t0);
  }
  // 2. identity
  const id = await identity(q);
  record.identity = id;
  if (!id.resolved.length && !id.unresolved.length) {
    record.preStatus = { status: STATUS.NA, reason: "no_card_mentioned",
      detail: id.groupMentions.length ? `只提到集合名称：${id.groupMentions.join("、")}` : "没有抽取到卡名" };
    return finish(record, t0);
  }
  const unmapped = id.resolved.filter((c) => !cidMap[c.cid]);
  if (id.unresolved.length || unmapped.length) {
    const names = [...id.unresolved.map((m) => `「${m.input}」`), ...unmapped.map((c) => `CID ${c.cid}（${cardsById.get(c.cid)?.name || "?"}）无卡号`)];
    record.preStatus = { status: STATUS.FAIL, reason: "identity", detail: `无法确认身份：${names.join("、")}` };
    return finish(record, t0);
  }
  // 3. planner context: engine facts by passcode + the main answer's card text by CID
  const codes = id.resolved.map((c) => cidMap[c.cid]);
  const facts = engine({ op: "cards", codes }).cards;
  const cards = id.resolved.map((c, i) => {
    const raw = cardsById.get(c.cid) || {};
    return { code: codes[i], cid: c.cid, engineName: facts[i].name, engine: facts[i], mentionedAs: c.mentionedAs,
      effectText: raw.effectText || "", pendulumEffectText: raw.pendulumEffectText || "" };
  });
  record.cards = cards.map((c) => ({ code: c.code, cid: c.cid, engineName: c.engineName, mentionedAs: c.mentionedAs }));
  const relatedCards = engine({ op: "related", codes }).related;
  const toolCards = engine({ op: "cards", codes: [...TOOL_CARD_CODES], with_text: true }).cards
    .map((c) => ({ code: c.code, name: c.name, types: c.types.join("/"), text: c.text }));
  record.relatedRefs = relatedCards.map((e) => ({ ref: e.ref, kind: e.kind, total: e.total ?? e.cards.length, shown: e.cards.length }));
  const allowed = [...codes, ...FILLER_CARDS.map((c) => c.code), ...TOOL_CARD_CODES,
    ...relatedCards.flatMap((e) => e.cards.map((c) => c.code))];
  const plannerInput = buildPlannerInput({ question: q.text, cards, relatedCards, toolCards, includeOfficialQa: args["include-official-qa"] });
  // 4. plan (call 1)
  record.plannerCalled = true;
  const r1 = await modelCall({ qid: q.qid, stage: "plan", model: planner.model, instructions: PLANNER_INSTRUCTIONS,
    input: plannerInput, reasoningEffort: planner.effort, maxOutputTokens: planner.maxOutput, maxInputTokens: planner.maxInput });
  record.planRaw = [{ call: "plan", status: r1.status, incomplete: r1.incomplete, text: r1.outputText }];
  let plan = null;
  let planLevelProblems = [];
  try { plan = parseJsonObject(r1.outputText); } catch (e) { planLevelProblems = [`输出不是完整的 JSON 对象（status=${r1.status}${r1.incomplete ? `, ${JSON.stringify(r1.incomplete)}` : ""}）：${e.message}`]; }
  if (plan) {
    const check = adoptPlan(record, plan, allowed);
    planLevelProblems = check.problems;
    if (!planLevelProblems.length && plan.applicability === "applicable") runBranches(record);
  }
  if (plan?.applicability === "not_applicable" && !planLevelProblems.length) {
    if (plan.reason_code === "archetype_level" && plan.archetype_name) {
      record.archetypeVerified = engine({ op: "setnames", names: [plan.archetype_name] }).setnames[plan.archetype_name] === true;
    }
    return finish(record, t0);
  }
  // 5. one repair call, only if something failed
  const failures = [];
  if (planLevelProblems.length) failures.push({ plan_level: true, problems: planLevelProblems });
  else for (const sq of record.subQuestions) for (const b of sq.branches) if (!b.engine || b.engine.status !== "replayed") failures.push(compactFailure(sq, b));
  if (failures.length) {
    record.repairCalled = true;
    const repairInput = buildRepairInput({ plannerInput, previousPlan: plan || r1.outputText.slice(0, 4000), failures });
    const r2 = await modelCall({ qid: q.qid, stage: "repair", model: planner.model, instructions: PLANNER_INSTRUCTIONS,
      input: repairInput, reasoningEffort: planner.effort, maxOutputTokens: planner.maxOutput, maxInputTokens: planner.maxInput });
    record.planRaw.push({ call: "repair", status: r2.status, incomplete: r2.incomplete, text: r2.outputText });
    let fix = null;
    try { fix = parseJsonObject(r2.outputText); } catch (e) { record.repairProblems = [`修复输出不是完整的 JSON：${e.message}`]; }
    if (fix && planLevelProblems.length) {
      const check = adoptPlan(record, fix, allowed);
      if (check.problems.length) { record.planFailure = "invalid_input"; record.repairProblems = check.problems; record.plan = null; }
      else if (fix.applicability === "applicable") runBranches(record);
      else if (fix.reason_code === "archetype_level" && fix.archetype_name) {
        record.archetypeVerified = engine({ op: "setnames", names: [fix.archetype_name] }).setnames[fix.archetype_name] === true;
      }
    } else if (fix) {
      const fixed = new Set();
      const extraCheck = checkPlan({ ...fix, applicability: "applicable", sub_questions: fix.sub_questions || [] }, allowed);
      for (const fsq of fix.sub_questions || []) {
        const sq = record.subQuestions.find((x) => x.id === fsq.id);
        if (!sq) continue;
        if (fsq.unrepresentable) { sq.unrepresentable = fsq.unrepresentable; sq.branches = []; sq.repaired = true; continue; }
        for (const fb of fsq.branches || []) {
          const b = sq.branches.find((x) => x.id === fb.id);
          if (!b || (b.engine && b.engine.status === "replayed")) continue;
          Object.assign(b, { scenario: fb.scenario, actions: fb.actions, observe: fb.observe || b.observe,
            assumption: fb.assumption ?? b.assumption, repaired: true, firstEngine: b.engine ? summarizeEngine(b.engine) : null,
            firstPlanProblems: b.planProblems, planProblems: extraCheck.branchProblems.get(`${sq.id}/${b.id}`) || null });
          fixed.add(`${sq.id}/${b.id}`);
        }
      }
      if (fix.extra_cards) record.plan.extra_cards = [...(record.plan.extra_cards || []), ...fix.extra_cards];
      runBranches(record, fixed);
    } else if (planLevelProblems.length) {
      record.planFailure = "invalid_input";
    }
  } else if (planLevelProblems.length) {
    record.planFailure = "invalid_input";
  }
  return finish(record, t0);
}

function summarizeEngine(r) {
  return { status: r.status, reason_code: r.reason_code, failure: r.failure ? { reason: r.failure.reason, step: r.failure.step } : null };
}

function finish(record, t0) {
  record.summary = aggregateQuestion(record);
  record.rendered = renderQuestion(record, record.summary);
  const mine = calls.filter((c) => c.qid === record.qid);
  record.metrics = {
    totalMs: Date.now() - t0,
    modelCalls: mine.map((c) => ({ stage: c.stage, model: c.model, cacheHit: c.cacheHit, bodyHash: c.bodyHash, status: c.status,
      input: c.usage?.input_tokens ?? null, cached: c.usage?.input_tokens_details?.cached_tokens ?? null,
      output: c.usage?.output_tokens ?? null, reasoning: c.usage?.output_tokens_details?.reasoning_tokens ?? null,
      costUsd: c.costUsd, ms: c.ms })),
    plannerCalls: mine.filter((c) => c.stage === "plan" || c.stage === "repair").length,
    engineMs: (record.subQuestions || []).flatMap((sq) => sq.branches || []).reduce((s, b) => s + (b.engineWallMs || 0), 0),
  };
  writeFileSync(join(outDir, "results", `${record.qid}.json`), JSON.stringify(record, null, 1));
  writeFileSync(join(outDir, "results", `${record.qid}.txt`), record.rendered + "\n");
  console.error(`${record.qid}: ${record.summary.status} ${record.summary.reasonCodes.join(",")} [${record.summary.flags.join(",")}]`);
  return record;
}

const selected = questionSet.questions.filter((q) => !only || only.has(q.qid));
for (const q of selected) {
  try { await processQuestion(q); } catch (error) {
    const record = { qid: q.qid, source: q.source, text: q.text, error: { code: error.code || null, message: String(error.message || error) } };
    writeFileSync(join(outDir, "results", `${q.qid}.json`), JSON.stringify(record, null, 1));
    console.error(`${q.qid}: ERROR ${record.error.code || ""} ${record.error.message}`);
    if (error.code === "budget_cap" || error.code === "no_api_key" || error.code === "openai_http_error") break;
  }
}
console.error(`spent this run (ledger, non-cache): $${runner.spentUsd().toFixed(4)}`);
