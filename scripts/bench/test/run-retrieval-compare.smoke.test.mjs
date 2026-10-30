// Mock-mode smoke test of the runner: the full production pipeline runs with
// the transport mock (no keys, no network), stops at the budget, resumes and
// produces a report. Takes about a minute (two cold asset preloads).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { integrityChecks, parseRunnerArgs, planJobs, unledgeredModelRequests } from "../run-retrieval-compare.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runner = path.join(repositoryRoot, "scripts/bench/run-retrieval-compare.mjs");
const reporter = path.join(repositoryRoot, "scripts/bench/report-retrieval-compare.mjs");

function run(script, args) {
  const child = spawnSync(process.execPath, [script, ...args], { cwd: repositoryRoot, encoding: "utf8", timeout: 300_000 });
  return { status: child.status, output: `${child.stdout}\n${child.stderr}` };
}

test("argument parsing guards the arm flag, budget and mock ledger", () => {
  assert.throws(() => parseRunnerArgs(["--set", "x.json"]), /真实模式必须给 --budget-usd/u);
  assert.throws(() => parseRunnerArgs(["--set", "x.json", "--mock", "--set-env", "RULE_TOC_ADMIT_ENABLED=true"]),
    /由 --arms 控制/u);
  assert.throws(() => parseRunnerArgs(["--set", "x.json", "--mock", "--ledger", "upstash"]), /进程内账本/u);
  assert.throws(() => parseRunnerArgs(["--set", "x.json", "--mock", "--arms", "baseline,other"]), /未知臂/u);
  const parsed = parseRunnerArgs(["--set", "x.json", "--mock", "--set-env", "A=b=c"]);
  assert.equal(parsed.ledger, "memory");
  assert.equal(parsed.budgetUsd, 1);
  assert.deepEqual(parsed.setEnv, { A: "b=c" });
  const jobs = planJobs({ items: [{ qid: "Q1", question: "a" }, { qid: "Q2", question: "b" }],
    arms: ["baseline", "toc"], repeat: 2 });
  assert.deepEqual(jobs.map((job) => job.key), [
    "Q1__baseline__r1", "Q1__toc__r1", "Q1__toc__r2", "Q1__baseline__r2",
    "Q2__toc__r1", "Q2__baseline__r1", "Q2__baseline__r2", "Q2__toc__r2",
  ]);
});

test("integrity checks catch silent mock fallbacks and model calls without a ledger ticket", () => {
  const continuation = { cardNameModel: { dryRun: false, providerUsed: "openai", modelUsed: "gpt-6-luna" },
    ruleQueryModel: { dryRun: false, evidenceSelector: "luna", stageTelemetry: { selection: { channel: "official" } } } };
  const final = { debug: { dryRun: false, providerUsed: "openai", requestedModel: "gpt-6-astra" } };
  const network = [
    { route: "mock", host: "api.openai.com", path: "/v1/responses" },
    { route: "mock", host: "generativelanguage.googleapis.com", path: "/v1beta/models/m:countTokens" },
    { route: "ledger", host: "bench-ledger.invalid", path: "/" },
    { route: "mock", host: "ygocdb.com", path: "/api/v0/" },
  ];
  assert.equal(integrityChecks({ continuation, final, network, calls: [{ status: "usage_settled" }] }).ok, true);
  assert.deepEqual(unledgeredModelRequests(network, []), { requests: 1, tickets: 0, ok: false });
  const fallback = integrityChecks({ continuation, final: { debug: { ...final.debug, dryRun: true, providerUsed: "mock" } },
    network, calls: [{ status: "usage_settled" }] });
  assert.equal(fallback.ok, false);
  assert.deepEqual(fallback.checks.filter((check) => !check.ok).map((check) => check.id),
    ["final_model_ran", "final_provider_openai"]);
});

test("mock run stops at the budget, resumes to completion and reports", { timeout: 600_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bench-smoke-"));
  try {
    const set = JSON.parse(await readFile(path.join(repositoryRoot, "scripts/bench/sets/ocg-50-20260924.json"), "utf8"));
    const setFile = path.join(directory, "set.json");
    await writeFile(setFile, JSON.stringify({ ...set, setId: "smoke", repeat: 1,
      items: set.items.filter((item) => ["Q1", "Q3"].includes(item.qid)) }));
    const out = path.join(directory, "run");

    const first = run(runner, ["--mock", "--set", setFile, "--out", out, "--budget-usd", "0.09",
      "--job-estimate-usd", "0.01", "--concurrency", "2"]);
    assert.equal(first.status, 3, first.output);
    const stopped = JSON.parse(await readFile(path.join(out, "checkpoint.json"), "utf8"));
    assert.equal(stopped.status, "budget_stopped");
    assert.ok(stopped.spentUsd > 0.09 || Object.values(stopped.jobs).some((job) => job.status === "budget_stopped"));
    assert.ok((stopped.counts.completed || 0) < 4);

    const second = run(runner, ["--mock", "--set", setFile, "--out", out, "--resume", "--budget-usd", "1"]);
    assert.equal(second.status, 0, second.output);
    const done = JSON.parse(await readFile(path.join(out, "checkpoint.json"), "utf8"));
    assert.equal(done.status, "completed");
    assert.equal(done.counts.completed, 4);
    assert.ok(done.spentUsd >= stopped.spentUsd);
    const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.sessions.length, 2);
    assert.deepEqual(manifest.armEnvDifference, { prepare: ["RULE_TOC_ADMIT_ENABLED"], finalize: ["RULE_TOC_ADMIT_ENABLED"] });
    assert.ok(!JSON.stringify(manifest.envSnapshots).includes("mock-final-openai-key"), "keys are masked");

    const names = (await readdir(path.join(out, "results"))).filter((name) => !name.endsWith(".events.json"));
    assert.equal(names.length, 4);
    for (const name of names) {
      const result = JSON.parse(await readFile(path.join(out, "results", name), "utf8"));
      assert.equal(result.status, "completed", name);
      assert.equal(result.integrity.ok, true, name);
      assert.ok(result.network.every((entry) => ["mock", "ledger"].includes(entry.route)), "no real network");
      assert.ok(result.prepared.continuation.promptBundle.prompt.length > 0);
      assert.ok(result.final.shortAnswer.includes("MOCK"));
      assert.ok(result.cost.calls.length >= 5);
      const toc = result.evidence.toc.summary;
      if (result.job.arm === "baseline") assert.equal(toc, null, name);
      else {
        // The mock ToC call answers unit 101; the stage records it end to end.
        assert.equal(toc.status, "selected", name);
        assert.equal(toc.selectedCount, 1, name);
        assert.ok(Number.isFinite(toc.officialListUsd) && toc.officialListUsd > 0, name);
        // The ledger settles in whole nano-dollars, hence the tolerance.
        assert.ok(result.cost.calls.some((call) => call.operation === "generate_content"
          && Math.abs(call.costUsd - toc.officialListUsd) < 1e-8), "ToC call is in the job's ledger cost");
      }
    }

    const report = run(reporter, ["--run", out]);
    assert.equal(report.status, 0, report.output);
    const markdown = await readFile(path.join(out, "report.md"), "utf8");
    assert.match(markdown, /MOCK 运行/u);
    const rows = markdown.split("\n").filter((line) => /^\| Q[13] \|/u.test(line));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.split(" | ")[5] === "selected" && row.split(" | ")[6] === "1"), rows.join("\n"));
    assert.match(markdown, /ToC 阶段（toc 臂 2 个任务）：状态 selected 2/u);
    assert.match(markdown, /选中单元进入最终包的题数：\d \/ 2/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
