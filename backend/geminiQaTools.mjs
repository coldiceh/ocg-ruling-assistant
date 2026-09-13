import crypto from "node:crypto";

import {
  buildManualCaptureCompleteLexicalQueryQueue,
  installManualCaptureLexicalIndex,
  serializeManualCaptureLexicalIndex,
} from "../scripts/lib/manual-capture-evidence-selection.mjs";

const QA_RECORD_TYPES = new Set(["qa", "card-faq"]);
const CURSOR_VERSION = 1;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function cloneAndFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("gemini_qa_record_cyclic_invalid");
  seen.add(value);
  for (const child of Object.values(value)) cloneAndFreeze(child, seen);
  seen.delete(value);
  return Object.freeze(value);
}

function cloneRecord(record) {
  let clone;
  try {
    clone = structuredClone(record);
  } catch (error) {
    throw new TypeError("gemini_qa_record_not_cloneable", { cause: error });
  }
  return cloneAndFreeze(clone);
}

function normalizeRevision(qaRevision) {
  const revision = String(qaRevision ?? "").trim();
  if (!revision) throw new TypeError("gemini_qa_revision_invalid");
  return revision;
}

function normalizePageSize(pageSize) {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new TypeError("gemini_qa_page_size_invalid");
  }
  return pageSize;
}

function normalizeCardIds(cardIds) {
  if (!Array.isArray(cardIds)) throw new TypeError("gemini_qa_card_ids_invalid");
  return Object.freeze([...new Set(cardIds
    .map((cardId) => String(cardId ?? "").trim())
    .filter(Boolean))].sort());
}

function snapshotRecords(records) {
  if (!Array.isArray(records)) throw new TypeError("gemini_qa_records_invalid");
  const selected = [];
  const ids = new Set();
  for (const input of records) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("gemini_qa_record_invalid");
    }
    const recordType = String(input.recordType || "").trim();
    if (!QA_RECORD_TYPES.has(recordType)) continue;
    const id = String(input.id || "").trim();
    if (!id || ids.has(id)) throw new Error("gemini_qa_record_identity_invalid");
    ids.add(id);
    selected.push(cloneRecord(input));
  }
  return Object.freeze(selected);
}

function makeCandidate(record, qaRevision) {
  // JSON is the source adapter's canonical complete body. This adapter only
  // preserves it and never compares parallel text fields for meaning.
  const text = JSON.stringify(record);
  if (typeof text !== "string" || !text) throw new Error("gemini_qa_record_body_invalid");
  const handle = sha256(canonicalJson({
    qaRevision,
    recordType: record.recordType,
    id: record.id,
    record,
  }));
  return Object.freeze({ binding: handle, handle, record, text });
}

function encodeCursor({ qaRevision, queryFingerprint, offset }) {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    qaRevision,
    queryFingerprint,
    offset,
  }), "utf8").toString("base64url");
}

function decodeCursor(cursor, { qaRevision, queryFingerprint, total }) {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (typeof cursor !== "string") throw new TypeError("gemini_qa_cursor_invalid");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (error) {
    throw new TypeError("gemini_qa_cursor_invalid", { cause: error });
  }
  if (!parsed || parsed.v !== CURSOR_VERSION
      || parsed.qaRevision !== qaRevision
      || parsed.queryFingerprint !== queryFingerprint
      || !Number.isSafeInteger(parsed.offset)
      || parsed.offset < 0 || parsed.offset > total) {
    throw new Error("gemini_qa_cursor_snapshot_mismatch");
  }
  return parsed.offset;
}

