import assert from "node:assert/strict";
import test from "node:test";

import { selectIndependentRuleQueries } from "../backend/ragEvidenceRetriever.mjs";

test("a full four-query model plan cannot remove the deterministic question branch", () => {
  const deterministic = [{
    query: "原始问题中的完整操作、区域、时点与所问结果",
    source: "deterministic_user_question",
  }];
  const supplemental = [1, 2, 3, 4].map((index) => ({
    query: `模型改写查询 ${index}：完整操作、区域、时点与所问结果`,
    source: "model_rule_query_extractor",
  }));

  for (const permutation of [
    supplemental,
    [...supplemental].reverse(),
    [supplemental[2], supplemental[0], supplemental[3], supplemental[1]],
  ]) {
    const selected = selectIndependentRuleQueries({
      deterministicRuleQueries: deterministic,
      supplementalRuleQueries: permutation,
      limit: 4,
    });
    assert.equal(selected.length, 4);
    assert.ok(selected.some((item) => item.query === deterministic[0].query));
    assert.equal(selected.filter((item) => item.source === "model_rule_query_extractor").length, 3);
  }
});

test("a duplicate model rewrite does not consume the reserved deterministic slot", () => {
  const sharedQuery = "同一完整问题分支";
  const selected = selectIndependentRuleQueries({
    deterministicRuleQueries: [{ query: sharedQuery, source: "deterministic_user_question" }],
    supplementalRuleQueries: [
      { query: sharedQuery, source: "model_rule_query_extractor" },
      { query: "独立模型查询二", source: "model_rule_query_extractor" },
      { query: "独立模型查询三", source: "model_rule_query_extractor" },
      { query: "独立模型查询四", source: "model_rule_query_extractor" },
    ],
    limit: 4,
  });

  assert.equal(selected.length, 4);
  assert.equal(selected.filter((item) => item.query === sharedQuery).length, 1);
});
