import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultInput = resolve(root, "data", "test", "twitter-ruling-questions.json");
const defaultOutput = resolve(root, "artifacts", "twitter-ruling-batch-report.json");
const defaultConfig = resolve(root, "config.json");

export async function runRulingCorpusBatch(options = {}) {
  const inputPath = resolve(options.inputPath || defaultInput);
  const outputPath = resolve(options.outputPath || defaultOutput);
  const corpus = validateCorpus(JSON.parse(await readFile(inputPath, "utf8")));
  const runners = normalizeRunners(options.runners || ["online", "local"]);
  const endpoint = options.endpoint || await readConfiguredEndpoint();
  const limit = boundedInteger(options.limit, corpus.cases.length, 1, corpus.cases.length);
  const offset = boundedInteger(options.offset, 0, 0, corpus.cases.length);
  const selectedCases = corpus.cases.slice(offset, offset + limit);
  const report = options.resume === false
    ? createReport(corpus, { inputPath, endpoint, runners })
    : await loadOrCreateReport(outputPath, corpus, { inputPath, endpoint, runners });
  const answerers = await buildAnswerers({
    endpoint,
    runners,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    rulingVersion: options.rulingVersion,
    modelTier: options.modelTier,
    env: options.env,
    onlineAnswerer: options.onlineAnswerer,
    localAnswerer: options.localAnswerer,
  });

  for (const corpusCase of selectedCases) {
    const result = findOrCreateCaseResult(report, corpusCase);
    for (const runner of runners) {
      if (options.resume !== false && result.runs?.[runner]?.ok === true) continue;
      const startedAt = Date.now();
      try {
        const answer = await answerers[runner](corpusCase);
        result.runs[runner] = {
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          ok: true,
          answer: summarizeAnswer(answer),
          evaluation: evaluateRulingAnswer(corpusCase, answer),
        };
      } catch (error) {
        result.runs[runner] = {
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          evaluation: { overall: "request_failed" },
        };
      }
      updateCaseComparison(result);
      updateReportSummary(report);
      await persistReport(outputPath, report);
      if (runner === "online" && Number(options.delayMs) > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Number(options.delayMs)));
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  updateReportSummary(report);
  await persistReport(outputPath, report);
  return report;
}

export function evaluateRulingAnswer(corpusCase = {}, answer = {}) {
  const execution = {
    dryRun: answer.debug?.dryRun === true,
    provider: answer.debug?.providerUsed || "",
    model: answer.debug?.modelUsed || "",
  };
  const expectedCardIds = stringList(corpusCase.expectedCardIds || corpusCase.cardIds);
  const expectedCardNames = stringList(corpusCase.expectedCardNames);
  const resolvedCards = Array.isArray(answer.resolvedCards) ? answer.resolvedCards : [];
  const resolvedCardIds = stringList(resolvedCards.map((card) => card?.id || card?.cardId || card?.passcode));
  const resolvedCardNames = stringList(resolvedCards.flatMap(cardIdentityNames));
  const missingCardIds = expectedCardIds.filter((id) => !resolvedCardIds.includes(id));
  const resolvedCardNameKeys = new Set(resolvedCardNames.map(normalizeCardIdentity).filter(Boolean));
  const missingCardNames = expectedCardNames.filter((name) => !resolvedCardNameKeys.has(normalizeCardIdentity(name)));
  const unresolvedMentions = Array.isArray(answer.debug?.unresolvedMentions) ? answer.debug.unresolvedMentions : [];
  const ambiguousMentions = Array.isArray(answer.debug?.ambiguousMentions) ? answer.debug.ambiguousMentions : [];
  const cardResolution = expectedCardIds.length || expectedCardNames.length
    ? {
        status: missingCardIds.length || missingCardNames.length || unresolvedMentions.length || ambiguousMentions.length ? "miss" : "hit",
        expectedCardIds,
        expectedCardNames,
        resolvedCardIds,
        resolvedCardNames,
        missingCardIds,
        missingCardNames,
        unresolvedMentions: unresolvedMentions.map((item) => item?.input || String(item)),
        ambiguousMentions: ambiguousMentions.map((item) => item?.input || String(item)),
      }
    : {
        status: unresolvedMentions.length || ambiguousMentions.length
          ? "unresolved"
          : (resolvedCardIds.length ? "hit_without_gold" : "no_card_detected"),
        expectedCardIds,
        expectedCardNames,
        resolvedCardIds,
        resolvedCardNames,
        missingCardIds,
        missingCardNames,
        unresolvedMentions: unresolvedMentions.map((item) => item?.input || String(item)),
        ambiguousMentions: ambiguousMentions.map((item) => item?.input || String(item)),
      };

  const usedEvidenceIds = extractEvidenceIds(answer.usedEvidence);
  const expectedQaIds = stringList(
    corpusCase.expectedQaIds || corpusCase.expectedQaId || corpusCase.officialFaqId,
  ).map(normalizeQaId);
  const matchedQaIds = expectedQaIds.filter((id) => usedEvidenceIds.includes(id));
  const directCount = Number(answer.debug?.retrievalCounts?.officialQaDirectCandidates || 0);
  const officialQa = expectedQaIds.length
    ? {
        status: matchedQaIds.length === expectedQaIds.length ? "hit" : "miss",
        expectedQaIds,
        matchedQaIds,
        usedEvidenceIds,
        directCandidateCount: directCount,
      }
    : {
        status: directCount > 0 ? "hit_without_gold" : "not_found",
        expectedQaIds,
        matchedQaIds,
        usedEvidenceIds,
        directCandidateCount: directCount,
      };

  const answerText = collectAnswerText(answer);
  const correctness = evaluateCorrectness(corpusCase, answerText, officialQa);
  const hardFailure = cardResolution.status === "miss"
    || officialQa.status === "miss"
    || correctness.status === "fail";
  const needsReview = execution.dryRun
    || correctness.status === "needs_review"
    || cardResolution.status === "unresolved"
    || officialQa.status === "not_found";
  return {
    overall: execution.dryRun ? "dry_run" : (hardFailure ? "fail" : (needsReview ? "needs_review" : "pass")),
    execution,
    cardResolution,
    officialQa,
    correctness,
  };
}

export function buildBatchSummary(cases = []) {
  const runs = {};
  for (const item of cases) {
    for (const [runner, result] of Object.entries(item.runs || {})) {
      const stats = runs[runner] ||= {
        completed: 0,
        requestFailed: 0,
        pass: 0,
        fail: 0,
        needsReview: 0,
        dryRun: 0,
        cardMiss: 0,
        cardUnresolved: 0,
        officialQaHit: 0,
        officialQaMiss: 0,
        officialQaNotFound: 0,
      };
      stats.completed += 1;
      if (!result.ok) stats.requestFailed += 1;
      const evaluation = result.evaluation || {};
      if (evaluation.overall === "pass") stats.pass += 1;
      if (evaluation.overall === "fail") stats.fail += 1;
      if (evaluation.overall === "needs_review") stats.needsReview += 1;
      if (evaluation.overall === "dry_run") stats.dryRun += 1;
      if (evaluation.cardResolution?.status === "miss") stats.cardMiss += 1;
      if (evaluation.cardResolution?.status === "unresolved") stats.cardUnresolved += 1;
      if (/^hit/u.test(evaluation.officialQa?.status || "")) stats.officialQaHit += 1;
      if (evaluation.officialQa?.status === "miss") stats.officialQaMiss += 1;
      if (evaluation.officialQa?.status === "not_found") stats.officialQaNotFound += 1;
    }
  }
  return {
    totalCases: cases.length,
    runs,
    onlineLocalComparable: cases.filter((item) => item.comparison?.status !== "not_available").length,
    onlineLocalDiverged: cases.filter((item) => item.comparison?.status === "diverged").length,
  };
}

function evaluateCorrectness(corpusCase, answerText, officialQa) {
  const mustInclude = stringList(corpusCase.mustInclude);
  const softKeyPoints = stringList(corpusCase.expectedAnswerKeyPoints);
  const mustNotInclude = stringList(corpusCase.mustNotInclude);
  const normalizedAnswerText = normalizeTextMatch(answerText);
  const missingRequired = mustInclude.filter((term) => !normalizedAnswerText.includes(normalizeTextMatch(term)));
  const missingSoftKeyPoints = softKeyPoints.filter((term) => !normalizedAnswerText.includes(normalizeTextMatch(term)));
  const forbiddenPresent = mustNotInclude.filter((term) => normalizedAnswerText.includes(normalizeTextMatch(term)));
  if (missingRequired.length || forbiddenPresent.length) {
    return {
      status: "fail",
      reason: "explicit_expectation_failed",
      missingRequired,
      forbiddenPresent,
    };
  }
  if (mustInclude.length || mustNotInclude.length) {
    return {
      status: "pass",
      reason: "explicit_expectations_satisfied",
      missingRequired,
      forbiddenPresent,
    };
  }
  if (softKeyPoints.length) {
    return missingSoftKeyPoints.length
      ? {
          status: "needs_review",
          reason: "answer_key_points_need_cross_language_or_completeness_review",
          softKeyPoints,
          missingSoftKeyPoints,
        }
      : {
          status: "pass",
          reason: "answer_key_points_satisfied",
          softKeyPoints,
          missingSoftKeyPoints,
        };
  }

  const expectedAnswer = String(corpusCase.expectedAnswer || "").trim();
  const expectedVerdicts = classifyVerdicts(expectedAnswer);
  const actualVerdicts = classifyVerdicts(answerText);
  if (expectedVerdicts.length === 1) {
    const expected = expectedVerdicts[0];
    const opposite = oppositeVerdict(expected);
    if (actualVerdicts.includes(opposite) && !actualVerdicts.includes(expected)) {
      return { status: "fail", reason: "verdict_contradiction", expectedVerdicts, actualVerdicts };
    }
    if (actualVerdicts.includes(expected) && isSimpleExpectedAnswer(expectedAnswer)) {
      return { status: "pass", reason: "simple_verdict_matches", expectedVerdicts, actualVerdicts };
    }
  }

  if (expectedAnswer) {
    return {
      status: "needs_review",
      reason: officialQa.status === "hit" ? "official_qa_grounded_but_completeness_requires_review" : "complex_answer_requires_review",
      expectedVerdicts,
      actualVerdicts,
    };
  }
  return {
    status: "needs_review",
    reason: officialQa.status === "hit_without_gold" ? "direct_qa_found_without_answer_gold" : "answer_gold_missing",
    expectedVerdicts,
    actualVerdicts,
  };
}

function classifyVerdicts(value) {
  const text = String(value || "").normalize("NFKC").toLocaleLowerCase();
  const found = new Set();
  const activationNegative = /発動(?:する事|すること)?(?:は)?できません|不能发动|无法发动|不可以发动/gu;
  const applicationNegative = /適用されません|适用しません|不适用|不会适用|不能适用/gu;
  if (activationNegative.test(text)) found.add("cannot_activate");
  if (applicationNegative.test(text)) found.add("does_not_apply");
  const positiveText = text
    .replace(activationNegative, "")
    .replace(applicationNegative, "");
  if (/発動(?:する事|すること)?(?:が|は)?できます|可以发动|能够发动/u.test(positiveText)) found.add("can_activate");
  if (/適用されます|会适用|可以适用/u.test(positiveText)) found.add("applies");
  return [...found];
}

function oppositeVerdict(value) {
  return {
    cannot_activate: "can_activate",
    can_activate: "cannot_activate",
    does_not_apply: "applies",
    applies: "does_not_apply",
  }[value] || "";
}

function isSimpleExpectedAnswer(value) {
  const text = String(value || "").trim();
  return text.length > 0 && text.length <= 100 && text.split(/\n{2,}/u).filter(Boolean).length <= 1;
}

function updateCaseComparison(result) {
  const online = result.runs?.online;
  const local = result.runs?.local;
  if (!online?.ok || !local?.ok) {
    result.comparison = { status: "not_available" };
    return;
  }
  const differences = [];
  if (online.evaluation?.correctness?.actualVerdicts?.join("|") !== local.evaluation?.correctness?.actualVerdicts?.join("|")) {
    differences.push("verdict");
  }
  if (!equalStringSets(
    online.evaluation?.cardResolution?.resolvedCardIds,
    local.evaluation?.cardResolution?.resolvedCardIds,
  )) {
    differences.push("resolved_cards");
  }
  if (online.evaluation?.officialQa?.status !== local.evaluation?.officialQa?.status) {
    differences.push("official_qa");
  }
  result.comparison = { status: differences.length ? "diverged" : "consistent", differences };
}

function summarizeAnswer(answer = {}) {
  return {
    answerLevel: answer.answerLevel || "",
    shortAnswer: answer.shortAnswer || "",
    reasoning: answer.reasoning || [],
    usedEvidence: answer.usedEvidence || [],
    resolvedCards: (answer.resolvedCards || []).map((card) => ({
      id: String(card?.id || card?.cardId || card?.passcode || ""),
      name: card?.name || card?.cnName || card?.jaName || card?.enName || "",
      input: card?.input || "",
      confidence: card?.confidence,
    })),
    missingInfo: answer.missingInfo || [],
    riskFlags: answer.riskFlags || [],
    confidenceSelfEstimate: answer.confidenceSelfEstimate,
    debug: {
      retrievalCounts: answer.debug?.retrievalCounts || {},
      unresolvedMentions: answer.debug?.unresolvedMentions || [],
      ambiguousMentions: answer.debug?.ambiguousMentions || [],
      retrievalWarnings: answer.debug?.retrievalWarnings || [],
      providerUsed: answer.debug?.providerUsed || "",
      modelUsed: answer.debug?.modelUsed || "",
      dryRun: answer.debug?.dryRun === true,
      timingsMs: answer.debug?.timingsMs || {},
    },
  };
}

async function buildAnswerers(options) {
  const answerers = {};
  if (options.runners.includes("online")) {
    if (!options.endpoint && typeof options.onlineAnswerer !== "function") {
      throw new Error("online endpoint is not configured");
    }
    answerers.online = options.onlineAnswerer || (async (corpusCase) => {
      const fetchImpl = options.fetchImpl || globalThis.fetch;
      const signal = AbortSignal.timeout(boundedInteger(options.timeoutMs, 120000, 5000, 600000));
      const response = await fetchImpl(options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: corpusCase.question,
          mode: "rag",
          ...(options.rulingVersion ? { rulingVersion: options.rulingVersion } : {}),
          ...(options.modelTier ? { modelTier: options.modelTier } : {}),
        }),
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`online_answer_failed:${response.status}:${payload?.error || "unknown"}`);
      return payload;
    });
  }
  if (options.runners.includes("local")) {
    if (typeof options.localAnswerer === "function") {
      answerers.local = options.localAnswerer;
    } else {
      const { answerRagRulingQuestionForVersion } = await import("../backend/rulingVersionRegistry.mjs");
      answerers.local = (corpusCase) => answerRagRulingQuestionForVersion({
        question: corpusCase.question,
        rulingVersion: options.rulingVersion,
        env: options.env || globalThis.process?.env || {},
      });
    }
  }
  return answerers;
}

