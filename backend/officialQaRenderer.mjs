export function renderOfficialQaDirect({ match, extracted }) {
  const answerText = extracted.answerText || "官方 Q&A 已直接回答该问题。";
  return {
    answerType: "direct_official",
    answerRoute: "official_qa_exact_match",
    answerSource: "official_qa_direct",
    confirmationLevel: "official_confirmed",
    verdict: extracted.verdict,
    shortAnswer: renderSubjectAwareAnswer(extracted, answerText),
    judgeReasoning: [{
      text: `官方 Q&A 原题或高度一致原题直接给出该处理。`,
      basis: ["official_qa"],
      refs: [match.id],
    }],
    requiredFacts: [],
    assumptions: [],
    possibleCounterCases: [],
    confidence: "high",
    officialQaMatch: summarizeMatch(match, extracted),
  };
}

export function renderOfficialQaNearCase({ match, extracted }) {
  return {
    answerType: "official_case_based",
    answerRoute: "official_qa_near_case_match",
    answerSource: "official_qa_near_case",
    confirmationLevel: "conditional_official_case",
    verdict: extracted.verdict,
    shortAnswer: `根据官方相似案例，若本题的卡片状态、时点与处理结构相同，则：${renderSubjectAwareAnswer(extracted, extracted.answerText)}`,
    judgeReasoning: [{
      text: "该资料是官方相似案例，不是当前问题原题；结论仅在关键事实一致时适用。",
      basis: ["official_qa"],
      refs: [match.id],
    }],
    requiredFacts: ["确认本题与该官方案例的卡片状态、处理时点和发动主体一致"],
    assumptions: ["相似案例中的关键事实与当前问题一致"],
    possibleCounterCases: ["卡片区域、控制者、处理时点或发动手续不同"],
    confidence: "medium",
    officialQaMatch: summarizeMatch(match, extracted),
  };
}

function renderSubjectAwareAnswer(extracted, fallback) {
  if (extracted.questionType !== "who_can_activate") return fallback;
  const labels = {
    self_can_activate: "在该效果可以发动的时点，由自己发动。",
    opponent_can_activate: "在该效果可以发动的时点，由对方发动。",
    current_controller_can_activate: "在该效果可以发动的时点，由当时的控制者发动。",
    controller_can_activate: "在该效果可以发动的时点，由符合条件的控制者发动。",
    cannot_activate: "该玩家不能发动这个效果。",
  };
  return labels[extracted.verdict] || fallback;
}

function summarizeMatch(match, extracted) {
  return {
    evidenceId: match.id,
    matchLevel: match.matchLevel,
    score: match.score,
    questionType: extracted.questionType,
    answerText: extracted.answerText,
    matchedBy: match.matchedBy,
  };
}
