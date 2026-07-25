import assert from "node:assert/strict";
import test from "node:test";

import {
  detectTranslationPlaceholder,
  findRulingDataQualityIssues,
  formatRulingDataQualityIssue,
  quarantineRulingData,
  selectUsableLocalizedRulingText,
} from "../backend/rulingDataQuality.mjs";
import { buildDataHealth } from "../backend/dataHealth.mjs";

const card = { id: "card-a", name: "测试卡A", aliases: ["测试卡A"] };
const alias = { alias: "测试卡A", normalizedAlias: "测试卡a", cardId: "card-a", cardName: "测试卡A" };

test("translation placeholder detection covers mismatch and obvious failure variants", () => {
  assert.equal(detectTranslationPlaceholder("Translation mismatch error")?.code, "translation_mismatch_error");
  assert.equal(detectTranslationPlaceholder("[Translation unavailable]")?.code, "translation_failure_placeholder");
  assert.equal(detectTranslationPlaceholder("翻译失败")?.code, "translation_failure_placeholder");
  assert.equal(detectTranslationPlaceholder("这个效果正常处理。"), null);
});

test("localized ruling selection skips broken translations and keeps the usable Japanese original", () => {
  const selected = selectUsableLocalizedRulingText({
    en: {
      answer: "A useful prefix. (Translation mismatch error: source changed.)",
    },
    cn: {
      answer: "Untranslated text related to a card name.",
    },
    ja: {
      answer: "この効果は通常通り適用されます。",
    },
  }, ["answer", "content"]);

  assert.deepEqual(selected, {
    text: "この効果は通常通り適用されます。",
    locale: "ja",
    field: "answer",
  });
  assert.equal(selectUsableLocalizedRulingText({
    en: { answer: "Translation unavailable" },
    ja: { answer: "翻訳エラー" },
  }, ["answer"]), null);
});

test("ruling quality scan identifies placeholders in QA and card FAQ bodies without using source IDs", () => {
  const issues = findRulingDataQualityIssues([
    {
      id: "arbitrary-qa",
      recordType: "qa",
      question: "这个效果如何处理？",
      conclusion: "Translation mismatch error",
    },
    {
      id: "arbitrary-faq",
      recordType: "card-faq",
      conclusion: "正常正文。",
      steps: ["Translation unavailable"],
    },
    {
      id: "card-text-a",
      recordType: "card-text",
      conclusion: "Translation mismatch error",
    },
  ]);

  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map((issue) => issue.recordId), ["arbitrary-qa", "arbitrary-faq"]);
  assert.match(formatRulingDataQualityIssue(issues[0]), /translation_mismatch_error/u);
});

test("existing snapshots containing translation placeholders are unhealthy", () => {
  const qa = {
    id: "qa-a",
    recordType: "qa",
    title: "测试问答",
    question: "如何处理？",
    conclusion: "Translation mismatch error",
  };
  const faq = { id: "faq-a", recordType: "card-faq", title: "测试 FAQ", conclusion: "可以。" };
  const health = buildDataHealth({
    cards: [card],
    rulings: [qa, faq],
    aliases: [alias],
    qaIndex: [{ id: "qa-a", recordType: "qa" }],
  });

  assert.equal(health.status, "data_quality_invalid");
  assert.equal(health.usable, false);
  assert.equal(health.rulingDataQualityIssueCount, 1);
  assert.equal(health.rulingDataQualityIssues[0].recordId, "qa-a");
});

test("quarantine retains a healthy previous value and drops invalid records without a safe fallback", () => {
  const previousHealthy = {
    id: "qa-retained",
    recordType: "qa",
    question: "如何处理？",
    conclusion: "旧的健康正文。",
  };
  const result = quarantineRulingData([
    {
      ...previousHealthy,
      conclusion: "Translation mismatch error",
    },
    {
      id: "qa-dropped",
      recordType: "qa",
      question: "如何处理？",
      conclusion: "Untranslated text",
    },
    {
      id: "qa-ok",
      recordType: "qa",
      question: "如何处理？",
      conclusion: "新的健康正文。",
    },
  ], [previousHealthy]);

  assert.equal(result.issues.length, 2);
  assert.deepEqual(result.retainedPreviousIds, ["qa-retained"]);
  assert.deepEqual(result.droppedIds, ["qa-dropped"]);
  assert.equal(result.records.find((record) => record.id === "qa-retained")?.conclusion, "旧的健康正文。");
  assert.equal(result.records.find((record) => record.id === "qa-dropped"), undefined);
  assert.equal(findRulingDataQualityIssues(result.records).length, 0);
});
