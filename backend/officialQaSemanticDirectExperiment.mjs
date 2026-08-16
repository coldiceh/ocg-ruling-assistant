import { searchOfficialQaEvidence } from "./officialQaMatcher.mjs";

const CURRENT_STATUSES = new Set(["", "confirmed", "current"]);

export async function runOfficialQaSemanticDirectExperiment({
  userQuestion,
  records = [],
  resolvedCards = [],
  verifier,
  candidateRetriever = retrieveOfficialQaSemanticCandidates,
} = {}) {
  const question = String(userQuestion || "").trim();
  if (!question) return ordinaryRagFallback("empty_question");
  if (typeof verifier !== "function") throw new TypeError("semantic-direct experiment requires a verifier");

  const retrieval = await candidateRetriever({
    question,
    records,
    resolvedCards,
  });
  const candidates = normalizeUniqueCurrentCandidates(retrieval?.candidates || []);
  if (candidates.length !== 1) {
    return ordinaryRagFallback(
      candidates.length ? "high_relevance_candidate_not_unique" : "unique_high_relevance_candidate_not_found",
      { candidateQaIds: candidates.map((item) => item.qaId), retrieval },
    );
  }

  const candidate = candidates[0];
  let verification;
  try {
    // Deliberately pass no candidate id, metadata or answer. The equivalence
    // model is allowed to compare only the two question surfaces.
    verification = normalizeEquivalenceVerification(await verifier({
      userQuestion: question,
      officialQuestion: candidate.officialQuestionJapanese,
    }));
  } catch (error) {
    return ordinaryRagFallback("equivalence_verifier_failed", {
      candidateQaIds: [candidate.qaId],
      retrieval,
      verifierError: String(error?.code || error?.name || "verifier_error"),
      modelCalls: 1,
    });
  }

  const certified = verification.equivalent === true
    && verification.userEntailsOfficial === true
    && verification.officialEntailsUser === true
    && verification.uncertain === false
    && verification.differences.length === 0
    && verification.unresolvedReferences.length === 0;
  if (!certified) {
    return ordinaryRagFallback("semantic_equivalence_not_certified", {
      candidateQaIds: [candidate.qaId],
      retrieval,
      verification,
      modelCalls: 1,
    });
  }

  return {
    status: "matched",
    route: "official_qa_semantic_direct",
    experimental: true,
    qaId: candidate.qaId,
    recordId: candidate.recordId,
    sourceUrl: candidate.sourceUrl,
    officialQuestionJapanese: candidate.officialQuestionJapanese,
    officialAnswerJapanese: candidate.officialAnswerJapanese,
    candidateQaIds: [candidate.qaId],
    verification,
    modelCalls: 1,
  };
}

export function retrieveOfficialQaSemanticCandidates({
  question,
  records = [],
  resolvedCards = [],
} = {}) {
  const resolvedIds = new Set((resolvedCards || [])
    .map((card) => String(card?.id || card?.cardId || "").trim())
    .filter(Boolean));
  // Mirror the ordinary retriever's canonical-card scope before applying its
  // existing question matcher. Requiring every resolved identity is allowed to
  // miss; it prevents a one-card neighbour from becoming a semantic-direct
  // candidate in a multi-card question.
  const scopedRecords = currentOfficialQaRecords(records).filter((record) => {
    if (!resolvedIds.size) return true;
    const recordIds = new Set((record.cardIds || []).map(String));
    return [...resolvedIds].every((id) => recordIds.has(id));
  });
  const matches = searchOfficialQaEvidence({
    question,
    records: scopedRecords,
    resolvedCards,
    limit: 20,
    subsumptionCandidatePoolComplete: true,
  });
  const highMatches = matches.exact.length
    ? matches.exact
    : matches.near.length
      ? matches.near
      : (resolvedIds.size && matches.all.length === 1 ? matches.all : []);
  return {
    candidates: highMatches.map(candidateFromMatch).filter(Boolean),
    candidateQaIds: highMatches.map((item) => officialQaId(item.record)).filter(Boolean),
    matchLevels: highMatches.map((item) => item.matchLevel),
    scores: highMatches.map((item) => Number(item.score) || 0),
  };
}

export function createOfficialQaSemanticEquivalenceVerifier({
  invoke,
  model = "gpt-5.6-sol",
  reasoningEffort = "low",
} = {}) {
  if (typeof invoke !== "function") throw new TypeError("semantic equivalence verifier requires invoke");
  return async ({ userQuestion, officialQuestion }) => {
    const prompt = buildOfficialQaSemanticEquivalencePrompt({ userQuestion, officialQuestion });
    const raw = await invoke({
      prompt,
      model,
      reasoningEffort,
      task: "official_qa_semantic_equivalence",
    });
    return normalizeEquivalenceVerification(parseVerifierJson(raw));
  };
}

