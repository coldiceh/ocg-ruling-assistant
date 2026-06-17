const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
const baigeApiBase = "https://ygocdb.com/api/v0/";

export default async function handler(request, response) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const query = getQuery(request);
  const name = firstString(query.name);
  const jaName = firstString(query.jaName);
  const enName = firstString(query.enName);
  const id = normalizeId(firstString(query.id));
  const search = name || jaName || enName || id;

  if (!search) {
    response.status(400).json({ error: "Missing card name" });
    return;
  }

  try {
    const card = await loadBaigeCard({ id, names: [name, jaName, enName].filter(Boolean) });
    if (!card) {
      response.status(404).json({ error: "Card not found" });
      return;
    }
    response.status(200).json(card);
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function loadBaigeCard({ id, names }) {
  const attempts = [];
  if (id) attempts.push({ id, query: id });
  for (const name of names) attempts.push({ id, query: name });

  const errors = [];
  for (const attempt of attempts) {
    try {
      const payload = await fetchBaigeSearch(attempt.query);
      const cards = collectBaigeCards(payload);
      const best = pickBestCard(cards, attempt);
      if (best) return normalizeBaigeCard(best, attempt);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length) throw new Error(errors[0]);
  return null;
}

async function fetchBaigeSearch(query) {
  const url = new URL(baigeApiBase);
  url.searchParams.set("search", query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "ocg-ruling-assistant/0.2",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Baige API ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
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

    const id = normalizeId(value.id || value.cid || value.cardId || value.password || value.passcode || value.ot);
    const name = value.name || value.cn_name || value.cnName || value.sc_name || value.zh_name || value.title || "";
    const text = extractEffectText(value);
    if (id && (name || text)) {
      const key = `${id}:${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(value);
      }
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") visit(child);
    }
  }

  visit(payload?.result || payload?.data || payload?.cards || payload);
  return result;
}

function pickBestCard(cards, attempt) {
  if (!cards.length) return null;
  const id = normalizeId(attempt.id);
  const queryKey = normalizeKey(attempt.query);

  let best = null;
  for (const card of cards) {
    const cardId = normalizeId(card.id || card.cid || card.cardId || card.password || card.passcode || card.ot);
    const names = collectNames(card);
    let score = 0;
    if (id && cardId === id) score += 100;
    for (const name of names) {
      const nameKey = normalizeKey(name);
      if (!nameKey || !queryKey) continue;
      if (nameKey === queryKey) score += 80;
      else if (nameKey.includes(queryKey) || queryKey.includes(nameKey)) score += 45;
      else score += Math.round(diceCoefficient(nameKey, queryKey) * 30);
    }
    if (!best || score > best.score) best = { card, score };
  }

  return best?.card || cards[0];
}

function normalizeBaigeCard(card, attempt) {
  const id = normalizeId(card.id || card.cid || card.cardId || card.password || card.passcode || card.ot || attempt.id);
  const names = collectNames(card);
  const name = names[0] || attempt.query || id;
  const effectText = extractEffectText(card);
  const meta = [card.type, card.race, card.attribute, card.level || card.rank || card.link, buildAtkDef(card)]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(" / ");

  return {
    id,
    name,
    names,
    meta,
    effectText,
    imageUrl: collectImageCandidates(card, id)[0] || "",
    imageCandidates: collectImageCandidates(card, id),
    sourceUrl: id ? `https://ygocdb.com/card/${id}` : "https://ygocdb.com/",
  };
}

function collectNames(card) {
  return [
    card.name,
    card.cn_name,
    card.cnName,
    card.sc_name,
    card.zh_name,
    card.ja_name,
    card.jaName,
    card.jp_name,
    card.en_name,
    card.enName,
    card.nwbbs_n,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function extractEffectText(card) {
  const direct = [
    card.desc,
    card.effect,
    card.effectText,
    card.text,
    card.cn_desc,
    card.zh_desc,
    card.sc_desc,
    card.nwbbs_text,
  ].find((value) => typeof value === "string" && value.trim());
  if (direct) return cleanText(direct);

  const texts = [];
  function visit(value, key = "") {
    if (!value) return;
    if (typeof value === "string") {
      if (/desc|effect|text/i.test(key) && value.trim().length > 8) texts.push(cleanText(value));
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
  return texts.sort((a, b) => b.length - a.length)[0] || "";
}

function buildAtkDef(card) {
  const parts = [];
  if (card.atk !== undefined && card.atk !== null) parts.push(`ATK ${card.atk}`);
  if (card.def !== undefined && card.def !== null) parts.push(`DEF ${card.def}`);
  return parts.join(" / ");
}

function buildImageCandidates(id) {
  if (!id) return [];
  const compactId = id.replace(/^0+/, "") || id;
  return [
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg!half`,
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${compactId}.webp!half`,
    `https://images.ygoprodeck.com/images/cards/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygopro/pics/${id}.jpg`,
    `https://cdn.233.momobako.com/ygopro/pics/${id}.jpg!half`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${id}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${id}.webp!half`,
  ];
}

function collectImageCandidates(card, id) {
  const candidates = [];
  function add(value) {
    if (!value) return;
    const text = String(value).trim();
    if (!text) return;
    if (/^https?:\/\//i.test(text)) {
      candidates.push(text);
      return;
    }
    if (/^\/\//.test(text)) {
      candidates.push(`https:${text}`);
      return;
    }
    if (/\.(?:jpg|jpeg|png|webp)(?:!half)?(?:\?|$)/i.test(text)) {
      try {
        candidates.push(new URL(text, "https://ygocdb.com/").toString());
      } catch {
        // Ignore malformed image hints from the upstream payload.
      }
    }
  }

  function visit(value, key = "") {
    if (!value) return;
    if (typeof value === "string") {
      if (/img|image|pic|cover|art/i.test(key) || /\.(?:jpg|jpeg|png|webp)(?:!half)?(?:\?|$)/i.test(value)) add(value);
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
  return [...new Set([...candidates, ...buildImageCandidates(id)])];
}

function cleanText(value) {
  return decodeHtmlEntities(stripHtml(String(value || "")))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripHtml(value) {
  return value
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|section|article)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = String(entity).toLowerCase();
    if (lower[0] === "#") {
      const isHex = lower[1] === "x";
      const codePoint = Number.parseInt(lower.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
  });
}

function firstString(value) {
  return Array.isArray(value) ? String(value[0] || "").trim() : String(value || "").trim();
}

function getQuery(request) {
  if (request.query && Object.keys(request.query).length) return request.query;
  try {
    const url = new URL(request.url, "https://localhost");
    return Object.fromEntries(url.searchParams.entries());
  } catch {
    return {};
  }
}

function normalizeId(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (!digits) return "";
  return digits.length <= 8 ? digits.padStart(8, "0") : digits;
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function diceCoefficient(left, right) {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  let intersection = 0;
  const counts = new Map();
  for (const item of leftBigrams) counts.set(item, (counts.get(item) || 0) + 1);
  for (const item of rightBigrams) {
    const count = counts.get(item) || 0;
    if (!count) continue;
    counts.set(item, count - 1);
    intersection += 1;
  }
  return (2 * intersection) / (leftBigrams.length + rightBigrams.length);
}

function bigrams(value) {
  const result = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    result.push(value.slice(index, index + 2));
  }
  return result;
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}
