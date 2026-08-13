#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildFinalRulingInput } from "../backend/adminModelLabService.mjs";
import { hashAdminFinalInput } from "../backend/adminEvidenceVariant.mjs";
import {
  isSolModelIdentity,
  judgeCandidateWithSolHigh,
} from "./evaluate-pure-llm-preview.mjs";
import { normalizeSnapshotBundle } from "./local-relay-effort-experiment.mjs";

const EXPECTED_VARIANTS = Object.freeze([
  "card_text_only",
  "card_text_plus_lua",
]);
const GENERATION_MODEL = "relay-gpt-5.6-sol";
const GENERATION_EFFORT = "low";
const JUDGE_MODEL = "gpt-5.6-sol";
const JUDGE_EFFORT = "high";
const DEFAULT_TIMEOUT_MS = 300_000;
const GENERATION_STATUSES_WITH_CANDIDATES = new Set([
  "completed_valid",
  "completed_invalid",
]);
const REVIEWED_VERDICTS = new Set([
  "correct",
  "partially_correct",
  "incorrect",
]);

export async function runLuaAblationSemanticJudge({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  readText = (filePath) => readFile(filePath, "utf8"),
  writeJson = writeJsonAtomically,
  buildBundleContract = createFrozenBundleContract,
  now = () => new Date(),
  log = console.log,
} = {}) {
  const options = parseLuaAblationJudgeArgs(argv);
  if (options.help) {
    log(helpText());
    return null;
  }

  const casesFixture = normalizeCases(JSON.parse(await readText(options.casesPath)));
  const serializedBundle = await readText(options.bundlePath);
  const bundleContract = buildBundleContract({ serializedBundle, casesFixture });

  // This is a deliberate information barrier. Every generated candidate must
  // already be terminal, durable and mutually bound before the private
  // reference-answer file is opened. Generation therefore cannot observe a
  // reference answer through this process, even indirectly.
  const candidates = new Map();
  for (const variant of EXPECTED_VARIANTS) {
    const checkpoint = JSON.parse(await readText(options.checkpoints.get(variant)));
    candidates.set(variant, normalizeCandidateCheckpoint({
      checkpoint,
      variant,
      casesFixture,
      bundleContract,
    }));
  }
  assertPairedGeneration(candidates, casesFixture, bundleContract);

  const references = normalizeReferences(
    JSON.parse(await readText(options.referencesPath)),
    casesFixture,
  );
  const privateResults = [];
  for (const variant of EXPECTED_VARIANTS) {
    for (const evaluationCase of casesFixture.cases) {
      const candidate = candidates.get(variant).byCase.get(evaluationCase.id);
      log(`[judge] ${variant} ${evaluationCase.id}`);
      const judgment = await judgeCandidateWithSolHigh({
        caseId: `${variant}:${evaluationCase.id}`,
        question: evaluationCase.question,
        referenceAnswer: references.get(evaluationCase.id),
        candidateResponseText: candidate.rawOutput,
        env,
        fetchImpl,
        timeoutMs: options.timeoutMs,
      });
      privateResults.push({
        variant,
        caseId: evaluationCase.id,
        snapshotSha256: candidate.snapshotSha256,
        finalInputSha256: candidate.finalInputSha256,
        candidateSha256: sha256(candidate.rawOutput),
        judgment,
      });
      log(`[judge] ${variant} ${evaluationCase.id}: ${judgment.verdict}`);
    }
  }

  const generatedAt = now().toISOString();
  const privateReport = {
    schemaVersion: 1,
    kind: "private-lua-prompt-ablation-semantic-judgments",
    generatedAt,
    generation: generationDescriptor(candidates),
    judge: judgeDescriptor(),
    results: privateResults,
  };
  const publicReport = createLuaAblationPublicReport({
    candidates,
    privateResults,
    selectedCases: casesFixture.cases.length,
    generatedAt,
  });
  await mkdir(dirname(options.privateOutputPath), { recursive: true });
  await mkdir(dirname(options.publicOutputPath), { recursive: true });
  await writeJson(options.privateOutputPath, privateReport);
  await writeJson(options.publicOutputPath, publicReport);
  log(JSON.stringify(publicReport.summary));

  if (publicReport.summary.judgeFailed > 0) {
    throw new Error(`${publicReport.summary.judgeFailed} Lua ablation candidates were not reviewed`);
  }
  return { privateReport, publicReport };
}

