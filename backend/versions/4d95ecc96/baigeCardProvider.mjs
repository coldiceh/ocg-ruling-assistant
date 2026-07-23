// Frozen software snapshot from Git revision 4d95ecc96.
import { canonicalizeNumberedCardPrefixes, extractNumberedCardIdentities, hasNumberedCardIdentityConflict } from "./numberedCardIdentity.mjs";

const BAIGE_API_BASE = "https://ygocdb.com/api/v0/";
const DEFAULT_CACHE_TTL_MS = 86_400_000;
const searchCache = new Map();
const ATTRIBUTE_NAMES = new Map([
  [1, "地"], [2, "水"], [4, "炎"], [8, "风"], [16, "光"], [32, "暗"], [64, "神"],
]);
const RACE_NAMES = new Map([
  [1, "战士族"], [2, "魔法师族"], [4, "天使族"], [8, "恶魔族"], [16, "不死族"],
  [32, "机械族"], [64, "水族"], [128, "炎族"], [256, "岩石族"], [512, "鸟兽族"],
  [1024, "植物族"], [2048, "昆虫族"], [4096, "雷族"], [8192, "龙族"], [16384, "兽族"],
  [32768, "兽战士族"], [65536, "恐龙族"], [131072, "鱼族"], [262144, "海龙族"],
  [524288, "爬虫类族"], [1048576, "念动力族"], [2097152, "幻神兽族"],
  [4194304, "创造神族"], [8388608, "幻龙族"], [16777216, "电子界族"], [33554432, "幻想魔族"],
]);

export async function searchCards(query, options = {}) {
  return searchBaigeCards(query, options);
}

export async function searchBaigeCards(query, {
  fetchImpl = globalThis.fetch,
  env = globalThis.process?.env || {},
  limit = 8,
  now = Date.now(),
} = {}) {
  const normalizedQuery = String(query || "").trim();
  const warnings = [];
  if (!normalizedQuery) return { provider: "baige", query: "", results: [], warnings: ["baige_empty_query"], cacheHit: false };
  if (typeof fetchImpl !== "function") {
    return { provider: "baige", query: normalizedQuery, results: [], warnings: ["baige_fetch_unavailable"], cacheHit: false };
  }

  const cacheKey = normalizeSearchKey(normalizedQuery);
  const ttlMs = readPositiveNumber(env.BAIGE_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return {
      provider: "baige",
      query: normalizedQuery,
      results: cached.results.slice(0, limit),
      warnings: [...cached.warnings],
      cacheHit: true,
    };
  }

  let payload = null;
  let matchedSearchQuery = normalizedQuery;
  try {
    for (const searchQuery of buildBaigeSearchQueries(normalizedQuery)) {
      const url = new URL(BAIGE_API_BASE);
      url.searchParams.set("search", searchQuery);
      const response = await fetchImpl(url.toString(), {
        headers: {
          accept: "application/json",
          "user-agent": "ocg-ruling-assistant/0.3",
        },
      });
      if (!response?.ok) {
        warnings.push(`baige_http_${response?.status || "error"}`);
        return { provider: "baige", query: normalizedQuery, results: [], warnings, cacheHit: false };
      }
      payload = await response.json();
      const payloadCards = collectBaigeCards(payload);
      const hasCompatibleCard = payloadCards.some((card) => !hasNumberedCardIdentityConflict(
        normalizedQuery,
        [readFirst(card, ["cn_name", "cnName", "sc_name", "zh_name", "nwbbs_n", "name", "title"]), readFirst(card, ["jp_name", "ja_name"]), readFirst(card, ["en_name"])].filter(Boolean).join(" "),
      ));
      if (payloadCards.length && hasCompatibleCard) {
        matchedSearchQuery = searchQuery;
        if (searchQuery !== normalizedQuery) warnings.push(`baige_fallback_query_used:${searchQuery}`);
        break;
      }
      if (payloadCards.length) warnings.push(`baige_numbered_identity_conflict:${searchQuery}`);
    }
  } catch (error) {
    warnings.push(`baige_fetch_failed:${safeErrorMessage(error)}`);
    return { provider: "baige", query: normalizedQuery, results: [], warnings, cacheHit: false };
  }

  const rawCards = collectBaigeCards(payload);
  const results = rawCards
    .map((card) => normalizeBaigeCard(card, normalizedQuery, warnings))
    .filter((card) => card.name || card.text || card.id)
    .filter((card) => !hasNumberedCardIdentityConflict(normalizedQuery, [card.name, card.cnName, card.jpName, card.enName, ...(card.aliases || [])].filter(Boolean).join(" ")))
    .map((card) => ({ ...card, confidence: scoreBaigeCard(card, normalizedQuery) }))
    .sort((left, right) => right.confidence - left.confidence || String(left.name).localeCompare(String(right.name), "zh-Hans-CN"))
    .slice(0, limit);

  searchCache.set(cacheKey, {
    results,
    warnings,
    expiresAt: now + ttlMs,
  });

  return {
    provider: "baige",
    query: normalizedQuery,
    matchedSearchQuery,
    results,
    warnings,
    cacheHit: false,
  };
}

