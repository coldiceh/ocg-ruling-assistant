import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";
import { createAdminModelLabHttpClient } from "./admin-model-matrix.mjs";

const SENSITIVE_KEY = /^(?:api[_-]?key|authorization|cookie|csrf[_-]?token|password|secret)$/iu;

/**
 * Reads sourceRunId values from completed matrix reports, then exports only
 * the immutable source evidence and the execution profile needed to replay it.
 * Final answers, matrix results and evaluation goldens are deliberately absent.
 */
export async function exportAdminSourceSnapshots({
  reportFiles,
  client,
  readFileImpl = readFile,
  now = () => new Date(),
} = {}) {
  if (!client || typeof client.getRun !== "function") {
    throw new TypeError("an authenticated admin model lab client is required");
  }
  const paths = normalizeReportFiles(reportFiles);
  const references = [];
  const reportDigests = [];

  for (const path of paths) {
    const raw = await readFileImpl(path, "utf8");
    const report = JSON.parse(raw);
    reportDigests.push({
      file: basename(path),
      sha256: sha256(raw),
    });
    references.push(...collectSourceReferences(report, path));
  }

  const uniqueReferences = dedupeReferences(references);
  if (uniqueReferences.length === 0) {
    throw new Error("matrix reports contain no sourceRunId values");
  }

  const sources = [];
  for (const reference of uniqueReferences) {
    const envelope = await client.getRun(reference.sourceRunId);
    const run = envelope?.run || envelope?.record || envelope?.item || envelope;
    const status = String(run?.status || "").trim().toUpperCase();
    if (!new Set(["SUCCEEDED", "FAILED"]).has(status)) {
      throw new Error(`source run ${reference.sourceRunId} is not terminal`);
    }
    const submissionState = String(run?.execution?.providerSubmission?.state || "NONE")
      .trim()
      .toUpperCase();
    if (new Set(["SUBMITTING", "OUTCOME_UNKNOWN"]).has(submissionState)) {
      throw new Error(`source run ${reference.sourceRunId} has an ambiguous provider submission`);
    }

    const rawSnapshot = run?.evidenceSnapshot || run?.result?.evidenceSnapshot;
    if (!rawSnapshot) {
      throw new Error(`source run ${reference.sourceRunId} has no full frozen evidence snapshot`);
    }
    const evidenceSnapshot = parseEvidenceSnapshot(rawSnapshot);
    const executionProfile = run?.executionProfile;
    if (!executionProfile || typeof executionProfile !== "object" || Array.isArray(executionProfile)) {
      throw new Error(`source run ${reference.sourceRunId} has no executionProfile`);
    }
    if (executionProfile.status !== "evidence_frozen") {
      throw new Error(`source run ${reference.sourceRunId} executionProfile is not evidence_frozen`);
    }
    if (String(executionProfile.evidenceSnapshotId || "") !== evidenceSnapshot.snapshotId) {
      throw new Error(`source run ${reference.sourceRunId} executionProfile snapshot binding mismatches`);
    }
    if (
      reference.question
      && String(evidenceSnapshot.question || "").trim() !== reference.question
    ) {
      throw new Error(`source run ${reference.sourceRunId} question mismatches its matrix report`);
    }

    const source = {
      caseId: reference.caseId,
      sourceRunId: reference.sourceRunId,
      status,
      evidenceSnapshot,
      executionProfile,
    };
    assertNoSensitiveFields(source);
    sources.push(source);
  }

  return {
    schemaVersion: 1,
    kind: "admin-frozen-source-snapshot-bundle",
    generatedAt: now().toISOString(),
    sourceCount: sources.length,
    reports: reportDigests,
    sources,
  };
}

export function collectSourceReferences(report, label = "matrix report") {
  const reports = Array.isArray(report?.reports) ? report.reports : [report];
  return reports.map((item, index) => {
    const sourceRunId = requiredText(item?.sourceRunId, `${label} sourceRunId`);
    const caseId = requiredText(
      item?.caseId || (reports.length === 1 ? report?.caseId : ""),
      `${label} caseId at index ${index}`,
    );
    return {
      caseId,
      sourceRunId,
      question: optionalText(item?.question),
    };
  });
}

export function parseExportArguments(argv = []) {
  const options = { reportFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    if (argument === "--report") options.reportFiles.push(take());
    else if (argument === "--output") options.output = take();
    else if (argument === "--base-url") options.baseUrl = take();
    else if (argument === "--origin") options.origin = take();
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseExportArguments(argv);
  const stdout = dependencies.stdout || process.stdout;
  if (options.help) {
    stdout.write(usageText());
    return 0;
  }
  normalizeReportFiles(options.reportFiles);
  const output = requiredText(options.output, "--output");
  const password = requiredText(env.ADMIN_MODEL_LAB_PASSWORD, "ADMIN_MODEL_LAB_PASSWORD");
  const client = (dependencies.createClient || createAdminModelLabHttpClient)({
    baseUrl: options.baseUrl || env.ADMIN_MODEL_LAB_BASE_URL,
    origin: options.origin || env.ADMIN_MODEL_LAB_ORIGIN,
    password,
    fetchImpl: dependencies.fetchImpl || globalThis.fetch,
  });
  await client.login();
  const bundle = await exportAdminSourceSnapshots({
    reportFiles: options.reportFiles,
    client,
    readFileImpl: dependencies.readFileImpl,
    now: dependencies.now,
  });
  await (dependencies.writeFileImpl || writeFile)(output, `${JSON.stringify(bundle, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  stdout.write(`${JSON.stringify({
    ok: true,
    output,
    sourceCount: bundle.sourceCount,
    sourceRunIds: bundle.sources.map((item) => item.sourceRunId),
  })}\n`);
  return 0;
}

function dedupeReferences(references) {
  const byCase = new Map();
  const byRun = new Map();
  for (const reference of references) {
    const previousCase = byCase.get(reference.caseId);
    if (previousCase && previousCase.sourceRunId !== reference.sourceRunId) {
      throw new Error(`case ${reference.caseId} has conflicting sourceRunId values`);
    }
    const previousRun = byRun.get(reference.sourceRunId);
    if (previousRun && previousRun.caseId !== reference.caseId) {
      throw new Error(`source run ${reference.sourceRunId} is shared by different cases`);
    }
    byCase.set(reference.caseId, reference);
    byRun.set(reference.sourceRunId, reference);
  }
  return [...byCase.values()];
}

function assertNoSensitiveFields(value, path = "bundle", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`sensitive field is forbidden in export: ${path}.${key}`);
    assertNoSensitiveFields(child, `${path}.${key}`, seen);
  }
}

function normalizeReportFiles(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("at least one --report is required");
  }
  return value.map((path) => requiredText(path, "report file"));
}

function requiredText(value, name) {
  const text = optionalText(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function optionalText(value) {
  return String(value ?? "").trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function usageText() {
  return "Usage: node scripts/export-admin-source-snapshots.mjs --report MATRIX.json --output BUNDLE.json [--base-url URL --origin ORIGIN]\n";
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url).toLowerCase() === String(process.argv[1]).toLowerCase();
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
