import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { clearBaigeSearchCache } from "../backend/baigeCardProvider.mjs";
import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import {
  loadRawRagData,
  normalizeInjectedData,
  retrieveRagEvidence,
} from "../backend/ragEvidenceRetriever.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import {
  canonicalJsonBytes,
  loadRagRuntimeBundle,
  RAG_RUNTIME_CORPORA,
  sha256,
} from "../backend/ragRuntimeBundle.mjs";
import { registerCanonicalNormalizedRagData } from "../backend/ragNormalizedDataRegistry.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(repositoryRoot, "data");
const casesPath = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "admin-evidence-dry-run-cases.json",
);

const EVIDENCE_BUCKET_KEYS = Object.freeze([
  "cardTexts",
  "userProvidedCardTexts",
  "officialQaDirectCandidates",
  "officialQaRelated",
  "provisionalOfficialResponses",
  "faqRelated",
  "formalEngineProofs",
  "rawRelatedEvidence",
  "rulebookCandidates",
]);

const CARD_RESOLUTION_KEYS = Object.freeze([
  "resolvedCards",
  "unresolvedMentions",
  "ambiguousMentions",
  "omittedResolvedCards",
  "userProvidedCardTexts",
  "modelCardNameCandidates",
]);

const RETRIEVAL_CARD_KEYS = Object.freeze([
  "retrievedCards",
  "remainingUnresolvedMentions",
  "fuzzyResolvedCards",
  "baigeResolvedCards",
  "baigeAmbiguousMentions",
]);

const offlineEnv = Object.freeze({
  RAG_LIVE_OFFICIAL_QA: "false",
});

test("explicit canonical registration prevents non-idempotent records from being normalized twice", () => {
  const firstPass = normalizeInjectedData({
    cards: [{ id: 1, name: "合成测试卡" }],
    records: [{
      id: "synthetic-faq",
      recordType: "card-faq",
      title: "合成测试卡 FAQ 1",
      answer: "处理说明。",
    }],
    qaRecords: [],
  });
  // A serialized runtime bundle loses WeakMap/cache identity. Registration is
  // therefore deliberately repeated only after the detached snapshot has been
  // validated by its loader.
  const detached = registerCanonicalNormalizedRagData(
    JSON.parse(JSON.stringify(firstPass)),
  );
  const reinjected = normalizeInjectedData(detached);

  assert.strictEqual(reinjected.cards, detached.cards);
  assert.strictEqual(reinjected.records, detached.records);
  assert.strictEqual(reinjected.qaRecords, detached.qaRecords);
  assertByteExactJson(reinjected, detached, "synthetic canonical reinjection");
  assert.equal(reinjected.records[0].text, "处理说明。");
});

test("precompiled RAG runtime is byte-exact with the raw loader and four real retrieval prompts", async () => {
  // Keep the parity gate deliberately single-path-at-a-time. Both corpora must
  // coexist for comparison, but parsing/decompression and the two full index
  // scans need not create an avoidable concurrent memory/CPU peak.
  const fixture = await readFixture();
  const rawData = await loadRawRagData(dataDir);
  const runtimeBundle = await loadRagRuntimeBundle({ dataDir });

  assert.equal(runtimeBundle.ok, true, runtimeFailureDiagnostic(runtimeBundle));
  assert.equal(fixture.cases.length, 4, "the parity gate must retain all four real dry-run cases");

  for (const corpus of RAG_RUNTIME_CORPORA) {
    const raw = corpusDigest(rawData[corpus.key]);
    const bundled = corpusDigest(runtimeBundle.data[corpus.key]);
    assert.deepEqual(
      bundled,
      raw,
      `${corpus.key} count or byte-exact corpus serialization changed`,
    );
    assert.equal(
      bundled.sha256,
      runtimeBundle.manifest.corpora[corpus.key].canonicalSha256,
      `${corpus.key} bytes are not bound to the runtime manifest`,
    );
  }

  for (const definition of fixture.cases) {
    const modelCardNameCandidates = Object.freeze(definition.candidateCards.map((name) => Object.freeze({
      name,
      originalText: name,
    })));
    clearBaigeSearchCache();
    const rawRun = await runRetrievalPath({ definition, data: rawData, modelCardNameCandidates });
    clearBaigeSearchCache();
    const bundledRun = await runRetrievalPath({
      definition,
      data: runtimeBundle.data,
      modelCardNameCandidates,
    });

    assertCardResolutionParity(definition.id, "extract", rawRun.extracted, bundledRun.extracted);
    assertCardResolutionParity(
      definition.id,
      "retrieval",
      rawRun.evidence.cardResolution,
      bundledRun.evidence.cardResolution,
    );

    for (const key of EVIDENCE_BUCKET_KEYS) {
      assertByteExactJson(
        bundledRun.evidence[key] || [],
        rawRun.evidence[key] || [],
        `${definition.id}: evidence bucket ${key}`,
      );
    }
    for (const key of RETRIEVAL_CARD_KEYS) {
      assertByteExactJson(
        bundledRun.evidence[key] || [],
        rawRun.evidence[key] || [],
        `${definition.id}: retrieval card field ${key}`,
      );
    }
    assertByteExactJson(
      bundledRun.evidence.ruleSearchQueries || [],
      rawRun.evidence.ruleSearchQueries || [],
      `${definition.id}: rule search queries`,
    );
    assertByteExactJson(
      bundledRun.evidence.retrievalWarnings || [],
      rawRun.evidence.retrievalWarnings || [],
      `${definition.id}: retrieval warnings`,
    );
    assertByteExactJson(
      withoutDebugTimings(bundledRun.evidence.debug),
      withoutDebugTimings(rawRun.evidence.debug),
      `${definition.id}: retrieval debug excluding timings`,
    );

    assert.equal(
      bundledRun.promptBundle.prompt,
      rawRun.promptBundle.prompt,
      `${definition.id}: final prompt changed`,
    );
    assert.equal(
      bundledRun.promptBundle.recoveryPrompt,
      rawRun.promptBundle.recoveryPrompt,
      `${definition.id}: recovery prompt changed`,
    );
    assertByteExactJson(
      bundledRun.promptBundle.warnings,
      rawRun.promptBundle.warnings,
      `${definition.id}: prompt warnings`,
    );
    assert.equal(
      bundledRun.promptBundle.authoritativeOfficialDirectId,
      rawRun.promptBundle.authoritativeOfficialDirectId,
      `${definition.id}: authoritative official direct id changed`,
    );
  }
});

