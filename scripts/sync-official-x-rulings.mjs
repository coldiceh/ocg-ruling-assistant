import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = resolve(root, "data", "test", "twitter-ruling-questions.json");
const OFFICIAL_HANDLE = "YuGiOh_OCG_INFO";
const OFFICIAL_ACCOUNT_ID = "618646265";
const OFFICIAL_FAQ_HOST = "www.db.yugioh-card.com";
const OFFICIAL_FAQ_PATH = "/yugiohdb/faq_search.action";
const FULL_ARCHIVE_ENDPOINT = "https://api.x.com/2/tweets/search/all";

export const DEFAULT_FULL_ARCHIVE_QUERY =
  `from:${OFFICIAL_HANDLE} "考えてみよう" url:db.yugioh-card.com/yugiohdb/faq_search.action -is:retweet -is:reply`;

export function parseOfficialFaqId(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.hostname.toLocaleLowerCase() !== OFFICIAL_FAQ_HOST) return null;
    if (url.pathname !== OFFICIAL_FAQ_PATH) return null;
    return /^\d+$/u.test(url.searchParams.get("fid") || "") ? url.searchParams.get("fid") : null;
  } catch {
    return null;
  }
}

export function findOfficialFaqUrl(tweet = {}) {
  const candidates = [];
  for (const item of tweet?.entities?.urls || []) {
    candidates.push(item?.unwound_url, item?.expanded_url, item?.url);
  }
  candidates.push(...String(tweet?.text || "").match(/https?:\/\/[^\s)\]}>]+/gu) || []);
  for (const value of candidates.filter(Boolean)) {
    try {
      const url = new URL(String(value));
      if (
        url.hostname.toLocaleLowerCase() === OFFICIAL_FAQ_HOST
        && url.pathname === OFFICIAL_FAQ_PATH
      ) {
        return url.href;
      }
    } catch {
      // Ignore shortened or malformed URL candidates.
    }
  }
  return null;
}

export function extractQuestionText(value) {
  const source = String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .split(/(?:✅|☑️?|✔️?)?\s*(?:回答|答え)(?:はこちら|はコチラ|をチェック)[^\n]*/u, 1)[0];

  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/https?:\/\/\S+/gu, "").trim())
    .filter(Boolean)
    .filter((line) => !isDecorationLine(line))
    .filter((line) => !isSeriesHeading(line))
    .filter((line) => !/^#\S+(?:\s+#\S+)*$/u.test(line));

  return lines
    .join("\n")
    .replace(/^[「『【]?\s*(?:Ｑ＆Ａ|Q\s*&\s*A)\s*(?:を)?考えてみよう\s*[」』】]?[!！]?/iu, "")
    .trim();
}

export function isOfficialRulingTweet(tweet = {}) {
  const text = String(tweet?.text || "");
  const authorId = String(tweet?.author_id || "");
  return authorId === OFFICIAL_ACCOUNT_ID
    && /(?:Ｑ＆Ａ|Q\s*&\s*A)/iu.test(text)
    && text.includes("考えてみよう")
    && Boolean(findOfficialFaqUrl(tweet));
}

export function normalizeTweet(tweet = {}) {
  if (!isOfficialRulingTweet(tweet)) return null;
  const tweetId = String(tweet.id || "").trim();
  const officialFaqUrl = findOfficialFaqUrl(tweet);
  const officialFaqId = parseOfficialFaqId(officialFaqUrl);
  const question = extractQuestionText(tweet.text);
  if (!tweetId || !question || !officialFaqUrl) return null;

  const xUrl = `https://x.com/${OFFICIAL_HANDLE}/status/${tweetId}`;
  return {
    id: `official-x-${tweetId}`,
    question,
    sourceUrl: xUrl,
    tweetId,
    createdAt: normalizeTimestamp(tweet.created_at),
    xUrl,
    officialFaqId,
    officialFaqUrl,
    officialCardQaIndexUrl: null,
    expectedQaIds: officialFaqId ? [officialFaqId] : [],
    expectedCardNames: [],
    expectedAnswerKeyPoints: [],
    provenanceStatus: "official_x_full_archive_api",
  };
}

