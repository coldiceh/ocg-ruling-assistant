import assert from "node:assert/strict";
import test from "node:test";
import { createCloudEvidenceProvider, interleaveCloudEvidenceQueues, packCloudEvidenceCandidates } from "../backend/cloudEvidenceProvider.mjs";
import { buildSafeCandidates } from "../scripts/lib/manual-capture-evidence-selection.mjs";
import { buildManualCaptureEmbeddingDocumentViews, MANUAL_CAPTURE_EMBEDDING_QUERY_INSTRUCTION } from "../scripts/lib/manual-capture-local-embedding-shadow.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";

const revision = "synthetic-corpus-revision";
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
function vectorIndex(corpus) {
  const hashes = [...new Set(corpus.documents.flatMap((document) => document.views.map((view) => view.textSha256)))];
  return {
    manifest: { dimension: 2 },
    entries: new Map(hashes.map((hash, rowIndex) => [hash, { shardIndex: 0, rowIndex }])),
    shards: [Float32Array.from(hashes.flatMap(() => [1, 0]))],
  };
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

test("starts corpus and vector asset loads together before binding checks", async () => {
  const corpus = corpusFor(records(1));
  let active = 0;
  let maxActive = 0;
  const delayed = async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 40));
    active -= 1;
    return value;
  };
  const provider = createCloudEvidenceProvider({
    loadCorpus: async () => delayed(corpus),
    loadVectorIndex: async () => delayed(vectorIndex(corpus)),
    generatePlan: async () => ({ informationNeeds: [], queryTexts: [] }),
    embed: async ({ inputs }) => ({ vectors: inputs.map(() => [1, 0]) }),
  });
  await provider.retrieve(input({ CLOUD_EVIDENCE_CANDIDATE_LIMIT: "1" }));
  assert.equal(maxActive, 2);
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
