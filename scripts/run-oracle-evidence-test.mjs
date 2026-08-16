import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { estimateOpenAIModelCost } from "../backend/modelPricing.mjs";
import { requestRelayChatCompletionSse } from "../backend/rulingModelProviders.mjs";
import {
  createManualReviewBundle,
  createPublicReport,
  parseDatasetText,
} from "./evaluate-pure-llm-preview.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_CARDS_PATH = resolve(repositoryRoot, "data/cards.json");
const DEFAULT_QA_PATH = resolve(repositoryRoot, "data/qa-index.json");
const MODEL = "gpt-5.6-sol";
const DEFAULT_REASONING_EFFORT = "low";
const MAX_COMPLETION_TOKENS = 4_096;

export const ORACLE_REASONING_EFFORTS = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

// This is an isolated diagnostic fixture. It is never imported by backend/, api/
// or src/, and it contains no expected answer or per-case reasoning recipe.
export const ORACLE_CASE_SPECS = Object.freeze({
  "case-004": Object.freeze({
    cardIds: Object.freeze(["23380", "22700"]),
    evidenceIds: Object.freeze([]),
    inlineEvidence: Object.freeze([Object.freeze({
      id: "official-qa-24310",
      title: "相手の『キラーチューン B2B』の効果適用中に『ガガガマジシャン－ガガガマジック』を発動できますか？",
      question: "相手フィールドで、相手モンスターのレベルを2つ上げる永続効果が適用中。手札にレベル4の対象モンスター2体がある時、EXデッキが(A)ランク4のみ、(B)ランク6のみ、(C)ランク4と6のみなら、この効果を発動でき、処理はどうなるか。",
      answer: "(A)発動できる。2体を特殊召喚し、その時点で両方がレベル6となってX召喚可能なモンスターがなくなるため、X召喚は行わない。(B)発動できない。(C)発動でき、特殊召喚後に両方がレベル6となり、片方のレベルをもう片方と同じとして扱ってもさらに2上がることはなく、ランク6をX召喚する。",
      sourceUrl: "https://www.db.yugioh-card.com/yugiohdb/faq_search.action?fid=24310&ope=5&request_locale=ja",
      authority: "KONAMI official card database",
    })]),
  }),
  "case-018": Object.freeze({
    cardIds: Object.freeze(["21779", "13631", "22130"]),
    evidenceIds: Object.freeze([
      "card-faq-22130-1",
      "ygoresources-qa-8129",
      "card-faq-4910-0",
    ]),
    inlineEvidence: Object.freeze([]),
  }),
  "case-027": Object.freeze({
    cardIds: Object.freeze(["9154"]),
    evidenceIds: Object.freeze([
      "card-faq-9154-1",
      "ygoresources-qa-13142",
      "ygoresources-qa-13144",
      "card-faq-6707-1",
    ]),
    inlineEvidence: Object.freeze([]),
  }),
  "case-028": Object.freeze({
    cardIds: Object.freeze(["5530", "5980", "5576", "8087", "9139", "10695"]),
    evidenceIds: Object.freeze([
      "card-faq-5530-1",
      "ygoresources-qa-10794",
      "ygoresources-qa-8186",
    ]),
    inlineEvidence: Object.freeze([]),
  }),
});

const SYSTEM_PROMPT = [
  "你是一名OCG裁判。",
  "请只根据用户问题、完整卡片文本和经核实资料独立判断。",
  "按卡文顺序分别核对发动时与每个处理步骤当时的合法性；每次状态变化后重新检查下一步，明确该步不能执行时前序结果是否保留，以及处理在何处结束。",
  "先给明确结论，再给简短、可核验的理由，并引用资料编号。",
  "资料不足时请明确说明，不得虚构官方裁定，也不要输出隐藏思维链。",
].join("\n");

export function buildOracleRequestBody({
  question,
  cardTexts,
  officialEvidence,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
} = {}) {
  const normalizedQuestion = String(question || "").trim();
  if (!normalizedQuestion) throw new TypeError("Oracle case requires a question");
  if (!Array.isArray(cardTexts) || !cardTexts.length) {
    throw new TypeError("Oracle case requires complete card texts");
  }
  if (!Array.isArray(officialEvidence) || !officialEvidence.length) {
    throw new TypeError("Oracle case requires at least one verified source");
  }
  const envelope = {
    question: normalizedQuestion,
    cardTexts: cardTexts.map(projectCardText),
    verifiedMaterials: officialEvidence.map(projectEvidence),
  };
  return {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(envelope, null, 2) },
    ],
    reasoning_effort: validateReasoningEffort(reasoningEffort),
    max_completion_tokens: MAX_COMPLETION_TOKENS,
  };
}

