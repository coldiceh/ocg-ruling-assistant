import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeOfficialResponses } from "../backend/officialResponses.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = join(projectRoot, "data");

export async function revalidateOfficialResponses(options = {}) {
  const dataDir = options.dataDir || defaultDataDir;
  const officialResponses = options.officialResponses
    ? normalizeOfficialResponses(options.officialResponses)
    : normalizeOfficialResponses((await readJson(join(dataDir, "official-responses.json"), { records: [] })).records || []);
  const records = options.records
    ? normalizeDbRecords(options.records)
    : normalizeDbRecords((await readJson(join(dataDir, "rulings.json"), { records: [] })).records || []);
  const useLive = options.useLive === true;
  const timeoutMs = Number(options.timeoutMs || 5000);
  const fetcher = options.fetcher || globalThis.fetch;

  const reports = [];
  for (const response of officialResponses.filter((item) => item.watchOfficialDb?.enabled)) {
    const found = findDirectOfficialEvidenceForResponse(response, records);
    if (found) {
      reports.push({
        id: response.id,
        previousDisplayStatus: response.displayStatus || "provisional_official_response",
        newSourceType: found.sourceType || recordSourceType(found),
        newEvidenceId: found.id,
        newStatus: "confirmed",
        lastResult: "found_direct_qa",
      });
      continue;
    }

    if (useLive && fetcher && response.watchOfficialDb?.sourceUrls?.length) {
      const liveResult = await tryLiveRevalidation(response, { fetcher, timeoutMs });
      if (liveResult.status === "live_source_timeout") {
        reports.push({
          id: response.id,
          previousDisplayStatus: response.displayStatus || "provisional_official_response",
          newStatus: "unknown",
          lastResult: "live_source_timeout",
        });
        continue;
      }
    }

    reports.push({
      id: response.id,
      previousDisplayStatus: response.displayStatus || "provisional_official_response",
      newStatus: "unknown",
      lastResult: "not_found",
    });
  }
  return {
    checkedAt: new Date().toISOString(),
    checkedCount: reports.length,
    reports,
  };
}

export function findDirectOfficialEvidenceForResponse(response, records = []) {
  const candidates = normalizeDbRecords(records).filter((record) => isOfficialDirectDbEvidence(record));
  return candidates.find((record) =>
    recordMatchesWatchCard(response, record) &&
    recordCoversQueryTerms(response, record) &&
    recordCoversExpectedAskedResult(record, response.watchOfficialDb?.expectedAskedResult || [])
  ) || null;
}

export function recordCoversExpectedAskedResult(record, expectedAskedResult = []) {
  const text = normalizeText(recordText(record));
  return (expectedAskedResult || []).every((expected) => {
    if (expected === "can_activate") {
      return /(?:発動できます|発動できる|可以发动|能发动|can activate|can be activated)/iu.test(text) &&
        !/(?:発動できません|発動できない|不能发动|cannot activate|can't activate)/iu.test(text);
    }
    if (expected === "can_pay_cost") {
      return /(?:コスト|cost|代价|支付)/iu.test(text) &&
        /(?:墓地へ送|墓地に送り|送去墓地|送入墓地|send .*graveyard|sent .*graveyard)/iu.test(text);
    }
    if (expected === "does_not_perform_fusion_material_processing") {
      return /(?:処理は何も行われません|何も行われません|处理不进行|不进行处理|nothing is performed|no processing is performed)/iu.test(text) &&
        /(?:融合素材|fusion material|融合)/iu.test(text);
    }
    return text.includes(normalizeText(expected));
  });
}

async function tryLiveRevalidation(response, { fetcher, timeoutMs }) {
  for (const url of response.watchOfficialDb?.sourceUrls || []) {
    try {
      await fetchWithTimeout(fetcher, url, timeoutMs);
    } catch (error) {
      if (error?.name === "AbortError" || error?.message === "live_source_timeout") {
        return { status: "live_source_timeout" };
      }
      return { status: "live_source_unavailable", error: error?.message || String(error) };
    }
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

function recordMatchesWatchCard(response, record) {
  const wantedIds = new Set((response.watchOfficialDb?.cardIds || []).map(normalizeId).filter(Boolean));
  const recordIds = [
    record.cardId,
    ...(Array.isArray(record.cardIds) ? record.cardIds : []),
  ].map(normalizeId).filter(Boolean);
  if (recordIds.some((id) => wantedIds.has(id))) return true;
  const text = normalizeText(recordText(record));
  return (response.cards || []).some((card) => text.includes(normalizeText(card)));
}

function recordCoversQueryTerms(response, record) {
  const text = normalizeText(recordText(record));
  const terms = response.watchOfficialDb?.queryTerms || [];
  if (!terms.length) return true;
  const hits = terms.filter((term) => text.includes(normalizeText(term))).length;
  return hits >= Math.min(2, terms.length);
}

function isOfficialDirectDbEvidence(record) {
  return record.recordType === "qa" ||
    record.recordType === "card-faq" ||
    record.recordType === "official-database" ||
    ["official_qa", "card_faq", "official_database"].includes(record.sourceType);
}

function recordSourceType(record) {
  if (record.sourceType) return record.sourceType;
  if (record.recordType === "card-faq") return "card_faq";
  if (record.recordType === "official-database") return "official_database";
  return "official_qa";
}

function normalizeDbRecords(records) {
  return (Array.isArray(records) ? records : []).map((record) => ({
    id: String(record.id || record.sourceId || ""),
    recordType: record.recordType || inferRecordType(record),
    sourceType: record.sourceType || "",
    title: record.title || "",
    question: record.question || record.questionText || "",
    conclusion: record.conclusion || record.answer || record.answerText || record.text || "",
    cards: Array.isArray(record.cards) ? record.cards : [],
    cardId: record.cardId || "",
    cardIds: Array.isArray(record.cardIds) ? record.cardIds : [],
    keywords: Array.isArray(record.keywords) ? record.keywords : [],
    steps: Array.isArray(record.steps) ? record.steps : [],
  })).filter((record) => record.id);
}

function inferRecordType(record) {
  const id = String(record.id || "");
  if (id.startsWith("card-faq-") || /FAQ/iu.test(record.title || "")) return "card-faq";
  if (id.includes("qa")) return "qa";
  return record.recordType || "note";
}

function recordText(record) {
  return [
    record.title,
    record.question,
    record.conclusion,
    ...(record.keywords || []),
    ...(record.cards || []),
    ...(record.steps || []),
  ].filter(Boolean).join(" ");
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[「」『』"'\s·・－ー_-]+/gu, "")
    .trim();
}

function normalizeId(value) {
  const text = String(value || "").trim();
  return /^\d+$/u.test(text) ? String(Number(text)) : text;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const report = await revalidateOfficialResponses({
    useLive: process.argv.includes("--live"),
  });
  console.log(JSON.stringify(report, null, 2));
}
