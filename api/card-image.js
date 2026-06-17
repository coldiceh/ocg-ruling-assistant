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
  if (!id) {
    response.status(400).json({ error: "Missing card id" });
    return;
  }

  const candidates = buildImageCandidates(id);
  for (const url of candidates) {
    try {
      const image = await fetchImage(url);
      if (!image) continue;
      response.setHeader("cache-control", "public, max-age=86400, s-maxage=604800");
      response.setHeader("content-type", image.contentType);
      response.status(200).send(Buffer.from(await image.arrayBuffer()));
      return;
    } catch {
      // Try the next image source.
    }
  }

  response.status(404).json({ error: "Card image not found" });
}

async function fetchImage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        referer: "https://ygocdb.com/",
        "user-agent": "Mozilla/5.0 ocg-ruling-assistant/0.2",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!/^image\//i.test(contentType)) return null;
    return {
      contentType,
      arrayBuffer: () => response.arrayBuffer(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildImageCandidates(id) {
  const compactId = id.replace(/^0+/, "") || id;
  return [
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg!half`,
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${compactId}.webp!half`,
    `https://images.ygoprodeck.com/images/cards/${compactId}.jpg`,
    `https://images.ygoprodeck.com/images/cards_cropped/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygopro/pics/${id}.jpg!half`,
    `https://cdn.233.momobako.com/ygopro/pics/${id}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${id}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${id}.webp!half`,
  ];
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

function setCors(response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}
