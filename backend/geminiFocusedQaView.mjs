import crypto from "node:crypto";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function clone(value) {
  return structuredClone(value);
}

function hasPopulatedField(record, key) {
  const value = record[key];
  return value !== undefined && value !== null && value !== ""
    && !(Array.isArray(value) && value.length === 0);
}

function isSchemaKnownFaq(record) {
  if (!record || record.recordType !== "card-faq" || typeof record.conclusion !== "string" || !record.conclusion) return false;
  // The FAQ adapter owns conclusion. If another body field is populated, preserving
  // the complete record is the only mechanical choice; comparing fields would infer
  // semantic coverage and could silently discard source material.
  return !["question", "answer", "rawQuestion", "rawDetailedQuestion", "fullText", "text"]
    .some((key) => hasPopulatedField(record, key));
}

function lineStartAt(source, index) {
  return index === 0 || source[index - 1] === "\n" || source[index - 1] === "\r";
}

function lineBreakLength(source, index) {
  if (source.startsWith("\r\n", index)) return 2;
  return source[index] === "\r" || source[index] === "\n" ? 1 : 0;
}

function lineEndIndex(source, start) {
  for (let index = start; index < source.length; index += 1) {
    if (lineBreakLength(source, index)) return index;
  }
  return source.length;
}

function segmentStarts(source) {
  const starts = new Set([0]);
  // Recognize blank paragraphs by consuming complete line-ending tokens. This
  // keeps a lone CRLF line break from being reinterpreted as CR followed by LF.
  for (let index = 0; index < source.length;) {
    const firstBreak = lineBreakLength(source, index);
    if (!firstBreak) { index += 1; continue; }
    let cursor = index + firstBreak;
    while (source[cursor] === " " || source[cursor] === "\t") cursor += 1;
    const secondBreak = lineBreakLength(source, cursor);
    if (secondBreak) {
      cursor += secondBreak;
      while (true) {
        while (source[cursor] === " " || source[cursor] === "\t") cursor += 1;
        const nextBreak = lineBreakLength(source, cursor);
        if (!nextBreak) break;
        cursor += nextBreak;
      }
      starts.add(cursor);
    }
    index += firstBreak;
  }
  // Bullet and full heading lines are source presentation boundaries. Their bytes
  // remain in the resulting segment; only the boundary is introduced here.
  for (let index = 0; index < source.length; index += 1) {
    if (!lineStartAt(source, index)) continue;
    const line = source.slice(index, lineEndIndex(source, index));
    if (source[index] === "■" || /^【[^】]*】[ \t]*$/u.test(line)) starts.add(index);
  }
  return [...starts].sort((left, right) => left - right);
}

function headingForSegment(source, start) {
  if (source[start] !== "【") return null;
  const end = lineEndIndex(source, start);
  const text = source.slice(start, end);
  return /^【[^】]*】[ \t]*$/u.test(text) ? { text, start, end } : null;
}

function copyDefined(record, target, keys) {
  for (const key of keys) if (Object.hasOwn(record, key)) target[key] = clone(record[key]);
}

function makeExcerpt(parent, parentHandle, qaRevision, source, start, end, heading) {
  const excerpt = {
    id: `${parent.id}-${start}-${end}`,
    recordType: "card-faq",
    title: parent.title,
    cards: clone(parent.cards),
    cardIds: clone(parent.cardIds),
    status: parent.status,
    conclusion: source.slice(start, end),
    sourceExcerpt: {
      parentRecordId: parent.id,
      parentHandle,
      qaRevision,
      bodyField: "conclusion",
      start,
      end,
      bodySha256: sha256(source),
      ...(heading ? { heading: clone(heading) } : {}),
    },
  };
  copyDefined(parent, excerpt, [
    "sourceAuthority", "sourceTier", "official", "updatedAt", "sources", "sourceName", "sourceUrl",
  ]);
  return Object.freeze(excerpt);
}

function expandFaq(item, qaRevision) {
  const parent = item.record;
  const source = parent.conclusion;
  const starts = segmentStarts(source);
  const segments = [];
  let heading = null;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? source.length;
    if (end <= start) continue;
    const ownHeading = headingForSegment(source, start);
    if (ownHeading) heading = ownHeading;
    const record = makeExcerpt(parent, item.handle, qaRevision, source, start, end, ownHeading ? null : heading);
    const handle = sha256(canonicalJson({ parentHandle: item.handle, qaRevision, start, end }));
    segments.push({ handle, record });
  }
  return segments;
}

/**
 * Present offered QA records as selectable source-defined units.
 *
 * Mechanical invariant: excerpt ranges partition the adapter-selected canonical
 * conclusion, so concatenating their conclusion fields reproduces it exactly.
 * PASS/FAIL uses only offsets, hashes, identity, and offered-handle membership;
 * no code infers relevance, completeness, or semantic equivalence. A false
 * positive here can only expose a presentation split; semantic choice remains LLM work.
 */
export function createFocusedQaView({ qaRevision, items = [] } = {}) {
  const revision = String(qaRevision ?? "").trim();
  if (!revision) throw new TypeError("gemini_focused_qa_revision_invalid");
  const offered = new Map();

  function add(input = []) {
    if (!Array.isArray(input)) throw new TypeError("gemini_focused_qa_items_invalid");
    const transformed = [];
    for (const item of input) {
      if (!item || typeof item !== "object" || typeof item.handle !== "string" || !item.record) {
        throw new TypeError("gemini_focused_qa_item_invalid");
      }
      const produced = isSchemaKnownFaq(item.record) ? expandFaq(item, revision) : [item];
      for (const next of produced) {
        if (offered.has(next.handle)) continue;
        const publicItem = Object.freeze(isSchemaKnownFaq(item.record)
          ? {
            handle: next.handle,
            record: next.record,
            ...(Object.hasOwn(next.record, "sourceAuthority") ? { sourceAuthority: next.record.sourceAuthority } : {}),
            ...(Object.hasOwn(next.record, "sourceTier") ? { sourceTier: next.record.sourceTier } : {}),
            ...(Object.hasOwn(next.record, "official") ? { official: next.record.official } : {}),
          }
          : { ...next });
        offered.set(next.handle, publicItem);
        transformed.push(publicItem);
      }
    }
    return Object.freeze(transformed);
  }

  add(items);

  function readSelected(handles = []) {
    if (!Array.isArray(handles)) throw new TypeError("gemini_focused_qa_handles_invalid");
    const seen = new Set();
    const result = [];
    for (const raw of handles) {
      const handle = String(raw ?? "").trim();
      if (!handle) throw new TypeError("gemini_focused_qa_handle_invalid");
      if (seen.has(handle)) continue;
      const selected = offered.get(handle);
      if (!selected) throw new Error("gemini_focused_qa_handle_unknown");
      seen.add(handle);
      result.push(Object.freeze({ handle, record: selected.record, text: JSON.stringify(selected.record) }));
    }
    return Object.freeze(result);
  }

  return Object.freeze({
    qaRevision: revision,
    add,
    get items() { return Object.freeze([...offered.values()]); },
    readSelected,
  });
}