async function runRetrievalPath({ definition, data, modelCardNameCandidates }) {
  const extracted = extractRagCards(definition.question, {
    cards: data.cards,
    modelCardNameCandidates,
  });
  const evidence = await retrieveRagEvidence({
    userQuery: definition.question,
    cardResolution: extracted,
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
    enableLiveOfficialQa: false,
    env: offlineEnv,
    fetchImpl: unavailableFetch,
  });
  const promptBundle = buildRagRulingPromptBundle({
    userQuery: definition.question,
    cardResolution: evidence.cardResolution || extracted,
    evidence,
    env: offlineEnv,
  });
  return { extracted, evidence, promptBundle };
}

function assertCardResolutionParity(caseId, stage, raw, bundled) {
  for (const key of CARD_RESOLUTION_KEYS) {
    assertByteExactJson(
      bundled?.[key] || [],
      raw?.[key] || [],
      `${caseId}: ${stage} card resolution ${key}`,
    );
  }
  assertByteExactJson(bundled || {}, raw || {}, `${caseId}: complete ${stage} card resolution`);
}

function corpusDigest(value) {
  const bytes = canonicalJsonBytes(value);
  return Object.freeze({
    count: Array.isArray(value) ? value.length : -1,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

function assertByteExactJson(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}: object values or array order changed`);
  const actualBytes = canonicalJsonBytes(actual);
  const expectedBytes = canonicalJsonBytes(expected);
  assert.deepEqual(
    { bytes: actualBytes.byteLength, sha256: sha256(actualBytes) },
    { bytes: expectedBytes.byteLength, sha256: sha256(expectedBytes) },
    `${label}: JSON byte serialization changed`,
  );
}

function withoutDebugTimings(debug) {
  if (!debug || typeof debug !== "object" || Array.isArray(debug)) return debug || {};
  const { timingsMs: _ignored, ...rest } = debug;
  return rest;
}

async function readFixture() {
  const parsed = JSON.parse(await readFile(casesPath, "utf8"));
  assert.equal(parsed?.schemaVersion, 1, "unsupported parity fixture schemaVersion");
  assert.ok(Array.isArray(parsed?.cases), "parity fixture cases must be an array");
  for (const definition of parsed.cases) {
    assert.equal(typeof definition?.id, "string", "parity case id is required");
    assert.equal(typeof definition?.question, "string", `${definition?.id}: question is required`);
    assert.ok(
      Array.isArray(definition?.candidateCards) && definition.candidateCards.length > 0,
      `${definition?.id}: fixed model card candidates are required`,
    );
  }
  return parsed;
}

async function unavailableFetch() {
  return new Response("{}", {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

function runtimeFailureDiagnostic(runtimeBundle) {
  return JSON.stringify({
    reason: runtimeBundle?.reason || "unknown",
    reasons: runtimeBundle?.reasons || [],
  });
}
