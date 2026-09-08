const SILICONFLOW_EMBEDDING_URL = 'https://api.siliconflow.cn/v1/embeddings';
const SILICONFLOW_EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-0.6B';
const SILICONFLOW_EMBEDDING_DIMENSIONS = 1024;
const SILICONFLOW_RERANK_URL = 'https://api.siliconflow.cn/v1/rerank';
const SILICONFLOW_RERANK_MODEL = 'Qwen/Qwen3-Reranker-8B';

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
}

function assertCallback(value, label, optional = false) {
  if (value === undefined && optional) return () => {};
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function validateEnvironment(env) {
  assertPlainObject(env, 'env');
  const apiKey = env.SILICONFLOW_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('SILICONFLOW_API_KEY is required');
  }
  return apiKey;
}

function validateFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be explicitly injected');
  }
  return fetchImpl;
}

function requestOptions(apiKey, body, signal) {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  };
}

function makeHttpError(operation, status) {
  const safeStatus = Number.isInteger(status) ? status : 'unknown';
  const error = new Error(`SiliconFlow ${operation} request failed with HTTP ${safeStatus}`);
  if (status !== undefined) error.status = status;
  return error;
}

function makeTransportError(operation) {
  return new Error(`SiliconFlow ${operation} request failed`);
}

function makeJsonError(operation) {
  return new Error(`SiliconFlow ${operation} response was not valid JSON`);
}

function elapsedSince(start) {
  return Math.max(0, performance.now() - start);
}

async function sendJsonRequest({ operation, url, body, env, fetchImpl, signal, beforeSend, onResponse }) {
  const apiKey = validateEnvironment(env);
  const fetchFunction = validateFetch(fetchImpl);
  const before = assertCallback(beforeSend, 'beforeSend');
  const responseCallback = assertCallback(onResponse, 'onResponse', true);
  const requestStarted = performance.now();

  const reservation = await before({ operation, model: body.model, count: operation === 'embeddings' ? body.input.length : body.documents.length });

  const fetchStarted = performance.now();
  let response;
  try {
    response = await fetchFunction(url, requestOptions(apiKey, body, signal));
  } catch {
    throw makeTransportError(operation);
  }
  const fetchMs = elapsedSince(fetchStarted);

  if (response === null || typeof response !== 'object') {
    throw new Error(`SiliconFlow ${operation} response object is invalid`);
  }
  if (response.ok !== true) {
    throw makeHttpError(operation, response.status);
  }
  if (typeof response.json !== 'function') {
    throw new Error(`SiliconFlow ${operation} response JSON reader is invalid`);
  }

  let rawResponse;
  const jsonStarted = performance.now();
  try {
    rawResponse = await response.json();
  } catch {
    throw makeJsonError(operation);
  }
  const jsonMs = elapsedSince(jsonStarted);

  await responseCallback(rawResponse, reservation);

  return {
    rawResponse,
    fetchMs,
    jsonMs,
    totalMs: elapsedSince(requestStarted),
  };
}

function validateIndexedEntries(entries, expectedCount, label) {
  assertArray(entries, `${label} data`);
  if (entries.length !== expectedCount) {
    throw new RangeError(`${label} data must cover every submitted item`);
  }

  const seenIndexes = new Set();
  for (let position = 0; position < entries.length; position += 1) {
    const entry = entries[position];
    assertPlainObject(entry, `${label} data[${position}]`);
    const index = entry.index;
    if (!Number.isSafeInteger(index) || index < 0 || index >= expectedCount) {
      throw new RangeError(`${label} data[${position}].index is outside the submitted batch`);
    }
    if (seenIndexes.has(index)) throw new RangeError(`${label} response contains a duplicate index`);
    seenIndexes.add(index);
  }
  for (let index = 0; index < expectedCount; index += 1) {
    if (!seenIndexes.has(index)) throw new RangeError(`${label} response does not cover every submitted index`);
  }
  return entries;
}