function validateCorpus(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.cases)) {
    throw new Error("corpus must contain a cases array");
  }
  const seen = new Set();
  const cases = payload.cases.map((item, index) => {
    const question = String(item?.question || "").trim();
    const id = String(item?.id || `case-${index + 1}`).trim();
    if (!question) throw new Error(`corpus case ${id} has no question`);
    if (seen.has(id)) throw new Error(`duplicate corpus case id: ${id}`);
    seen.add(id);
    return { ...item, id, question };
  });
  return { ...payload, cases };
}

function createReport(corpus, metadata) {
  return {
    schemaVersion: 1,
    source: corpus.source || {
      account: corpus.sourceAccount || "",
      collection: corpus.collection || {},
      knownTweetDateRange: corpus.knownTweetDateRange || {},
    },
    corpusCompleteness: corpus.corpusCompleteness
      || corpus.coverageLevel
      || (corpus.isCompleteCorpus === true ? "complete" : "unknown"),
    coverageLevel: corpus.coverageLevel || corpus.corpusCompleteness || "unknown",
    isCompleteCorpus: corpus.isCompleteCorpus === true,
    corpusCaseCount: corpus.cases.length,
    inputPath: metadata.inputPath,
    endpoint: metadata.endpoint || "",
    runners: metadata.runners,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    summary: {},
    cases: [],
  };
}

