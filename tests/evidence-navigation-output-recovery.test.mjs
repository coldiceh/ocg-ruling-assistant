import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEvidenceInputMeasurement, generationContractSha256,
  loadEvidenceGenerationContract, normalizeEvidenceGenerationUsage,
} from "../backend/evidenceGenerationContract.mjs";
import {
  createEvidenceGenerationTransport, evidenceGenerationResponseDiagnostic,
} from "../backend/evidenceGenerationTransport.mjs";
import {
  NAVIGATION_NORMALIZER_VERSION, NAVIGATION_PROMPT_CONTRACT_SHA256,
  runNavigationCli, runNavigationPreparation, validateNavigationInputs,
} from "../scripts/prepare-evidence-navigation.mjs";
import {
  createLocalEvidencePreprocessBudget, createLocalEvidencePreprocessCache,
  navigationCacheKey, sha256, stableJson,
} from "../scripts/lib/evidence-preprocess-cache.mjs";
import { readCloudEvidencePreprocessLedger } from "../scripts/lib/evidence-preprocess-cloud.mjs";

const profileUrl = new URL("../config/evidence-generation/bai-gpt-5.6-luna-medium-theoretical.json", import.meta.url);
const contract = loadEvidenceGenerationContract("navigation", { profileUrl });
const text = JSON.stringify({ descriptionZh: "公开条件和处理顺序", descriptionJa: "公開条件と処理順序",
  searchQuestions: [{ language: "zh", text: "这一条件何时适用？" }, { language: "ja", text: "この条件はいつ適用されますか？" }] });
