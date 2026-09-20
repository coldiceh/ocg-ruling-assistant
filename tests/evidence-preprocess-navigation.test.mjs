import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  generationContractSha256,
  loadEvidenceGenerationContract,
} from "../backend/evidenceGenerationContract.mjs";
import {
  normalizeNavigationOutput,
  planNavigationMisses,
  runNavigationCli,
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
    unitText: sourceKind === "rule" ? `${unitKey} public text`
      : JSON.stringify({ id: unitKey, text: `${unitKey} public text` }),
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

test("navigation CLI executes a reviewed BAI theoretical profile through the generic measurement contract", async (t) => {
  const directory = await temporaryDirectory(t);
  const ledgerPath = join(directory, "ledger.json");
  const inputsPath = join(directory, "navigation-inputs.json");
  const outDir = join(directory, "output");
  await writeLedger(ledgerPath);
  await writeFile(inputsPath, JSON.stringify([input("bai-cli", "rule")]), "utf8");
  let calls = 0;
  const result = await runNavigationCli([
    "--inputs", inputsPath,
    "--cache-dir", join(directory, "cache"),
    "--out-dir", outDir,
    "--generation-profile", fileURLToPath(new URL(
      "../config/evidence-generation/bai-deepseek-v4.1-flash-none-theoretical.json",
      import.meta.url,
    )),
    "--ledger", ledgerPath,
    "--max-usd", "1",
    "--job-runtime-ms", "3600000",
    "--request-timeout-ms", "300000",
    "--all-inputs",
    "--execute",
  ], {
    env: { BAI_API_KEY: "fixture-only" },
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, "https://api.b.ai/v1/responses");
      assert.ok(options.signal instanceof AbortSignal);
      const request = JSON.parse(options.body);
      assert.equal(request.model, "deepseek-v4.1-flash");
      return new Response(JSON.stringify({
        model: "deepseek-v4.1-flash",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
          descriptionZh: "中文",
          descriptionJa: "日本語",
          searchQuestions: [{ language: "zh", text: "问题" }, { language: "ja", text: "質問" }],
        }) }] }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.records[0].navigationStatus, "generated");
});

test("CLI applies the request timeout to Gemini token counting and generation", async (t) => {
  const directory = await temporaryDirectory(t);
  const ledgerPath = join(directory, "ledger.json");
  const inputsPath = join(directory, "navigation-inputs.json");
  await writeLedger(ledgerPath);
  await writeFile(inputsPath, JSON.stringify([input("gemini-timeout", "qa")]), "utf8");
  const operations = [];
  const result = await runNavigationCli([
    "--inputs", inputsPath,
    "--cache-dir", join(directory, "cache"),
    "--out-dir", join(directory, "output"),
    "--generation-profile", fileURLToPath(profileUrl),
    "--ledger", ledgerPath,
    "--max-usd", "1",
    "--request-timeout-ms", "300000",
    "--all-inputs",
    "--execute",
  ], {
    env: { GEMINI_RULE_QA_API_KEY: "fixture-only" },
    fetchImpl: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      if (String(url).endsWith(":countTokens")) {
        operations.push("countTokens");
        return new Response(JSON.stringify({ totalTokens: 100 }), { status: 200 });
      }
      operations.push("generateContent");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          descriptionZh: "中文",
          descriptionJa: "日本語",
          searchQuestions: [
            { language: "zh", text: "问题" },
            { language: "ja", text: "質問" },
          ],
        }) }] } }],
        usageMetadata: {
          promptTokenCount: 100, cachedContentTokenCount: 0, candidatesTokenCount: 10,
          thoughtsTokenCount: 0, totalTokenCount: 110,
        },
      }), { status: 200 });
    },
  });
  assert.deepEqual(operations, ["countTokens", "generateContent"]);
  assert.equal(result.records[0].navigationStatus, "generated");
});