async function loadOrCreateReport(outputPath, corpus, metadata) {
  try {
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    if (report.inputPath === metadata.inputPath && Number(report.corpusCaseCount) === corpus.cases.length) {
      report.runners = [...new Set([...(report.runners || []), ...metadata.runners])];
      report.endpoint = metadata.endpoint || report.endpoint || "";
      return report;
    }
  } catch {
    // A missing or incompatible report starts a new resumable run.
  }
  return createReport(corpus, metadata);
}

function findOrCreateCaseResult(report, corpusCase) {
  let result = report.cases.find((item) => item.id === corpusCase.id);
  if (!result) {
    result = {
      id: corpusCase.id,
      question: corpusCase.question,
      sourceUrl: corpusCase.sourceUrl || "",
      expectedCardIds: stringList(corpusCase.expectedCardIds || corpusCase.cardIds),
      expectedCardNames: stringList(corpusCase.expectedCardNames),
      expectedQaIds: stringList(corpusCase.expectedQaIds || corpusCase.expectedQaId || corpusCase.officialFaqId),
      expectedAnswerKeyPoints: stringList(corpusCase.expectedAnswerKeyPoints),
      runs: {},
      comparison: { status: "not_available" },
    };
    report.cases.push(result);
  }
  return result;
}

function updateReportSummary(report) {
  report.summary = buildBatchSummary(report.cases);
}

