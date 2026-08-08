#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAdminEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";
import {
  hashAdminFinalInput,
  normalizeAdminEvidenceVariant,
} from "../backend/adminEvidenceVariant.mjs";
import {
  buildFinalRulingInput,
  buildFinalRulingModelEvidencePacket,
} from "../backend/adminModelLabService.mjs";
import { CompatibleEvidencePreparationProvider } from "../backend/rulingModelProviders.mjs";

const DEFAULT_MODEL = "relay-gpt-5.6-sol";
const DEFAULT_EFFORTS = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);
const ALLOWED_EFFORTS = new Set(DEFAULT_EFFORTS);
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_CALLS = 24;
const PROMPT_VERSION = "openai-ruling-v1";

export function parseLocalRelayExperimentArgs(argv) {
  const parsed = { efforts: [], caseIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument === "--recover-running-as-outcome-unknown") {
      parsed.recoverRunningAsOutcomeUnknown = true;
      continue;
    }
    const field = ({
      "--snapshots": "snapshots",
      "--model": "model",
      "--effort": "effort",
      "--evidence-variant": "evidenceVariant",
      "--case": "caseId",
      "--output": "output",
      "--timeout-ms": "timeoutMs",
      "--max-calls": "maxCalls",
    })[argument];
    if (!field) throw new TypeError(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith("--")) {
      throw new TypeError(`${argument} requires a value`);
    }
    index += 1;
    if (field === "effort") parsed.efforts.push(String(value).trim().toLowerCase());
    else if (field === "caseId") parsed.caseIds.push(String(value).trim());
    else parsed[field] = value;
  }
  return parsed;
}

export function normalizeLocalRelayExperimentOptions(options, env = process.env) {
  if (!options?.snapshots) throw new TypeError("--snapshots is required");
  if (!options?.output) throw new TypeError("--output is required");
  const model = String(options.model || DEFAULT_MODEL).trim();
  if (!/^relay-gpt-5\.6-(?:sol|terra|luna)$/u.test(model)) {
    throw new TypeError("--model must be relay-gpt-5.6-sol, relay-gpt-5.6-terra or relay-gpt-5.6-luna");
  }
  const efforts = options.efforts?.length ? options.efforts : [...DEFAULT_EFFORTS];
  for (const effort of efforts) {
    if (!ALLOWED_EFFORTS.has(effort)) throw new TypeError(`unsupported --effort: ${effort}`);
  }
  if (new Set(efforts).size !== efforts.length) throw new TypeError("duplicate --effort values are not allowed");
  const evidenceVariant = normalizeAdminEvidenceVariant(options.evidenceVariant || "full");
  const caseIds = (options.caseIds || []).map((value) => String(value).trim());
  if (caseIds.some((value) => !value)) throw new TypeError("--case must not be empty");
  if (new Set(caseIds).size !== caseIds.length) throw new TypeError("duplicate --case values are not allowed");
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
    throw new TypeError("--timeout-ms must be an integer between 1000 and 3600000");
  }
  const maxCalls = Number(options.maxCalls || DEFAULT_MAX_CALLS);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 24) {
    throw new TypeError("--max-calls must be an integer between 1 and 24");
  }
  const apiKey = String(env.RELAY_API_KEY || "").trim();
  if (!apiKey) throw new TypeError("RELAY_API_KEY is required");
  const baseUrl = String(env.RELAY_BASE_URL || "").trim();
  if (!baseUrl) throw new TypeError("RELAY_BASE_URL is required");
  return Object.freeze({
    snapshotsPath: path.resolve(String(options.snapshots)),
    outputPath: path.resolve(String(options.output)),
    model,
    efforts: Object.freeze([...efforts]),
    evidenceVariant,
    caseIds: Object.freeze([...caseIds]),
    timeoutMs,
    maxCalls,
    recoverRunningAsOutcomeUnknown: options.recoverRunningAsOutcomeUnknown === true,
    apiKey,
    baseUrl,
  });
}

