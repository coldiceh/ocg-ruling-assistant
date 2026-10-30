#!/usr/bin/env node
// Mechanically extracts the 50-question benchmark (question text and the
// reference answer column) from the published static table. No text is
// rewritten: character references are decoded and nothing else changes.
import { createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cellText } from "./lib/html-text.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DEFAULT_HTML = "assets/benchmarks/ocg-50-20260924.html";
export const DEFAULT_OUT = "scripts/bench/sets/ocg-50-20260924.json";
export const EXPECTED_QUESTION_COUNT = 50;

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function attribute(attributes, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "u").exec(attributes);
  return match ? match[1] : null;
}

function single(rowHtml, pattern, label, qid) {
  const matches = [...rowHtml.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`ocg50_${label}_count_${matches.length}:${qid}`);
  return matches[0][1];
}

/**
 * Extracts every question row of the benchmark table.
 * @param {string|Buffer} html raw file content (hashed after CRLF→LF normalization)
 * @param {{expectedCount?: number}} options
 */
export function extractOcg50FromHtml(html, { expectedCount = EXPECTED_QUESTION_COUNT } = {}) {
  // Git for Windows checks this file out with CRLF by default. Hash and read
  // the LF-normalized UTF-8 text so the set and its hash are platform-stable.
  const text = (Buffer.isBuffer(html) ? html.toString("utf8") : String(html)).replace(/\r\n?/gu, "\n");
  const sourceHtmlSha256 = sha256Hex(Buffer.from(text, "utf8"));
  const items = [];
  for (const row of text.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gu)) {
    const [, attributes, body] = row;
    const qid = attribute(attributes, "data-case");
    if (qid === null) continue; // header row
    if (!/^Q\d+$/u.test(qid)) throw new Error(`ocg50_qid_invalid:${qid}`);
    if (attribute(attributes, "id") !== qid) throw new Error(`ocg50_row_id_mismatch:${qid}`);
    const heading = cellText(single(body, /<h2>([\s\S]*?)<\/h2>/gu, "heading", qid), `${qid}:heading`);
    if (heading !== qid) throw new Error(`ocg50_heading_mismatch:${qid}:${heading}`);
    const question = cellText(single(body, /<p class="question-text">([\s\S]*?)<\/p>/gu, "question", qid), `${qid}:question`);
    const referenceAnswer = cellText(single(body, /<td class="reference">([\s\S]*?)<\/td>/gu, "reference", qid), `${qid}:reference`);
    const cellIds = [...new Set([...body.matchAll(/\bdata-cell="(B\d+)-[^"]*"/gu)].map((match) => match[1]))];
    if (cellIds.length !== 1) throw new Error(`ocg50_cell_id_count_${cellIds.length}:${qid}`);
    items.push({ qid, cellId: cellIds[0], question, referenceAnswer, sourceHtmlSha256 });
  }
  validateOcg50Items(items, { expectedCount });
  return { sourceHtmlSha256, items };
}

export function validateOcg50Items(items, { expectedCount = EXPECTED_QUESTION_COUNT } = {}) {
  const problems = [];
  if (items.length !== expectedCount) problems.push(`count:${items.length}!=${expectedCount}`);
  items.forEach((item, index) => {
    if (item.qid !== `Q${index + 1}`) problems.push(`order:${index}:${item.qid}`);
    for (const field of ["qid", "cellId", "question", "referenceAnswer", "sourceHtmlSha256"]) {
      if (typeof item[field] !== "string" || !item[field].trim()) problems.push(`empty:${item.qid}:${field}`);
    }
  });
  for (const field of ["qid", "cellId"]) {
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item[field])) problems.push(`duplicate:${field}:${item[field]}`);
      seen.add(item[field]);
    }
  }
  if (problems.length) throw new Error(`ocg50_validation_failed:${problems.join(",")}`);
  return true;
}

export function buildOcg50SetDocument({ sourceHtmlSha256, items }, { htmlPath = DEFAULT_HTML } = {}) {
  return {
    schemaVersion: 1,
    setId: "ocg-50-20260924",
    description: "50题基准：题面与参考答案（结论+理由）由 extract-ocg50.mjs 从静态表机械抽取，未改写。",
    source: { path: htmlPath.replaceAll("\\", "/"), sha256: sourceHtmlSha256 },
    extractedBy: "scripts/bench/extract-ocg50.mjs",
    repeat: 1,
    itemCount: items.length,
    items,
  };
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function parseArgs(argv) {
  const options = { html: DEFAULT_HTML, out: DEFAULT_OUT, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--html" || argument === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/bench/extract-ocg50.mjs [--html <file>] [--out <json>] [--check]\n"
      + "--check 只校验现有 JSON 与重新抽取结果一致，不写文件。");
    return;
  }
  const htmlPath = path.resolve(repositoryRoot, options.html);
  const outPath = path.resolve(repositoryRoot, options.out);
  const extracted = extractOcg50FromHtml(await readFile(htmlPath));
  const document = buildOcg50SetDocument(extracted, { htmlPath: path.relative(repositoryRoot, htmlPath) });
  if (options.check) {
    const existing = JSON.parse(await readFile(outPath, "utf8"));
    if (JSON.stringify(existing) !== JSON.stringify(document)) {
      console.error(`不一致：${path.relative(repositoryRoot, outPath)} 与重新抽取结果不同`);
      process.exitCode = 1;
      return;
    }
    console.log(`一致：${document.itemCount} 题，source sha256=${document.source.sha256}`);
    return;
  }
  await writeJsonAtomic(outPath, document);
  const emptyFields = document.items.filter((item) => Object.values(item).some((value) => !String(value).trim())).length;
  console.log(`已写入 ${path.relative(repositoryRoot, outPath)}：${document.itemCount} 题，空字段 ${emptyFields} 处，`
    + `cellId ${document.items[0].cellId}–${document.items.at(-1).cellId}，source sha256=${document.source.sha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