export function clearBaigeSearchCache() {
  searchCache.clear();
}

export function normalizeBaigeCard(card = {}, query = "", warnings = []) {
  const id = normalizeId(readFirst(card, ["id", "card_id", "cardId", "password", "passcode"]) || card?.data?.id || "");
  const cid = readFirst(card, ["cid", "card_cid", "ygocdb_id"]);
  const cnName = readFirst(card, ["cn_name", "cnName", "sc_name", "zh_name", "nwbbs_n", "cnocg_n", "name", "title"]);
  const jpName = readFirst(card, ["jp_name", "ja_name", "jpName", "jaName", "jp_ruby"]);
  const enName = readFirst(card, ["en_name", "enName", "english_name"]);
  const name = cnName || readFirst(card, ["name", "title"]) || jpName || enName || String(query || id || cid || "");
  const text = extractEffectText(card);
  const type = readFirst(card, ["type", "cardType"]) || card?.text?.types || card?.data?.type || "";
  const attribute = normalizeAttribute(readFirst(card, ["attribute"]) || card?.data?.attribute || "", type);
  const race = normalizeRace(readFirst(card, ["race"]) || card?.data?.race || "", type);
  const atk = readStat(card, "atk");
  const def = readStat(card, "def");
  const level = readStat(card, "level") || readStat(card, "rank") || readStat(card, "link");
  const imageCandidates = collectImageCandidates(card, id);
  const sourceUrl = id ? `https://ygocdb.com/card/${id}` : "https://ygocdb.com/";

  if (!id) warnings.push(`baige_missing_id:${name || query}`);
  if (!name) warnings.push(`baige_missing_name:${id || query}`);
  if (!text) warnings.push(`baige_missing_text:${name || id || query}`);

  return {
    provider: "baige",
    source: "baige",
    sourceLabel: "百鸽",
    id,
    cardId: id,
    passcode: id,
    cid: cid === undefined || cid === null ? null : cid,
    name,
    cnName,
    jpName,
    jaName: jpName,
    enName,
    text,
    effectText: text,
    type: String(type || ""),
    cardType: String(type || ""),
    attribute: attribute === undefined || attribute === null ? "" : attribute,
    race: race === undefined || race === null ? "" : race,
    atk: atk === undefined ? null : atk,
    def: def === undefined ? null : def,
    level: level === undefined ? null : level,
    aliases: [name, cnName, jpName, enName, readFirst(card, ["sc_name", "zh_name", "nwbbs_n", "cnocg_n"])]
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .filter((item, index, array) => array.indexOf(item) === index),
    imageUrl: imageCandidates[0] || "",
    imageCandidates,
    sourceUrl,
    official: false,
    raw: card,
  };
}

export function scoreBaigeCard(card = {}, query = "") {
  if (/^\s*\d{1,4}\s*$/u.test(String(query || ""))) return 0;
  const identityText = [card.cnName, card.name, card.jpName, card.jaName, card.enName, ...(card.aliases || [])].filter(Boolean).join(" ");
  if (hasNumberedCardIdentityConflict(query, identityText)) return 0;
  const queryKey = normalizeSearchKey(query);
  if (!queryKey) return 0;
  const names = [card.cnName, card.name, card.jpName, card.jaName, card.enName, ...(card.aliases || [])].filter(Boolean);
  let score = 0;
  for (const name of names) {
    const key = normalizeSearchKey(name);
    if (!key) continue;
    const distance = boundedEditDistance(key, queryKey, 2);
    if (distance === 1 && Math.min(key.length, queryKey.length) >= 5) {
      score = Math.max(score, 0.9);
    } else if (distance === 2 && Math.min(key.length, queryKey.length) >= 7) {
      score = Math.max(score, 0.82);
    }
    if (key === queryKey) score = Math.max(score, name === card.cnName || name === card.name ? 1 : 0.96);
    else if (key.includes(queryKey)) score = Math.max(score, queryKey.length >= 4 ? 0.9 : 0.72);
    else if (queryKey.includes(key)) score = Math.max(score, key.length >= 4 ? 0.82 : 0.62);
    else score = Math.max(score, diceCoefficient(key, queryKey) * 0.75);
  }
  const textKey = normalizeSearchKey(card.text || card.effectText || "");
  if (textKey.includes(queryKey)) score = Math.max(score, 0.38);
  return Math.round(score * 1000) / 1000;
}