test("rule rows use their selected navigation contract in one queue and restart without duplicate billing", async (t) => {
  const directory = await temporaryDirectory(t);
  const ledgerPath = join(directory, "ledger.json");
  const inputsPath = join(directory, "navigation-inputs.json");
  const outDir = join(directory, "output");
  await writeLedger(ledgerPath);
  await writeFile(inputsPath, JSON.stringify([
    input("qa-none", "qa"),
    input("rule-low", "rule"),
  ]), "utf8");
  const noneProfileUrl = new URL(
    "../config/evidence-generation/bai-deepseek-v4.1-flash-none-navigation-promotion.json",
    import.meta.url,
  );
  const lowProfileUrl = new URL(
    "../config/evidence-generation/bai-deepseek-v4.1-flash-low-navigation-promotion.json",
    import.meta.url,
  );
  const noneContract = loadEvidenceGenerationContract("navigation", { profileUrl: noneProfileUrl });
  const lowContract = loadEvidenceGenerationContract("navigation", { profileUrl: lowProfileUrl });
  const dry = await runNavigationPreparation({
    inputs: [input("qa-none-dry", "qa"), input("rule-low-dry", "rule")],
    cache: createLocalEvidencePreprocessCache({ cacheDir: join(directory, "dry-cache") }),
    contract: noneContract,
    ruleGenerationContract: lowContract,
    execute: false,
    coverageScope: { selectedUnitKeys: ["qa-none-dry", "rule-low-dry"] },
  });
  assert.equal(dry.report.generationMisses, 2);
  assert.equal(dry.report.profile.generationContractSha256, generationContractSha256(noneContract));
  assert.equal(dry.report.ruleProfile.generationContractSha256, generationContractSha256(lowContract));
  const calls = [];
  const argv = [
    "--inputs", inputsPath,
    "--cache-dir", join(directory, "cache"),
    "--out-dir", outDir,
    "--generation-profile", fileURLToPath(noneProfileUrl),
    "--rule-generation-profile", fileURLToPath(lowProfileUrl),
    "--ledger", ledgerPath,
    "--max-usd", "1",
    "--job-runtime-ms", "3600000",
    "--request-timeout-ms", "300000",
    "--all-inputs",
    "--execute",
  ];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ effort: request.reasoning.effort, maxOutputTokens: request.max_output_tokens });
    return new Response(JSON.stringify({
      model: "deepseek-v4.1-flash",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
        descriptionZh: `zh:${request.reasoning.effort}`,
        descriptionJa: `ja:${request.reasoning.effort}`,
        searchQuestions: [
          { language: "zh", text: `zh:${request.reasoning.effort}` },
          { language: "ja", text: `ja:${request.reasoning.effort}` },
        ],
      }) }] }],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const first = await runNavigationCli(argv, { env: { BAI_API_KEY: "fixture-only" }, fetchImpl });
  assert.deepEqual(calls.sort((a, b) => a.effort.localeCompare(b.effort)), [
    { effort: "low", maxOutputTokens: 12288 },
    { effort: "none", maxOutputTokens: 2048 },
  ]);
  assert.deepEqual(first.records.map((row) => row.generator.reasoningConfig.responses.effort), ["none", "low"]);
  assert.notEqual(
    first.records[0].generator.generationContractSha256,
    first.records[1].generator.generationContractSha256,
  );
  const ledgerAfterFirst = await readFile(ledgerPath, "utf8");
  const tickets = Object.values(JSON.parse(ledgerAfterFirst).tickets);
  assert.equal(tickets.length, 2);
  assert.notEqual(tickets[0].reservedUsd, tickets[1].reservedUsd);

  const replay = await runNavigationCli(argv, { env: { BAI_API_KEY: "fixture-only" }, fetchImpl });
  assert.equal(calls.length, 2);
  assert.deepEqual(replay.records, first.records);
  assert.equal(await readFile(ledgerPath, "utf8"), ledgerAfterFirst);
});

