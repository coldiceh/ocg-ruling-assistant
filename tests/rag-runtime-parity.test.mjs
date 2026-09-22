import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

import { clearBaigeSearchCache } from "../backend/baigeCardProvider.mjs";
import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import {
  loadRawRagData,
  normalizeInjectedData,
  retrieveRagEvidence,
} from "../backend/ragEvidenceRetriever.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import { bindOfficialQaDiscoveryRelations } from "../backend/officialQaDiscoveryRelations.mjs";
import {
  canonicalJsonBytes,
  loadRagRuntimeBundle,
  RAG_RUNTIME_CORPORA,
  sha256,
} from "../backend/ragRuntimeBundle.mjs";
import { buildRagRuntimeBundle } from "../backend/ragRuntimeBundleCompiler.mjs";
import { RAG_DATA_REVISION_MANIFEST_FILE, RAG_DATA_REVISION_SOURCE_FILES } from "../backend/ragDataRevisionManifest.mjs";
import { registerCanonicalNormalizedRagData } from "../backend/ragNormalizedDataRegistry.mjs";

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

test("precompiled RAG runtime is byte-exact with the raw loader and synthetic retrieval prompts", async (t) => {
  const fixture = await createSyntheticFixture();
  const { dataDir } = fixture;
  t.after(async () => {
    const root = resolve(fixture.root);
    assert.ok(root.startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  const built = await buildRagRuntimeBundle({ dataDir, loadNormalizedData: loadRawRagData });
  // Load the raw path from a separately persisted source snapshot so its
  // revision manifest is present before the production loader caches it.
  const rawDataDir = join(fixture.root, "raw");
  await mkdir(rawDataDir);
  await Promise.all(RAG_DATA_REVISION_SOURCE_FILES.map((name) => (
    copyFile(join(dataDir, name), join(rawDataDir, name))
  )));
  await writeFile(join(rawDataDir, RAG_DATA_REVISION_MANIFEST_FILE), JSON.stringify(built.revisionManifest), "utf8");
  const rawData = await loadRawRagData(rawDataDir);
  const runtimeBundle = await loadRagRuntimeBundle({
    dataDir,
    sourceRevisionManifest: built.revisionManifest,
  });

  assert.equal(runtimeBundle.ok, true, runtimeFailureDiagnostic(runtimeBundle));
  // The production loadRagData path binds this weak discovery sidecar after
  // loading either raw or precompiled data. The parity test injects the
  // bundle directly, so reproduce that lifecycle before comparing retrieval.
  await bindOfficialQaDiscoveryRelations({
    dataDir,
    data: runtimeBundle.data,
    requireTrustedData: true,
  });
  assert.equal(fixture.cases.length, 4, "the parity gate retains four synthetic input shapes");

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

    assert.ok(rawRun.extracted.resolvedCards.length > 0, `${definition.id}: synthetic cards must resolve`);
    assert.ok(rawRun.evidence.cardTexts.length > 0, `${definition.id}: synthetic card text must be emitted`);
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

async function createSyntheticFixture() {
  const root = await mkdtemp(join(tmpdir(), "rag-parity-synthetic-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  // These inputs exercise serialization, aliases, ordering and source fields.
  // They contain no game scenario, reference ruling or historical test answer.
  const sources = {
    "cards.json": { records: [
      { id: 31001, name: "协议甲", aliases: ["协议甲别名"], effectText: "合成卡文甲。\n字段字符：\"甲\"。" },
      { id: 31002, name: "协议乙", aliases: [], effectText: "合成卡文乙。" },
    ] },
    "rulings.json": { records: [
      { id: "synthetic-rule-a", title: "协议甲资料", text: "合成资料正文甲。", cards: ["协议甲"] },
    ] },
    "qa-index.json": { records: [
      { id: "synthetic-qa-a", recordType: "qa", question: "协议甲的合成字段是什么？", answer: "字段内容甲。", cardIds: ["31001"],
        questionLocales: { ja: { question: "合成フィールド甲？" }, cn: { question: "合成字段甲？" } } },
      { id: "synthetic-qa-b", recordType: "qa", question: "协议乙的合成字段是什么？", answer: "字段内容乙。", cardIds: ["31002"] },
    ] },
    "evidence-index.json": { records: [
      { id: "synthetic-faq-b", recordType: "faq", title: "协议乙资料", text: "合成补充正文乙。", cards: ["协议乙"] },
      { id: "synthetic-rule-duplicate", sourceId: "ocg-rule", stableId: "ocg-rule:synthetic-parity", text: "合成旧重复条目。" },
    ] },
    "ocg-rule-corpus.json": { records: [
      { id: "synthetic-rulebook", sourceId: "ocg-rule", stableId: "ocg-rule:synthetic-parity", title: "合成规则条目", text: "合成规则字段正文。" },
    ] },
    "official-responses.json": { records: [
      { id: "synthetic-response", sourceType: "official_response_screenshot", title: "合成来源字段", scenario: "合成输入字段。", officialText: "合成来源正文字段。", cards: ["协议乙"] },
    ] },
  };
  await Promise.all(Object.entries(sources).map(([name, value]) => (
    writeFile(join(dataDir, name), JSON.stringify(value) + "\n", "utf8")
  )));
  return {
    root,
    dataDir,
    cases: [
      { id: "synthetic-name", question: "请展示「协议甲」的资料。", candidateCards: ["协议甲"] },
      { id: "synthetic-second", question: "请展示「协议乙」的资料。", candidateCards: ["协议乙"] },
      { id: "synthetic-alias", question: "请展示「协议甲别名」和「协议乙」的资料。", candidateCards: ["协议甲别名", "协议乙"] },
      { id: "synthetic-pair", question: "请展示「协议甲」和「协议乙」及合成规则条目。", candidateCards: ["协议甲", "协议乙"] },
    ],
  };
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
