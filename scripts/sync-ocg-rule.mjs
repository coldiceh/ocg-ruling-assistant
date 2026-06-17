import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(rootDir, "data");
const baseUrl = normalizeBaseUrl(process.env.OCG_RULE_BASE_URL || "https://ocg-rule.readthedocs.io/zh-cn/latest/");
const maxPages = Number(process.env.OCG_RULE_MAX_PAGES || 240);
const fetchConcurrency = Number(process.env.OCG_RULE_FETCH_CONCURRENCY || 6);
const userAgent = "ocg-ruling-assistant/0.2 (+https://github.com/coldiceh/ocg-ruling-assistant)";

const testKeywordPattern = /(测试|检定|試験|试题|题目|练习|practice|exam|test|judge)/i;
const usefulDocPattern = /(规则|发动|效果|连锁|无效|处理|伤害|战斗|对象|取对象|破坏|除外|一时|特殊召唤|表示形式|里侧|控制权|检定|测试|试题|题目|rule|chain|effect|damage|battle|target|destroy|banish|judge|test|exam)/i;

async function main() {
  await mkdir(dataDir, { recursive: true });
  const index = await loadSearchIndex();
  const docs = buildDocTargets(index).slice(0, maxPages);
  const pages = await mapLimit(docs, fetchConcurrency, loadRulePage);
  const records = pages.filter(Boolean);
  const tests = records.filter((record) => testKeywordPattern.test(`${record.docname} ${record.title}`));
  const generatedAt = new Date().toISOString();

  await writeJson(join(dataDir, "ocg-rule-corpus.json"), {
    schemaVersion: 1,
    generatedAt,
    source: {
      name: "OCG Rule",
      url: baseUrl,
      role: "规则学习资料与裁判训练资料；回答时只能作为规则依据或测试集，不能伪装为官方数据库裁定。",
    },
    records,
  });

  await writeJson(join(dataDir, "ocg-rule-tests.json"), {
    schemaVersion: 1,
    generatedAt,
    source: {
      name: "OCG Rule tests",
      url: baseUrl,
      role: "裁判训练/往年测试资料，用于回归测试和规则理解检查。",
    },
    records: tests.map((record) => ({
      id: record.id,
      title: record.title,
      docname: record.docname,
      sourceUrl: record.sourceUrl,
      text: record.text,
    })),
  });

  console.log(`Synced ${records.length} OCG rule pages and ${tests.length} test pages.`);
}

async function loadSearchIndex() {
  const script = await fetchText(new URL("searchindex.js", baseUrl).toString());
  const match = script.match(/Search\.setIndex\(([\s\S]+)\)\s*;?\s*$/);
  if (!match) throw new Error("Could not parse ReadTheDocs searchindex.js");
  return JSON.parse(match[1]);
}

function buildDocTargets(index) {
  const docnames = Array.isArray(index.docnames) ? index.docnames : [];
  const titles = Array.isArray(index.titles) ? index.titles : [];
  return docnames
    .map((docname, index) => ({
      docname,
      title: cleanText(titles[index] || docname),
      sourceUrl: new URL(`${docname}.html`, baseUrl).toString(),
    }))
    .filter((doc) => usefulDocPattern.test(`${doc.docname} ${doc.title}`));
}

async function loadRulePage(doc) {
  try {
    const html = await fetchText(doc.sourceUrl);
    const title = extractTitle(html) || doc.title;
    const text = cleanText(stripHtml(extractMainHtml(html)));
    if (text.length < 120) return null;
    return {
      id: `ocg-rule:${doc.docname}`,
      recordType: testKeywordPattern.test(`${doc.docname} ${title}`) ? "rule-test" : "rule-doc",
      title,
      docname: doc.docname,
      sourceName: "OCG Rule",
      sourceUrl: doc.sourceUrl,
      keywords: extractKeywords(`${doc.docname} ${title} ${text}`),
      text,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn(`Skip ${doc.sourceUrl}: ${formatError(error)}`);
    return null;
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

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