export async function runOracleCases({
  dataset,
  cardRecords,
  qaRecords,
  checkpointDirectory,
  requestImpl,
  caseIds = Object.keys(ORACLE_CASE_SPECS),
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  now = () => new Date(),
  log = console.log,
} = {}) {
  if (!dataset?.datasetDigest || !Array.isArray(dataset.cases)) {
    throw new TypeError("Oracle run requires a parsed private dataset");
  }
  if (typeof requestImpl !== "function") throw new TypeError("Oracle run requires requestImpl");
  const cardById = indexRecords(cardRecords, "card");
  const qaById = indexRecords(qaRecords, "evidence");
  const selectedCaseIds = validateCaseIds(caseIds);
  const normalizedReasoningEffort = validateReasoningEffort(reasoningEffort);
  const selectedCases = selectedCaseIds.map((caseId) => {
    const item = dataset.cases.find((candidate) => candidate.id === caseId);
    if (!item) throw new TypeError(`Private dataset is missing ${caseId}`);
    return item;
  });
  // Resolve every configured card and evidence record before the first paid
  // request. A stale ID must fail the whole preflight, never after earlier
  // cases have already consumed money.
  const preparedCases = selectedCases.map((item) => {
    const spec = ORACLE_CASE_SPECS[item.id];
    return {
      item,
      spec,
      cardTexts: spec.cardIds.map((id) => requireRecord(cardById, id, "card")),
      officialEvidence: [
        ...spec.evidenceIds.map((id) => requireRecord(qaById, id, "evidence")),
        ...spec.inlineEvidence,
      ],
    };
  });
  const generationDirectory = resolve(checkpointDirectory, "generations");
  await mkdir(generationDirectory, { recursive: true });
  const generations = new Map();

  // Intentionally serial: one case, one paid request, no retry or repair call.
  for (const { item, spec, cardTexts, officialEvidence } of preparedCases) {
    const body = buildOracleRequestBody({
      question: item.question,
      cardTexts,
      officialEvidence,
      reasoningEffort: normalizedReasoningEffort,
    });
    const checkpointPath = resolve(generationDirectory, `${item.id}.json`);
    await assertCheckpointAbsent(checkpointPath);
    const submittedAt = now().toISOString();
    const promptSha256 = sha256(JSON.stringify(body.messages));
    await writeJsonAtomically(checkpointPath, {
      schemaVersion: 1,
      caseId: item.id,
      datasetDigest: dataset.datasetDigest,
      status: "submitted",
      submittedAt,
      promptSha256,
      requestedModel: MODEL,
      reasoningEffort: normalizedReasoningEffort,
      requestCount: 1,
    });
    const startedAt = Date.now();
    let generation;
    try {
      const response = await requestImpl(body);
      const candidateResponseText = String(response?.choices?.[0]?.message?.content || "").trim();
      if (!candidateResponseText) throw new Error("Oracle provider returned empty content");
      const returnedModel = String(response?.model || "").trim();
      if (returnedModel && returnedModel !== MODEL) {
        throw new Error(`Oracle provider returned unexpected model ${returnedModel}`);
      }
      const latencyMs = Date.now() - startedAt;
      generation = {
        schemaVersion: 1,
        caseId: item.id,
        datasetDigest: dataset.datasetDigest,
        status: "generated",
        submittedAt,
        completedAt: now().toISOString(),
        latencyMs,
        promptSha256,
        candidateResponseText,
        requestedModel: MODEL,
        returnedModel: returnedModel || null,
        reasoningEffort: normalizedReasoningEffort,
        finishReason: response?.choices?.[0]?.finish_reason || null,
        usage: response?.usage || null,
        streamMetrics: response?.stream_metrics || null,
        estimatedCostUsd: estimateCostUsd(response?.usage),
        requestCount: 1,
        oracleInput: {
          cardIds: spec.cardIds,
          evidenceIds: officialEvidence.map((evidence) => String(evidence.id || "")),
          messages: body.messages,
        },
      };
    } catch (error) {
      generation = {
        schemaVersion: 1,
        caseId: item.id,
        datasetDigest: dataset.datasetDigest,
        status: "generation_failed",
        submittedAt,
        completedAt: now().toISOString(),
        latencyMs: Date.now() - startedAt,
        promptSha256,
        candidateResponseText: "",
        requestedModel: MODEL,
        reasoningEffort: normalizedReasoningEffort,
        failureCode: String(error?.code || "oracle_request_failed"),
        error: String(error?.message || error).slice(0, 1_000),
        requestCount: 1,
        oracleInput: {
          cardIds: spec.cardIds,
          evidenceIds: officialEvidence.map((evidence) => String(evidence.id || "")),
          messages: body.messages,
        },
      };
    }
    await writeJsonAtomically(checkpointPath, generation);
    generations.set(item.id, generation);
    log(JSON.stringify({
      caseId: item.id,
      status: generation.status,
      latencyMs: generation.latencyMs,
      requestCount: 1,
    }));
  }
  return { selectedCases, generations };
}

