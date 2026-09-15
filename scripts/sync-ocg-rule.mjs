import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyManualOcgRuleSourcePolicy } from "./lib/ocg-rule-source-policy.mjs";
import { bindOcgRuleStructure, parseOcgRuleHtml } from "./lib/ocg-rule-structure.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(rootDir, "data");
const baseUrl = normalizeBaseUrl(process.env.OCG_RULE_BASE_URL || "https://ocg-rule.readthedocs.io/zh-cn/latest/");
const maxPages = Number(process.env.OCG_RULE_MAX_PAGES || 240);
const fetchConcurrency = Number(process.env.OCG_RULE_FETCH_CONCURRENCY || 6);
const userAgent = "ocg-ruling-assistant/0.2 (+https://github.com/coldiceh/ocg-ruling-assistant)";
const OWNED_RECORD_PREFIX = "ocg-rule:";
const fixedSourcesDir = join(dataDir, "fixed-rule-sources");

const testKeywordPattern = /(测试|检定|試験|试题|题目|练习|practice|exam|test|judge)/i;
const nonContentDocPattern = /(?:^|\/)(?:index|search|genindex|py-modindex)$/iu;

async function main() {
  await mkdir(dataDir, { recursive: true });
  const corpusPath = join(dataDir, "ocg-rule-corpus.json");
  const testsPath = join(dataDir, "ocg-rule-tests.json");
  const previousCorpus = await readJson(corpusPath, { records: [] });
  const fixedRecords = await loadFixedRuleSources(fixedSourcesDir);
  const index = await loadSearchIndex();
  const enumeratedDocs = buildDocTargets(index);
  assertCompleteOcgRuleFetch({ enumeratedDocs, maxPages });
  const docs = enumeratedDocs;
  const pageResults = await mapLimit(docs, fetchConcurrency, loadRulePage);
  const refreshedRecords = pageResults.map((item) => item.record).filter(Boolean);
  const failures = pageResults.filter((item) => !item.record);
  assertCompleteOcgRuleFetch({ enumeratedDocs, maxPages, pageResults });
  const previousRecords = Array.isArray(previousCorpus.records) ? previousCorpus.records : [];
  const previousOwnedRecords = previousRecords.filter((record) => String(record?.id || "").startsWith(OWNED_RECORD_PREFIX));
  const records = mergeOwnedOcgRuleRecords(refreshedRecords, fixedRecords);
  const tests = refreshedRecords.filter((record) => testKeywordPattern.test(`${record.docname} ${record.title}`));
  const generatedAt = new Date().toISOString();
  const sync = validateOcgRuleSnapshot({
    targets: docs,
    records,
    failures,
    previousRecords: previousOwnedRecords,
    env: process.env,
  });
  sync.testCount = tests.length;
  sync.recordCount = records.length;
  sync.previousRecordCount = previousRecords.length;
  sync.contentHash = hashOcgRuleRecords(records);
  sync.previousContentHash = hashOcgRuleRecords(previousRecords);
  sync.enumeration = docs.map((doc) => ({ docname: doc.docname, sourceUrl: doc.sourceUrl }));
  sync.pages = pageResults.map(({ doc, record, error }) => ({
    docname: doc.docname,
    sourceUrl: doc.sourceUrl,
    status: record ? "fetched" : "failed",
    ...(error ? { error } : {}),
  }));

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
      structure: record.structure,
    })),
  };

  await Promise.all([
    writeJsonAtomic(corpusPath, corpusPayload),
    writeJsonAtomic(testsPath, testsPayload),
  ]);

  console.log(`Synced ${refreshedRecords.length}/${docs.length} OCG rule pages, restored ${fixedRecords.length} fixed sources, and wrote ${tests.length} test pages (${sync.contentHash.slice(0, 12)}).`);
}

/** The manifest is the complete authority for records outside this fetcher's
 * explicit ocg-rule namespace. Removing a manifest entry removes that fixed
 * record on the next successful complete sync.
 */
export function mergeOwnedOcgRuleRecords(refreshedRecords = [], fixedRecords = []) {
  return [...(Array.isArray(refreshedRecords) ? refreshedRecords : []), ...(Array.isArray(fixedRecords) ? fixedRecords : [])];
}

export function assertCompleteOcgRuleFetch({ enumeratedDocs = [], maxPages: limit = maxPages, pageResults } = {}) {
  if (!Array.isArray(enumeratedDocs) || !enumeratedDocs.length) {
    throw new Error("OCG Rule enumeration incomplete: no content targets");
  }
  if (enumeratedDocs.length > limit) {
    throw new Error(`OCG Rule enumeration incomplete: ${enumeratedDocs.length} targets exceed OCG_RULE_MAX_PAGES=${limit}`);
  }
  if (pageResults == null) return;
  const failures = pageResults.filter((item) => !item?.record);
  if (pageResults.length !== enumeratedDocs.length || failures.length) {
    throw new Error(`OCG Rule page fetch incomplete: ${failures.length || enumeratedDocs.length - pageResults.length}/${enumeratedDocs.length} pages failed; previous corpus retained`);
  }
}

