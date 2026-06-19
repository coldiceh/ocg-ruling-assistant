import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const REQUIRED_DATA_FILES = [
  "cards.json",
  "rulings.json",
  "card-alias-index.json",
  "qa-index.json",
];

export function expectedDataPaths(dataDir) {
  const root = resolve(dataDir);
  return Object.fromEntries(REQUIRED_DATA_FILES.map((name) => [name, join(root, name)]));
}

export async function checkDataHealth(dataDir) {
  const paths = expectedDataPaths(dataDir);
  const dataFiles = [];
  const payloads = {};

  for (const [name, path] of Object.entries(paths)) {
    let exists = false;
    try {
      await access(path);
      exists = true;
      payloads[name] = JSON.parse(await readFile(path, "utf8"));
    } catch {
      payloads[name] = null;
    }
    dataFiles.push({ name, path, exists });
  }

  return buildDataHealth({
    cards: payloads["cards.json"]?.records || payloads["cards.json"]?.cards || [],
    rulings: payloads["rulings.json"]?.records || payloads["rulings.json"]?.rulings || [],
    aliases: payloads["card-alias-index.json"]?.records || payloads["card-alias-index.json"]?.aliases || [],
    qaIndex: payloads["qa-index.json"]?.records || payloads["qa-index.json"]?.entries || [],
    dataFiles,
    missingFiles: dataFiles.filter((item) => !item.exists).map((item) => item.path),
    expectedDataPaths: paths,
  });
}

export function buildDataHealth({
  cards = [],
  rulings = [],
  aliases = [],
  qaIndex = [],
  dataFiles = [],
  missingFiles = [],
  expectedDataPaths: paths = {},
} = {}) {
  const cardRecords = Array.isArray(cards) ? cards : [];
  const rulingRecords = Array.isArray(rulings) ? rulings : [];
  const aliasRecords = Array.isArray(aliases) ? aliases : [];
  const qaIndexRecords = Array.isArray(qaIndex) ? qaIndex : [];
  const cardIds = new Set(cardRecords.map((card) => String(card?.id || card?.cardId || "").trim()).filter(Boolean));
  const aliasWithoutCardId = aliasRecords.filter((entry) => {
    const cardId = String(entry?.cardId || entry?.id || "").trim();
    return !cardId || !cardIds.has(cardId);
  });
  const qaCount = rulingRecords.filter((record) => record?.recordType === "qa").length;
  const faqCount = rulingRecords.filter((record) => record?.recordType === "card-faq").length;
  const stats = {
    cardsCount: cardRecords.length,
    cardAliasCount: aliasRecords.length,
    qaCount,
    faqCount,
    qaIndexCount: qaIndexRecords.length,
    aliasWithoutCardIdCount: aliasWithoutCardId.length,
    aliasWithoutCardId: aliasWithoutCardId.slice(0, 20),
    dataFiles,
    missingFiles,
    expectedDataPaths: paths,
  };
  const status = determineDataHealthStatus(stats);
  const readinessLevel = determineReadinessLevel({ ...stats, status });
  return {
    ...stats,
    status,
    readinessLevel,
    usable: isDataHealthUsable({ ...stats, status }),
  };
}

export function determineReadinessLevel(stats) {
  if (!isDataHealthUsable(stats)) return "not_ready";
  if (stats.cardsCount >= 5_000 && stats.qaCount >= 1_000 && stats.faqCount >= 500) return "production_ready";
  if (stats.currentQuestionReady || (stats.cardsCount >= 100 && stats.qaCount >= 100 && stats.faqCount > 0)) return "usable_partial";
  return "dev_ok";
}

export function determineDataHealthStatus(stats) {
  if (stats.cardsCount === 0 && stats.qaCount === 0) return "data_source_missing";
  if (stats.cardsCount === 0) return "missing_cards";
  if (stats.qaCount === 0) return "missing_qa";
  if (stats.cardAliasCount === 0) return "missing_cards";
  if (stats.aliasWithoutCardIdCount > 0) return "alias_without_card_id";
  if (stats.qaIndexCount === 0) return "qa_index_empty";
  if (stats.faqCount === 0) return "missing_faq";
  return "ok";
}

export function isDataHealthUsable(stats) {
  return stats.cardsCount > 0 &&
    stats.cardAliasCount > 0 &&
    stats.qaCount > 0 &&
    stats.qaIndexCount > 0 &&
    stats.aliasWithoutCardIdCount === 0 &&
    (stats.missingFiles || []).length === 0;
}
