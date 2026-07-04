import { RULING_DRAFT_ANSWER_TYPES, RULING_DRAFT_CLAIM_TYPES } from "./rulingDraftSchema.mjs";

const INPUT_ARRAY_FIELDS = [
  "resolvedCards",
  "cardTexts",
  "officialEvidence",
  "relatedEvidence",
  "similarCases",
  "knownBlockers",
  "templates",
  "missingInfo",
];

export function buildRulingDraftPrompt(input = {}) {
  const context = normalizePromptInput(input);
  const example = {
    answerType: "unknown",
    mainConclusion: "根据现有信息可以提出倾向分析，但关键条件仍需验证。",
    confidenceSelfEstimate: "low",
    reasoningSteps: [{ step: 1, text: "识别需要验证的规则条件。", dependsOn: ["claim-1"] }],
    claims: [{
      id: "claim-1",
      type: "condition",
      subject: "待分析对象",
      predicate: "可能满足",
      object: "待验证条件",
      timing: "待确认时点",
      source: "llm_draft",
      requiresValidation: true,
    }],
    usedEvidenceIds: [],
    missingFacts: ["仍需确认的关键事实"],
    assumptions: [],
    riskFlags: ["缺少直接验证"],
  };

  return [
    "你要生成的是 rulingDraft（LLM 裁定分析草案），不是最终裁定。",
    "只输出一个合法 JSON 对象，不要 Markdown、代码围栏或 JSON 之外的说明。",
    `answerType 必须从以下枚举选择：${RULING_DRAFT_ANSWER_TYPES.join(", ")}。`,
    `claim.type 必须从以下枚举选择：${RULING_DRAFT_CLAIM_TYPES.join(", ")}。`,
    "不得输出 official_confirmed，也不得输出 finalVerdict、finalLevel、confirmationLevel、safetyLevel、officialConfirmed、verdict、answerSource、evidenceLevel 等最终决策字段。",
    "confidenceSelfEstimate 只是模型自评，不代表最终等级，也不能决定最终输出。",
    "所有结论性断言必须拆分为 claims；每个 claim 的 source 必须是 llm_draft，requiresValidation 必须是 true。",
    "不得自造 evidenceIds。usedEvidenceIds 只能引用输入资料中明确提供的 id；没有可用 id 时必须保持为空数组。",
    "不确定之处必须写入 missingFacts、assumptions 或 riskFlags。信息不足时可以给出倾向分析，但必须明确记录风险。",
    "以下是仅用于说明 JSON 结构的通用示例，不代表任何具体裁定：",
    JSON.stringify(example, null, 2),
    "以下是本次分析上下文。只能使用其中提供的事实与 evidence id：",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

function normalizePromptInput(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const normalized = { userQuery: typeof source.userQuery === "string" ? source.userQuery : "" };
  for (const field of INPUT_ARRAY_FIELDS) normalized[field] = Array.isArray(source[field]) ? source[field] : [];
  return normalized;
}
