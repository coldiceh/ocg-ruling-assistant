// One engine reproduction for one question: identity -> planner (1 call) -> engine -> at most one
// repair call -> question-level status. Shared by the production answer path and the batch script.
// Card identity always comes from the main answer's own card resolution (no second resolver).
// Only mechanical checks happen here: field shapes, allowed card codes, exact names, budgets.
import { DEFAULT_DECK, DEFAULT_SEED, FILLER_CARDS, PLANNER_INSTRUCTIONS, PROMPT_VERSION, TOOL_CARD_CODES } from "./plannerPrompt.mjs";
import { preparePlannerContext } from "./plannerContext.mjs";
import { STATUS, aggregateQuestion, renderQuestion } from "./aggregate.mjs";

export const DEFAULT_PLANNER = Object.freeze({ model: "gpt-6.1-sol", effort: "low", maxOutput: 1600, maxInput: 16000 });
const REASON_CODES = ["pure_rule", "archetype_level", "tournament_policy", "ruleset_version"];

// The main answer's card resolution -> the identity record used here.
export function identityFromCardResolution(cardResolution = {}, groupMentions = []) {
  const byCid = new Map();
  for (const c of cardResolution.resolvedCards || []) {
    const cid = String(c.id);
    const entry = byCid.get(cid) || { cid, mentionedAs: [], resolutionSources: [] };
    if (c.input && !entry.mentionedAs.includes(c.input)) entry.mentionedAs.push(c.input);
    if (c.resolutionSource) entry.resolutionSources.push(c.resolutionSource);
    byCid.set(cid, entry);
  }
  return {
    resolved: [...byCid.values()],
    unresolved: [...(cardResolution.unresolvedMentions || []), ...(cardResolution.ambiguousMentions || [])]
      .map((m) => ({ input: m.input, reason: m.reason || null })),
    groupMentions: Array.isArray(groupMentions) ? groupMentions : [],
  };
}

// Mechanical defaults the prompt tells the planner to omit (schema tags, seed, LP 8000, no draw,
// the five-card filler deck). Explicit values are kept as written.
export function expandPlanDefaults(scenario, actions) {
  const sc = scenario && typeof scenario === "object" && !Array.isArray(scenario) ? { ...scenario } : scenario;
  if (sc && typeof sc === "object") {
    sc.schema ??= "ocg-repro-scenario/v1";
    if (!Number.isSafeInteger(sc.seed)) sc.seed = DEFAULT_SEED;
    if (Array.isArray(sc.players)) {
      sc.players = sc.players.map((p) => {
        if (!p || typeof p !== "object") return p;
        const q = { ...p };
        q.lp ??= 8000;
        q.draw_count ??= 0;
        if (q.deck === undefined) q.deck = [...DEFAULT_DECK];
        return q;
      });
    }
  }
  const ac = actions && typeof actions === "object" && !Array.isArray(actions) ? { ...actions } : actions;
  if (ac && typeof ac === "object") {
    ac.schema ??= "ocg-repro-actions/v1";
    ac.setup ??= [];
    ac.probes ??= [];
  }
  return { scenario: sc, actions: ac };
}

// Tool cards are the same for every question on one engine build: fetch once per engine and process.
const toolCardCache = new Map();
function toolCardsFor(engine) {
  const key = engine.cacheKey || null;
  const load = () => engine("cards", { codes: [...TOOL_CARD_CODES], with_text: true })
    .then((r) => r.cards.map((c) => ({ code: c.code, name: c.name, types: c.types.join("/"), text: c.text })));
  if (!key) return load();
  if (!toolCardCache.has(key)) toolCardCache.set(key, load().catch((error) => { toolCardCache.delete(key); throw error; }));
  return toolCardCache.get(key);
}

function parseJsonObject(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
  return value;
}

export function collectCodes(scenario, actions) {
  const codes = [];
  for (const p of scenario?.players || []) {
    for (const key of ["hand", "deck", "extra", "extra_faceup", "grave"]) codes.push(...(p[key] || []));
    for (const r of p.removed || []) codes.push(r?.code);
    for (const m of p.mzone || []) { codes.push(m?.code); codes.push(...(m?.overlay || [])); }
    for (const s of p.szone || []) codes.push(s?.code);
    if (p.fzone) codes.push(p.fzone.code);
    for (const z of p.pzone || []) if (z) codes.push(z.code);
  }
  for (const step of actions?.setup || []) {
    if (step?.choose?.card !== undefined) codes.push(step.choose.card);
    for (const c of step?.choose?.cards || []) codes.push(c?.card);
    // A declared card name is a card number too, checked like every other card in the plan.
    if (step?.decision === "announce_card" && step?.choose?.value !== undefined) codes.push(step.choose.value);
  }
  for (const probe of actions?.probes || []) if (probe?.target?.card !== undefined) codes.push(probe.target.card);
  return codes;
}