export async function loadFixedRuleSources(directory = fixedSourcesDir) {
  const manifestPath = join(directory, "manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.sources)) {
    throw new Error("Invalid fixed rule source manifest");
  }
  const seenIds = new Set();
  const records = [];
  for (const entry of manifest.sources) {
    const sourceId = String(entry?.sourceId || "");
    const file = String(entry?.file || "");
    const expectedSha256 = String(entry?.sha256 || "");
    if (!sourceId || sourceId.startsWith(OWNED_RECORD_PREFIX) || seenIds.has(sourceId)) {
      throw new Error(`Invalid fixed rule sourceId: ${sourceId || "<empty>"}`);
    }
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(file) || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error(`Invalid fixed rule source manifest entry: ${sourceId}`);
    }
    const recordText = await readFile(join(directory, file), "utf8");
    const actualSha256 = createHash("sha256").update(recordText.replace(/\r\n/g, "\n"), "utf8").digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error(`Fixed rule source hash mismatch: ${sourceId}`);
    const record = JSON.parse(recordText);
    if (record?.id !== sourceId || typeof record?.text !== "string" || !record.text || typeof record?.sourceUrl !== "string") {
      throw new Error(`Fixed rule source record binding mismatch: ${sourceId}`);
    }
    seenIds.add(sourceId);
    records.push(record);
  }
  return records;
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
    const parsed = parseOcgRuleHtml(html);
    const rawText = parsed.text;
    const sourcePolicy = applyManualOcgRuleSourcePolicy({ docname: doc.docname, text: rawText });
    const text = sourcePolicy.text;
    const removedRange = findAppliedSourceEditRange(rawText, sourcePolicy);
    const sourceId = `ocg-rule:${doc.docname}`;
    const structure = bindOcgRuleStructure(parsed, text, {
      sourceId,
      sourceUrl: doc.sourceUrl,
      ...(removedRange ? { removedRange } : {}),
    });
    if (text.length < 120) return { doc, error: "page_text_too_short" };
    return { doc, record: {
      id: sourceId,
      recordType: testKeywordPattern.test(`${doc.docname} ${title}`) ? "rule-test" : "rule-doc",
      title,
      docname: doc.docname,
      sourceName: "OCG Rule",
      sourceUrl: doc.sourceUrl,
      sourceRole: sourcePolicy.sourceRole,
      ...(sourcePolicy.sourceEditId ? {
        sourceEditId: sourcePolicy.sourceEditId,
        sourceEditBeforeTextSha256: sourcePolicy.sourceEditBeforeTextSha256,
        sourceEditObservedTextSha256: sourcePolicy.sourceEditObservedTextSha256,
        sourceEditStatus: sourcePolicy.sourceEditStatus,
        ...(sourcePolicy.sourceEditNotAppliedReason ? {
          sourceEditNotAppliedReason: sourcePolicy.sourceEditNotAppliedReason,
        } : {}),
      } : {}),
      keywords: extractKeywords(`${doc.docname} ${title} ${text}`),
      text,
      structure,
      updatedAt: new Date().toISOString(),
    } };
  } catch (error) {
    console.warn(`Skip ${doc.sourceUrl}: ${formatError(error)}`);
    return { doc, error: formatError(error) };
  }
}

function findAppliedSourceEditRange(rawText, sourcePolicy) {
  if (sourcePolicy?.sourceEditStatus !== "applied" || rawText === sourcePolicy.text) return undefined;
  const targetLength = rawText.length - String(sourcePolicy.text || "").length;
  if (targetLength <= 0) throw new Error("Applied OCG Rule source edit is not a single deletion");
  let start = 0;
  const target = String(sourcePolicy.text || "");
  while (start < target.length && rawText[start] === target[start]) start += 1;
  const end = start + targetLength;
  if (`${rawText.slice(0, start)}${rawText.slice(end)}` !== target) {
    throw new Error("Applied OCG Rule source edit cannot be represented as one explicit deletion");
  }
  return { start, end };
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
    sourceRole: String(record.sourceRole || "active-rule"),
    keywords: [...(record.keywords || [])].map(String).sort(),
    text: String(record.text || ""),
  })).sort((left, right) => compareCodeUnits(left.id, right.id));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

// Hash ordering must not depend on the host's ICU data or default locale.
// `localeCompare()` can order Chinese identifiers differently across runtimes.
function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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