function provider({ status = "completed", reason = null, output = text, usage = true, model = contract.modelId } = {}) {
  return { id: "resp_fixture", model, status, incomplete_details: reason ? { reason } : null,
    output: [{ type: "message", content: [{ type: "output_text", text: output }] }],
    ...(usage ? { usage: { input_tokens: 100, output_tokens: status === "incomplete" ? 2048 : 100,
      output_tokens_details: { reasoning_tokens: status === "incomplete" ? 2048 : 20 }, total_tokens: status === "incomplete" ? 2148 : 200 } } : {}),
  };
}
async function fixture(t, remaining = 5) {
  const directory = await mkdtemp(join(tmpdir(), "ocg-output-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, "ledger.json");
  await writeFile(ledgerPath, JSON.stringify({ schemaVersion: 1, authorizationId: "fixture-only",
    limitUsd: 5, spentUsd: 5 - remaining, reservedUsd: 0, tickets: {} }));
  const cache = createLocalEvidencePreprocessCache({ cacheDir: join(directory, "cache") });
  const budget = createLocalEvidencePreprocessBudget({ ledgerPath, maxUsd: 5 });
  const input = { sourceKind: "rule", titlePath: ["public fixture"], unitText: "Public fixture conditions.",
    unitStructure: { blocks: [] }, structuralContextTexts: [], structuralContextStructures: [], explicitLinkedTitles: [] };
  const inputs = validateNavigationInputs([{ unitKey: "fixture-rule", sourceId: "fixture-source",
    canonicalBodySha256: sha256("public body"), contextRefs: [], explicitRefs: [], input,
    contextInputSha256: sha256(stableJson(input)) }]);
  const baseKey = navigationCacheKey({ contract: { ...contract, generationContractSha256: generationContractSha256(contract) },
    promptContractSha256: NAVIGATION_PROMPT_CONTRACT_SHA256, contextInputSha256: inputs[0].contextInputSha256 });
  const transportFor = (c) => createEvidenceGenerationTransport({ contract: c, env: {} });
  let calls = [];
  const run = (responses = [], options = {}) => runNavigationPreparation({
    inputs, cache, budget, contract, execute: true, maxUsd: 5,
    coverageScope: { selectedUnitKeys: inputs.map((row) => row.unitKey) },
    prepareRequest: (b, c) => transportFor(c).prepareRequest(b),
    measureInput: ({ body, contract: c }) => buildEvidenceInputMeasurement({ body, contract: c }),
    generateContent: async (body, c, { measurement }) => {
      calls.push({ body, contract: c, measurement });
      assert.equal(measurement.requestSha256, sha256(JSON.stringify(body)));
      assert.equal(measurement.generationContractSha256, generationContractSha256(c));
      assert.ok(responses.length, "Unexpected additional provider invocation");
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    extractText: (r, c) => transportFor(c).extractText(r),
    rawUsage: (r, c) => transportFor(c).rawUsage(r),
    validateResponse: (r, c) => transportFor(c).validateResponse(r),
    ...options,
  });
  const seed = async (response, { attempt = 0, raw = true } = {}) => {
    const requestTicket = `fixture-ticket-${attempt}`;
    await budget.reserve({ ticket: requestTicket, amountUsd: 0.004 });
    const providerRaw = { schemaVersion: 1, kind: "provider-raw", key: baseKey,
      inputKey: inputs[0].contextInputSha256, requestTicket, attempt,
      providerResponse: response, measurement: null, reservedUsd: 0.004 };
    await cache.saveNavigationProviderRaw(baseKey, providerRaw);
    if (raw) await cache.saveNavigationRaw(baseKey, { ...providerRaw, kind: "raw", rawResponse: response.output[0].content[0].text,
      usage: normalizeEvidenceGenerationUsage(response.usage, contract), generator: { fixture: true } });
    return providerRaw;
  };
  return { directory, ledgerPath, cache, budget, baseKey, inputs, calls, run, seed,
    ledger: async () => JSON.parse(await readFile(ledgerPath, "utf8")) };
}

test("explicit output-limit failure gets one 8192-token recovery with the same model, effort and persistent budget", async (t) => {
  const f = await fixture(t);
  const first = provider({ status: "incomplete", reason: "max_output_tokens", output: "" });
  const result = await f.run([first, provider()]);
  assert.equal(result.report.complete, true);
  assert.equal(result.records[0].navigationStatus, "generated");
  assert.deepEqual(f.calls.map((x) => x.body.max_output_tokens), [2048, 8192]);
  assert.deepEqual(f.calls.map((x) => x.body.model), [contract.modelId, contract.modelId]);
  assert.ok(f.calls.every((x) => x.body.reasoning.effort === "medium"));
  assert.equal(f.calls[0].body.instructions, f.calls[1].body.instructions);
  assert.deepEqual(f.calls[0].body.input, f.calls[1].body.input);
  const original = await f.cache.readNavigation(f.baseKey, NAVIGATION_NORMALIZER_VERSION);
  assert.deepEqual(original.providerRaw.providerResponse, first);
  assert.equal(original.normalized, null);
  const ledger = await f.ledger();
  assert.equal(ledger.limitUsd, 5);
  assert.equal(Object.keys(ledger.tickets).length, 2);
  assert.ok(ledger.spentUsd > 0 && ledger.spentUsd < 0.02);
  assert.ok(Math.abs(ledger.reservedUsd) < 1e-10);
  assert.equal(result.records[0].generator.generationContractSha256, generationContractSha256(f.calls[1].contract));
  const before = await f.ledger();
  const replay = await f.run([]);
  assert.equal(replay.records[0].navigationStatus, "generated");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(await f.ledger(), before);
});

test("cached incomplete response cannot be normalized into success even if its JSON is valid", async (t) => {
  const f = await fixture(t);
  await f.seed(provider({ status: "incomplete", reason: "content_filter" }));
  await assert.rejects(f.run([]), (error) => {
    assert.equal(error.message, "evidence_generation_response_incomplete");
    assert.equal(error.responseDiagnostic.incompleteReason, "content_filter");
    return true;
  });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.cache.readNavigation(f.baseKey, NAVIGATION_NORMALIZER_VERSION)).normalized, null);
});

test("cached output-limit failure resumes from its saved response, without repeating the 2048-token call", async (t) => {
  const f = await fixture(t);
  await f.seed(provider({ status: "incomplete", reason: "max_output_tokens", output: "" }));
  const result = await f.run([provider()]);
  assert.equal(result.records[0].navigationStatus, "generated");
  assert.deepEqual(f.calls.map((x) => x.body.max_output_tokens), [8192]);
  assert.equal(Object.keys((await f.ledger()).tickets).length, 2);
});

test("provider-only cache survives interruption before raw normalization and settlement", async (t) => {
  const f = await fixture(t);
  await f.seed(provider({ status: "incomplete", reason: "max_output_tokens", output: "" }), { raw: false });
  assert.equal((await f.ledger()).reservedUsd, 0.004);
  const result = await f.run([provider()]);
  assert.equal(result.records[0].navigationStatus, "generated");
  assert.equal(f.calls.length, 1);
  assert.ok(Math.abs((await f.ledger()).reservedUsd) < 1e-10);
});

test("a second incomplete result fails without a third call, and future reruns do not rebill it", async (t) => {
  const f = await fixture(t);
  const incomplete = provider({ status: "incomplete", reason: "max_output_tokens", output: "" });
  await assert.rejects(f.run([incomplete, incomplete]), /evidence_generation_response_incomplete/);
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.run([]), /evidence_generation_response_incomplete/);
  assert.equal(f.calls.length, 2);
});

