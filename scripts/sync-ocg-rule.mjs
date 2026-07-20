import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(rootDir, "data");
const baseUrl = normalizeBaseUrl(process.env.OCG_RULE_BASE_URL || "https://ocg-rule.readthedocs.io/zh-cn/latest/");
const maxPages = Number(process.env.OCG_RULE_MAX_PAGES || 240);
const fetchConcurrency = Number(process.env.OCG_RULE_FETCH_CONCURRENCY || 6);
const userAgent = "ocg-ruling-assistant/0.2 (+https://github.com/coldiceh/ocg-ruling-assistant)";

const testKeywordPattern = /(测试|检定|試験|试题|题目|练习|practice|exam|test|judge)/i;
const nonContentDocPattern = /(?:^|\/)(?:index|search|genindex|py-modindex)$/iu;

async function main() {
  await mkdir(dataDir, { recursive: true });
  const corpusPath = join(dataDir, "ocg-rule-corpus.json");
  const testsPath = join(dataDir, "ocg-rule-tests.json");
  const previousCorpus = await readJson(corpusPath, { records: [] });
  const index = await loadSearchIndex();
  const docs = buildDocTargets(index).slice(0, maxPages);
  const pageResults = await mapLimit(docs, fetchConcurrency, loadRulePage);
  const records = pageResults.map((item) => item.record).filter(Boolean);
  const failures = pageResults.filter((item) => !item.record);
  const tests = records.filter((record) => testKeywordPattern.test(`${record.docname} ${record.title}`));
  const generatedAt = new Date().toISOString();
  const sync = validateOcgRuleSnapshot({
    targets: docs,
    records,
    failures,
    previousRecords: previousCorpus.records || [],
    env: process.env,
  });
  sync.testCount = tests.length;

  const corpusPayload = {
    schemaVersion: 1,
    generatedAt,
    source: {
      name: "OCG Rule",
      url: baseUrl,
      role: "规则学习资料与裁判训练资料；回答时只能作为规则依据或测试集，不能伪装为官方数据库裁定。",
    },
    sync,
    records,
  };

  const testsPayload = {
    schemaVersion: 1,
    generatedAt,
    source: {
      name: "OCG Rule tests",
      url: baseUrl,
      role: "裁判训练/往年测试资料，用于回归测试和规则理解检查。",
    },
    sync: { ...sync, testCount: tests.length },
    records: tests.map((record) => ({
      id: record.id,
      title: record.title,
      docname: record.docname,
      sourceUrl: record.sourceUrl,
      text: record.text,
    })),
  };

  await Promise.all([
    writeJsonAtomic(corpusPath, corpusPayload),
    writeJsonAtomic(testsPath, testsPayload),
  ]);

  console.log(`Synced ${records.length}/${docs.length} OCG rule pages and ${tests.length} test pages (${sync.contentHash.slice(0, 12)}).`);
}

async function loadSearchIndex() {
  const script = await fetchText(new URL("searchindex.js", baseUrl).toString());
  const match = script.match(/Search\.setIndex\(([\s\S]+)\)\s*;?\s*$/);
  if (!match) throw new Error("Could not parse ReadTheDocs searchindex.js");
  return JSON.parse(match[1]);
}

export function buildDocTargets(index) {
  const docnames = Array.isArray(index.docnames) ? index.docnames : [];
  const titles = Array.isArray(index.titles) ? index.titles : [];
  return docnames
    .map((docname, index) => ({
      docname,
      title: cleanText(titles[index] || docname),
      sourceUrl: new URL(`${docname}.html`, baseUrl).toString(),
    }))
    .filter((doc) => doc.docname && !nonContentDocPattern.test(doc.docname));
}

