import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCardAliasIndex, buildQaIndex } from "../backend/dataIndex.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(rootDir, "data");
const baseUrl = process.env.YGORESOURCES_BASE_URL || "https://db.ygoresources.com";
const maxRecentQa = Number(process.env.MAX_RECENT_QA || 120);
const maxCardQaPerCard = Number(process.env.MAX_CARD_QA_PER_CARD || 80);
const maxQaTotal = Number(process.env.MAX_QA_TOTAL || 3000);
const maxCards = Number(process.env.MAX_CARDS || 0);
const fetchConcurrency = Number(process.env.FETCH_CONCURRENCY || 8);
const syncAllReleasedCards = process.env.SYNC_ALL_RELEASED_CARDS !== "false";
const syncOnlyReleasedCards = process.env.SYNC_ONLY_RELEASED_CARDS !== "false";
const defaultIndexLanguages = (process.env.CARD_INDEX_LANGUAGES || "en,ja")
  .split(",")
  .map((language) => language.trim())
  .filter(Boolean);
const freshnessDays = Number(process.env.FRESHNESS_DAYS || 7);
const userAgent = "ocg-ruling-assistant/0.1 (+https://github.com/)";

const warnings = [];
const sourceSyncWarnings = [];
const aliasWarnings = [];
const parseFailedWarnings = [];

async function main() {
  await mkdir(dataDir, { recursive: true });
  const tracked = await readJsonFile(join(dataDir, "tracked-cards.json"), { cards: [] });
  const previousMeta = await readJsonFile(join(dataDir, "snapshot-meta.json"), {});
  const previousCards = await readJsonFile(join(dataDir, "cards.json"), { records: [] });
  const previousRulings = await readJsonFile(join(dataDir, "rulings.json"), { records: [] });

  const trackedCards = tracked.cards || [];
  const languages = new Set([...defaultIndexLanguages, ...trackedCards.map((card) => card.language || "en")]);
  const nameIndexes = await loadNameIndexes(languages);
  const cardTargets = buildCardTargets(trackedCards, nameIndexes);
  const cardPayloads = await loadCards(cardTargets, nameIndexes);
  let cards = cardPayloads.map(({ record }) => record);
  let rulings = await loadRulings(cards, cardPayloads);
  if (sourceSyncWarnings.length || !syncAllReleasedCards) {
    cards = mergeById(previousCards.records || [], cards);
    rulings = mergeById(previousRulings.records || [], rulings);
  }
  const cardAliasIndex = buildCardAliasIndex(cards);
  const qaIndex = buildQaIndex(rulings, cards);
  const manifest = await loadManifest(previousMeta.sourceRevision);

  const generatedAt = new Date().toISOString();
  const sourceFreshness = sourceSyncWarnings.length ? "stale" : "fresh";
  const dataQualityWarnings = [...aliasWarnings, ...parseFailedWarnings];
  await writeJson(join(dataDir, "cards.json"), {
    schemaVersion: 1,
    generatedAt,
    records: cards,
  });
  await writeJson(join(dataDir, "cards-lite.json"), {
    schemaVersion: 1,
    generatedAt,
    records: cards.map((card) => ({
      id: card.id,
      name: card.name,
      cnName: card.cnName,
      jaName: card.jaName,
      enName: card.enName,
      aliases: card.aliases,
      released: card.released,
    })),
  });
  await writeJson(join(dataDir, "rulings.json"), {
    schemaVersion: 1,
    generatedAt,
    records: rulings,
  });
  await writeJson(join(dataDir, "card-alias-index.json"), {
    schemaVersion: 1,
    generatedAt,
    records: cardAliasIndex,
  });
  await writeJson(join(dataDir, "qa-index.json"), {
    schemaVersion: 1,
    generatedAt,
    records: qaIndex,
  });
  await writeJson(join(dataDir, "snapshot-meta.json"), {
    schemaVersion: 1,
    status: warnings.length ? "synced-with-warnings" : "synced",
    generatedAt,
    freshnessDays,
    sourceFreshness,
    previousSourceRevision: previousMeta.sourceRevision || null,
    sourceRevision: manifest.revision || previousMeta.sourceRevision || null,
    lastSuccessfulSyncAt: sourceSyncWarnings.length ? (previousMeta.lastSuccessfulSyncAt || previousMeta.generatedAt || null) : generatedAt,
    lastFailedSyncAt: sourceSyncWarnings.length ? generatedAt : (previousMeta.lastFailedSyncAt || null),
    syncFailureCount: sourceSyncWarnings.length ? Number(previousMeta.syncFailureCount || 0) + 1 : 0,
    aliasWarnings,
    parseFailedWarnings,
    dataQualityWarnings,
    aliasWarningCount: aliasWarnings.length,
    parseFailedCount: parseFailedWarnings.length,
    dataQualityWarningCount: dataQualityWarnings.length,
    newItems: Number(previousMeta.newItems || 0),
    changedItems: Number(previousMeta.changedItems || 0),
    removedItems: Number(previousMeta.removedItems || 0),
    sources: [
      {
        id: "official-card-database",
        name: "Yu-Gi-Oh! OCG Card Database",
        url: "https://www.db.yugioh-card.com/yugiohdb/",
        role: "最终权威资料来源；涉及裁定变更时以官方数据库和事务局确认优先。",
      },
      {
        id: "ygoresources",
        name: "YGOResources DB",
        url: baseUrl,
        role: "结构化卡片与 Q&A 数据来源，用于生成 GitHub Pages 可读取的静态快照。",
      },
    ],
    warnings,
    sourceSyncWarnings,
    aliasWarnings,
    parseFailedWarnings,
    dataQualityWarnings,
    changedPaths: manifest.changedPaths,
  });

  await writeJson(join(dataDir, "sync-report.json"), {
    generatedAt,
    cardCount: cards.length,
    rulingCount: rulings.length,
    cardAliasCount: cardAliasIndex.length,
    qaIndexCount: qaIndex.length,
    syncAllReleasedCards,
    syncOnlyReleasedCards,
    maxCards,
    maxQaTotal,
    warnings,
    changedPaths: manifest.changedPaths,
  });

  console.log(`Synced ${cards.length} cards, ${cardAliasIndex.length} aliases, ${rulings.length} ruling records, and ${qaIndex.length} Q&A index entries.`);
  if (warnings.length) console.warn(warnings.join("\n"));
}

