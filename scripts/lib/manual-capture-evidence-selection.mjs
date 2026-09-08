import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { normalizeCardKey } from "../../backend/ragCardExtractor.mjs";

const DEFAULT_MAX_RANKED_CANDIDATES = 256;
const MAX_ALLOWED_RANKED_CANDIDATES = 512;
const MAX_SERIALIZED_PROMPT_CHARS = 36_000;
const NEED_GENERATOR_MODEL = "gpt-5.6-sol";
const NEED_GENERATOR_REASONING_EFFORT = "medium";
const NEED_GENERATOR_MAX_COMPLETION_TOKENS = 4_096;
const DEFAULT_NEED_SHORTLIST_PER_NEED = 20;
const MIN_NEED_SHORTLIST_PER_NEED = 16;
const MAX_NEED_SHORTLIST_PER_NEED = 24;
// Frozen phase-2 manual Capture replay bounds, not production retrieval knobs.
const DEFAULT_NEED_SHORTLIST_GLOBAL_PREFIX = 48;
const DEFAULT_NEED_SHORTLIST_MIN = 64;
const DEFAULT_NEED_SHORTLIST_MAX = 96;
const TRUSTED_CONFIRMED_RESOLUTION_SOURCES = new Set([
  "query",
  "external_identity_verification",
  "numbered_identity_unique_localized_variant",
]);

const SELECTABLE_BUCKETS = Object.freeze([
  "officialQaDirectCandidates",
  "faqRelated",
  "officialQaRelated",
  "provisionalOfficialResponses",
  "rawRelatedEvidence",
]);

export const MANUAL_CAPTURE_RERANK_INSTRUCTION =
  "Rank official evidence by relevance and complementary support for the query. Do not answer the query.";

export const MANUAL_CAPTURE_NEED_GENERATOR_CONFIG = Object.freeze({
  model: NEED_GENERATOR_MODEL,
  reasoningEffort: NEED_GENERATOR_REASONING_EFFORT,
  maxCompletionTokens: NEED_GENERATOR_MAX_COMPLETION_TOKENS,
});

export const MANUAL_CAPTURE_NEED_GENERATOR_SYSTEM_INSTRUCTIONS = [
  "Decompose the supplied ruling question into atomic information needs only.",
  "Use only the question and confirmed complete card texts in the input.",
  "Do not answer the question, judge evidence support, select evidence, or invent facts.",
  "List the intermediate propositions that must be verified to connect the stated facts to any conclusion; do not skip an implicit transition merely because the surface outcome is named.",
  "When an object may change location, state, identity, controller, type, attribute, or applicable conditions, create separate needs for how it is referred to before and after that change and which conditions apply at each point.",
  "Each need must describe one independently outcome-changing condition or processing consequence.",
  "Return one JSON object containing informationNeeds. Each item contains only need.",
].join("\n");

export function manualCaptureNeedPromptSha256({ systemInstructions, input } = {}) {
  if (typeof systemInstructions !== "string"
      || !input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("manual_capture_information_needs_prompt_binding_invalid");
  }
  return sha256(`${systemInstructions}\u0000${JSON.stringify(input)}`);
}

export function buildManualCaptureNeedGeneratorRequest({
  caseId,
  question,
  confirmedCardTexts,
  signal,
} = {}) {
  const normalizedCaseId = String(caseId || "").trim();
  const normalizedQuestion = String(question || "");
  if (!normalizedCaseId
      || !normalizedQuestion.trim()
      || !Array.isArray(confirmedCardTexts)
      || confirmedCardTexts.some((text) => !String(text || "").trim())) {
    throw new TypeError("manual_capture_information_needs_input_invalid");
  }
  const input = Object.freeze({
    question: normalizedQuestion,
    confirmedCardTexts: Object.freeze(confirmedCardTexts.map((text) => String(text))),
  });
  return Object.freeze({
    caseId: normalizedCaseId,
    ...MANUAL_CAPTURE_NEED_GENERATOR_CONFIG,
    systemInstructions: MANUAL_CAPTURE_NEED_GENERATOR_SYSTEM_INSTRUCTIONS,
    input,
    ...(signal === undefined ? {} : { signal }),
  });
}

export const MANUAL_CAPTURE_SELECTOR_SYSTEM_INSTRUCTIONS = [
  "You perform evidence-set selection only. You are not a ruling model or an answer grader.",
  "Never answer the question, state a final ruling, or use knowledge outside the supplied records.",
  "First identify every independent information need implied by the question, then identify the supplied candidate support for each need.",
  "Decompose the question into concrete outcome-changing conditions before selecting. A distinct condition that can independently change whether an action is permitted or how processing proceeds is a separate information need; do not collapse it into a broad topical paraphrase.",
  "Information-need coverage takes priority over compactness. Do not omit a need or necessary support merely to make the union smaller; only after coverage, avoid redundant records.",
  "Support for one need may be distributed across multiple candidate texts. No single candidate must cover the whole question or the whole need.",
  "Mark a need SUPPORTED only when the cited candidate texts jointly state its necessary condition and consequence. Topical similarity, analogy, generalized background, or partial support is insufficient.",
  "When a need depends on a card or object changing location, state, controller, or identity during resolution, ordinary-case processing text is not enough by itself. The cited support must jointly cover that changed condition and its resulting processing consequence.",
  "When a more specific candidate addresses an identified condition, include it instead of substituting only a general record. Do not discard non-redundant support to reduce the item count; compactness applies only after every supported need is covered.",
  "The final evidence set is the deterministic union of supportIndices from every SUPPORTED need and must fit the supplied 36000-character budget.",
  "Use UNSUPPORTED when the candidates contain no support for a need, and UNCERTAIN when the supplied text does not permit a reliable support judgment. Do not invent support.",
  "A relatedOnly record remains related context and is never upgraded into a direct official ruling. Uncertain identity never unlocks a card-specific FAQ.",
  "Return one JSON object containing informationNeeds only. Each item contains need, status, and supportIndices. Status is SUPPORTED, UNSUPPORTED, or UNCERTAIN.",
  "A SUPPORTED item has one or more integer candidate numbers. UNSUPPORTED and UNCERTAIN use an empty list.",
].join("\n");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function normalizedFingerprintValue(value) {
  if (typeof value === "string") {
    return value.normalize("NFKC").replace(/\s+/gu, "").trim();
  }
  if (Array.isArray(value)) return value.map(normalizedFingerprintValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, normalizedFingerprintValue(item)]));
  }
  return value;
}

function itemId(item = {}) {
  return String(item?.id || item?.evidenceId || item?.stableId || "").trim();
}

function stableRecordKeys(item = {}) {
  const record = item?.record && typeof item.record === "object" ? item.record : item;
  return [...new Set([
    record?.id,
    record?.stableId,
    record?.evidenceId,
    record?.sourceId,
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function inferredSourceAuthority(record = {}) {
  const declaredAuthority = String(record.sourceAuthority || "").trim();
  const declaredTier = String(record.sourceTier || "").trim();
  const identity = [
    record.source,
    record.sourceName,
    record.sourceType,
    record.sourceId,
    record.id,
    declaredTier,
    declaredAuthority,
  ].filter(Boolean).join(" ");
  const community = declaredAuthority === "community_reference"
    || /^S2_/u.test(declaredTier)
    || /(?:^|[^a-z])ocg[-_ ]?rule(?:[^a-z]|$)|community|社区|社群/iu.test(identity)
    || ["rule-doc", "rule-test"].includes(String(record.recordType || ""));
  if (community) return "community_reference";
  if (record.official !== false && (
    declaredAuthority === "official_database"
    || declaredTier === "S0_OFFICIAL_DB_MIRROR"
    || ["qa", "card-faq", "official-database"].includes(record.recordType)
  )) return "official_database";
  if (record.official !== false && (
    declaredAuthority === "official_reference"
    || /^S0_OFFICIAL/u.test(declaredTier)
    || record.official === true
  )) return "official_database";
  if (record.official !== false && (
    declaredAuthority === "official_reference"
    || /^S0_OFFICIAL/u.test(declaredTier)
    || record.official === true
  )) return "official_reference";
  return declaredAuthority || "other_reference";
}

// This is intentionally byte-for-byte compatible with the shadow experiment's
// stable binding material. Checkpoint adapters may use the binding, but neither
// model-facing adapter receives an internal corpus id as a semantic hint.
export function manualCaptureCandidateStableFingerprint(item = {}, dataRevision = "") {
  const body = item?.body && typeof item.body === "object" ? item.body : item;
  const revision = String(dataRevision || "").trim();
  const canonicalId = itemId(body) || itemId(item);
  const sourceType = String(
    body?.sourceType || body?.recordType || item?.bucket || "",
  ).trim();
  if (!revision || !canonicalId || !sourceType) {
    throw new Error("manual_capture_stable_candidate_fingerprint_input_invalid");
  }
  const material = {
    dataRevision: revision,
    sourceType,
    internalCanonicalId: canonicalId,
    normalizedBodySha256: sha256(canonicalJson(normalizedFingerprintValue(body))),
    authorityVariant: {
      sourceAuthority: inferredSourceAuthority(body),
      sourceTier: String(body?.sourceTier || "").trim(),
      recordType: String(body?.recordType || "").trim(),
      bucket: String(item?.bucket || "").trim(),
      type: String(body?.type || "").trim(),
      official: body?.official === true ? true : body?.official === false ? false : null,
    },
  };
  return sha256(canonicalJson(material));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("manual_capture_evidence_selection_aborted");
  error.name = "AbortError";
  throw error;
}

function assertFunction(value, code) {
  if (typeof value !== "function") throw new TypeError(code);
}

function assertObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(code);
  }
}

const SOURCE_TEXT_FIELDS = Object.freeze([
  "title",
  "question",
  "rawQuestion",
  "rawDetailedQuestion",
  "answer",
  "text",
  "cardText",
  "description",
]);

function sourceText(item = {}) {
  const record = item?.record && typeof item.record === "object" ? item.record : item;
  const fields = [...SOURCE_TEXT_FIELDS, "cardReferenceContext"];
  return [...new Set(fields.map((key) => String(record?.[key] || "").trim()).filter(Boolean))]
    .join("\n");
}

function buildUniqueCardNameIndex(cards = []) {
  const namesById = new Map();
  const conflictingIds = new Set();
  for (const card of Array.isArray(cards) ? cards : []) {
    const id = String(card?.id ?? "").trim();
    const name = String(card?.name ?? "").trim();
    if (!/^\d+$/u.test(id) || !name || conflictingIds.has(id)) continue;
    if (!namesById.has(id)) {
      namesById.set(id, name);
    } else if (namesById.get(id) !== name) {
      namesById.delete(id);
      conflictingIds.add(id);
    }
  }
  return namesById;
}

function cardReferenceContext(record = {}, namesById = new Map()) {
  const seen = new Set();
  const rows = [];
  for (const field of SOURCE_TEXT_FIELDS) {
    for (const match of String(record?.[field] || "").matchAll(/<<(\d+)>>/gu)) {
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);
      if (namesById.has(id)) {
        rows.push(JSON.stringify({ id, name: namesById.get(id) }));
      }
    }
  }
  return rows.join("\n");
}

function localSearchTerms(value) {
  const normalized = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const terms = normalized.match(/[a-z0-9]+/gu) || [];
  const compact = [...normalized].filter((character) => /[\p{L}\p{N}]/u.test(character));
  for (const width of [2, 3]) {
    for (let index = 0; index + width <= compact.length; index += 1) {
      terms.push(`g${width}:${compact.slice(index, index + width).join("")}`);
    }
  }
  return terms;
}

function needText(item) {
  return String(
    typeof item === "string" ? item : item?.need ?? item?.description ?? item?.text ?? "",
  ).trim();
}

function unwrapNeedGeneratorValue(value) {
  let current = value;
  for (let depth = 0; depth < 2; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return current;
    const keys = Object.keys(current);
    if (keys.length !== 1 || !["output", "result", "response"].includes(keys[0])) return current;
    current = current[keys[0]];
  }
  return current;
}

function normalizeGeneratedInformationNeeds(value) {
  const unwrapped = unwrapNeedGeneratorValue(value);
  const rows = Array.isArray(unwrapped)
    ? unwrapped
    : unwrapped?.informationNeeds ?? unwrapped?.needs;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("manual_capture_information_needs_output_invalid");
  }
  const seen = new Set();
  const informationNeeds = [];
  for (const row of rows) {
    const need = needText(row);
    if (!need) throw new Error("manual_capture_information_needs_output_invalid");
    const key = need.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    informationNeeds.push(Object.freeze({ need }));
  }
  if (informationNeeds.length === 0) {
    throw new Error("manual_capture_information_needs_output_invalid");
  }
  return Object.freeze(informationNeeds);
}