async function loadRulePage(doc) {
  try {
    const html = await fetchText(doc.sourceUrl);
    const title = extractTitle(html) || doc.title;
    const text = cleanText(stripHtml(extractMainHtml(html)));
    if (text.length < 120) return { doc, error: "page_text_too_short" };
    return { doc, record: {
      id: `ocg-rule:${doc.docname}`,
      recordType: testKeywordPattern.test(`${doc.docname} ${title}`) ? "rule-test" : "rule-doc",
      title,
      docname: doc.docname,
      sourceName: "OCG Rule",
      sourceUrl: doc.sourceUrl,
      keywords: extractKeywords(`${doc.docname} ${title} ${text}`),
      text,
      updatedAt: new Date().toISOString(),
    } };
  } catch (error) {
    console.warn(`Skip ${doc.sourceUrl}: ${formatError(error)}`);
    return { doc, error: formatError(error) };
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/javascript,text/plain,*/*",
      "user-agent": userAgent,
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

function extractMainHtml(html) {
  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) return articleMatch[1];
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return mainMatch[1];
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : html;
}

function extractTitle(html) {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(stripHtml(match[1])) : "";
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|section|article|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function cleanText(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = String(entity).toLowerCase();
    if (lower[0] === "#") {
      const isHex = lower[1] === "x";
      const codePoint = Number.parseInt(lower.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
  });
}

function extractKeywords(text) {
  const groups = [
    ["发动", /发动|発動|activate/i],
    ["连锁", /连锁|チェーン|chain/i],
    ["无效", /无效|無効|negate/i],
    ["效果处理", /处理|適用|apply|resolve/i],
    ["对象", /对象|対象|target/i],
    ["破坏", /破坏|破壊|destroy/i],
    ["除外", /除外|banish/i],
    ["伤害", /伤害|ダメージ|damage/i],
    ["战斗", /战斗|戦闘|battle/i],
    ["测试", testKeywordPattern],
  ];
  return groups.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function normalizeBaseUrl(value) {
  const text = String(value || "").trim();
  return text.endsWith("/") ? text : `${text}/`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export function hashOcgRuleRecords(records = []) {
  const stable = (records || []).map((record) => ({
    id: String(record.id || ""),
    recordType: String(record.recordType || ""),
    title: String(record.title || ""),
    docname: String(record.docname || ""),
    sourceUrl: String(record.sourceUrl || ""),
    keywords: [...(record.keywords || [])].map(String).sort(),
    text: String(record.text || ""),
  })).sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function validateOcgRuleSnapshot({
  targets = [],
  records = [],
  failures = [],
  previousRecords = [],
  env = {},
} = {}) {
  const targetCount = targets.length || records.length + failures.length;
  const recordCount = records.length;
  const failedCount = failures.length || Math.max(0, targetCount - recordCount);
  const successRatio = targetCount ? recordCount / targetCount : 0;
  const minimumRecords = readThreshold(env.OCG_RULE_MIN_RECORDS, 10);
  const minimumSuccessRatio = readRatio(env.OCG_RULE_MIN_SUCCESS_RATIO, 0.85);
  const minimumPreviousRatio = readRatio(env.OCG_RULE_MIN_PREVIOUS_RATIO, 0.75);
  const previousRecordCount = previousRecords.length;
  const uniqueIds = new Set(records.map((record) => String(record.id || "")).filter(Boolean));
  const errors = [];
  if (!targetCount) errors.push("no_content_targets");
  if (recordCount < minimumRecords) errors.push(`record_count_below_minimum:${recordCount}<${minimumRecords}`);
  if (uniqueIds.size !== recordCount) errors.push(`duplicate_or_missing_record_ids:${uniqueIds.size}/${recordCount}`);
  if (successRatio < minimumSuccessRatio) errors.push(`success_ratio_below_minimum:${successRatio.toFixed(3)}<${minimumSuccessRatio}`);
  if (previousRecordCount >= minimumRecords && recordCount / previousRecordCount < minimumPreviousRatio) {
    errors.push(`snapshot_shrank_abnormally:${recordCount}/${previousRecordCount}<${minimumPreviousRatio}`);
  }
  if (errors.length) {
    const failedSample = failures.slice(0, 5).map((item) => item?.doc?.sourceUrl || item?.doc?.docname || item?.error).filter(Boolean);
    throw new Error(`OCG Rule snapshot rejected: ${errors.join(", ")}${failedSample.length ? `; failed=${failedSample.join(" | ")}` : ""}`);
  }
  return {
    status: "complete",
    targetCount,
    recordCount,
    failedCount,
    successRatio: Number(successRatio.toFixed(6)),
    previousRecordCount,
    contentHash: hashOcgRuleRecords(records),
    previousContentHash: hashOcgRuleRecords(previousRecords),
    failedDocnames: failures.slice(0, 12).map((item) => item?.doc?.docname).filter(Boolean),
  };
}

function readThreshold(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function readRatio(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
