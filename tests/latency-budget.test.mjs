import assert from "node:assert/strict";
import test from "node:test";
import { LATENCY_TARGETS, createLatencyBudget, isLatencyTimeout, runWithinLatencyBudget } from "../backend/latencyBudget.mjs";

test("duel latency budget is capped at ten seconds", () => {
  const budget = createLatencyBudget({ mode: "duel", maxLatencyMs: 99999 });
  assert.equal(budget.budgetMs, LATENCY_TARGETS.duel.hardTimeoutMs);
});

test("budget timeout rejects without returning an unvalidated result", async () => {
  const budget = createLatencyBudget({ mode: "duel", maxLatencyMs: 250 });
  await assert.rejects(() => runWithinLatencyBudget(() => new Promise(() => {}), budget, "model"), (error) => isLatencyTimeout(error));
});