export function parseManualCaptureInformationNeedsOutput(rawValue) {
  let text = String(rawValue || "").trim();
  const fenced = /^```(?:json|text)?\s*([\s\S]*?)\s*```$/iu.exec(text);
  if (fenced) text = fenced[1].trim();
  try {
    return {
      informationNeeds: normalizeGeneratedInformationNeeds(JSON.parse(text)),
    };
  } catch (error) {
    if (String(error?.message || "") === "manual_capture_information_needs_output_invalid") {
      throw error;
    }
    throw new Error("manual_capture_information_needs_output_invalid");
  } finally {
    text = "";
  }
}

function atomicWriteNeedCheckpoint(checkpointPath, value) {
  const temporary = `${checkpointPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, checkpointPath);
}

function loadNeedCheckpoint(checkpointPath) {
  if (!fs.existsSync(checkpointPath)) {
    return {
      schemaVersion: 1,
      kind: "manual-capture-atomic-needs-checkpoint",
      calls: [],
    };
  }
  const value = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  if (value?.schemaVersion !== 1
      || value?.kind !== "manual-capture-atomic-needs-checkpoint"
      || !Array.isArray(value.calls)
      || value.calls.some((call) => (
        !["submitted", "completed", "failed"].includes(call?.status)
        || !/^[a-f0-9]{64}$/u.test(String(call?.promptSha256 || ""))
      ))
      || value.calls.some((call) => call.status === "submitted")) {
    throw new Error("manual_capture_information_needs_checkpoint_invalid");
  }
  return value;
}

function safeNeedGeneratorRequestId(value) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(normalized) ? normalized : null;
}

export function createCheckpointedManualCaptureNeedGenerator({
  checkpointPath,
  request,
  env = process.env,
  relayBudget = null,
  onModelCall = () => {},
} = {}) {
  if (!String(checkpointPath || "").trim()
      || typeof request !== "function"
      || typeof onModelCall !== "function") {
    throw new TypeError("manual_capture_information_needs_configuration_invalid");
  }
  if (relayBudget !== null
      && !["reconcileCheckpointCalls", "reserve", "settle", "recordFailure"]
        .every((method) => typeof relayBudget?.[method] === "function")) {
    throw new TypeError("manual_capture_information_needs_budget_invalid");
  }
  const checkpointFile = path.resolve(checkpointPath);
  const checkpoint = loadNeedCheckpoint(checkpointFile);
  relayBudget?.reconcileCheckpointCalls({ namespace: "selector", calls: checkpoint.calls });

  const generateInformationNeeds = async ({
    caseId,
    model,
    reasoningEffort,
    maxCompletionTokens,
    systemInstructions,
    input,
    signal,
  } = {}) => {
    const diagnosticCaseId = String(caseId || "").trim();
    if (!/^case-\d{3}$/u.test(diagnosticCaseId)
        || model !== NEED_GENERATOR_MODEL
        || reasoningEffort !== NEED_GENERATOR_REASONING_EFFORT
        || maxCompletionTokens !== NEED_GENERATOR_MAX_COMPLETION_TOKENS
        || String(systemInstructions || "") !== MANUAL_CAPTURE_NEED_GENERATOR_SYSTEM_INSTRUCTIONS
        || !input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).length !== 2
        || !Object.hasOwn(input, "question")
        || !Object.hasOwn(input, "confirmedCardTexts")) {
      throw new Error("manual_capture_information_needs_request_invalid");
    }
    throwIfAborted(signal);
    const userPrompt = JSON.stringify(input);
    const promptSha256 = manualCaptureNeedPromptSha256({ systemInstructions, input });
    const existing = checkpoint.calls.find((call) => call.promptSha256 === promptSha256);
    if (existing) {
      if (existing.reasoningEffort !== NEED_GENERATOR_REASONING_EFFORT
          || existing.maxCompletionTokens !== NEED_GENERATOR_MAX_COMPLETION_TOKENS
          || existing.status !== "completed") {
        throw new Error("manual_capture_information_needs_checkpoint_binding_invalid");
      }
      return existing.result;
    }
    const callId = `${diagnosticCaseId}:atomic-needs:${promptSha256}:v1`;
    relayBudget?.reserve({
      namespace: "selector",
      callId,
      bindingSha256: promptSha256,
      systemPrompt: systemInstructions,
      userPrompt,
      maxCompletionTokens: NEED_GENERATOR_MAX_COMPLETION_TOKENS,
    });
    const call = {
      callId,
      caseId: diagnosticCaseId,
      status: "submitted",
      promptSha256,
      reasoningEffort: NEED_GENERATOR_REASONING_EFFORT,
      maxCompletionTokens: NEED_GENERATOR_MAX_COMPLETION_TOKENS,
      submittedAt: new Date().toISOString(),
    };
    checkpoint.calls.push(call);
    atomicWriteNeedCheckpoint(checkpointFile, checkpoint);
    onModelCall({ caseId: diagnosticCaseId, kind: "information_need_generation" });
    try {
      const response = await request({
        model: NEED_GENERATOR_MODEL,
        systemPrompt: systemInstructions,
        userPrompt,
        responseFormat: "json_object",
        reasoningEffort: NEED_GENERATOR_REASONING_EFFORT,
        maxCompletionTokens: NEED_GENERATOR_MAX_COMPLETION_TOKENS,
        parseResponse: parseManualCaptureInformationNeedsOutput,
        env,
      });
      const result = {
        informationNeeds: normalizeGeneratedInformationNeeds(response?.parsed),
      };
      relayBudget?.settle({
        namespace: "selector",
        callId,
        usage: response?.reportedUsage ?? response?.usage,
      });
      Object.assign(call, {
        status: "completed",
        completedAt: new Date().toISOString(),
        durationMs: Number(response?.durationMs || 0),
        requestId: safeNeedGeneratorRequestId(response?.requestId),
        reportedModel: String(response?.reportedModel || NEED_GENERATOR_MODEL),
        ...(response?.reportedUsage ? { reportedUsage: response.reportedUsage } : {}),
        ...(response?.usage ? { usage: response.usage } : {}),
        ...(response?.cost ? { cost: response.cost } : {}),
        outputSha256: sha256(canonicalJson(result)),
        result,
      });
      atomicWriteNeedCheckpoint(checkpointFile, checkpoint);
      return result;
    } catch (error) {
      const telemetry = error?.solEvidenceTelemetry;
      relayBudget?.recordFailure({
        namespace: "selector",
        callId,
        usage: telemetry?.reportedUsage ?? telemetry?.usage,
        outcomeKnown: error?.outcomeKnown,
        budgetReservationMayExist: error?.budgetReservationMayExist,
      });
      Object.assign(call, {
        status: "failed",
        failedAt: new Date().toISOString(),
        failureClassification: String(error?.code || error?.message || "need_generation_failed"),
        outcomeKnown: error?.outcomeKnown === true,
        budgetReservationMayExist: error?.budgetReservationMayExist !== false,
        ...(telemetry?.reportedUsage ? { reportedUsage: telemetry.reportedUsage } : {}),
        ...(telemetry?.usage ? { usage: telemetry.usage } : {}),
      });
      atomicWriteNeedCheckpoint(checkpointFile, checkpoint);
      throw error;
    }
  };

  return Object.freeze({ generateInformationNeeds, checkpoint });
}

const bm25CorpusCache = new WeakMap();
const completeLexicalCorpusCache = new WeakMap();

function prepareBm25Corpus(documentCount, termsAt) {
  const postings = new Map();
  const lengths = new Uint32Array(documentCount);
  let totalLength = 0;
  for (let index = 0; index < documentCount; index += 1) {
    const terms = termsAt(index);
    lengths[index] = terms.length;
    totalLength += terms.length;
    const frequencies = new Map();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) || 0) + 1);
    for (const [term, frequency] of frequencies) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push(index, frequency);
    }
  }
  for (const [term, entries] of postings) postings.set(term, Uint32Array.from(entries));
  const averageLength = totalLength / Math.max(1, documentCount);
  const k1 = 1.2;
  const b = 0.75;
  const lengthNormalizations = Float64Array.from(lengths, length => k1 * (
    1 - b + b * length / Math.max(1, averageLength)
  ));
  return { documentCount, postings, lengthNormalizations };
}

function bm25NeedScores(need, candidateTerms, preparedCorpus) {
  if (!preparedCorpus) {
    if (!bm25CorpusCache.has(candidateTerms)) bm25CorpusCache.set(candidateTerms,
      prepareBm25Corpus(candidateTerms.length, index => candidateTerms[index]));
    preparedCorpus = bm25CorpusCache.get(candidateTerms);
  }
  const { documentCount, postings, lengthNormalizations } = preparedCorpus;
  const queryTerms = [...new Set(localSearchTerms(need))];
  const scores = new Float64Array(documentCount);
  const k1 = 1.2;
  // Every document receives additions in the original query-term order, using
  // the unchanged BM25 expression. Postings replace repeated includes/Map work;
  // they neither remove zero-score documents nor alter the final stable sort.
  for (const term of queryTerms) {
    const entries = postings.get(term);
    if (!entries) continue;
    const documentFrequency = entries.length / 2;
    const inverseDocumentFrequency = Math.log(
      1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
    );
    for (let position = 0; position < entries.length; position += 2) {
      const index = entries[position];
      const frequency = entries[position + 1];
      const lengthNormalization = lengthNormalizations[index];
      scores[index] = scores[index] + inverseDocumentFrequency * (
        frequency * (k1 + 1) / (frequency + lengthNormalization)
      );
    }
  }
  return Array.from(scores);
}

function validateNeedShortlistLimit(value, name, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`manual_capture_need_shortlist_${name}_invalid`);
  }
}

// Returns only 1-based ranks into the frozen global ranking. The caller maps
// those ranks back to the original candidate objects; this function never
// clones or rewrites candidate bodies, bindings, or authority metadata.
export function buildManualCaptureNeedConditionedShortlistRanks({
  informationNeeds,
  candidates,
  perNeedLimit = DEFAULT_NEED_SHORTLIST_PER_NEED,
  globalPrefixLimit = DEFAULT_NEED_SHORTLIST_GLOBAL_PREFIX,
  minCandidates = DEFAULT_NEED_SHORTLIST_MIN,
  maxCandidates = DEFAULT_NEED_SHORTLIST_MAX,
} = {}) {
  if (!Array.isArray(informationNeeds) || !Array.isArray(candidates)) {
    throw new TypeError("manual_capture_need_shortlist_input_invalid");
  }
  validateNeedShortlistLimit(perNeedLimit, "per_need", MIN_NEED_SHORTLIST_PER_NEED);
  if (perNeedLimit > MAX_NEED_SHORTLIST_PER_NEED) {
    throw new TypeError("manual_capture_need_shortlist_per_need_invalid");
  }
  validateNeedShortlistLimit(globalPrefixLimit, "global_prefix");
  validateNeedShortlistLimit(minCandidates, "minimum", 1);
  validateNeedShortlistLimit(maxCandidates, "maximum", minCandidates);
  const needs = informationNeeds.map(needText).filter(Boolean);
  if (needs.length === 0) {
    throw new TypeError("manual_capture_need_shortlist_information_needs_invalid");
  }
  if (candidates.some((candidate) => !candidate || typeof candidate !== "object")) {
    throw new TypeError("manual_capture_need_shortlist_candidates_invalid");
  }

  const candidateCount = candidates.length;
  const candidateTerms = candidates.map((candidate) => localSearchTerms(candidate.text));
  const perNeedRankings = needs.map((need) => {
    const scores = bm25NeedScores(need, candidateTerms);
    return candidates.map((candidate, index) => ({
      rank: index + 1,
      score: scores[index],
    })).sort((left, right) => right.score - left.score || left.rank - right.rank)
      .map((item) => item.rank);
  });
  const globalPrefix = Array.from(
    { length: Math.min(globalPrefixLimit, candidateCount) },
    (_, index) => index + 1,
  );
  if (globalPrefix.length > maxCandidates) {
    throw new Error("manual_capture_need_shortlist_capacity_insufficient");
  }
  const selected = new Set(globalPrefix);
  for (let depth = 0;
    depth < Math.min(perNeedLimit, candidateCount) && selected.size < maxCandidates;
    depth += 1) {
    for (const ranks of perNeedRankings) {
      if (selected.size >= maxCandidates) break;
      if (ranks[depth]) selected.add(ranks[depth]);
    }
  }

  for (let depth = perNeedLimit;
    depth < candidateCount && selected.size < Math.min(minCandidates, candidateCount);
    depth += 1) {
    for (const ranks of perNeedRankings) {
      if (selected.size >= Math.min(minCandidates, candidateCount)) break;
      if (ranks[depth]) selected.add(ranks[depth]);
    }
  }
  return Object.freeze([...selected].sort((left, right) => left - right));
}

function candidateRecordIdentity(item = {}) {
  const body = item?.body && typeof item.body === "object" ? item.body : item;
  return `${String(body?.recordType || "").trim()}\u0000${itemId(body) || itemId(item)}`;
}

function pendingIdentityMentions(cardResolution = {}) {
  return [
    ...(cardResolution?.unresolvedMentions || []),
    ...(cardResolution?.ambiguousMentions || []),
  ];
}

function resolvedCardMatchesPendingMention(card = {}, mention = {}) {
  const mentionKey = normalizeCardKey(mention?.input);
  if (!mentionKey) return false;
  const originKeys = [card?.input, card?.matchedQuery]
    .map(normalizeCardKey)
    .filter(Boolean);
  if (originKeys.length > 0) return originKeys.includes(mentionKey);
  return [
    card?.name,
    card?.cnName,
    card?.jaName,
    card?.jpName,
    card?.enName,
    ...(card?.aliases || []),
  ].map(normalizeCardKey).filter(Boolean).includes(mentionKey);
}

function resolvedCardIsConfirmed(card = {}, pendingMentions = []) {
  const verification = String(card?.identityVerificationStatus || "").trim();
  const resolutionSource = String(card?.resolutionSource || "").trim();
  const requiresVerification = card?.requiresExternalIdentityVerification === true
    || card?.identityMatchKind === "edit_distance"
    || card?.retrievalIdentityMatchKind === "local_fuzzy";
  const externalIdentityVerified = resolutionSource !== "external_identity_verification"
    || /^verified_/u.test(verification);
  const ids = [card?.id, card?.cardId, card?.cid, card?.passcode]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return ids.length > 0
    && card?.identityCanonicalizationConflict !== true
    && TRUSTED_CONFIRMED_RESOLUTION_SOURCES.has(resolutionSource)
    && verification !== "unverified"
    && (!requiresVerification || /^verified_/u.test(verification))
    && externalIdentityVerified
    && !pendingMentions.some((mention) => resolvedCardMatchesPendingMention(card, mention));
}

function confirmedCardIds(cardResolution = {}) {
  const pendingMentions = pendingIdentityMentions(cardResolution);
  return new Set((cardResolution?.resolvedCards || [])
    .filter((card) => resolvedCardIsConfirmed(card, pendingMentions))
    .flatMap((card) => [card?.id, card?.cardId, card?.cid, card?.passcode])
    .map((value) => String(value || "").trim())
    .filter(Boolean));
}

function recordCardIds(record = {}) {
  return [...new Set([
    record?.cardId,
    ...(Array.isArray(record?.cardIds) ? record.cardIds : []),
    ...(Array.isArray(record?.questionCardIds) ? record.questionCardIds : []),
    ...(Array.isArray(record?.metadataCardIds) ? record.metadataCardIds : []),
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function officialQaRecordIsSafe(record = {}) {
  const recordType = String(record?.recordType || "").trim();
  const status = String(record?.status || "current").trim();
  return ["qa", "card-faq"].includes(recordType)
    && record?.official !== false
    && inferredSourceAuthority(record) !== "community_reference"
    && !["removed", "superseded", "conflict", "parse_failed"].includes(status);
}

function referenceRecordIsSafe(record = {}) {
  const recordType = String(record?.recordType || "").trim();
  const status = String(record?.status || "current").trim();
  return recordType === "rule-doc"
    && !["removed", "superseded", "conflict", "parse_failed"].includes(status);
}

function referenceParagraphRanges(text) {
  const ranges = [];
  const separator = /(?:\r\n|\r|\n)[\t\f\v ]*(?:\r\n|\r|\n)(?:(?:[\t\f\v ]*)(?:\r\n|\r|\n))*/gu;
  let start = 0;
  for (const match of text.matchAll(separator)) {
    const end = match.index + match[0].length;
    ranges.push({ start, end });
    start = end;
  }
  if (start < text.length || ranges.length === 0) {
    ranges.push({ start, end: text.length });
  }
  return ranges;
}

function splitReferenceRangeByUtf8Bytes(text, range, paragraphIndex, maxBodyBytes) {
  if (Buffer.byteLength(text.slice(range.start, range.end), "utf8") <= maxBodyBytes) {
    return [{
      ...range,
      paragraphStart: paragraphIndex,
      paragraphEnd: paragraphIndex + 1,
      byteLength: Buffer.byteLength(text.slice(range.start, range.end), "utf8"),
    }];
  }
  const pieces = [];
  let start = range.start;
  let offset = range.start;
  let byteLength = 0;
  while (offset < range.end) {
    const character = String.fromCodePoint(text.codePointAt(offset));
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (characterBytes > maxBodyBytes) {
      throw new Error("manual_capture_reference_paragraph_character_exceeds_max_body_bytes");
    }
    if (byteLength > 0 && byteLength + characterBytes > maxBodyBytes) {
      pieces.push({
        start,
        end: offset,
        paragraphStart: paragraphIndex,
        paragraphEnd: paragraphIndex + 1,
        byteLength,
      });
      start = offset;
      byteLength = 0;
    }
    byteLength += characterBytes;
    offset += character.length;
  }
  if (offset > start) {
    pieces.push({
      start,
      end: offset,
      paragraphStart: paragraphIndex,
      paragraphEnd: paragraphIndex + 1,
      byteLength,
    });
  }
  return pieces;
}

export function buildManualCaptureReferenceParagraphRecords(
  records,
  { maxBodyBytes } = {},
) {
  if (!Array.isArray(records)) {
    throw new TypeError("manual_capture_reference_paragraph_records_invalid");
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new TypeError("manual_capture_reference_paragraph_max_body_bytes_invalid");
  }
  const result = [];
  for (const record of records) {
    if (String(record?.recordType || "").trim() !== "rule-doc") continue;
    const sourceRecordId = itemId(record);
    if (!sourceRecordId || typeof record?.text !== "string") {
      throw new Error("manual_capture_reference_paragraph_record_invalid");
    }
    const sourceText = record.text;
    if (Buffer.byteLength(sourceText, "utf8") <= maxBodyBytes) {
      result.push(record);
      continue;
    }
    const sourceTextSha256 = sha256(sourceText);
    const paragraphRanges = referenceParagraphRanges(sourceText);
    const pieces = paragraphRanges.flatMap((range, paragraphIndex) => (
      splitReferenceRangeByUtf8Bytes(sourceText, range, paragraphIndex, maxBodyBytes)
    ));
    const chunkRanges = [];
    for (const piece of pieces) {
      const current = chunkRanges.at(-1);
      if (current && current.byteLength + piece.byteLength <= maxBodyBytes) {
        current.end = piece.end;
        current.paragraphEnd = piece.paragraphEnd;
        current.byteLength += piece.byteLength;
      } else {
        chunkRanges.push({ ...piece });
      }
    }
    for (const range of chunkRanges) {
      result.push(Object.freeze({
        ...record,
        id: `${sourceRecordId}#chars=${range.start}-${range.end}`,
        text: sourceText.slice(range.start, range.end),
        sourceRecordId,
        sourceTextSha256,
        sourceCharStart: range.start,
        sourceCharEnd: range.end,
        sourceParagraphStart: range.paragraphStart,
        sourceParagraphEnd: range.paragraphEnd,
        sourceOffsetUnit: "utf16_code_unit_end_exclusive",
      }));
    }
  }
  return Object.freeze(result);
}

