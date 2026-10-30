// Mechanical HTML text helpers for the benchmark extractors. They decode
// character references only; any markup inside a captured text cell is
// reported instead of being guessed at, so an unexpected source change fails
// loudly rather than silently changing a question.

const NAMED_ENTITIES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
});

export function decodeHtmlEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, body) => {
    if (body[0] === "#") {
      const codePoint = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new Error(`html_entity_invalid:${match}`);
      }
      return String.fromCodePoint(codePoint);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    if (named === undefined) throw new Error(`html_entity_unsupported:${match}`);
    return named;
  });
}

// Returns the decoded text of a captured cell. Markup inside the cell is an
// extraction error: the caller decides how to report it.
export function cellText(rawHtml, label) {
  const tag = /<[^>]+>/u.exec(rawHtml);
  if (tag) throw new Error(`html_cell_contains_markup:${label}:${tag[0]}`);
  return decodeHtmlEntities(rawHtml);
}
