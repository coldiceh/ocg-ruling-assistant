const NUMBERED_PREFIX_PATTERN = /(?:混沌\s*(?:no|编号|編號)|chaos\s+number|c\s*no|number|no|编号|編號)\s*[.．]?\s*\d{1,4}/iu;

export function canonicalizeNumberedCardPrefixes(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/混沌\s*(?:no|编号|編號)\s*\.?\s*(\d{1,4})/giu, "cno$1")
    .replace(/\bchaos\s+number\s*\.?\s*(\d{1,4})/giu, "cno$1")
    .replace(/\bc\s*no\s*\.?\s*(\d{1,4})/giu, "cno$1")
    .replace(/\bnumber\s*\.?\s*(\d{1,4})/giu, "no$1")
    .replace(/(?:编号|編號)\s*\.?\s*(\d{1,4})/gu, "no$1")
    .replace(/\bno\s*\.?\s*(\d{1,4})/giu, "no$1");
}

export function extractNumberedCardIdentities(value) {
  const canonical = canonicalizeNumberedCardPrefixes(value).toLowerCase();
  const result = [];
  const seen = new Set();
  for (const match of canonical.matchAll(/(cno|no)(\d{1,4})(?!\d)/gu)) {
    const identity = { family: match[1], number: Number.parseInt(match[2], 10) };
    const key = `${identity.family}:${identity.number}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(identity);
    }
  }
  return result;
}

export function hasNumberedCardIdentityConflict(reference, candidate) {
  const references = extractNumberedCardIdentities(reference);
  const candidates = extractNumberedCardIdentities(candidate);
  if (!references.length || !candidates.length) return false;
  return !candidates.some((candidateIdentity) => references.some((referenceIdentity) => (
    candidateIdentity.family === referenceIdentity.family
    && candidateIdentity.number === referenceIdentity.number
  )));
}

export function extractNumberedCardMentionCandidates(value) {
  const text = String(value || "").normalize("NFKC");
  const result = [];
  const seen = new Set();
  const prefix = "(?:混沌\\s*(?:No|编号|編號)|Chaos\\s+Number|C\\s*No|Number|No|编号|編號)";
  const pattern = new RegExp(
    `(${prefix}\\s*[.．]?\\s*\\d{1,4}\\s+[\\p{L}\\p{N}・·･.．\\-－—–_:：\\s]{1,60}?)(?=\\s*(?:为素材|作為素材|作为素材|超量召唤|超量召喚|发动|發動|的?[①②③④⑤⑥⑦⑧⑨⑩]?效果|，|,|。|；|;|、|$))`,
    "giu",
  );
  for (const match of text.matchAll(pattern)) {
    const mention = String(match[1] || "").replace(/\s+/gu, " ").trim();
    const key = canonicalizeNumberedCardPrefixes(mention).toLowerCase().replace(/\s+/gu, "");
    if (!mention || !NUMBERED_PREFIX_PATTERN.test(mention) || seen.has(key)) continue;
    seen.add(key);
    result.push(mention);
  }
  return result;
}
