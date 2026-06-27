import { runWithinLatencyBudget } from "./latencyBudget.mjs";

const answerTypes = new Set(["direct_official", "rule_judgment", "needs_clarification", "cannot_answer_safely"]);
const verdicts = new Set([
  "yes", "no", "can_activate", "cannot_activate", "applies", "does_not_apply", "destroyed", "not_destroyed",
  "damage_occurs", "damage_does_not_occur", "numeric_result", "unknown",
]);
const bases = new Set(["card_text", "official_qa", "faq_analogy", "rule_snippet"]);

export async function runJudgeAnswerModel({ contextPack, mode = "duel", budget, env = globalThis.process?.env || {}, modelInvoker } = {}) {
  const input = buildJudgeModelInput(contextPack, mode);
  const raw = modelInvoker
    ? await runWithinLatencyBudget(() => modelInvoker(input), budget, "judge_model")
    : await callConfiguredModel(input, budget, env);
  if (!raw) return null;
  return normalizeJudgeModelAnswer(typeof raw === "string" ? parseJson(raw) : raw, mode);
}

export function buildJudgeModelInput(contextPack, mode = "duel") {
  const rejected = (contextPack.issueFrames?.rejectedIssueFrames || []).map((item) => item.id);
  return {
    instructions: [
      "你是 OCG 对局规则处理助手，只能根据下面的上下文包作答。",
      "输出单个 JSON 对象，不要 Markdown，不要引用未提供的案例。",
      "direct_official 仅在 officialQaCandidates/faqCandidates 明确直接回答当前场景时使用，否则只能 rule_judgment 或 needs_clarification。",
      "每条 judgeReasoning 必须有 basis 和有效 refs；最多 3 条。",
      "带 staleRisk 或 supersededBy 的来源不能作为当前规则的强依据；涉及规则变更时必须引用当前有效来源。",
      "回答必须覆盖全部 primaryIssueFrames，并至少提到一张当前核心卡。",
      `禁止引入这些未触发争点：${rejected.join("、") || "无"}。`,
      mode === "duel" ? "shortAnswer 不超过 120 个中文字符。" : "shortAnswer 保持简洁，完整分析放 judgeReasoning。",
    ],
    schema: {
      answerType: [...answerTypes],
      verdict: [...verdicts],
      shortAnswer: "string",
      judgeReasoning: [{ text: "string", basis: [...bases], refs: ["context ref id"] }],
      assumptions: ["string"],
      requiredFacts: ["string"],
      possibleCounterCases: ["string"],
      confidence: ["high", "medium", "low"],
    },
    context: compactContextPack(contextPack),
  };
}

export function normalizeJudgeModelAnswer(value, mode = "duel") {
  const answer = value && typeof value === "object" ? value : {};
  return {
    answerType: answerTypes.has(answer.answerType) ? answer.answerType : "cannot_answer_safely",
    verdict: verdicts.has(answer.verdict) ? answer.verdict : "unknown",
    shortAnswer: trim(String(answer.shortAnswer || ""), mode === "duel" ? 120 : 360),
    judgeReasoning: (Array.isArray(answer.judgeReasoning) ? answer.judgeReasoning : []).slice(0, 3).map((item) => ({
      text: trim(String(item?.text || ""), mode === "duel" ? 180 : 500),
      basis: [...new Set((Array.isArray(item?.basis) ? item.basis : []).filter((basis) => bases.has(basis)))],
      refs: [...new Set((Array.isArray(item?.refs) ? item.refs : []).map(String).filter(Boolean))],
    })).filter((item) => item.text),
    assumptions: stringList(answer.assumptions, 8),
    requiredFacts: stringList(answer.requiredFacts, 8),
    possibleCounterCases: stringList(answer.possibleCounterCases, 6),
    confidence: ["high", "medium", "low"].includes(answer.confidence) ? answer.confidence : "low",
  };
}

async function callConfiguredModel(input, budget, env) {
  const provider = String(env.MODEL_PROVIDER || "").toLowerCase();
  if ((provider === "gemini" || (!provider && env.GEMINI_API_KEY)) && env.GEMINI_API_KEY) {
    return callGemini(input, budget, env);
  }
  if ((provider === "openai" || !provider) && env.OPENAI_API_KEY && env.OPENAI_MODEL) {
    return callOpenAi(input, budget, env);
  }
  return null;
}

async function callOpenAi(input, budget, env) {
  const response = await runWithinLatencyBudget(() => fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_JUDGE_MODEL || env.OPENAI_MODEL,
      input: [
        { role: "system", content: [{ type: "input_text", text: input.instructions.join("\n") }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify({ schema: input.schema, context: input.context }) }] },
      ],
      max_output_tokens: Number(env.OPENAI_JUDGE_TOKENS || 1400),
    }),
  }), budget, "openai_judge_request");
  if (!response.ok) throw new Error(`OpenAI judge ${response.status}`);
  const payload = await response.json();
  const text = payload.output_text || payload.output?.flatMap((item) => item.content || []).find((item) => item.text)?.text;
  return text ? parseJson(text) : null;
}

async function callGemini(input, budget, env) {
  const model = env.GEMINI_JUDGE_MODEL || String(env.GEMINI_MODELS || env.GEMINI_MODEL || "").split(",")[0].trim();
  if (!model) return null;
  const path = model.startsWith("models/") ? model : `models/${model}`;
  const response = await runWithinLatencyBudget(() => fetch(`https://generativelanguage.googleapis.com/v1beta/${path}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: input.instructions.join("\n") }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify({ schema: input.schema, context: input.context }) }] }],
      generationConfig: { temperature: 0, maxOutputTokens: Number(env.GEMINI_JUDGE_TOKENS || 1800), responseMimeType: "application/json" },
    }),
  }), budget, "gemini_judge_request");
  if (!response.ok) throw new Error(`Gemini judge ${response.status}`);
  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((item) => item.text || "").join("");
  return text ? parseJson(text) : null;
}

function compactContextPack(pack = {}) {
  const compactEvidence = (items) => (items || []).map((item) => ({ id: item.id, source: item.source, title: item.title, cardIds: item.cardIds, text: item.text, matchedBy: item.matchedBy, metadata: item.metadata }));
  return {
    question: pack.question,
    normalizedScenario: pack.normalizedScenario,
    resolvedCards: pack.resolvedCards,
    unresolvedCards: pack.unresolvedCards,
    relevantCardSections: pack.relevantCardSections,
    primaryIssueFrames: pack.issueFrames?.primaryIssueFrames || [],
    secondaryIssueFrames: pack.issueFrames?.secondaryIssueFrames || [],
    officialQaCandidates: compactEvidence(pack.officialQaCandidates),
    faqCandidates: compactEvidence(pack.faqCandidates),
    ruleSnippets: compactEvidence(pack.ruleSnippets),
    knownAnalogies: compactEvidence(pack.knownAnalogies),
    counterEvidenceCandidates: compactEvidence(pack.counterEvidenceCandidates),
    staleness: pack.staleness ? {
      staleRisk: pack.staleness.staleRisk,
      matchedRuleChanges: pack.staleness.matchedRuleChanges,
      staleEvidenceIds: pack.staleness.staleEvidenceIds,
      currentEvidenceIds: pack.staleness.currentEvidenceIds,
    } : null,
  };
}

function parseJson(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Judge model returned invalid JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function stringList(value, max) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => trim(String(item || ""), 260)).filter(Boolean))].slice(0, max);
}

function trim(value, max) {
  return value.length <= max ? value : value.slice(0, max);
}