function referenceRecordCandidate(record = {}) {
  const hasAuthority = Object.hasOwn(record, "sourceAuthority");
  const hasTier = Object.hasOwn(record, "sourceTier");
  const hasOfficial = Object.hasOwn(record, "official");
  if ((hasAuthority && record.sourceAuthority !== "community_reference")
      || (hasTier && record.sourceTier !== "S2_COMMUNITY_REFERENCE")
      || (hasOfficial && record.official !== false)) {
    throw new Error("manual_capture_reference_record_authority_conflict");
  }
  const id = itemId(record);
  const hasFullText = Object.hasOwn(record, "fullText");
  const body = {
    ...record,
    id,
    type: "rulebook",
    recordType: "rule-doc",
    ...(!hasFullText ? {
      fullText: String(record.text || ""),
      fullTextProjectionOf: "text",
    } : {}),
    ...(!hasAuthority ? { sourceAuthority: "community_reference" } : {}),
    ...(!hasTier ? { sourceTier: "S2_COMMUNITY_REFERENCE" } : {}),
    ...(!hasOfficial ? { official: false } : {}),
    isDirect: false,
  };
  const text = sourceText(body);
  if (!id || !text) {
    throw new Error("manual_capture_reference_record_invalid");
  }
  return {
    id,
    body,
    bodySha256: sha256(canonicalJson(body)),
    bucket: "rawRelatedEvidence",
    origin: "semantic_full_corpus",
    text,
    stableKeys: stableRecordKeys(record),
  };
}

