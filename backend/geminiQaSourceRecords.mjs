import { createQaSnapshot } from "./geminiQaTools.mjs";

const SOURCE_BASE_URL = "https://db.ygoresources.com/data/qa";
const SOURCE_ID = /^ygoresources-qa-(\d+)$/u;
const SOURCE_TIMEOUT_MS = 30_000;
const MAX_PAGE_CONCURRENCY = 4;

// normalizeQa owns the title/detail/answer roles. buildQaIndex derives `title`,
// `question` and `text` from those roles for display and search. The prompt uses
// the source roles once; the complete frozen record still owns the handle.
// Unknown source schemas keep all fields. No cross-field meaning comparison.
export function canonicalQaPromptRecord(record) {
  const answerField = Object.hasOwn(record, 'answer') && !Object.hasOwn(record, 'conclusion') ? 'answer'
    : Object.hasOwn(record, 'conclusion') && !Object.hasOwn(record, 'answer') ? 'conclusion' : null;
  if (record.recordType !== 'qa' || !SOURCE_ID.test(String(record.id || '')) || !answerField
      || typeof record.rawQuestion !== 'string' || typeof record.rawDetailedQuestion !== 'string'
      || typeof record[answerField] !== 'string' || Object.hasOwn(record, 'sourceQa')) return record;
  const derivedKeys = new Set(['title', 'question', 'text', 'rawQuestion', 'rawDetailedQuestion', answerField]);
  return {
    ...Object.fromEntries(Object.entries(record).filter(([key]) => !derivedKeys.has(key))),
    sourceQa: { title: record.rawQuestion, question: record.rawDetailedQuestion, answer: record[answerField] },
  };
}

function sourceError(code, { status, url, cause } = {}) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  if (status !== undefined) error.status = status;
  if (url !== undefined) error.url = url;
  return error;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function needsSourceRecord(record) {
  return isObject(record)
    && record.recordType === "qa"
    && SOURCE_ID.test(String(record.id || ""))
    && !Object.hasOwn(record, "answer")
    && !Object.hasOwn(record, "conclusion");
}

function responseRevision(response) {
  const value = response?.headers?.get?.("X-Cache-Revision");
  return typeof value === "string" ? value : "";
}

function sourceUrl(id) {
  return `${SOURCE_BASE_URL}/${id}`;
}

function sourceRecord(payload, { id, baseRevision, revision, url }) {
  const ja = payload?.qaData?.ja;
  if (!isObject(ja)) throw sourceError("source_qa_ja_invalid", { url });
  if (!Number.isSafeInteger(ja.id) || String(ja.id) !== id) {
    throw sourceError("source_qa_id_binding_invalid", { url });
  }
  if (["title", "question", "answer"].some((key) => (
    !Object.hasOwn(ja, key) || typeof ja[key] !== "string"
  ))) {
    throw sourceError("source_qa_body_fields_invalid", { url });
  }
  if (!Array.isArray(payload.cards)
      || payload.cards.some((cardId) => !Number.isSafeInteger(cardId) || cardId < 0)) {
    throw sourceError("source_qa_card_ids_invalid", { url });
  }

  const canonical = {
    id: `ygoresources-qa-${id}`,
    recordType: "qa",
    cardIds: [...new Set(payload.cards.map(String))],
    sourceId: id,
    sourceName: "YGOResources DB",
    sourceUrl: url,
    sourceRevision: revision,
    sourceQa: ja,
  };
  const snapshot = createQaSnapshot({ records: [canonical], qaRevision: baseRevision });
  const snapshotTools = snapshot.createQaTools();
  const handle = snapshot.snapshotHandles[0];
  const record = snapshotTools.readSelected([handle])[0].record;
  return Object.freeze({ kind: "record", handle, record });
}

