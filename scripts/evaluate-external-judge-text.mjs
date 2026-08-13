import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  buildBatchSummary,
  runRulingCorpusBatch,
} from "./batch-ruling-corpus.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMANTIC_RATINGS = new Set([
  "correct",
  "partially_correct",
  "incorrect",
  "uncertain",
]);
const SEMANTIC_JUDGE_PROMPT_VERSION = "external-semantic-judge-v1";

export function parseExternalJudgeText(rawText) {
  const normalizedText = String(rawText || "")
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n");
  const { blocks, sourceFormat } = splitExternalJudgeBlocks(normalizedText);
  const cases = [];
  const seenQuestions = new Map();
  let duplicateQuestionCount = 0;

  for (const [index, block] of blocks.entries()) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) {
      throw new Error(`external judge block ${index + 1} must contain a question and a reference answer`);
    }

    const { question, referenceAnswer, parseStrategy } = splitQuestionAndReference(lines);
    if (!question || !referenceAnswer) {
      throw new Error(`external judge block ${index + 1} has an empty question or reference answer`);
    }
    const identity = normalizeQuestionIdentity(question);
    const referenceIdentity = normalizeReferenceIdentity(referenceAnswer);
    const duplicate = seenQuestions.get(identity);
    if (duplicate) {
      if (duplicate.referenceIdentity !== referenceIdentity) {
        throw new Error(
          `external judge blocks ${duplicate.blockNumber} and ${index + 1} repeat the same question with conflicting reference answers`,
        );
      }
      duplicateQuestionCount += 1;
      continue;
    }
    seenQuestions.set(identity, {
      blockNumber: index + 1,
      referenceIdentity,
    });
    cases.push({
      id: stableExternalCaseId(identity),
      question,
      referenceAnswer,
      parseStrategy,
    });
  }

  if (!cases.length) throw new Error("external judge text has no usable cases");
  const questionSetSha256 = hashQuestionSet(cases);
  return {
    schemaVersion: 1,
    fixtureName: "external-local-judge-text",
    purpose: "Ephemeral local evaluation; reference answers are judge-only.",
    source: {
      kind: "external_local_text",
      includedInRepository: false,
    },
    modelInputContract: {
      allowedCaseFields: ["question"],
      forbiddenCaseFields: ["answer", "referenceAnswer", "expectedAnswer"],
      referenceAnswerUsage: "judge_only",
      mustNotIncludeReferenceAnswerInModelInput: true,
    },
    inputBlockCount: blocks.length,
    duplicateQuestionCount,
    questionSetSha256,
    sourceFormat,
    cases,
  };
}

