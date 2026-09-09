import crypto from "node:crypto";
import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

import { completeDenseQueue, roundRobinLexicalDense } from "./evidenceQueueOrder.mjs";
export { completeDenseQueue };
import { loadEvidenceVectorIndex, scoreEvidenceDocumentViews } from "./evidenceVectorIndex.mjs";
import { callSiliconFlowEmbeddings, callSiliconFlowRerank } from "./siliconFlowEvidenceClient.mjs";
import {
  assertCompleteOfflinePacking,
  buildManualCaptureCompleteLexicalQueryQueue,
  installManualCaptureLexicalIndex,
  buildSelectedEvidence,
  manualCaptureCandidateStableFingerprint,
  MANUAL_CAPTURE_RERANK_INSTRUCTION,
} from "../scripts/lib/manual-capture-evidence-selection.mjs";
import {
  MANUAL_CAPTURE_EMBEDDING_QUERY_INSTRUCTION,
  normalizeManualCaptureEmbeddingText,
} from "../scripts/lib/manual-capture-local-embedding-shadow.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const unzip = promisify(gunzip);
const loaderCaches = new WeakMap();
function loaderCache(loader) {
  if (!loaderCaches.has(loader)) loaderCaches.set(loader, new Map());
  return loaderCaches.get(loader);
}
async function cached(cache, key, work) {
  if (!cache.has(key)) cache.set(key, Promise.resolve().then(work));
  const pending = cache.get(key);
  try { return await pending; } catch (error) {
    if (cache.get(key) === pending) cache.delete(key);
    throw error;
  }
}
function freezeCorpus(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) freezeCorpus(item, seen);
  return Object.freeze(value);
}
const canonicalJson = (value) => value === null || typeof value !== "object"
  ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
const check = (condition, code) => { if (!condition) throw new Error(code); };
const elapsed = (started) => Math.max(0, performance.now() - started);
const abort = (signal) => signal?.throwIfAborted();
const enabled = (value) => String(value || "").toLowerCase() === "true";
const positiveInteger = (value, fallback) => {
  const result = value === undefined || value === "" ? fallback : Number(value);
  check(Number.isSafeInteger(result) && result > 0, "cloud_evidence_candidate_limit_invalid");
  return result;
};

function validateCorpus(corpus, dataRevision) {
  check(corpus?.schemaVersion === 1 && corpus.dataRevision === dataRevision,
    "cloud_evidence_corpus_revision_invalid");
  check(Array.isArray(corpus.candidates) && Array.isArray(corpus.documents)
    && corpus.candidates.length === corpus.documents.length,
  "cloud_evidence_corpus_count_invalid");
  const bindings = new Set();
  for (let index = 0; index < corpus.candidates.length; index += 1) {
    const candidate = corpus.candidates[index];
    const document = corpus.documents[index];
    check(candidate?.body && typeof candidate.text === "string" && candidate.text.length > 0,
      "cloud_evidence_candidate_invalid");
    check(sha256(canonicalJson(candidate.body)) === candidate.bodySha256
      && manualCaptureCandidateStableFingerprint(candidate, dataRevision) === candidate.binding
      && !bindings.has(candidate.binding), "cloud_evidence_candidate_binding_invalid");
    check(document?.binding === candidate.binding
      && document.candidateBodySha256 === candidate.bodySha256
      && Array.isArray(document.views) && document.views.length === 2,
    "cloud_evidence_document_binding_invalid");
    for (const view of document.views) {
      check(typeof view?.text === "string" && sha256(view.text) === view.textSha256,
        "cloud_evidence_document_text_binding_invalid");
    }
    bindings.add(candidate.binding);
  }
  return freezeCorpus(corpus);
}

