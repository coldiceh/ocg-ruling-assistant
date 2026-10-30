#!/usr/bin/env node
// Mechanically extracts the rule-exam pages of data/ocg-rule-corpus.json
// (recordType "rule-test": the translated KONAMI 规则检定测试 2018–2021 and the
// site's own 规则测试2017/2020) into question / option / answer records.
// Only page structure is used: paragraph breaks, "… ¶" headings, option and
// sub-item labels (A./a.), the "简答：" closing line of short-answer items and
// the answer key under "答案 ¶". Nothing is reworded, judged or run.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DEFAULT_CORPUS = "data/ocg-rule-corpus.json";
export const DEFAULT_OUT = "scripts/bench/sets/rule-exam.json";

const HEADING = /^(.+?)\s*¶$/u;
const CONTENT_HEADINGS = new Set(["正文", "基本部分", "应用部分", "单选题", "多选题", "判断题"]);
const OPTION = /^([A-Z])[.．]\s*([\s\S]*)$/u;
const SUB_ITEM = /^([a-z])[.．]\s*([\s\S]*)$/u;
const SHORT_ANSWER_CLOSE = /^简答[：:]/u;
const RANGE_ANSWER = /^(\d+)\s*[-~～－]\s*(\d+)\s+(.+)$/u;
const NUMBERED_ANSWER = /^(\d+)\s+(\S.*)$/u;

export function paragraphs(text) {
  return String(text).replace(/\r\n?/gu, "\n").split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
}

function headingName(paragraph) {
  const match = HEADING.exec(paragraph);
  return match && !paragraph.includes("\n") ? match[1].trim() : null;
}

// Groups the question region of one section into items.
function parseQuestionSection(section, lines) {
  const items = [];
  let current = null;
  const finish = () => {
    if (current) items.push(current);
    current = null;
  };
  for (const paragraph of lines) {
    if (section === "判断题") {
      // Each paragraph of a true/false section is one statement.
      items.push({ section, parts: [paragraph], options: [], subItems: [] });
      continue;
    }
    const option = OPTION.exec(paragraph);
    const subItem = option ? null : SUB_ITEM.exec(paragraph);
    if (option || subItem) {
      if (!current) current = { section, parts: [], options: [], subItems: [] };
      (option ? current.options : current.subItems).push({ label: (option || subItem)[1], text: (option || subItem)[2].trim() });
      continue;
    }
    if (current && (current.options.length || current.subItems.length)) finish();
    if (!current) current = { section, parts: [], options: [], subItems: [] };
    current.parts.push(paragraph);
    if (SHORT_ANSWER_CLOSE.test(paragraph)) finish();
  }
  finish();
  return items;
}

function splitAnswerTokens(raw, expected) {
  const compact = raw.replace(/\s+/gu, "");
  if (/^[A-Z]+$/u.test(compact) && compact.length === expected) return [...compact];
  const tokens = raw.split(/\s+/u).filter(Boolean);
  return tokens.length === expected ? tokens : null;
}

// Answer key → Map(scope → Map(number → raw answer)).
function parseAnswerRegion(lines) {
  const scopes = new Map();
  let scope = "*";
  let sequential = [];
  const problems = [];
  const put = (number, value) => {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    const map = scopes.get(scope);
    if (map.has(number)) problems.push(`duplicate_answer:${scope}:${number}`);
    map.set(number, value);
  };
  for (const line of lines) {
    const heading = headingName(line);
    if (heading) {
      if (CONTENT_HEADINGS.has(heading)) scope = heading;
      continue;
    }
    const range = RANGE_ANSWER.exec(line);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const tokens = splitAnswerTokens(range[3], end - start + 1);
      if (!tokens) problems.push(`range_token_count:${line}`);
      else tokens.forEach((token, index) => put(start + index, token));
      continue;
    }
    const numbered = NUMBERED_ANSWER.exec(line);
    if (numbered) {
      put(Number(numbered[1]), numbered[2].trim());
      continue;
    }
    sequential.push({ scope, line });
  }
  return { scopes, sequential, problems };
}

