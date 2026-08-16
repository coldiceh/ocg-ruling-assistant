import { searchOfficialQaEvidence } from "./officialQaMatcher.mjs";
import {
  completeOfficialQuestionText,
  materializeOfficialJapaneseText,
  officialAnswerText,
} from "./officialQaExactDirect.mjs";
import { projectOfficialQaQuestion } from "./officialQaQuestionProjection.mjs";

const CURRENT_STATUSES = new Set(["", "confirmed", "current"]);

export async function runOfficialQaSemanticDirectExperiment({
  userQuestion,
  records = [],
  resolvedCards = [],
  cards = [],
  verifier,
  candidateRetriever = retrieveOfficialQaSemanticCandidates,
} = {}) {
  const question = String(userQuestion || "").trim();
  if (!question) return ordinaryRagFallback("empty_question");
  if (typeof verifier !== "function") return ordinaryRagFallback("equivalence_verifier_unavailable");

  let retrieval;
  try {
    retrieval = await candidateRetriever({
      question,
      records,
      resolvedCards,
      cards,
    });
  } catch (error) {
    return ordinaryRagFallback("candidate_retrieval_failed", {
      verifierError: String(error?.code || error?.name || "candidate_retrieval_error"),
    });
  }
  const candidates = normalizeUniqueCurrentCandidates(retrieval?.candidates || []);
  if (candidates.length !== 1) {
    return ordinaryRagFallback(
      candidates.length ? "high_relevance_candidate_not_unique" : "unique_high_relevance_candidate_not_found",
      { candidateQaIds: candidates.map((item) => item.qaId), retrieval },
    );
  }

  const candidate = candidates[0];
  const canonicalCards = canonicalCardIdentities(resolvedCards);
  if (!canonicalCards?.length) {
    return ordinaryRagFallback("canonical_card_identity_not_unique", {
      candidateQaIds: [candidate.qaId],
      retrieval,
    });
  }
  let verification;
  try {
    // Deliberately pass no candidate id, metadata or answer. The equivalence
    // model is allowed to compare only the two question surfaces.
    verification = normalizeEquivalenceVerification(await verifier({
      userQuestion: question,
      officialQuestion: candidate.officialQuestionJapanese,
      canonicalCards,
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
    && verification.decisiveDifferences.length === 0
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
  cards = [],
} = {}) {
  const resolvedIds = new Set((resolvedCards || [])
    .map((card) => String(card?.id || card?.cardId || "").trim())
    .filter(Boolean));
  const disqualifiedQaIds = disqualifiedCurrentQaIds(records, cards);
  // Mirror the ordinary retriever's canonical-card scope before applying its
  // existing question matcher. Requiring every resolved identity is allowed to
  // miss; it prevents a one-card neighbour from becoming a semantic-direct
  // candidate in a multi-card question.
  const scopedRecords = currentOfficialQaRecords(records).filter((record) => {
    if (disqualifiedQaIds.has(officialQaId(record))) return false;
    if (!resolvedIds.size) return true;
    const recordIds = new Set([
      ...(record.cardIds || []),
      ...projectOfficialQaQuestion(record).principalCardIds,
    ].map(String));
    return [...resolvedIds].every((id) => recordIds.has(id));
  }).map((record) => materializeQuestionForSemanticSearch(record, cards)).filter(Boolean);
  const matches = searchOfficialQaEvidence({
    question,
    records: scopedRecords,
    resolvedCards,
    limit: Math.max(1, scopedRecords.length),
    subsumptionCandidatePoolComplete: true,
  });
  const highMatches = [
    ...matches.exact,
    ...matches.near,
    ...matches.related.filter(isHighRelevanceSemanticVerifierCandidate),
  ];
  return {
    candidates: highMatches.map((match) => candidateFromMatch(match, cards)).filter(Boolean),
    candidateQaIds: highMatches.map((item) => officialQaId(item.record)).filter(Boolean),
    matchLevels: highMatches.map((item) => item.matchLevel),
    scores: highMatches.map((item) => Number(item.score) || 0),
  };
}

function isHighRelevanceSemanticVerifierCandidate(match) {
  return Number(match?.score || 0) >= 0.65
    && Number(match?.cardIdCoverage || 0) === 1
    && Number(match?.relatedQuestionCardIdCoverage || 0) === 1
    && Array.isArray(match?.semanticHits)
    && match.semanticHits.length >= 1
    && Number(match?.semanticQueryCoverage || 0) >= 0.9
    && Number(match?.semanticScore || 0) >= 0.15
    && match?.effectNumberCompatible === true;
}

export function createOfficialQaSemanticEquivalenceVerifier({
  invoke,
  model = "gpt-5.6-sol",
  reasoningEffort = "low",
} = {}) {
  if (typeof invoke !== "function") throw new TypeError("semantic equivalence verifier requires invoke");
  return async ({ userQuestion, officialQuestion, canonicalCards }) => {
    const prompt = buildOfficialQaSemanticEquivalencePrompt({
      userQuestion,
      officialQuestion,
      canonicalCards,
    });
    const raw = await invoke({
      prompt,
      model,
      reasoningEffort,
      task: "official_qa_semantic_equivalence",
    });
    return normalizeEquivalenceVerification(parseVerifierJson(raw));
  };
}

export function buildOfficialQaSemanticEquivalencePrompt({
  userQuestion,
  officialQuestion,
  canonicalCards = [],
} = {}) {
  return [
    "你是严格的双向语义蕴含验证器，不负责回答游戏王裁定。",
    "只比较下面两个问题；你没有也不得推测任何官方答案。",
    "只有玩家角色、时点、区域、效果编号、前提条件和所问操作全部等价时，才可判定 equivalent=true。",
    "省略但可由同一句中的唯一指代无歧义恢复，不算差异；任何不确定、范围变化或未解析指代都必须拒绝等价。",
    "仅输出一个 JSON 对象，字段必须为：",
    '{"equivalent":false,"userEntailsOfficial":false,"officialEntailsUser":false,"decisiveDifferences":[],"unresolvedReferences":[],"uncertain":false}',
    "",
    "<user_question>",
    String(userQuestion || "").trim(),
    "</user_question>",
    "<official_question>",
    String(officialQuestion || "").trim(),
    "</official_question>",
    "<canonical_card_identities>",
    JSON.stringify(normalizeCanonicalCards(canonicalCards)),
    "</canonical_card_identities>",
  ].join("\n");
}

export function normalizeEquivalenceVerification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("equivalence verifier output must be an object");
  }
  const expectedKeys = [
    "decisiveDifferences",
    "equivalent",
    "officialEntailsUser",
    "uncertain",
    "unresolvedReferences",
    "userEntailsOfficial",
  ];
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError("equivalence verifier output has an invalid structure");
  }
  for (const key of ["equivalent", "userEntailsOfficial", "officialEntailsUser", "uncertain"]) {
    if (typeof value[key] !== "boolean") throw new TypeError(`equivalence verifier ${key} must be boolean`);
  }
  return {
    equivalent: value.equivalent,
    userEntailsOfficial: value.userEntailsOfficial,
    officialEntailsUser: value.officialEntailsUser,
    decisiveDifferences: normalizeStringArray(value.decisiveDifferences, "decisiveDifferences"),
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
  const conflictedIds = new Set();
  for (const candidate of candidates) {
    if (!candidate?.qaId || !candidate.officialQuestionJapanese || !candidate.officialAnswerJapanese) continue;
    if (conflictedIds.has(candidate.qaId)) continue;
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
      byId.delete(candidate.qaId);
      conflictedIds.add(candidate.qaId);
    }
  }
  return [...byId.values()];
}