test("bounded lazy execution stops before the job deadline and resumes without duplicate generation or ledger charges", async (t) => {
  const directory = await temporaryDirectory(t);
  const ledgerPath = join(directory, "ledger.json");
  await writeLedger(ledgerPath);
  const cache = createLocalEvidencePreprocessCache({ cacheDir: join(directory, "cache") });
  const inputs = ["one", "two", "three", "four", "five"].map((unitKey) => input(unitKey, "rule"));
  const coverageScope = { selectedUnitKeys: inputs.map((row) => row.unitKey) };
  const calls = new Map();
  const generateContent = async (body) => {
    const unitKey = JSON.parse(body.contents[0].parts[0].text).unitText.split(' ')[0];
    calls.set(unitKey, (calls.get(unitKey) || 0) + 1);
    return {
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        descriptionZh: `zh:${unitKey}`,
        descriptionJa: `ja:${unitKey}`,
        searchQuestions: [
          { language: "zh", text: `zh:${unitKey}` },
          { language: "ja", text: `ja:${unitKey}` },
        ],
      }) }] } }],
      usageMetadata: {
        promptTokenCount: 100, cachedContentTokenCount: 0, candidatesTokenCount: 10,
        thoughtsTokenCount: 0, totalTokenCount: 110,
      },
    };
  };
  const run = async (resumeCursor = null) => {
    let clock = 0;
    return runNavigationPreparation({
      inputs,
      cache,
      contract,
      execute: true,
      maxUsd: 0.5,
      ledgerPath,
      coverageScope,
      countTokens: async () => ({ totalTokens: 100 }),
      generateContent,
      runtimeLimitMs: 3,
      now: () => clock++,
      resumeCursor,
    });
  };

  const first = await run();
  assert.equal(first.report.complete, false);
  assert.equal(first.report.processedThisRun, 2);
  assert.equal(calls.size, 2);
  await assert.rejects(runNavigationPreparation({
    inputs: [...inputs].reverse(),
    cache,
    contract,
    execute: true,
    maxUsd: 0.5,
    ledgerPath,
    coverageScope,
    countTokens: async () => ({ totalTokens: 100 }),
    generateContent,
    resumeCursor: first.report.nextCursor,
  }), /navigation_resume_cursor_binding_mismatch/u);
  const second = await run(first.report.nextCursor);
  assert.equal(second.report.startOffset, 2);
  assert.equal(second.report.processedThisRun, 2);
  const third = await run(second.report.nextCursor);
  assert.equal(third.report.complete, true);
  assert.deepEqual(third.records.map((row) => row.unitKey), inputs.map((row) => row.unitKey));
  assert.ok([...calls.values()].every((count) => count === 1));
  const ledgerAfterFull = await readFile(ledgerPath, "utf8");

  const replay = await run(third.report.nextCursor);
  assert.equal(replay.report.complete, true);
  assert.equal(replay.report.processedThisRun, 0);
  assert.ok([...calls.values()].every((count) => count === 1));
  assert.equal(await readFile(ledgerPath, "utf8"), ledgerAfterFull);
});