export async function runExternalJudgeTextEvaluation(options = {}) {
  const inputPath = resolveRequiredExternalPath(options.inputPath, "input");
  const outputPath = resolveRequiredExternalPath(
    options.outputPath || defaultOutputPath(inputPath),
    "output",
  );
  if (outputPath === inputPath) {
    throw new Error("output path must not overwrite the external judge input");
  }
  const corpus = parseExternalJudgeText(await readFile(inputPath, "utf8"));
  const checkpointPath = resolveRequiredExternalPath(
    options.checkpointPath || defaultCheckpointPath(outputPath),
    "checkpoint",
  );
  if (checkpointPath === inputPath || checkpointPath === outputPath) {
    throw new Error("checkpoint path must differ from the input and output paths");
  }
  const runOptions = {
    ...options,
    endpoint: options.endpoint || await readDefaultAnswerEndpoint(),
  };
  const judgeRuntime = resolveSemanticJudgeRuntime(runOptions);
  runOptions.judgeConfiguration = judgeRuntime.configuration;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ocg-external-judge-"));
  const temporaryCorpusPath = join(temporaryRoot, "corpus.json");
  const temporaryReportPath = join(temporaryRoot, "batch-report.json");
  const batchCorpus = {
    schemaVersion: corpus.schemaVersion,
    fixtureName: corpus.fixtureName,
    purpose: "Ephemeral answer generation; contains questions only.",
    source: corpus.source,
    cases: corpus.cases.map((item) => ({
      id: item.id,
      question: item.question,
    })),
  };

  try {
    const resume = runOptions.resume !== false;
    const checkpoint = resume
      ? await loadExternalCheckpoint(checkpointPath, corpus, runOptions)
      : createExternalCheckpoint(corpus, runOptions);
    if (resume && checkpoint.cases.length) {
      await writeTemporaryBatchReport(
        temporaryReportPath,
        temporaryCorpusPath,
        checkpoint,
        corpus,
        runOptions,
      );
    }
    await writeFile(temporaryCorpusPath, `${JSON.stringify(batchCorpus, null, 2)}\n`, "utf8");
    const {
      inputPath: _discardedInput,
      outputPath: _discardedOutput,
      checkpointPath: _discardedCheckpoint,
      redact: _discardedRedact,
      modelProfile: _discardedModelProfile,
      resume: _discardedResume,
      offset: _discardedOffset,
      limit: _discardedLimit,
      delayMs: _discardedDelay,
      judgeProvider: _discardedJudgeProvider,
      judgeEndpoint: _discardedJudgeEndpoint,
      judgeModel: _discardedJudgeModel,
      judgeReasoningEffort: _discardedJudgeReasoningEffort,
      judgeApiKey: _discardedJudgeApiKey,
      judgeEnv: _discardedJudgeEnv,
      judgeFetchImpl: _discardedJudgeFetchImpl,
      judgeConfiguration: _discardedJudgeConfiguration,
      ...batchOptions
    } = runOptions;
    delete batchOptions.fetchImpl;
    const selectedIndexes = selectedCaseIndexes(corpus.cases.length, runOptions);
    let fullReport = checkpoint.cases.length
      ? await readFullReportOrCreateEmpty(
          temporaryReportPath,
          checkpoint,
          corpus,
          runOptions,
        )
      : null;
    if (judgeRuntime.configuration.enabled && fullReport) {
      for (const caseIndex of selectedIndexes) {
        await judgeCaseRuns({ caseIndex, corpus, fullReport, judgeRuntime });
      }
      await persistExternalCheckpoint(checkpointPath, createExternalCheckpoint(
        corpus,
        runOptions,
        fullReport,
      ));
      await writeFile(temporaryReportPath, `${JSON.stringify(fullReport, null, 2)}\n`, "utf8");
      await persistExternalPublicReport(outputPath, fullReport, corpus);
    }
    for (const [selectionIndex, caseIndex] of selectedIndexes.entries()) {
      const existingRunCount = countSuccessfulRunsForCase(checkpoint, corpus.cases[caseIndex]?.id);
      fullReport = await runRulingCorpusBatch({
        ...batchOptions,
        inputPath: temporaryCorpusPath,
        outputPath: temporaryReportPath,
        offset: caseIndex,
        limit: 1,
        resume: selectionIndex > 0 || (resume && checkpoint.cases.length > 0),
        fetchImpl: createProfileSelectingFetchImpl(runOptions),
      });
      // Persist the private candidate before making the independent judge call.
      // If the judge transport fails, resume can retry judging without paying to
      // generate the answer a second time.
      await persistExternalCheckpoint(checkpointPath, createExternalCheckpoint(
        corpus,
        runOptions,
        fullReport,
      ));
      if (judgeRuntime.configuration.enabled) {
        await judgeCaseRuns({
          caseIndex,
          corpus,
          fullReport,
          judgeRuntime,
        });
        await persistExternalCheckpoint(checkpointPath, createExternalCheckpoint(
          corpus,
          runOptions,
          fullReport,
        ));
        await writeFile(temporaryReportPath, `${JSON.stringify(fullReport, null, 2)}\n`, "utf8");
      }
      await persistExternalPublicReport(outputPath, fullReport, corpus);
      const updatedRunCount = countSuccessfulRunsForCase(
        createExternalCheckpoint(corpus, runOptions, fullReport),
        corpus.cases[caseIndex]?.id,
      );
      if (Number(runOptions.delayMs) > 0 && updatedRunCount > existingRunCount) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Number(runOptions.delayMs)));
      }
    }
    if (!selectedIndexes.length && !checkpoint.cases.length) {
      await persistExternalCheckpoint(checkpointPath, checkpoint);
    }
    if (!fullReport) {
      fullReport = await readFullReportOrCreateEmpty(
        temporaryReportPath,
        checkpoint,
        corpus,
        runOptions,
      );
    }
    fullReport.externalModelConfiguration = normalizeExternalModelConfiguration(
      runOptions,
      fullReport.modelConfiguration,
    );
    const redact = options.redact !== false;
    const report = redact
      ? redactExternalJudgeReport(fullReport, corpus)
      : {
          ...fullReport,
          inputPath,
          inputBlockCount: corpus.inputBlockCount,
          duplicateQuestionCount: corpus.duplicateQuestionCount,
          questionSetSha256: corpus.questionSetSha256,
          sourceFormat: corpus.sourceFormat,
          privacy: {
            redacted: false,
            questionsIncluded: true,
            referenceAnswersIncluded: false,
            generatedAnswersIncluded: true,
          },
        };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function createExternalCheckpoint(corpus, options = {}, fullReport = {}) {
  const casesById = new Map((corpus.cases || []).map((item) => [String(item.id), item]));
  return {
    schemaVersion: 2,
    checkpointKind: "external_judge_private_evaluation",
    privacy: {
      private: true,
      publishable: false,
      questionsIncluded: false,
      referenceAnswersIncluded: false,
      generatedAnswersIncluded: true,
      externalPathsIncluded: false,
    },
    questionSetSha256: corpus.questionSetSha256,
    corpusCaseCount: corpus.cases.length,
    endpointIdentity: hashOpaqueValue(options.endpoint || ""),
    rulingVersion: String(options.rulingVersion || fullReport.rulingVersion || ""),
    modelConfiguration: normalizeExternalModelConfiguration(options, fullReport.modelConfiguration),
    judgeConfiguration: options.judgeConfiguration || disabledJudgeConfiguration(),
    runners: Array.isArray(fullReport.runners) ? fullReport.runners : parseRunners(options.runners),
    startedAt: fullReport.startedAt || new Date().toISOString(),
    finishedAt: fullReport.finishedAt || null,
    cases: (fullReport.cases || []).map((item) => {
      const corpusCase = casesById.get(String(item.id || ""));
      return {
        id: String(item.id || ""),
        questionSha256: hashOpaqueValue(corpusCase?.question || ""),
        referenceAnswerSha256: hashOpaqueValue(corpusCase?.referenceAnswer || ""),
        runs: Object.fromEntries(Object.entries(item.runs || {}).map(([runner, result]) => [
          runner,
          privateCheckpointRun(result),
        ])),
        comparison: item.comparison || { status: "not_available" },
      };
    }),
  };
}

