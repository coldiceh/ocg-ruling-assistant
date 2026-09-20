import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Per-run usage reporting only. No Redis access, spending limit, reservation,
// cumulative ledger, or historical charge reconciliation. The reserve/settle
// names are adapters for the existing preprocessing call sites.
export function createEvidenceRunCostReporter({ reportPath = null } = {}) {
  const requests = new Map();
  let outcome = "running";
  let pending = Promise.resolve();
  const warnings = new Set();
  const knownAmount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  function summary() {
    const rows = [...requests.values()];
    const known = rows.filter((row) => knownAmount(row.amountUsd));
    const sum = (items) => Number(items.reduce((total, row) => total + row.amountUsd, 0).toFixed(12));
    const unknownCostRequests = rows.length - known.length;
    const byProvider = {};
    for (const row of rows) {
      const key = row.providerId || "unknown";
      const group = byProvider[key] ||= { requests: 0, knownCostUsd: 0, unknownCostRequests: 0 };
      group.requests += 1;
      if (knownAmount(row.amountUsd)) group.knownCostUsd += row.amountUsd;
      else group.unknownCostRequests += 1;
    }
    for (const group of Object.values(byProvider)) group.knownCostUsd = Number(group.knownCostUsd.toFixed(12));
    return {
      schemaVersion: 1,
      kind: "evidence-preprocess-run-cost",
      mode: "report_only",
      scope: "new_navigation_and_gemini_embedding_requests_in_this_process",
      currency: "USD",
      costBasis: "provider_usage_times_existing_configured_rates_not_supplier_invoice",
      outcome,
      requestsAttempted: rows.length,
      knownCostRequests: known.length,
      unknownCostRequests,
      knownCostUsd: sum(known),
      totalCostUsd: unknownCostRequests ? null : sum(known),
      byProvider,
      warnings: [...warnings],
    };
  }
  async function persist() {
    if (!reportPath) return;
    // Serialize snapshots so parallel workers cannot overwrite a newer total.
    pending = pending.then(async () => {
      const temp = `${reportPath}.${randomUUID()}.tmp`;
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(temp, `${JSON.stringify(summary(), null, 2)}\n`, "utf8");
      await rename(temp, reportPath);
    }).catch(() => {
      // Reporting storage must not become another payment gate.
      warnings.add("cost_report_write_failed");
    });
    await pending;
  }
  return Object.freeze({
    kind: "evidence-preprocess-run-cost-reporter",
    reportOnly: true,
    summary,
    persist,
    async reserve({ ticket, providerId = "unknown", modelId = null }) {
      if (!requests.has(ticket)) requests.set(ticket, { providerId, modelId, amountUsd: null });
      await persist();
      return { status: "reported", ticket };
    },
    async recordUsage({ ticket, usage }) {
      const row = requests.get(ticket);
      // Replaying an old response is not a new provider request this run.
      if (!row) return { status: "historical_ignored" };
      const cost = usage?.billableCost;
      row.amountUsd = cost?.status === "known" && knownAmount(cost.amountUsd) ? cost.amountUsd : null;
      await persist();
      return { status: "reported" };
    },
    async settle({ ticket, spentUsd }) {
      const row = requests.get(ticket);
      if (!row) return { status: "historical_ignored" };
      row.amountUsd = knownAmount(spentUsd) ? spentUsd : null;
      await persist();
      return { status: "reported" };
    },
    async finish(result) {
      outcome = result;
      await persist();
      return summary();
    },
  });
}

export function formatEvidenceRunCost(report) {
  if (report?.kind !== "evidence-preprocess-run-cost" || !Number.isFinite(report.knownCostUsd)
      || !Number.isInteger(report.unknownCostRequests)) {
    return "SYNC COST: unavailable; do not treat missing usage as zero.";
  }
  const amount = report.knownCostUsd.toFixed(8);
  const qualifier = report.unknownCostRequests
    ? `known subtotal USD ${amount}; ${report.unknownCostRequests} request(s) have UNKNOWN cost`
    : `USD ${amount}`;
  return `SYNC COST: ${qualifier}; ${report.requestsAttempted} new request(s); configured-rate estimate, not supplier invoice; outcome=${report.outcome}.`;
}

export async function publishEvidenceRunCost({ reportPath, summaryPath, log = console.log } = {}) {
  let report;
  try { report = JSON.parse(await readFile(reportPath, "utf8")); } catch { report = null; }
  const line = formatEvidenceRunCost(report);
  log(line);
  if (report) log(`SYNC_COST_JSON ${JSON.stringify(report)}`);
  if (summaryPath) {
    await appendFile(summaryPath, `## This run: model API cost\n\n${line}\n\nCached responses are not charged again in this total. Missing usage is unknown, not free. This excludes GitHub, Redis, and other infrastructure fees.\n`, "utf8")
      .catch(() => log("SYNC COST WARNING: could not write GitHub job summary."));
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  publishEvidenceRunCost({ reportPath: process.argv[2], summaryPath: process.env.GITHUB_STEP_SUMMARY })
    .catch(() => console.log("SYNC COST: unavailable; do not treat missing usage as zero."));
}
