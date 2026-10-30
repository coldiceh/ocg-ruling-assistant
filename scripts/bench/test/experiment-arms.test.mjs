// The named experiment arms: composition, conflicts, the production baseline
// and the runner's argument handling of arms and the final-model switch.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_EVIDENCE_EXPERIMENT_ARMS, EVIDENCE_EXPERIMENT_ARM_KEYS, evidenceExperimentArm, withEvidenceExperimentArm,
} from "../../../backend/evidenceExperimentArms.mjs";
import { loadEvidenceGenerationContract } from "../../../backend/evidenceGenerationContract.mjs";
import {
  armKeyDifference, baselineProductionMismatch, buildBaseEnv, readVercelProductionEnv,
} from "../lib/bench-env.mjs";
import { parseRunnerArgs, planJobs } from "../run-retrieval-compare.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

test("arms compose features over the production baseline", () => {
  assert.deepEqual(evidenceExperimentArm("baseline"), { RULE_NAVIGATION_PARTITION: "legacy",
    EVIDENCE_PLANNING_PROFILE: "gemini-3.8-flash-medium-planning-room-theoretical", RULE_TOC_ADMIT_ENABLED: "false" });
  assert.deepEqual(evidenceExperimentArm("nav-family+plan-luna+toc"), { RULE_NAVIGATION_PARTITION: "source-family",
    EVIDENCE_PLANNING_PROFILE: "bai-gpt-6-luna-medium-theoretical", RULE_TOC_ADMIT_ENABLED: "true" });
  assert.equal(evidenceExperimentArm("nav-unit+plan-luna-low").EVIDENCE_PLANNING_PROFILE, "bai-gpt-6-luna-low-theoretical");
  assert.deepEqual(DEFAULT_EVIDENCE_EXPERIMENT_ARMS, ["baseline", "toc", "nav-family", "nav-family+toc",
    "nav-family+plan-luna", "nav-family+plan-luna+toc"]);
  for (const name of ["nav-family+nav-unit", "plan-luna+plan-luna-low", "toc+toc", "luna", "", "toc+nav-family"]) {
    assert.throws(() => evidenceExperimentArm(name), (error) => error.code === "evidence_experiment_arm_unknown", name);
  }
  assert.throws(() => evidenceExperimentArm("toc+nav-family"), /must be written nav-family\+toc/u);
  const env = { KEEP: "1", RULE_TOC_ADMIT_ENABLED: "true" };
  assert.deepEqual(withEvidenceExperimentArm(env, "baseline").RULE_TOC_ADMIT_ENABLED, "false");
  assert.equal(env.RULE_TOC_ADMIT_ENABLED, "true", "the given env is not modified");
});

test("baseline is the vercel.json production configuration and arms differ only in their keys", () => {
  const production = readVercelProductionEnv(path.join(repositoryRoot, "vercel.json"));
  assert.deepEqual(baselineProductionMismatch(production), []);
  assert.deepEqual(baselineProductionMismatch({ ...production, RULE_TOC_ADMIT_ENABLED: "true" }),
    ["RULE_TOC_ADMIT_ENABLED: vercel.json=true baseline=false"]);
  assert.deepEqual(armKeyDifference("baseline", "toc"), ["RULE_TOC_ADMIT_ENABLED"]);
  assert.deepEqual(armKeyDifference("toc", "nav-family+plan-luna"),
    ["EVIDENCE_PLANNING_PROFILE", "RULE_NAVIGATION_PARTITION", "RULE_TOC_ADMIT_ENABLED"]);
  const base = buildBaseEnv({ mode: "mock", productionEnv: production, ledgerMode: "memory", runId: "x",
    setEnv: {} });
  for (const key of EVIDENCE_EXPERIMENT_ARM_KEYS) assert.equal(Object.hasOwn(base, key), false, key);
  for (const arm of DEFAULT_EVIDENCE_EXPERIMENT_ARMS) {
    const contract = loadEvidenceGenerationContract("planning", { env: { ...withEvidenceExperimentArm(base, arm) } });
    assert.ok(["gemini", "bai"].includes(contract.providerId), arm);
  }
});

test("runner arguments: evidence pack by default, arms validated, arm keys not settable", () => {
  const parsed = parseRunnerArgs(["--set", "x.json", "--mock"]);
  assert.equal(parsed.prepareOnly, true);
  assert.deepEqual(parsed.arms, [...DEFAULT_EVIDENCE_EXPERIMENT_ARMS]);
  assert.equal(parsed.jobEstimateUsd, 0.05);
  const withFinal = parseRunnerArgs(["--set", "x.json", "--mock", "--with-final"]);
  assert.equal(withFinal.prepareOnly, false);
  assert.equal(withFinal.jobEstimateUsd, 0.15);
  assert.throws(() => parseRunnerArgs(["--set", "x.json", "--mock", "--with-final", "--prepare-only"]), /只能选一个/u);
  assert.throws(() => parseRunnerArgs(["--set", "x.json", "--mock", "--arms", "baseline,toc+nav-family"]), /未知臂/u);
  assert.throws(() => parseRunnerArgs(["--set", "x.json", "--mock", "--set-env", "RULE_NAVIGATION_PARTITION=legacy"]),
    /由 --arms 控制/u);
  const jobs = planJobs({ items: [{ qid: "Q1", question: "a" }, { qid: "Q2", question: "b" }],
    arms: ["baseline", "toc", "nav-family"], repeat: 1 });
  assert.deepEqual(jobs.map((job) => job.key), ["Q1__baseline__r1", "Q1__toc__r1", "Q1__nav-family__r1",
    "Q2__nav-family__r1", "Q2__toc__r1", "Q2__baseline__r1"]);
});
