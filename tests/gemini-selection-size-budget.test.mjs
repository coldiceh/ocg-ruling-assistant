import { displayedPayload } from './helpers/readable-prompt.mjs';
import test from "node:test";
import assert from "node:assert/strict";

import {
  computeGeminiSelectionPackingBudget,
  packGeminiSelection,
} from "../backend/geminiRuleQaPacking.mjs";

const MARKER = "本次用户问题、卡片原文与检索资料如下：\n";

// Mechanical invariant: these estimates count serialized prompt characters
// only; they never decide relevance, completeness, authority, or sufficiency.
function fixture() {
  const shared = {
    recordType: "rule-doc",
    title: "共享规则来源",
    sourceUrl: "https://rules.example.test/shared",
    source: "fixture-rules",
    sourceAuthority: "official_reference",
    official: true,
    parentSourceId: "shared-parent",
  };
  const rules = [
    { ...shared, id: "R1", ruleUnitIndex: 0, text: "条件一：保留完整正文。".repeat(12) },
    { ...shared, id: "R2", ruleUnitIndex: 1, text: "条件二：保留另一段完整正文。".repeat(10) },
    {
      ...shared,
      id: "R3",
      ruleUnitIndex: 2,
      sourceUrl: "https://rules.example.test/other",
      text: "不同来源正文。".repeat(8),
    },
  ];
  const qaItems = [
    {
      handle: "qa-escaped",
      record: {
        id: "qa-escaped-record",
        recordType: "qa",
        title: "带转义字符的 QA",
        sourceName: "fixture-qa",
        sourceUrl: "https://qa.example.test/escaped",
        sourceAuthority: "official_database",
        official: true,
        question: "问题含有 \"引号\" 和 \\\\ 反斜杠",
        answer: "回答第一行\n回答第二行",
      },
    },
    {
      handle: "qa-plain",
      record: {
        id: "qa-plain-record",
        recordType: "qa",
        title: "普通 QA",
        sourceAuthority: "official_database",
        official: true,
        question: "普通问题",
        answer: "普通回答",
      },
    },
  ];
  return {
    rules,
    qaItems,
    userQuery: "原题含有固定卡文、转义字符和多个来源。",
    cardResolution: {
      resolvedCards: [{ id: "1001", name: "测试卡", effectText: "完整卡文。" }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    retrievedEvidence: {
      cardTexts: [{
        id: "card-fixed",
        type: "card_text",
        title: "固定卡文",
        text: '固定卡文含有 "引号" 和反斜杠 \\ 以及换行\n。',
      }],
      userProvidedCardTexts: [{
        id: "user-fixed",
        type: "user_provided_text",
        title: "用户卡文",
        text: "用户补充固定字段",
      }],
    },
  };
}

test("budget maps conservatively bound a multi-source packed prompt", () => {
  const input = fixture();
  const budget = computeGeminiSelectionPackingBudget({ ...input, maxPromptChars: 14000 });
  const actual = packGeminiSelection({
    ...input,
    selection: { selectedRules: input.rules, selectedQa: input.qaItems },
    maxPromptChars: 14000,
  });
  const estimated = budget.basePromptChars
    + Object.values(budget.ruleUnitChars).reduce((sum, chars) => sum + chars, 0)
    + Object.values(budget.qaHandleChars).reduce((sum, chars) => sum + chars, 0);

  assert.equal(budget.limitChars, 14000);
  assert.equal(budget.availableEvidenceChars, Math.max(0, 14000 - budget.basePromptChars));
  assert.equal(
    budget.basePromptChars,
    packGeminiSelection({ ...input, selection: { selectedRules: [], selectedQa: [] } })
      .packing.promptChars,
  );
  assert.ok(actual.packing.promptChars <= estimated,
    `actual ${actual.packing.promptChars} must fit estimated ${estimated}`);
  assert.deepEqual(Object.keys(budget.ruleUnitChars), ["R1", "R2", "R3"]);
  assert.deepEqual(Object.keys(budget.qaHandleChars), ["qa-escaped", "qa-plain"]);

  const payload = displayedPayload(actual.packing);
  const first = payload.evidence.rawRelatedEvidence.find((item) => item.id === "R1");
  const second = payload.evidence.rawRelatedEvidence.find((item) => item.id === "R2");
  const firstSource = first.sourceRef ? payload.ruleSources[first.sourceRef] : first;
  const secondSource = second.sourceRef ? payload.ruleSources[second.sourceRef] : second;
  assert.equal(firstSource.sourceUrl, "https://rules.example.test/shared");
  assert.equal(secondSource.sourceUrl, firstSource.sourceUrl);
  if (payload.ruleSources) assert.equal(first.sourceRef, second.sourceRef,
    "when sharing saves characters, identical source metadata uses the same reference");
  assert.match(actual.packing.prompt, /qa-escaped/u);
  assert.match(actual.packing.prompt, /\\\\/u, "literal source backslashes remain in the prompt");
});

test("each estimate covers its actual single-entry marginal size and separators", () => {
  const input = fixture();
  const budget = computeGeminiSelectionPackingBudget(input);
  const base = packGeminiSelection({ ...input, selection: { selectedRules: [], selectedQa: [] } })
    .packing.promptChars;

  for (const rule of input.rules) {
    const actual = packGeminiSelection({ ...input,
      selection: { selectedRules: [rule], selectedQa: [] } }).packing.promptChars;
    assert.ok(budget.ruleUnitChars[rule.id] >= actual - base);
  }
  for (const item of input.qaItems) {
    const actual = packGeminiSelection({ ...input,
      selection: { selectedRules: [], selectedQa: [item] } }).packing.promptChars;
    assert.ok(budget.qaHandleChars[item.handle] >= actual - base);
  }
});

test("available evidence characters never becomes negative when fixed fields exceed the limit", () => {
  const input = fixture();
  const budget = computeGeminiSelectionPackingBudget({ ...input, maxPromptChars: 1 });
  assert.equal(budget.availableEvidenceChars, 0);
  assert.equal(budget.limitChars, 1);
  assert.ok(budget.basePromptChars > budget.limitChars);
});