function semanticCorpusCandidate(record = {}, { sameCardFaq = false, namesById } = {}) {
  const recordType = String(record.recordType || "").trim();
  const id = itemId(record);
  const referenceContext = cardReferenceContext(record, namesById);
  const body = {
    ...record,
    ...(referenceContext ? { cardReferenceContext: referenceContext } : {}),
    id,
    type: sameCardFaq ? "faq" : "related",
    recordType,
    fullText: String(record.text || record.answer || record.conclusion || ""),
    fullTextProjectionOf: record.text ? "text" : record.answer ? "answer" : record.conclusion ? "conclusion" : "",
    source: String(record.source || record.sourceName || ""),
    sourceName: String(record.sourceName || record.source || ""),
    sourceAuthority: "official_database",
    sourceTier: "S0_OFFICIAL_DB_MIRROR",
    official: true,
    isDirect: false,
    retrievalContext: {
      ...(record.retrievalContext && typeof record.retrievalContext === "object"
        ? record.retrievalContext
        : {}),
      scope: "semantic_full_corpus",
      relatedOnly: true,
    },
  };
  const text = sourceText(body);
  if (!id || !text || !["qa", "card-faq"].includes(recordType)) {
    throw new Error("manual_capture_official_corpus_record_invalid");
  }
  return {
    id,
    body,
    bodySha256: sha256(canonicalJson(body)),
    bucket: sameCardFaq ? "faqRelated" : "officialQaRelated",
    origin: "semantic_full_corpus",
    text,
    stableKeys: stableRecordKeys(record),
  };
}

export function buildSafeCandidates({
  officialQaRecords,
  referenceRecords = [],
  cardResolution,
  dataRevision,
  cards,
}) {
  const confirmedIds = confirmedCardIds(cardResolution);
  const namesById = buildUniqueCardNameIndex(cards);
  const candidateByIdentity = new Map();
  const add = (candidate) => {
    if (!candidate) return;
    const identity = candidateRecordIdentity(candidate);
    if (!identity || identity.endsWith("\u0000")) return;
    const previous = candidateByIdentity.get(identity);
    if (previous) {
      if (previous.bodySha256 !== candidate.bodySha256) {
        throw new Error("manual_capture_official_corpus_identity_conflict");
      }
      return;
    }
    candidateByIdentity.set(identity, candidate);
  };

  for (const record of officialQaRecords) {
    if (!officialQaRecordIsSafe(record)) continue;
    const sameCardFaq = record.recordType === "card-faq"
      && recordCardIds(record).some((id) => confirmedIds.has(id));
    add(semanticCorpusCandidate(record, { sameCardFaq, namesById }));
  }

  for (const record of referenceRecords) {
    if (!referenceRecordIsSafe(record)) continue;
    add(referenceRecordCandidate(record));
  }

  return [...candidateByIdentity.values()].map((item, index) => ({
    ...item,
    originalIndex: index,
    binding: item.binding || manualCaptureCandidateStableFingerprint(item, dataRevision),
  }));
}

function localShortlistEventItems(event = {}) {
  const type = String(event?.type || "").trim();
  if (["SOURCE_RETURNED", "RETRIEVAL_OUTPUT", "ALLOCATOR_INPUT"].includes(type)) {
    return Array.isArray(event.returnedItems) ? event.returnedItems : [];
  }
  if (["LOCAL_TRUNCATION", "GLOBAL_CROP"].includes(type)) {
    return Array.isArray(event.beforeItems) ? event.beforeItems : [];
  }
  if (["MERGE", "ALLOCATOR_OUTPUT", "LOCAL_FILTER"].includes(type)) {
    if (Array.isArray(event.afterItems)) return event.afterItems;
    return Array.isArray(event.beforeItems) ? event.beforeItems : [];
  }
  return [];
}

function compareStableText(left, right) {
  return String(left || "") < String(right || "")
    ? -1
    : String(left || "") > String(right || "") ? 1 : 0;
}

function localShortlistCandidateKeyMap(candidates) {
  const candidatesByKey = new Map();
  const ambiguousKeys = new Set();
  for (const candidate of candidates) {
    const keys = new Set([
      ...stableRecordKeys(candidate),
      ...stableRecordKeys(candidate.body),
      itemId(candidate),
      itemId(candidate.body),
    ].map((value) => String(value || "").trim()).filter(Boolean));
    for (const key of keys) {
      const previous = candidatesByKey.get(key);
      if (previous && previous.binding !== candidate.binding) {
        ambiguousKeys.add(key);
        candidatesByKey.delete(key);
      } else if (!ambiguousKeys.has(key)) {
        candidatesByKey.set(key, candidate);
      }
    }
  }
  return candidatesByKey;
}

function localShortlistQueueFromEvent(event, candidatesByKey) {
  const selected = [];
  const seen = new Set();
  for (const item of localShortlistEventItems(event)) {
    const keys = new Set([
      ...stableRecordKeys(item),
      itemId(item),
    ].map((value) => String(value || "").trim()).filter(Boolean));
    const matches = [...keys]
      .map((key) => candidatesByKey.get(key))
      .filter(Boolean);
    const bindings = new Set(matches.map((candidate) => candidate.binding));
    if (bindings.size !== 1) continue;
    const candidate = matches[0];
    if (seen.has(candidate.binding)) continue;
    seen.add(candidate.binding);
    selected.push(candidate);
  }
  return selected;
}

function buildLocalShortlistState({
  officialQaRecords,
  referenceRecords = [],
  cardResolution,
  dataRevision,
  lineageEvents,
  cards,
}) {
  if (!Array.isArray(officialQaRecords)) {
    throw new TypeError("manual_capture_local_shortlist_official_records_invalid");
  }
  if (!Array.isArray(referenceRecords)) {
    throw new TypeError("manual_capture_local_shortlist_reference_records_invalid");
  }
  assertObject(cardResolution, "manual_capture_local_shortlist_card_resolution_invalid");
  const revision = String(dataRevision || "").trim();
  if (!revision) {
    throw new TypeError("manual_capture_local_shortlist_data_revision_invalid");
  }
  if (!Array.isArray(lineageEvents)) {
    throw new TypeError("manual_capture_local_shortlist_lineage_invalid");
  }

  const candidates = buildSafeCandidates({
    officialQaRecords,
    referenceRecords,
    cardResolution,
    dataRevision: revision,
    cards,
  });
  if (candidates.length === 0) {
    throw new Error("manual_capture_local_shortlist_safe_candidate_pool_empty");
  }
  const stableCandidates = [...candidates].sort((left, right) => (
    compareStableText(left.binding, right.binding)
  ));
  const candidatesByKey = localShortlistCandidateKeyMap(stableCandidates);
  const bestQueueBySurface = new Map();

  for (const event of lineageEvents) {
    const stage = String(event?.stage || "").trim();
    const channel = String(event?.channel || "").trim();
    if (!stage || !channel) continue;
    const queue = localShortlistQueueFromEvent(event, candidatesByKey);
    if (queue.length === 0) continue;
    const bindings = queue.map((candidate) => candidate.binding);
    const queueDigest = sha256(canonicalJson(bindings));
    const surfaceKey = `${stage}\u0000${channel}`;
    const current = bestQueueBySurface.get(surfaceKey);
    if (!current
        || queue.length > current.queue.length
        || (queue.length === current.queue.length
          && compareStableText(queueDigest, current.queueDigest) < 0)) {
      bestQueueBySurface.set(surfaceKey, {
        surfaceKey,
        stage,
        channel,
        queue,
        queueDigest,
      });
    }
  }

  const lineageQueues = [...bestQueueBySurface.values()].sort((left, right) => (
    compareStableText(left.stage, right.stage)
      || compareStableText(left.channel, right.channel)
      || compareStableText(left.queueDigest, right.queueDigest)
  ));
  return Object.freeze({
    revision,
    stableCandidates: Object.freeze(stableCandidates),
    lineageQueues: Object.freeze(lineageQueues),
  });
}

