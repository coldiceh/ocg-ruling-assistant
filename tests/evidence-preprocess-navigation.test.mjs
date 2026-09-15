import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEvidenceGenerationContract } from "../backend/evidenceGenerationContract.mjs";
import {
  normalizeNavigationOutput,
  planNavigationMisses,
  runNavigationPreparation,
  selectNavigationCoverage,
  validateNavigationInputs,
} from "../scripts/prepare-evidence-navigation.mjs";
import {
  createLocalEvidencePreprocessCache,
  createRedisEvidencePreprocessCache,
  denseCacheKey,
  navigationCacheKey,
  reserveLocalPreprocessBudget,
  settleLocalPreprocessBudget,
  sha256,
  stableJson,
} from "../scripts/lib/evidence-preprocess-cache.mjs";

const profileUrl = new URL("../config/evidence-generation/gemini-3.8-flash-low.json", import.meta.url);
const contract = loadEvidenceGenerationContract("navigation", { profileUrl });

function input(unitKey, sourceKind, extras = {}) {
  const projected = {
    sourceKind,
    titlePath: extras.titlePath || [unitKey],
    unitText: `${unitKey} public text`,
    unitStructure: extras.unitStructure || { blocks: [] },
    structuralContextTexts: [],
    structuralContextStructures: [],
    explicitLinkedTitles: [],
  };
  return {
    unitKey,
    sourceId: `source:${unitKey}`,
    canonicalBodySha256: sha256(`${unitKey}:canonical`),
    contextRefs: [],
    explicitRefs: extras.explicitRefs || [],
    input: projected,
    contextInputSha256: sha256(stableJson(projected)),
  };
}

function sampleInputs() {
  return validateNavigationInputs([
    input("parent", "rule", { titlePath: ["root", "child"] }),
    input("list", "rule", { unitStructure: { blocks: [{ kind: "list" }] } }),
    input("table", "rule", { unitStructure: { tables: [{ rowCount: 1, columnCount: 1, cells: [] }] } }),
    input("link", "rule", { explicitRefs: ["ref:1"] }),
    input("qa", "qa"),
    input("faq", "faq"),
    input("opaque", "rule", { unitStructure: { blocks: [{ kind: "opaque" }] } }),
  ]);
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "evidence-preprocess-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeLedger(path, overrides = {}) {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    authorizationId: "fixture-authorization",
    limitUsd: 6,
    spentUsd: 4.3439,
    reservedUsd: 0,
    tickets: {},
    ...overrides,
  }, null, 2)}\n`, "utf8");
}

test("coverage scope is frozen, structure-stratified and dry-run performs zero provider calls", async (t) => {
  const directory = await temporaryDirectory(t);
  const inputs = sampleInputs();
  const coverage = selectNavigationCoverage(inputs);
  assert.deepEqual(coverage.missingCategories, []);
  assert.deepEqual(new Set(coverage.selectedUnitKeys), new Set(inputs.map((row) => row.unitKey)));
  assert.deepEqual(selectNavigationCoverage([...inputs].reverse()), coverage);

  let calls = 0;
  const result = await runNavigationPreparation({
    inputs,
    cache: createLocalEvidencePreprocessCache({ cacheDir: directory }),
    contract,
    execute: false,
    countTokens: async () => { calls += 1; },
    generateContent: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
  assert.equal(result.report.generationMisses, 7);
  assert.equal(result.report.ordinaryQaCanonicalCount, 1);
  assert.equal(result.report.ruleReadingUnitCount, 5);
  assert.equal(result.report.faqUnitCount, 1);
  assert.equal(result.report.tokenEstimate.status, "provider_measurement_required");
  assert.ok(result.records.every((row) => row.navigationStatus === "blocked_before_attempt"));
});

test("input binding and nav/dense cache domains are mechanical and independent", () => {
  const row = input("bound", "rule");
  assert.throws(() => validateNavigationInputs([{ ...row, contextInputSha256: "0".repeat(64) }]), /context_input_hash_mismatch/u);
  const nav = navigationCacheKey({
    contract: { ...contract, generationContractSha256: "a".repeat(64) },
    promptContractSha256: "b".repeat(64),
    contextInputSha256: row.contextInputSha256,
  });
  const dense = denseCacheKey({
    embeddingModel: contract.modelId,
    dimension: 768,
    embeddingInputContractHash: "b".repeat(64),
    embeddingInputTextHash: row.contextInputSha256,
  });
  assert.notEqual(nav, dense);
});

test("normalizer deterministically accepts wrappers and duplicate questions but not missing meaning", () => {
  const normalized = normalizeNavigationOutput("```json\n{\"navigation\":{\"descriptionZh\":\" 中文 \" ,\"descriptionJa\":[\"日本語\"],\"searchQuestions\":[{\"language\":\"zh\",\"text\":\"问题\"},{\"language\":\"zh\",\"text\":\"问题\"},{\"language\":\"ja\",\"text\":\"質問\"}]}}\n```");
  assert.deepEqual(normalized, {
    descriptionZh: "中文",
    descriptionJa: "日本語",
    searchQuestions: [{ language: "zh", text: "问题" }, { language: "ja", text: "質問" }],
  });
  assert.throws(() => normalizeNavigationOutput({ descriptionZh: "中文", descriptionJa: "日本語" }), /searchQuestions/u);
});