export function parseLuaAblationJudgeArgs(argv = []) {
  const parsed = { checkpoints: new Map(), timeoutMs: DEFAULT_TIMEOUT_MS, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument === "--checkpoint") {
      const specification = requiredNext(argv, ++index, argument);
      const separator = specification.indexOf("=");
      if (separator <= 0 || separator === specification.length - 1) {
        throw new TypeError("--checkpoint requires VARIANT=PATH");
      }
      const variant = specification.slice(0, separator);
      const filePath = specification.slice(separator + 1);
      if (!EXPECTED_VARIANTS.includes(variant)) throw new TypeError(`unsupported checkpoint variant: ${variant}`);
      if (parsed.checkpoints.has(variant)) throw new TypeError(`duplicate checkpoint variant: ${variant}`);
      parsed.checkpoints.set(variant, resolve(filePath));
      continue;
    }
    const value = requiredNext(argv, ++index, argument);
    if (argument === "--cases") parsed.casesPath = resolve(value);
    else if (argument === "--bundle") parsed.bundlePath = resolve(value);
    else if (argument === "--references") parsed.referencesPath = resolve(value);
    else if (argument === "--private-output") parsed.privateOutputPath = resolve(value);
    else if (argument === "--public-output") parsed.publicOutputPath = resolve(value);
    else if (argument === "--judge-timeout-ms") parsed.timeoutMs = positiveInteger(value, argument);
    else throw new TypeError(`unknown argument: ${argument}`);
  }
  if (parsed.help) return parsed;
  for (const [name, value] of Object.entries({
    casesPath: parsed.casesPath,
    bundlePath: parsed.bundlePath,
    referencesPath: parsed.referencesPath,
    privateOutputPath: parsed.privateOutputPath,
    publicOutputPath: parsed.publicOutputPath,
  })) {
    if (!value) throw new TypeError(`--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`).replace(/-path$/u, "")} is required`);
  }
  for (const variant of EXPECTED_VARIANTS) {
    if (!parsed.checkpoints.has(variant)) throw new TypeError(`missing --checkpoint ${variant}=PATH`);
  }
  return parsed;
}

export function createLuaAblationPublicReport({
  candidates,
  privateResults,
  selectedCases,
  generatedAt = new Date().toISOString(),
} = {}) {
  const variants = {};
  let generated = 0;
  let reviewed = 0;
  for (const variant of EXPECTED_VARIANTS) {
    const candidateSet = candidates.get(variant);
    const results = privateResults.filter((item) => item.variant === variant);
    const counts = {
      correct: results.filter((item) => item.judgment?.verdict === "correct").length,
      partiallyCorrect: results.filter((item) => item.judgment?.verdict === "partially_correct").length,
      incorrect: results.filter((item) => item.judgment?.verdict === "incorrect").length,
    };
    const variantReviewed = counts.correct + counts.partiallyCorrect + counts.incorrect;
    generated += candidateSet.byCase.size;
    reviewed += variantReviewed;
    variants[variant] = {
      generated: candidateSet.byCase.size,
      reviewed: variantReviewed,
      judgeFailed: candidateSet.byCase.size - variantReviewed,
      ...counts,
      reviewedAccuracy: ratio(counts.correct, variantReviewed),
      strictAccuracy: ratio(counts.correct, selectedCases),
    };
  }
  const baseline = variants.card_text_only;
  const withLua = variants.card_text_plus_lua;
  return {
    schemaVersion: 1,
    kind: "public-lua-prompt-ablation-summary",
    generatedAt,
    selectedCases,
    generation: generationDescriptor(candidates),
    judge: judgeDescriptor(),
    variants,
    comparison: {
      strictAccuracyDelta: subtractRatios(withLua.strictAccuracy, baseline.strictAccuracy),
    },
    summary: {
      candidates: generated,
      reviewed,
      judgeFailed: generated - reviewed,
    },
  };
}

function normalizeCases(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.cases) || !value.cases.length) {
    throw new TypeError("Lua ablation cases fixture is invalid");
  }
  const ids = new Set();
  const cases = value.cases.map((item) => {
    const id = requiredText(item?.id, "case id");
    const question = requiredText(item?.question, `${id} question`);
    if (ids.has(id)) throw new TypeError(`duplicate case id: ${id}`);
    ids.add(id);
    return { id, question };
  });
  return { schemaVersion: 1, cases };
}

function normalizeReferences(value, casesFixture) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.goldens)) {
    throw new TypeError("Lua ablation references fixture is invalid");
  }
  const references = new Map();
  for (const item of value.goldens) {
    const id = requiredText(item?.id, "reference id");
    if (references.has(id)) throw new TypeError(`duplicate reference id: ${id}`);
    references.set(id, requiredText(item?.expectedAnswer, `${id} expectedAnswer`));
  }
  const expectedIds = casesFixture.cases.map((item) => item.id);
  if (references.size !== expectedIds.length || expectedIds.some((id) => !references.has(id))) {
    throw new TypeError("Reference ids do not exactly match the frozen generation cases");
  }
  return references;
}

function normalizeCandidateCheckpoint({ checkpoint, variant, casesFixture, bundleContract }) {
  if (checkpoint?.status !== "completed") throw new TypeError(`${variant} checkpoint is not terminal`);
  if (checkpoint?.runner !== "local-relay-effort-experiment/v1") throw new TypeError(`${variant} checkpoint runner is invalid`);
  if (checkpoint?.model !== GENERATION_MODEL
    || checkpoint?.provider !== "relay"
    || checkpoint?.reasoningMode !== "pro"
    || checkpoint?.evidenceVariant !== variant
    || JSON.stringify(checkpoint?.efforts) !== JSON.stringify([GENERATION_EFFORT])
    || checkpoint?.concurrency !== 1
    || checkpoint?.retries !== 0) {
    throw new TypeError(`${variant} checkpoint does not use the fixed serial Sol low generation profile`);
  }
  if (checkpoint.bundleSha256 !== bundleContract.bundleSha256) {
    throw new TypeError(`${variant} checkpoint is not bound to the supplied frozen bundle`);
  }
  const expectedIds = casesFixture.cases.map((item) => item.id);
  if (JSON.stringify(checkpoint.caseIds) !== JSON.stringify(expectedIds)
    || checkpoint.plannedRequests !== expectedIds.length
    || !Array.isArray(checkpoint.results)
    || checkpoint.results.length !== expectedIds.length) {
    throw new TypeError(`${variant} checkpoint case plan is incomplete or different`);
  }
  const byCase = new Map();
  for (const result of checkpoint.results) {
    const caseId = requiredText(result?.caseId, `${variant} result caseId`);
    if (!expectedIds.includes(caseId) || byCase.has(caseId)) throw new TypeError(`${variant} contains an unexpected or duplicate result`);
    if (!GENERATION_STATUSES_WITH_CANDIDATES.has(result?.status)) {
      throw new TypeError(`${variant}/${caseId} has no completed candidate`);
    }
    const rawOutput = requiredText(result?.rawOutput, `${variant}/${caseId} rawOutput`);
    if (result?.model !== GENERATION_MODEL
      || result?.provider !== "relay"
      || result?.effort !== GENERATION_EFFORT
      || result?.reasoningMode !== "pro"
      || result?.evidenceVariant !== variant) {
      throw new TypeError(`${variant}/${caseId} generation parameters do not match the checkpoint`);
    }
    if (!isSolModelIdentity(result?.submittedModel)
      || !isSolModelIdentity(result?.reportedModel)) {
      throw new TypeError(`${variant}/${caseId} does not prove the submitted and returned GPT-5.6 Sol identity`);
    }
    const expected = bundleContract.byCase.get(caseId);
    const snapshotId = requiredText(result?.snapshotId, `${variant}/${caseId} snapshotId`);
    const snapshotSha256 = requiredSha256(result?.snapshotSha256, `${variant}/${caseId} snapshotSha256`);
    const finalInputSha256 = requiredSha256(result?.finalInputSha256, `${variant}/${caseId} finalInputSha256`);
    if (!expected
      || snapshotId !== expected.snapshotId
      || snapshotSha256 !== expected.snapshotSha256
      || finalInputSha256 !== expected.inputSha256[variant]) {
      throw new TypeError(`${variant}/${caseId} is not bound to the expected snapshot and rebuilt final input`);
    }
    byCase.set(caseId, {
      rawOutput,
      snapshotId,
      snapshotSha256,
      finalInputSha256,
    });
  }
  return {
    bundleSha256: requiredSha256(checkpoint.bundleSha256, `${variant} bundleSha256`),
    byCase,
  };
}

function assertPairedGeneration(candidates, casesFixture, bundleContract) {
  const baseline = candidates.get("card_text_only");
  const withLua = candidates.get("card_text_plus_lua");
  if (baseline.bundleSha256 !== withLua.bundleSha256) {
    throw new Error("Lua A/B checkpoints were not generated from the same frozen bundle");
  }
  if (baseline.bundleSha256 !== bundleContract.bundleSha256) {
    throw new Error("Lua A/B checkpoints do not match the supplied frozen bundle");
  }
  for (const item of casesFixture.cases) {
    const a = baseline.byCase.get(item.id);
    const b = withLua.byCase.get(item.id);
    if (a.snapshotSha256 !== b.snapshotSha256) {
      throw new Error(`${item.id} Lua A/B candidates do not share one Evidence Snapshot`);
    }
    if (a.finalInputSha256 === b.finalInputSha256) {
      throw new Error(`${item.id} Lua A/B final inputs are unexpectedly identical`);
    }
  }
}

export function createFrozenBundleContract({ serializedBundle, casesFixture } = {}) {
  const text = String(serializedBundle || "");
  if (!text.trim()) throw new TypeError("Lua A/B frozen bundle is empty");
  const sources = normalizeSnapshotBundle(JSON.parse(text));
  const expectedCases = Array.isArray(casesFixture?.cases) ? casesFixture.cases : [];
  if (sources.length !== expectedCases.length) {
    throw new TypeError("Frozen bundle cases do not exactly match the generation cases");
  }
  const sourceById = new Map(sources.map((source) => [source.caseId, source]));
  const byCase = new Map();
  for (const evaluationCase of expectedCases) {
    const source = sourceById.get(evaluationCase.id);
    if (!source || source.evidenceSnapshot.question !== evaluationCase.question) {
      throw new TypeError(`${evaluationCase.id} frozen bundle question does not match the generation case`);
    }
    const baselineInput = buildFinalRulingInput(source.evidenceSnapshot, {
      evidenceVariant: "card_text_only",
    });
    const withLuaInput = buildFinalRulingInput(source.evidenceSnapshot, {
      evidenceVariant: "card_text_plus_lua",
    });
    if (!withLuaInput.startsWith(`${baselineInput}\n`)) {
      throw new Error(`${evaluationCase.id} Lua input changed more than the isolated prompt addon`);
    }
    const addon = withLuaInput.slice(baselineInput.length + 1);
    if (countOccurrences(addon, "legacyLuaPromptHints:") !== 1
      || /legacyLuaSemanticPacket/u.test(addon)) {
      throw new Error(`${evaluationCase.id} Lua input does not contain exactly one isolated prompt addon`);
    }
    byCase.set(evaluationCase.id, {
      snapshotId: source.evidenceSnapshot.snapshotId,
      snapshotSha256: source.evidenceSnapshot.contentSha256,
      inputSha256: {
        card_text_only: hashAdminFinalInput(baselineInput),
        card_text_plus_lua: hashAdminFinalInput(withLuaInput),
      },
    });
  }
  return {
    bundleSha256: sha256(text),
    byCase,
  };
}

function generationDescriptor(candidates) {
  return {
    requestedModel: GENERATION_MODEL,
    reasoningEffort: GENERATION_EFFORT,
    reasoningMode: "pro",
    concurrency: 1,
    retries: 0,
    frozenBundleSha256: candidates.get("card_text_only").bundleSha256,
  };
}

function judgeDescriptor() {
  return {
    requestedModel: JUDGE_MODEL,
    reasoningEffort: JUDGE_EFFORT,
    returnedModelMustMatchSol: true,
    concurrency: 1,
    retries: 0,
  };
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, filePath);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function requiredSha256(value, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function requiredText(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function requiredNext(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || String(value).startsWith("--")) throw new TypeError(`${flag} requires a value`);
  return String(value);
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 3_600_000) {
    throw new TypeError(`${name} must be an integer between 1 and 3600000`);
  }
  return parsed;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null;
}

function subtractRatios(left, right) {
  return left === null || right === null ? null : Number((left - right).toFixed(6));
}

function countOccurrences(value, needle) {
  return String(value).split(needle).length - 1;
}

function helpText() {
  return `Usage:
  node scripts/judge-lua-ablation.mjs \\
    --cases <generation-cases.json> \\
    --bundle <frozen-source-bundle.json> \\
    --checkpoint card_text_only=<checkpoint.json> \\
    --checkpoint card_text_plus_lua=<checkpoint.json> \\
    --references <private-reference-answers.json> \\
    --private-output <private-judgments.json> \\
    --public-output <anonymous-summary.json>

All generation checkpoints are validated before the private reference file is
read. The semantic judge is fixed to gpt-5.6-sol with high reasoning effort,
runs serially and never retries automatically.`;
}

function isDirectExecution() {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runLuaAblationSemanticJudge().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