export async function runLocalRelayEffortExperiment({
  options,
  env = process.env,
  providerFactory,
  now = () => new Date(),
  log = console.log,
} = {}) {
  const resolved = normalizeLocalRelayExperimentOptions(options, env);
  const serializedBundle = await readFile(resolved.snapshotsPath, "utf8");
  const bundleSha256 = sha256(serializedBundle);
  const allCases = normalizeSnapshotBundle(JSON.parse(serializedBundle));
  const casesById = new Map(allCases.map((item) => [item.caseId, item]));
  for (const caseId of resolved.caseIds) {
    if (!casesById.has(caseId)) throw new TypeError(`unknown --case: ${caseId}`);
  }
  const cases = resolved.caseIds.length
    ? resolved.caseIds.map((caseId) => casesById.get(caseId))
    : allCases;
  const selectedCaseIds = cases.map((item) => item.caseId);
  const plan = cases.flatMap((item) => resolved.efforts.map((effort) => ({
    caseId: item.caseId,
    effort,
    evidenceVariant: resolved.evidenceVariant,
    key: resultKey(item.caseId, resolved.model, effort, resolved.evidenceVariant),
  })));
  if (plan.length > resolved.maxCalls) {
    throw new Error(`planned relay calls ${plan.length} exceed --max-calls ${resolved.maxCalls}`);
  }
  let checkpoint = await loadOrCreateCheckpoint({
    outputPath: resolved.outputPath,
    bundleSha256,
    bundlePath: resolved.snapshotsPath,
    model: resolved.model,
    efforts: resolved.efforts,
    evidenceVariant: resolved.evidenceVariant,
    caseIds: selectedCaseIds,
    plan,
    recoverRunningAsOutcomeUnknown: resolved.recoverRunningAsOutcomeUnknown,
    now,
  });
  const provider = providerFactory
    ? providerFactory({ resolved, env })
    : new CompatibleEvidencePreparationProvider({
        providerId: "relay",
        apiKey: resolved.apiKey,
        baseUrl: resolved.baseUrl,
        env: {
          ...env,
          RELAY_STREAM: "true",
          RELAY_STREAM_TIMEOUT_MS: String(resolved.timeoutMs),
          RELAY_LOCAL_STREAM_TIMEOUT_MAX_MS: String(resolved.timeoutMs),
        },
      });

  for (const item of cases) {
    const evidenceVariant = resolved.evidenceVariant;
    const input = buildFinalRulingInput(item.evidenceSnapshot, { evidenceVariant });
    const finalInputSha256 = hashAdminFinalInput(input);
    if (evidenceVariant === (item.executionProfile.evidenceVariant || "full")
      &&
      item.executionProfile.finalRulingInputSha256
      && item.executionProfile.finalRulingInputSha256 !== finalInputSha256
    ) {
      throw new Error(`${item.caseId} final ruling input hash does not match its executionProfile`);
    }
    const modelVisibleEvidencePacket = buildFinalRulingModelEvidencePacket(
      item.evidenceSnapshot,
      { evidenceVariant },
    );
    for (const effort of resolved.efforts) {
      const key = resultKey(item.caseId, resolved.model, effort, evidenceVariant);
      const existing = checkpoint.results.find((entry) => entry.key === key);
      // A running record means the process died after submission. Skipping it
      // prevents an ambiguous, possibly charged request from being repeated.
      if (existing) {
        log(`[skip] ${key} (${existing.status})`);
        continue;
      }
      const startedAt = now().toISOString();
      checkpoint.results.push({ key, caseId: item.caseId, model: resolved.model, effort, status: "running", startedAt });
      checkpoint.updatedAt = startedAt;
      await writeCheckpointAtomic(resolved.outputPath, checkpoint);
      log(`[run] ${key}`);
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error(`local relay experiment timed out after ${resolved.timeoutMs} ms`)),
        resolved.timeoutMs,
      );
      timeout.unref?.();
      const monotonicStarted = performance.now();
      let completed;
      const profile = item.executionProfile.finalRuling || {};
      // Relay GPT-5.6 capabilities are always-on reasoning models. The frozen
      // source profile may originate from the public standard-mode pipeline,
      // but this experiment varies effort within the Relay model's required
      // pro mode rather than replaying that incompatible transport setting.
      const reasoningMode = "pro";
      try {
        const prompt = item.executionProfile.prompt || {};
        const response = await provider.runRuling({
          model: resolved.model,
          reasoningEffort: effort,
          reasoningMode,
          instructions: String(prompt.instructions),
          input,
          maxOutputTokens: profile.maxOutputTokens,
          metadata: {
            runId: `local-${item.caseId}-${effort}-${randomUUID()}`.slice(0, 512),
            promptVersion: String(prompt.version || PROMPT_VERSION),
          },
          signal: controller.signal,
        });
        const validation = provider.validateCompletedResponse(response, {
          evidenceSnapshot: item.evidenceSnapshot,
          modelVisibleEvidencePacket,
          expectedQuestionIds: item.executionProfile.questionIds || [],
          providedFacts: item.executionProfile.providedFacts || [],
          normalizeEvidenceProvenance: true,
          normalizeStructuralBindings: true,
        });
        completed = {
          key,
          caseId: item.caseId,
          model: resolved.model,
          effort,
          reasoningMode,
          evidenceVariant,
          status: validation.ok ? "completed_valid" : "completed_invalid",
          startedAt,
          endedAt: now().toISOString(),
          durationMs: Math.round(performance.now() - monotonicStarted),
          snapshotId: item.evidenceSnapshot.snapshotId,
          snapshotSha256: item.evidenceSnapshot.contentSha256,
          finalInputSha256,
          rawOutput: response.output_text,
          validatedResult: validation,
          usage: response.usage || null,
          finishReason: response.finish_reason || null,
          requestId: response.id || null,
          requestedModel: response.requested_model || resolved.model,
          submittedModel: response.submitted_model || null,
          reportedModel: response.reported_model || response.model || null,
          sseTiming: response.stream_metrics || null,
        };
      } catch (error) {
        completed = {
          key,
          caseId: item.caseId,
          model: resolved.model,
          effort,
          reasoningMode,
          evidenceVariant,
          status: error?.outcomeKnown === true ? "error_rejected" : "error_outcome_unknown",
          startedAt,
          endedAt: now().toISOString(),
          durationMs: Math.round(performance.now() - monotonicStarted),
          snapshotId: item.evidenceSnapshot.snapshotId,
          snapshotSha256: item.evidenceSnapshot.contentSha256,
          finalInputSha256,
          rawOutput: typeof error?.outputText === "string" ? error.outputText : null,
          validatedResult: null,
          usage: jsonSafe(error?.usage || null),
          sseTiming: jsonSafe(error?.streamMetrics || null),
          error: serializeError(error),
        };
      } finally {
        clearTimeout(timeout);
      }
      checkpoint.results = checkpoint.results.map((entry) => entry.key === key ? completed : entry);
      checkpoint.updatedAt = completed.endedAt;
      checkpoint.status = checkpoint.results.length === plan.length
        && checkpoint.results.every((entry) => entry.status !== "running")
        ? "completed"
        : "in_progress";
      await writeCheckpointAtomic(resolved.outputPath, checkpoint);
    }
  }
  return checkpoint;
}