async function fetchSource({ fetchImpl, id, baseRevision }) {
  const url = sourceUrl(id);
  const timeoutSignal = AbortSignal.timeout(SOURCE_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", redirect: "error", signal: timeoutSignal });
  } catch (cause) {
    if (timeoutSignal.aborted) throw sourceError("source_http_timeout", { url, cause });
    throw sourceError("source_http_network", { url, cause });
  }
  const status = Number(response?.status);
  if (status === 404 || status === 410) {
    return Object.freeze({ kind: "unavailable", id: `ygoresources-qa-${id}`, url, status });
  }
  if (!response?.ok) throw sourceError(`source_http_${status}`, { status, url });

  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw sourceError("source_qa_json_invalid", { status, url, cause });
  }
  return sourceRecord(payload, {
    id,
    baseRevision,
    revision: responseRevision(response),
    url,
  });
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(sourceError("source_request_aborted"));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(sourceError("source_request_aborted"));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function mapConcurrent(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function unavailableItem(result) {
  return Object.freeze({
    unavailable: true,
    id: result.id,
    recordType: "qa",
    sourceUrl: result.url,
    httpStatus: result.status,
  });
}

function deliveredItem(source) {
  const item = { handle: source.handle, record: source.record };
  for (const key of ["sourceAuthority", "sourceTier", "official"]) {
    if (Object.hasOwn(source.record, key)) item[key] = source.record[key];
  }
  return Object.freeze(item);
}

/**
 * Add source-backed canonical records to one request-scoped QA tool view.
 * Search order and cursors remain owned by the base QA tools; this wrapper only
 * replaces legacy source-schema records after a page is selected.
 */
export function createSourceBackedQaTools({ qaTools, fetchImpl = globalThis.fetch, signal } = {}) {
  if (!qaTools || typeof qaTools.search !== "function" || typeof qaTools.readSelected !== "function") {
    throw new TypeError("source_qa_tools_invalid");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("source_qa_fetch_invalid");
  const baseRevision = String(qaTools.qaRevision || "").trim();
  if (!baseRevision) throw new TypeError("source_qa_revision_invalid");
  const delivered = new Map();
  const requestSources = new Map();

  function requestSource(id) {
    const existing = requestSources.get(id);
    if (existing) return existing;
    const pending = waitWithSignal(fetchSource({ fetchImpl, id, baseRevision }), signal);
    requestSources.set(id, pending);
    pending.catch(() => {
      if (requestSources.get(id) === pending) requestSources.delete(id);
    });
    return pending;
  }

  async function search(args = {}) {
    const page = await qaTools.search(args);
    if (!page || !Array.isArray(page.items)) throw new TypeError("source_qa_search_page_invalid");
    const items = await mapConcurrent(page.items, MAX_PAGE_CONCURRENCY, async (item) => {
      if (!needsSourceRecord(item?.record)) return item;
      const match = SOURCE_ID.exec(String(item.record.id));
      const source = await requestSource(match[1]);
      return source.kind === "unavailable" ? unavailableItem(source) : deliveredItem(source);
    });

    for (const item of items) {
      if (!item?.handle) continue;
      const prior = delivered.get(item.handle);
      if (prior && prior.record !== item.record) throw new Error("source_qa_handle_binding_invalid");
      delivered.set(item.handle, item);
    }
    const frozenItems = Object.freeze(items);
    return Object.freeze({
      ...page,
      items: frozenItems,
      handles: Object.freeze(items.flatMap((item) => item?.handle ? [item.handle] : [])),
    });
  }

  function readSelected(handles = []) {
    if (!Array.isArray(handles)) throw new TypeError("gemini_qa_handles_invalid");
    const seen = new Set();
    const selected = [];
    for (const rawHandle of handles) {
      const handle = String(rawHandle || "").trim();
      if (seen.has(handle)) continue;
      const item = delivered.get(handle);
      if (!item) throw new Error("source_qa_handle_not_delivered");
      seen.add(handle);
      selected.push(item);
    }
    return Object.freeze(selected);
  }

  return Object.freeze({ ...qaTools, search, readSelected });
}