export async function runOracleCli(argv = process.argv.slice(2), {
  env = process.env,
  requestTransport = requestRelayChatCompletionSse,
  log = console.log,
} = {}) {
  const options = parseCliArguments(argv);
  const apiKey = String(env.RELAY_API_KEY || "").trim();
  if (!apiKey) throw new TypeError("RELAY_API_KEY is required for the Oracle evidence test");
  const dataset = parseDatasetText(await readFile(options.datasetPath, "utf8"));
  const [cardsPayload, qaPayload] = await Promise.all([
    readJson(options.cardsPath),
    readJson(options.qaPath),
  ]);
  const endpoint = resolveRelayEndpoint(env.RELAY_BASE_URL || "https://api.986310.xyz/v1");
  const result = await runOracleCases({
    dataset,
    cardRecords: cardsPayload.records,
    qaRecords: qaPayload.records,
    checkpointDirectory: options.checkpointDirectory,
    caseIds: options.caseIds,
    reasoningEffort: options.reasoningEffort,
    requestImpl: (body) => requestTransport({
      endpoint,
      apiKey,
      body,
      env,
    }),
    log,
  });
  const manualReview = createManualReviewBundle({
    dataset,
    selectedCases: result.selectedCases,
    generations: result.generations,
  });
  await writeJsonAtomically(
    resolve(options.checkpointDirectory, "manual-review.json"),
    manualReview,
  );
  const report = createPublicReport({
    dataset,
    selectedCases: result.selectedCases,
    generations: result.generations,
    mode: "generate_only",
  });
  await writeJsonAtomically(options.reportPath, report);
  log(JSON.stringify(report.summary));
  if (Number(report.summary?.generationFailed || 0) > 0) {
    throw new Error(
      `Oracle evidence test has ${report.summary.generationFailed} incomplete generation(s)`,
    );
  }
  return report;
}

function parseCliArguments(argv) {
  const options = {
    datasetPath: "",
    checkpointDirectory: "",
    reportPath: "",
    cardsPath: DEFAULT_CARDS_PATH,
    qaPath: DEFAULT_QA_PATH,
    caseIds: [],
    reasoningEffort: DEFAULT_REASONING_EFFORT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (["--dataset", "--checkpoint-dir", "--report", "--cards", "--qa", "--include-case", "--reasoning-effort"].includes(argument)) {
      if (!value || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
      index += 1;
      if (argument === "--dataset") options.datasetPath = resolve(value);
      else if (argument === "--checkpoint-dir") options.checkpointDirectory = resolve(value);
      else if (argument === "--report") options.reportPath = resolve(value);
      else if (argument === "--cards") options.cardsPath = resolve(value);
      else if (argument === "--qa") options.qaPath = resolve(value);
      else if (argument === "--include-case") options.caseIds.push(value);
      else if (argument === "--reasoning-effort") options.reasoningEffort = validateReasoningEffort(value);
    } else {
      throw new TypeError(`Unknown Oracle option: ${argument}`);
    }
  }
  for (const [name, value] of [
    ["--dataset", options.datasetPath],
    ["--checkpoint-dir", options.checkpointDirectory],
    ["--report", options.reportPath],
  ]) {
    if (!value) throw new TypeError(`${name} is required`);
  }
  if (!options.caseIds.length) options.caseIds = Object.keys(ORACLE_CASE_SPECS);
  options.caseIds = validateCaseIds(options.caseIds);
  return options;
}

function validateCaseIds(caseIds) {
  if (!Array.isArray(caseIds) || !caseIds.length) {
    throw new TypeError("Oracle test requires at least one case ID");
  }
  const normalized = [...new Set(caseIds.map((item) => String(item || "").trim()))];
  for (const caseId of normalized) {
    if (!Object.hasOwn(ORACLE_CASE_SPECS, caseId)) {
      throw new TypeError(`Unknown Oracle case ID: ${caseId}`);
    }
  }
  return normalized;
}

function validateReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!ORACLE_REASONING_EFFORTS.includes(normalized)) {
    throw new TypeError(`Unsupported Oracle reasoning effort: ${value}`);
  }
  return normalized;
}

