import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateGoldenCase } from "../scripts/smoke-real-ruling-goldens.mjs";

const payload = JSON.parse(await readFile(new URL("../data/test/real-ruling-goldens.json", import.meta.url), "utf8"));

test("real ruling golden set contains at least twenty structured cases", () => {
  assert.ok(payload.cases.length >= 20);
  for (const item of payload.cases) {
    for (const key of ["id", "question", "expectedVerdictType", "mustMention", "mustNotMention", "requiredBlockers", "forbiddenBlockers", "notes"]) assert.ok(Object.hasOwn(item, key), `${item.id}:${key}`);
  }
});

test("illegal-premise golden enforces both primary and hypothetical branches", () => {
  const golden = payload.cases[0];
  const result = evaluateGoldenCase(golden, {
    answerType: "rule_judgment", verdict: "original_chain_illegal", primaryVerdict: "original_chain_illegal", statusChip: "RULE-JUDGED", sourceFreshness: "fresh",
    shortAnswer: "正常情况：题述连锁不成立。假设情况继续分析。",
    hypotheticalBranch: { verdict: "immediate_special_win" },
    resolutionSteps: [{ action: "C2后LP从2500变成1700。" }, { action: "特殊胜利条件满足且不开连锁，C1不再处理。" }],
    finalJudgeSummary: [], sourceSummary: { officialQaRefs: [] },
    blockers: golden.requiredBlockers.map((id) => ({ id })),
  });
  assert.equal(result.pass, true, result.failures.join(","));
});

test("golden evaluator rejects forbidden handling", () => {
  const golden = payload.cases[1];
  const result = evaluateGoldenCase(golden, { answerType: "rule_judgment", primaryVerdict: "cannot_activate", statusChip: "RULE-JUDGED", sourceFreshness: "fresh", shortAnswer: "可以发动，天雷把无限泡影返回手牌。", blockers: [] });
  assert.equal(result.pass, false);
});
