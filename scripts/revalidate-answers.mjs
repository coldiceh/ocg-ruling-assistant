import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAnswerHistory } from "../backend/answerHistory.mjs";
import {
  answerEachSubQuestion,
  loadSnapshot,
  retrieveEvidenceByFormalQuery,
} from "../backend/engine.mjs";
import { normalizeFormalRulingQuery, validateFormalRulingQuery } from "../backend/formalQuery.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = join(projectRoot, "data");

export async function revalidateAnswers(options = {}) {
  const dataDir = options.dataDir || defaultDataDir;
  const history = options.history
    ? normalizeHistory(options.history)
    : await loadAnswerHistory(join(dataDir, "answer-history.json"));
  const snapshot = options.snapshot || await loadSnapshot(dataDir);
  const records = Array.isArray(options.records) ? options.records : snapshot.records || [];
  const cards = Array.isArray(options.cards) ? options.cards : snapshot.cards || [];
  const timeoutMs = Number(options.timeoutMs || 5000);
  const fetcher = options.fetcher || globalThis.fetch;
  const reports = [];

  for (const item of history.records || []) {
    if (options.useLive === true && fetcher && item.watchTerms?.length) {
      const liveResult = await tryLiveProbe(item, { fetcher, timeoutMs });
      if (liveResult.status === "live_source_timeout") {
        reports.push({
          id: item.id,
          originalText: item.originalText,
          previousStatus: item.finalStatus,
          newStatus: item.finalStatus || "unknown",
          lastRevalidationResult: "live_source_timeout",
        });
        continue;
      }
    }

    const result = revalidateAnswerItem(item, { records, cards });
    reports.push(result);
  }

  return {
    checkedAt: new Date().toISOString(),
    checkedCount: reports.length,
    reports,
  };
}

export function revalidateAnswerItem(item, { records = [], cards = [] } = {}) {
  const formalQuery = normalizeFormalRulingQuery(item.formalQuery || {
    originalText: item.originalText || "",
    cards: [],
    scenario: {},
    subQuestions: [],
  });
  const detectedCards = cardsForHistoryItem(item, formalQuery, cards);
  const evidence = retrieveEvidenceByFormalQuery(formalQuery, detectedCards, { records });
  const subAnswers = answerEachSubQuestion(
    formalQuery,
    evidence,
    { records },
    validateFormalRulingQuery(formalQuery),
    { parserWarnings: [] }
  );
  const allConfirmed = subAnswers.length > 0 && subAnswers.every((answer) => answer.status === "confirmed");
  if (allConfirmed) {
    return {
      id: item.id,
      originalText: item.originalText,
      previousStatus: item.finalStatus,
      newStatus: "confirmed",
      newVerdict: summarizeVerdict(subAnswers),
      newEvidenceIds: [...new Set(subAnswers.flatMap((answer) => answer.evidenceIds || []))],
      changedReason: "official_database_direct_evidence_found",
      lastRevalidationResult: "upgraded_to_confirmed",
    };
  }

  const relatedIds = [...new Set([
    ...evidence.rulingEvidence.map((entry) => entry.evidenceId || entry.id),
    ...evidence.similarRulingEvidence.map((entry) => entry.evidenceId || entry.id),
  ].filter(Boolean))];
  if (relatedIds.some((id) => !(item.usedEvidenceIds || []).includes(id))) {
    return {
      id: item.id,
      originalText: item.originalText,
      previousStatus: item.finalStatus,
      newStatus: item.finalStatus || "unknown",
      relatedEvidenceIds: relatedIds,
      lastRevalidationResult: "new_related_evidence",
    };
  }

  return {
    id: item.id,
    originalText: item.originalText,
    previousStatus: item.finalStatus,
    newStatus: item.finalStatus || "unknown",
    lastRevalidationResult: "unchanged",
  };
}

function cardsForHistoryItem(item, formalQuery, cards) {
  const wantedIds = new Set((item.watchCardIds || []).map((value) => String(Number(value))).filter((value) => value !== "NaN"));
  const wantedNames = new Set([
    ...(formalQuery.cards || []).map((card) => card.name),
    ...(formalQuery.subQuestions || []).map((question) => question.card),
  ].map(normalizeKey).filter((value) => value && value !== "unknown"));
  const matched = (cards || []).filter((card) => {
    const ids = [card.id, card.cardId, card.passcode, card.liveId].map((value) => String(Number(value))).filter((value) => value !== "NaN");
    if (ids.some((id) => wantedIds.has(id))) return true;
    const aliases = [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].map(normalizeKey);
    return aliases.some((alias) => wantedNames.has(alias));
  });
  return matched.length ? matched : cards || [];
}

function summarizeVerdict(subAnswers) {
  if (subAnswers.length === 1) return subAnswers[0].verdict;
  return {
    subAnswers: subAnswers.map((answer) => ({
      questionId: answer.questionId,
      verdict: answer.verdict,
    })),
  };
}

async function tryLiveProbe(item, { fetcher, timeoutMs }) {
  const markerUrl = `https://api.github.com/?q=${encodeURIComponent((item.watchTerms || []).slice(0, 3).join(" "))}`;
  try {
    await fetchWithTimeout(fetcher, markerUrl, timeoutMs);
  } catch (error) {
    if (error?.name === "AbortError" || error?.message === "live_source_timeout") return { status: "live_source_timeout" };
    return { status: "live_source_unavailable", error: error?.message || String(error) };
  }
  return { status: "not_found" };
}

async function fetchWithTimeout(fetcher, url, timeoutMs) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(Object.assign(new Error("live_source_timeout"), { name: "AbortError" })), timeoutMs);
  });
  try {
    return await Promise.race([fetcher(url), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function normalizeHistory(history) {
  if (Array.isArray(history)) return { schemaVersion: 1, records: history };
  return {
    schemaVersion: Number(history?.schemaVersion || 1),
    records: Array.isArray(history?.records) ? history.records : [],
  };
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[「」『』"'\s·・－ー_-]+/gu, "")
    .trim();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const report = await revalidateAnswers({
    useLive: process.argv.includes("--live"),
  });
  console.log(JSON.stringify(report, null, 2));
}