test("execute saves each paid raw response before normalization, retries format once and settles the existing ledger", async (t) => {
  const directory = await temporaryDirectory(t);
  const ledgerPath = join(directory, "ledger.json");
  await writeLedger(ledgerPath);
  const cache = createLocalEvidencePreprocessCache({ cacheDir: join(directory, "cache") });
  const inputs = [input("only", "rule")];
  const coverageScope = { selectedUnitKeys: ["only"], seed: "fixture", method: "fixture", requiredCategories: [], categorySelections: {}, missingCategories: [] };
  let generated = 0;
  const result = await runNavigationPreparation({
    inputs,
    cache,
    contract,
    execute: true,
    maxUsd: 0.02,
    ledgerPath,
    coverageScope,
    countTokens: async () => ({ totalTokens: 100 }),
    generateContent: async () => {
      generated += 1;
      const text = generated === 1
        ? "{\"descriptionZh\":\"缺字段\"}"
        : "{\"descriptionZh\":\"中文\",\"descriptionJa\":\"日本語\",\"searchQuestions\":[{\"language\":\"zh\",\"text\":\"问题\"},{\"language\":\"ja\",\"text\":\"質問\"}]}";
      return {
        candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 0, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 110 },
      };
    },
  });
  assert.equal(generated, 2);
  assert.equal(result.records[0].navigationStatus, "generated");
  const planned = await planNavigationMisses({ inputs, cache, contract, coverageScope });
  assert.equal(planned.rows[0].state, "cache_hit");
  const raw0 = await cache.readResult("nav", planned.rows[0].key, "raw-attempt-0");
  const raw1 = await cache.readResult("nav", planned.rows[0].key, "raw-attempt-1");
  assert.equal(raw0.attempt, 0);
  assert.equal(raw1.attempt, 1);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.reservedUsd, 0);
  assert.ok(ledger.spentUsd > 4.3439);
  assert.equal(Object.values(ledger.tickets).filter((row) => row.state === "settled").length, 2);
});

test("missing generation usage keeps the reservation while the normalized result remains reusable", async (t) => {
  const directory = await temporaryDirectory(t);
  const ledgerPath = join(directory, "ledger.json");
  await writeLedger(ledgerPath);
  const cache = createLocalEvidencePreprocessCache({ cacheDir: join(directory, "cache") });
  const inputs = [input("unknown-usage", "rule")];
  const coverageScope = { selectedUnitKeys: ["unknown-usage"] };
  const result = await runNavigationPreparation({
    inputs,
    cache,
    contract,
    execute: true,
    maxUsd: 0.02,
    ledgerPath,
    coverageScope,
    countTokens: async () => ({ totalTokens: 100 }),
    generateContent: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        descriptionZh: "中文",
        descriptionJa: "日本語",
        searchQuestions: [{ language: "zh", text: "问题" }, { language: "ja", text: "質問" }],
      }) }] } }],
    }),
  });
  assert.equal(result.records[0].navigationStatus, "generated");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.spentUsd, 4.3439);
  assert.ok(ledger.reservedUsd > 0);
  assert.equal(Object.values(ledger.tickets).filter((row) => row.state === "reserved").length, 1);
  const replay = await planNavigationMisses({ inputs, cache, contract, coverageScope });
  assert.equal(replay.rows[0].state, "cache_hit");
});