function normalizeQueries(queries) {
  const input = Array.isArray(queries) ? queries : [queries];
  const normalized = [];
  const seen = new Set();
  for (const query of input) {
    const text = String(query ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  if (!normalized.length) throw new TypeError("gemini_qa_queries_invalid");
  return Object.freeze(normalized);
}

function explicitAuthorityFields(record) {
  const fields = {};
  for (const key of ["sourceAuthority", "sourceTier", "official"]) {
    if (Object.hasOwn(record, key)) fields[key] = record[key];
  }
  return fields;
}

function publicItem(candidate) {
  const result = { handle: candidate.handle, record: candidate.record };
  Object.assign(result, explicitAuthorityFields(candidate.record));
  return Object.freeze(result);
}

function compareSourceIds(left, right) {
  const leftId = String(left);
  const rightId = String(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function mergeQueues(queues, byHandle) {
  const positions = queues.map(() => 0);
  const seen = new Set();
  const ordered = [];
  while (true) {
    let advanced = false;
    for (let queueIndex = 0; queueIndex < queues.length; queueIndex += 1) {
      const candidate = queues[queueIndex][positions[queueIndex]];
      if (!candidate) continue;
      positions[queueIndex] += 1;
      advanced = true;
      if (seen.has(candidate.handle)) continue;
      const stableCandidate = byHandle.get(candidate.handle);
      if (!stableCandidate) throw new Error("gemini_qa_candidate_binding_invalid");
      seen.add(candidate.handle);
      ordered.push(stableCandidate);
    }
    if (!advanced) break;
  }
  return Object.freeze(ordered);
}

function rankLexicalUnion(compiled, queries) {
  const queues = queries.map((query) => buildManualCaptureCompleteLexicalQueryQueue({
    query,
    candidates: compiled.candidates,
  }));
  return mergeQueues(queues, compiled.byHandle);
}

function explicitRecordCardIds(record) {
  if (!Array.isArray(record.cardIds)) return [];
  return [...new Set(record.cardIds
    .map((cardId) => String(cardId ?? "").trim())
    .filter(Boolean))];
}

function rankCardLinked(compiled, confirmedCardIds) {
  if (!confirmedCardIds.length) return Object.freeze([]);
  const confirmed = new Set(confirmedCardIds);
  return Object.freeze(compiled.candidates
    .map((candidate) => ({
      candidate,
      matchCount: explicitRecordCardIds(candidate.record)
        .filter((cardId) => confirmed.has(cardId)).length,
    }))
    .filter((item) => item.matchCount > 0)
    .sort((left, right) => (
      right.matchCount - left.matchCount
      || compareSourceIds(left.candidate.record.id, right.candidate.record.id)
    ))
    .map((item) => item.candidate));
}

function buildRequestTools(compiled, { pageSize = 4, cardIds = [] } = {}) {
  const limit = normalizePageSize(pageSize);
  const confirmedCardIds = normalizeCardIds(cardIds);
  const cardLinkedQueue = rankCardLinked(compiled, confirmedCardIds);

  function search({ queries, cursor } = {}) {
    const normalizedQueries = normalizeQueries(queries);
    const queryFingerprint = sha256(canonicalJson({ queries: normalizedQueries, cardIds: confirmedCardIds }));
    const lexical = compiled.candidates.length ? rankLexicalUnion(compiled, normalizedQueries) : Object.freeze([]);
    const ordered = mergeQueues([cardLinkedQueue, lexical], compiled.byHandle);
    const offset = decodeCursor(cursor, {
      qaRevision: compiled.qaRevision,
      queryFingerprint,
      total: ordered.length,
    });
    const items = ordered.slice(offset, offset + limit).map(publicItem);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < ordered.length
      ? encodeCursor({ qaRevision: compiled.qaRevision, queryFingerprint, offset: nextOffset })
      : null;
    return Object.freeze({
      qaRevision: compiled.qaRevision,
      items: Object.freeze(items),
      handles: Object.freeze(items.map((item) => item.handle)),
      cursor: nextCursor,
      nextCursor,
      hasMore: nextCursor !== null,
      total: ordered.length,
    });
  }

  function readSelected(handles = []) {
    if (!Array.isArray(handles)) throw new TypeError("gemini_qa_handles_invalid");
    const seen = new Set();
    const items = [];
    for (const rawHandle of handles) {
      const handle = String(rawHandle || "").trim();
      if (!/^[a-f0-9]{64}$/u.test(handle)) throw new TypeError("gemini_qa_handle_invalid");
      if (seen.has(handle)) continue;
      const candidate = compiled.byHandle.get(handle);
      if (!candidate) throw new Error("gemini_qa_handle_unknown");
      seen.add(handle);
      items.push(publicItem(candidate));
    }
    return Object.freeze(items);
  }

  return Object.freeze({
    qaRevision: compiled.qaRevision,
    pageSize: limit,
    cardIds: confirmedCardIds,
    snapshotSize: compiled.records.length,
    snapshotHandles: compiled.snapshotHandles,
    search,
    readSelected,
  });
}

/**
 * Compile and own one immutable process-level QA snapshot. The installed BM25
 * index remains attached to this candidate array; request card ids are supplied
 * only when createQaTools is called on the returned snapshot.
 */
export function createQaSnapshot({ records, qaRevision, lexicalIndexBytes } = {}) {
  const revision = normalizeRevision(qaRevision);
  const snapshot = snapshotRecords(records);
  const candidates = Object.freeze(snapshot.map((record) => makeCandidate(record, revision)));
  const byHandle = new Map(candidates.map((candidate) => [candidate.handle, candidate]));
  const snapshotHandles = Object.freeze(candidates.map((candidate) => candidate.handle));
  const compiled = { qaRevision: revision, records: snapshot, candidates, byHandle, snapshotHandles };

  if (lexicalIndexBytes !== undefined) {
    installManualCaptureLexicalIndex({ candidates, dataRevision: revision, bytes: lexicalIndexBytes });
  }

  function buildLexicalIndex() {
    const bytes = serializeManualCaptureLexicalIndex({ candidates, dataRevision: revision });
    installManualCaptureLexicalIndex({ candidates, dataRevision: revision, bytes });
    return bytes;
  }

  function installLexicalIndex(bytes) {
    return installManualCaptureLexicalIndex({ candidates, dataRevision: revision, bytes });
  }

  return Object.freeze({
    qaRevision: revision,
    records: snapshot,
    snapshotSize: snapshot.length,
    snapshotHandles,
    buildLexicalIndex,
    installLexicalIndex,
    createQaTools: (options = {}) => buildRequestTools(compiled, options),
  });
}

/**
 * Direct factory compatible with the verified experiment adapter. Production
 * callers should normally load one createQaSnapshot and create request views
 * from it so records and the installed index are not rebuilt per request.
 */
export function createQaTools({
  records,
  qaRevision,
  pageSize = 4,
  cardIds = [],
  lexicalIndexBytes,
  snapshot,
} = {}) {
  const prepared = snapshot || createQaSnapshot({ records, qaRevision, lexicalIndexBytes });
  if (!prepared || typeof prepared.createQaTools !== "function") {
    throw new TypeError("gemini_qa_snapshot_invalid");
  }
  return prepared.createQaTools({ pageSize, cardIds });
}
