// Conclusion sentence of the engine-reproduction section (2026-10-30).
//
// One cheap model call per reproduced question (GPT-6 Luna, reasoning low) writes one or two Chinese
// sentences that say what the engine did about the thing the question asks, using only the engine
// observations the short section lists (concise.mjs digest: probe results, the full state of the cards
// at the moment the engine stopped, life points, cards that left the field). The question decides what
// is reported; no code here picks fields. The model also returns which observations it used; the
// section lists exactly those observations, verbatim, under the sentence so readers can check it.
//
// Nothing here inspects the sentence. Only the response shape is checked, fail closed: a completed
// response, a JSON object, a non-empty sentence and at least one cited observation, every cited id one
// of the listed ones. Anything else (or the switch ENGINE_REPRO_CONCLUSION=off, a budget refusal, a
// timeout, an HTTP error) leaves the section on the mechanical list of all observations.
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

export const CONCLUSION_INSTRUCTIONS = [
  "你把 ygopro 引擎（MyCard 版核心）对一道游戏王 OCG 裁定题的运行结果，用一两句中文告诉玩家。你不回答裁定，只转述引擎的结果。",
  "",
  "## 输入",
  "- 题目原文。",
  "- 计划要看的：每个子问题在题面的原话、计划写的看点、要看结果的卡、分支的假设。",
  "- 引擎观察值：每条前面有编号（如 [o1]），是引擎实际运行给出的结果；“未取得”表示引擎没有返回这一项。",
  "- 没能复现的部分、计划补充的假设、局面：只是背景，不是观察值。",
  "",
  "## 要求",
  "1. 直接回答题目问的那件事在引擎里是什么结果：题目问哪一项就说哪一项（问能不能发动就说能不能发动，问数值、属性、种族、等级就说那个值，问卡去了哪里就说在哪里）。一两句，不超过 120 字。",
  "2. 只用引擎观察值里写出来的值，卡名和数值照抄；不补充、不换算、不推测观察值里没有的内容；不用游戏规则推断引擎“本该”怎样；不评价任何回答或官方裁定的对错。",
  "3. 题目问的那一项在观察值里写着“未取得”或根本没有时，直说引擎没有给出这一项，不要猜；题目问的部分没能复现时，说那部分没能复现。",
  "4. 时点用玩家的说法（“我方主要阶段1”“对方回合的伤害计算前”）。不要写“日志、回放、决策、窗口、探测、分支、setup”和步骤编号，也不要在句子里写观察值编号。",
  "5. used 列出句子用到的观察值编号，至少一条，只能是输入里出现的编号。",
  "",
  "## 输出",
  "只输出一个单行 JSON 对象：{\"conclusion\":\"一两句中文\",\"used\":[\"o1\"]}。不要 markdown，不要解释。",
].join("\n");

export const CONCLUSION_PROMPT_VERSION = createHash("sha256").update(CONCLUSION_INSTRUCTIONS).digest("hex").slice(0, 12);

const SIDE = ["我方", "对方"];

/** The model input: the question, what the plan looks at, the numbered observations and the background. */
export function buildConclusionInput({ question, digest }) {
  const parts = ["## 题目（原文）", String(question || "").trim(), "", "## 计划要看的"];
  const subQuestions = Array.isArray(digest?.subQuestions) ? digest.subQuestions : [];
  subQuestions.forEach((sq, index) => {
    const head = `子问题 ${index + 1}${sq.quotedSpan ? `「${sq.quotedSpan}」` : ""}`;
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
      parts.push(`- ${head}${facts.length ? `：${facts.join("；")}` : ""}`);
    }
  });
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

/** Shape check only (see the header): { ok, text, used: [{ id, text }] } or { ok: false, error }. */
export function parseConclusionOutput(outputText, observations = []) {
  let parsed;
  try { parsed = JSON.parse(String(outputText || "")); } catch { return { ok: false, error: "output_not_json" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "output_not_object" };
  const text = typeof parsed.conclusion === "string" ? parsed.conclusion.replace(/\s+/gu, " ").trim() : "";
  if (!text) return { ok: false, error: "conclusion_missing" };
  if (!Array.isArray(parsed.used) || !parsed.used.length) return { ok: false, error: "used_missing" };
  const known = new Set(observations.map((item) => item.id));
  const cited = new Set();
  for (const raw of parsed.used) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!known.has(id)) return { ok: false, error: `unknown_observation:${id || "(empty)"}`.slice(0, 80) };
    cited.add(id);
  }
  // listed in the order the section numbers them, each once, with the text the model was given
  return { ok: true, text, used: observations.filter((item) => cited.has(item.id)).map(({ id, text: observed }) => ({ id, text: observed })) };
}

const failureCode = (error) => String(error?.code || error?.name || error?.message || error || "unknown").slice(0, 120);
const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/**
 * Write the conclusion for one reproduction digest. Never throws. Result:
 *   { status: "done", text, used: [{ id, text }], ms, costUsd, usage, ... }
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
  const parsed = parseConclusionOutput(response.outputText, observations);
  if (!parsed.ok) {
    return { ...base, ...measured, ...spent, status: "failed", error: parsed.error,
      outputText: String(response.outputText || "").slice(0, RAW_OUTPUT_KEPT_CHARS) };
  }
  return { ...base, ...measured, ...spent, status: "done", text: parsed.text, used: parsed.used };
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