function projectCardText(record) {
  const id = String(record?.id || "").trim();
  const name = String(record?.name || record?.cnName || record?.jaName || "").trim();
  const text = String(record?.effectText || record?.text || "").trim();
  if (!id || !name || !text) throw new TypeError("Oracle card text is incomplete");
  return {
    id: `card-${id}`,
    name,
    ...(record?.cnName ? { cnName: String(record.cnName) } : {}),
    ...(record?.jaName ? { jaName: String(record.jaName) } : {}),
    ...(record?.enName ? { enName: String(record.enName) } : {}),
    ...(record?.cardType || record?.type
      ? { cardType: String(record.cardType || record.type) }
      : {}),
    ...(record?.attribute ? { attribute: String(record.attribute) } : {}),
    ...(record?.race ? { race: String(record.race) } : {}),
    ...projectFiniteCardNumber(record, "level"),
    ...projectFiniteCardNumber(record, "rank"),
    ...projectFiniteCardNumber(record, "link"),
    ...projectFiniteCardNumber(record, "atk", "attack"),
    ...projectFiniteCardNumber(record, "def", "defense"),
    text,
    sourceUrl: String(record?.sourceUrl || ""),
  };
}

function projectFiniteCardNumber(record, outputKey, fallbackKey = outputKey) {
  const raw = record?.[outputKey] ?? record?.[fallbackKey];
  if (raw === null || raw === undefined || raw === "") return {};
  const value = Number(raw);
  return Number.isFinite(value) ? { [outputKey]: value } : {};
}

function projectEvidence(record) {
  const id = String(record?.id || "").trim();
  const title = String(record?.title || "").trim();
  const question = String(record?.rawDetailedQuestion || record?.question || "").trim();
  const answer = String(record?.answer || "").trim();
  const text = String(record?.text || "").trim();
  if (!id || !(answer || text)) throw new TypeError("Oracle evidence is incomplete");
  return {
    id,
    ...(title ? { title } : {}),
    ...(question ? { question } : {}),
    ...(answer ? { answer } : { text }),
    sourceUrl: String(record?.sourceUrl || ""),
    authority: String(record?.authority || "official database mirror"),
  };
}

function indexRecords(records, label) {
  if (!Array.isArray(records)) throw new TypeError(`Oracle ${label} records must be an array`);
  return new Map(records.map((record) => [String(record?.id || ""), record]));
}

function requireRecord(index, id, label) {
  const record = index.get(String(id));
  if (!record) throw new TypeError(`Oracle ${label} record is missing: ${id}`);
  return record;
}

async function assertCheckpointAbsent(path) {
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Oracle checkpoint already exists; refusing to resend: ${path}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function resolveRelayEndpoint(baseUrl) {
  const url = new URL(String(baseUrl || "").trim());
  if (url.protocol !== "https:") throw new TypeError("Oracle Relay endpoint must use HTTPS");
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function estimateCostUsd(usage) {
  if (!usage) return null;
  try {
    return Number(estimateOpenAIModelCost({
      model: MODEL,
      usage,
      reasoningMode: "standard",
      inputBillingBasis: "all_uncached",
    }).totalCostUsd);
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runOracleCli().catch((error) => {
    console.error(String(error?.stack || error));
    process.exitCode = 1;
  });
}
