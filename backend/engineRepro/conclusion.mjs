// Conclusion of the engine-reproduction section (2026-10-30; one sentence per sub-question since 2026-11-08).
//
// One cheap model call per reproduced question (GPT-6 Luna, reasoning low) writes, for every sub-question of
// the plan (the planner's own split, sub_questions), one Chinese sentence: what the engine did about the thing
// that sub-question asks ("引擎里的结果是……", verdict "observed"), or which observation the engine record lacks
// to tell ("引擎记录里看不出：缺少……的观察", verdict "not_observable"). It uses only the engine observations the
// short section lists (concise.mjs digest: probe results, the cards a marked selection offered, the full state
// of the cards at the moment the engine stopped, life points, cards that left the field). The question decides
// what is reported; no code here picks fields. Each sentence comes with the observations it used; the section
// lists exactly those observations, verbatim, under the sentences so readers can check them.
//
// Nothing here inspects a sentence. Only the response shape is checked, fail closed: a completed response, a
// JSON object whose perQuestion has exactly one entry for every sub-question id given, each with a known
// verdict, a non-empty sentence and cited observation ids that are all listed ones (at least one for
// "observed"). Anything else (or the switch ENGINE_REPRO_CONCLUSION=off, a budget refusal, a timeout, an HTTP
// error) leaves the section on the mechanical list of all observations.
//
// It runs inside the reproduction (reproduce.mjs, after the engine results and before the record is
// stored) through the reproduction's own model call (production: modelCalls.mjs createOfficialModelCall,
// the official OpenAI API and the reproduction's daily budget bucket), so its time and cost are recorded
// with the engine section (timings.conclusionMs, modelUsage stage "conclusion"), never with the main
// answer. It is called only for 已复现 / 部分复现 with at least one real observation.
import { createHash } from "node:crypto";
import { digestAssumptions, digestBoards } from "./concise.mjs";
import { estimateTokens } from "./modelCalls.mjs";

export const CONCLUSION_MODEL = Object.freeze({ model: "gpt-6-luna", effort: "low", maxOutput: 2000, timeoutMs: 20_000 });
const MAX_OBSERVATIONS = 40;
const RAW_OUTPUT_KEPT_CHARS = 600;

/** On unless ENGINE_REPRO_CONCLUSION is 0 / false / no / off (the section must be enabled too). */
export function conclusionEnabled(env = {}) {
  return !/^(?:0|false|no|off)$/iu.test(String(env.ENGINE_REPRO_CONCLUSION || "").trim());
}

export function conclusionConfigFromEnv(env = {}) {
  return { ...CONCLUSION_MODEL, enabled: conclusionEnabled(env) };
}

export const CONCLUSION_VERDICTS = Object.freeze(["observed", "not_observable"]);