test("navigation execution uses exactly two active requests, preserves order, retries per item, and resumes from cache", async (t) => {
  const directory = await temporaryDirectory(t);
  const ledgerPath = join(directory, "ledger.json");
  await writeLedger(ledgerPath);
  const cache = createLocalEvidencePreprocessCache({ cacheDir: join(directory, "cache") });
  const inputs = ["first", "second", "retry", "fourth"].map((unitKey) => input(unitKey, "rule"));
  const coverageScope = { selectedUnitKeys: inputs.map((row) => row.unitKey) };
  const callsByUnit = new Map();
  let active = 0;
  let maximumActive = 0;
  let generationCalls = 0;

  const generateContent = async (body) => {
    const unitKey = JSON.parse(body.contents[0].parts[0].text).unitText.split(' ')[0];
    const callCount = (callsByUnit.get(unitKey) || 0) + 1;
    callsByUnit.set(unitKey, callCount);
    generationCalls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const delays = { first: 40, second: 5, retry: 20, fourth: 1 };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delays[unitKey]));
    active -= 1;
    const text = unitKey === "retry" && callCount === 1
      ? JSON.stringify({ descriptionZh: "missing required fields" })
      : JSON.stringify({
        descriptionZh: `zh:${unitKey}`,
        descriptionJa: `ja:${unitKey}`,
        searchQuestions: [
          { language: "zh", text: `zh-question:${unitKey}` },
          { language: "ja", text: `ja-question:${unitKey}` },
        ],
      });
    return {
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 0,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 0,
        totalTokenCount: 110,
      },
    };
  };

  const firstRun = await runNavigationPreparation({
    inputs,
    cache,
    contract,
    execute: true,
    maxUsd: 0.5,
    ledgerPath,
    coverageScope,
    countTokens: async () => ({ totalTokens: 100 }),
    generateContent,
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(firstRun.records.map((row) => row.unitKey), inputs.map((row) => row.unitKey));
  assert.deepEqual(firstRun.records.map((row) => row.descriptionZh), inputs.map((row) => `zh:${row.unitKey}`));
  assert.deepEqual(Object.fromEntries(callsByUnit), { first: 1, second: 1, retry: 2, fourth: 1 });
  assert.equal(generationCalls, 5);
  const ledgerAfterFirstRun = await readFile(ledgerPath, "utf8");

  const resumed = await runNavigationPreparation({
    inputs,
    cache,
    contract,
    execute: true,
    maxUsd: 0.5,
    ledgerPath,
    coverageScope,
    countTokens: async () => ({ totalTokens: 100 }),
    generateContent: async () => {
      generationCalls += 1;
      throw new Error("cache_resume_must_not_generate");
    },
  });

  assert.equal(generationCalls, 5);
  assert.deepEqual(resumed.records, firstRun.records);
  assert.equal(await readFile(ledgerPath, "utf8"), ledgerAfterFirstRun);
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

test("a worker hard failure stops new claims and waits for the other paid response to save and settle", async (t) => {
  const directory = await temporaryDirectory(t);
  const ledgerPath = join(directory, "ledger.json");
  await writeLedger(ledgerPath);
  const cache = createLocalEvidencePreprocessCache({ cacheDir: join(directory, "cache") });
  const inputs = ["fails", "deferred", "must-not-start"].map((unitKey) => input(unitKey, "rule"));
  const coverageScope = { selectedUnitKeys: inputs.map((row) => row.unitKey) };
  let releaseDeferred;
  let markDeferredStarted;
  let markFailureThrown;
  const deferredStarted = new Promise((resolve) => { markDeferredStarted = resolve; });
  const failureThrown = new Promise((resolve) => { markFailureThrown = resolve; });
  const deferredResponse = new Promise((resolve) => { releaseDeferred = resolve; });
  const calls = [];

  const execution = runNavigationPreparation({
    inputs,
    cache,
    contract,
    execute: true,
    maxUsd: 0.5,
    ledgerPath,
    coverageScope,
    countTokens: async () => ({ totalTokens: 100 }),
    generateContent: async (body) => {
      const unitKey = JSON.parse(body.contents[0].parts[0].text).unitText.split(' ')[0];
      calls.push(unitKey);
      if (unitKey === "fails") {
        await deferredStarted;
        markFailureThrown();
        throw new Error("fixture_hard_failure");
      }
      if (unitKey === "deferred") {
        markDeferredStarted();
        return deferredResponse;
      }
      throw new Error("third_row_must_not_start");
    },
  });
  let outerSettled = false;
  execution.then(
    () => { outerSettled = true; },
    () => { outerSettled = true; },
  );
  await deferredStarted;
  await failureThrown;
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeDeferredResponse = outerSettled;
  releaseDeferred({
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      descriptionZh: "中文",
      descriptionJa: "日本語",
      searchQuestions: [
        { language: "zh", text: "问题" },
        { language: "ja", text: "質問" },
      ],
    }) }] } }],
    usageMetadata: {
      promptTokenCount: 100, cachedContentTokenCount: 0, candidatesTokenCount: 10,
      thoughtsTokenCount: 0, totalTokenCount: 110,
    },
  });
  await assert.rejects(execution, /fixture_hard_failure/u);
  assert.equal(settledBeforeDeferredResponse, false);
  assert.deepEqual(calls.sort(), ["deferred", "fails"]);
  const replay = await planNavigationMisses({ inputs, cache, contract, coverageScope });
  assert.equal(replay.rows[1].state, "cache_hit");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(Object.values(ledger.tickets).filter((row) => row.state === "settled").length, 1);
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
  const mgetCalls = [];
  const command = async (args) => {
    if (args[0] === "GET") return values.get(args[1]) ?? null;
    if (args[0] === "MGET") {
      mgetCalls.push(args.slice(1));
      return args.slice(1).map((key) => values.get(key) ?? null);
    }
    const script = args[1];
    const resultKey = args[3];
    if (script.includes("local normalized")) {
      if (values.has(args[3])) return ["COMPLETE", values.get(args[3])];
      for (const index of [4, 5, 6]) if (values.has(args[index])) return ["RAW", values.get(args[index])];
      for (const index of [7, 8]) if (values.has(args[index])) return ["PROVIDER_RAW", values.get(args[index])];
      if (!values.has(args[9])) {
        values.set(args[9], args[10]);
        return ["CLAIMED", args[10]];
      }
      return ["BUSY", values.get(args[9])];
    }
    if (script.includes("return {'WRITTEN'}")) {
      if (values.has(resultKey)) return values.get(resultKey) === args[4] ? ["EXISTING"] : ["CONFLICT"];
      values.set(resultKey, args[4]);
      return ["WRITTEN"];
    }
    if (script.includes("return {'RELEASED'}")) {
      if (values.get(resultKey) !== args[4]) return ["OWNER_MISMATCH"];
      values.delete(resultKey);
      return ["RELEASED"];
    }
    if (script.includes("return {'ADOPTED'")) {
      if (values.get(resultKey) !== args[4]) return ["BUSY", values.get(resultKey) || ""];
      values.set(resultKey, args[5]);
      return ["ADOPTED", args[5]];
    }
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
  await first.saveNavigationProviderRaw("same", { key: "same", kind: "provider-raw", attempt: 0 });
  await first.releaseNavigationClaim("same", "ticket-1");
  await first.saveNavigationRaw("same", { key: "same", kind: "raw", attempt: 0 });
  await first.saveNavigationNormalized("same", "navigation-output-v1", {
    key: "same", kind: "normalized", normalizerVersion: "navigation-output-v1",
  });
  const restarted = createRedisEvidencePreprocessCache({ command, ownerId: "worker-3" });
  const saved = await restarted.readNavigation("same", "navigation-output-v1");
  assert.equal(saved.providerRaw.kind, "provider-raw");
  assert.equal(saved.raw.kind, "raw");
  assert.equal(saved.normalized.kind, "normalized");
  assert.equal(mgetCalls.length, 1);
  assert.equal(mgetCalls[0].length, 6);
  values.set(mgetCalls[0][0], JSON.stringify({ key: "same", kind: "raw", attempt: 1 }));
  values.set(mgetCalls[0][3], JSON.stringify({ key: "same", kind: "provider-raw", attempt: 1 }));
  const preferred = await restarted.readNavigation("same", "navigation-output-v1");
  assert.equal(preferred.raw.attempt, 1);
  assert.equal(preferred.providerRaw.attempt, 1);
  const batched = await restarted.readNavigationBatch(["same", "absent"], "navigation-output-v1");
  assert.equal(batched[0].raw.attempt, 1);
  assert.deepEqual(batched[1], { raw: null, providerRaw: null, normalized: null });
  assert.equal(mgetCalls.at(-1).length, 12);
  assert.equal((await restarted.claimNavigation("same", "ticket-3")).status, "complete");
  assert.equal((await restarted.claimDense("same", "dense-ticket")).status, "claimed");
  const interruptedDense = await contender.claimDense("same", "dense-ticket");
  assert.equal(interruptedDense.status, "busy");
  assert.equal((await contender.adoptClaim("dense", "same", "dense-ticket", interruptedDense.claim)).status, "adopted");
  await contender.writeRaw("dense", "same", {
    ticket: "dense-ticket",
    value: { key: "same", kind: "dense-raw-pointer" },
  });
  assert.notEqual(first.navKey("same"), first.denseKey("same"));

  assert.equal((await first.claimNavigation("raw", "raw-ticket")).status, "claimed");
  await first.writeRaw("nav", "raw", { ticket: "raw-ticket", value: { key: "raw", kind: "raw", rawResponse: "{}" } });
  assert.equal((await restarted.claimNavigation("raw", "retry-ticket")).status, "raw_reusable");
  await restarted.saveNavigationNormalized("raw", "navigation-output-v1", {
    key: "raw", kind: "normalized", normalizerVersion: "navigation-output-v1",
  });
  assert.equal((await restarted.claimNavigation("raw", "after-normalize")).status, "complete");
});