function privateCheckpointRun(result = {}) {
  const candidateAnswer = collectCandidateAnswer(result.answer);
  return {
    completedAt: result.completedAt || null,
    latencyMs: Number(result.latencyMs || 0),
    ok: result.ok === true,
    ...(!result.ok ? { error: "request_failed" } : {}),
    ...(result.ok ? {
      answer: result.answer || {},
      evaluation: result.evaluation || {},
      candidateAnswer,
      candidateAnswerSha256: hashOpaqueValue(candidateAnswer),
    } : {}),
    ...(result.semanticReview ? { semanticReview: result.semanticReview } : {}),
  };
}

async function loadExternalCheckpoint(checkpointPath, corpus, options) {
  let checkpoint;
  try {
    checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return createExternalCheckpoint(corpus, options);
    throw new Error(`external judge checkpoint is unreadable or invalid: ${error?.message || error}`);
  }
  const expected = createExternalCheckpoint(corpus, options);
  const compatible = checkpoint?.checkpointKind === expected.checkpointKind
    && checkpoint?.questionSetSha256 === expected.questionSetSha256
    && Number(checkpoint?.corpusCaseCount) === expected.corpusCaseCount
    && checkpoint?.endpointIdentity === expected.endpointIdentity
    && String(checkpoint?.rulingVersion || "") === expected.rulingVersion
    && JSON.stringify(checkpoint?.modelConfiguration || {}) === JSON.stringify(expected.modelConfiguration)
    && JSON.stringify(checkpoint?.judgeConfiguration || {}) === JSON.stringify(expected.judgeConfiguration);
  if (!compatible) {
    throw new Error("external judge checkpoint does not match the question set or run configuration; use --no-resume or a different checkpoint path");
  }
  return checkpoint;
}