export function normalizeSnapshotBundle(bundle) {
  const rawCases = Array.isArray(bundle?.cases)
    ? bundle.cases
    : (Array.isArray(bundle?.sources)
        ? bundle.sources
        : (Array.isArray(bundle?.snapshots) ? bundle.snapshots : (Array.isArray(bundle?.runs) ? bundle.runs : [])));
  if (rawCases.length === 0) throw new TypeError("snapshot bundle must contain a non-empty cases array");
  const ids = new Set();
  return rawCases.map((raw, index) => {
    const source = raw?.run && typeof raw.run === "object" ? raw.run : raw;
    const caseId = String(raw?.caseId || raw?.id || source?.runId || `case-${index + 1}`).trim();
    if (!caseId || ids.has(caseId)) throw new TypeError(`invalid or duplicate case id: ${caseId}`);
    ids.add(caseId);
    const evidenceSnapshot = parseAdminEvidenceSnapshot(source?.evidenceSnapshot || source?.snapshot);
    const executionProfile = source?.executionProfile;
    if (!executionProfile || typeof executionProfile !== "object" || Array.isArray(executionProfile)) {
      throw new TypeError(`${caseId} is missing executionProfile`);
    }
    if (
      executionProfile.evidenceSnapshotId
      && executionProfile.evidenceSnapshotId !== evidenceSnapshot.snapshotId
    ) {
      throw new Error(`${caseId} executionProfile is bound to a different evidence snapshot`);
    }
    const prompt = executionProfile.prompt;
    if (!prompt || typeof prompt.instructions !== "string" || !prompt.instructions.trim()) {
      throw new TypeError(`${caseId} executionProfile is missing frozen prompt instructions`);
    }
    if (prompt.sha256 && prompt.sha256 !== sha256(prompt.instructions)) {
      throw new Error(`${caseId} frozen prompt instructions fail their SHA-256 binding`);
    }
    const evidenceVariant = executionProfile.evidenceVariant || "full";
    const rebuiltFinalInput = buildFinalRulingInput(evidenceSnapshot, { evidenceVariant });
    const rebuiltFinalInputSha256 = hashAdminFinalInput(rebuiltFinalInput);
    if (
      executionProfile.finalRulingInputSha256
      && executionProfile.finalRulingInputSha256 !== rebuiltFinalInputSha256
    ) {
      throw new Error(`${caseId} final ruling input hash does not match its executionProfile`);
    }
    return { caseId, evidenceSnapshot, executionProfile: jsonSafe(executionProfile) };
  });
}