async function readCorpus({ dataDir, dataRevision }) {
  const [manifestBytes, compressed] = await Promise.all([
    readFile(path.join(dataDir, "corpus-manifest.json")),
    readFile(path.join(dataDir, "corpus.json.gz")),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  check(manifest.corpusFile === "corpus.json.gz" && manifest.corpusEncoding === "gzip"
    && compressed.length === manifest.corpusCompressedBytes
    && sha256(compressed) === manifest.corpusCompressedSha256,
  "cloud_evidence_compressed_corpus_binding_invalid");
  const lexical = manifest.lexicalIndex;
  const lexicalBytesPromise = lexical ? (async () => {
    check(lexical.file === "lexical-index.bin.gz" && lexical.encoding === "gzip", "cloud_evidence_lexical_index_manifest_invalid");
    const compressedIndex = await readFile(path.join(dataDir, lexical.file));
    check(compressedIndex.length === lexical.compressedBytes && sha256(compressedIndex) === lexical.compressedSha256,
      "cloud_evidence_lexical_index_compressed_binding_invalid");
    const indexBytes = await unzip(compressedIndex);
    check(indexBytes.length === lexical.bytes && sha256(indexBytes) === lexical.sha256, "cloud_evidence_lexical_index_bytes_binding_invalid");
    return indexBytes;
  })() : null;
  const [bytes, lexicalBytes] = await Promise.all([unzip(compressed), lexicalBytesPromise]);
  check(bytes.length === manifest.corpusBytes && sha256(bytes) === manifest.corpusSha256,
    "cloud_evidence_corpus_bytes_binding_invalid");
  const corpus = validateCorpus(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")), dataRevision);
  if (lexicalBytes) installManualCaptureLexicalIndex({ candidates: corpus.candidates, dataRevision, bytes: lexicalBytes });
  return corpus;
}

export async function loadCloudEvidenceAssetSnapshot({ dataDir, dataRevision } = {}) {
  const [corpus, vectorIndex] = await Promise.all([
    readCorpus({ dataDir, dataRevision }),
    loadEvidenceVectorIndex({ dataDir, dataRevision }),
  ]);
  const orderedContentHashes = [...new Set(corpus.documents.flatMap((document) => (
    document.views.map((view) => view.textSha256)
  )))];
  check(canonicalJson(orderedContentHashes) === canonicalJson(vectorIndex.manifest.orderedContentHashes),
    "cloud_evidence_vector_corpus_binding_invalid");
  return Object.freeze({ corpus, vectorIndex });
}

export function interleaveCloudEvidenceQueues(queues, candidateLimit) {
  const positions = queues.map(() => 0);
  const seen = new Set();
  const result = [];
  while (result.length < candidateLimit) {
    let added = false;
    for (let index = 0; index < queues.length && result.length < candidateLimit; index += 1) {
      while (positions[index] < queues[index].length) {
        const candidate = queues[index][positions[index]++];
        if (seen.has(candidate.binding)) continue;
        seen.add(candidate.binding);
        result.push(candidate);
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  return result;
}

const WHOLE_ENTRY_BUDGET_REJECTIONS = new Set([
  "manual_capture_pack_budget_exceeded",
  "manual_capture_pack_truncated",
  "manual_capture_pack_compacted",
  "manual_capture_selected_body_truncated",
]);

export async function packCloudEvidenceCandidates({
  candidates, retrievedEvidence, dataRevision, packEvidence, signal,
}) {
  check(typeof packEvidence === "function", "cloud_evidence_packer_required");
  let evidence = buildSelectedEvidence(retrievedEvidence, []);
  let packing = await packEvidence(evidence);
  abort(signal);
  assertCompleteOfflinePacking({ packing, retrievedEvidence, selectedCandidates: [], dataRevision });
  const selected = [];
  let attempts = 1;
  for (const candidate of candidates) {
    abort(signal);
    const proposed = [...selected, candidate];
    const proposedEvidence = buildSelectedEvidence(retrievedEvidence, proposed);
    try {
      attempts += 1;
      const proposedPacking = await packEvidence(proposedEvidence);
      abort(signal);
      assertCompleteOfflinePacking({ packing: proposedPacking, retrievedEvidence, selectedCandidates: proposed, dataRevision });
      selected.push(candidate);
      evidence = proposedEvidence;
      packing = proposedPacking;
    } catch (error) {
      abort(signal);
      // The fixed envelope already fitted. Only an observed whole-entry budget
      // omission is recoverable here; identity or authority failures propagate.
      if (error?.code === "evidence_prompt_budget_exceeded"
          || WHOLE_ENTRY_BUDGET_REJECTIONS.has(error?.message)) continue;
      throw error;
    }
  }
  return { evidence, packing, selectedCount: selected.length, attempts };
}

function querySurfaces(question, plan) {
  check(Array.isArray(plan?.informationNeeds) && Array.isArray(plan?.queryTexts),
    "cloud_evidence_plan_invalid");
  check([...plan.informationNeeds, ...plan.queryTexts].every((value) => typeof value === "string"),
    "cloud_evidence_plan_text_invalid");
  const seen = new Set();
  return [question, ...plan.informationNeeds, ...plan.queryTexts]
    .map(normalizeManualCaptureEmbeddingText).filter((text) => {
      if (!text || seen.has(text)) return false;
      seen.add(text);
      return true;
    });
}

export function createCloudEvidenceProvider({
  generatePlan,
  embed,
  rank,
  beforeSend,
  onResponse,
  fetchImpl = globalThis.fetch,
  loadCorpus = readCorpus,
  loadVectorIndex = loadEvidenceVectorIndex,
  candidateLimit,
} = {}) {
  check(typeof generatePlan === "function", "cloud_evidence_plan_generator_required");
  // Factories may be request-scoped. Share only immutable assets, never a plan,
  // query vector, model response, or request environment. Injected loaders keep
  // separate namespaces so a test/source adapter cannot populate another cache.
  const corpusLoads = loaderCache(loadCorpus);
  const vectorLoads = loaderCache(loadVectorIndex);

  return {
    async retrieve({ userQuery, cardResolution, retrievedEvidence, dataRevision, env = {}, signal, packEvidence }) {
      const started = performance.now();
      const timingsMs = {};
      check(typeof userQuery === "string" && userQuery.trim(), "cloud_evidence_question_required");
      check(typeof dataRevision === "string" && dataRevision.length > 0, "cloud_evidence_revision_required");
      check(typeof env.CLOUD_EVIDENCE_ASSET_DIR === "string" && env.CLOUD_EVIDENCE_ASSET_DIR.length > 0,
        "cloud_evidence_asset_dir_required");
      abort(signal);
      const dataDir = loadCorpus === readCorpus
        ? await realpath(env.CLOUD_EVIDENCE_ASSET_DIR)
        : path.resolve(env.CLOUD_EVIDENCE_ASSET_DIR);
      const key = JSON.stringify([dataDir, dataRevision]);
      const limit = positiveInteger(candidateLimit ?? env.CLOUD_EVIDENCE_CANDIDATE_LIMIT, 128);
      const dense = env.CLOUD_EVIDENCE_DENSE === undefined
        ? typeof embed === "function" : enabled(env.CLOUD_EVIDENCE_DENSE);
      const corpusLoad = cached(corpusLoads, key, async () => {
        const loaded = await loadCorpus({ dataDir, dataRevision });
        return loadCorpus === readCorpus ? loaded : validateCorpus(loaded, dataRevision);
      });
      const indexLoad = dense ? cached(vectorLoads, key, async () => {
        const result = await loadVectorIndex({ dataDir, dataRevision });
        const loadedCorpus = await corpusLoad;
        for (const document of loadedCorpus.documents) {
          for (const view of document.views) check(result.entries.has(view.textSha256), "cloud_evidence_vector_missing");
        }
        return result;
      }) : Promise.resolve(null);
      const [corpus, index] = await Promise.all([corpusLoad, indexLoad]);
      abort(signal);
      timingsMs.assets = elapsed(started);
      let step = performance.now();
      const plan = await generatePlan({ question: userQuery, cardTexts: retrievedEvidence.cardTexts || [], signal });
      abort(signal);
      const surfaces = querySurfaces(userQuery, plan);
      timingsMs.plan = elapsed(step);
      step = performance.now();
      let embeddingResult = null;
      if (dense && corpus.candidates.length > 0) {
        embeddingResult = await (embed || callSiliconFlowEmbeddings)({
          inputs: surfaces.map((query) => `Instruct: ${MANUAL_CAPTURE_EMBEDDING_QUERY_INSTRUCTION}\nQuery:${query}`),
          env, signal, fetchImpl, beforeSend, onResponse,
        });
        abort(signal);
      }
      timingsMs.embedding = elapsed(step);
      const vectors = Array.isArray(embeddingResult) ? embeddingResult : embeddingResult?.vectors;
      if (dense && corpus.candidates.length > 0) check(Array.isArray(vectors) && vectors.length === surfaces.length,
        "cloud_evidence_embedding_count_invalid");
      step = performance.now();
      const queues = corpus.candidates.length === 0 ? [] : surfaces.map((query, indexOfSurface) => {
        const lexical = buildManualCaptureCompleteLexicalQueryQueue({ query, candidates: corpus.candidates });
        if (!dense) return lexical;
        const scores = scoreEvidenceDocumentViews(index, { queryVector: vectors[indexOfSurface], documents: corpus.documents });
        // A global union of at most limit unique bindings cannot need any
        // surface beyond its first limit unique bindings. This is a count cap,
        // with no score threshold or interpretation of candidate meaning.
        return roundRobinLexicalDense(lexical, completeDenseQueue(corpus.candidates, scores), limit);
      });
      let candidates = interleaveCloudEvidenceQueues(queues, limit);
      timingsMs.candidates = elapsed(step);
      step = performance.now();
      let rerankResult = null;
      if (enabled(env.CLOUD_EVIDENCE_RERANK) && candidates.length > 0) {
        const head = candidates.slice(0, 64);
        rerankResult = await (rank || callSiliconFlowRerank)({
          query: userQuery, documents: head.map((candidate) => candidate.text),
          instruction: MANUAL_CAPTURE_RERANK_INSTRUCTION,
          env, signal, fetchImpl, beforeSend, onResponse,
        });
        abort(signal);
        const scores = Array.isArray(rerankResult) ? rerankResult : rerankResult?.scores;
        candidates = [...completeDenseQueue(head, scores), ...candidates.slice(head.length)];
      }
      timingsMs.rerank = elapsed(step);
      step = performance.now();
      const packed = await packCloudEvidenceCandidates({ candidates, retrievedEvidence, dataRevision, packEvidence, signal });
      timingsMs.packing = elapsed(step);
      timingsMs.total = elapsed(started);
      return {
        ...packed.evidence,
        cardResolution,
        debug: {
          ...retrievedEvidence.debug,
          cloudEvidence: {
            strategy: dense ? "lexical_dense_round_robin" : "lexical_round_robin",
            dataRevision, candidateLimit: limit, candidateCount: candidates.length,
            querySurfaceCount: surfaces.length, informationNeedCount: plan.informationNeeds.length,
            queryTextCount: plan.queryTexts.length, selectedCount: packed.selectedCount,
            packAttempts: packed.attempts, promptChars: packed.packing.promptChars,
            rerankCount: rerankResult ? Math.min(64, candidates.length) : 0,
            planTelemetry: plan.telemetry || null,
            embeddingUsage: embeddingResult?.usage || null,
            rerankUsage: rerankResult?.usage || null,
            ...(env.VERCEL_ENV === "preview" ? {
              candidateBindings: candidates.map((candidate) => candidate.binding),
            } : {}),
            timingsMs,
          },
        },
      };
    },
  };
}