function roundRobinCandidateQueues(queues) {
  const positions = Array(queues.length).fill(0);
  const orderedCandidates = [];
  const selectedBindings = new Set();
  while (true) {
    let added = false;
    for (let queueIndex = 0; queueIndex < queues.length; queueIndex += 1) {
      const queue = queues[queueIndex];
      while (positions[queueIndex] < queue.length) {
        const candidate = queue[positions[queueIndex]];
        positions[queueIndex] += 1;
        if (selectedBindings.has(candidate.binding)) continue;
        selectedBindings.add(candidate.binding);
        orderedCandidates.push(candidate);
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  return { orderedCandidates, selectedBindings };
}

function appendStableCandidateFallback({ orderedCandidates, selectedBindings, stableCandidates }) {
  for (const candidate of stableCandidates) {
    if (selectedBindings.has(candidate.binding)) continue;
    selectedBindings.add(candidate.binding);
    orderedCandidates.push(candidate);
  }
}

function normalizedNeedSurfaceTexts(informationNeeds) {
  if (!Array.isArray(informationNeeds) || informationNeeds.length === 0) {
    throw new TypeError("manual_capture_need_first_information_needs_invalid");
  }
  const seen = new Set();
  const needs = [];
  for (const item of informationNeeds) {
    const need = needText(item);
    const key = need.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    needs.push(need);
  }
  if (needs.length === 0) {
    throw new TypeError("manual_capture_need_first_information_needs_invalid");
  }
  return Object.freeze(needs);
}

function rankCompleteLocalQuerySurface(query, stableCandidates, candidateTerms, onScores, preparedCorpus) {
  const text = String(query || "").trim();
  if (!text) throw new TypeError("manual_capture_need_first_query_invalid");
  const scores = bm25NeedScores(text, candidateTerms, preparedCorpus);
  onScores?.(Object.freeze({
    candidates: Object.freeze([...stableCandidates]),
    scores: Object.freeze([...scores]),
  }));
  return Object.freeze(stableCandidates.map((candidate, index) => ({
    candidate,
    score: scores[index],
  })).sort((left, right) => (
      right.score - left.score
        || compareStableText(left.candidate.binding, right.candidate.binding)
    ))
    .map((item) => item.candidate));
}

// Offline shadow seam: expose the exact complete lexical matcher used by the
// need-first shortlist without exposing or changing the production retriever.
// The candidate pool is always canonicalized by opaque binding before scoring
// so caller input order cannot affect ties.
export function buildManualCaptureCompleteLexicalQueryQueue({
  query,
  candidates,
  onScores,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError("manual_capture_complete_lexical_candidates_invalid");
  }
  // The cache is only eligible for immutable arrays of immutable primitive
  // binding/text fields. Mutable callers are recomputed, so a body-text update
  // cannot reuse statistics merely because an old binding was retained.
  const cacheable = Object.isFrozen(candidates) && candidates.every((candidate, index) => (
    Object.isFrozen(candidate)
      && Object.getOwnPropertyDescriptor(candidates, index)?.value === candidate
      && typeof Object.getOwnPropertyDescriptor(candidate, "binding")?.value === "string"
      && typeof Object.getOwnPropertyDescriptor(candidate, "text")?.value === "string"
  ));
  const cachedCorpus = cacheable && completeLexicalCorpusCache.get(candidates);
  if (cachedCorpus) return rankCompleteLocalQuerySurface(query, cachedCorpus.stableCandidates,
    undefined, onScores, cachedCorpus.preparedCorpus);
  const stableCandidates = [...candidates].sort((left, right) => (
    compareStableText(String(left?.binding || ""), String(right?.binding || ""))
  ));
  const bindings = stableCandidates.map((candidate) => String(candidate?.binding || ""));
  if (bindings.some((binding) => !/^[a-f0-9]{64}$/u.test(binding))
      || new Set(bindings).size !== bindings.length) {
    throw new Error("manual_capture_complete_lexical_candidate_binding_invalid");
  }
  const preparedCorpus = prepareBm25Corpus(stableCandidates.length,
    index => localSearchTerms(stableCandidates[index].text));
  if (cacheable) completeLexicalCorpusCache.set(candidates, { stableCandidates, preparedCorpus });
  return rankCompleteLocalQuerySurface(query, stableCandidates, undefined, onScores, preparedCorpus);
}

// Phase-B offline-only seam. It consumes the already ordered observations emitted
// by the production retriever. It does not accept a case id, K, checkpoint,
// Qwen score, Oracle, or audit result, so those values cannot influence ordering.
// Complete card text remains outside this candidate order and outside K.
export function buildManualCaptureLocalShortlistTotalOrder({
  officialQaRecords,
  referenceRecords = [],
  cardResolution,
  dataRevision,
  lineageEvents,
  cards,
} = {}) {
  const state = buildLocalShortlistState({
    officialQaRecords,
    referenceRecords,
    cardResolution,
    dataRevision,
    lineageEvents,
    cards,
  });
  const interleaved = roundRobinCandidateQueues(
    state.lineageQueues.map((row) => row.queue),
  );
  appendStableCandidateFallback({
    ...interleaved,
    stableCandidates: state.stableCandidates,
  });
  if (interleaved.orderedCandidates.length !== state.stableCandidates.length
      || interleaved.selectedBindings.size !== state.stableCandidates.length) {
    throw new Error("manual_capture_local_shortlist_total_order_incomplete");
  }

  const orderedCandidateBindings = Object.freeze(
    interleaved.orderedCandidates.map((candidate) => candidate.binding),
  );
  return Object.freeze({
    orderedCandidates: Object.freeze(interleaved.orderedCandidates),
    orderedCandidateBindings,
    candidateCount: interleaved.orderedCandidates.length,
    rankedSurfaceCount: state.lineageQueues.length,
    rankedSurfaceSummaries: Object.freeze(state.lineageQueues.map((row) => Object.freeze({
      stage: row.stage,
      channel: row.channel,
      candidateCount: row.queue.length,
      queueSha256: row.queueDigest,
    }))),
    totalOrderSha256: sha256(canonicalJson({
      dataRevision: state.revision,
      orderedCandidateBindings,
    })),
  });
}

// Phase-2C shadow seam. All query surfaces are ranked against the same complete,
// identity-gated official pool. No per-surface top-N crop occurs here. The
// stable fallback is appended only after every real query queue is exhausted.
export function buildManualCaptureNeedFirstShortlistTotalOrder({
  officialQaRecords,
  cardResolution,
  dataRevision,
  lineageEvents,
  cards,
  userQuery,
  informationNeeds,
} = {}) {
  const state = buildLocalShortlistState({
    officialQaRecords,
    cardResolution,
    dataRevision,
    lineageEvents,
    cards,
  });
  const question = String(userQuery || "").trim();
  if (!question) throw new TypeError("manual_capture_need_first_question_invalid");
  const questionKey = question.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const needs = Object.freeze(normalizedNeedSurfaceTexts(informationNeeds).filter((need) => (
    need.normalize("NFKC").replace(/\s+/gu, " ").trim() !== questionKey
  )));
  const legacyInterleaved = roundRobinCandidateQueues(
    state.lineageQueues.map((row) => row.queue),
  );
  const candidateTerms = state.stableCandidates.map((candidate) => (
    localSearchTerms(candidate.text)
  ));
  const questionQueue = rankCompleteLocalQuerySurface(
    question,
    state.stableCandidates,
    candidateTerms,
  );
  const needQueues = needs.map((need) => rankCompleteLocalQuerySurface(
    need,
    state.stableCandidates,
    candidateTerms,
  ));
  const queryQueues = [
    Object.freeze({ kind: "existing_local_total_order", queue: Object.freeze(
      legacyInterleaved.orderedCandidates,
    ) }),
    Object.freeze({ kind: "original_question", queue: questionQueue }),
    ...needQueues.map((queue, needIndex) => Object.freeze({
      kind: "information_need",
      needIndex,
      queue,
    })),
  ];
  const interleaved = roundRobinCandidateQueues(queryQueues.map((row) => row.queue));
  const realQueryCandidateCount = interleaved.orderedCandidates.length;
  appendStableCandidateFallback({
    ...interleaved,
    stableCandidates: state.stableCandidates,
  });
  if (interleaved.orderedCandidates.length !== state.stableCandidates.length
      || interleaved.selectedBindings.size !== state.stableCandidates.length) {
    throw new Error("manual_capture_need_first_total_order_incomplete");
  }
  const orderedCandidateBindings = Object.freeze(
    interleaved.orderedCandidates.map((candidate) => candidate.binding),
  );
  const questionSha256 = sha256(question);
  const informationNeedSha256s = Object.freeze(needs.map((need) => sha256(need)));
  return Object.freeze({
    strategy: "need_first_complete_local_surfaces_v1",
    questionSha256,
    informationNeedSha256s,
    orderedCandidates: Object.freeze(interleaved.orderedCandidates),
    orderedCandidateBindings,
    candidateCount: interleaved.orderedCandidates.length,
    rankedSurfaceCount: state.lineageQueues.length,
    querySurfaceCount: queryQueues.length,
    querySurfaceSummaries: Object.freeze(queryQueues.map((row) => Object.freeze({
      kind: row.kind,
      ...(row.needIndex === undefined ? {} : { needIndex: row.needIndex }),
      candidateCount: row.queue.length,
      queueSha256: sha256(canonicalJson(row.queue.map((candidate) => candidate.binding))),
    }))),
    realQueryCandidateCount,
    fallbackStartRank: realQueryCandidateCount + 1,
    fallbackCandidateCount: state.stableCandidates.length - realQueryCandidateCount,
    totalOrderSha256: sha256(canonicalJson({
      strategy: "need_first_complete_local_surfaces_v1",
      dataRevision: state.revision,
      questionSha256,
      informationNeedSha256s,
      orderedCandidateBindings,
    })),
  });
}

async function loadOfficialRecords({ loadOfficialQaRecords, input }) {
  const loaded = loadOfficialQaRecords
    ? await loadOfficialQaRecords({
        caseId: input.caseId,
        dataRevision: input.dataRevision,
        sourceData: input.sourceData,
        signal: input.signal,
      })
    : input.sourceData?.qaRecords;
  const records = Array.isArray(loaded)
    ? loaded
    : Array.isArray(loaded?.records) ? loaded.records : null;
  if (!records) throw new TypeError("manual_capture_official_qa_records_invalid");
  return records;
}

function candidateAdapterProjection(candidate, index) {
  return Object.freeze({
    binding: candidate.binding,
    index: index + 1,
    text: candidate.text,
    recordType: String(candidate.body?.recordType || ""),
    sourceAuthority: inferredSourceAuthority(candidate.body),
    relatedOnly: effectiveFlag(candidate, candidate.bucket, "relatedOnly") === true,
    isDirect: effectiveFlag(candidate, candidate.bucket, "isDirect") === true,
  });
}

function normalizeRankingResult(value, candidates, maxRankedCandidates) {
  const results = Array.isArray(value) ? value : value?.results;
  if (!Array.isArray(results) || results.length !== candidates.length) {
    throw new Error("manual_capture_rank_result_coverage_invalid");
  }
  const candidatesByBinding = new Map(candidates.map((candidate) => [candidate.binding, candidate]));
  if (candidatesByBinding.size !== candidates.length) {
    throw new Error("manual_capture_candidate_binding_ambiguous");
  }
  const seen = new Set();
  const hasRanks = results.map((result) => Object.hasOwn(result || {}, "rank"));
  if (hasRanks.some(Boolean) && !hasRanks.every(Boolean)) {
    throw new Error("manual_capture_rank_result_rank_mixed");
  }
  const normalized = results.map((result) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("manual_capture_rank_result_invalid");
    }
    const binding = String(result.binding || "").trim();
    if (!candidatesByBinding.has(binding)) {
      throw new Error("manual_capture_rank_result_binding_unknown");
    }
    if (seen.has(binding)) {
      throw new Error("manual_capture_rank_result_binding_duplicate");
    }
    const score = Number(result.score);
    if (!Number.isFinite(score)) {
      throw new Error("manual_capture_rank_result_score_invalid");
    }
    seen.add(binding);
    const candidate = candidatesByBinding.get(binding);
    return {
      candidate,
      score,
      rank: hasRanks.every(Boolean) ? result.rank : null,
    };
  });
  if (seen.size !== candidates.length) {
    throw new Error("manual_capture_rank_result_coverage_invalid");
  }
  if (hasRanks.every(Boolean) && hasRanks.length) {
    const ranks = normalized.map((item) => item.rank);
    if (ranks.some((rank) => !Number.isInteger(rank) || rank < 1 || rank > candidates.length)
        || new Set(ranks).size !== candidates.length) {
      throw new Error("manual_capture_rank_result_rank_invalid");
    }
    normalized.sort((left, right) => left.rank - right.rank);
  } else {
    normalized.sort((left, right) => (
      right.score - left.score
      || left.candidate.originalIndex - right.candidate.originalIndex
    ));
  }
  return normalized.slice(0, maxRankedCandidates).map((item, index) => ({
    ...item.candidate,
    score: item.score,
    rank: index + 1,
  }));
}

function normalizeSelectorResult(value, candidateCount) {
  assertObject(value, "manual_capture_selector_result_invalid");
  if (!Array.isArray(value.informationNeeds) || value.informationNeeds.length === 0) {
    throw new Error("manual_capture_selector_information_needs_invalid");
  }
  const selected = new Set();
  const informationNeeds = value.informationNeeds.map((item) => {
    assertObject(item, "manual_capture_selector_information_need_invalid");
    const need = String(item.need || "").trim();
    const status = String(item.status || "").trim().toUpperCase();
    if (!need || !["SUPPORTED", "UNSUPPORTED", "UNCERTAIN"].includes(status)
        || !Array.isArray(item.supportIndices)) {
      throw new Error("manual_capture_selector_information_need_invalid");
    }
    const supportIndices = [...new Set(item.supportIndices.map((index) => {
      if (typeof index !== "number" || !Number.isInteger(index)) {
        throw new Error("manual_capture_selector_index_noninteger");
      }
      if (index < 1 || index > candidateCount) {
        throw new Error("manual_capture_selector_index_out_of_range");
      }
      return index;
    }))].sort((left, right) => left - right);
    if (status === "SUPPORTED" && supportIndices.length === 0) {
      throw new Error("manual_capture_selector_supported_indices_missing");
    }
    if (status !== "SUPPORTED" && supportIndices.length > 0) {
      throw new Error("manual_capture_selector_unsupported_indices_present");
    }
    supportIndices.forEach((index) => selected.add(index));
    return { need, status, supportIndices };
  });
  return {
    informationNeeds,
    selectedIndices: [...selected].sort((left, right) => left - right),
  };
}

function effectiveFlag(item = {}, bucket = "", name) {
  if (name === "isDirect" && bucket === "officialQaDirectCandidates") return true;
  if (Object.hasOwn(item || {}, name)) return item[name];
  const body = item?.body && typeof item.body === "object" ? item.body : item;
  if (Object.hasOwn(body || {}, name)) return body[name];
  if (Object.hasOwn(body?.retrievalContext || {}, name)) return body.retrievalContext[name];
  if (name === "relatedOnly" && bucket === "rawRelatedEvidence") return true;
  if (name === "isDirect") return false;
  return null;
}

function promptBody(item = {}) {
  const question = String(item?.question || item?.rawQuestion || "");
  return {
    question,
    detailedScene: String(
      item?.rawDetailedQuestion
        || item?.detailedScene
        || item?.detailedQuestion
        || (item?.scenario && item.scenario !== question ? item.scenario : "")
        || "",
    ),
    answer: String(item?.answer || item?.officialAnswer || item?.conclusion || ""),
    text: String(item?.fullText || item?.text || item?.officialText || ""),
  };
}

export function buildSelectedEvidence(retrievedEvidence, selectedCandidates) {
  const selectedEvidence = { ...(retrievedEvidence || {}) };
  for (const bucket of SELECTABLE_BUCKETS) selectedEvidence[bucket] = [];
  for (const candidate of selectedCandidates) {
    if (!SELECTABLE_BUCKETS.includes(candidate.bucket)) {
      throw new Error("manual_capture_selected_bucket_invalid");
    }
    selectedEvidence[candidate.bucket].push(candidate.body);
  }
  return selectedEvidence;
}

function packingPromptChars(packing) {
  const declared = Number(packing?.promptChars);
  if (Number.isSafeInteger(declared) && declared >= 0) return declared;
  if (typeof packing?.prompt === "string") return packing.prompt.length;
  throw new Error("manual_capture_pack_prompt_chars_invalid");
}

function assertPackBudget(packing) {
  assertObject(packing, "manual_capture_pack_result_invalid");
  const promptChars = packingPromptChars(packing);
  if (typeof packing.prompt === "string" && packing.prompt.length !== promptChars) {
    throw new Error("manual_capture_pack_prompt_chars_mismatch");
  }
  if (promptChars > MAX_SERIALIZED_PROMPT_CHARS) {
    throw new Error("manual_capture_pack_budget_exceeded");
  }
  if (packing.promptTruncated === true) {
    throw new Error("manual_capture_pack_truncated");
  }
  return promptChars;
}

function assertPackNotCompacted(packing) {
  if (packing?.promptCompacted === true
      || packing?.compacted === true
      || packing?.transportContract?.compacted === true
      || (packing?.warnings || []).some((warning) => /rag_prompt_compacted/iu.test(String(warning)))) {
    throw new Error("manual_capture_pack_compacted");
  }
}

function truncationWarningsForId(warnings, id) {
  return (warnings || []).some((warning) => {
    const text = String(warning || "");
    const separator = text.lastIndexOf(":");
    return text.includes("truncated") && separator >= 0 && text.slice(separator + 1) === id;
  });
}

function assertSelectedPackingBindings({ packing, selectedCandidates, dataRevision }) {
  const allowedIds = Array.isArray(packing.allowedEvidenceIds)
    ? packing.allowedEvidenceIds.map((id) => String(id || "").trim()).filter(Boolean)
    : null;
  if (!allowedIds || new Set(allowedIds).size !== allowedIds.length) {
    throw new Error("manual_capture_pack_allowed_evidence_invalid");
  }
  assertObject(packing.modelEvidence, "manual_capture_pack_model_evidence_invalid");
  const selectedIds = selectedCandidates.map((candidate) => candidate.id);
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error("manual_capture_selected_identity_ambiguous");
  }
  const allowed = new Set(allowedIds);
  for (const candidate of selectedCandidates) {
    if (manualCaptureCandidateStableFingerprint(candidate, dataRevision) !== candidate.binding) {
      throw new Error("manual_capture_selected_binding_changed");
    }
    if (!allowed.has(candidate.id)) {
      throw new Error("manual_capture_selected_evidence_missing");
    }
    const preparedMatches = Array.isArray(packing.modelEvidence?.[candidate.bucket])
      ? packing.modelEvidence[candidate.bucket].filter((item) => itemId(item) === candidate.id)
      : [];
    if (preparedMatches.length !== 1) {
      throw new Error("manual_capture_selected_evidence_binding_missing");
    }
    const prepared = preparedMatches[0];
    if (itemId(prepared) !== itemId(candidate.body)
        || String(prepared.recordType || "") !== String(candidate.body?.recordType || "")) {
      throw new Error("manual_capture_selected_identity_drift");
    }
    if (truncationWarningsForId(packing.warnings, candidate.id)) {
      throw new Error("manual_capture_selected_body_truncated");
    }
    if (inferredSourceAuthority(prepared) !== inferredSourceAuthority(candidate.body)
        || effectiveFlag(prepared, candidate.bucket, "relatedOnly")
          !== effectiveFlag(candidate, candidate.bucket, "relatedOnly")
        || effectiveFlag(prepared, candidate.bucket, "isDirect")
          !== effectiveFlag(candidate, candidate.bucket, "isDirect")) {
      throw new Error("manual_capture_selected_authority_drift");
    }
  }
}