function collectBaigeCards(payload) {
  const result = [];
  const seen = new Set();

  function visit(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;

    const id = normalizeId(readFirst(value, ["id", "card_id", "cardId", "password", "passcode"]));
    const cid = readFirst(value, ["cid"]);
    const name = readFirst(value, ["cn_name", "cnName", "sc_name", "zh_name", "nwbbs_n", "name", "title"]);
    const text = extractEffectText(value);
    if ((id || cid) && (name || text)) {
      const key = `${id || cid}:${name || ""}:${String(text || "").slice(0, 40)}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(value);
      }
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") visit(child);
    }
  }

  visit(payload?.result || payload?.data || payload?.cards || payload?.list || payload);
  return result;
}

function collectImageCandidates(card, id) {
  const candidates = [];
  function add(value) {
    if (!value) return;
    const text = String(value).trim();
    if (!text) return;
    if (/^https?:\/\//iu.test(text)) candidates.push(text);
    else if (/^\/\//u.test(text)) candidates.push(`https:${text}`);
    else if (/\.(?:jpg|jpeg|png|webp)(?:!half|!thumb)?(?:\?|$)/iu.test(text)) {
      try {
        candidates.push(new URL(text, "https://ygocdb.com/").toString());
      } catch {
        // Ignore malformed image hints.
      }
    }
  }

  function visit(value, key = "") {
    if (!value) return;
    if (typeof value === "string") {
      if (/img|image|pic|cover|art/iu.test(key) || /\.(?:jpg|jpeg|png|webp)(?:!half|!thumb)?(?:\?|$)/iu.test(value)) add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  }

  visit(card);
  return [...new Set([...candidates, ...buildCardImageCandidates(id)])];
}

export function buildCardImageCandidates(id) {
  const normalizedId = normalizeId(id);
  if (!normalizedId) return [];
  const compactId = normalizedId.replace(/^0+/u, "") || normalizedId;
  return [
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg!half`,
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg!thumb`,
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${compactId}.webp!half`,
    `https://images.ygoprodeck.com/images/cards/${compactId}.jpg`,
    `https://images.ygoprodeck.com/images/cards_cropped/${compactId}.jpg`,
    `https://images.ygoprodeck.com/images/cards_small/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygopro/pics/${normalizedId}.jpg!half`,
    `https://cdn.233.momobako.com/ygopro/pics/${normalizedId}.jpg!thumb`,
    `https://cdn.233.momobako.com/ygopro/pics/${normalizedId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${normalizedId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${normalizedId}.webp!half`,
  ];
}

function extractEffectText(card) {
  const candidates = [
    card.desc,
    card.effect,
    card.effectText,
    card.text,
    card.cn_desc,
    card.zh_desc,
    card.sc_desc,
    card.nwbbs_text,
    card?.text?.desc,
    card?.html?.desc,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return cleanText(candidate);
  }

  const texts = [];
  function visit(value, key = "") {
    if (!value) return;
    if (typeof value === "string") {
      if (/desc|effect|text/iu.test(key) && value.trim().length > 8) texts.push(cleanText(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  }
  visit(card);
  return texts.sort((left, right) => right.length - left.length)[0] || "";
}

function readFirst(source, keys) {
  for (const key of keys) {
    if (!source || !Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return "";
}

function readStat(card, key) {
  if (card?.[key] !== undefined && card?.[key] !== null) return card[key];
  if (card?.data?.[key] !== undefined && card?.data?.[key] !== null) return card.data[key];
  return undefined;
}

function normalizeAttribute(value, typeText = "") {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && ATTRIBUTE_NAMES.has(numeric)) return ATTRIBUTE_NAMES.get(numeric);
  const text = String(value ?? "").trim().replace(/風/gu, "风");
  if (text && !/^\d+$/u.test(text)) return text;
  const match = String(typeText || "").replace(/風/gu, "风").match(/(?:\/|\s)(地|水|炎|风|光|暗|神)(?=$|[\s/\]])/u);
  return match?.[1] || "";
}

function normalizeRace(value, typeText = "") {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && RACE_NAMES.has(numeric)) return RACE_NAMES.get(numeric);
  const text = String(value ?? "").trim();
  if (text && !/^\d+$/u.test(text)) return text;
  const match = String(typeText || "").match(/\]\s*([^/\n]+)\/(?:地|水|炎|风|風|光|暗|神)(?=$|[\s/\]])/u);
  const parsed = String(match?.[1] || "").trim();
  return parsed ? (parsed.endsWith("族") ? parsed : `${parsed}族`) : "";
}

function cleanText(value) {
  return decodeHtmlEntities(stripHtml(String(value || "")))
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<\s*br\s*\/?\s*>/giu, "\n")
    .replace(/<\/\s*(p|div|li|tr|section|article)\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, "");
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (match, entity) => {
    const lower = String(entity).toLowerCase();
    if (lower[0] === "#") {
      const isHex = lower[1] === "x";
      const codePoint = Number.parseInt(lower.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
  });
}

function normalizeId(value) {
  const digits = String(value || "").replace(/\D+/gu, "");
  if (!digits) return "";
  return digits.length <= 8 ? digits.padStart(8, "0") : digits;
}

function normalizeSearchKey(value) {
  return canonicalizeNumberedCardPrefixes(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[雙]/gu, "双")
    .replace(/[來]/gu, "来")
    .replace(/[龍]/gu, "龙")
    .replace(/[薔]/gu, "蔷")
    .replace(/[蘇]/gu, "苏")
    .replace(/[場]/gu, "场")
    .replace(/[發]/gu, "发")
    .replace(/[動]/gu, "动")
    .replace(/[體]/gu, "体")
    .replace(/[從]/gu, "从")
    .replace(/[對]/gu, "对")
    .replace(/[選]/gu, "选")
    .replace(/[闕]/gu, "阙")
    .replace(/導/gu, "导")
    .replace(/[の之的]/gu, "")
    .replace(/[「」『』《》【】“”"'`]/gu, "")
    .replace(/[：:・·･．.－—–_\-\s]/gu, "")
    .replace(/[，,。.!！?？;；、()（）\[\]{}]/gu, "")
    .trim();
}

function buildBaigeSearchQueries(value) {
  const original = String(value || "").trim();
  const canonicalSpelling = original;
  const numberedIdentity = extractNumberedCardIdentities(canonicalSpelling)[0];
  if (numberedIdentity) {
    const tail = canonicalSpelling
      .replace(/^(?:[「『《【“"']\s*)?(?:混沌\s*(?:No|编号|編號)|Chaos\s+Number|C\s*No|Number|No|编号|編號)\s*[.．]?\s*\d{1,4}\s*/iu, "")
      .replace(/[」』》】”"']$/u, "")
      .trim();
    const prefixes = numberedIdentity.family === "cno"
      ? [`CNo.${numberedIdentity.number}`, `混沌No.${numberedIdentity.number}`, `混沌编号${numberedIdentity.number}`]
      : [`No.${numberedIdentity.number}`, `编号${numberedIdentity.number}`];
    return [...new Set([original, canonicalSpelling, ...prefixes.map((prefix) => `${prefix}${tail ? ` ${tail}` : ""}`)].filter(Boolean))].slice(0, 6);
  }
  const compact = canonicalSpelling.replace(/[「」『』《》【】“”"'`：:・·･．.－—–_\-\s，,。.!！?？;；、()（）\[\]{}]/gu, "");
  const tokens = canonicalSpelling
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token !== original);
  const longerPrefix = compact.length >= 7 ? compact.slice(0, 4) : "";
  const shortPrefix = compact.length >= 6 ? compact.slice(0, 2) : "";
  const suffix = compact.length >= 7 ? compact.slice(-4) : "";
  return [...new Set([original, compact, ...tokens, longerPrefix, shortPrefix, suffix].filter(Boolean))].slice(0, 6);
}

function diceCoefficient(left, right) {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  const counts = new Map();
  for (const item of leftBigrams) counts.set(item, (counts.get(item) || 0) + 1);
  let intersection = 0;
  for (const item of rightBigrams) {
    const count = counts.get(item) || 0;
    if (!count) continue;
    counts.set(item, count - 1);
    intersection += 1;
  }
  return (2 * intersection) / (leftBigrams.length + rightBigrams.length);
}

function boundedEditDistance(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]
        + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      const value = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution,
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

function bigrams(value) {
  const result = [];
  for (let index = 0; index < value.length - 1; index += 1) result.push(value.slice(index, index + 2));
  return result;
}

function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function safeErrorMessage(error) {
  return String(error instanceof Error ? error.message : error || "unknown").replace(/\s+/gu, "_").slice(0, 120);
}