test("the complete provider response survives extraction failure and is replayed without a second call", async (t) => {
  const directory = await temporaryDirectory(t);
  const ledgerPath = join(directory, "ledger.json");
  await writeLedger(ledgerPath);
  const cache = createLocalEvidencePreprocessCache({ cacheDir: join(directory, "cache") });
  const inputs = [input("provider-raw-replay", "rule")];
  const coverageScope = { selectedUnitKeys: ["provider-raw-replay"] };
  let generated = 0;
  const providerResponse = {
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      descriptionZh: "中文",
      descriptionJa: "日本語",
      searchQuestions: [{ language: "zh", text: "问题" }, { language: "ja", text: "質問" }],
    }) }] } }],
    usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 0, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 110 },
  };
  await assert.rejects(runNavigationPreparation({
    inputs,
    cache,
    contract,
    execute: true,
    maxUsd: 0.02,
    ledgerPath,
    coverageScope,
    countTokens: async () => ({ totalTokens: 100 }),
    generateContent: async () => { generated += 1; return providerResponse; },
    extractText: () => { throw new Error("fixture_extract_failure"); },
  }), /fixture_extract_failure/u);
  assert.equal(generated, 1);
  const interrupted = await planNavigationMisses({ inputs, cache, contract, coverageScope });
  assert.equal(interrupted.rows[0].state, "provider_raw_reusable");
  assert.deepEqual(interrupted.rows[0].cached.providerRaw.providerResponse, providerResponse);

  const resumed = await runNavigationPreparation({
    inputs,
    cache,
    contract,
    execute: true,
    maxUsd: 0.02,
    ledgerPath,
    coverageScope,
    countTokens: async () => ({ totalTokens: 100 }),
    generateContent: async () => { generated += 1; throw new Error("must_not_call"); },
  });
  assert.equal(generated, 1);
  assert.equal(resumed.records[0].navigationStatus, "generated");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.reservedUsd, 0);
});

test("capacity or budget rejection is blocked before generation with attemptCount zero", async (t) => {
  const directory = await temporaryDirectory(t);
  const ledgerPath = join(directory, "ledger.json");
  await writeLedger(ledgerPath, { spentUsd: 5.99999 });
  const inputs = [input("blocked", "rule")];
  let generated = 0;
  const result = await runNavigationPreparation({
    inputs,
    cache: createLocalEvidencePreprocessCache({ cacheDir: join(directory, "cache") }),
    contract,
    execute: true,
    maxUsd: 0.02,
    ledgerPath,
    coverageScope: { selectedUnitKeys: ["blocked"] },
    countTokens: async () => ({ totalTokens: 100 }),
    generateContent: async () => { generated += 1; },
  });
  assert.equal(generated, 0);
  assert.equal(result.exitCode, 3);
  assert.equal(result.records[0].navigationStatus, "blocked_before_attempt");
  assert.equal(result.records[0].attemptCount, 0);
  assert.equal(result.records[0].mechanicalReason, "budget_exceeded");

  const capacityLedgerPath = join(directory, "capacity-ledger.json");
  await writeLedger(capacityLedgerPath);
  const capacityInputs = [input("too-large", "rule")];
  const capacityResult = await runNavigationPreparation({
    inputs: capacityInputs,
    cache: createLocalEvidencePreprocessCache({ cacheDir: join(directory, "capacity-cache") }),
    contract,
    execute: true,
    maxUsd: 0.02,
    ledgerPath: capacityLedgerPath,
    coverageScope: { selectedUnitKeys: ["too-large"] },
    countTokens: async () => ({ totalTokens: 2_000_000 }),
    generateContent: async () => { generated += 1; },
  });
  assert.equal(generated, 0);
  assert.equal(capacityResult.records[0].mechanicalReason, "provider_input_capacity_exceeded");
});

test("one local ledger lock prevents concurrent workers from both spending the same remainder", async (t) => {
  const directory = await temporaryDirectory(t);
  const ledgerPath = join(directory, "ledger.json");
  await writeLedger(ledgerPath, { limitUsd: 1, spentUsd: 0.9 });
  const outcomes = await Promise.allSettled([
    reserveLocalPreprocessBudget({ ledgerPath, ticket: "a", amountUsd: 0.08, maxUsd: 1 }),
    reserveLocalPreprocessBudget({ ledgerPath, ticket: "b", amountUsd: 0.08, maxUsd: 1 }),
  ]);
  assert.equal(outcomes.filter((row) => row.status === "fulfilled").length, 1);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.reservedUsd, 0.08);
});