// Parenthesized remarks (e.g. "（20/7/29裁定变更：不能）") are kept verbatim in
// answerNote and removed from the primary answer wherever they occur; the
// published answer is not re-decided from them.
function normalizeAnswer(raw, item) {
  const notes = [...raw.matchAll(/[（(]([^）)]*)[）)]/gu)].map((match) => match[1].trim());
  const primary = raw.replace(/[（(][^）)]*[）)]/gu, " ").replace(/\s+/gu, " ").trim();
  const letters = primary.replace(/\s+/gu, "");
  let answer = primary;
  if (item.options.length && /^[A-Z]+$/u.test(letters)) answer = letters;
  else if (item.subItems.length) {
    const tokens = primary.split(" ");
    answer = tokens.length === item.subItems.length ? tokens : primary;
  }
  return { answer, answerRaw: raw, answerNote: notes.length ? notes.join("；") : null };
}

function itemType(item, answer) {
  if (item.section === "判断题") return "true_false";
  if (item.subItems.length) return "statement_set";
  if (item.options.length) {
    if (typeof answer !== "string") return "choice";
    return answer.length > 1 ? "multiple_choice" : "single_choice";
  }
  return "short_answer";
}

export function extractRuleExamFromRecord(record) {
  const lines = paragraphs(record.text);
  const answerIndex = lines.findIndex((line) => headingName(line) === "答案");
  const firstContent = lines.findIndex((line) => CONTENT_HEADINGS.has(headingName(line) || ""));
  const page = { id: record.id, title: String(record.title || "").replace(/\s*¶$/u, ""), sourceUrl: record.sourceUrl || null,
    examKind: /规则检定测试/u.test(record.docname || "") ? "konami_rule_exam_translation" : "ocg_rule_site_exam",
    status: "ok", problems: [], questionCount: 0, answeredCount: 0 };
  if (answerIndex < 0 || firstContent < 0 || firstContent > answerIndex) {
    page.status = "skipped_no_question_or_answer_section";
    return { page, questions: [] };
  }
  const sections = [];
  let section = null;
  for (const line of lines.slice(firstContent, answerIndex)) {
    const heading = headingName(line);
    if (heading) {
      if (CONTENT_HEADINGS.has(heading)) {
        section = { name: heading, lines: [] };
        sections.push(section);
      } else page.problems.push(`unexpected_heading:${heading}`);
      continue;
    }
    section?.lines.push(line);
  }
  const items = sections.flatMap((entry) => parseQuestionSection(entry.name, entry.lines));
  const answerLines = lines.slice(answerIndex + 1);
  const { scopes, sequential, problems } = parseAnswerRegion(answerLines);
  page.problems.push(...problems);

  // Map answers to items: per-section numbering when the key has section
  // headings, otherwise one numbering across the page; an unnumbered key is
  // read one paragraph per item in order. Counts must match exactly.
  const sectionNames = [...new Set(items.map((item) => item.section))];
  const answersFor = new Array(items.length).fill(null);
  const scoped = [...scopes.keys()].filter((key) => key !== "*");
  if (scoped.length) {
    for (const name of sectionNames) {
      const sectionItems = items.map((item, index) => ({ item, index })).filter((entry) => entry.item.section === name);
      const map = scopes.get(name);
      if (!map || map.size !== sectionItems.length) {
        page.problems.push(`answer_count_mismatch:${name}:${map?.size ?? 0}/${sectionItems.length}`);
        continue;
      }
      sectionItems.forEach((entry, position) => { answersFor[entry.index] = map.get(position + 1) ?? null; });
    }
  } else if (scopes.has("*")) {
    const map = scopes.get("*");
    if (map.size === items.length && items.every((_, index) => map.has(index + 1))) {
      items.forEach((_, index) => { answersFor[index] = map.get(index + 1); });
    } else page.problems.push(`answer_count_mismatch:page:${map.size}/${items.length}`);
  } else if (sequential.length === items.length) {
    sequential.forEach((entry, index) => { answersFor[index] = entry.line; });
  } else {
    page.problems.push(`answer_count_mismatch:sequential:${sequential.length}/${items.length}`);
  }
  // With a numbered key, other answer-region paragraphs (introductory remarks)
  // are listed for review but are not answers.
  if (scopes.size && sequential.length) page.ignoredAnswerLines = sequential.map((entry) => entry.line);

  const numbering = new Map();
  const questions = items.map((item, index) => {
    const scopeKey = scoped.length ? item.section : "*";
    const number = (numbering.get(scopeKey) || 0) + 1;
    numbering.set(scopeKey, number);
    const raw = answersFor[index];
    const normalized = raw === null ? { answer: null, answerRaw: null, answerNote: null } : normalizeAnswer(raw, item);
    if (raw !== null && item.subItems.length && !Array.isArray(normalized.answer)) {
      page.problems.push(`statement_answer_token_mismatch:${item.section}-${number}`);
    }
    return {
      id: `${page.title}#${scoped.length ? `${item.section}-` : ""}${number}`,
      pageId: page.id,
      pageTitle: page.title,
      examKind: page.examKind,
      section: item.section,
      number,
      type: itemType(item, normalized.answer),
      question: item.parts.join("\n\n"),
      options: item.options,
      subItems: item.subItems,
      ...normalized,
      explanation: null,
    };
  });
  page.questionCount = questions.length;
  page.answeredCount = questions.filter((question) => question.answer !== null).length;
  if (page.problems.length) page.status = "partial";
  return { page, questions };
}