export const CONCLUSION_INSTRUCTIONS = [
  "你把 ygopro 引擎（MyCard 版核心）对一道游戏王 OCG 裁定题的运行结果，按小问逐个告诉玩家：每个小问一句中文。你不回答裁定，只转述引擎的结果。",
  "",
  "## 输入",
  "- 题目原文。",
  "- 计划要看的：每个子问题在题面的原话、计划写的看点、要看结果的卡、选卡时放的对照候选、分支的假设。",
  "- 小问：计划把题目拆成的小问，每个前面有编号（如 [q1]）；每个小问都要写一句。",
  "- 引擎观察值：每条前面有编号（如 [o1]），是引擎实际运行给出的结果；“未取得”表示引擎没有返回这一项。",
  "- 没能复现的部分、计划补充的假设、局面：只是背景，不是观察值。",
  "",
  "## 要求",
  "1. 每个小问单独写一句，不超过 120 字，只回答这个小问问的那件事在引擎里是什么结果：题目问哪一项就说哪一项（问能不能发动就说能不能发动，问还能不能特殊召唤就说召唤出来了没有，问数值、属性、种族、等级就说那个值，问卡去了哪里就说在哪里，问能选哪些卡就说哪些可选、哪些不可选）。",
  "2. 观察值里有能直接回答这个小问的事实，就必须用它作答：verdict 写 \"observed\"，句子写成“引擎里的结果是……”。例如问效果处理后还能不能把怪兽特殊召唤，而观察值写着处理后那只怪兽在场上，这条就是答案。选卡类的小问照观察值说可选和不可选的卡；对照候选属于条件的哪一侧是计划的说明，可以用来说明可选的卡落在哪一侧，但不是引擎结果。",
  "3. 观察值里确实没有能回答这个小问的事实时，verdict 写 \"not_observable\"，句子写成“引擎记录里看不出：缺少……的观察”，写明缺的是哪一种观察（例如没有记录选卡时可选的卡、要看的那一项未取得、这一问没能复现）。不要写“引擎没有给出结果”这类笼统的话。",
  "4. 只用引擎观察值里写出来的值，卡名和数值照抄；不补充、不换算、不推测观察值里没有的内容；不用游戏规则推断引擎“本该”怎样；不评价任何回答或官方裁定的对错。",
  "5. 时点用玩家的说法（“我方主要阶段1”“对方回合的伤害计算前”“效果处理时”）。不要写“日志、回放、决策、窗口、探测、分支、setup”和步骤编号，也不要在句子里写观察值或小问的编号。",
  "6. used 列出句子用到的观察值编号，只能是输入里出现的编号：observed 至少一条；not_observable 没有可引的就写空数组。",
  "",
  "## 输出",
  "只输出一个单行 JSON 对象：{\"perQuestion\":[{\"id\":\"q1\",\"verdict\":\"observed\",\"sentence\":\"一句中文\",\"used\":[\"o1\"]}]}。每个小问恰好一项，按小问编号的顺序。不要 markdown，不要解释。",
].join("\n");

export const CONCLUSION_PROMPT_VERSION = createHash("sha256").update(CONCLUSION_INSTRUCTIONS).digest("hex").slice(0, 12);

const SIDE = ["我方", "对方"];

/**
 * The sub-questions a conclusion answers, in plan order: { id: "q1", index: 0, head: "子问题 1「…」", unrepresentable }.
 * The ids are the conclusion's own (q1, q2, … by position), so they are unique whatever the planner named them.
 */
export function conclusionQuestions(digest) {
  return (Array.isArray(digest?.subQuestions) ? digest.subQuestions : []).map((sq, index) => ({ id: `q${index + 1}`, index,
    head: `子问题 ${index + 1}${sq?.quotedSpan ? `「${sq.quotedSpan}」` : ""}`, unrepresentable: Boolean(sq?.unrepresentable) }));
}

/** The model input: the question, what the plan looks at, the sub-question ids, the numbered observations and the background. */
export function buildConclusionInput({ question, digest }) {
  const parts = ["## 题目（原文）", String(question || "").trim(), "", "## 计划要看的"];
  const subQuestions = Array.isArray(digest?.subQuestions) ? digest.subQuestions : [];
  const questions = conclusionQuestions(digest);
  subQuestions.forEach((sq, index) => {
    const head = questions[index].head;
    if (sq.unrepresentable) { parts.push(`- ${head}：没能复现（见“没能复现的部分”）`); return; }
    const branches = Array.isArray(sq.branches) ? sq.branches : [];
    for (const branch of branches) {
      const facts = [];
      if (branches.length > 1) facts.push(branch.assumption ? `假设「${branch.assumption}」的分支` : "无额外假设的分支");
      else if (branch.assumption) facts.push(`假设：${branch.assumption}`);
      if (branch.observe) facts.push(`看点：${branch.observe}`);
      if (branch.resultCards?.length) {
        facts.push(`要看结果的卡：${branch.resultCards.map((card) => `${SIDE[card.controller] ? `${SIDE[card.controller]}的` : ""}「${card.name}」`).join("、")}`);
      }
      const candidates = candidatesText(branch.selectCandidates);
      if (candidates) facts.push(`选卡时放的对照候选：${candidates}`);
      parts.push(`- ${head}${facts.length ? `：${facts.join("；")}` : ""}`);
    }
  });
  parts.push("", "## 小问（每个小问写一句；id 用方括号里的编号）",
    ...questions.map((item) => `- [${item.id}] ${item.head}${item.unrepresentable ? "（没能复现）" : ""}`));
  const observations = (Array.isArray(digest?.observations) ? digest.observations : []).slice(0, MAX_OBSERVATIONS);
  parts.push("", "## 引擎观察值（只能引用这些；“未取得”表示引擎没有返回这一项）",
    ...observations.map((item) => `[${item.id}] ${item.text}`));
  const background = (title, lines) => { if (lines.length) parts.push("", title, ...lines); };
  background("## 没能复现的部分（背景，不是观察值）", (Array.isArray(digest?.notReproduced) ? digest.notReproduced : [])
    .filter((item) => !item.observedBranch).map((item) => `- ${item.label ? `${item.label}：` : ""}${item.text}`));
  background("## 计划补充的假设（背景，不是观察值）", digestAssumptions(digest).map((text) => `- ${text}`));
  background("## 局面（计划搭的初始局面，背景，不是观察值）", digestBoards(digest)
    .map((board) => `- ${board.label ? `${board.label}：` : ""}${board.text}`));
  parts.push("", "按要求输出 JSON。");
  return parts.join("\n");
}