test("the authorized legacy ledger keeps its history while preprocess stage fields are appended", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-preprocess-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, "ledger.json");
  const historicalRows = [{ phase: "paid-history", amountUsd: 4.343913597857144 }];
  const legacy = {
    startedAt: "2026-09-01T00:00:00.000Z",
    decision: "authorized-bounded-run",
    limitUsd: 6,
    usdCnyIllustrative: 7,
    priorAccountedUsd: 4.343913597857144,
    priorRemainingUsdNotAdded: 0,
    spentUsd: 4.343913597857144,
    reservedUsd: 0,
    rows: historicalRows,
    stopOnFirstSemanticFailure: true,
    budgetScope: "fixture",
    finalEvaluationLimitUsd: null,
    authorizationUpdatedAt: "2026-09-01T00:00:00.000Z",
    requireSameVersionRegression: true,
    regressionPolicy: "fixture",
  };
  await writeFile(ledgerPath, JSON.stringify(legacy));
  await reserveLocalPreprocessBudget({ ledgerPath, ticket: "legacy-ticket", amountUsd: 0.01, maxUsd: 0.02 });
  await settleLocalPreprocessBudget({ ledgerPath, ticket: "legacy-ticket", spentUsd: 0.004 });
  const updated = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.deepEqual(updated.rows, historicalRows);
  assert.equal(updated.priorAccountedUsd, legacy.priorAccountedUsd);
  assert.ok(Math.abs(updated.spentUsd - 4.347913597857144) < 1e-12);
  assert.equal(updated.reservedUsd, 0);
  assert.equal(updated.stageSpentUsd, 0.004);
  assert.equal(updated.stageReservedUsd, 0);
  assert.deepEqual(updated.tickets["legacy-ticket"], { state: "settled", reservedUsd: 0.01, spentUsd: 0.004 });
});

test("Redis adapter keeps nav/dense namespaces separate and restart contenders observe the existing claim/result", async () => {
  const values = new Map();
  const command = async (args) => {
    if (args[0] === "GET") return values.get(args[1]) ?? null;
    const script = args[1];
    const resultKey = args[3];
    if (script.includes("local complete")) {
      const rawKey = args[4];
      const claimKey = args[5];
      if (values.has(resultKey)) return ["COMPLETE", values.get(resultKey)];
      if (values.has(rawKey)) return ["RAW", values.get(rawKey)];
      if (!values.has(claimKey)) {
        values.set(claimKey, args[6]);
        return ["CLAIMED", args[6]];
      }
      return ["BUSY", values.get(claimKey)];
    }
    if (script.includes("RAW_MISSING")) {
      const rawKey = args[4];
      if (!values.has(rawKey)) return ["RAW_MISSING"];
      if (values.has(resultKey) && values.get(resultKey) !== args[5]) return ["CONFLICT"];
      values.set(resultKey, args[5]);
      return ["SAVED"];
    }
    const claimKey = args[4];
    if (values.get(claimKey) !== args[5]) return ["OWNER_MISMATCH"];
    values.set(resultKey, args[6]);
    values.delete(claimKey);
    return ["SAVED"];
  };
  const first = createRedisEvidencePreprocessCache({ command, ownerId: "worker-1" });
  const contender = createRedisEvidencePreprocessCache({ command, ownerId: "worker-2" });
  assert.equal((await first.claimNavigation("same", "ticket-1")).status, "claimed");
  assert.equal((await contender.claimNavigation("same", "ticket-2")).status, "busy");
  await first.saveNavigation("same", "ticket-1", { key: "same", status: "complete" });
  const restarted = createRedisEvidencePreprocessCache({ command, ownerId: "worker-3" });
  assert.equal((await restarted.claimNavigation("same", "ticket-3")).status, "complete");
  assert.equal((await restarted.claimDense("same", "dense-ticket")).status, "claimed");
  assert.notEqual(first.navKey("same"), first.denseKey("same"));

  assert.equal((await first.claimNavigation("raw", "raw-ticket")).status, "claimed");
  await first.writeRaw("nav", "raw", { ticket: "raw-ticket", value: { key: "raw", kind: "raw", rawResponse: "{}" } });
  assert.equal((await restarted.claimNavigation("raw", "retry-ticket")).status, "raw_reusable");
  await restarted.writeResult("nav", "raw", { value: { key: "raw", kind: "normalized", normalizerVersion: "v2" } });
  assert.equal((await restarted.claimNavigation("raw", "after-normalize")).status, "complete");
});