export function buildRuleExamSet(corpus, { corpusPath = DEFAULT_CORPUS, corpusSha256 = null } = {}) {
  const records = (corpus.records || []).filter((record) => record.recordType === "rule-test");
  const pages = [];
  const items = [];
  for (const record of records) {
    const { page, questions } = extractRuleExamFromRecord(record);
    pages.push(page);
    items.push(...questions);
  }
  const fieldCompleteness = completeness(items);
  return {
    schemaVersion: 1,
    setId: "ocg-rule-exams",
    description: "OCG Rule 站「规则检定测试」等页面的题目/选项/答案，机械抽取，未改写、未运行。答案为页面所载原值；页面注明的裁定变更保留在 answerNote，不代为改判。",
    source: { path: corpusPath, sha256: corpusSha256, generatedAt: corpus.generatedAt || null },
    extractedBy: "scripts/bench/extract-rule-exam.mjs",
    notes: [
      "解析（explanation）在语料文本中不存在：2021 页注明答案解析在外部链接，其余页面无解析；2017 简答题的理由包含在答案原文里。",
      "部分官方题题面引用了场面图（如“场上是以下状况的场合”），图片不在语料文本中；使用前需人工筛除。",
      "examKind 按页面路径区分：规则检定测试 = KONAMI 官方测试的中文翻译；规则测试20xx = 本站作者自出题，非官方。",
    ],
    pages,
    fieldCompleteness,
    itemCount: items.length,
    items,
  };
}

export function completeness(items) {
  const count = (predicate) => items.filter(predicate).length;
  const choice = items.filter((item) => item.options.length);
  return {
    total: items.length,
    question: count((item) => item.question.trim().length > 0),
    options: { applicable: choice.length, present: count((item) => item.options.length >= 2) },
    answer: count((item) => item.answer !== null && String(item.answer).trim().length > 0),
    answerWithRemark: count((item) => item.answerNote !== null),
    explanation: count((item) => item.explanation !== null),
    byType: Object.fromEntries([...new Set(items.map((item) => item.type))].map((type) => [type, count((item) => item.type === type)])),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const options = { corpus: DEFAULT_CORPUS, out: DEFAULT_OUT };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--help" || argv[index] === "-h") {
      console.log("node scripts/bench/extract-rule-exam.mjs [--corpus data/ocg-rule-corpus.json] [--out scripts/bench/sets/rule-exam.json]");
      return;
    }
    if (!["--corpus", "--out"].includes(argv[index]) || !argv[index + 1]) throw new Error(`unknown or incomplete argument: ${argv[index]}`);
    options[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  const corpusPath = path.resolve(repositoryRoot, options.corpus);
  const raw = (await readFile(corpusPath, "utf8")).replace(/\r\n?/gu, "\n");
  const document = buildRuleExamSet(JSON.parse(raw), {
    corpusPath: path.relative(repositoryRoot, corpusPath).replaceAll("\\", "/"),
    corpusSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
  });
  const outPath = path.resolve(repositoryRoot, options.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(`${outPath}.tmp`, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await rename(`${outPath}.tmp`, outPath);
  console.log(`已写入 ${path.relative(repositoryRoot, outPath)}：${document.itemCount} 题`);
  for (const page of document.pages) {
    console.log(`  ${page.title}: ${page.status}，${page.questionCount} 题，${page.answeredCount} 有答案`
      + (page.problems.length ? `；问题 ${page.problems.join("; ")}` : ""));
  }
  console.log(`  字段完整率：${JSON.stringify(document.fieldCompleteness)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