function fixedCardEntries(retrievedEvidence = {}) {
  return ["userProvidedCardTexts", "cardTexts"].flatMap((bucket) => (
    Array.isArray(retrievedEvidence?.[bucket])
      ? retrievedEvidence[bucket].map((body) => ({ bucket, body, id: itemId(body) }))
      : []
  ));
}

function packedPromptResolvedCards(packing = {}) {
  const prompt = String(packing?.prompt || "").trimEnd();
  if (!prompt) return [];
  const serializedPayload = prompt.slice(prompt.lastIndexOf("\n") + 1);
  try {
    const payload = JSON.parse(serializedPayload);
    return Array.isArray(payload?.resolvedCards) ? payload.resolvedCards : [];
  } catch {
    return [];
  }
}

function normalizedCardIdentityName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, "")
    .trim();
}

function cardIdentityKeys(item = {}) {
  const body = item?.body && typeof item.body === "object" ? item.body : item;
  const ids = [body?.id, body?.cardId, ...(body?.cardIds || [])]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => `id:${value}`);
  const names = [
    body?.name,
    body?.cnName,
    body?.jaName,
    body?.enName,
    ...(body?.aliases || []),
    ...(body?.cards || []),
  ].map(normalizedCardIdentityName)
    .filter(Boolean)
    .map((value) => `name:${value}`);
  return new Set([...ids, ...names]);
}