export function buildOfficialQaSemanticEquivalencePrompt({ userQuestion, officialQuestion } = {}) {
  return [
    "你是严格的双向语义蕴含验证器，不负责回答游戏王裁定。",
    "只比较下面两个问题；你没有也不得推测任何官方答案。",
    "只有玩家角色、时点、区域、效果编号、前提条件和所问操作全部等价时，才可判定 equivalent=true。",
    "省略但可由同一句中的唯一指代无歧义恢复，不算差异；任何不确定、范围变化或未解析指代都必须拒绝等价。",
    "仅输出一个 JSON 对象，字段必须为：",
    '{"equivalent":false,"userEntailsOfficial":false,"officialEntailsUser":false,"differences":[],"unresolvedReferences":[],"uncertain":false}',
    "",
    "<user_question>",
    String(userQuestion || "").trim(),
    "</user_question>",
    "<official_question>",
    String(officialQuestion || "").trim(),
    "</official_question>",
  ].join("\n");
}

export function normalizeEquivalenceVerification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("equivalence verifier output must be an object");
  }
  for (const key of ["equivalent", "userEntailsOfficial", "officialEntailsUser", "uncertain"]) {
    if (typeof value[key] !== "boolean") throw new TypeError(`equivalence verifier ${key} must be boolean`);
  }
  return {
    equivalent: value.equivalent,
    userEntailsOfficial: value.userEntailsOfficial,
    officialEntailsUser: value.officialEntailsUser,
    differences: normalizeStringArray(value.differences, "differences"),
    unresolvedReferences: normalizeStringArray(value.unresolvedReferences, "unresolvedReferences"),
    uncertain: value.uncertain,
  };
}

function parseVerifierJson(raw) {
  const value = raw?.result ?? raw?.content ?? raw?.text ?? raw;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = String(value || "").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    throw new SyntaxError("equivalence verifier did not return one JSON object");
  }
  return JSON.parse(text);
}

function normalizeUniqueCurrentCandidates(candidates) {
  const byId = new Map();
  for (const candidate of candidates) {
    if (!candidate?.qaId || !candidate.officialQuestionJapanese || !candidate.officialAnswerJapanese) continue;
    const existing = byId.get(candidate.qaId);
    if (!existing) {
      byId.set(candidate.qaId, candidate);
      continue;
    }
    if (
      existing.officialQuestionJapanese !== candidate.officialQuestionJapanese
      || existing.officialAnswerJapanese !== candidate.officialAnswerJapanese
    ) {
      // Multiple incompatible current bodies are never a unique candidate.
      byId.set(candidate.qaId, null);
    }
  }
  return [...byId.values()].filter(Boolean);
}

function candidateFromMatch(match) {
  const record = match?.record;
  const qaId = officialQaId(record);
  const officialQuestionJapanese = completeOfficialQuestion(record);
  const officialAnswerJapanese = String(record?.rawAnswer || record?.answer || record?.conclusion || "").trim();
  if (!qaId || !officialQuestionJapanese || !officialAnswerJapanese) return null;
  return {
    qaId,
    recordId: String(record.id || `ygoresources-qa-${qaId}`),
    sourceUrl: String(record.sourceUrl || `https://www.db.yugioh-card.com/yugiohdb/faq_search.action?fid=${qaId}&ope=5&request_locale=ja`),
    officialQuestionJapanese,
    officialAnswerJapanese,
  };
}

function completeOfficialQuestion(record) {
  return [record?.rawDetailedQuestion, record?.rawQuestion, record?.question, record?.title]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .sort((left, right) => Array.from(right).length - Array.from(left).length)[0] || "";
}

function currentOfficialQaRecords(records) {
  return (records || []).filter((record) => (
    ["qa", "official-database"].includes(String(record?.recordType || ""))
    && CURRENT_STATUSES.has(String(record?.status || "").toLowerCase())
  ));
}

function officialQaId(record) {
  const direct = String(record?.sourceRecordId || record?.sourceId || "").match(/^\d+$/u)?.[0];
  if (direct) return direct;
  return String(record?.id || record?.stableId || "").match(/(?:^|-)qa-(\d+)$/u)?.[1] || "";
}

function normalizeStringArray(value, key) {
  if (!Array.isArray(value)) throw new TypeError(`equivalence verifier ${key} must be an array`);
  return value.map((item) => {
    if (typeof item !== "string") throw new TypeError(`equivalence verifier ${key} entries must be strings`);
    return item.trim();
  }).filter(Boolean);
}

function ordinaryRagFallback(reason, details = {}) {
  return {
    status: "fallback",
    route: "ordinary_rag",
    experimental: true,
    reason,
    candidateQaIds: details.candidateQaIds || [],
    verification: details.verification || null,
    modelCalls: Number(details.modelCalls || 0),
    retrieval: details.retrieval || null,
    ...(details.verifierError ? { verifierError: details.verifierError } : {}),
  };
}