async function loadNameIndexes(languages) {
  const indexes = new Map();

  for (const language of languages) {
    try {
      const payload = await fetchJson(`/data/idx/card/name/${language}`);
      indexes.set(language, collectNameIndex(payload));
    } catch (error) {
      addSourceWarning(`Name index ${language} failed: ${formatError(error)}`);
      indexes.set(language, new Map());
    }
  }

  return indexes;
}

function buildCardTargets(trackedCards, nameIndexes) {
  const targets = new Map();

  if (syncAllReleasedCards) {
    for (const index of nameIndexes.values()) {
      for (const id of index.values()) {
        mergeTarget(targets, { id: String(id), aliases: [] });
      }
    }
  }

  for (const item of trackedCards) {
    const id = item.id || resolveCardId(item, nameIndexes);
    if (!id) {
      addAliasWarning(`Card not resolved: ${item.lookupName || item.name || JSON.stringify(item)}`);
      continue;
    }
    mergeTarget(targets, { ...item, id: String(id) });
  }

  const result = [...targets.values()];
  return maxCards > 0 ? result.slice(0, maxCards) : result;
}

function mergeTarget(targets, item) {
  const id = String(item.id);
  const existing = targets.get(id);
  if (!existing) {
    targets.set(id, { ...item, id, aliases: item.aliases || [] });
    return;
  }

  existing.lookupName = existing.lookupName || item.lookupName;
  existing.name = existing.name || item.name;
  existing.language = existing.language || item.language;
  existing.aliases = [...new Set([...(existing.aliases || []), ...(item.aliases || [])])];
}

