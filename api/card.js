import { searchCards } from "../backend/baigeCardProvider.mjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

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
  const id = normalizeId(firstString(query.id));
  const name = firstString(query.name);
  const jaName = firstString(query.jaName);
  const enName = firstString(query.enName);
  const attempts = [id, name, jaName, enName].filter(Boolean);

  if (!attempts.length) {
    response.status(400).json({ error: "Missing card name" });
    return;
  }

  const warnings = [];
  for (const attempt of attempts) {
    const result = await searchCards(attempt, { env: process.env, limit: 5 });
    warnings.push(...(result.warnings || []));
    const best = pickBestApiCard(result.results || [], { id, query: attempt });
    if (!best) continue;
    attachImageProxy(request, best);
    response.status(200).json(toCardApiResponse(best, warnings));
    return;
  }

  response.status(404).json({ error: "Card not found", warnings });
}

function pickBestApiCard(cards, { id, query }) {
  if (!cards.length) return null;
  const normalizedId = normalizeId(id);
  if (normalizedId) {
    const exactId = cards.find((card) => normalizeId(card.id || card.cardId || card.passcode) === normalizedId);
    if (exactId) return exactId;
  }
  const queryKey = normalizeKey(query);
  return cards
    .slice()
    .sort((left, right) => {
      const leftExact = [left.cnName, left.name, left.jpName, left.jaName, left.enName].some((name) => normalizeKey(name) === queryKey) ? 1 : 0;
      const rightExact = [right.cnName, right.name, right.jpName, right.jaName, right.enName].some((name) => normalizeKey(name) === queryKey) ? 1 : 0;
      return rightExact - leftExact || Number(right.confidence || 0) - Number(left.confidence || 0);
    })[0];
}

function toCardApiResponse(card, warnings) {
  const names = [card.name, card.cnName, card.jpName, card.jaName, card.enName, ...(card.aliases || [])]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index);
  return {
    id: card.id || card.cardId || "",
    name: card.name || card.cnName || card.jpName || card.enName || "",
    names,
    meta: [card.type || card.cardType, card.race, card.attribute, card.level, buildAtkDef(card)]
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .join(" / "),
    effectText: card.text || card.effectText || "",
    sourceLabel: "百鸽",
    sourceUrl: card.sourceUrl || "",
    imageUrl: card.imageUrl || "",
    imageCandidates: card.imageCandidates || [],
    warnings,
  };
}

function attachImageProxy(request, card) {
  if (!card?.id) return;
  const proxyUrl = buildImageProxyUrl(request, card.id);
  if (!proxyUrl) return;
  card.imageUrl = proxyUrl;
  card.imageCandidates = [...new Set([proxyUrl, ...(card.imageCandidates || [])])];
}

function buildAtkDef(card) {
  const parts = [];
  if (card.atk !== undefined && card.atk !== null && card.atk !== "") parts.push(`ATK ${card.atk}`);
  if (card.def !== undefined && card.def !== null && card.def !== "") parts.push(`DEF ${card.def}`);
  return parts.join(" / ");
}

function buildImageProxyUrl(request, id) {
  const host = request.headers?.host;
  if (!host) return "";
  const proto = firstHeader(request.headers["x-forwarded-proto"]) || "https";
  const url = new URL(`${proto}://${host}/api/card-image`);
  url.searchParams.set("id", id);
  return url.toString();
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : String(value || "").split(",")[0].trim();
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
  const digits = String(value || "").replace(/\D+/gu, "");
  if (!digits) return "";
  return digits.length <= 8 ? digits.padStart(8, "0") : digits;
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}