async function checkPlan(plan, allowedCodes, engine) {
  const problems = [];
  if (!["applicable", "not_applicable"].includes(plan.applicability)) problems.push("applicability 取值无效");
  if (plan.applicability === "not_applicable" && !REASON_CODES.includes(plan.reason_code)) {
    problems.push("not_applicable 需要有效的 reason_code");
  }
  if (plan.applicability === "applicable" && !(Array.isArray(plan.sub_questions) && plan.sub_questions.length)) {
    problems.push("applicable 时 sub_questions 不能为空");
  }
  for (const field of ["reason_code", "archetype_name"]) {
    if (plan[field] === "null") problems.push(`${field} 写成了字符串 "null"，应为 JSON null`);
  }
  const allowed = new Set(allowedCodes);
  const extra = Array.isArray(plan.extra_cards) ? plan.extra_cards : [];
  const extraCodes = extra.map((c) => Number(c?.code)).filter(Number.isSafeInteger);
  const extraInfo = extraCodes.length ? (await engine("cards", { codes: extraCodes })).cards : [];
  for (const [i, c] of extra.entries()) {
    const info = extraInfo.find((x) => x.code === Number(c?.code));
    if (!info?.exists) problems.push(`extra_cards[${i}] 卡号 ${c?.code} 不在卡库`);
    else if (info.name !== c?.name) problems.push(`extra_cards[${i}] 卡号 ${c?.code} 在卡库中名为「${info.name}」，与所写「${c?.name}」不一致`);
    else allowed.add(info.code);
  }
  const branchProblems = new Map();
  for (const sq of plan.sub_questions || []) {
    if (!sq || typeof sq.id !== "string") { problems.push("sub_question 缺少 id"); continue; }
    if (sq.unrepresentable === "null") problems.push(`${sq.id}: unrepresentable 写成了字符串 "null"，应为 JSON null`);
    const branches = Array.isArray(sq.branches) ? sq.branches : [];
    if (!sq.unrepresentable && (branches.length < 1 || branches.length > 2)) problems.push(`${sq.id}: branches 需要 1–2 个`);
    for (const b of branches) {
      if (b?.assumption === "null") problems.push(`${sq.id}/${b?.id}: assumption 写成了字符串 "null"，应为 JSON null`);
      if (!b || typeof b.id !== "string") { problems.push(`${sq.id}: branch 缺少 id`); continue; }
      const bp = [];
      if (!b.scenario || typeof b.scenario !== "object") bp.push("缺少 scenario");
      if (!b.actions || typeof b.actions !== "object") bp.push("缺少 actions");
      for (const code of collectCodes(b.scenario, b.actions)) {
        if (!allowed.has(code)) bp.push(`卡号 ${code} 不在允许的卡号列表中（题目中的卡、填充卡、相关卡、通用工具卡、extra_cards）`);
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
      failure.decision = { kind: d.kind, player: d.player, phase: d.phase, timing: d.timing?.at || undefined, turn: d.turn,
        hint: d.hint?.text || null,
        card: d.card || undefined, desc_text: d.desc_text || undefined,
        options: (d.options || []).slice(0, 40).map((o) => ({ cmd: o.cmd, card: o.card, name: o.name, controller: o.controller,
          from: o.from, seq: o.seq, desc: o.desc, desc_text: o.desc_text, forced: o.forced, position: o.position,
          place: o.place, selected: o.selected })) };
    }
  }
  if (r?.probes) failure.probes = r.probes.map((p) => ({ result: p.result, card_level_only: p.card_level_only || undefined }));
  return failure;
}

function summarizeEngine(r) {
  return { status: r.status, reason_code: r.reason_code, failure: r.failure ? { reason: r.failure.reason, step: r.failure.step } : null };
}

/**
 * @param question     the question text (only ever sent to the planner model, never to the engine)
 * @param identity     identityFromCardResolution(...) of the main answer's resolution
 * @param cardsById    Map CID -> card record of the same data snapshot the main answer used
 * @param cidMap       { CID: passcode }
 * @param engine       async (op, body) -> engine response object for that op
 * @param modelCall    async ({stage, model, instructions, input, reasoningEffort, maxOutputTokens, maxInputTokens})
 *                     -> {status, incomplete, outputText, usage, costUsd, ms, cacheHit}
 * @param clock        () -> ms since the request started (timings are reported on that axis)
 */
export async function runEngineReproduction({ question, identity, cardsById, cidMap, engine, modelCall,
  planner = DEFAULT_PLANNER, includeOfficialQa = false, clock = () => 0, record: base = {} }) {
  const record = { ...base, text: question, promptVersion: PROMPT_VERSION, planner, includeOfficialQa,
    plannerCalled: false, identity, plannerContext: [], modelUsage: [],
    timings: { startedAtMs: clock(), plannerMs: 0, repairMs: 0, engineMs: 0 } };
  const finish = () => {
    record.summary = aggregateQuestion(record);
    record.rendered = renderQuestion(record, record.summary);
    record.timings.finishedAtMs = clock();
    return record;
  };
  // engineMs is wall time spent waiting on the engine (parallel calls in one phase count once).
  const enginePhase = async (fn) => {
    const t0 = clock();
    try { return await fn(); } finally { record.timings.engineMs += clock() - t0; }
  };
  const timedEngine = (op, body) => enginePhase(() => engine(op, body));
  const timedModel = async (opts) => {
    const t0 = clock();
    try {
      const result = await modelCall(opts);
      record.modelUsage.push({ stage: opts.stage, inputTokensEstimate: record.plannerContext.at(-1).inputTokensEstimate,
        inputTokens: result.usage?.input_tokens ?? null, outputTokens: result.usage?.output_tokens ?? null,
        costUsd: Number.isFinite(result.costUsd) ? result.costUsd : null });
      return result;
    } catch (error) {
      if (error && typeof error === "object") error.engineReproRecord = record;
      throw error;
    } finally {
      record.timings[opts.stage === "repair" ? "repairMs" : "plannerMs"] += clock() - t0;
    }
  };
  const modelOpts = (stage, input) => ({ stage, model: planner.model, instructions: PLANNER_INSTRUCTIONS, input,
    reasoningEffort: planner.effort, maxOutputTokens: planner.maxOutput, maxInputTokens: planner.maxInput });

  if (!identity.resolved.length && !identity.unresolved.length) {
    record.preStatus = { status: STATUS.NA, reason: "no_card_mentioned",
      detail: identity.groupMentions.length ? `只提到集合名称：${identity.groupMentions.join("、")}` : "没有抽取到卡名" };
    return finish();
  }
  const unmapped = identity.resolved.filter((c) => !cidMap[c.cid]);
  if (identity.unresolved.length || unmapped.length) {
    const names = [...identity.unresolved.map((m) => `「${m.input}」`),
      ...unmapped.map((c) => `CID ${c.cid}（${cardsById.get(c.cid)?.name || "?"}）无卡号`)];
    record.preStatus = { status: STATUS.FAIL, reason: "identity", detail: `无法确认身份：${names.join("、")}` };
    return finish();
  }

  // planner context: engine facts by passcode + the main answer's card text by CID
  const codes = identity.resolved.map((c) => cidMap[c.cid]);
  const [factsResponse, relatedResponse, toolCards] = await enginePhase(() => Promise.all([
    engine("cards", { codes }), engine("related", { codes }), toolCardsFor(engine)]));
  const facts = factsResponse.cards;
  const cards = identity.resolved.map((c, i) => {
    const raw = cardsById.get(c.cid) || {};
    return { code: codes[i], cid: c.cid, engineName: facts[i].name, engine: facts[i], mentionedAs: c.mentionedAs,
      effectText: raw.effectText || "", pendulumEffectText: raw.pendulumEffectText || "" };
  });
  record.cards = cards.map((c) => ({ code: c.code, cid: c.cid, engineName: c.engineName, mentionedAs: c.mentionedAs }));
  const relatedCards = relatedResponse.related;
  record.relatedRefs = relatedCards.map((e) => ({ ref: e.ref, kind: e.kind, total: e.total ?? e.cards.length, shown: e.cards.length }));
  const allowed = [...codes, ...FILLER_CARDS.map((c) => c.code), ...TOOL_CARD_CODES,
    ...relatedCards.flatMap((e) => e.cards.map((c) => c.code))];
  const contextOptions = { question, cards, relatedCards, toolCards, includeOfficialQa, maxInput: planner.maxInput };
  const planned = preparePlannerContext(contextOptions);
  record.plannerContext.push(planned.context);

  // All branches in parallel (each is an independent duel on the engine service).
  const runBranches = async (onlyKeys = null) => {
    const jobs = [];
    for (const sq of record.subQuestions) {
      if (sq.unrepresentable) continue;
      for (const b of sq.branches) {
        const key = `${sq.id}/${b.id}`;
        if (onlyKeys && !onlyKeys.has(key)) continue;
        if (b.planProblems) { b.engine = null; continue; }
        jobs.push(b);
      }
    }
    if (!jobs.length) return;
    const results = await enginePhase(() => Promise.all(jobs.map((b) =>
      engine("reproduce", { scenario: b.scenario, actions: b.actions }).then((r) => r.result))));
    jobs.forEach((b, i) => { b.engine = results[i]; });
  };
  const adoptPlan = async (plan) => {
    const check = await checkPlan(plan, allowed, timedEngine);
    record.plan = plan;
    record.planProblems = check.problems;
    record.subQuestions = (plan.sub_questions || []).map((sq) => ({ id: sq.id, quoted_span: sq.quoted_span,
      unrepresentable: sq.unrepresentable || null,
      branches: (sq.unrepresentable ? [] : (sq.branches || [])).map((b) => ({ id: b.id, assumption: b.assumption || null,
        observe: b.observe || null, ...expandPlanDefaults(b.scenario, b.actions),
        planProblems: check.branchProblems.get(`${sq.id}/${b.id}`) || null })) }));
    return check;
  };
  const verifyArchetype = async (plan) => {
    if (plan.reason_code === "archetype_level" && plan.archetype_name) {
      record.archetypeVerified = (await timedEngine("setnames", { names: [plan.archetype_name] })).setnames[plan.archetype_name] === true;
    }
  };

  // call 1: plan
  record.plannerCalled = true;
  const r1 = await timedModel(modelOpts("plan", planned.input));
  record.planRaw = [{ call: "plan", status: r1.status, incomplete: r1.incomplete, text: r1.outputText }];
  let plan = null;
  let planLevelProblems = [];
  try { plan = parseJsonObject(r1.outputText); } catch (e) {
    planLevelProblems = [`输出不是完整的 JSON 对象（status=${r1.status}${r1.incomplete ? `, ${JSON.stringify(r1.incomplete)}` : ""}）：${e.message}`];
  }
  if (plan) {
    planLevelProblems = (await adoptPlan(plan)).problems;
    if (!planLevelProblems.length && plan.applicability === "applicable") await runBranches();
  }
  if (plan?.applicability === "not_applicable" && !planLevelProblems.length) {
    await verifyArchetype(plan);
    return finish();
  }

  // call 2: one repair, only if something failed
  const failures = [];
  if (planLevelProblems.length) failures.push({ plan_level: true, problems: planLevelProblems });
  else for (const sq of record.subQuestions) for (const b of sq.branches) if (!b.engine || b.engine.status !== "replayed") failures.push(compactFailure(sq, b));
  if (!failures.length) return finish();
  record.repairCalled = true;
  const repaired = preparePlannerContext({ ...contextOptions,
    repair: { previousPlan: plan || String(r1.outputText || "").slice(0, 4000), failures, planLevel: planLevelProblems.length > 0 } });
  record.plannerContext.push(repaired.context);
  const r2 = await timedModel(modelOpts("repair", repaired.input));
  record.planRaw.push({ call: "repair", status: r2.status, incomplete: r2.incomplete, text: r2.outputText });
  let fix = null;
  try { fix = parseJsonObject(r2.outputText); } catch (e) { record.repairProblems = [`修复输出不是完整的 JSON：${e.message}`]; }
  if (!fix) {
    if (planLevelProblems.length) record.planFailure = "invalid_input";
    return finish();
  }
  if (planLevelProblems.length) {
    const check = await adoptPlan(fix);
    if (check.problems.length) { record.planFailure = "invalid_input"; record.repairProblems = check.problems; record.plan = null; }
    else if (fix.applicability === "applicable") await runBranches();
    else await verifyArchetype(fix);
    return finish();
  }
  const fixed = new Set();
  const extraCheck = await checkPlan({ ...fix, applicability: "applicable", sub_questions: fix.sub_questions || [],
    extra_cards: [...(record.plan.extra_cards || []), ...(fix.extra_cards || [])] }, allowed, timedEngine);
  for (const fsq of fix.sub_questions || []) {
    const sq = record.subQuestions.find((x) => x.id === fsq.id);
    if (!sq) continue;
    if (fsq.unrepresentable && fsq.unrepresentable !== "null") { sq.unrepresentable = fsq.unrepresentable; sq.branches = []; sq.repaired = true; continue; }
    for (const fb of fsq.branches || []) {
      const b = sq.branches.find((x) => x.id === fb.id);
      if (!b || (b.engine && b.engine.status === "replayed")) continue;
      Object.assign(b, { ...expandPlanDefaults(fb.scenario, fb.actions), observe: fb.observe || b.observe,
        assumption: fb.assumption ?? b.assumption, repaired: true, firstEngine: b.engine ? summarizeEngine(b.engine) : null,
        firstPlanProblems: b.planProblems, planProblems: extraCheck.branchProblems.get(`${sq.id}/${b.id}`) || null });
      fixed.add(`${sq.id}/${b.id}`);
    }
  }
  if (fix.extra_cards) record.plan.extra_cards = [...(record.plan.extra_cards || []), ...fix.extra_cards];
  await runBranches(fixed);
  return finish();
}