async function writeTemporaryBatchReport(path, inputPath, checkpoint, corpus, options) {
  const report = {
    schemaVersion: 1,
    source: corpus.source,
    corpusCaseCount: corpus.cases.length,
    inputPath,
    endpoint: options.endpoint || "",
    rulingVersion: checkpoint.rulingVersion,
    runners: checkpoint.runners,
    modelConfiguration: normalizeBatchModelConfiguration(options),
    startedAt: checkpoint.startedAt,
    finishedAt: checkpoint.finishedAt,
    summary: buildBatchSummary(checkpoint.cases),
    cases: restorePrivateCheckpointCases(checkpoint, corpus),
  };
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function restorePrivateCheckpointCases(checkpoint, corpus) {
  const casesById = new Map((corpus.cases || []).map((item) => [String(item.id), item]));
  return (checkpoint.cases || []).map((item) => ({
    id: String(item.id || ""),
    question: String(casesById.get(String(item.id || ""))?.question || ""),
    runs: Object.fromEntries(Object.entries(item.runs || {}).map(([runner, run]) => [
      runner,
      {
        completedAt: run.completedAt || null,
        latencyMs: Number(run.latencyMs || 0),
        ok: run.ok === true,
        ...(!run.ok ? { error: "request_failed" } : {}),
        ...(run.ok ? {
          answer: run.answer || {},
          evaluation: run.evaluation || {},
        } : {}),
        ...(run.semanticReview ? { semanticReview: run.semanticReview } : {}),
      },
    ])),
    comparison: item.comparison || { status: "not_available" },
  }));
}

async function persistExternalCheckpoint(path, checkpoint) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

async function persistExternalPublicReport(path, fullReport, corpus) {
  const report = redactExternalJudgeReport(fullReport, corpus);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function selectedCaseIndexes(caseCount, options = {}) {
  const offset = boundedNonNegativeInteger(options.offset, 0, caseCount);
  const available = Math.max(0, caseCount - offset);
  const limit = boundedNonNegativeInteger(options.limit, available, available);
  return Array.from({ length: Math.min(limit, available) }, (_, index) => offset + index);
}

function boundedNonNegativeInteger(value, fallback, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error("offset and limit must be non-negative integers");
  }
  return Math.min(number, maximum);
}

function countSuccessfulRunsForCase(checkpoint, caseId) {
  const item = (checkpoint?.cases || []).find((entry) => entry.id === caseId);
  return Object.values(item?.runs || {}).filter((run) => run?.ok === true).length;
}

function createProfileSelectingFetchImpl(options = {}) {
  if (!options.modelProfile && !options.fetchImpl) return undefined;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  return (url, requestOptions = {}) => {
    if (!options.modelProfile || typeof requestOptions.body !== "string") {
      return fetchImpl(url, requestOptions);
    }
    const payload = JSON.parse(requestOptions.body);
    return fetchImpl(url, {
      ...requestOptions,
      body: JSON.stringify({
        ...payload,
        rulingModelProfile: String(options.modelProfile),
      }),
    });
  };
}

function resolveSemanticJudgeRuntime(options = {}) {
  const env = options.judgeEnv || globalThis.process?.env || {};
  const explicit = Boolean(
    options.judgeEndpoint
    || options.judgeApiKey
    || options.judgeModel
    || options.judgeProvider,
  );
  const partiallyExplicit = Boolean(
    options.judgeEndpoint
    || options.judgeApiKey
    || options.judgeProvider,
  );
  const provider = String(options.judgeProvider || "relay").trim().toLowerCase();
  if (!explicit) {
    return { configuration: disabledJudgeConfiguration(), invoke: null };
  }
  if (partiallyExplicit && !options.judgeModel) {
    throw new Error("semantic judge requires --judge-model when judge configuration is provided");
  }
  if (provider !== "relay") {
    throw new Error("semantic judge provider must be relay");
  }
  const endpoint = semanticJudgeChatCompletionsUrl(
    options.judgeEndpoint || env.RELAY_BASE_URL,
  );
  const apiKey = String(options.judgeApiKey || env.RELAY_API_KEY || "").trim();
  const model = String(options.judgeModel || "").trim();
  if (!apiKey) throw new Error("semantic judge requires an explicit key or RELAY_API_KEY");
  if (!model) throw new Error("semantic judge requires --judge-model");
  const reasoningEffort = String(options.judgeReasoningEffort || "low").trim().toLowerCase();
  if (!/^(?:none|low|medium|high|xhigh|max)$/u.test(reasoningEffort)) {
    throw new Error(`unsupported semantic judge reasoning effort: ${reasoningEffort}`);
  }
  const fetchImpl = options.judgeFetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("semantic judge fetch is unavailable");
  const configuration = {
    enabled: true,
    provider,
    endpointIdentity: hashOpaqueValue(endpoint),
    model,
    reasoningEffort,
    promptVersion: SEMANTIC_JUDGE_PROMPT_VERSION,
  };
  return {
    configuration,
    invoke: (input) => invokeSemanticJudge({
      ...input,
      endpoint,
      apiKey,
      model,
      reasoningEffort,
      fetchImpl,
      timeoutMs: options.timeoutMs,
    }),
  };
}

function disabledJudgeConfiguration() {
  return {
    enabled: false,
    promptVersion: SEMANTIC_JUDGE_PROMPT_VERSION,
  };
}

function semanticJudgeChatCompletionsUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("semantic judge endpoint must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("semantic judge endpoint must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("semantic judge endpoint must not contain credentials, query parameters or fragments");
  }
  const base = parsed.toString().replace(/\/$/u, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

async function judgeCaseRuns({ caseIndex, corpus, fullReport, judgeRuntime }) {
  const corpusCase = corpus.cases[caseIndex];
  const reportCase = (fullReport.cases || []).find((item) => item.id === corpusCase?.id);
  if (!corpusCase || !reportCase) return;
  for (const [runner, result] of Object.entries(reportCase.runs || {})) {
    if (!result?.ok) continue;
    const candidateAnswer = collectCandidateAnswer(result.answer);
    const binding = semanticReviewBinding(corpusCase, candidateAnswer, judgeRuntime.configuration);
    if (!result.semanticReview?.error
        && sameSemanticReviewBinding(result.semanticReview?.binding, binding)
        && SEMANTIC_RATINGS.has(result.semanticReview?.rating)) {
      continue;
    }
    const startedAt = Date.now();
    try {
      const assessment = await judgeRuntime.invoke({
        question: corpusCase.question,
        referenceAnswer: corpusCase.referenceAnswer,
        candidateAnswer,
      });
      result.semanticReview = {
        ...assessment,
        reviewer: judgeRuntime.configuration,
        binding,
        runner,
        latencyMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch {
      result.semanticReview = {
        rating: "uncertain",
        rationale: "independent judge request failed",
        reviewer: judgeRuntime.configuration,
        binding,
        runner,
        latencyMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
        error: "judge_request_failed",
      };
    }
  }
}

function collectCandidateAnswer(answer = {}) {
  return [
    String(answer.shortAnswer || "").trim(),
    ...(Array.isArray(answer.reasoning)
      ? answer.reasoning.map((item) => String(item?.text || item || "").trim())
      : []),
  ].filter(Boolean).join("\n");
}

function semanticReviewBinding(corpusCase, candidateAnswer, configuration) {
  return {
    questionSha256: hashOpaqueValue(corpusCase.question),
    referenceAnswerSha256: hashOpaqueValue(corpusCase.referenceAnswer),
    candidateAnswerSha256: hashOpaqueValue(candidateAnswer),
    judgeConfigurationSha256: hashOpaqueValue(JSON.stringify(configuration)),
  };
}

function sameSemanticReviewBinding(left, right) {
  return left && Object.keys(right).every((key) => left[key] === right[key]);
}

async function invokeSemanticJudge({
  question,
  referenceAnswer,
  candidateAnswer,
  endpoint,
  apiKey,
  model,
  reasoningEffort,
  fetchImpl,
  timeoutMs,
}) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: [
            "You are an independent semantic evaluator, not the answering assistant.",
            "Treat the supplied referee reference as correct ground truth; do not question or override it.",
            "Compare the candidate with that reference for the entire question.",
            "Judge meaning, polarity, conditions, and material reasoning; do not require identical wording.",
            "Do not introduce card-specific rules or use outside knowledge to override the reference.",
            "Return JSON only: {\"rating\":\"correct|partially_correct|incorrect|uncertain\",\"rationale\":\"concise explanation\"}.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({ question, referenceAnswer, candidateAnswer }),
        },
      ],
      response_format: { type: "json_object" },
      ...(reasoningEffort !== "none" ? { reasoning_effort: reasoningEffort } : {}),
    }),
    signal: AbortSignal.timeout(boundedNonNegativeInteger(timeoutMs, 120000, 600000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`semantic_judge_failed:${response.status}`);
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = typeof content === "string" ? JSON.parse(content) : content;
  const rating = String(parsed?.rating || "").trim().toLowerCase();
  const rationale = String(parsed?.rationale || "").trim();
  if (!SEMANTIC_RATINGS.has(rating) || !rationale) {
    throw new Error("semantic judge returned an invalid assessment");
  }
  return { rating, rationale };
}

async function readFullReportOrCreateEmpty(path, checkpoint, corpus, options) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {
      schemaVersion: 1,
      source: corpus.source,
      corpusCaseCount: corpus.cases.length,
      inputPath: "",
      endpoint: options.endpoint || "",
      rulingVersion: checkpoint.rulingVersion,
      runners: checkpoint.runners,
      modelConfiguration: normalizeBatchModelConfiguration(options),
      startedAt: checkpoint.startedAt,
      finishedAt: checkpoint.finishedAt,
      summary: buildBatchSummary(restorePrivateCheckpointCases(checkpoint, corpus)),
      cases: restorePrivateCheckpointCases(checkpoint, corpus),
    };
  }
}

