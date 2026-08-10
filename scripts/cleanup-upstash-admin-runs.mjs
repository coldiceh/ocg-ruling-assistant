import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ADMIN_RUN_CLEANUP_CONFIRMATION,
  ADMIN_RUN_WRITES_DISABLED_CONFIRMATION,
  DEFAULT_ADMIN_RUN_CLEANUP_LIMITS,
  executeAdminRunCleanup,
  planAdminRunCleanup,
} from "../backend/adminRunRedisCleanup.mjs";

export function parseAdminRunCleanupArguments(argv = []) {
  const options = {
    olderThanDays: null,
    execute: false,
    confirmation: "",
    writesDisabledConfirmation: "",
    approvalFingerprint: "",
    compact: false,
    limits: { ...DEFAULT_ADMIN_RUN_CLEANUP_LIMITS },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (argument === "--") {
      continue;
    } else if (argument === "--older-than-days") {
      options.olderThanDays = requiredNumber(argv, ++index, argument);
    } else if (argument === "--max-runs") {
      options.limits.maxRuns = requiredInteger(argv, ++index, argument);
    } else if (argument === "--max-keys") {
      options.limits.maxKeys = requiredInteger(argv, ++index, argument);
    } else if (argument === "--max-known-bytes") {
      options.limits.maxKnownBytes = requiredInteger(argv, ++index, argument);
    } else if (argument === "--max-scan-keys") {
      options.limits.maxScanKeys = requiredInteger(argv, ++index, argument);
    } else if (argument === "--execute") {
      options.execute = true;
    } else if (argument === "--confirm") {
      options.confirmation = requiredText(argv, ++index, argument);
    } else if (argument === "--confirm-writes-disabled") {
      options.writesDisabledConfirmation = requiredText(argv, ++index, argument);
    } else if (argument === "--plan-fingerprint") {
      options.approvalFingerprint = requiredText(argv, ++index, argument);
    } else if (argument === "--compact") {
      options.compact = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new TypeError(`unsupported argument: ${argument}`);
    }
  }
  return options;
}

export async function runAdminRunCleanupCli(
  argv = process.argv.slice(2),
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    now = new Date(),
    stdout = process.stdout,
    planCleanup = planAdminRunCleanup,
    executeCleanup = executeAdminRunCleanup,
  } = {},
) {
  const options = parseAdminRunCleanupArguments(argv);
  if (options.help) {
    stdout.write(helpText());
    return null;
  }
  if (options.olderThanDays === null) {
    throw new TypeError("--older-than-days is required, including for dry-run");
  }
  if (options.execute && options.confirmation !== ADMIN_RUN_CLEANUP_CONFIRMATION) {
    const error = new Error(
      `--execute requires --confirm \"${ADMIN_RUN_CLEANUP_CONFIRMATION}\"`,
    );
    error.code = "admin_run_cleanup_refused";
    throw error;
  }
  if (options.execute
    && options.writesDisabledConfirmation !== ADMIN_RUN_WRITES_DISABLED_CONFIRMATION) {
    const error = new Error(
      `--execute requires --confirm-writes-disabled "${ADMIN_RUN_WRITES_DISABLED_CONFIRMATION}"`,
    );
    error.code = "admin_run_cleanup_refused";
    throw error;
  }
  if (options.execute && !/^[a-f0-9]{64}$/u.test(options.approvalFingerprint)) {
    const error = new Error(
      "--execute requires the exact 64-character --plan-fingerprint from dry-run",
    );
    error.code = "admin_run_cleanup_refused";
    throw error;
  }
  const plan = await planCleanup({
    env,
    fetchImpl,
    now,
    olderThanDays: options.olderThanDays,
    limits: options.limits,
  });
  const report = options.execute
    ? await executeCleanup(plan, {
        execute: true,
        confirmation: options.confirmation,
        writesDisabledConfirmation: options.writesDisabledConfirmation,
        approvalFingerprint: options.approvalFingerprint,
        fetchImpl,
      })
    : plan;
  stdout.write(`${JSON.stringify(report, null, options.compact ? 0 : 2)}\n`);
  return report;
}

function helpText() {
  return [
    "Usage: node scripts/cleanup-upstash-admin-runs.mjs --older-than-days <days> [options]",
    "",
    "Default mode is read-only dry-run. It never deletes Admin Lab History,",
    "query-audit, session, budget, public-latency, or feedback data.",
    "",
    "Options:",
    "  --older-than-days <n>  Required positive terminal-run age threshold",
    `  --max-runs <n>         Hard cap (default ${DEFAULT_ADMIN_RUN_CLEANUP_LIMITS.maxRuns})`,
    `  --max-keys <n>         Hard cap (default ${DEFAULT_ADMIN_RUN_CLEANUP_LIMITS.maxKeys})`,
    `  --max-known-bytes <n>  Hard cap (default ${DEFAULT_ADMIN_RUN_CLEANUP_LIMITS.maxKnownBytes})`,
    `  --max-scan-keys <n>    SCAN safety cap (default ${DEFAULT_ADMIN_RUN_CLEANUP_LIMITS.maxScanKeys})`,
    "  --compact              Print compact JSON",
    "  --execute              Apply the in-process dry-run plan",
    `  --confirm <phrase>     Exact phrase: ${ADMIN_RUN_CLEANUP_CONFIRMATION}`,
    `  --confirm-writes-disabled <phrase> Exact phrase: ${ADMIN_RUN_WRITES_DISABLED_CONFIRMATION}`,
    "  --plan-fingerprint <h> Exact 64-character fingerprint from the reviewed dry-run",
    "  -h, --help             Show this help",
    "",
    "Execution is irreversible and must be run while Admin Model Lab creation",
    "and forking are paused. History keeps only a normalized, maximum-500-char",
    "questionSummary; full evidence, result, events, timing, replay, and forks",
    "from a deleted run are not retained.",
    "",
  ].join("\n");
}

function requiredText(argv, index, option) {
  const value = String(argv[index] ?? "");
  if (!value || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
  return value;
}

function requiredNumber(argv, index, option) {
  const value = Number(requiredText(argv, index, option));
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${option} requires a positive number`);
  }
  return value;
}

function requiredInteger(argv, index, option) {
  const value = Number(requiredText(argv, index, option));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${option} requires a positive integer`);
  }
  return value;
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runAdminRunCleanupCli().catch((error) => {
    process.stderr.write(`${error?.code ? `${error.code}: ` : ""}${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