export async function fetchOfficialXRulings(options = {}) {
  const token = String(options.token || process.env.X_BEARER_TOKEN || "").trim();
  if (!token) {
    const error = new Error(
      "X_BEARER_TOKEN is required for historical collection. "
      + "Use --use-discovered-sample only when a clearly incomplete public-index sample is acceptable.",
    );
    error.exitCode = 2;
    throw error;
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const query = String(options.query || DEFAULT_FULL_ARCHIVE_QUERY).trim();
  const maxPages = positiveInteger(options.maxPages, Number.POSITIVE_INFINITY);
  const casesByTweetId = new Map();
  const seenTokens = new Set();
  let nextToken = "";
  let pagesFetched = 0;
  let paginationExhausted = false;
  let rawTweetCount = 0;
  let rejectedTweetCount = 0;

  while (pagesFetched < maxPages) {
    const requestUrl = new URL(FULL_ARCHIVE_ENDPOINT);
    requestUrl.searchParams.set("query", query);
    requestUrl.searchParams.set("max_results", "500");
    requestUrl.searchParams.set("tweet.fields", "author_id,created_at,entities");
    if (options.startTime) requestUrl.searchParams.set("start_time", normalizeRequiredTimestamp(options.startTime));
    if (options.endTime) requestUrl.searchParams.set("end_time", normalizeRequiredTimestamp(options.endTime));
    if (nextToken) requestUrl.searchParams.set("next_token", nextToken);

    const response = await fetchImpl(requestUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "ocg-ruling-assistant-official-x-sync/1.0",
      },
    });
    const body = await readResponseJson(response);
    if (!response.ok) {
      const detail = body?.detail || body?.title || body?.errors?.[0]?.message || `HTTP ${response.status}`;
      throw new Error(`X full-archive search failed: ${detail}`);
    }

    pagesFetched += 1;
    const tweets = Array.isArray(body?.data) ? body.data : [];
    rawTweetCount += tweets.length;
    for (const tweet of tweets) {
      const normalized = normalizeTweet(tweet);
      if (!normalized) {
        rejectedTweetCount += 1;
        continue;
      }
      casesByTweetId.set(normalized.tweetId, normalized);
    }

    nextToken = String(body?.meta?.next_token || "");
    if (!nextToken) {
      paginationExhausted = true;
      break;
    }
    if (seenTokens.has(nextToken)) throw new Error("X API returned a repeated pagination token");
    seenTokens.add(nextToken);
  }

  const cases = [...casesByTweetId.values()].sort(compareCases);
  return createCorpus(cases, {
    query,
    pagesFetched,
    paginationExhausted,
    rawTweetCount,
    rejectedTweetCount,
    startTime: options.startTime || null,
    endTime: options.endTime || null,
  });
}

export async function loadDiscoveredSample(path = DEFAULT_OUTPUT) {
  const payload = JSON.parse(await readFile(resolve(path), "utf8"));
  validateCorpus(payload);
  if (payload.coverageLevel !== "discovered_public_sample" || payload.isCompleteCorpus !== false) {
    throw new Error("The fallback corpus must explicitly identify itself as an incomplete discovered_public_sample");
  }
  return payload;
}

function createCorpus(cases, collection) {
  const timestamps = cases.map((item) => item.createdAt).filter(Boolean).sort();
  return {
    schemaVersion: 1,
    fixtureName: "official-x-rulings-full-archive-query-result",
    coverageLevel: "official_x_full_archive_query_result",
    corpusCompleteness: collection.paginationExhausted
      ? "query_pagination_exhausted_not_independently_proven_complete"
      : "partial_query_result",
    isCompleteCorpus: false,
    generatedAt: new Date().toISOString(),
    sourceAccount: {
      handle: OFFICIAL_HANDLE,
      numericId: OFFICIAL_ACCOUNT_ID,
      profileUrl: `https://x.com/${OFFICIAL_HANDLE}`,
      officialAccountDirectoryUrl: "https://www.konami.com/yugioh/",
    },
    knownTweetDateRange: {
      from: timestamps[0] || null,
      to: timestamps.at(-1) || null,
      basis: "Tweets returned by the configured X API v2 full-archive query.",
    },
    collection: {
      endpoint: FULL_ARCHIVE_ENDPOINT,
      ...collection,
      seriesSignature: {
        requiredTextFragments: ["Ｑ＆Ａ or Q&A", "考えてみよう"],
        requiredExpandedUrlHost: OFFICIAL_FAQ_HOST,
        requiredExpandedUrlPath: OFFICIAL_FAQ_PATH,
        requiredAuthorId: OFFICIAL_ACCOUNT_ID,
        emojiAndDecorationAreNotStable: true,
      },
      limitations: [
        "Pagination exhaustion proves only that the configured query returned no next token.",
        "It does not prove that every historical series post used the same wording or an expanded official FAQ URL.",
        "isCompleteCorpus therefore remains false unless completeness is independently audited.",
      ],
    },
    cases,
  };
}