function cardIdentitiesIntersect(left, right) {
  const rightKeys = cardIdentityKeys(right);
  for (const key of cardIdentityKeys(left)) if (rightKeys.has(key)) return true;
  return false;
}

function assertFixedCardPackingBindings({ packing, retrievedEvidence }) {
  const fixedCards = fixedCardEntries(retrievedEvidence);
  const fixedIds = fixedCards.map((item) => item.id);
  if (fixedIds.some((id) => !id) || new Set(fixedIds).size !== fixedIds.length) {
    throw new Error("manual_capture_fixed_card_identity_invalid");
  }
  const allowed = new Set((packing.allowedEvidenceIds || [])
    .map((id) => String(id || "").trim()).filter(Boolean));
  const resolvedCards = packedPromptResolvedCards(packing);
  const boundResolvedCardIndexes = new Set();
  for (const fixed of fixedCards) {
    const preparedMatches = Array.isArray(packing.modelEvidence?.[fixed.bucket])
      ? packing.modelEvidence[fixed.bucket].filter((item) => itemId(item) === fixed.id)
      : [];
    if (allowed.has(fixed.id) && preparedMatches.length === 1) {
      const prepared = preparedMatches[0];
      if (itemId(prepared) !== itemId(fixed.body)
          || String(prepared.recordType || "") !== String(fixed.body?.recordType || "")) {
        throw new Error("manual_capture_fixed_card_identity_drift");
      }
      if (truncationWarningsForId(packing.warnings, fixed.id)) {
        throw new Error("manual_capture_fixed_card_truncated");
      }
      if (inferredSourceAuthority(prepared) !== inferredSourceAuthority(fixed.body)
          || effectiveFlag(prepared, fixed.bucket, "relatedOnly")
            !== effectiveFlag(fixed.body, fixed.bucket, "relatedOnly")
          || effectiveFlag(prepared, fixed.bucket, "isDirect")
            !== effectiveFlag(fixed.body, fixed.bucket, "isDirect")) {
        throw new Error("manual_capture_fixed_card_authority_drift");
      }
      continue;
    }

    if (allowed.has(fixed.id) || preparedMatches.length > 0) {
      throw new Error("manual_capture_fixed_card_identity_drift");
    }

    // The production prompt packer removes a cardTexts record when card text is
    // already carried by the model-visible resolvedCards
    // envelope. resolvedCards is not citation evidence, so its card-text id is
    // intentionally absent from allowedEvidenceIds and modelEvidence.
    if (fixed.bucket !== "cardTexts") {
      throw new Error("manual_capture_fixed_card_missing");
    }
    const resolvedMatches = resolvedCards
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => cardIdentitiesIntersect(fixed.body, card));
    if (resolvedMatches.length === 0) {
      throw new Error("manual_capture_fixed_card_missing");
    }
    if (resolvedMatches.length !== 1 || boundResolvedCardIndexes.has(resolvedMatches[0].index)) {
      throw new Error("manual_capture_fixed_card_identity_drift");
    }
    const resolved = resolvedMatches[0];
    const prepared = { ...resolved.card, text: resolved.card.effectText || resolved.card.text || "" };
    if (truncationWarningsForId(packing.warnings, fixed.id)) {
      throw new Error("manual_capture_fixed_card_truncated");
    }
    if (inferredSourceAuthority(prepared) !== inferredSourceAuthority(fixed.body)
        || effectiveFlag(prepared, fixed.bucket, "relatedOnly")
          !== effectiveFlag(fixed.body, fixed.bucket, "relatedOnly")
        || effectiveFlag(prepared, fixed.bucket, "isDirect")
          !== effectiveFlag(fixed.body, fixed.bucket, "isDirect")) {
      throw new Error("manual_capture_fixed_card_authority_drift");
    }
    boundResolvedCardIndexes.add(resolved.index);
  }
  return fixedCards;
}

const LOCALLY_REJECTABLE_PACKING_FAILURES = new Set([
  "manual_capture_pack_budget_exceeded",
  "manual_capture_pack_truncated",
  "manual_capture_pack_compacted",
  "manual_capture_selected_evidence_missing",
  "manual_capture_selected_evidence_binding_missing",
  "manual_capture_selected_identity_drift",
  "manual_capture_selected_body_truncated",
  "manual_capture_selected_authority_drift",
  "manual_capture_fixed_card_missing",
  "manual_capture_fixed_card_identity_drift",
  "manual_capture_fixed_card_truncated",
  "manual_capture_fixed_card_authority_drift",
]);

export function assertCompleteOfflinePacking({
  packing,
  retrievedEvidence,
  selectedCandidates,
  dataRevision,
}) {
  assertPackBudget(packing);
  assertPackNotCompacted(packing);
  assertFixedCardPackingBindings({ packing, retrievedEvidence });
  assertSelectedPackingBindings({ packing, selectedCandidates, dataRevision });
}

function normalizeNeedRows(userQuery, generated) {
  const rows = [{ kind: "global_question", need: userQuery }];
  const seen = new Set([userQuery.normalize("NFKC").replace(/\s+/gu, " ").trim()]);
  for (const item of normalizeGeneratedInformationNeeds(generated)) {
    const key = item.need.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ kind: "atomic_need", need: item.need });
  }
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function rankingRowSha256({
  userQuery,
  need,
  rowKind,
  needIndex,
  candidates,
  dataRevision,
}) {
  return sha256(canonicalJson({
    schemaVersion: 1,
    questionSha256: sha256(userQuery),
    need,
    rowKind,
    needIndex,
    dataRevision,
    candidateBindings: candidates.map((candidate) => candidate.binding),
  }));
}

function safeCandidatePoolSha256(candidates) {
  return sha256(canonicalJson(candidates.map((candidate) => ({
    binding: candidate.binding,
    id: candidate.id,
    bucket: candidate.bucket,
  }))));
}

function normalizeFrozenShortlistResolution({
  value,
  candidates,
  questionSha256,
  dataRevision,
  candidatePoolSha256,
}) {
  assertObject(value, "manual_capture_frozen_shortlist_result_invalid");
  if (value.questionSha256 !== questionSha256
      || value.dataRevision !== dataRevision
      || value.candidatePoolSha256 !== candidatePoolSha256
      || !Array.isArray(value.orderedCandidateBindings)
      || value.orderedCandidateBindings.length === 0) {
    throw new Error("manual_capture_frozen_shortlist_binding_invalid");
  }
  const candidatesByBinding = new Map(candidates.map((candidate) => [
    candidate.binding,
    candidate,
  ]));
  if (candidatesByBinding.size !== candidates.length) {
    throw new Error("manual_capture_candidate_binding_ambiguous");
  }
  const seen = new Set();
  const frozenShortlist = value.orderedCandidateBindings.map((rawBinding) => {
    const binding = String(rawBinding || "").trim();
    if (!/^[a-f0-9]{64}$/u.test(binding)) {
      throw new Error("manual_capture_frozen_shortlist_fingerprint_invalid");
    }
    if (seen.has(binding)) {
      throw new Error("manual_capture_frozen_shortlist_binding_duplicate");
    }
    const candidate = candidatesByBinding.get(binding);
    if (!candidate) {
      throw new Error("manual_capture_frozen_shortlist_binding_unknown");
    }
    seen.add(binding);
    return candidate;
  });
  return Object.freeze(frozenShortlist);
}