function candidateFromMatch(match, cards) {
  const record = match?.record;
  const qaId = officialQaId(record);
  const officialQuestionJapanese = materializeOfficialJapaneseText(
    completeOfficialQuestionText(record),
    cards,
  );
  const officialAnswerJapanese = materializeOfficialJapaneseText(
    officialAnswerText(record),
    cards,
  );
  if (!qaId
      || !isCompleteOfficialBody(officialQuestionJapanese)
      || !isCompleteOfficialBody(officialAnswerJapanese)) return null;
  return {
    qaId,
    recordId: String(record.id || `ygoresources-qa-${qaId}`),
    sourceUrl: String(record.sourceUrl || `https://www.db.yugioh-card.com/yugiohdb/faq_search.action?fid=${qaId}&ope=5&request_locale=ja`),
    officialQuestionJapanese,
    officialAnswerJapanese,
  };
}

function materializeQuestionForSemanticSearch(record, cards) {
  const projection = projectOfficialQaQuestion(record);
  const officialQuestionJapanese = materializeOfficialJapaneseText(
    completeOfficialQuestionText(record),
    cards,
  );
  if (!isCompleteOfficialBody(officialQuestionJapanese)) return null;
  return {
    ...record,
    rawDetailedQuestion: officialQuestionJapanese,
    rawQuestion: officialQuestionJapanese,
    question: officialQuestionJapanese,
    questionCardIds: [...new Set([
      ...(record.questionCardIds || []),
      ...projection.principalCardIds,
    ].map(String).filter(Boolean))],
  };
}

