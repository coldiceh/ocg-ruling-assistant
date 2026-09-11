import assert from "node:assert/strict";
import test from "node:test";
import { createCloudEvidenceProvider, interleaveCloudEvidenceQueues, packCloudEvidenceCandidates } from "../backend/cloudEvidenceProvider.mjs";
import { buildSafeCandidates, buildManualCaptureCompleteLexicalQueryQueue } from "../scripts/lib/manual-capture-evidence-selection.mjs";
import { buildManualCaptureEmbeddingDocumentViews, MANUAL_CAPTURE_EMBEDDING_QUERY_INSTRUCTION } from "../scripts/lib/manual-capture-local-embedding-shadow.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";

const revision = "synthetic-corpus-revision";

test("optional hint count cannot dilute the independent original lexical queue", async () => {
  const corpus = corpusFor(records(48));
  const userQuery = "synthetic term0 request";
  const original = buildManualCaptureCompleteLexicalQueryQueue({query:userQuery,candidates:corpus.candidates});
  const provider = createCloudEvidenceProvider({
    loadCorpus: async () => corpus,
    generatePlan: async () => ({informationNeeds:Array.from({length:20},(_,i)=>`synthetic term${10+i} request`),queryTexts:[]}),
  });
  const result = await provider.retrieve(input({VERCEL_ENV:'preview',CLOUD_EVIDENCE_CANDIDATE_LIMIT:'16',CLOUD_EVIDENCE_DENSE:'false',CLOUD_EVIDENCE_RERANK:'false'}));
  const order = result.debug.cloudEvidence.candidateBindings;
  // This is a source-order/count contract, not a relevance or sufficiency test.
  original.slice(0,8).forEach((row,index)=>{
    assert.ok(order.indexOf(row.binding)>=0 && order.indexOf(row.binding)<=2*index,`original position ${index} was diluted`);
  });
});
const cardResolution = { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] };
const emptyEvidence = () => ({
  cardTexts: [], userProvidedCardTexts: [], officialQaDirectCandidates: [], officialQaRelated: [],
  faqRelated: [], provisionalOfficialResponses: [], rawRelatedEvidence: [], ruleSearchQueries: [],
  retrievalWarnings: [], debug: { existing: true },
});
const records = (count = 4) => Array.from({ length: count }, (_, index) => ({
  id: `synthetic-${index}`, recordType: "qa", official: true,
  question: `synthetic term${index} question`, text: `synthetic term${index} complete body`,
}));
function corpusFor(sourceRecords = records()) {
  const candidates = buildSafeCandidates({ officialQaRecords: sourceRecords, cardResolution, dataRevision: revision });
  return { schemaVersion: 1, dataRevision: revision, candidates, documents: candidates.map(buildManualCaptureEmbeddingDocumentViews) };
}
function vectorIndex(corpus, dimension = 2) {
  const hashes = [...new Set(corpus.documents.flatMap((document) => document.views.map((view) => view.textSha256)))];
  return {
    manifest: { dimension },
    entries: new Map(hashes.map((hash, rowIndex) => [hash, { shardIndex: 0, rowIndex }])),
    shards: [Float32Array.from(hashes.flatMap(() => [1, ...Array(dimension - 1).fill(0)]))],
  };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
function corpusWithObservableLexicalBindings(onBindingRead) {
  const source = corpusFor(records(3));
  const candidates = source.candidates.map((candidate) => {
    const binding = candidate.binding;
    const observable = { ...candidate };
    Object.defineProperty(observable, "binding", {
      configurable: true,
      enumerable: true,
      get() {
        onBindingRead();
        return binding;
      },
    });
    return observable;
  });
  return { ...source, candidates };
}
function input(env = {}, overrides = {}) {
  const userQuery = "synthetic term0 request";
  return {
    userQuery, cardResolution, retrievedEvidence: emptyEvidence(), dataRevision: revision,
    env: { CLOUD_EVIDENCE_ASSET_DIR: "synthetic-assets", ...env },
    packEvidence: (evidence) => buildRagRulingPromptBundle({ userQuery, cardResolution, evidence, env: { RAG_MAX_PROMPT_CHARS: "36000" } }),
    ...overrides,
  };
}

test("cloud core retains all query surfaces, shares cached assets and uses the actual whole-entry packer", async () => {
  const corpus = corpusFor();
  let corpusLoads = 0;
  let vectorLoads = 0;
  let embeddings = 0;
  let ranking = 0;
  const provider = createCloudEvidenceProvider({
    loadCorpus: async () => { corpusLoads += 1; return corpus; },
    loadVectorIndex: async () => { vectorLoads += 1; return vectorIndex(corpus); },
    generatePlan: async ({ question, cardTexts }) => {
      assert.equal(question, "synthetic term0 request");
      assert.deepEqual(cardTexts, []);
      return {
        informationNeeds: Array.from({ length: 17 }, (_, i) => `synthetic need ${i}`),
        queryTexts: Array.from({ length: 13 }, (_, i) => `synthetic query ${i}`),
        telemetry: { inputTokens: 31 },
      };
    },
    embed: async ({ inputs }) => {
      embeddings += 1;
      assert.equal(inputs.length, 31);
      assert.equal(inputs[0], `Instruct: ${MANUAL_CAPTURE_EMBEDDING_QUERY_INSTRUCTION}\nQuery:synthetic term0 request`);
      return { vectors: inputs.map(() => [1, 0]), usage: { inputTokens: 42 } };
    },
    rank: async () => { ranking += 1; throw new Error("unexpected_rerank"); },
  });
  for (let run = 0; run < 2; run += 1) {
    const result = await provider.retrieve(input({ CLOUD_EVIDENCE_CANDIDATE_LIMIT: "2" }));
    assert.equal(result.debug.existing, true);
    assert.equal(result.debug.cloudEvidence.querySurfaceCount, 31);
    assert.equal(result.debug.cloudEvidence.selectedCount, 2);
    assert.equal(result.debug.cloudEvidence.packAttempts, 3);
    assert.deepEqual(result.debug.cloudEvidence.embeddingUsage, { inputTokens: 42 });
    assert.ok(result.debug.cloudEvidence.promptChars <= 36000);
    for (const selected of result.officialQaRelated) {
      assert.deepEqual(selected, corpus.candidates.find((candidate) => candidate.id === selected.id).body);
    }
  }
  assert.equal(corpusLoads, 1);
  assert.equal(vectorLoads, 1);
  assert.equal(embeddings, 2);
  assert.equal(ranking, 0);
});

test("finishes corpus loading before starting vectors to bound peak memory", async () => {
  const corpus = corpusFor(records(1));
  const events = [];
  const provider = createCloudEvidenceProvider({
    loadCorpus: async () => {
      events.push("corpus-start");
      await new Promise(resolve => setImmediate(resolve));
      events.push("corpus-end");
      return corpus;
    },
    loadVectorIndex: async () => {
      events.push("vectors");
      return vectorIndex(corpus);
    },
    generatePlan: async () => ({ informationNeeds: [], queryTexts: [] }),
    embed: async ({ inputs }) => ({ vectors: inputs.map(() => [1, 0]) }),
  });
  await provider.retrieve(input({ CLOUD_EVIDENCE_CANDIDATE_LIMIT: "1" }));
  assert.deepEqual(events, ["corpus-start", "corpus-end", "vectors"]);
});

test("builds lexical queues while embedding is pending and preserves serial candidate order", async () => {
  const referenceCorpus = corpusFor(records(3));
  const plan = { informationNeeds: ["synthetic term1 request"], queryTexts: ["synthetic term2 request"] };
  const embeddingVectors = ({ inputs }) => ({ vectors: inputs.map(() => [1, 0]) });
  const reference = await createCloudEvidenceProvider({
    loadCorpus: async () => referenceCorpus,
    loadVectorIndex: async () => vectorIndex(referenceCorpus),
    generatePlan: async () => plan,
    embed: async (request) => embeddingVectors(request),
  }).retrieve(input({ CLOUD_EVIDENCE_CANDIDATE_LIMIT: "3" }));

  let bindingReads = 0;
  const overlapCorpus = corpusWithObservableLexicalBindings(() => { bindingReads += 1; });
  const embeddingStarted = deferred();
  const embeddingRelease = deferred();
  let readsWhenEmbeddingStarted = 0;
  let embeddingCalls = 0;
  const pending = createCloudEvidenceProvider({
    loadCorpus: async () => overlapCorpus,
    loadVectorIndex: async () => vectorIndex(overlapCorpus),
    generatePlan: async () => plan,
    embed: async (request) => {
      embeddingCalls += 1;
      readsWhenEmbeddingStarted = bindingReads;
      embeddingStarted.resolve();
      await embeddingRelease.promise;
      return embeddingVectors(request);
    },
  }).retrieve(input({ CLOUD_EVIDENCE_CANDIDATE_LIMIT: "3" }));

  await embeddingStarted.promise;
  await new Promise(resolve => setImmediate(resolve));
  let overlapAssertion;
  try {
    assert.ok(bindingReads > readsWhenEmbeddingStarted,
      "lexical ranking must read candidate bindings before embedding resolves");
  } catch (error) {
    overlapAssertion = error;
  } finally {
    embeddingRelease.resolve();
  }
  const result = await pending;
  if (overlapAssertion) throw overlapAssertion;
  assert.equal(embeddingCalls, 1);
  assert.deepEqual(result.officialQaRelated.map((record) => record.id),
    reference.officialQaRelated.map((record) => record.id));
  assert.equal(result.debug.cloudEvidence.querySurfaceCount, reference.debug.cloudEvidence.querySurfaceCount);
  assert.equal(result.debug.cloudEvidence.candidateCount, reference.debug.cloudEvidence.candidateCount);
  assert.equal(result.debug.cloudEvidence.selectedCount, reference.debug.cloudEvidence.selectedCount);
  assert.equal(result.debug.cloudEvidence.packAttempts, reference.debug.cloudEvidence.packAttempts);
});

test("starts the real SiliconFlow fetch before lexical work and overlaps lexical work with its response", async () => {
  let bindingReads = 0;
  const corpus = corpusWithObservableLexicalBindings(() => { bindingReads += 1; });
  const reservationStarted = deferred();
  const reservationRelease = deferred();
  const fetchStarted = deferred();
  const responseRelease = deferred();
  let readsWhenReservationStarted = 0;
  let readsWhenFetchStarted = 0;
  let fetchCalls = 0;
  let responseCalls = 0;
  const reservation = { reservationId: "synthetic-reservation" };
  const provider = createCloudEvidenceProvider({
    loadCorpus: async () => corpus,
    loadVectorIndex: async () => vectorIndex(corpus, 1024),
    generatePlan: async () => ({ informationNeeds: [], queryTexts: [] }),
    beforeSend: async () => {
      readsWhenReservationStarted = bindingReads;
      reservationStarted.resolve();
      await reservationRelease.promise;
      return reservation;
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      readsWhenFetchStarted = bindingReads;
      fetchStarted.resolve();
      await responseRelease.promise;
      return {
        ok: true,
        json: async () => ({
          data: [{ index: 0, embedding: [1, ...Array(1023).fill(0)] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      };
    },
    onResponse: async (_response, observedReservation) => {
      responseCalls += 1;
      assert.equal(observedReservation, reservation);
    },
  });
  const pending = provider.retrieve(input({
    CLOUD_EVIDENCE_CANDIDATE_LIMIT: "3",
    CLOUD_EVIDENCE_DENSE: "true",
    SILICONFLOW_API_KEY: "synthetic-key",
  }));

  await reservationStarted.promise;
  await new Promise(resolve => setImmediate(resolve));
  const assertionFailures = [];
  try {
    assert.equal(bindingReads, readsWhenReservationStarted,
      "lexical work must not block the budget reservation before fetch dispatch");
  } catch (error) {
    assertionFailures.push(error);
  } finally {
    reservationRelease.resolve();
  }
  await fetchStarted.promise;
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.ok(bindingReads > readsWhenFetchStarted,
      "lexical work must run after fetch starts and before its response resolves");
  } catch (error) {
    assertionFailures.push(error);
  } finally {
    responseRelease.resolve();
  }
  const result = await pending;
  if (assertionFailures.length) throw assertionFailures[0];
  assert.equal(fetchCalls, 1);
  assert.equal(responseCalls, 1);
  assert.equal(result.debug.cloudEvidence.embeddingUsage.total_tokens, 1);
  assert.ok(result.debug.cloudEvidence.timingsMs.embeddingLexicalOverlap >= 0);
});

test("real SiliconFlow reservation failure, fetch failure and abort each stop after one attempt", async () => {
  for (const mode of ["reservation-failure", "fetch-failure", "fetch-abort"]) {
    const corpus = corpusFor(records(2));
    const controller = new AbortController();
    const fetchStarted = deferred();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let reservationCalls = 0;
    let fetchCalls = 0;
    let responseCalls = 0;
    let rankCalls = 0;
    let packCalls = 0;
    try {
      const provider = createCloudEvidenceProvider({
        loadCorpus: async () => corpus,
        loadVectorIndex: async () => vectorIndex(corpus, 1024),
        generatePlan: async () => ({ informationNeeds: [], queryTexts: [] }),
        beforeSend: async () => {
          reservationCalls += 1;
          if (mode === "reservation-failure") throw new Error("synthetic_reservation_failure");
          return { reservationId: "one-reservation" };
        },
        fetchImpl: async (_url, { signal }) => {
          fetchCalls += 1;
          fetchStarted.resolve();
          if (mode === "fetch-failure") throw new Error("synthetic_fetch_failure");
          await new Promise((resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          throw new Error("unreachable_fetch_completion");
        },
        onResponse: async () => { responseCalls += 1; },
        rank: async () => { rankCalls += 1; return []; },
      });
      const pending = provider.retrieve(input({
        CLOUD_EVIDENCE_CANDIDATE_LIMIT: "2",
        CLOUD_EVIDENCE_DENSE: "true",
        SILICONFLOW_API_KEY: "synthetic-key",
      }, {
        signal: controller.signal,
        packEvidence: async (...args) => {
          packCalls += 1;
          return input().packEvidence(...args);
        },
      }));
      if (mode === "fetch-abort") {
        await fetchStarted.promise;
        controller.abort(new Error("synthetic_fetch_abort"));
      }
      await assert.rejects(pending, mode === "reservation-failure"
        ? /synthetic_reservation_failure/u
        : /SiliconFlow embeddings request failed/u);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reservationCalls, 1);
      assert.equal(fetchCalls, mode === "reservation-failure" ? 0 : 1);
      assert.equal(responseCalls, 0);
      assert.equal(rankCalls, 0);
      assert.equal(packCalls, 0);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }
});

test("candidate limit is applied before one original-question rerank and there is no dense work when disabled", async () => {
  const corpus = corpusFor(records(7));
  let rerankCalls = 0;
  let rerankDocuments;
  const provider = createCloudEvidenceProvider({
    loadCorpus: async () => corpus,
    loadVectorIndex: async () => { throw new Error("unexpected_vector_load"); },
    embed: async () => { throw new Error("unexpected_embedding"); },
    generatePlan: async () => ({ informationNeeds: ["synthetic term1 request"], queryTexts: ["synthetic term2 request"] }),
    rank: async ({ query, documents }) => {
      rerankCalls += 1;
      assert.equal(query, "synthetic term0 request");
      assert.equal(documents.length, 2);
      rerankDocuments = documents;
      return { scores: [0, 1], usage: { inputTokens: 12 } };
    },
  });
  const result = await provider.retrieve(input({
    CLOUD_EVIDENCE_DENSE: "false", CLOUD_EVIDENCE_RERANK: "true", CLOUD_EVIDENCE_CANDIDATE_LIMIT: "2",
  }));
  assert.equal(rerankCalls, 1);
  const expected = [...rerankDocuments].reverse().map((text) => corpus.candidates.find((candidate) => candidate.text === text).id);
  assert.deepEqual(result.officialQaRelated.map((record) => record.id), expected);
  assert.equal(result.debug.cloudEvidence.candidateCount, 2);
  assert.equal(result.debug.cloudEvidence.rerankCount, 2);
  assert.equal(result.debug.cloudEvidence.timingsMs.embedding, 0);
  assert.equal(result.debug.cloudEvidence.timingsMs.embeddingLexicalOverlap, 0);
});

test("asset body and revision failures stop before plan generation", async () => {
  for (const mutate of [
    (corpus) => { corpus.dataRevision = "different-revision"; },
    (corpus) => { corpus.candidates[0].body.text += " changed"; },
    (corpus) => { corpus.documents[0] = { ...corpus.documents[0], binding: corpus.candidates[1].binding }; },
  ]) {
    const corpus = corpusFor();
    mutate(corpus);
    let planCalls = 0;
    const provider = createCloudEvidenceProvider({
      loadCorpus: async () => corpus,
      generatePlan: async () => { planCalls += 1; return { informationNeeds: [], queryTexts: [] }; },
    });
    await assert.rejects(provider.retrieve(input()), /cloud_evidence_(corpus_revision|candidate_binding|document_binding)_invalid/u);
    assert.equal(planCalls, 0);
  }
});

test("separate request factories share immutable assets and a failed load does not poison the cache", async () => {
  const corpus = corpusFor();
  let corpusLoads = 0;
  let vectorLoads = 0;
  const options = {
    loadCorpus: async () => { corpusLoads += 1; return corpus; },
    loadVectorIndex: async () => {
      vectorLoads += 1;
      if (vectorLoads === 1) throw new Error("synthetic_load_failure");
      return vectorIndex(corpus);
    },
    generatePlan: async () => ({informationNeeds: [], queryTexts: []}),
    embed: async ({inputs}) => ({vectors:inputs.map(()=>[1,0])}),
  };
  await assert.rejects(createCloudEvidenceProvider(options).retrieve(input()), /synthetic_load_failure/u);
  for (let request = 0; request < 2; request += 1) {
    await createCloudEvidenceProvider(options).retrieve(input());
  }
  assert.equal(corpusLoads, 1);
  assert.equal(vectorLoads, 2);
  assert.ok(Object.isFrozen(corpus.candidates[0].body));
  await createCloudEvidenceProvider(options).retrieve(input({CLOUD_EVIDENCE_ASSET_DIR:"other-synthetic-assets"}));
  assert.equal(corpusLoads, 2, "a different actual asset path has a different cache entry");
});

test("cross-asset binding failure evicts the vector cache before retry", async () => {
  const corpus = corpusFor();
  let vectorLoads = 0;
  const options = {
    loadCorpus: async () => corpus,
    loadVectorIndex: async () => {
      vectorLoads += 1;
      const index = vectorIndex(corpus);
      if (vectorLoads === 1) index.entries.delete(corpus.documents[0].views[0].textSha256);
      return index;
    },
    generatePlan: async () => ({ informationNeeds: [], queryTexts: [] }),
    embed: async ({ inputs }) => ({ vectors: inputs.map(() => [1, 0]) }),
  };
  await assert.rejects(createCloudEvidenceProvider(options).retrieve(input()), /cloud_evidence_vector_missing/u);
  await createCloudEvidenceProvider(options).retrieve(input());
  assert.equal(vectorLoads, 2);
});

test("round robin uses each surface in order and only stable bindings deduplicate", () => {
  const a = { binding: "a" };
  const b = { binding: "b" };
  const c = { binding: "c" };
  const d = { binding: "d" };
  assert.deepEqual(interleaveCloudEvidenceQueues([[a, b, c, d], [b, a, d, c]], 4), [a, b, c, d]);
  assert.deepEqual(interleaveCloudEvidenceQueues([[a, b, c], [a, c, b]], 2), [a, c]);
});

test("packing skips a whole oversized entry, preserves later complete entries and propagates authority drift", async () => {
  const corpus = corpusFor([
    { id: "whole-a", recordType: "qa", official: true, question: "synthetic a", text: "a".repeat(22000) },
    { id: "whole-b", recordType: "qa", official: true, question: "synthetic b", text: "b".repeat(22000) },
    { id: "whole-c", recordType: "qa", official: true, question: "synthetic c", text: "c".repeat(50) },
  ]);
  const actual = input();
  const packed = await packCloudEvidenceCandidates({ candidates: corpus.candidates, ...actual });
  assert.deepEqual(packed.evidence.officialQaRelated.map((record) => record.id), ["whole-a", "whole-c"]);
  assert.equal(packed.evidence.officialQaRelated[0].text, "a".repeat(22000));
  assert.equal(packed.packing.promptTruncated, false);
  assert.ok(packed.packing.promptChars <= 36000);
  await assert.rejects(packCloudEvidenceCandidates({
    candidates: corpus.candidates.slice(0, 1), ...actual,
    packEvidence: (evidence) => {
      const packing = actual.packEvidence(evidence);
      if (packing.modelEvidence.officialQaRelated.length) packing.modelEvidence.officialQaRelated[0].sourceAuthority = "community_reference";
      return packing;
    },
  }), /manual_capture_selected_authority_drift/u);
  await assert.rejects(packCloudEvidenceCandidates({
    candidates: corpus.candidates.slice(0, 1), ...actual,
    packEvidence: (evidence) => ({...actual.packEvidence(evidence), allowedEvidenceIds: []}),
  }), /manual_capture_selected_evidence_missing/u,
  "an unexplained missing ID is a binding failure, not an observed budget omission");
});