async function persistReport(outputPath, report) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function readConfiguredEndpoint() {
  try {
    const config = JSON.parse((await readFile(defaultConfig, "utf8")).replace(/^\uFEFF/u, ""));
    return String(config.answerApiUrl || "").trim();
  } catch {
    return "";
  }
}

function collectAnswerText(answer) {
  return [
    answer.shortAnswer,
    ...(Array.isArray(answer.reasoning) ? answer.reasoning.map((item) => item?.text || item) : []),
  ].filter(Boolean).join("\n");
}

function extractEvidenceIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => typeof item === "string" ? item : item?.id || item?.evidenceId)
    .filter(Boolean)
    .map(String))];
}

function normalizeQaId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^(?:ygoresources-qa-|card-faq-)/u.test(text)) return text;
  return `ygoresources-qa-${text}`;
}

function cardIdentityNames(card = {}) {
  return [
    card.name,
    card.cnName,
    card.zhName,
    card.jaName,
    card.jpName,
    card.enName,
    card.input,
    ...(Array.isArray(card.aliases) ? card.aliases : []),
  ];
}

function normalizeCardIdentity(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\-－ー・･:："'“”‘’「」『』《》()（）【】\[\]，。；;、？?!！]/gu, "");
}

function normalizeTextMatch(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, "");
}