function normalizeBatchModelConfiguration(options = {}) {
  return {
    ...(options.modelTier ? { modelTier: String(options.modelTier) } : {}),
    ...(options.thinkingMode ? { thinkingMode: String(options.thinkingMode) } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: String(options.reasoningEffort) } : {}),
  };
}

function splitExternalJudgeBlocks(normalizedText) {
  const text = normalizedText.trim();
  if (!text) return { blocks: [], sourceFormat: "legacy_blank_lines" };
  if (/^[\t ]*::case[\t ]*$/imu.test(text)) {
    const blocks = text
      .split(/^[\t ]*::case[\t ]*$/gimu)
      .map((block) => block.replace(/^[\t ]*::end[\t ]*$/gimu, "").trim())
      .filter(Boolean);
    return { blocks, sourceFormat: "explicit_case_markers" };
  }
  return {
    blocks: text
      .split(/\n[\t ]*\n+/u)
      .map((block) => block.trim())
      .filter(Boolean),
    sourceFormat: "legacy_blank_lines",
  };
}

function splitQuestionAndReference(lines) {
  const questionMarkerIndex = lines.findIndex(isQuestionMarker);
  const referenceMarkerIndex = lines.findIndex(isReferenceMarker);
  if (referenceMarkerIndex >= 0) {
    if (questionMarkerIndex > referenceMarkerIndex) {
      throw new Error("question marker must precede the reference-answer marker");
    }
    return {
      question: lines.slice(questionMarkerIndex >= 0 ? questionMarkerIndex + 1 : 0, referenceMarkerIndex).join("\n").trim(),
      referenceAnswer: lines.slice(referenceMarkerIndex + 1).join("\n").trim(),
      parseStrategy: questionMarkerIndex >= 0 ? "explicit_markers" : "reference_marker",
    };
  }
  if (questionMarkerIndex >= 0) {
    throw new Error("explicit question marker requires a reference-answer marker");
  }

  const questionBoundaryIndex = findLegacyQuestionBoundary(lines);
  if (questionBoundaryIndex >= 0) {
    return {
      question: lines.slice(0, questionBoundaryIndex + 1).join("\n").trim(),
      referenceAnswer: lines.slice(questionBoundaryIndex + 1).join("\n").trim(),
      parseStrategy: "legacy_question_boundary",
    };
  }
  return {
    question: lines.slice(0, -1).join("\n").trim(),
    referenceAnswer: lines.at(-1).trim(),
    parseStrategy: "legacy_last_line",
  };
}

