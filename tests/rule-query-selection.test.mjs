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

test("a five-branch retrieval budget keeps four model subclaims and one deterministic fallback", () => {
  const deterministic = {
    query: "原始问题中的完整操作、区域、时点与所问结果",
    source: "deterministic_user_question",
  };
  const supplemental = [1, 2, 3, 4].map((index) => ({
    query: `互相独立的模型子问题 ${index}`,
    checkpoint: `checkpoint_${index}`,
    source: "model_rule_query_extractor",
  }));
  const selected = selectIndependentRuleQueries({
    deterministicRuleQueries: [deterministic],
    supplementalRuleQueries: supplemental,
    limit: 5,
  });

  assert.equal(selected.length, 5);
  assert.equal(selected.filter((item) => item.source === "model_rule_query_extractor").length, 4);
  assert.ok(selected.some((item) => item.query === deterministic.query));
});

test("a duplicate model rewrite remains a single model branch", () => {
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

test("the reserved deterministic branch maximizes mechanism novelty instead of source order", () => {
  const lateCardTextBranch = {
    query: "场上的魔法陷阱卡返回持有者手牌",
    source: "card_text_derived_rule_search_query",
  };
  const selected = selectIndependentRuleQueries({
    deterministicRuleQueries: [
      { query: "效果发动后进行处理", source: "derived_rule_search_query" },
      { query: "怪兽可以特殊召唤", source: "card_text_derived_rule_search_query" },
      lateCardTextBranch,
    ],
    supplementalRuleQueries: [
      { query: "效果能否发动", source: "model_rule_query_extractor" },
      { query: "效果处理时如何适用", source: "model_rule_query_extractor" },
      { query: "处理后能否特殊召唤", source: "model_rule_query_extractor" },
    ],
    limit: 4,
  });

  assert.equal(selected.length, 4);
  assert.ok(selected.some((item) => item.query === lateCardTextBranch.query), JSON.stringify(selected));
  assert.equal(selected.filter((item) => item.source === "model_rule_query_extractor").length, 3);
});

test("checkpoint diversity keeps model branches while deterministic evidence fills an unused slot", () => {
  const deterministic = {
    query: "完整题面中的确定性卡文操作分支",
    source: "card_text_derived_rule_search_query",
  };
  const supplemental = [
    "operation_legality",
    "resolution_snapshot",
    "step_dependency",
  ].map((checkpoint, index) => ({
    query: `模型独立查询 ${index + 1}`,
    checkpoint,
    source: "model_rule_query_extractor",
  }));

  const selected = selectIndependentRuleQueries({
    deterministicRuleQueries: [deterministic],
    supplementalRuleQueries: supplemental,
    limit: 4,
  });
  assert.equal(selected.length, 4);
  assert.ok(selected.some((item) => item.query === deterministic.query), JSON.stringify(selected));
  assert.equal(selected.filter((item) => item.source === "model_rule_query_extractor").length, 3);

  const single = selectIndependentRuleQueries({
    deterministicRuleQueries: [deterministic],
    supplementalRuleQueries: supplemental,
    limit: 1,
  });
  assert.deepEqual(single.map((item) => item.query), [deterministic.query]);
});

test("a primary card-text grounding branch survives novelty-only deterministic selection", () => {
  const grounding = {
    query: "通常陷阱卡的卡片发动后场上的魔法陷阱卡返回持有者手牌",
    source: "card_text_derived_rule_search_query",
  };
  const referenceGrounding = {
    query: "通常陷阱卡的卡片发动后场上的魔法陷阱卡返回持有者手牌并破坏",
    source: "card_text_reference_derived_rule_search_query",
  };
  const novelButUnrelated = {
    query: "怪兽效果的发动被无效后从墓地除外并特殊召唤",
    source: "card_text_derived_rule_search_query",
  };
  const selected = selectIndependentRuleQueries({
    deterministicRuleQueries: [
      referenceGrounding,
      novelButUnrelated,
      grounding,
    ],
    supplementalRuleQueries: [{
      query: "连锁通常陷阱卡的发动并将正在发动的卡返回持有者手牌",
      checkpoint: "operation_legality",
      source: "model_rule_query_extractor",
    }, {
      query: "通常陷阱卡处理前离开魔法陷阱区域时如何结算",
      checkpoint: "resolution_snapshot",
      source: "model_rule_query_extractor",
    }],
    limit: 3,
  });
  assert.equal(selected.length, 3);
  assert.ok(selected.some((item) => item.query === grounding.query), JSON.stringify(selected));
  assert.ok(!selected.some((item) => item.query === referenceGrounding.query));
  assert.ok(!selected.some((item) => item.query === novelButUnrelated.query));
});

test("one treated-as relation cannot impersonate two grounding features", () => {
  const duplicateRelation = {
    query: "该对象不被视为原本种类",
    source: "card_text_derived_rule_search_query",
  };
  const novelOperation = {
    query: "场上的魔法陷阱卡返回持有者手牌",
    source: "card_text_derived_rule_search_query",
  };
  const selected = selectIndependentRuleQueries({
    deterministicRuleQueries: [duplicateRelation, novelOperation],
    supplementalRuleQueries: [{
      query: "对象不会被视为原本种类",
      checkpoint: "classification",
      source: "model_rule_query_extractor",
    }],
    limit: 2,
  });

  assert.equal(selected.length, 2);
  assert.ok(selected.some((item) => item.query === novelOperation.query), JSON.stringify(selected));
  assert.ok(!selected.some((item) => item.query === duplicateRelation.query));
});