// "满足条件的「A」「B」，不满足条件的「C」": the candidates a branch put on both sides of the question's condition.
function candidatesText(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const side = (value, words) => {
    const names = [...new Set(list.filter((item) => item?.side === value).map((item) => `「${item.name || "卡"}」`))];
    return names.length ? `${words}${names.join("")}` : "";
  };
  return [side("meets", "满足条件的"), side("fails", "不满足条件的")].filter(Boolean).join("，");
}

/**
 * Shape check only (see the header). `questions` are conclusionQuestions(digest). Result:
 *   { ok: true, perQuestion: [{ id, index, verdict, sentence, used: [{ id, text }] }], used: [{ id, text }], text }
 *   { ok: false, error }
 * perQuestion follows the sub-question order; `used` is every cited observation once, in the section's order,
 * with the text the model was given; `text` joins the sentences (logs, batch reports).
 */
export function parseConclusionOutput(outputText, observations = [], questions = []) {
  let parsed;
  try { parsed = JSON.parse(String(outputText || "")); } catch { return { ok: false, error: "output_not_json" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "output_not_object" };
  if (!Array.isArray(parsed.perQuestion) || !parsed.perQuestion.length) return { ok: false, error: "per_question_missing" };
  const known = new Set(observations.map((item) => item.id));
  const byId = new Map(questions.map((item) => [item.id, item]));
  const answered = new Map();
  for (const entry of parsed.perQuestion) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, error: "entry_not_object" };
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!byId.has(id)) return { ok: false, error: `unknown_question:${id || "(empty)"}`.slice(0, 80) };
    if (answered.has(id)) return { ok: false, error: `duplicate_question:${id}` };
    if (!CONCLUSION_VERDICTS.includes(entry.verdict)) return { ok: false, error: `verdict_invalid:${id}` };
    const sentence = typeof entry.sentence === "string" ? entry.sentence.replace(/\s+/gu, " ").trim() : "";
    if (!sentence) return { ok: false, error: `sentence_missing:${id}` };
    if (!Array.isArray(entry.used)) return { ok: false, error: `used_missing:${id}` };
    const cited = new Set();
    for (const raw of entry.used) {
      const observation = typeof raw === "string" ? raw.trim() : "";
      if (!known.has(observation)) return { ok: false, error: `unknown_observation:${observation || "(empty)"}`.slice(0, 80) };
      cited.add(observation);
    }
    if (entry.verdict === "observed" && !cited.size) return { ok: false, error: `used_missing:${id}` };
    answered.set(id, { id, index: byId.get(id).index, verdict: entry.verdict, sentence,
      used: observations.filter((item) => cited.has(item.id)).map(({ id: observed, text }) => ({ id: observed, text })) });
  }
  const missing = questions.find((item) => !answered.has(item.id));
  if (missing) return { ok: false, error: `question_missing:${missing.id}` };
  const perQuestion = questions.map((item) => answered.get(item.id));
  const cited = new Set(perQuestion.flatMap((item) => item.used.map((used) => used.id)));
  return { ok: true, perQuestion, text: perQuestion.map((item) => item.sentence).join(" "),
    // listed in the order the section numbers them, each once, with the text the model was given
    used: observations.filter((item) => cited.has(item.id)).map(({ id, text }) => ({ id, text })) };
}