function isQuestionMarker(line) {
  return /^[\t ]*::(?:question|问题|题目)[\t ]*$/iu.test(line);
}

function isReferenceMarker(line) {
  return /^(?:(?:#{1,6}\s*)?(?:answer|reference[_ -]?answer|referenceAnswer|答案|参考答案|裁判答案)\s*[:：]?|::(?:answer|reference[_-]?answer|参考答案|裁判答案))[\t ]*$/iu.test(line);
}

function findLegacyQuestionBoundary(lines) {
  const strongBoundaries = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (hasTerminalQuestionSignal(lines[index])) strongBoundaries.push(index);
  }
  if (strongBoundaries.length) return strongBoundaries.at(-1);

  for (let index = lines.length - 2; index >= 0; index -= 1) {
    if (hasLexicalQuestionSignal(lines[index])) return index;
  }
  return -1;
}

function normalizedBoundaryLine(line) {
  return String(line || "")
    .normalize("NFKC")
    .trim()
    .replace(/[」』》】）)\]"'”’]+$/gu, "")
    .trim();
}

function hasTerminalQuestionSignal(line) {
  const text = normalizedBoundaryLine(line);
  return /[?？]$/u.test(text)
    || /(?:吗|么|呢|可否|与否)(?:[。.!！])?$/u.test(text);
}

function hasLexicalQuestionSignal(line) {
  const text = normalizedBoundaryLine(line);
  return /(?:请问|能否|是否|为什么|为何|怎么|如何|多少|哪(?:个|些|种)?|何时|哪里|有没有|是不是|还是)/u.test(text);
}

export function redactExternalJudgeReport(report = {}, corpus = {}) {
  const parseStrategies = new Map(
    (corpus.cases || []).map((item) => [String(item.id || ""), String(item.parseStrategy || "")]),
  );
  return {
    schemaVersion: report.schemaVersion || 1,
    reportKind: "external_judge_evaluation",
    source: {
      kind: "external_local_text",
      includedInRepository: false,
    },
    privacy: {
      redacted: true,
      questionsIncluded: false,
      referenceAnswersIncluded: false,
      generatedAnswersIncluded: false,
      externalPathsIncluded: false,
    },
    corpusCaseCount: report.corpusCaseCount || corpus.cases?.length || 0,
    inputBlockCount: corpus.inputBlockCount || 0,
    duplicateQuestionCount: corpus.duplicateQuestionCount || 0,
    questionSetSha256: corpus.questionSetSha256 || "",
    sourceFormat: corpus.sourceFormat || "unknown",
    rulingVersion: String(report.rulingVersion || ""),
    runners: Array.isArray(report.runners) ? report.runners : [],
    modelConfiguration: report.externalModelConfiguration || report.modelConfiguration || {},
    startedAt: report.startedAt || null,
    finishedAt: report.finishedAt || null,
    summary: redactExternalSummary(report.summary, report.cases),
    cases: (report.cases || []).map((item) => redactCaseResult(
      item,
      parseStrategies.get(String(item.id || "")),
    )),
  };
}

function redactExternalSummary(summary = {}, cases = []) {
  const semanticByRunner = collectSemanticSummary(cases);
  const runs = Object.fromEntries(Object.entries(summary.runs || {}).map(([runner, stats]) => [
    runner,
    {
      completed: Number(stats?.completed || 0),
      requestFailed: Number(stats?.requestFailed || 0),
      dryRun: Number(stats?.dryRun || 0),
      cardMiss: Number(stats?.cardMiss || 0),
      cardUnresolved: Number(stats?.cardUnresolved || 0),
      officialQaHit: Number(stats?.officialQaHit || 0),
      officialQaMiss: Number(stats?.officialQaMiss || 0),
      officialQaNotFound: Number(stats?.officialQaNotFound || 0),
      semanticReview: semanticByRunner[runner] || emptySemanticSummary(),
    },
  ]));
  return {
    totalCases: Number(summary.totalCases || 0),
    runs,
    onlineLocalComparable: Number(summary.onlineLocalComparable || 0),
    onlineLocalDiverged: Number(summary.onlineLocalDiverged || 0),
  };
}

function collectSemanticSummary(cases = []) {
  const byRunner = {};
  for (const item of cases || []) {
    for (const [runner, result] of Object.entries(item.runs || {})) {
      const stats = byRunner[runner] ||= emptySemanticSummary();
      const rating = result?.semanticReview?.rating;
      if (!SEMANTIC_RATINGS.has(rating)) {
        stats.notReviewed += 1;
        continue;
      }
      stats[rating] += 1;
      stats.reviewed += 1;
    }
  }
  for (const stats of Object.values(byRunner)) {
    stats.strictAccuracy = stats.reviewed > 0
      && stats.notReviewed === 0
      && stats.uncertain === 0
      ? stats.correct / stats.reviewed
      : null;
  }
  return byRunner;
}

function emptySemanticSummary() {
  return {
    correct: 0,
    partially_correct: 0,
    incorrect: 0,
    uncertain: 0,
    reviewed: 0,
    notReviewed: 0,
    strictAccuracy: null,
  };
}

function redactCaseResult(item = {}, parseStrategy = "") {
  return {
    id: String(item.id || ""),
    parseStrategy: String(parseStrategy || ""),
    runs: Object.fromEntries(Object.entries(item.runs || {}).map(([runner, result]) => [
      runner,
      redactRunResult(result),
    ])),
    comparison: item.comparison || { status: "not_available" },
  };
}

function redactRunResult(result = {}) {
  const semanticReview = redactSemanticReview(result.semanticReview);
  return {
    completedAt: result.completedAt || null,
    latencyMs: Number(result.latencyMs || 0),
    ok: result.ok === true,
    ...(!result.ok ? { error: "request_failed" } : {}),
    evaluation: redactEvaluation(result.evaluation),
    semanticReview,
  };
}

function redactSemanticReview(review = {}) {
  const performed = SEMANTIC_RATINGS.has(review.rating);
  return {
    status: performed ? "completed" : "not_performed",
    ...(performed ? { rating: review.rating } : {}),
    ...(review.error ? { error: "judge_request_failed" } : {}),
    latencyMs: Number(review.latencyMs || 0),
    completedAt: review.completedAt || null,
    // A rationale may quote private inputs, so it is private-checkpoint only.
  };
}

function redactEvaluation(evaluation = {}) {
  const cardResolution = evaluation.cardResolution || {};
  const officialQa = evaluation.officialQa || {};
  const execution = evaluation.execution || {};
  return {
    overall: evaluation.overall || "request_failed",
    execution: {
      dryRun: execution.dryRun === true,
      rawDryRun: execution.rawDryRun === true,
      provider: String(execution.provider || ""),
      model: String(execution.model || ""),
      policyStatus: String(execution.policyStatus || ""),
      policyViolations: Array.isArray(execution.policyViolations) ? execution.policyViolations : [],
    },
    cardResolution: {
      status: String(cardResolution.status || ""),
      expectedCardCount: countItems(cardResolution.expectedCardIds) + countItems(cardResolution.expectedCardNames),
      resolvedCardCount: Math.max(countItems(cardResolution.resolvedCardIds), countItems(cardResolution.resolvedCardNames)),
      missingCardCount: countItems(cardResolution.missingCardIds) + countItems(cardResolution.missingCardNames),
      unresolvedMentionCount: countItems(cardResolution.unresolvedMentions),
      ambiguousMentionCount: countItems(cardResolution.ambiguousMentions),
    },
    officialQa: {
      status: String(officialQa.status || ""),
      expectedCount: countItems(officialQa.expectedQaIds),
      matchedCount: countItems(officialQa.matchedQaIds),
      usedEvidenceCount: countItems(officialQa.usedEvidenceIds),
      directCandidateCount: Number(officialQa.directCandidateCount || 0),
    },
  };
}

function countItems(value) {
  return Array.isArray(value) ? value.length : 0;
}

function normalizeQuestionIdentity(question) {
  return String(question).normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizeReferenceIdentity(referenceAnswer) {
  return String(referenceAnswer)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[。.!！?？]+$/gu, "")
    .trim();
}

function stableExternalCaseId(questionIdentity) {
  return `external-judge-${createHash("sha256")
    .update(`external-judge-case-id-v1\0${questionIdentity}`, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

function hashQuestionSet(cases) {
  const anonymousIds = cases
    .map((item) => stableExternalCaseId(normalizeQuestionIdentity(item.question)))
    .sort();
  return createHash("sha256")
    .update(JSON.stringify(anonymousIds), "utf8")
    .digest("hex");
}

function hashOpaqueValue(value) {
  return createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

function normalizeExternalModelConfiguration(options = {}, fallback = {}) {
  return {
    ...(fallback || {}),
    ...(options.modelProfile ? { modelProfile: String(options.modelProfile) } : {}),
    ...(options.modelTier ? { modelTier: String(options.modelTier) } : {}),
    ...(options.thinkingMode ? { thinkingMode: String(options.thinkingMode) } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: String(options.reasoningEffort) } : {}),
  };
}

function resolveRequiredExternalPath(value, label) {
  if (!String(value || "").trim()) throw new Error(`${label} path is required`);
  const resolvedPath = resolve(String(value));
  const repositoryRelativePath = relative(repositoryRoot, resolvedPath);
  const isInsideRepository = repositoryRelativePath === ""
    || (!repositoryRelativePath.startsWith(`..${sep}`)
      && repositoryRelativePath !== ".."
      && !isAbsolute(repositoryRelativePath));
  if (isInsideRepository) {
    throw new Error(`${label} path must stay outside the repository`);
  }
  return resolvedPath;
}

function defaultOutputPath(inputPath) {
  const extension = extname(inputPath);
  const stem = basename(inputPath, extension);
  return join(dirname(inputPath), `${stem}.evaluation-report.json`);
}

function defaultCheckpointPath(outputPath) {
  const extension = extname(outputPath);
  const stem = basename(outputPath, extension);
  return join(dirname(outputPath), `${stem}.checkpoint.json`);
}

async function readDefaultAnswerEndpoint() {
  try {
    const configPath = resolve(repositoryRoot, "config.json");
    const config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/u, ""));
    return String(config.answerApiUrl || "").trim();
  } catch {
    return "";
  }
}

function parseRunners(value) {
  const runners = String(value || "online")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return runners.length ? runners : ["online"];
}

function renderUsage() {
  return [
    "Usage: node scripts/evaluate-external-judge-text.mjs --input <external-test.txt> [options]",
    "",
    "Options:",
    "  --output <path>       External redacted report path (default: beside input)",
    "  --checkpoint <path>   External PRIVATE resumable checkpoint path (never publish)",
    "  --endpoint <url>      Online answer endpoint",
    "  --runners <list>      Comma-separated online/local runners (default: online)",
    "  --offset <number>     Skip this many unique cases",
    "  --limit <number>      Evaluate at most this many unique cases",
    "  --delay-ms <number>   Delay after each online request",
    "  --timeout-ms <number> Per-request timeout",
    "  --ruling-version <id> Version to evaluate",
    "  --model-profile <id>  Public ruling model profile sent to the API",
    "  --judge-endpoint <url> Explicit independent relay base URL or chat endpoint",
    "  --judge-model <id>     Enable independent semantic judging with this model",
    "  --judge-effort <level> Judge effort: none/low/medium/high/xhigh/max",
    "  --no-resume           Start a new checkpoint instead of resuming",
    "  --no-redact           Private local diagnostic output; never publish it",
    "  --help                Show this help",
    "",
    "Preferred input format:",
    "  ::case",
    "  ::question",
    "  <one or more question lines>",
    "  ::reference-answer",
    "  <one or more judge-only answer lines>",
    "  ::end",
    "",
    "Legacy blank-line-separated blocks remain supported. An '答案' or",
    "'referenceAnswer' marker separates a multi-line answer; otherwise the parser",
    "uses the final question-like line as the boundary, then falls back to the",
    "historical final-line answer rule. Reports are redacted by default.",
  ].join("\n");
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string", short: "i" },
      output: { type: "string", short: "o" },
      checkpoint: { type: "string" },
      endpoint: { type: "string" },
      runners: { type: "string" },
      offset: { type: "string" },
      limit: { type: "string" },
      "delay-ms": { type: "string" },
      "timeout-ms": { type: "string" },
      "ruling-version": { type: "string" },
      "model-profile": { type: "string" },
      "judge-endpoint": { type: "string" },
      "judge-model": { type: "string" },
      "judge-effort": { type: "string" },
      "no-resume": { type: "boolean" },
      "no-redact": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(`${renderUsage()}\n`);
    return;
  }
  const inputPath = resolveRequiredExternalPath(values.input, "input");
  const outputPath = resolveRequiredExternalPath(
    values.output || defaultOutputPath(inputPath),
    "output",
  );
  if (outputPath === inputPath) {
    throw new Error("output path must not overwrite the external judge input");
  }
  const report = await runExternalJudgeTextEvaluation({
    inputPath,
    outputPath,
    ...(values.checkpoint ? { checkpointPath: values.checkpoint } : {}),
    endpoint: values.endpoint,
    runners: parseRunners(values.runners),
    redact: values["no-redact"] !== true,
    resume: values["no-resume"] !== true,
    ...(values.offset ? { offset: Number(values.offset) } : {}),
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    ...(values["delay-ms"] ? { delayMs: Number(values["delay-ms"]) } : {}),
    ...(values["timeout-ms"] ? { timeoutMs: Number(values["timeout-ms"]) } : {}),
    ...(values["ruling-version"] ? { rulingVersion: values["ruling-version"] } : {}),
    ...(values["model-profile"] ? { modelProfile: values["model-profile"] } : {}),
    ...(values["judge-endpoint"] ? { judgeEndpoint: values["judge-endpoint"] } : {}),
    ...(values["judge-model"] ? { judgeModel: values["judge-model"] } : {}),
    ...(values["judge-effort"] ? { judgeReasoningEffort: values["judge-effort"] } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    outputPath,
    corpusCaseCount: report.corpusCaseCount,
    summary: report.summary,
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
