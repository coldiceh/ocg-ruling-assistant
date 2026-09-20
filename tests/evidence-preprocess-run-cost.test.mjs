import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEvidenceRunCostReporter, formatEvidenceRunCost, publishEvidenceRunCost } from "../scripts/lib/evidence-preprocess-run-cost.mjs";
import { createCloudEvidencePreprocessResources } from "../scripts/lib/evidence-preprocess-cloud.mjs";

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "run-cost-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("report-only has no cap and ignores historical settlements and duplicate usage", async () => {
  const r = createEvidenceRunCostReporter();
  await r.settle({ ticket: "historical", spentUsd: 99 });
  await r.reserve({ ticket: "new", amountUsd: 0.01, providerId: "bai" });
  await r.settle({ ticket: "new", spentUsd: 6 });
  await r.settle({ ticket: "new", spentUsd: 6 });
  assert.equal(r.summary().requestsAttempted, 1);
  assert.equal(r.summary().totalCostUsd, 6); // Neither old $5 cap nor quote enforced.
  const nextRun = createEvidenceRunCostReporter();
  await nextRun.settle({ ticket: "new", spentUsd: 6 });
  assert.equal(nextRun.summary().requestsAttempted, 0);
  assert.equal(nextRun.summary().totalCostUsd, 0);
});

test("missing usage and a lost response remain unknown, not zero", async () => {
  const r = createEvidenceRunCostReporter();
  await r.reserve({ ticket: "known", providerId: "bai" });
  await r.recordUsage({ ticket: "known", usage: { billableCost: { status: "known", amountUsd: 0.1 } } });
  await r.reserve({ ticket: "lost", providerId: "gemini" });
  await r.reserve({ ticket: "missing", providerId: "bai" });
  await r.recordUsage({ ticket: "missing", usage: { billableCost: { status: "unknown", amountUsd: null } } });
  assert.equal(r.summary().knownCostUsd, 0.1);
  assert.equal(r.summary().totalCostUsd, null);
  assert.equal(r.summary().unknownCostRequests, 2);
  assert.match(formatEvidenceRunCost(r.summary()), /UNKNOWN cost/);
});

test("parallel snapshots persist final subtotal, not ticket IDs or content", async (t) => {
  const dir = await directory(t);
  const reportPath = join(dir, "run-cost.json");
  const r = createEvidenceRunCostReporter({ reportPath });
  await Promise.all(Array.from({ length: 30 }, async (_, i) => {
    const ticket = `secret-ticket-${i}`;
    await r.reserve({ ticket, providerId: "bai" });
    await r.settle({ ticket, spentUsd: 0.01 });
  }));
  await r.finish("failed");
  const text = await readFile(reportPath, "utf8");
  const saved = JSON.parse(text);
  assert.equal(saved.totalCostUsd, 0.3);
  assert.equal(saved.requestsAttempted, 30);
  assert.equal(saved.outcome, "failed");
  assert.doesNotMatch(text, /secret-ticket/);
});

test("report storage failure does not block provider processing", async (t) => {
  const dir = await directory(t);
  const file = join(dir, "not-a-directory");
  await writeFile(file, "fixture");
  const r = createEvidenceRunCostReporter({ reportPath: join(file, "run-cost.json") });
  await r.reserve({ ticket: "one" });
  await r.settle({ ticket: "one", spentUsd: 0.25 });
  await r.finish("success");
  assert.equal(r.summary().totalCostUsd, 0.25);
  assert.deepEqual(r.summary().warnings, ["cost_report_write_failed"]);
});

test("cloud report-only uses existing cache without touching invalid or missing ledger", async () => {
  const calls = [];
  const resources = await createCloudEvidencePreprocessResources({
    reportOnlyCost: true, costReporter: createEvidenceRunCostReporter(),
    env: {
      EVIDENCE_PREPROCESS_AUTHORIZATION_ID: "invalid auth!",
      EVIDENCE_PREPROCESS_LEDGER_KEY: "broken-ledger",
      EVIDENCE_PREPROCESS_MAX_USD: "not-a-number",
      EVIDENCE_PREPROCESS_CACHE_NAMESPACE: "ocg-daily-sync-20260920",
      UPSTASH_BUDGET_KV_REST_API_URL: "https://fixture.example.test",
      UPSTASH_BUDGET_KV_REST_API_TOKEN: "fixture-token",
    },
    fetchImpl: async (_url, options) => {
      const command = JSON.parse(options.body);
      calls.push(command);
      assert.equal(command[0], "GET");
      assert.match(command[1], /^evidence-preprocess:dense:/);
      assert.doesNotMatch(command[1], /ledger/);
      return new Response(JSON.stringify({ result: JSON.stringify({ vector: [1] }) }));
    },
  });
  assert.equal(calls.length, 0);
  assert.equal(resources.budget.reportOnly, true);
  assert.deepEqual(await resources.cache.readResult("dense", "a".repeat(64)), { vector: [1] });
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /ocg-daily-sync-20260920:result$/);
});

test("summary is available on failure and unavailable reports never claim zero", async (t) => {
  const dir = await directory(t);
  const reportPath = join(dir, "run-cost.json");
  const summaryPath = join(dir, "summary.md");
  const r = createEvidenceRunCostReporter({ reportPath });
  await r.finish("failed");
  const lines = [];
  await publishEvidenceRunCost({ reportPath, summaryPath, log: (line) => lines.push(line) });
  assert.match(lines[0], /USD 0\.00000000/);
  assert.match(await readFile(summaryPath, "utf8"), /outcome=failed/);
  const missing = [];
  await publishEvidenceRunCost({ reportPath: join(dir, "missing"), log: (line) => missing.push(line) });
  assert.match(missing[0], /unavailable/);
  assert.doesNotMatch(missing[0], /USD 0/);
});

test("workflow uses report-only instead of ledger initialization or maximum spend", async () => {
  const text = await readFile(new URL("../.github/workflows/sync-data.yml", import.meta.url), "utf8");
  const paidStep = text.split("id: bounded_sync")[1].split("- name: Promote")[0];
  assert.match(paidStep, /--report-only-cost/);
  assert.match(paidStep, /EVIDENCE_PREPROCESS_CACHE_NAMESPACE/);
  assert.doesNotMatch(paidStep, /initializeCloudEvidencePreprocessLedger|readCloudEvidencePreprocessLedger|--max-usd|EVIDENCE_PREPROCESS_LEDGER_KEY|EVIDENCE_PREPROCESS_MAX_USD/);
  assert.match(paidStep, /always\(\)/);
});