async function loadOrCreateCheckpoint({
  outputPath,
  bundleSha256,
  bundlePath,
  model,
  efforts,
  evidenceVariant,
  caseIds,
  plan,
  recoverRunningAsOutcomeUnknown,
  now,
}) {
  try {
    const existing = JSON.parse(await readFile(outputPath, "utf8"));
    if (existing?.bundleSha256 !== bundleSha256 || existing?.model !== model) {
      throw new Error("existing checkpoint belongs to a different snapshot bundle or model");
    }
    if (String(existing.evidenceVariant || "full") !== evidenceVariant) {
      throw new Error("existing checkpoint belongs to a different evidence variant");
    }
    // Checkpoints written before case filtering existed have no caseIds field.
    // Their result keys still provide fail-closed plan validation below, so
    // treating them as the current full selection preserves safe resume.
    const existingCaseIds = Array.isArray(existing.caseIds) ? existing.caseIds : caseIds;
    if (JSON.stringify(existingCaseIds) !== JSON.stringify(caseIds)) {
      throw new Error("existing checkpoint belongs to a different case selection");
    }
    const previousEfforts = Array.isArray(existing.efforts) ? existing.efforts : [];
    const requestedEfforts = new Set(efforts);
    if (!previousEfforts.every((effort) => requestedEfforts.has(effort))) {
      throw new Error("existing checkpoint effort list is not a subset of the requested effort list");
    }
    const requestedKeys = new Set(plan.map((entry) => entry.key));
    if (!Array.isArray(existing.results)
      || existing.results.some((entry) => !requestedKeys.has(entry?.key))) {
      throw new Error("existing checkpoint contains results outside the requested plan");
    }
    const resumedAt = now().toISOString();
    if (recoverRunningAsOutcomeUnknown) {
      existing.results = existing.results.map((entry) => {
        if (entry.status !== "running") return entry;
        // The explicit recovery flag acknowledges that a previous process
        // stopped after submission. Its provider outcome may have been charged
        // even though no response was durably recorded, so seal it as unknown
        // instead of retrying or leaving the whole checkpoint permanently open.
        return {
          ...entry,
          status: "error_outcome_unknown",
          endedAt: resumedAt,
          durationMs: null,
          validatedResult: null,
          usage: null,
          sseTiming: null,
          recoveredFromInterruptedCheckpoint: true,
          budgetReservationMayExist: true,
          error: {
            name: "InterruptedRelayRunError",
            code: "local_relay_interrupted_outcome_unknown",
            message: "A persisted running request has an unknown provider outcome and was not retried.",
            outcomeKnown: false,
          },
        };
      });
    }
    existing.efforts = [...efforts];
    existing.evidenceVariant = evidenceVariant;
    existing.caseIds = [...caseIds];
    existing.plan = plan;
    existing.plannedRequests = plan.length;
    existing.status = existing.results.length === plan.length
      && existing.results.every((entry) => entry.status !== "running")
      ? "completed"
      : "in_progress";
    existing.updatedAt = resumedAt;
    await writeCheckpointAtomic(outputPath, existing);
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (recoverRunningAsOutcomeUnknown) {
      throw new Error("--recover-running-as-outcome-unknown requires an existing checkpoint");
    }
  }
  const createdAt = now().toISOString();
  const checkpoint = {
    schemaVersion: 1,
    runner: "local-relay-effort-experiment/v1",
    status: "in_progress",
    createdAt,
    updatedAt: createdAt,
    bundlePath,
    bundleSha256,
    model,
    efforts: [...efforts],
    evidenceVariant,
    caseIds: [...caseIds],
    concurrency: 1,
    retries: 0,
    plannedRequests: plan.length,
    plan,
    results: [],
  };
  await writeCheckpointAtomic(outputPath, checkpoint);
  return checkpoint;
}