function validateCorpus(payload) {
  if (!payload || !Array.isArray(payload.cases)) throw new Error("corpus must contain a cases array");
  const ids = new Set();
  for (const [index, item] of payload.cases.entries()) {
    const id = String(item?.id || "").trim();
    const question = String(item?.question || "").trim();
    if (!id) throw new Error(`corpus case ${index + 1} has no id`);
    if (!question) throw new Error(`corpus case ${id} has no question`);
    if (ids.has(id)) throw new Error(`duplicate corpus case id: ${id}`);
    ids.add(id);
  }
}

function isDecorationLine(line) {
  const withoutEmoji = line.replace(/\p{Extended_Pictographic}|\uFE0F|\u20E3/gu, "");
  return !/[\p{L}\p{N}ぁ-んァ-ヶ一-龠]/u.test(withoutEmoji)
    || /^[┏┓┗┛━┃═✨⭐★◆◇■□─┌┐└┘╔╗╚╝╭╮╰╯・･\s]+$/u.test(line);
}

function isSeriesHeading(line) {
  return /(?:Ｑ＆Ａ|Q\s*&\s*A).{0,8}考えてみよう/iu.test(line)
    || /^遊戯王(?:OCG)?カードデータベース$/iu.test(line)
    || /^(?:今週|今回)の(?:Ｑ＆Ａ|Q\s*&\s*A)/iu.test(line);
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeRequiredTimestamp(value) {
  const normalized = normalizeTimestamp(value);
  if (!normalized) throw new Error(`invalid ISO timestamp: ${value}`);
  return normalized;
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`expected a positive integer, got: ${value}`);
  return number;
}

function compareCases(left, right) {
  const leftTime = left.createdAt || "";
  const rightTime = right.createdAt || "";
  return leftTime.localeCompare(rightTime) || left.tweetId.localeCompare(right.tweetId);
}

async function readResponseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`X API returned non-JSON content (HTTP ${response.status})`);
  }
}

async function writeJsonAtomic(path, payload) {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temporaryPath, absolutePath);
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--out") options.outputPath = requireValue(argument, value), index += 1;
    else if (argument === "--query") options.query = requireValue(argument, value), index += 1;
    else if (argument === "--start-time") options.startTime = requireValue(argument, value), index += 1;
    else if (argument === "--end-time") options.endTime = requireValue(argument, value), index += 1;
    else if (argument === "--max-pages") options.maxPages = requireValue(argument, value), index += 1;
    else if (argument === "--use-discovered-sample") options.useDiscoveredSample = true;
    else if (argument === "--help") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function requireValue(argument, value) {
  if (!value || String(value).startsWith("--")) throw new Error(`${argument} requires a value`);
  return value;
}

function printUsage() {
  console.log([
    "Usage: node scripts/sync-official-x-rulings.mjs [options]",
    "",
    "Without --use-discovered-sample this command requires X_BEARER_TOKEN and",
    "uses X API v2 full-archive search with complete pagination.",
    "",
    "  --out <path>                   Output JSON (default: data/test/twitter-ruling-questions.json)",
    "  --query <x-query>              Override the documented series query",
    "  --start-time <ISO timestamp>   Restrict the archive query start",
    "  --end-time <ISO timestamp>     Restrict the archive query end",
    "  --max-pages <n>                Stop early and mark the result partial",
    "  --use-discovered-sample        Validate/use the incomplete public-index sample",
    "  --help                         Show this message",
  ].join("\n"));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else if (options.useDiscoveredSample) {
      const sample = await loadDiscoveredSample(DEFAULT_OUTPUT);
      const outputPath = resolve(options.outputPath || DEFAULT_OUTPUT);
      if (outputPath !== DEFAULT_OUTPUT) await writeJsonAtomic(outputPath, sample);
      console.log(JSON.stringify({
        coverageLevel: sample.coverageLevel,
        isCompleteCorpus: sample.isCompleteCorpus,
        caseCount: sample.cases.length,
        outputPath,
      }, null, 2));
    } else {
      const corpus = await fetchOfficialXRulings(options);
      const outputPath = resolve(options.outputPath || DEFAULT_OUTPUT);
      await writeJsonAtomic(outputPath, corpus);
      console.log(JSON.stringify({
        coverageLevel: corpus.coverageLevel,
        isCompleteCorpus: corpus.isCompleteCorpus,
        paginationExhausted: corpus.collection.paginationExhausted,
        caseCount: corpus.cases.length,
        outputPath,
      }, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = Number(error?.exitCode) || 1;
  }
}