async function loadCards(cards, nameIndexes) {
  const results = await mapLimit(cards, fetchConcurrency, async (item) => {
    const id = item.id || resolveCardId(item, nameIndexes);
    if (!id) {
      addAliasWarning(`Card not resolved: ${item.lookupName || item.name || JSON.stringify(item)}`);
      return null;
    }

    try {
      const payload = await fetchJson(`/data/card/${id}`);
      const record = normalizeCard(payload, item, id);
      if (syncOnlyReleasedCards && !record.released) return null;
      return { record, payload, tracked: item };
    } catch (error) {
      addSourceWarning(`Card ${item.lookupName || id} failed: ${formatError(error)}`);
      return null;
    }
  });

  return dedupeBy(results.filter(Boolean), (entry) => String(entry.record.id || entry.record.name));
}

async function loadRulings(cards, cardPayloads) {
  const records = [];
  records.push(...buildCardTextRecords(cardPayloads));
  records.push(...buildFaqRecords(cardPayloads));

  const qaIds = new Set();
  for (const entry of cardPayloads) {
    for (const id of collectQaIds(entry.payload?.qaIndex || [])) {
      qaIds.add(id);
    }
  }

  try {
    const payload = await fetchJson("/data/meta/recent/ja/qa");
    for (const id of collectQaIds(payload).slice(0, maxRecentQa)) qaIds.add(id);
  } catch (error) {
    addSourceWarning(`Recent Q&A failed: ${formatError(error)}`);
  }

  const qaLimit = Math.min(maxQaTotal, Math.max(maxRecentQa, cards.length * maxCardQaPerCard));
  for (const id of [...qaIds].slice(0, qaLimit)) {
    try {
      const payload = await fetchJson(`/data/qa/${id}`);
      const record = normalizeQa(payload, id, cards);
      if (record) records.push(record);
    } catch (error) {
      addSourceWarning(`Q&A ${id} failed: ${formatError(error)}`);
    }
  }

  return records;
}

async function loadManifest(previousRevision) {
  if (!previousRevision) return { revision: null, changedPaths: [] };

  try {
    const payload = await fetchJson(`/manifest/${previousRevision}`);
    return {
      revision: payload.revision || payload.latestRevision || payload.currentRevision || null,
      changedPaths: payload.changed || payload.paths || payload.data || [],
    };
  } catch (error) {
    addSourceWarning(`Manifest check failed: ${formatError(error)}`);
    return { revision: previousRevision, changedPaths: [] };
  }
}

function resolveCardId(item, indexes) {
  const language = item.language || "en";
  const index = indexes.get(language) || new Map();
  return index.get(normalizeKey(item.lookupName || item.name || ""));
}

function collectNameIndex(payload) {
  const index = new Map();

  function visit(value, possibleName = "") {
    if (!value) return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item, possibleName);
      return;
    }

    if (typeof value !== "object") {
      if (possibleName && (typeof value === "string" || typeof value === "number")) {
        index.set(normalizeKey(possibleName), String(value));
      }
      return;
    }

    const name = value.name || value.cardName || value.label || value.en || value.ja || possibleName;
    const id = value.id || value.cardId || value.cid || value.passcode || value.konamiId;
    if (name && id) index.set(normalizeKey(name), String(id));

    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" || typeof child === "number") {
        if (looksLikeCardName(key) && looksLikeId(child)) index.set(normalizeKey(key), String(child));
      } else {
        visit(child, looksLikeCardName(key) ? key : name);
      }
    }
  }

  visit(payload);
  return index;
}

function normalizeCard(payload, tracked, id) {
  const cardData = payload?.cardData || {};
  const cnName = cardData.cn?.name || tracked.aliases?.find((alias) => /[\u4e00-\u9fa5]/.test(alias));
  const jaName = cardData.ja?.name;
  const enName = cardData.en?.name || tracked.lookupName;
  const primaryName = cnName || jaName || enName || tracked.name || String(id);
  const aliases = [...new Set([primaryName, cnName, jaName, enName, tracked.lookupName, ...(tracked.aliases || [])].filter(Boolean))];

  return {
    id: String(id),
    name: primaryName,
    cnName,
    jaName,
    enName,
    cardType: cardData.cn?.cardType || cardData.ja?.cardType || cardData.en?.cardType || "",
    effectText: cardData.cn?.effectText || cardData.ja?.effectText || cardData.en?.effectText || "",
    released: isReleased(cardData),
    aliases,
    sourceUrl: `${baseUrl}/data/card/${id}`,
    updatedAt: new Date().toISOString(),
  };
}