function normalizeRunners(values) {
  const runners = stringList(values).map((value) => value.toLocaleLowerCase());
  const invalid = runners.filter((value) => !["online", "local"].includes(value));
  if (invalid.length) throw new Error(`unsupported runners: ${invalid.join(", ")}`);
  return runners.length ? [...new Set(runners)] : ["online", "local"];
}

function stringList(value) {
  const values = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function equalStringSets(left, right) {
  const a = stringList(left).sort();
  const b = stringList(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--input") options.inputPath = value, index += 1;
    else if (arg === "--output") options.outputPath = value, index += 1;
    else if (arg === "--endpoint") options.endpoint = value, index += 1;
    else if (arg === "--runner") options.runners = String(value || "").split(","), index += 1;
    else if (arg === "--limit") options.limit = value, index += 1;
    else if (arg === "--offset") options.offset = value, index += 1;
    else if (arg === "--delay-ms") options.delayMs = value, index += 1;
    else if (arg === "--timeout-ms") options.timeoutMs = value, index += 1;
    else if (arg === "--ruling-version") options.rulingVersion = value, index += 1;
    else if (arg === "--model-tier") options.modelTier = value, index += 1;
    else if (arg === "--no-resume") options.resume = false;
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function printUsage() {
  console.log([
    "Usage: node scripts/batch-ruling-corpus.mjs [options]",
    "",
    "  --input <path>          Corpus JSON (default: data/test/twitter-ruling-questions.json)",
    "  --output <path>         Resumable report JSON",
    "  --runner online,local   Run deployed API, local pipeline, or both",
    "  --endpoint <url>        Deployed /api/answer URL (default: config.json)",
    "  --limit <n>             Limit this invocation",
    "  --offset <n>            Skip corpus cases before running",
    "  --delay-ms <n>          Delay after each online request",
    "  --timeout-ms <n>        Per-request timeout",
    "  --ruling-version <id>   latest, previous, or a registered revision",
    "  --model-tier <tier>     flash or pro",
    "  --no-resume             Ignore an existing output report",
  ].join("\n"));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      const report = await runRulingCorpusBatch(options);
      console.log(JSON.stringify(report.summary, null, 2));
      if (Object.values(report.summary.runs || {}).some((item) => item.requestFailed || item.fail)) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