async function writeCheckpointAtomic(outputPath, value) {
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, outputPath);
}

function serializeError(error) {
  return jsonSafe({
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code || null,
    provider: error?.provider || null,
    status: error?.status ?? null,
    outcomeKnown: error?.outcomeKnown ?? false,
    budgetReservationMayExist: error?.budgetReservationMayExist ?? null,
    requestId: error?.requestId || null,
    requestedModel: error?.requestedModel || null,
    submittedModel: error?.submittedModel || null,
    reportedModel: error?.reportedModel || null,
  });
}

function jsonSafe(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resultKey(caseId, model, effort, evidenceVariant) {
  const base = `${caseId}::${model}::${effort}`;
  return evidenceVariant === "full" ? base : `${base}::${evidenceVariant}`;
}

function printHelp() {
  console.log(`Usage:
  pnpm run experiment:relay:local -- --snapshots <bundle.json> --output <checkpoint.json> [options]

Options:
  --model <relay-gpt-5.6-sol|relay-gpt-5.6-terra|relay-gpt-5.6-luna>
  --effort <none|low|medium|high|xhigh|max>  Repeat to select efforts (default: all six)
  --evidence-variant <full|card_text_only|without_lua>
                                              Evidence ablation (default: full)
  --case <case-id>                            Repeat to select cases (default: all)
  --recover-running-as-outcome-unknown        Seal interrupted submissions without retrying (resume only)
  --timeout-ms <1000..3600000>              Per-request SSE deadline (default: 900000)
  --max-calls <1..24>                        Hard plan limit before transport (default: 24)

The runner is serial, performs no retries, reads no golden answers, and resumes
only combinations that have never reached the running checkpoint.`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const options = parseLocalRelayExperimentArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else await runLocalRelayEffortExperiment({ options });
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