function isReleased(cardData) {
  const today = new Date();
  const dates = [];
  for (const locale of Object.values(cardData || {})) {
    for (const product of locale?.products || []) {
      const date = new Date(product.date);
      if (Number.isFinite(date.getTime())) dates.push(date);
    }
  }
  return !dates.length || dates.some((date) => date <= today);
}

function buildCardTextRecords(cardPayloads) {
  return cardPayloads
    .filter(({ record }) => record.effectText)
    .map(({ record }) => ({
      id: `card-text-${record.id}`,
      recordType: "card-text",
      title: `${record.name} 的效果文本`,
      status: "confirmed",
      cards: [record.name],
      cardIds: [record.id],
      keywords: extractKeywords(record.effectText),
      conclusion: record.effectText,
      steps: ["这是同步到的卡片效果文本。若问题涉及裁定处理，仍应继续核对相关 Q&A。"],
      questions: record.released ? [] : ["该卡可能尚未发售或同步来源缺少发售日期，裁定应按预览文本谨慎处理。"],
      sources: [
        {
          label: "YGOResources Card & FAQ data",
          detail: record.sourceUrl,
        },
      ],
      updatedAt: record.updatedAt,
    }));
}

function buildFaqRecords(cardPayloads) {
  const records = [];

  for (const { record, payload } of cardPayloads) {
    const entries = payload?.faqData?.entries || {};
    for (const [effectNo, blocks] of Object.entries(entries)) {
      const lines = [];
      for (const block of blocks || []) {
        const text = block.cn || block.ja || block.en;
        if (text) lines.push(text);
      }
      if (!lines.length) continue;

      records.push({
        id: `card-faq-${record.id}-${effectNo}`,
        recordType: "card-faq",
        title: `${record.name} FAQ ${effectNo}`,
        status: "confirmed",
        cards: [record.name],
        cardIds: [record.id],
        question: "",
        keywords: extractKeywords(lines.join("\n")),
        conclusion: lines.join("\n"),
        steps: ["按同步 FAQ 的说明处理。", "若对局条件与 FAQ 不同，继续查对应官方 Q&A。"],
        questions: [],
        sources: [
          {
            label: "YGOResources Card FAQ",
            detail: record.sourceUrl,
          },
        ],
        updatedAt: payload?.faqData?.meta?.ja?.date || payload?.faqData?.meta?.en?.date || record.updatedAt,
      });
    }
  }

  return records;
}

function normalizeQa(payload, id, cards) {
  const question = firstText(payload, ["question", "q", "title"]);
  const answer = firstText(payload, ["answer", "a", "content"]);
  if (!question || !answer) {
    addParseWarning(`Q&A ${id} skipped: question or answer not found`);
    return null;
  }

  const text = `${question}\n${answer}`;
  const involvedCards = detectCards(text, cards);
  const title = truncate(question.replace(/\s+/g, " "), 90);
  return {
    id: `ygoresources-qa-${id}`,
    recordType: "qa",
    title,
    question,
    status: "confirmed",
    cards: involvedCards.map((card) => card.name),
    cardIds: involvedCards.map((card) => card.id).filter(Boolean),
    keywords: extractKeywords(text),
    conclusion: answer,
    steps: ["按同步 Q&A 的问答结论处理。", "若对局条件与问答不同，先回到官方数据库核对完整原文。"],
    questions: [],
    sources: [
      {
        label: "YGOResources Q&A",
        detail: `${baseUrl}/data/qa/${id}`,
      },
    ],
    sourceId: String(id),
    sourceName: "YGOResources DB",
    sourceUrl: `${baseUrl}/data/qa/${id}`,
    updatedAt: new Date().toISOString(),
  };
}