function parseEmbeddingPayload(payload, expectedCount) {
  assertPlainObject(payload, 'embedding response payload');
  const entries = validateIndexedEntries(payload.data, expectedCount, 'embedding');
  const vectors = new Array(expectedCount);
  for (const entry of entries) {
    assertArray(entry.embedding, `embedding data[${entry.index}].embedding`);
    if (entry.embedding.length !== SILICONFLOW_EMBEDDING_DIMENSIONS) {
      throw new RangeError(`embedding data[${entry.index}].embedding must have ${SILICONFLOW_EMBEDDING_DIMENSIONS} dimensions`);
    }
    for (let dimension = 0; dimension < entry.embedding.length; dimension += 1) {
      if (typeof entry.embedding[dimension] !== 'number' || !Number.isFinite(entry.embedding[dimension])) {
        throw new TypeError(`embedding data[${entry.index}].embedding[${dimension}] must be finite`);
      }
    }
    vectors[entry.index] = entry.embedding;
  }
  return vectors;
}

function parseRerankPayload(payload, expectedCount) {
  assertPlainObject(payload, 'rerank response payload');
  const entries = validateIndexedEntries(payload.results, expectedCount, 'rerank');
  const scores = new Array(expectedCount);
  for (const entry of entries) {
    if (typeof entry.relevance_score !== 'number' || !Number.isFinite(entry.relevance_score)) {
      throw new TypeError(`rerank results[${entry.index}].relevance_score must be finite`);
    }
    scores[entry.index] = entry.relevance_score;
  }
  return scores;
}

function usageFromPayload(payload) {
  if (payload.usage !== undefined) return payload.usage;
  if (payload.meta?.billed_units !== undefined) return payload.meta.billed_units;
  return null;
}

export async function callSiliconFlowEmbeddings({
  inputs,
  env,
  fetchImpl,
  signal,
  beforeSend,
  onResponse,
} = {}) {
  assertArray(inputs, 'inputs');
  if (inputs.length === 0) throw new RangeError('inputs must contain at least one input');
  inputs.forEach((input, index) => assertNonEmptyString(input, `inputs[${index}]`));
  const body = {
    model: SILICONFLOW_EMBEDDING_MODEL,
    input: inputs,
    dimensions: SILICONFLOW_EMBEDDING_DIMENSIONS,
    encoding_format: 'float',
  };
  const sent = await sendJsonRequest({
    operation: 'embeddings',
    url: SILICONFLOW_EMBEDDING_URL,
    body,
    env,
    fetchImpl,
    signal,
    beforeSend,
    onResponse,
  });
  const vectors = parseEmbeddingPayload(sent.rawResponse, inputs.length);
  return {
    rawResponse: sent.rawResponse,
    usage: usageFromPayload(sent.rawResponse),
    vectors,
    model: SILICONFLOW_EMBEDDING_MODEL,
    timing: { fetchMs: sent.fetchMs, jsonMs: sent.jsonMs, totalMs: sent.totalMs },
  };
}

export async function callSiliconFlowRerank({
  query,
  documents,
  instruction,
  env,
  fetchImpl,
  signal,
  beforeSend,
  onResponse,
} = {}) {
  assertNonEmptyString(query, 'query');
  assertArray(documents, 'documents');
  if (documents.length === 0) throw new RangeError('documents must contain at least one document');
  documents.forEach((document, index) => assertNonEmptyString(document, `documents[${index}]`));
  assertNonEmptyString(instruction, 'instruction');
  const body = {
    model: SILICONFLOW_RERANK_MODEL,
    query,
    documents,
    instruction,
    top_n: documents.length,
    return_documents: false,
  };
  const sent = await sendJsonRequest({
    operation: 'rerank',
    url: SILICONFLOW_RERANK_URL,
    body,
    env,
    fetchImpl,
    signal,
    beforeSend,
    onResponse,
  });
  const scores = parseRerankPayload(sent.rawResponse, documents.length);
  return {
    rawResponse: sent.rawResponse,
    usage: usageFromPayload(sent.rawResponse),
    scores,
    model: SILICONFLOW_RERANK_MODEL,
    timing: { fetchMs: sent.fetchMs, jsonMs: sent.jsonMs, totalMs: sent.totalMs },
  };
}
