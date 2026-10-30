import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildRuleExamSet, extractRuleExamFromRecord, paragraphs } from "../extract-rule-exam.mjs";

const page = (title, body) => ({ id: `ocg-rule:c05/${title}`, recordType: "rule-test", docname: `c05/${title}`,
  title: `${title} ¶`, sourceUrl: `https://example.invalid/${title}`, text: `${title} ¶\n\n ${body.join("\n\n ")}` });

test("official layout: context paragraphs stay with the stem, options wrap lines, range keys map in order", () => {
  const record = page("2099年游戏王OCG规则检定测试", [
    "前言 ¶", "说明文字。", "正文 ¶", "基本部分 ¶",
    "以下哪个是cost？", "A. 甲", "B.\n乙的第一行\n，乙的续行", "C. 丙",
    "应用部分 ¶",
    "以下状况中，正确的是？", "例：场上存在某卡。", "A. 一", "B. 二", "C. 三",
    "答案 ¶", "1~2 CB",
  ]);
  const { page: info, questions } = extractRuleExamFromRecord(record);
  assert.equal(info.status, "ok");
  assert.equal(info.examKind, "konami_rule_exam_translation");
  assert.deepEqual(questions.map((question) => [question.section, question.number, question.answer, question.type]),
    [["基本部分", 1, "C", "single_choice"], ["应用部分", 2, "B", "single_choice"]]);
  assert.equal(questions[0].options[1].text, "乙的第一行\n，乙的续行");
  assert.equal(questions[1].question, "以下状况中，正确的是？\n\n例：场上存在某卡。");
  assert.equal(questions[1].explanation, null);
});

test("sectioned key: single, multiple and true/false numbering restart per section", () => {
  const record = page("规则测试2099", [
    "正文 ¶", "单选题 ¶", "问一？", "A. x", "B. y", "多选题 ¶", "问二？", "A. x", "B. y", "C. z",
    "判断题 ¶", "陈述一。", "陈述二。",
    "答案 ¶", "以上题目……", "单选题 ¶", "1-1 B", "多选题 ¶", "1 AC", "判断题 ¶", "1-2 √ ×",
  ]);
  const { page: info, questions } = extractRuleExamFromRecord(record);
  assert.equal(info.status, "ok");
  assert.equal(info.examKind, "ocg_rule_site_exam");
  assert.deepEqual(info.ignoredAnswerLines, ["以上题目……"]);
  assert.deepEqual(questions.map((question) => [question.id.split("#")[1], question.type, question.answer]), [
    ["单选题-1", "single_choice", "B"], ["多选题-1", "multiple_choice", "AC"],
    ["判断题-1", "true_false", "√"], ["判断题-2", "true_false", "×"],
  ]);
});

test("unnumbered key: statement sets, short answers closed by 简答, remarks kept verbatim", () => {
  const record = page("规则测试2098", [
    "正文 ¶",
    "问一？", "A. x", "B. y",
    "下列说法是否正确？", "a. 甲", "b. 乙",
    "已知某条 FAQ：", "Q: 某问 A: 某答", "简答：矛盾吗？",
    "答案 ¶", "B（20/1/1裁定变更：A）", "正确 错误（21/1/1变更：正确）", "不矛盾。原因见某页。",
  ]);
  const { page: info, questions } = extractRuleExamFromRecord(record);
  assert.equal(info.status, "ok");
  assert.deepEqual(questions.map((question) => question.type), ["single_choice", "statement_set", "short_answer"]);
  assert.equal(questions[0].answer, "B");
  assert.equal(questions[0].answerNote, "20/1/1裁定变更：A");
  assert.deepEqual(questions[1].answer, ["正确", "错误"]);
  assert.equal(questions[1].answerRaw, "正确 错误（21/1/1变更：正确）");
  assert.equal(questions[2].question, "已知某条 FAQ：\n\nQ: 某问 A: 某答\n\n简答：矛盾吗？");
  assert.equal(questions[2].answer, "不矛盾。原因见某页。");
});

test("a key that does not match the question count leaves answers empty and marks the page partial", () => {
  const record = page("规则测试2097", ["正文 ¶", "问一？", "A. x", "B. y", "问二？", "A. x", "B. y", "答案 ¶", "1-1 A"]);
  const { page: info, questions } = extractRuleExamFromRecord(record);
  assert.equal(info.status, "partial");
  assert.match(info.problems.join(), /answer_count_mismatch:page:1\/2/u);
  assert.ok(questions.every((question) => question.answer === null));
  assert.equal(extractRuleExamFromRecord(page("目录", ["没有题目"])).page.status, "skipped_no_question_or_answer_section");
  assert.deepEqual(paragraphs("a\r\n\r\n b\n \n c"), ["a", "b", "c"]);
});

test("current corpus: every exam page with an answer key parses without count problems", async () => {
  const corpus = JSON.parse(await readFile(new URL("../../../data/ocg-rule-corpus.json", import.meta.url), "utf8"));
  const set = buildRuleExamSet(corpus);
  const parsed = set.pages.filter((info) => info.status !== "skipped_no_question_or_answer_section");
  assert.ok(parsed.length >= 6);
  assert.deepEqual(parsed.filter((info) => info.status !== "ok").map((info) => [info.title, info.problems]), []);
  assert.equal(set.fieldCompleteness.answer, set.itemCount);
  assert.ok(set.items.filter((item) => item.examKind === "konami_rule_exam_translation").every((item) => item.options.length === 5));
});