function collectQaIds(payload) {
  const ids = [];

  function visit(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") {
      if (looksLikeId(value)) ids.push(String(value));
      return;
    }
    const id = value.id || value.qaId || value.qid;
    if (looksLikeId(id)) ids.push(String(id));
    for (const child of Object.values(value)) visit(child);
  }

  visit(payload);
  return [...new Set(ids)];
}

function collectLocalizedValues(payload, targetKeys) {
  const values = {};

  function visit(value, key = "") {
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) {
      if (targetKeys.includes(childKey) && child && typeof child === "object") {
        for (const [locale, text] of Object.entries(child)) {
          if (typeof text === "string" && text.trim()) values[locale] = text.trim();
        }
      } else if (targetKeys.includes(key) && typeof child === "string") {
        values[childKey] = child.trim();
      } else {
        visit(child, childKey);
      }
    }
  }

  visit(payload);
  return values;
}

function firstText(payload, targetKeys) {
  const candidates = [];

  function visit(value, key = "") {
    if (!value) return;
    if (typeof value === "string") {
      if (targetKeys.includes(key) && value.trim().length > 1) candidates.push(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) {
        if (targetKeys.includes(childKey)) {
          if (typeof child === "string" && child.trim()) candidates.push(child.trim());
          if (child && typeof child === "object") {
            const localized = child["zh-CN"] || child.cn || child.ja || child.en || child.value || child.text;
            if (typeof localized === "string" && localized.trim()) candidates.push(localized.trim());
          }
        }
        visit(child, childKey);
      }
    }
  }

  visit(payload);
  return candidates.sort((a, b) => b.length - a.length)[0] || "";
}

function detectCards(text, cards) {
  const normalized = normalizeKey(text);
  return cards.filter((card) => (card.aliases || []).some((alias) => normalized.includes(normalizeKey(alias))));
}

function extractKeywords(text) {
  const keywords = [
    ["发动", "能否发动", "可以发动"],
    ["连锁", "C1", "C2"],
    ["控制权", "获得控制权"],
    ["战斗伤害", "伤害计算", "攻击"],
    ["代替破坏", "代破", "破坏"],
    ["魔法", "陷阱"],
  ];
  const result = [];
  for (const group of keywords) {
    if (group.some((keyword) => text.includes(keyword))) result.push(group[0]);
  }
  return result;
}

async function fetchJson(path) {
  const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": userAgent,
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await writeFile(path, content, "utf8");
      return;
    } catch (error) {
      if (attempt === 5 || !["EPERM", "EBUSY", "UNKNOWN"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    }
  }
}

function dedupeBy(items, getKey) {
  const map = new Map();
  for (const item of items) map.set(getKey(item), item);
  return [...map.values()];
}

function mergeById(previous, current) {
  return dedupeBy([...(previous || []), ...(current || [])], (item) => String(item.id || item.name || ""));
}

function addSourceWarning(message) { sourceSyncWarnings.push(message); warnings.push(message); }
function addAliasWarning(message) { aliasWarnings.push(message); warnings.push(message); }
function addParseWarning(message) { parseFailedWarnings.push(message); warnings.push(message); }

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[－ー]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeCardName(value) {
  const text = String(value || "");
  return text.length >= 2 && /[a-zA-Z\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

function looksLikeId(value) {
  return /^[0-9]{3,12}$/.test(String(value || ""));
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch(async (error) => {
  console.error(error);
  const previous = await readJsonFile(join(dataDir, "snapshot-meta.json"), {});
  const failedAt = new Date().toISOString();
  await writeJson(join(dataDir, "snapshot-meta.json"), {
    ...previous,
    sourceFreshness: previous.lastSuccessfulSyncAt || previous.generatedAt ? "stale" : "unknown",
    lastFailedSyncAt: failedAt,
    syncFailureCount: Number(previous.syncFailureCount || 0) + 1,
    warnings: [...new Set([...(previous.warnings || []), `Sync failed: ${formatError(error)}`])],
  });
  process.exitCode = 1;
});
