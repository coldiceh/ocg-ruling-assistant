export function evaluateCardIdentityGate({ resolvedCards = [], unresolvedCards = [] } = {}) {
  const uncertainCards = (unresolvedCards || []).map((item) => ({
    rawText: item.rawText || item.unresolvedCardName || item.name || "unknown",
    candidates: (item.candidates || item.candidateCards || []).map(normalizeCandidate),
    reason: item.reason || inferReason(item),
  }));
  uncertainCards.push(...(resolvedCards || [])
    .filter((card) => card?.confidence === "low" || card?.identityConfidence === "low" || card?.resolution === "approximate")
    .map((card) => ({
      rawText: card.rawText || card.matched || card.name || "unknown",
      candidates: [normalizeCandidate(card)],
      reason: "ambiguous_or_low_confidence",
    })));
  const duplicateResolutions = findDuplicateRawResolutions(resolvedCards);
  uncertainCards.push(...duplicateResolutions);
  const unique = dedupeUncertain(uncertainCards);
  return {
    status: unique.length ? "needs_card_confirmation" : "resolved",
    passed: unique.length === 0,
    uncertainCards: unique,
    warnings: unique.map((item) => `card_identity_uncertain:${item.rawText}`),
  };
}

export function buildCardIdentityGateAnswer(gate, { answerType = "needs_clarification" } = {}) {
  const names = (gate?.uncertainCards || []).map((item) => item.rawText).join("、");
  return {
    answerType,
    status: "needs_card_confirmation",
    verdict: "needs_card_confirmation",
    evidenceGrade: "needs_card_confirmation",
    shortAnswer: names ? `请先确认卡名：${names}。卡片身份未唯一确定，裁定流程已停止。` : "请先确认卡名后再进行裁定。",
    userFacingAnswer: names ? `请确认“${names}”对应的正式卡名。` : "请确认相关卡的正式卡名。",
    uncertainCards: gate?.uncertainCards || [],
    blockers: (gate?.uncertainCards || []).map((item) => ({
      code: "activation.card_identity_uncertain",
      source: item.rawText,
      explanation: "卡片身份尚未通过数据库 exact/alias 唯一匹配。",
    })),
    ruleTrace: [{ step: "resolve_card_identities", result: "blocked", blocker: "activation.card_identity_uncertain" }],
    warnings: gate?.warnings || [],
    judgeReasoning: [],
    requiredFacts: ["相关卡片的正式卡名或数据库 ID"],
    assumptions: [],
    possibleCounterCases: [],
    confidence: "low",
  };
}

function normalizeCandidate(candidate) {
  if (typeof candidate === "string") return { name: candidate };
  return {
    name: candidate?.name || candidate?.cnName || candidate?.jaName || candidate?.enName || "unknown",
    cardId: String(candidate?.cardId || candidate?.id || ""),
    score: Number.isFinite(candidate?.score) ? candidate.score : undefined,
    reason: candidate?.reason || undefined,
  };
}

function inferReason(item) {
  const candidates = item?.candidates || item?.candidateCards || [];
  return candidates.length > 1 ? "ambiguous_or_low_confidence" : "no_exact_or_alias_match";
}

function findDuplicateRawResolutions(cards) {
  const byRaw = new Map();
  for (const card of cards || []) {
    const raw = card.matched || card.rawText;
    if (!raw) continue;
    const key = normalize(raw);
    const bucket = byRaw.get(key) || [];
    bucket.push(card);
    byRaw.set(key, bucket);
  }
  return [...byRaw.values()].filter((items) => new Set(items.map(cardKey)).size > 1).map((items) => ({
    rawText: items[0].matched || items[0].rawText,
    candidates: items.map(normalizeCandidate),
    reason: "ambiguous_or_low_confidence",
  }));
}

function dedupeUncertain(items) {
  const map = new Map();
  for (const item of items) {
    const key = normalize(item.rawText);
    if (key && !map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function cardKey(card) {
  return String(card?.id || card?.cardId || normalize(card?.name || card?.cnName || ""));
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