export function createManualCaptureRankedQueueEvidenceSelectionProvider({
  resolveFrozenShortlist,
  rankNeedCandidates,
  generateInformationNeeds,
  loadOfficialQaRecords,
} = {}) {
  assertFunction(
    resolveFrozenShortlist,
    "manual_capture_frozen_shortlist_resolver_invalid",
  );
  assertFunction(rankNeedCandidates, "manual_capture_rank_need_candidates_invalid");
  assertFunction(generateInformationNeeds, "manual_capture_generate_information_needs_invalid");
  if (loadOfficialQaRecords !== undefined) {
    assertFunction(loadOfficialQaRecords, "manual_capture_official_qa_loader_invalid");
  }

  return async function manualCaptureRankedQueueEvidenceSelectionProvider(input = {}) {
    const caseId = String(input.caseId || "").trim();
    const userQuery = String(input.userQuery || "").trim();
    const dataRevision = String(input.dataRevision || "").trim();
    if (!caseId || !userQuery || !dataRevision) {
      throw new TypeError("manual_capture_provider_input_binding_invalid");
    }
    assertObject(input.sourceData, "manual_capture_source_data_invalid");
    assertObject(input.cardResolution, "manual_capture_card_resolution_invalid");
    assertObject(input.retrievedEvidence, "manual_capture_retrieved_evidence_invalid");
    assertFunction(input.packEvidence, "manual_capture_pack_evidence_invalid");
    throwIfAborted(input.signal);

    const emptySelection = buildSelectedEvidence(input.retrievedEvidence, []);
    const fixedPacking = await input.packEvidence(emptySelection);
    throwIfAborted(input.signal);
    assertCompleteOfflinePacking({
      packing: fixedPacking,
      retrievedEvidence: input.retrievedEvidence,
      selectedCandidates: [],
      dataRevision,
    });
    const confirmedCardTexts = (input.retrievedEvidence.cardTexts || [])
      .map((item) => sourceText(item));
    if (confirmedCardTexts.some((text) => !text)) {
      throw new Error("manual_capture_fixed_card_text_invalid");
    }
    const generated = await generateInformationNeeds(buildManualCaptureNeedGeneratorRequest({
      caseId,
      question: userQuery,
      confirmedCardTexts,
      signal: input.signal,
    }));
    throwIfAborted(input.signal);
    const needRows = normalizeNeedRows(userQuery, generated);
    const informationNeedSha256s = Object.freeze(needRows
      .filter((row) => row.kind === "atomic_need")
      .map((row) => sha256(row.need)));

    const officialQaRecords = await loadOfficialRecords({ loadOfficialQaRecords, input });
    throwIfAborted(input.signal);
    const candidates = buildSafeCandidates({
      officialQaRecords,
      referenceRecords: input.sourceData.referenceRecords ?? [],
      cardResolution: input.cardResolution,
      dataRevision,
      cards: input.sourceData.cards,
    });
    if (candidates.length === 0) {
      throw new Error("manual_capture_safe_candidate_pool_empty");
    }
    if (new Set(candidates.map((candidate) => candidate.binding)).size !== candidates.length) {
      throw new Error("manual_capture_candidate_binding_ambiguous");
    }

    const questionSha256 = sha256(userQuery);
    const candidatePoolSha256 = safeCandidatePoolSha256(candidates);
    const frozenResolution = await resolveFrozenShortlist({
      caseId,
      questionSha256,
      dataRevision,
      candidatePoolSha256,
      candidates: Object.freeze(candidates.map(candidateAdapterProjection)),
      informationNeedSha256s,
      signal: input.signal,
    });
    throwIfAborted(input.signal);
    const frozenShortlist = normalizeFrozenShortlistResolution({
      value: frozenResolution,
      candidates,
      questionSha256,
      dataRevision,
      candidatePoolSha256,
    });
    const frozenProjection = Object.freeze(frozenShortlist.map(candidateAdapterProjection));
    const rankedQueues = [];
    for (let needIndex = 0; needIndex < needRows.length; needIndex += 1) {
      const row = needRows[needIndex];
      const ranked = await rankNeedCandidates({
        caseId,
        query: row.need,
        questionSha256,
        dataRevision,
        rowKind: row.kind,
        needIndex,
        instruction: MANUAL_CAPTURE_RERANK_INSTRUCTION,
        candidates: frozenProjection,
        rankingRowSha256: rankingRowSha256({
          userQuery,
          need: row.need,
          rowKind: row.kind,
          needIndex,
          candidates: frozenShortlist,
          dataRevision,
        }),
        signal: input.signal,
      });
      throwIfAborted(input.signal);
      rankedQueues.push(normalizeRankingResult(
        ranked,
        frozenShortlist,
        frozenShortlist.length,
      ));
    }

    const positions = Array(rankedQueues.length).fill(0);
    const selectedCandidates = [];
    const selectedBindings = new Set();
    // The injected serializer is deterministic for an unchanged evidence input.
    // Cache only byte-identical JSON inputs at the current selected prefix; an
    // accepted candidate clears this cache. No rejection is inferred for a
    // larger selection, a changed body, or a changed authority field.
    const rejectedPackingInputs = new Set();
    let selectedEvidence = emptySelection;
    while (true) {
      let addedThisRound = false;
      for (let queueIndex = 0; queueIndex < rankedQueues.length; queueIndex += 1) {
        const queue = rankedQueues[queueIndex];
        while (positions[queueIndex] < queue.length) {
          const candidate = queue[positions[queueIndex]];
          positions[queueIndex] += 1;
          if (selectedBindings.has(candidate.binding)) continue;
          const proposedCandidates = [...selectedCandidates, candidate];
          const proposedEvidence = buildSelectedEvidence(
            input.retrievedEvidence,
            proposedCandidates,
          );
          const packingInput = JSON.stringify(proposedEvidence);
          if (rejectedPackingInputs.has(packingInput)) continue;
          const packing = await input.packEvidence(proposedEvidence);
          throwIfAborted(input.signal);
          try {
            assertCompleteOfflinePacking({
              packing,
              retrievedEvidence: input.retrievedEvidence,
              selectedCandidates: proposedCandidates,
              dataRevision,
            });
          } catch (error) {
            if (LOCALLY_REJECTABLE_PACKING_FAILURES.has(String(error?.message || ""))) {
              rejectedPackingInputs.add(packingInput);
              continue;
            }
            throw error;
          }
          selectedCandidates.push(candidate);
          selectedBindings.add(candidate.binding);
          selectedEvidence = proposedEvidence;
          rejectedPackingInputs.clear();
          addedThisRound = true;
          break;
        }
      }
      if (!addedThisRound) break;
    }
    return selectedEvidence;
  };
}

function selectorCandidateProjection(candidate, index) {
  return Object.freeze({
    index: index + 1,
    rank: candidate.rank,
    text: candidate.text,
    recordType: String(candidate.body?.recordType || ""),
    sourceAuthority: inferredSourceAuthority(candidate.body),
    relatedOnly: effectiveFlag(candidate, candidate.bucket, "relatedOnly") === true,
    isDirect: effectiveFlag(candidate, candidate.bucket, "isDirect") === true,
    serializedBodyChars: canonicalJson(candidate.body).length,
  });
}

function normalizeShortlistRanks(value, candidateCount) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("manual_capture_need_shortlist_result_invalid");
  }
  const seen = new Set();
  return value.map((rank) => {
    if (!Number.isInteger(rank) || rank < 1 || rank > candidateCount) {
      throw new Error("manual_capture_need_shortlist_rank_invalid");
    }
    if (seen.has(rank)) {
      throw new Error("manual_capture_need_shortlist_rank_duplicate");
    }
    seen.add(rank);
    return rank;
  });
}

export function createManualCaptureEvidenceSelectionProvider({
  rankCandidates,
  selectEvidence,
  shortlistCandidates,
  loadOfficialQaRecords,
  maxRankedCandidates = DEFAULT_MAX_RANKED_CANDIDATES,
} = {}) {
  assertFunction(rankCandidates, "manual_capture_rank_candidates_invalid");
  assertFunction(selectEvidence, "manual_capture_select_evidence_invalid");
  if (shortlistCandidates !== undefined) {
    assertFunction(shortlistCandidates, "manual_capture_shortlist_candidates_invalid");
  }
  if (!Number.isInteger(maxRankedCandidates)
      || maxRankedCandidates < 1
      || maxRankedCandidates > MAX_ALLOWED_RANKED_CANDIDATES) {
    throw new TypeError("manual_capture_max_ranked_candidates_invalid");
  }
  if (loadOfficialQaRecords !== undefined) {
    assertFunction(loadOfficialQaRecords, "manual_capture_official_qa_loader_invalid");
  }

  return async function manualCaptureEvidenceSelectionProvider(input = {}) {
    const caseId = String(input.caseId || "").trim();
    const userQuery = String(input.userQuery || "").trim();
    const dataRevision = String(input.dataRevision || "").trim();
    if (!caseId || !userQuery || !dataRevision) {
      throw new TypeError("manual_capture_provider_input_binding_invalid");
    }
    assertObject(input.sourceData, "manual_capture_source_data_invalid");
    assertObject(input.cardResolution, "manual_capture_card_resolution_invalid");
    assertObject(input.retrievedEvidence, "manual_capture_retrieved_evidence_invalid");
    assertFunction(input.packEvidence, "manual_capture_pack_evidence_invalid");
    throwIfAborted(input.signal);

    const officialQaRecords = await loadOfficialRecords({ loadOfficialQaRecords, input });
    throwIfAborted(input.signal);
    const candidates = buildSafeCandidates({
      officialQaRecords,
      cardResolution: input.cardResolution,
      dataRevision,
      cards: input.sourceData.cards,
    });
    if (candidates.length === 0) {
      throw new Error("manual_capture_safe_candidate_pool_empty");
    }
    if (new Set(candidates.map((candidate) => candidate.binding)).size !== candidates.length) {
      throw new Error("manual_capture_candidate_binding_ambiguous");
    }

    const rankInputCandidates = Object.freeze(candidates.map(candidateAdapterProjection));
    const rankingResult = await rankCandidates({
      caseId,
      query: userQuery,
      dataRevision,
      instruction: MANUAL_CAPTURE_RERANK_INSTRUCTION,
      candidates: rankInputCandidates,
      signal: input.signal,
    });
    throwIfAborted(input.signal);
    const ranked = normalizeRankingResult(rankingResult, candidates, maxRankedCandidates);
    let selectorRanked = ranked;
    if (shortlistCandidates) {
      const shortlistRanks = normalizeShortlistRanks(await shortlistCandidates({
        caseId,
        query: userQuery,
        dataRevision,
        informationNeeds: input.informationNeeds,
        candidates: Object.freeze(ranked.map(selectorCandidateProjection)),
        signal: input.signal,
      }), ranked.length);
      throwIfAborted(input.signal);
      selectorRanked = shortlistRanks.map((rank) => ranked[rank - 1]);
    }

    const emptySelection = buildSelectedEvidence(input.retrievedEvidence, []);
    const basePacking = await input.packEvidence(emptySelection);
    throwIfAborted(input.signal);
    const fixedEnvelopeChars = assertPackBudget(basePacking);
    const selectorInput = Object.freeze({
      task: "numbered_evidence_set_selection",
      question: userQuery,
      fixedEvidence: Object.freeze((input.retrievedEvidence.cardTexts || []).map((item, index) => (
        Object.freeze({ index: index + 1, text: sourceText(item) })
      ))),
      budget: Object.freeze({
        totalSerializedPromptChars: MAX_SERIALIZED_PROMPT_CHARS,
        fixedEnvelopeChars,
        remainingChars: MAX_SERIALIZED_PROMPT_CHARS - fixedEnvelopeChars,
      }),
      candidates: Object.freeze(selectorRanked.map(selectorCandidateProjection)),
      output: Object.freeze({
        informationNeeds: Object.freeze([Object.freeze({
          need: "independent information need",
          status: "SUPPORTED | UNSUPPORTED | UNCERTAIN",
          supportIndices: Object.freeze([1, 2]),
        })]),
      }),
    });
    const selectionResult = await selectEvidence({
      caseId,
      systemInstructions: MANUAL_CAPTURE_SELECTOR_SYSTEM_INSTRUCTIONS,
      input: selectorInput,
      signal: input.signal,
    });
    throwIfAborted(input.signal);
    const selection = normalizeSelectorResult(selectionResult, selectorRanked.length);
    const selectedCandidates = selection.selectedIndices.map((index) => selectorRanked[index - 1]);
    const selectedEvidence = buildSelectedEvidence(input.retrievedEvidence, selectedCandidates);
    const packing = await input.packEvidence(selectedEvidence);
    throwIfAborted(input.signal);
    assertPackBudget(packing);
    assertSelectedPackingBindings({ packing, selectedCandidates, dataRevision });
    return selectedEvidence;
  };
}
