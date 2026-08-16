import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { retrieveLiveOfficialQa } from "./liveOfficialQaProvider.mjs";
import { projectOfficialQaQuestion } from "./officialQaQuestionProjection.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = join(projectRoot, "data");
const discoveryCache = new Map();
const CURRENT_STATUSES = new Set(["", "confirmed", "current"]);
const SOURCE_QA_ID = /(?:^|-)qa-(\d+)$/u;

export class OfficialQaDataIntegrityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OfficialQaDataIntegrityError";
    this.code = "DATA_INTEGRITY_ERROR";
    this.statusCode = 503;
    this.details = details;
  }
}

export class OfficialQaBodyUnavailableError extends Error {
  constructor({ qaId, sourceRevision, questionHash, failureReason, warnings = [] } = {}) {
    super(`Official Q&A ${qaId || "(unknown)"} body is unavailable`);
    this.name = "OfficialQaBodyUnavailableError";
    this.code = "OFFICIAL_QA_BODY_UNAVAILABLE";
    this.statusCode = 503;
    this.details = {
      qaId: String(qaId || ""),
      sourceRevision: String(sourceRevision || ""),
      questionHash: String(questionHash || ""),
      failureReason: String(failureReason || "official_qa_body_unavailable"),
      warnings: [...warnings].map((item) => String(item || "")).filter(Boolean),
    };
  }
}