const failureCode = (error) => String(error?.code || error?.name || error?.message || error || "unknown").slice(0, 120);
const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/**
 * Write the conclusion for one reproduction digest. Never throws. Result:
 *   { status: "done", perQuestion: [{ id, index, verdict, sentence, used }], text, used: [{ id, text }], ms, costUsd, usage, ... }
 *   { status: "skipped", reason }            no call was made
 *   { status: "failed", error, ... }          a call was attempted (or refused by the budget)
 * `responded` is true when the provider returned a response (its usage and cost are then recorded).
 */
export async function writeConclusion({ question, digest, modelCall, config = CONCLUSION_MODEL, now = Date.now }) {
  const base = { promptVersion: CONCLUSION_PROMPT_VERSION, model: config.model, effort: config.effort };
  if (config.enabled === false) return { ...base, status: "skipped", reason: "disabled" };
  const observations = (Array.isArray(digest?.observations) ? digest.observations : []).slice(0, MAX_OBSERVATIONS);
  if (!observations.some((item) => !item.empty)) return { ...base, status: "skipped", reason: "no_observations" };
  if (typeof modelCall !== "function") return { ...base, status: "skipped", reason: "no_model_call" };
  const questions = conclusionQuestions(digest);
  if (!questions.length) return { ...base, status: "skipped", reason: "no_sub_questions" };
  const input = buildConclusionInput({ question, digest: { ...digest, observations } });
  const measured = { inputTokensEstimate: estimateTokens(`${CONCLUSION_INSTRUCTIONS}\n${input}`), observationCount: observations.length };
  const startedAt = now();
  let response;
  try {
    response = await modelCall({ stage: "conclusion", model: config.model, instructions: CONCLUSION_INSTRUCTIONS, input,
      reasoningEffort: config.effort, maxOutputTokens: config.maxOutput, timeoutMs: config.timeoutMs });
  } catch (error) {
    return { ...base, ...measured, status: "failed", error: failureCode(error), ms: now() - startedAt };
  }
  const usage = response?.usage || null;
  const spent = { responded: true, ms: now() - startedAt, costUsd: finiteOrNull(response?.costUsd),
    usage: usage ? { inputTokens: finiteOrNull(usage.input_tokens), outputTokens: finiteOrNull(usage.output_tokens) } : null };
  if (response?.status !== "completed") {
    return { ...base, ...measured, ...spent, status: "failed", error: `response_${response?.status || "missing_status"}` };
  }
  const parsed = parseConclusionOutput(response.outputText, observations, questions);
  if (!parsed.ok) {
    return { ...base, ...measured, ...spent, status: "failed", error: parsed.error,
      outputText: String(response.outputText || "").slice(0, RAW_OUTPUT_KEPT_CHARS) };
  }
  return { ...base, ...measured, ...spent, status: "done", perQuestion: parsed.perQuestion, text: parsed.text, used: parsed.used };
}

/** Compact, response-safe view of a conclusion result (no prompt text). */
export function conclusionSummary(conclusion) {
  if (!conclusion || typeof conclusion !== "object") return null;
  return {
    status: typeof conclusion.status === "string" ? conclusion.status : null,
    ...(conclusion.reason ? { reason: String(conclusion.reason) } : {}),
    ...(conclusion.error ? { error: String(conclusion.error) } : {}),
    promptVersion: conclusion.promptVersion || null, model: conclusion.model || null, effort: conclusion.effort || null,
    used: Array.isArray(conclusion.used) ? conclusion.used.map((item) => item?.id).filter(Boolean) : [],
    ms: finiteOrNull(conclusion.ms),
    costUsd: finiteOrNull(conclusion.costUsd),
    inputTokens: finiteOrNull(conclusion.usage?.inputTokens),
    outputTokens: finiteOrNull(conclusion.usage?.outputTokens),
  };
}