test("recovery that produces malformed JSON stops after one new attempt", async (t) => {
  const f = await fixture(t);
  await f.seed(provider({ status: "incomplete", reason: "max_output_tokens", output: "" }));
  await assert.rejects(f.run([provider({ output: "not JSON" })]), /navigation_output_recovery_invalid_json/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.run([]), /navigation_output_recovery_invalid_json/);
  assert.equal(f.calls.length, 1);
});

test("unknown incomplete reason is not guessed from duration, usage, or empty text", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run([provider({ status: "incomplete", output: "" })]), /evidence_generation_response_incomplete/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.run([]), /evidence_generation_response_incomplete/);
  assert.equal(f.calls.length, 1);
});

test("model mismatch never enables output-limit recovery", async (t) => {
  const f = await fixture(t);
  await f.seed(provider({ status: "incomplete", reason: "max_output_tokens", model: "other-model" }));
  await assert.rejects(f.run([]), /evidence_generation_response_model_mismatch/);
  assert.equal(f.calls.length, 0);
});

test("ordinary completed results keep the original cache identity and require no recovery", async (t) => {
  const f = await fixture(t);
  const result = await f.run([provider()]);
  assert.equal(result.records[0].generator.generationContractSha256, generationContractSha256(contract));
  assert.equal(f.calls.length, 1);
  assert.ok((await f.cache.readNavigation(f.baseKey, NAVIGATION_NORMALIZER_VERSION)).normalized);
  await f.run([]);
  assert.equal(f.calls.length, 1);
});

test("unknown original usage keeps its reservation after successful recovery", async (t) => {
  const f = await fixture(t);
  await f.seed(provider({ status: "incomplete", reason: "max_output_tokens", output: "", usage: false }));
  await f.run([provider()]);
  const ledger = await f.ledger();
  assert.ok(Math.abs(ledger.reservedUsd - 0.004) < 1e-10);
  assert.equal(ledger.tickets["fixture-ticket-0"].state, "reserved");
});

test("insufficient remaining cumulative budget blocks recovery before any model call", async (t) => {
  const f = await fixture(t, 0.008);
  await f.seed(provider({ status: "incomplete", reason: "max_output_tokens", output: "" }));
  const result = await f.run([]);
  assert.equal(result.report.budgetBlocked, true);
  assert.equal(result.report.complete, false);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.ledger()).limitUsd, 5);
  assert.ok((await f.ledger()).spentUsd > 4.99);
});

test("a newer provider-only attempt takes precedence over an older raw response", async (t) => {
  const f = await fixture(t);
  await f.seed(provider({ output: "bad JSON" }), { attempt: 0 });
  await f.seed(provider({ status: "incomplete", reason: "max_output_tokens", output: "" }), { attempt: 1, raw: false });
  const result = await f.run([provider()]);
  assert.equal(result.records[0].navigationStatus, "generated");
  assert.deepEqual(f.calls.map((x) => x.body.max_output_tokens), [8192]);
});