export function normalizeOfficialQaExactText(value) {
  return decodeMechanicalHtml(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    .replace(/[「」『』【】〔〕［］“”"'`]/gu, "")
    .replace(/[：:・·･－—–_\-]/gu, "")
    .replace(/[，,。.!！?？;；、()（）\[\]{}｛｝]/gu, "")
    .replace(/\s+/gu, "")
    .trim();
}

export function hashOfficialQaExactText(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function canonicalizeOfficialQaExactQuestion(question, cards = []) {
  let canonical = decodeMechanicalHtml(question).normalize("NFKC");
  const aliases = buildUniqueCardAliasCatalog(cards);
  const mentionedCardIds = new Set();
  const ambiguousCardSurfaces = [];

  for (const item of aliases.ambiguous) {
    if (canonical.includes(item.surface)) ambiguousCardSurfaces.push(item.surface);
  }
  for (const item of aliases.unique) {
    if (!canonical.includes(item.surface)) continue;
    canonical = canonical.split(item.surface).join(`<<${item.cardId}>>`);
    mentionedCardIds.add(item.cardId);
  }

  const normalized = normalizeOfficialQaExactText(canonical);
  return {
    canonical,
    normalized,
    hash: normalized ? hashOfficialQaExactText(normalized) : "",
    mentionedCardIds: [...mentionedCardIds],
    ambiguousCardSurfaces,
  };
}

export async function retrieveExactOfficialQaDirect({
  question,
  cards = [],
  qaRecords = [],
  qaDiscovery,
  dataDir = defaultDataDir,
  candidatePoolComplete = false,
  fetchImpl = globalThis.fetch,
  env = globalThis.process?.env || {},
  signal,
} = {}) {
  const query = canonicalizeOfficialQaExactQuestion(question, cards);
  if (!query.normalized || query.ambiguousCardSurfaces.length) {
    return noMatch("card_identity_not_unique", query);
  }

  let discovery = normalizeDiscoveryIndex(qaDiscovery);
  if (!discovery && !candidatePoolComplete) {
    discovery = await loadOfficialQaDiscoveryIndex(dataDir);
  }
  const pool = determineCandidatePool({
    discovery,
    mentionedCardIds: query.mentionedCardIds,
    questionHash: query.hash,
    qaRecords,
    candidatePoolComplete,
  });
  if (!pool.complete) return noMatch(pool.reason, query, pool);
  if (!pool.qaIds.length) return noMatch("exact_candidate_pool_empty", query, pool);

  const currentLocalRecords = currentOfficialQaRecords(qaRecords);
  const localByQaId = groupRecordsByQaId(currentLocalRecords);
  const missingQaIds = pool.qaIds.filter((id) => !(localByQaId.get(id) || []).length);
  let liveRecords = [];
  let liveWarnings = [];

  if (missingQaIds.length) {
    const liveLimit = positiveInteger(env.RAG_OFFICIAL_EXACT_MAX_CANDIDATES, 120);
    if (missingQaIds.length > liveLimit || typeof fetchImpl !== "function") {
      throwIfUniqueDiscoveredBodyUnavailable({
        pool,
        query,
        missingQaIds,
        failureReason: typeof fetchImpl !== "function"
          ? "official_qa_body_fetch_unavailable"
          : "official_qa_body_candidate_limit_exceeded",
      });
      return noMatch("exact_candidate_pool_incomplete", query, {
        ...pool,
        missingQaIds,
      });
    }
    const live = await retrieveLiveOfficialQa({
      resolvedCards: [],
      candidateQaIds: missingQaIds,
      fetchImpl,
      baseUrl: String(env.YGORESOURCES_BASE_URL || "https://db.ygoresources.com"),
      timeoutMs: positiveInteger(env.RAG_OFFICIAL_EXACT_TIMEOUT_MS, 5000),
      cacheTtlMs: positiveInteger(env.RAG_OFFICIAL_EXACT_CACHE_TTL_MS, 10 * 60 * 1000),
      maxCandidates: missingQaIds.length,
      maxConcurrentQaFetches: positiveInteger(env.RAG_OFFICIAL_EXACT_FETCH_CONCURRENCY, 6),
      signal,
    });
    liveRecords = currentOfficialQaRecords(live.records || []);
    liveWarnings = live.warnings || [];
  }

  const recordsByQaId = groupRecordsByQaId([...currentLocalRecords, ...liveRecords]);
  const stillMissingQaIds = pool.qaIds.filter((id) => !(recordsByQaId.get(id) || []).length);
  if (stillMissingQaIds.length) {
    throwIfUniqueDiscoveredBodyUnavailable({
      pool,
      query,
      missingQaIds: stillMissingQaIds,
      failureReason: "official_qa_body_fetch_failed",
      warnings: liveWarnings,
    });
    return noMatch("exact_candidate_pool_incomplete", query, {
      ...pool,
      missingQaIds: stillMissingQaIds,
      liveWarnings,
    });
  }

  const exactMatches = [];
  for (const qaId of pool.qaIds) {
    for (const record of recordsByQaId.get(qaId) || []) {
      for (const surface of officialQuestionSurfaces(record)) {
        const projected = canonicalizeOfficialQaExactQuestion(surface, cards);
        if (projected.hash !== query.hash || projected.normalized !== query.normalized) continue;
        exactMatches.push({ qaId, record, surface });
      }
    }
  }
  if (!exactMatches.length) return noMatch("exact_question_hash_not_found", query, pool);

  const byQaId = new Map();
  for (const match of exactMatches) {
    const matches = byQaId.get(match.qaId) || [];
    matches.push(match);
    byQaId.set(match.qaId, matches);
  }
  const certified = [];
  for (const [qaId, matches] of byQaId) {
    const answers = new Map();
    for (const match of matches) {
      const rawAnswer = officialAnswerText(match.record);
      const answerHash = hashOfficialQaExactText(normalizeOfficialQaExactText(rawAnswer));
      if (rawAnswer && answerHash) answers.set(answerHash, rawAnswer);
    }
    if (answers.size !== 1) {
      throw new OfficialQaDataIntegrityError(
        `Current official Q&A ${qaId} has incompatible or missing answers`,
        { qaId, answerHashes: [...answers.keys()] },
      );
    }
    certified.push({
      ...matches[0],
      rawAnswer: [...answers.values()][0],
    });
  }

  if (certified.length > 1) {
    const answerHashes = new Set(certified.map((match) => (
      hashOfficialQaExactText(normalizeOfficialQaExactText(match.rawAnswer))
    )));
    if (answerHashes.size > 1) {
      throw new OfficialQaDataIntegrityError(
        "One current official question maps to incompatible official answers",
        { qaIds: certified.map((match) => match.qaId), answerHashes: [...answerHashes] },
      );
    }
    return noMatch("exact_question_not_unique", query, {
      ...pool,
      matchedQaIds: certified.map((match) => match.qaId),
    });
  }

  const selected = certified[0];
  const title = materializeOfficialJapaneseText(
    selected.record.rawTitle || selected.record.title || selected.surface,
    cards,
  );
  const officialQuestionJapanese = materializeOfficialJapaneseText(
    completeOfficialQuestionText(selected.record) || selected.surface,
    cards,
  );
  const officialAnswerJapanese = materializeOfficialJapaneseText(selected.rawAnswer, cards);
  if (!officialAnswerJapanese) {
    throw new OfficialQaDataIntegrityError(
      `Current official Q&A ${selected.qaId} has no complete answer`,
      { qaId: selected.qaId },
    );
  }

  return {
    status: "matched",
    route: "official_qa_exact_direct",
    qaId: selected.qaId,
    recordId: String(selected.record.id || `ygoresources-qa-${selected.qaId}`),
    title,
    sourceUrl: officialQaSourceUrl(selected.record, selected.qaId),
    officialQuestionJapanese,
    officialAnswerJapanese,
    queryHash: query.hash,
    candidatePoolComplete: true,
    candidateQaIds: pool.qaIds,
    mentionedCardIds: query.mentionedCardIds,
    resolvedCards: query.mentionedCardIds
      .map((id) => cards.find((card) => String(card.id || card.cardId || "") === id))
      .filter(Boolean),
    modelCalls: 0,
    liveWarnings,
  };
}

export async function loadOfficialQaDiscoveryIndex(dataDir = defaultDataDir) {
  const path = join(dataDir || defaultDataDir, "qa-discovery-index.json");
  if (!discoveryCache.has(path)) {
    discoveryCache.set(path, readFile(path, "utf8")
      .then((text) => normalizeDiscoveryIndex(JSON.parse(text)))
      .catch(() => null));
  }
  return discoveryCache.get(path);
}

function determineCandidatePool({
  discovery,
  mentionedCardIds,
  questionHash,
  qaRecords,
  candidatePoolComplete,
}) {
  if (discovery?.complete === true && mentionedCardIds.length) {
    const byCardId = new Map(discovery.records.map((item) => [item.cardId, item.qaIds]));
    const lists = mentionedCardIds.map((id) => byCardId.get(id));
    if (lists.every(Array.isArray)) {
      const [head = [], ...tail] = lists;
      const qaIds = head.filter((id) => tail.every((items) => items.includes(id)));
      const exactQuestionQaIds = uniqueNumericIds(
        discovery.exactQuestionIdentities
          .filter((item) => item.questionHash === questionHash)
          .map((item) => item.qaId),
      ).filter((id) => qaIds.includes(id));
      return {
        complete: true,
        reason: "",
        qaIds: uniqueNumericIds(qaIds),
        source: "complete_card_qa_intersection",
        sourceRevision: discovery.sourceRevision,
        exactQuestionQaId: exactQuestionQaIds.length === 1 ? exactQuestionQaIds[0] : "",
      };
    }
    return { complete: false, reason: "exact_card_discovery_mapping_missing", qaIds: [] };
  }
  if (candidatePoolComplete) {
    return {
      complete: true,
      reason: "",
      qaIds: uniqueNumericIds(currentOfficialQaRecords(qaRecords).map(officialQaId).filter(Boolean)),
      source: "explicit_complete_fixture_pool",
    };
  }
  return { complete: false, reason: "exact_candidate_pool_not_certified", qaIds: [] };
}

function throwIfUniqueDiscoveredBodyUnavailable({
  pool,
  query,
  missingQaIds = [],
  failureReason,
  warnings = [],
}) {
  const qaId = String(pool?.exactQuestionQaId || "");
  if (
    pool?.source !== "complete_card_qa_intersection"
    || !qaId
    || !missingQaIds.map(String).includes(qaId)
  ) return;
  throw new OfficialQaBodyUnavailableError({
    qaId,
    sourceRevision: pool.sourceRevision,
    questionHash: query.hash,
    failureReason,
    warnings,
  });
}

function normalizeDiscoveryIndex(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.records)) return null;
  return {
    complete: value.complete === true,
    sourceRevision: String(value.sourceRevision || ""),
    records: value.records.map((item) => ({
      cardId: String(item?.cardId || ""),
      qaIds: uniqueNumericIds(item?.qaIds),
    })).filter((item) => item.cardId),
    exactQuestionIdentities: (Array.isArray(value.exactQuestionIdentities)
      ? value.exactQuestionIdentities
      : []).map((item) => ({
      qaId: String(item?.qaId || ""),
      questionHash: String(item?.questionHash || "").toLowerCase(),
    })).filter((item) => item.qaId && /^[a-f0-9]{64}$/u.test(item.questionHash)),
  };
}

function currentOfficialQaRecords(records) {
  return (records || []).filter((record) => (
    ["qa", "official-database"].includes(String(record?.recordType || ""))
    && CURRENT_STATUSES.has(String(record?.status || "").toLowerCase())
    && officialQaId(record)
  ));
}

function groupRecordsByQaId(records) {
  const result = new Map();
  for (const record of records || []) {
    const qaId = officialQaId(record);
    if (!qaId) continue;
    const items = result.get(qaId) || [];
    items.push(record);
    result.set(qaId, items);
  }
  return result;
}

function officialQuestionSurfaces(record) {
  const projection = projectOfficialQaQuestion(record);
  const surfaces = [
    record.rawDetailedQuestion,
    record.rawQuestion,
    record.question,
    ...projection.principalSurfaces,
    ...projection.surfaces,
  ];
  const seen = new Set();
  return surfaces.map((item) => String(item || "").trim()).filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function officialAnswerText(record) {
  return String(
    record.rawAnswer
    || record.answer
    || record.conclusion
    || projectOfficialQaQuestion(record).answerText
    || "",
  ).trim();
}

function completeOfficialQuestionText(record) {
  const projection = projectOfficialQaQuestion(record);
  return [
    record.rawDetailedQuestion,
    record.question,
    record.rawQuestion,
    ...projection.principalSurfaces,
    projection.scenarioText,
  ].map((value) => String(value || "").trim())
    .filter(Boolean)
    .sort((left, right) => Array.from(right).length - Array.from(left).length)[0] || "";
}

function officialQaId(record) {
  const direct = String(record?.sourceRecordId || record?.sourceId || "").match(/^\d+$/u)?.[0];
  if (direct) return direct;
  return String(record?.id || record?.stableId || "").match(SOURCE_QA_ID)?.[1] || "";
}

function officialQaSourceUrl(record, qaId) {
  const sourceUrl = String(record?.sourceUrl || record?.officialUrl || "").trim();
  if (/www\.db\.yugioh-card\.com\/yugiohdb\/faq_search\.action/iu.test(sourceUrl)) return sourceUrl;
  return `https://www.db.yugioh-card.com/yugiohdb/faq_search.action?fid=${encodeURIComponent(qaId)}&ope=5&request_locale=ja`;
}

function materializeOfficialJapaneseText(value, cards) {
  const byId = new Map((cards || []).map((card) => [
    String(card.id || card.cardId || ""),
    String(card.jaName || card.jpName || card.name || card.cnName || card.enName || ""),
  ]));
  return String(value || "").replace(/<<\s*(\d{1,10})\s*>>/gu, (match, id) => (
    byId.get(String(id)) || match
  )).trim();
}

function buildUniqueCardAliasCatalog(cards) {
  const idsBySurface = new Map();
  for (const card of cards || []) {
    const cardId = String(card.id || card.cardId || "").trim();
    if (!cardId) continue;
    for (const value of [
      card.jaName,
      card.jpName,
      card.name,
      card.cnName,
      card.enName,
      ...(card.aliases || []),
    ]) {
      const surface = decodeMechanicalHtml(value).normalize("NFKC").trim();
      if (Array.from(surface).length < 2 || /^<<\d+>>$/u.test(surface)) continue;
      const ids = idsBySurface.get(surface) || new Set();
      ids.add(cardId);
      idsBySurface.set(surface, ids);
    }
  }
  const unique = [];
  const ambiguous = [];
  for (const [surface, ids] of idsBySurface) {
    const item = { surface, cardId: ids.size === 1 ? [...ids][0] : "", cardIds: [...ids] };
    (ids.size === 1 ? unique : ambiguous).push(item);
  }
  const byLength = (left, right) => right.surface.length - left.surface.length
    || left.surface.localeCompare(right.surface, "ja");
  unique.sort(byLength);
  ambiguous.sort(byLength);
  return { unique, ambiguous };
}

function decodeMechanicalHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;|&#160;|&#x0*a0;/giu, " ")
    .replace(/&quot;|&#34;|&#x0*22;/giu, "\"")
    .replace(/&apos;|&#39;|&#x0*27;/giu, "'")
    .replace(/&lt;|&#60;|&#x0*3c;/giu, "<")
    .replace(/&gt;|&#62;|&#x0*3e;/giu, ">")
    .replace(/&amp;|&#38;|&#x0*26;/giu, "&")
    .replace(/\r\n?/gu, "\n");
}

function uniqueNumericIds(values = []) {
  return [...new Set((values || []).map((item) => String(item || "").trim()).filter((item) => /^\d+$/u.test(item)))];
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function noMatch(reason, query, details = {}) {
  return {
    status: "not_matched",
    route: "ordinary_rag",
    reason,
    queryHash: query.hash,
    mentionedCardIds: query.mentionedCardIds,
    candidatePoolComplete: details.complete === true,
    candidateQaIds: details.qaIds || [],
    missingQaIds: details.missingQaIds || [],
    matchedQaIds: details.matchedQaIds || [],
  };
}