function disqualifiedCurrentQaIds(records, cards) {
  const signatures = new Map();
  const disqualified = new Set();
  for (const record of currentOfficialQaRecords(records)) {
    const qaId = officialQaId(record);
    if (!qaId || disqualified.has(qaId)) continue;
    const question = materializeOfficialJapaneseText(
      completeOfficialQuestionText(record),
      cards,
    );
    const answer = materializeOfficialJapaneseText(
      officialAnswerText(record),
      cards,
    );
    if (!isCompleteOfficialBody(question) || !isCompleteOfficialBody(answer)) {
      disqualified.add(qaId);
      signatures.delete(qaId);
      continue;
    }
    const signature = `${question}\u0000${answer}`;
    const existing = signatures.get(qaId);
    if (existing && existing !== signature) {
      disqualified.add(qaId);
      signatures.delete(qaId);
    } else if (!existing) {
      signatures.set(qaId, signature);
    }
  }
  return disqualified;
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

function canonicalCardIdentities(resolvedCards) {
  const byId = new Map();
  for (const card of resolvedCards || []) {
    const id = String(card?.id || card?.cardId || "").trim();
    if (!id) continue;
    const identity = {
      id,
      userFacingName: String(card?.name || card?.cnName || card?.jaName || card?.jpName || "").trim(),
      officialJapaneseName: String(card?.jaName || card?.jpName || card?.name || card?.cnName || "").trim(),
    };
    const existing = byId.get(id);
    if (existing && (
      (existing.userFacingName && identity.userFacingName
        && existing.userFacingName !== identity.userFacingName)
      || (existing.officialJapaneseName && identity.officialJapaneseName
        && existing.officialJapaneseName !== identity.officialJapaneseName)
    )) return null;
    byId.set(id, {
      id,
      userFacingName: existing?.userFacingName || identity.userFacingName,
      officialJapaneseName: existing?.officialJapaneseName || identity.officialJapaneseName,
    });
  }
  return [...byId.values()];
}

function normalizeCanonicalCards(cards) {
  return (cards || []).map((card) => ({
    id: String(card?.id || "").trim(),
    userFacingName: String(card?.userFacingName || "").trim(),
    officialJapaneseName: String(card?.officialJapaneseName || "").trim(),
  })).filter((card) => card.id && (card.userFacingName || card.officialJapaneseName));
}

function isCompleteOfficialBody(value) {
  const text = String(value || "").trim();
  if (!text || /<<\s*\d{1,10}\s*>>/u.test(text)) return false;
  return !/(?:…|⋯|\.{3})\s*$/u.test(text);
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