test("CLI lazily creates the measured transport for the recovery contract", async (t) => {
  const f = await fixture(t);
  const inputsPath = join(f.directory, "inputs.json");
  await writeFile(inputsPath, JSON.stringify(f.inputs));
  const caps = [];
  const responses = [provider({ status: "incomplete", reason: "max_output_tokens", output: "" }), provider()];
  const result = await runNavigationCli(["--inputs", inputsPath, "--out-dir", join(f.directory, "out"),
    "--cache-dir", join(f.directory, "cache"), "--ledger", f.ledgerPath, "--max-usd", "5",
    "--generation-profile", fileURLToPath(profileUrl), "--all-inputs", "--execute"], {
    env: { BAI_API_KEY: "fixture-only" },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.b.ai/v1/responses");
      caps.push(JSON.parse(options.body).max_output_tokens);
      assert.ok(responses.length);
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    },
  });
  assert.equal(result.records[0].navigationStatus, "generated");
  assert.deepEqual(caps, [2048, 8192]);
});

test("response diagnostic contains metadata only, not model text or credentials", () => {
  const raw = provider({ status: "incomplete", reason: "max_output_tokens" });
  raw.input = "secret prompt"; raw.error = { code: "request_failed", message: "secret" };
  const diagnostic = evidenceGenerationResponseDiagnostic(raw);
  assert.equal(diagnostic.incompleteReason, "max_output_tokens");
  assert.equal(diagnostic.reasoningTokens, 2048);
  assert.ok(!JSON.stringify(diagnostic).includes("secret"));
  assert.equal(evidenceGenerationResponseDiagnostic({ status: "token secret\n", usage: { output_tokens: -1 } }).status, null);
  assert.equal(evidenceGenerationResponseDiagnostic({ usage: { output_tokens: -1 } }).outputTokens, null);
});

test("cloud ledger summary reads only GET and cannot initialize, reset or settle", async () => {
  const ledger = { schemaVersion: 1, authorizationId: "fixture-only", cloudPreprocessLedgerVersion: 1, cloudPreprocessAuthorizationId: "fixture-only",
    limitUsd: 5, spentUsd: 0.03, reservedUsd: 0.02, tickets: {} };
  const commands = [];
  const result = await readCloudEvidencePreprocessLedger({
    env: { UPSTASH_BUDGET_KV_REST_API_URL: "https://fixture.example.test", UPSTASH_BUDGET_KV_REST_API_TOKEN: "fixture-only",
      EVIDENCE_PREPROCESS_AUTHORIZATION_ID: "fixture-only", EVIDENCE_PREPROCESS_LEDGER_KEY: "fixture-ledger",
      EVIDENCE_PREPROCESS_CACHE_NAMESPACE: "fixture-only" },
    fetchImpl: async (_url, options) => {
      const command = JSON.parse(options.body); commands.push(command);
      assert.equal(command[0], "GET");
      return new Response(JSON.stringify({ result: JSON.stringify(ledger) }), { status: 200 });
    },
  });
  assert.deepEqual(result, ledger);
  assert.deepEqual(commands, [["GET", "fixture-ledger"]]);
});


test("dry-run never promotes an old normalized row contradicted by its incomplete provider response", async (t) => {
  const f = await fixture(t);
  await f.seed(provider({ status: "incomplete", reason: "content_filter" }));
  await f.cache.saveNavigationNormalized(f.baseKey, NAVIGATION_NORMALIZER_VERSION, {
    schemaVersion: 1, kind: "normalized", key: f.baseKey, inputKey: f.inputs[0].contextInputSha256,
    normalizerVersion: NAVIGATION_NORMALIZER_VERSION, normalized: JSON.parse(text), generator: { fixture: true },
  });
  const dry = await f.run([], { execute: false });
  assert.equal(dry.records[0].navigationStatus, "blocked_before_attempt");
  assert.equal(dry.report.validNavCacheHits, 0);
  await assert.rejects(f.run([]), /evidence_generation_response_incomplete/);
  assert.equal(f.calls.length, 0);
});
