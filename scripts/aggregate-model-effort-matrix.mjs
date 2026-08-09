#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  estimateOpenAIModelCost,
  getModelPricingConfig,
} from "../backend/modelPricing.mjs";
import {
  createExperimentResultBinding,
  hashExperimentRawOutput,
} from "./lib/experiment-result-binding.mjs";

const SCORE_STATUSES = new Set(["PASS", "FAIL", "INCONCLUSIVE"]);
const SEMANTIC_RATINGS = new Set(["correct", "partially_correct", "incorrect", "needs_review"]);
const DETERMINATE_SEMANTIC_RATINGS = new Set(["correct", "partially_correct", "incorrect"]);
const SEMANTIC_REVIEWER_KINDS = new Set(["human", "codex"]);
const EFFORT_ORDER = new Map(
  ["none", "low", "medium", "high", "xhigh", "max"].map((value, index) => [value, index]),
);
const OFFICIAL_MODEL_PRICING = getModelPricingConfig();
const DEFAULT_RELAY_CREDIT_TO_CNY = 1;
const DEFAULT_MARKDOWN_LOCALE = "zh";
const SUPPORTED_MARKDOWN_LOCALES = new Set(["zh", "en", "ja"]);
const DIRECT_RELAY_RUNNERS = new Set([
  "local-relay-effort-experiment/v1",
  "local-relay-effort-experiment/v2",
]);
const DIRECT_RELAY_TERMINAL_RESULT_STATUSES = new Set([
  "completed_valid",
  "completed_invalid",
  "error_rejected",
  "error_outcome_unknown",
]);
const DIRECT_RELAY_RESPONSE_RESULT_STATUSES = new Set([
  "completed_valid",
  "completed_invalid",
]);

const MARKDOWN_TEXT = Object.freeze({
  zh: Object.freeze({
    title: "模型与推理强度实验矩阵",
    evidenceConsistency: "证据一致性",
    passed: "通过",
    failed: "失败",
    accuracyDefinition: "用户答案正确率只来自与原始输出哈希严格绑定的逐题语义复核；自动关键词断言和结构 Validator 不参与正确率。",
    costDefinition: "费用按模型官方标准 API 单价和接口返回 Token 估算，不采用第三方中转倍率或余额扣款；它不是实际账单。只有语义复核完整时才计算每答对一题的费用。",
    error: "错误",
    warning: "警告",
    testContent: "测试内容",
    number: "编号",
    caseId: "Case ID",
    fullQuestion: "完整问题",
    requestedModel: "请求模型",
    returnedModel: "实际返回模型",
    effort: "推理强度",
    evidenceVariant: "证据方案",
    semanticAccuracy: "用户答案正确率",
    reviewCoverage: "复核覆盖率",
    autoAssertionRate: "Auto 断言通过率",
    hardValidationRate: "Hard Validator 通过率",
    totalLatency: "平均 / 中位总耗时",
    firstContentLatency: "平均 / 中位首正文",
    inputTokens: "输入 Token",
    outputTokens: "输出 Token",
    reasoningTokens: "推理 Token",
    totalTokens: "总 Token",
    cost: "费用（总计 / 平均每题 / 每答对一题）",
    dashboardTitle: "看板实际批次增量",
    dashboardNote: "以下数值只是批次级观测，不推导、不分摊为单次请求费用。",
    batch: "批次",
    requests: "请求数",
    start: "开始值",
    end: "结束值",
    delta: "增量",
    unit: "单位",
    source: "来源",
    unverified: "未验证；",
    perCurrencyCoverage: "按币种覆盖率",
    noReturnedModel: "未返回",
    reviewKinds: Object.freeze({ human: "人工", codex: "Codex" }),
    ratings: Object.freeze({
      correct: "正确",
      partially_correct: "部分正确",
      incorrect: "错误",
      needs_review: "需复核",
      unreviewed: "未复核",
      not_planned: "未测试",
    }),
    failureKinds: Object.freeze({ timeout: "超时", empty_response: "空响应" }),
    variants: Object.freeze({ full: "完整资料", card_text_only: "仅卡文", without_lua: "不含 Lua" }),
  }),
  en: Object.freeze({
    title: "Model and reasoning-effort evaluation matrix",
    evidenceConsistency: "Evidence consistency",
    passed: "passed",
    failed: "failed",
    accuracyDefinition: "User-answer accuracy comes only from case-by-case semantic reviews bound to the original-output hash. Keyword assertions and structural validators do not contribute to accuracy.",
    costDefinition: "Cost is estimated from official standard API list prices and provider-reported tokens, not relay multipliers or balance deductions. It is not an invoice. Cost per correct answer requires complete semantic review.",
    error: "Error",
    warning: "Warning",
    testContent: "Test cases",
    number: "No.",
    caseId: "Case ID",
    fullQuestion: "Full question",
    requestedModel: "Requested model",
    returnedModel: "Returned model",
    effort: "Reasoning effort",
    evidenceVariant: "Evidence variant",
    semanticAccuracy: "User-answer accuracy",
    reviewCoverage: "Review coverage",
    autoAssertionRate: "Auto assertion pass rate",
    hardValidationRate: "Hard Validator pass rate",
    totalLatency: "Average / median total latency",
    firstContentLatency: "Average / median first content",
    inputTokens: "Input tokens",
    outputTokens: "Output tokens",
    reasoningTokens: "Reasoning tokens",
    totalTokens: "Total tokens",
    cost: "Cost (total / per case / per correct answer)",
    dashboardTitle: "Observed dashboard batch delta",
    dashboardNote: "These are batch-level observations only and are not inferred or allocated to individual requests.",
    batch: "Batch",
    requests: "Requests",
    start: "Start",
    end: "End",
    delta: "Delta",
    unit: "Unit",
    source: "Source",
    unverified: "unverified; ",
    perCurrencyCoverage: "per-currency coverage",
    noReturnedModel: "Not returned",
    reviewKinds: Object.freeze({ human: "Human", codex: "Codex" }),
    ratings: Object.freeze({
      correct: "Correct",
      partially_correct: "Partially correct",
      incorrect: "Incorrect",
      needs_review: "Needs review",
      unreviewed: "Unreviewed",
      not_planned: "Not tested",
    }),
    failureKinds: Object.freeze({ timeout: "Timed out", empty_response: "Empty response" }),
    variants: Object.freeze({ full: "Full evidence", card_text_only: "Card text only", without_lua: "Without Lua" }),
  }),
  ja: Object.freeze({
    title: "モデル・推論強度評価マトリクス",
    evidenceConsistency: "証拠の一貫性",
    passed: "合格",
    failed: "不合格",
    accuracyDefinition: "ユーザー回答の正答率は、元出力のハッシュに厳密に紐付けた問題別の意味レビューだけから算出します。キーワード判定と構造 Validator は正答率に含めません。",
    costDefinition: "費用は公式の標準 API 価格と返却 Token から推定し、中継業者の倍率や残高控除は使いません。実際の請求額ではありません。正答1件あたりの費用は意味レビューが完全な場合だけ算出します。",
    error: "エラー",
    warning: "警告",
    testContent: "テスト内容",
    number: "番号",
    caseId: "Case ID",
    fullQuestion: "質問全文",
    requestedModel: "リクエストモデル",
    returnedModel: "応答モデル",
    effort: "推論強度",
    evidenceVariant: "証拠構成",
    semanticAccuracy: "ユーザー回答正答率",
    reviewCoverage: "レビュー網羅率",
    autoAssertionRate: "Auto 判定合格率",
    hardValidationRate: "Hard Validator 合格率",
    totalLatency: "総所要時間（平均 / 中央値）",
    firstContentLatency: "最初の本文まで（平均 / 中央値）",
    inputTokens: "入力 Token",
    outputTokens: "出力 Token",
    reasoningTokens: "推論 Token",
    totalTokens: "合計 Token",
    cost: "費用（合計 / 1問平均 / 正答1件あたり）",
    dashboardTitle: "ダッシュボードで観測したバッチ増分",
    dashboardNote: "以下はバッチ単位の観測値であり、個別リクエストへの推定・按分は行いません。",
    batch: "バッチ",
    requests: "リクエスト数",
    start: "開始値",
    end: "終了値",
    delta: "増分",
    unit: "単位",
    source: "出典",
    unverified: "未検証；",
    perCurrencyCoverage: "通貨別カバレッジ",
    noReturnedModel: "未返却",
    reviewKinds: Object.freeze({ human: "人間", codex: "Codex" }),
    ratings: Object.freeze({
      correct: "正解",
      partially_correct: "一部正解",
      incorrect: "不正解",
      needs_review: "要レビュー",
      unreviewed: "未レビュー",
      not_planned: "未実施",
    }),
    failureKinds: Object.freeze({ timeout: "タイムアウト", empty_response: "空の応答" }),
    variants: Object.freeze({ full: "完全な証拠", card_text_only: "カードテキストのみ", without_lua: "Lua なし" }),
  }),
});

export async function aggregateModelEffortMatrixFiles({
  pairs = [],
  semanticReviewFiles = [],
  dashboardMetadataFile = "",
  caseMetadataFile = "",
  expectedCaseCount,
  strictEvidence = true,
  relayCreditToCny = DEFAULT_RELAY_CREDIT_TO_CNY,
  now = () => new Date(),
  readFileImpl = readFile,
} = {}) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new TypeError("at least one checkpoint/scored pair is required");
  }
  const runs = [];
  for (const [index, pair] of pairs.entries()) {
    if (!pair?.checkpointFile || !pair?.scoredFile) {
      throw new TypeError(`pair ${index + 1} requires checkpointFile and scoredFile`);
    }
    const [checkpointText, scoredText] = await Promise.all([
      readFileImpl(pair.checkpointFile, "utf8"),
      readFileImpl(pair.scoredFile, "utf8"),
    ]);
    runs.push({
      checkpoint: parseJson(checkpointText, `checkpoint ${pair.checkpointFile}`),
      scored: parseJson(scoredText, `scored report ${pair.scoredFile}`),
      checkpointPath: String(pair.checkpointFile),
      scoredPath: String(pair.scoredFile),
    });
  }
  const semanticReviews = [];
  for (const semanticReviewFile of semanticReviewFiles) {
    const sourcePath = requiredText(semanticReviewFile, "semantic review file");
    semanticReviews.push({
      document: parseJson(
        await readFileImpl(sourcePath, "utf8"),
        `semantic review ${sourcePath}`,
      ),
      sourcePath,
    });
  }
  let dashboardMetadata = null;
  if (dashboardMetadataFile) {
    dashboardMetadata = parseJson(
      await readFileImpl(dashboardMetadataFile, "utf8"),
      `dashboard metadata ${dashboardMetadataFile}`,
    );
  }
  let caseMetadata = null;
  if (caseMetadataFile) {
    caseMetadata = parseJson(
      await readFileImpl(caseMetadataFile, "utf8"),
      `case metadata ${caseMetadataFile}`,
    );
  }
  return aggregateModelEffortMatrix({
    runs,
    semanticReviews,
    dashboardMetadata,
    caseMetadata,
    expectedCaseCount,
    strictEvidence,
    relayCreditToCny,
    generatedAt: now().toISOString(),
  });
}

export function aggregateModelEffortMatrix({
  runs = [],
  semanticReviews = [],
  dashboardMetadata = null,
  caseMetadata = null,
  expectedCaseCount,
  strictEvidence = true,
  relayCreditToCny = DEFAULT_RELAY_CREDIT_TO_CNY,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new TypeError("runs must contain at least one checkpoint/scored pair");
  }
  const normalizedRelayCreditToCny = positiveNumber(relayCreditToCny, "relayCreditToCny");
  const plannedRecords = runs.flatMap((run, runIndex) => normalizeRunPair(
    run,
    runIndex,
    normalizedRelayCreditToCny,
  ));
  if (plannedRecords.length === 0) throw new Error("experiment matrix contains no planned records");
  const dedupedRecords = dedupeRecords(plannedRecords);
  if (dedupedRecords.length === 0) throw new Error("experiment matrix contains no deduplicated records");
  const semanticReview = normalizeSemanticReviews(semanticReviews, dedupedRecords);
  const records = dedupedRecords.map((record) => ({
    ...record,
    semanticReview: semanticReview.selectedByIdentity.get(record.identity) || null,
  }));
  const configurations = groupRecords(records);
  if (configurations.length === 0) throw new Error("experiment matrix contains no configurations");
  const evidenceConsistency = inspectEvidenceConsistency({
    runs,
    records,
    configurations,
    expectedCaseCount,
  });
  if (strictEvidence && !evidenceConsistency.valid) {
    const error = new Error(`evidence consistency validation failed: ${evidenceConsistency.errors.join("; ")}`);
    error.code = "evidence_consistency_failed";
    error.details = evidenceConsistency;
    throw error;
  }
  const caseIds = evidenceConsistency.canonicalCaseIds;
  const caseCatalog = normalizeCaseCatalog(caseMetadata, caseIds);
  const dashboard = normalizeDashboardMetadata(dashboardMetadata);
  const configurationSummaries = configurations.map((group) => summarizeConfiguration(group, caseIds));
  const semanticPublishable = configurationSummaries.length > 0
    && configurationSummaries.every((configuration) => configuration.semanticPublishable);
  const aggregateMetrics = summarizeReportMetrics(configurationSummaries);
  return {
    schemaVersion: 2,
    reportType: "offline_model_effort_matrix",
    generatedAt,
    publishable: evidenceConsistency.valid && semanticPublishable,
    semanticPublishable,
    caseIds,
    caseCatalog,
    evidenceConsistency,
    semanticReview: {
      schemaVersion: 1,
      assessmentType: "semantic_result_review",
      precedence: ["human", "codex"],
      inputDocumentCount: semanticReview.inputDocumentCount,
      suppliedReviewCount: semanticReview.suppliedReviewCount,
      selectedReviewCount: semanticReview.selectedByIdentity.size,
      selectedHumanCount: semanticReview.selectedHumanCount,
      selectedCodexCount: semanticReview.selectedCodexCount,
      diagnostics: semanticReview.diagnostics,
    },
    semanticAccuracy: aggregateMetrics.semanticAccuracy,
    reviewCoverage: aggregateMetrics.reviewCoverage,
    autoAssertion: aggregateMetrics.autoAssertion,
    autoAssertionAccuracy: aggregateMetrics.autoAssertionAccuracy,
    hardValidation: aggregateMetrics.hardValidation,
    hardValidationRate: aggregateMetrics.hardValidationRate,
    metricDefinitions: {
      semanticAccuracy: "semantically correct / planned cases; rate is withheld until every planned result has a determinate human/Codex review",
      reviewCoverage: "determinate semantic reviews / planned cases",
      autoAssertionAccuracy: "offline scorer PASS / planned cases; humanTruth is always false",
      hardValidationRate: "hard_validity PASS / planned cases; validatedResult.ok is labeled legacy_combined_validator for diagnostics and is UNAVAILABLE for this rate",
      cost: "attributable final-ruling model calls only; shared Evidence Snapshot preparation is not duplicated across configurations",
      costPerCorrectAnswer: "complete attributable configuration cost / semantically correct count; unavailable until semantic review and cost coverage are complete or when correct count is zero",
    },
    pricingAssumptions: {
      officialListPrice: {
        status: "estimated",
        estimateOnly: true,
        currency: OFFICIAL_MODEL_PRICING.currency,
        processingTier: OFFICIAL_MODEL_PRICING.processingTier,
        pricingVersion: OFFICIAL_MODEL_PRICING.pricingVersion,
        effectiveDate: OFFICIAL_MODEL_PRICING.effectiveDate,
        sources: OFFICIAL_MODEL_PRICING.sources,
        disclaimer: "Official list-price estimate only; third-party relay billing may differ.",
      },
    },
    dashboard,
    configurations: configurationSummaries,
  };
}

export function renderModelEffortMatrixMarkdown(report, { locale = DEFAULT_MARKDOWN_LOCALE } = {}) {
  if (!report || report.reportType !== "offline_model_effort_matrix") {
    throw new TypeError("report must be an offline_model_effort_matrix report");
  }
  const text = markdownText(locale);
  const lines = [
    `# ${text.title}`,
    "",
    `${text.evidenceConsistency}: **${report.evidenceConsistency.valid ? text.passed : text.failed}**.`,
    "",
    text.accuracyDefinition,
    text.costDefinition,
  ];
  if (report.evidenceConsistency.errors.length) {
    lines.push("", ...report.evidenceConsistency.errors.map((error) => `- ${text.error}: ${escapeMarkdown(error)}`));
  }
  if (report.evidenceConsistency.warnings.length) {
    lines.push("", ...report.evidenceConsistency.warnings.map((warning) => `- ${text.warning}: ${escapeMarkdown(warning)}`));
  }
  if (report.semanticReview?.diagnostics?.length) {
    lines.push("", ...report.semanticReview.diagnostics.map((diagnostic) => (
      `- ${text.warning}: ${escapeMarkdown(diagnostic)}`
    )));
  }
  const caseCatalog = normalizeCaseCatalog(report.caseCatalog, report.caseIds);
  const caseHeaders = caseCatalog.map((item) => escapeMarkdown(item.label));
  if (caseCatalog.some((item) => item.question)) {
    lines.push(
      "",
      `## ${text.testContent}`,
      "",
      `| ${text.number} | ${text.caseId} | ${text.fullQuestion} |`,
      "| --- | --- | --- |",
      ...caseCatalog.map((item) => (
        `| ${escapeMarkdown(item.label)} | ${escapeMarkdown(item.caseId)} | ${escapeMarkdown(item.question || "—")} |`
      )),
    );
  }
  const headers = [
      text.requestedModel,
      text.returnedModel,
      text.effort,
      text.evidenceVariant,
      ...caseHeaders,
      text.semanticAccuracy,
      text.reviewCoverage,
      text.totalLatency,
      text.firstContentLatency,
      text.inputTokens,
      text.outputTokens,
      text.reasoningTokens,
      text.totalTokens,
      text.cost,
  ];
  lines.push(
    "",
    headers.map((value) => `| ${value} `).join("") + "|",
    headers.map(() => "| --- ").join("") + "|",
  );
  for (const configuration of report.configurations) {
    const casesById = new Map(configuration.cases.map((item) => [item.caseId, item]));
    lines.push([
      configuration.model,
      formatReturnedModel(configuration, text),
      configuration.effort,
      formatEvidenceVariant(configuration.evidenceVariant, text),
      ...report.caseIds.map((caseId) => formatSemanticReview(casesById.get(caseId), text)),
      formatSemanticAccuracy(configuration.semanticAccuracy),
      formatRatio(configuration.reviewCoverage),
      formatLatency(configuration.latency.totalMs),
      formatLatency(configuration.latency.firstContentMs),
      formatTokenMetric(configuration.tokens.input),
      formatTokenMetric(configuration.tokens.output),
      formatTokenMetric(configuration.tokens.reasoning),
      formatTokenMetric(configuration.tokens.total),
      formatEstimatedCost(configuration.estimatedCost, text),
    ].map((value) => `| ${escapeMarkdown(value)} `).join("") + "|");
  }
  if (report.dashboard) {
    lines.push(
      "",
      `## ${text.dashboardTitle}`,
      "",
      text.dashboardNote,
      "",
      `| ${text.batch} | ${text.requests} | ${text.start} | ${text.end} | ${text.delta} | ${text.unit} | ${text.source} |`,
      "| --- | ---: | ---: | ---: | ---: | --- | --- |",
    );
    for (const batch of report.dashboard.batches) {
      lines.push(`| ${escapeMarkdown(batch.label)} | ${nullable(batch.requestCount)} | ${nullable(batch.before)} | ${nullable(batch.after)} | ${nullable(batch.delta)} | ${escapeMarkdown(batch.unit || "")} | ${escapeMarkdown(batch.source || "")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function normalizeRunPair(run, runIndex, relayCreditToCny) {
  const checkpoint = requiredObject(run?.checkpoint, `run ${runIndex + 1} checkpoint`);
  const scored = requiredObject(run?.scored, `run ${runIndex + 1} scored report`);
  const isDirectRelay = isDirectRelayCheckpoint(checkpoint);
  if (!Array.isArray(checkpoint.results)) {
    throw new TypeError(`run ${runIndex + 1} checkpoint.results must be an array`);
  }
  if (!Array.isArray(scored.results)) {
    throw new TypeError(`run ${runIndex + 1} scored.results must be an array`);
  }
  if (checkpoint.results.length === 0) {
    throw new Error(`run ${runIndex + 1} checkpoint.results must not be empty`);
  }
  if (isDirectRelay && !Array.isArray(checkpoint.plan)) {
    throw new Error(`run ${runIndex + 1} Direct Relay checkpoint.plan must be a non-empty array`);
  }
  if (Array.isArray(checkpoint.plan) && checkpoint.plan.length === 0) {
    throw new Error(`run ${runIndex + 1} checkpoint.plan must not be empty`);
  }
  if (isDirectRelay && checkpoint.status !== "completed") {
    throw new Error(`run ${runIndex + 1} Direct Relay checkpoint status must be completed`);
  }
  if (!isDirectRelay && checkpoint.status && checkpoint.status !== "completed") {
    throw new Error(`run ${runIndex + 1} checkpoint is not completed (${checkpoint.status})`);
  }
  const directRelayContract = isDirectRelay
    ? validateDirectRelayCheckpointContract(checkpoint, runIndex)
    : null;
  const rawPlans = Array.isArray(checkpoint.plan) && checkpoint.plan.length
    ? checkpoint.plan
    : checkpoint.results.map((result) => ({
        key: result.key,
        caseId: result.caseId,
        model: result.model,
        effort: result.effort,
        evidenceVariant: result.evidenceVariant,
      }));
  if (rawPlans.length === 0) throw new Error(`run ${runIndex + 1} checkpoint has no plan`);
  if (isDirectRelay) {
    if (checkpoint.plannedRequests === undefined) {
      throw new Error(`run ${runIndex + 1} Direct Relay plannedRequests is required`);
    }
    const plannedRequests = Number(checkpoint.plannedRequests);
    if (!Number.isInteger(plannedRequests) || plannedRequests < 1) {
      throw new Error(`run ${runIndex + 1} Direct Relay plannedRequests must be a positive integer`);
    }
    if (plannedRequests !== rawPlans.length || plannedRequests !== checkpoint.results.length) {
      throw new Error(
        `run ${runIndex + 1} Direct Relay plannedRequests ${plannedRequests} does not match plan/results ${rawPlans.length}/${checkpoint.results.length}`,
      );
    }
  }
  const plans = rawPlans.map((plan, planIndex) => {
    const descriptor = {
      caseId: requiredText(plan.caseId, `plan[${planIndex}].caseId`),
      model: requiredText(plan.model || checkpoint.model, `plan[${planIndex}] model`),
      effort: requiredText(plan.effort, `plan[${planIndex}] effort`).toLowerCase(),
      evidenceVariant: String(plan.evidenceVariant || checkpoint.evidenceVariant || "full"),
    };
    const normalizedPlan = {
      raw: plan,
      key: optionalText(plan.key),
      finalInputSha256: optionalText(plan.finalInputSha256),
      descriptor,
      identity: recordIdentity(descriptor),
    };
    if (directRelayContract) {
      assertDirectRelayDescriptorMatchesCheckpoint(
        descriptor,
        directRelayContract,
        `plan[${planIndex}]`,
      );
      const expectedKey = directRelayResultKey(
        descriptor.caseId,
        descriptor.model,
        descriptor.effort,
        descriptor.evidenceVariant,
      );
      if (normalizedPlan.key !== expectedKey) {
        throw new Error(
          `run ${runIndex + 1} Direct Relay plan[${planIndex}].key must be ${expectedKey}`,
        );
      }
    }
    return normalizedPlan;
  });
  const planKeys = new Set();
  const planIdentities = new Set();
  for (const plan of plans) {
    if (planIdentities.has(plan.identity)) {
      throw new Error(`duplicate checkpoint plan identity: ${plan.identity}`);
    }
    planIdentities.add(plan.identity);
    if (plan.key) {
      if (planKeys.has(plan.key)) throw new Error(`duplicate checkpoint plan key: ${plan.key}`);
      planKeys.add(plan.key);
    }
  }
  if (directRelayContract) {
    const expectedPlanKeys = directRelayContract.caseIds.flatMap((caseId) => (
      directRelayContract.efforts.map((effort) => directRelayResultKey(
        caseId,
        directRelayContract.model,
        effort,
        directRelayContract.evidenceVariant,
      ))
    )).sort();
    const actualPlanKeys = plans.map((plan) => plan.key).sort();
    if (JSON.stringify(actualPlanKeys) !== JSON.stringify(expectedPlanKeys)) {
      throw new Error(
        `run ${runIndex + 1} Direct Relay checkpoint.plan must equal caseIds × efforts`,
      );
    }
  }
  const resultByKey = new Map();
  const resultByIdentity = new Map();
  const resultIdentity = new Map();
  for (const [resultIndex, result] of checkpoint.results.entries()) {
    const resultStatus = String(result.status || "");
    if (isDirectRelay && !DIRECT_RELAY_TERMINAL_RESULT_STATUSES.has(resultStatus)) {
      throw new Error(
        `run ${runIndex + 1} Direct Relay result[${resultIndex}].status must be terminal; received ${resultStatus || "missing"}`,
      );
    }
    const descriptor = {
      caseId: requiredText(result.caseId, `result[${resultIndex}].caseId`),
      model: requiredText(result.model || checkpoint.model, `result[${resultIndex}] model`),
      effort: requiredText(result.effort, `result[${resultIndex}] effort`).toLowerCase(),
      evidenceVariant: result.evidenceVariant || checkpoint.evidenceVariant || "full",
    };
    if (directRelayContract) {
      assertDirectRelayDescriptorMatchesCheckpoint(
        descriptor,
        directRelayContract,
        `result[${resultIndex}]`,
      );
      const expectedKey = directRelayResultKey(
        descriptor.caseId,
        descriptor.model,
        descriptor.effort,
        descriptor.evidenceVariant,
      );
      if (optionalText(result.key) !== expectedKey) {
        throw new Error(
          `run ${runIndex + 1} Direct Relay result[${resultIndex}].key must be ${expectedKey}`,
        );
      }
    }
    const identity = recordIdentity(descriptor);
    if (resultByIdentity.has(identity)) throw new Error(`duplicate checkpoint result identity: ${identity}`);
    resultByIdentity.set(identity, result);
    resultIdentity.set(result, identity);
    const key = optionalText(result.key);
    if (key) {
      if (resultByKey.has(key)) throw new Error(`duplicate checkpoint result key: ${key}`);
      resultByKey.set(key, result);
    }
  }
  const scoreByIdentity = new Map();
  for (const [scoreIndex, score] of scored.results.entries()) {
    const status = String(score.status || "").toUpperCase();
    if (!SCORE_STATUSES.has(status)) throw new Error(`unsupported scored status: ${score.status}`);
    const identity = recordIdentity({
      caseId: requiredText(score.caseId, `score[${scoreIndex}].caseId`),
      model: requiredText(score.requestedModel || score.model, `score[${scoreIndex}] model`),
      effort: requiredText(score.reasoningEffort || score.effort, `score[${scoreIndex}] effort`).toLowerCase(),
      evidenceVariant: score.evidenceVariant || checkpoint.evidenceVariant || "full",
    });
    if (scoreByIdentity.has(identity)) throw new Error(`duplicate scored result: ${identity}`);
    scoreByIdentity.set(identity, {
      ...score,
      status,
      sourceBinding: normalizeScoreSourceBinding(
        score.sourceBinding,
        `score[${scoreIndex}].sourceBinding`,
      ),
    });
  }
  const matchedResults = new Set();
  const records = plans.map((plan) => {
    const { descriptor, identity } = plan;
    const keyedResult = plan.key ? resultByKey.get(plan.key) || null : null;
    if (keyedResult && resultIdentity.get(keyedResult) !== identity) {
      throw new Error(
        `checkpoint plan key identity mismatch: ${plan.key} expected ${identity}, found ${resultIdentity.get(keyedResult)}`,
      );
    }
    const result = keyedResult || resultByIdentity.get(identity) || null;
    const score = scoreByIdentity.get(identity) || null;
    if (!result) throw new Error(`checkpoint plan is missing result: ${identity}`);
    if (!score) throw new Error(`checkpoint plan is missing score: ${identity}`);
    if (
      plan.finalInputSha256
      && plan.finalInputSha256 !== optionalText(result.finalInputSha256)
    ) {
      throw new Error(`checkpoint plan finalInputSha256 mismatch: ${identity}`);
    }
    if (
      new Set(["PASS", "FAIL"]).has(score.status)
      && result?.status !== "completed_valid"
    ) {
      throw new Error(
        `scored ${score.status} requires completed_valid result: ${identity} (${result?.status || "missing_result"})`,
      );
    }
    assertScoreSourceBindingMatchesResult(score.sourceBinding, result, identity);
    if (result) matchedResults.add(result);
    const checkpointReturnedModel = optionalText(result?.reportedModel || result?.returnedModel);
    const scoredReturnedModel = optionalText(score?.returnedModel);
    return {
      ...descriptor,
      identity,
      runIndex,
      checkpointPath: run.checkpointPath || null,
      scoredPath: run.scoredPath || null,
      bundleSha256: optionalText(checkpoint.bundleSha256),
      snapshotSha256: optionalText(result?.snapshotSha256),
      finalInputSha256: optionalText(result?.finalInputSha256),
      resultKey: score.sourceBinding.resultKey,
      requestId: score.sourceBinding.requestId,
      rawOutputSha256: score.sourceBinding.rawOutputSha256,
      sourceBinding: score.sourceBinding,
      rawStatus: result?.status || "missing_result",
      failureKind: classifyResultFailure(result),
      scoreStatus: score?.status || "INCONCLUSIVE",
      scoreReason: score?.reason || null,
      isDirectRelay,
      checkpointReturnedModel,
      scoredReturnedModel,
      returnedModel: isDirectRelay
        ? checkpointReturnedModel
        : (checkpointReturnedModel || scoredReturnedModel),
      durationMs: firstFinite(result?.durationMs, result?.sseTiming?.requestToCompleteMs),
      firstContentMs: firstFinite(
        result?.sseTiming?.requestToFirstContentMs,
        result?.streamMetrics?.requestToFirstContentMs,
      ),
      usage: extractUsage(result),
      hardValidation: normalizeHardValidation(result),
      estimatedCosts: extractEstimatedCosts(result, descriptor.model, relayCreditToCny),
    };
  });
  const orphanResult = checkpoint.results.find((result) => !matchedResults.has(result));
  if (orphanResult) {
    throw new Error(`orphan checkpoint result: ${resultIdentity.get(orphanResult)}`);
  }
  const orphanScore = [...scoreByIdentity.keys()].find((identity) => !planIdentities.has(identity));
  if (orphanScore) throw new Error(`orphan scored result: ${orphanScore}`);
  return records;
}

function normalizeScoreSourceBinding(value, label) {
  const binding = requiredObject(value, label);
  if (binding.status !== "bound") {
    const reasons = Array.isArray(binding.unavailableReasons)
      ? binding.unavailableReasons.join(", ")
      : "unknown reason";
    throw new Error(`${label} must be bound (${reasons})`);
  }
  return {
    status: "bound",
    resultKey: requiredText(binding.resultKey, `${label}.resultKey`),
    requestId: explicitNullableText(binding, "requestId", `${label}.requestId`),
    finalInputSha256: requiredText(binding.finalInputSha256, `${label}.finalInputSha256`),
    rawOutputSha256: requiredText(binding.rawOutputSha256, `${label}.rawOutputSha256`),
  };
}

function assertScoreSourceBindingMatchesResult(binding, result, identity) {
  const expected = createExperimentResultBinding(result);
  if (expected.status !== "bound") {
    throw new Error(
      `checkpoint result source binding is unavailable for ${identity}: ${expected.unavailableReasons.join(", ")}`,
    );
  }
  const recomputedRawOutputSha256 = hashExperimentRawOutput(result.rawOutput);
  if (expected.rawOutputSha256 !== recomputedRawOutputSha256) {
    throw new Error(`checkpoint rawOutput hash helper mismatch for ${identity}`);
  }
  const comparisons = [
    ["status", binding.status, expected.status],
    ["resultKey", binding.resultKey, expected.resultKey],
    ["requestId", binding.requestId, expected.requestId],
    ["finalInputSha256", binding.finalInputSha256, expected.finalInputSha256],
    ["rawOutputSha256", binding.rawOutputSha256, recomputedRawOutputSha256],
  ];
  for (const [field, scoredValue, resultValue] of comparisons) {
    if (scoredValue !== resultValue) {
      throw new Error(
        `score sourceBinding ${field} mismatch for ${identity}: ${nullable(scoredValue)} != ${nullable(resultValue)}`,
      );
    }
  }
}

function normalizeSemanticReviews(values, records) {
  if (!Array.isArray(values)) throw new TypeError("semanticReviews must be an array");
  const recordsByIdentity = new Map(records.map((record) => [record.identity, record]));
  const reviewByLevel = new Map();
  let suppliedReviewCount = 0;
  for (const [documentIndex, entry] of values.entries()) {
    const document = entry?.document || entry;
    const sourcePath = optionalText(entry?.sourcePath) || `semantic-review-${documentIndex + 1}`;
    requiredObject(document, `semantic review document ${documentIndex + 1}`);
    if (Number(document.schemaVersion) !== 1) {
      throw new Error(`semantic review ${sourcePath} must use schemaVersion 1`);
    }
    if (document.assessmentType !== "semantic_result_review") {
      throw new Error(`semantic review ${sourcePath} has unsupported assessmentType`);
    }
    if (!Array.isArray(document.reviews)) {
      throw new TypeError(`semantic review ${sourcePath}.reviews must be an array`);
    }
    for (const [reviewIndex, rawReview] of document.reviews.entries()) {
      const label = `semantic review ${sourcePath}[${reviewIndex}]`;
      const review = requiredObject(rawReview, label);
      const descriptor = {
        caseId: requiredText(review.caseId, `${label}.caseId`),
        model: requiredText(review.requestedModel, `${label}.requestedModel`),
        effort: requiredText(review.reasoningEffort, `${label}.reasoningEffort`).toLowerCase(),
        evidenceVariant: requiredText(review.evidenceVariant, `${label}.evidenceVariant`),
      };
      const identity = recordIdentity(descriptor);
      const record = recordsByIdentity.get(identity);
      if (!record) throw new Error(`orphan semantic review: ${identity}`);
      const binding = {
        resultKey: requiredText(review.resultKey, `${label}.resultKey`),
        requestId: explicitNullableText(review, "requestId", `${label}.requestId`),
        finalInputSha256: requiredText(review.finalInputSha256, `${label}.finalInputSha256`),
        rawOutputSha256: requiredText(review.rawOutputSha256, `${label}.rawOutputSha256`),
      };
      assertSemanticReviewBinding(record, binding, identity);
      const rating = requiredText(review.rating, `${label}.rating`).toLowerCase();
      if (!SEMANTIC_RATINGS.has(rating)) throw new Error(`unsupported semantic review rating: ${review.rating}`);
      const reviewer = requiredObject(review.reviewer, `${label}.reviewer`);
      const kind = requiredText(reviewer.kind, `${label}.reviewer.kind`).toLowerCase();
      if (!SEMANTIC_REVIEWER_KINDS.has(kind)) {
        throw new Error(`unsupported semantic reviewer kind: ${reviewer.kind}`);
      }
      const reviewedAt = requiredText(review.reviewedAt, `${label}.reviewedAt`);
      if (Number.isNaN(Date.parse(reviewedAt))) throw new Error(`${label}.reviewedAt must be an ISO date-time`);
      const normalized = {
        caseId: descriptor.caseId,
        requestedModel: descriptor.model,
        reasoningEffort: descriptor.effort,
        evidenceVariant: descriptor.evidenceVariant,
        resultKey: binding.resultKey,
        requestId: binding.requestId,
        finalInputSha256: binding.finalInputSha256,
        rawOutputSha256: binding.rawOutputSha256,
        rating,
        reviewer: {
          kind,
          name: requiredText(reviewer.name, `${label}.reviewer.name`),
          model: optionalText(reviewer.model),
          version: optionalText(reviewer.version),
        },
        reviewedAt,
        rationale: requiredText(review.rationale, `${label}.rationale`),
        firstErrorStage: optionalText(review.firstErrorStage),
        sourcePath,
      };
      const levelKey = `${identity}::${kind}`;
      const existing = reviewByLevel.get(levelKey);
      if (existing) {
        if (semanticReviewFingerprint(existing) === semanticReviewFingerprint(normalized)) {
          throw new Error(`duplicate semantic review at ${kind} level: ${identity}`);
        }
        throw new Error(`conflicting semantic reviews at ${kind} level: ${identity}`);
      }
      reviewByLevel.set(levelKey, normalized);
      suppliedReviewCount += 1;
    }
  }
  const selectedByIdentity = new Map();
  let selectedHumanCount = 0;
  let selectedCodexCount = 0;
  for (const identity of recordsByIdentity.keys()) {
    const human = reviewByLevel.get(`${identity}::human`);
    const codex = reviewByLevel.get(`${identity}::codex`);
    const selected = human || codex || null;
    if (!selected) continue;
    selectedByIdentity.set(identity, selected);
    if (selected.reviewer.kind === "human") selectedHumanCount += 1;
    else selectedCodexCount += 1;
  }
  const missingCount = records.length - selectedByIdentity.size;
  const needsReviewCount = [...selectedByIdentity.values()]
    .filter((review) => review.rating === "needs_review").length;
  const diagnostics = [];
  if (missingCount) diagnostics.push(`${missingCount} planned result(s) have no semantic review`);
  if (needsReviewCount) diagnostics.push(`${needsReviewCount} planned result(s) still need semantic review`);
  return {
    inputDocumentCount: values.length,
    suppliedReviewCount,
    selectedByIdentity,
    selectedHumanCount,
    selectedCodexCount,
    diagnostics,
  };
}

function assertSemanticReviewBinding(record, binding, identity) {
  for (const field of ["resultKey", "requestId", "finalInputSha256", "rawOutputSha256"]) {
    if (binding[field] !== record.sourceBinding[field]) {
      throw new Error(
        `semantic review ${field} binding mismatch for ${identity}: ${nullable(binding[field])} != ${nullable(record.sourceBinding[field])}`,
      );
    }
  }
}

function semanticReviewFingerprint(review) {
  return JSON.stringify({
    caseId: review.caseId,
    requestedModel: review.requestedModel,
    reasoningEffort: review.reasoningEffort,
    evidenceVariant: review.evidenceVariant,
    resultKey: review.resultKey,
    requestId: review.requestId,
    finalInputSha256: review.finalInputSha256,
    rawOutputSha256: review.rawOutputSha256,
    rating: review.rating,
    reviewer: review.reviewer,
    reviewedAt: review.reviewedAt,
    rationale: review.rationale,
    firstErrorStage: review.firstErrorStage,
  });
}

function normalizeHardValidation(result) {
  const explicit = result?.hardValidity ?? result?.validatedResult?.hardValidity;
  if (typeof explicit?.ok === "boolean") {
    return {
      status: explicit.ok ? "PASS" : "FAIL",
      ok: explicit.ok,
      source: "hard_validity",
      errors: Array.isArray(explicit.errors) ? explicit.errors.map(String) : [],
      semanticTruth: false,
    };
  }
  if (typeof explicit === "boolean") {
    return {
      status: explicit ? "PASS" : "FAIL",
      ok: explicit,
      source: "hard_validity",
      errors: [],
      semanticTruth: false,
    };
  }
  if (typeof result?.validatedResult?.ok === "boolean") {
    return {
      status: "UNAVAILABLE",
      ok: result.validatedResult.ok,
      source: "legacy_combined_validator",
      legacyStatus: result.validatedResult.ok ? "PASS" : "FAIL",
      errors: Array.isArray(result.validatedResult.errors)
        ? result.validatedResult.errors.map(String)
        : [],
      semanticTruth: false,
    };
  }
  return {
    status: "UNAVAILABLE",
    ok: null,
    source: "unavailable",
    errors: [],
    semanticTruth: false,
  };
}

function dedupeRecords(records) {
  const byIdentity = new Map();
  for (const record of records) {
    const existing = byIdentity.get(record.identity);
    if (!existing) {
      byIdentity.set(record.identity, record);
      continue;
    }
    const comparableKeys = [
      "bundleSha256", "snapshotSha256", "finalInputSha256", "rawStatus", "failureKind", "scoreStatus",
      "returnedModel", "checkpointReturnedModel", "scoredReturnedModel",
      "durationMs", "firstContentMs",
    ];
    if (comparableKeys.some((key) => existing[key] !== record[key])
      || JSON.stringify(existing.usage) !== JSON.stringify(record.usage)
      || JSON.stringify(existing.sourceBinding) !== JSON.stringify(record.sourceBinding)
      || JSON.stringify(existing.hardValidation) !== JSON.stringify(record.hardValidation)
      || JSON.stringify(existing.estimatedCosts) !== JSON.stringify(record.estimatedCosts)) {
      throw new Error(`conflicting duplicate experiment record: ${record.identity}`);
    }
  }
  return [...byIdentity.values()];
}

function groupRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.model}::${record.effort}::${record.evidenceVariant}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    model: items[0].model,
    effort: items[0].effort,
    evidenceVariant: items[0].evidenceVariant,
    plannedCaseIds: items.map((item) => item.caseId),
    records: items,
  })).sort(compareConfigurations);
}

function inspectEvidenceConsistency({ runs, records, configurations, expectedCaseCount }) {
  const errors = [];
  const warnings = [];
  const bundleHashes = unique(runs.map((run) => optionalText(run.checkpoint?.bundleSha256)).filter(Boolean));
  const directRelayRuns = runs.map((run, index) => ({ run, runNumber: index + 1 }))
    .filter(({ run }) => isDirectRelayCheckpoint(run.checkpoint));
  const legacyRuns = runs.map((run, index) => ({ run, runNumber: index + 1 }))
    .filter(({ run }) => !isDirectRelayCheckpoint(run.checkpoint));
  const directRelayBundleHashes = unique(
    directRelayRuns.map(({ run }) => optionalText(run.checkpoint?.bundleSha256)).filter(Boolean),
  );
  if (directRelayBundleHashes.length > 1) {
    errors.push(`Direct Relay bundleSha256 mismatch: ${directRelayBundleHashes.join(", ")}`);
  }
  const missingDirectBundleRunNumbers = directRelayRuns.flatMap(({ run, runNumber }) => (
    optionalText(run.checkpoint?.bundleSha256) ? [] : [runNumber]
  ));
  if (missingDirectBundleRunNumbers.length) {
    errors.push(
      `Direct Relay v2 requires bundleSha256 for every Direct Relay checkpoint; missing run(s): ${missingDirectBundleRunNumbers.join(", ")}`,
    );
  }
  const missingLegacyBundleRunNumbers = legacyRuns.flatMap(({ run, runNumber }) => (
    optionalText(run.checkpoint?.bundleSha256) ? [] : [runNumber]
  ));
  if (legacyRuns.length === runs.length && missingLegacyBundleRunNumbers.length === runs.length) {
    warnings.push("bundleSha256 was unavailable for every checkpoint");
  } else if (missingLegacyBundleRunNumbers.length) {
    warnings.push(
      `bundleSha256 was unavailable for one or more legacy checkpoints; run(s): ${missingLegacyBundleRunNumbers.join(", ")}`,
    );
  }
  const referenceCaseIdsByVariant = new Map();
  for (const configuration of configurations) {
    if (new Set(configuration.plannedCaseIds).size !== configuration.plannedCaseIds.length) {
      errors.push(`${configuration.key} contains duplicate planned cases`);
    }
    const variant = configuration.evidenceVariant || "full";
    const reference = referenceCaseIdsByVariant.get(variant);
    if (!reference) {
      referenceCaseIdsByVariant.set(variant, [...configuration.plannedCaseIds]);
    } else if (sortedSetKey(configuration.plannedCaseIds) !== sortedSetKey(reference)) {
      errors.push(`${configuration.key} does not use the same planned case set within evidence variant ${variant}`);
    }
  }
  const returnedModelsByConfiguration = {};
  for (const record of records) {
    const diagnostics = record.isDirectRelay ? errors : warnings;
    const directResponseRequiresModel = record.isDirectRelay
      && DIRECT_RELAY_RESPONSE_RESULT_STATUSES.has(record.rawStatus);
    if (directResponseRequiresModel && !record.checkpointReturnedModel) {
      errors.push(`${record.identity} Direct Relay checkpoint returnedModel was unavailable`);
    }
    if (!record.returnedModel) {
      if (record.isDirectRelay && !directResponseRequiresModel) {
        warnings.push(`${record.identity} returnedModel was not returned (${record.rawStatus})`);
      } else {
        diagnostics.push(`${record.identity} returnedModel was unavailable`);
      }
      continue;
    }
    if (
      record.checkpointReturnedModel
      && record.scoredReturnedModel
      && record.checkpointReturnedModel !== record.scoredReturnedModel
    ) {
      diagnostics.push(
        `${record.identity} returnedModel source mismatch: checkpoint ${record.checkpointReturnedModel}, scored ${record.scoredReturnedModel}`,
      );
    }
    if (!isAllowedReturnedModel(record.model, record.returnedModel)) {
      diagnostics.push(
        `${record.identity} returnedModel mismatch: requested ${record.model}, returned ${record.returnedModel}`,
      );
    }
  }
  for (const configuration of configurations) {
    const returnedModels = unique(
      configuration.records.map((record) => record.returnedModel).filter(Boolean),
    ).sort();
    returnedModelsByConfiguration[configuration.key] = returnedModels;
    const directReturnedModels = unique(configuration.records
      .filter((record) => record.isDirectRelay)
      .map((record) => record.returnedModel)
      .filter(Boolean)).sort();
    const legacyReturnedModels = unique(configuration.records
      .filter((record) => !record.isDirectRelay)
      .map((record) => record.returnedModel)
      .filter(Boolean)).sort();
    if (directReturnedModels.length > 1) {
      errors.push(
        `${configuration.key} Direct Relay returnedModel is inconsistent within configuration: ${directReturnedModels.join(", ")}`,
      );
    }
    if (legacyReturnedModels.length > 1) {
      warnings.push(
        `${configuration.key} legacy returnedModel is inconsistent within configuration: ${legacyReturnedModels.join(", ")}`,
      );
    }
  }
  const [canonicalVariant, canonicalCaseIds] = selectCanonicalVariant(referenceCaseIdsByVariant);
  const canonicalCaseIdSet = new Set(canonicalCaseIds);
  if (expectedCaseCount !== undefined) {
    const expected = Number(expectedCaseCount);
    if (!Number.isInteger(expected) || expected < 1) throw new TypeError("expectedCaseCount must be a positive integer");
    if (canonicalCaseIds.length !== expected) {
      errors.push(`expected ${expected} canonical planned cases, found ${canonicalCaseIds.length}`);
    }
  }
  for (const [variant, variantCaseIds] of referenceCaseIdsByVariant.entries()) {
    const outsideCanonical = variantCaseIds.filter((caseId) => !canonicalCaseIdSet.has(caseId));
    if (outsideCanonical.length) {
      errors.push(
        `${variant} planned case set is not a subset of canonical ${canonicalVariant}: ${outsideCanonical.join(", ")}`,
      );
    }
  }
  const finalInputSha256ByVariant = {};
  for (const [variant, variantCaseIds] of referenceCaseIdsByVariant.entries()) {
    finalInputSha256ByVariant[variant] = {};
    for (const caseId of variantCaseIds) {
      const caseRecords = records.filter((record) => (
        record.caseId === caseId && record.evidenceVariant === variant
      ));
      const hashes = unique(caseRecords.map((record) => record.finalInputSha256).filter(Boolean));
      finalInputSha256ByVariant[variant][caseId] = hashes;
      if (hashes.length > 1) errors.push(`${variant}/${caseId} finalInputSha256 mismatch: ${hashes.join(", ")}`);
      if (hashes.length === 0) warnings.push(`${variant}/${caseId} finalInputSha256 was unavailable`);
      else if (caseRecords.some((record) => !record.finalInputSha256)) {
        warnings.push(`${variant}/${caseId} finalInputSha256 was unavailable for one or more planned records`);
      }
    }
  }
  const finalInputSha256ByCase = canonicalVariant
    ? finalInputSha256ByVariant[canonicalVariant]
    : {};
  return {
    valid: errors.length === 0,
    checkedRunCount: runs.length,
    checkedConfigurationCount: configurations.length,
    expectedCaseCount: expectedCaseCount === undefined ? null : Number(expectedCaseCount),
    bundleSha256: directRelayRuns.length
      ? (directRelayBundleHashes.length === 1 ? directRelayBundleHashes[0] : null)
      : (bundleHashes.length === 1 ? bundleHashes[0] : null),
    observedBundleSha256: bundleHashes,
    observedDirectRelayBundleSha256: directRelayBundleHashes,
    returnedModelsByConfiguration,
    canonicalVariant,
    canonicalCaseIds,
    plannedCaseIdsByVariant: Object.fromEntries(referenceCaseIdsByVariant),
    finalInputSha256ByCase,
    finalInputSha256ByVariant,
    errors,
    warnings,
  };
}

function summarizeConfiguration(group, caseIds) {
  const byCase = new Map(group.records.map((record) => [record.caseId, record]));
  const observedReturnedModels = unique(
    group.records.map((record) => record.returnedModel).filter(Boolean),
  ).sort();
  const missingReturnedModelCount = group.records.filter((record) => !record.returnedModel).length;
  const plannedCaseIds = [...group.plannedCaseIds];
  const plannedCaseIdSet = new Set(plannedCaseIds);
  const cases = caseIds.map((caseId) => {
    const record = byCase.get(caseId);
    if (!plannedCaseIdSet.has(caseId)) {
      return {
        caseId,
        planned: false,
        semanticReview: null,
        autoAssertion: null,
        hardValidation: null,
        rawStatus: "not_planned",
      };
    }
    if (!record) throw new Error(`configuration is missing planned record: ${group.key} ${caseId}`);
    return {
      caseId,
      planned: true,
      semanticReview: record.semanticReview,
      autoAssertion: {
        status: record.scoreStatus,
        reason: record.scoreReason,
        humanTruth: false,
      },
      hardValidation: record.hardValidation,
      rawStatus: record.rawStatus,
      failureKind: record.failureKind,
      returnedModel: record.returnedModel,
      durationMs: record.durationMs,
      firstContentMs: record.firstContentMs,
      usage: record.usage,
      estimatedCost: record.estimatedCosts.length ? record.estimatedCosts : null,
    };
  });
  const plannedCases = cases.filter((item) => item.planned);
  const semanticCounts = Object.fromEntries([...SEMANTIC_RATINGS].map((rating) => [
    rating,
    plannedCases.filter((item) => item.semanticReview?.rating === rating).length,
  ]));
  semanticCounts.unreviewed = plannedCases.filter((item) => !item.semanticReview).length;
  const determinateReviewCount = [...DETERMINATE_SEMANTIC_RATINGS]
    .reduce((sum, rating) => sum + semanticCounts[rating], 0);
  const autoAssertionCounts = Object.fromEntries([...SCORE_STATUSES].map((status) => [
    status,
    plannedCases.filter((item) => item.autoAssertion?.status === status).length,
  ]));
  const planned = plannedCases.length;
  const semanticPublishable = planned > 0 && determinateReviewCount === planned;
  const hardValidationCounts = {
    PASS: plannedCases.filter((item) => item.hardValidation?.status === "PASS").length,
    FAIL: plannedCases.filter((item) => item.hardValidation?.status === "FAIL").length,
    UNAVAILABLE: plannedCases.filter((item) => item.hardValidation?.status === "UNAVAILABLE").length,
  };
  return {
    configurationKey: group.key,
    model: group.model,
    requestedModel: group.model,
    returnedModel: observedReturnedModels.length === 1 ? observedReturnedModels[0] : null,
    observedReturnedModels,
    missingReturnedModelCount,
    effort: group.effort,
    evidenceVariant: group.evidenceVariant,
    plannedCaseIds,
    cases,
    semanticReview: {
      counts: semanticCounts,
      selectedCount: planned - semanticCounts.unreviewed,
      determinateCount: determinateReviewCount,
      missingCount: semanticCounts.unreviewed,
      needsReviewCount: semanticCounts.needs_review,
    },
    semanticAccuracy: semanticAccuracy(semanticCounts.correct, determinateReviewCount, planned),
    reviewCoverage: ratio(determinateReviewCount, planned),
    semanticPublishable,
    autoAssertion: {
      counts: autoAssertionCounts,
      humanTruth: false,
    },
    autoAssertionAccuracy: {
      ...ratio(autoAssertionCounts.PASS, planned),
      humanTruth: false,
    },
    hardValidation: {
      counts: hardValidationCounts,
      sources: unique(plannedCases.map((item) => item.hardValidation?.source).filter(Boolean)).sort(),
      semanticTruth: false,
    },
    hardValidationRate: ratio(hardValidationCounts.PASS, planned),
    latency: {
      totalMs: numericSummary(plannedCases.map((item) => item.durationMs)),
      firstContentMs: numericSummary(plannedCases.map((item) => item.firstContentMs)),
    },
    tokens: {
      input: numericSummary(plannedCases.map((item) => item.usage?.inputTokens), { includeSum: true }),
      output: numericSummary(plannedCases.map((item) => item.usage?.outputTokens), { includeSum: true }),
      reasoning: numericSummary(plannedCases.map((item) => item.usage?.reasoningTokens), { includeSum: true }),
      total: numericSummary(plannedCases.map((item) => item.usage?.totalTokens), { includeSum: true }),
    },
    estimatedCost: summarizeEstimatedCosts(plannedCases, planned, {
      semanticComplete: semanticPublishable,
      correctCount: semanticCounts.correct,
    }),
  };
}

function summarizeReportMetrics(configurations) {
  const cases = configurations.flatMap((configuration) => (
    configuration.cases.filter((item) => item.planned)
  ));
  const planned = cases.length;
  const determinateReviewCount = cases.filter((item) => (
    DETERMINATE_SEMANTIC_RATINGS.has(item.semanticReview?.rating)
  )).length;
  const correctCount = cases.filter((item) => item.semanticReview?.rating === "correct").length;
  const autoAssertionCounts = Object.fromEntries([...SCORE_STATUSES].map((status) => [
    status,
    cases.filter((item) => item.autoAssertion?.status === status).length,
  ]));
  const hardValidationCounts = {
    PASS: cases.filter((item) => item.hardValidation?.status === "PASS").length,
    FAIL: cases.filter((item) => item.hardValidation?.status === "FAIL").length,
    UNAVAILABLE: cases.filter((item) => item.hardValidation?.status === "UNAVAILABLE").length,
  };
  return {
    semanticAccuracy: semanticAccuracy(correctCount, determinateReviewCount, planned),
    reviewCoverage: ratio(determinateReviewCount, planned),
    autoAssertion: {
      counts: autoAssertionCounts,
      humanTruth: false,
    },
    autoAssertionAccuracy: {
      ...ratio(autoAssertionCounts.PASS, planned),
      humanTruth: false,
    },
    hardValidation: {
      counts: hardValidationCounts,
      sources: unique(cases.map((item) => item.hardValidation?.source).filter(Boolean)).sort(),
      semanticTruth: false,
    },
    hardValidationRate: ratio(hardValidationCounts.PASS, planned),
  };
}

function semanticAccuracy(correctCount, determinateReviewCount, plannedCaseCount) {
  const complete = plannedCaseCount > 0 && determinateReviewCount === plannedCaseCount;
  return {
    numerator: correctCount,
    denominator: plannedCaseCount,
    rate: complete && plannedCaseCount ? round(correctCount / plannedCaseCount) : null,
    determinateReviewCount,
    complete,
  };
}

function extractUsage(result) {
  if (!result) return null;
  const usage = result.usage || result.metering?.usage || result.metering?.totals?.usage || {};
  const inputTokens = firstFinite(
    usage.inputTokens,
    usage.prompt_tokens,
    usage.promptTokens,
    usage.input_tokens,
  );
  const outputTokens = firstFinite(
    usage.outputTokens,
    usage.completion_tokens,
    usage.completionTokens,
    usage.output_tokens,
  );
  const reasoningTokens = firstFinite(
    usage.reasoningTokens,
    usage.reasoning_tokens,
    usage.completion_tokens_details?.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
  );
  const cachedInputTokens = firstFinite(
    usage.cachedInputTokens,
    usage.cached_input_tokens,
    usage.prompt_cache_hit_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
  );
  const cacheWriteTokens = firstFinite(
    usage.cacheWriteTokens,
    usage.cache_write_tokens,
    usage.prompt_tokens_details?.cache_write_tokens,
    usage.input_tokens_details?.cache_write_tokens,
  );
  const explicitTotal = firstFinite(usage.totalTokens, usage.total_tokens);
  const totalTokens = explicitTotal ?? (
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  );
  if ([inputTokens, outputTokens, reasoningTokens, totalTokens].every((value) => value === null)) return null;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === null ? {} : { cacheWriteTokens }),
  };
}

function extractEstimatedCosts(result, model, relayCreditToCny) {
  if (!result) return [];
  if (/^relay-gpt-5\.6-(?:sol|terra|luna)$/u.test(String(model || ""))) {
    const usage = extractUsage(result);
    if (!usage) return [];
    const canonicalModel = String(model).replace(/^relay-/u, "");
    const estimate = estimateOpenAIModelCost({
      model: canonicalModel,
      usage,
      reasoningMode: ["standard", "pro"].includes(result.reasoningMode)
        ? result.reasoningMode
        : "standard",
      pricing: OFFICIAL_MODEL_PRICING,
    });
    if (Number.isFinite(estimate.totalCostUsd)) {
      return [{
        currency: "USD",
        amount: estimate.totalCostUsd,
        source: "official_standard_api_list_price",
        verification: "official_list_rate_estimate",
        estimateOnly: true,
        pricingVersion: estimate.pricingVersion,
      }];
    }
  }
  const candidates = [];
  addCost(candidates, "CNY", result.estimatedCostCny, "estimatedCostCny");
  addCost(candidates, "USD", result.estimatedCostUsd, "estimatedCostUsd");
  const objects = [
    [result.estimatedCost, "estimatedCost"],
    [result.costEstimate, "costEstimate"],
    [result.metering?.estimatedCost, "metering.estimatedCost"],
    [result.metering?.totals?.estimatedCost, "metering.totals.estimatedCost"],
  ];
  for (const [value, source] of objects) {
    if (Number.isFinite(Number(value?.amount)) && optionalText(value?.currency)) {
      addCost(candidates, String(value.currency).toUpperCase(), value.amount, `${source}.amount`);
    }
    addCost(candidates, "CNY", value?.totalCostCny ?? value?.cny, `${source}.totalCostCny`);
    addCost(candidates, "USD", value?.totalCostUsd ?? value?.usd, `${source}.totalCostUsd`);
  }
  const byCurrency = new Map();
  for (const candidate of candidates) {
    if (!byCurrency.has(candidate.currency)) byCurrency.set(candidate.currency, candidate);
  }
  return [...byCurrency.values()];
}

function addCost(target, currency, amount, source) {
  if (amount === null || amount === undefined || amount === "") return;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric < 0) return;
  target.push({
    currency,
    amount: numeric,
    source,
    verification: "raw_record",
    estimateOnly: true,
  });
}

function summarizeEstimatedCosts(cases, planned, {
  semanticComplete = false,
  correctCount = 0,
} = {}) {
  const entries = cases.flatMap((item) => item.estimatedCost || []);
  if (entries.length === 0) return null;
  const caseCount = cases.filter((item) => item.estimatedCost?.length).length;
  const totals = {};
  const reportedCaseCountByCurrency = {};
  const sourceFields = new Set();
  const verification = new Set();
  const pricingVersions = new Set();
  let relayCreditTotal = 0;
  let relayCreditReported = false;
  for (const item of cases) {
    const currencies = unique((item.estimatedCost || []).map((entry) => entry.currency));
    for (const currency of currencies) {
      reportedCaseCountByCurrency[currency] = (reportedCaseCountByCurrency[currency] || 0) + 1;
    }
  }
  for (const entry of entries) {
    totals[entry.currency] = round((totals[entry.currency] || 0) + entry.amount, 9);
    sourceFields.add(entry.source);
    if (entry.verification) verification.add(entry.verification);
    if (entry.pricingVersion) pricingVersions.add(entry.pricingVersion);
    if (Number.isFinite(entry.relayCreditAmount)) {
      relayCreditTotal = round(relayCreditTotal + entry.relayCreditAmount, 9);
      relayCreditReported = true;
    }
  }
  const coverageByCurrency = Object.fromEntries(Object.keys(totals).sort().map((currency) => {
    const reportedCaseCount = reportedCaseCountByCurrency[currency] || 0;
    return [currency, {
      reportedCaseCount,
      plannedCaseCount: planned,
      complete: reportedCaseCount === planned,
    }];
  }));
  const completeCurrencies = new Set(Object.entries(coverageByCurrency)
    .filter(([, coverage]) => coverage.complete)
    .map(([currency]) => currency));
  const costsPerCorrectAnswer = semanticComplete && correctCount > 0
    ? Object.fromEntries(Object.entries(totals)
        .filter(([currency]) => completeCurrencies.has(currency))
        .map(([currency, amount]) => [currency, round(amount / correctCount, 9)]))
    : {};
  return {
    reportedCaseCount: caseCount,
    plannedCaseCount: planned,
    complete: Object.values(coverageByCurrency).every((coverage) => coverage.complete),
    coverageByCurrency,
    totals,
    averagesPerReportedCase: Object.fromEntries(
      Object.entries(totals).map(([currency, amount]) => [
        currency,
        round(amount / coverageByCurrency[currency].reportedCaseCount, 9),
      ]),
    ),
    costsPerCorrectAnswer: Object.keys(costsPerCorrectAnswer).length
      ? costsPerCorrectAnswer
      : null,
    sourceFields: [...sourceFields].sort(),
    verification: [...verification].sort(),
    pricingVersions: [...pricingVersions].sort(),
    relayCreditTotal: relayCreditReported ? relayCreditTotal : null,
  };
}

function normalizeDashboardMetadata(value) {
  if (value === null || value === undefined) return null;
  const rawBatches = Array.isArray(value) ? value : value.batches;
  if (!Array.isArray(rawBatches) || rawBatches.length === 0) {
    throw new TypeError("dashboard metadata must be a non-empty array or contain batches[]");
  }
  const batches = rawBatches.map((batch, index) => {
    const item = requiredObject(batch, `dashboard batch ${index + 1}`);
    const requestCount = item.requestCount === null || item.requestCount === undefined
      ? null
      : Number(item.requestCount);
    if (requestCount !== null && (!Number.isInteger(requestCount) || requestCount < 0)) {
      throw new TypeError(`dashboard batch ${index + 1} requestCount must be a non-negative integer`);
    }
    return {
      label: requiredText(item.label, `dashboard batch ${index + 1} label`),
      requestCount,
      before: finiteOrNull(item.before),
      after: finiteOrNull(item.after),
      delta: finiteOrNull(item.delta),
      unit: optionalText(item.unit),
      source: optionalText(item.source),
      note: optionalText(item.note),
      perRequestAllocation: null,
    };
  });
  return {
    attributionScope: "batch_only",
    perRequestAllocation: null,
    disclaimer: "Dashboard deltas are batch observations and are not allocated to individual requests.",
    batches,
  };
}

function normalizeCaseCatalog(value, caseIds) {
  const rawItems = Array.isArray(value) ? value : (Array.isArray(value?.cases) ? value.cases : []);
  const byId = new Map();
  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    const caseId = optionalText(item.caseId || item.id);
    if (!caseId || byId.has(caseId)) continue;
    byId.set(caseId, {
      question: optionalText(item.question || item.text),
      mechanism: optionalText(item.mechanism || item.category),
    });
  }
  return caseIds.map((caseId, index) => ({
    label: `Q${index + 1}`,
    caseId,
    question: byId.get(caseId)?.question || null,
    mechanism: byId.get(caseId)?.mechanism || null,
  }));
}

function numericSummary(values, { includeSum = false } = {}) {
  const usable = values.filter((value) => Number.isFinite(value)).map(Number).sort((a, b) => a - b);
  const result = {
    reportedCount: usable.length,
    average: usable.length ? round(usable.reduce((sum, value) => sum + value, 0) / usable.length) : null,
    median: usable.length ? round(median(usable)) : null,
  };
  if (includeSum) result.sum = usable.length ? round(usable.reduce((sum, value) => sum + value, 0)) : null;
  return result;
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function ratio(numerator, denominator) {
  return { numerator, denominator, rate: denominator ? round(numerator / denominator) : null };
}

function recordIdentity({ caseId, model, effort, evidenceVariant }) {
  return [caseId, model, effort, evidenceVariant || "full"].map((value) => String(value || "")).join("::");
}

function compareConfigurations(left, right) {
  const model = left.model.localeCompare(right.model, "en");
  if (model) return model;
  const leftEffort = EFFORT_ORDER.get(left.effort) ?? Number.MAX_SAFE_INTEGER;
  const rightEffort = EFFORT_ORDER.get(right.effort) ?? Number.MAX_SAFE_INTEGER;
  if (leftEffort !== rightEffort) return leftEffort - rightEffort;
  const effort = left.effort.localeCompare(right.effort, "en");
  if (effort) return effort;
  return left.evidenceVariant.localeCompare(right.evidenceVariant, "en");
}

function formatRatio(value) {
  return `${value.numerator}/${value.denominator} (${value.rate === null ? "n/a" : `${round(value.rate * 100, 1).toFixed(1)}%`})`;
}

function formatSemanticReview(value, text) {
  if (value?.planned === false) return text.ratings.not_planned;
  const review = value?.semanticReview;
  if (!review) return text.ratings.unreviewed;
  const kind = text.reviewKinds[review.reviewer?.kind] || review.reviewer?.kind || "?";
  const rating = text.ratings[review.rating] || review.rating;
  const failureKind = text.failureKinds?.[value.failureKind];
  if (!failureKind || review.rating !== "incorrect") return `${kind}: ${rating}`;
  const duration = Number.isFinite(value.durationMs)
    ? `, ${round(value.durationMs / 1000, 1).toFixed(1)} s`
    : "";
  return `${kind}: ${rating} (${failureKind}${duration})`;
}

function classifyResultFailure(result) {
  const code = optionalText(result?.error?.code);
  if (code === "relay_stream_timeout") return "timeout";
  if (code === "relay_empty_final_ruling") return "empty_response";
  return null;
}

function formatSemanticAccuracy(value) {
  if (!value || value.rate === null) {
    return value
      ? `${value.numerator}/${value.denominator} (n/a; ${value.determinateReviewCount}/${value.denominator})`
      : "—";
  }
  return formatRatio(value);
}

function selectCanonicalVariant(referenceCaseIdsByVariant) {
  if (referenceCaseIdsByVariant.has("full")) {
    return ["full", [...referenceCaseIdsByVariant.get("full")]];
  }
  const candidates = [...referenceCaseIdsByVariant.entries()].sort((left, right) => {
    const size = right[1].length - left[1].length;
    if (size) return size;
    const variant = left[0].localeCompare(right[0], "en");
    if (variant) return variant;
    return sortedSetKey(left[1]).localeCompare(sortedSetKey(right[1]), "en");
  });
  return candidates.length ? [candidates[0][0], [...candidates[0][1]]] : [null, []];
}

function formatEvidenceVariant(value, text) {
  const normalized = String(value || "full");
  return text.variants[normalized] || normalized;
}

function formatReturnedModel(configuration, text) {
  const missingLabel = text.noReturnedModel;
  if (configuration.returnedModel && !configuration.missingReturnedModelCount) {
    return configuration.returnedModel;
  }
  if (Array.isArray(configuration.observedReturnedModels) && configuration.observedReturnedModels.length) {
    const observed = configuration.observedReturnedModels.join(", ");
    return configuration.missingReturnedModelCount
      ? `${observed}, ${missingLabel} (${configuration.missingReturnedModelCount})`
      : observed;
  }
  return missingLabel;
}

function formatLatency(value) {
  if (value.average === null) return "—";
  return `${round(value.average / 1000, 1).toFixed(1)} / ${round(value.median / 1000, 1).toFixed(1)} s`;
}

function formatTokenMetric(value) {
  return value.sum === null ? "—" : `${formatInteger(value.sum)} (${value.reportedCount})`;
}

function formatEstimatedCost(value, text) {
  if (!value) return "—";
  const totals = Object.entries(value.totals).map(([currency, amount]) => {
    const average = value.averagesPerReportedCase?.[currency];
    const perCorrect = value.costsPerCorrectAnswer?.[currency];
    const coverage = value.coverageByCurrency?.[currency];
    const coverageSuffix = Object.keys(value.totals).length > 1 && coverage
      ? ` [${coverage.reportedCaseCount}/${coverage.plannedCaseCount}]`
      : "";
    return `${currency} ${round(amount, 6)} / ${round(average, 6)} / ${perCorrect === undefined ? "—" : round(perCorrect, 6)}${coverageSuffix}`;
  });
  const verification = value.verification.includes("unverified") ? text.unverified : "";
  const coverageLabel = totals.length > 1
    ? text.perCurrencyCoverage
    : `${value.reportedCaseCount}/${value.plannedCaseCount}`;
  return `${totals.join(" + ")} (${verification}${coverageLabel})`;
}

function markdownText(locale) {
  const normalized = String(locale || DEFAULT_MARKDOWN_LOCALE).trim().toLowerCase();
  if (!SUPPORTED_MARKDOWN_LOCALES.has(normalized)) {
    throw new TypeError(`unsupported Markdown locale: ${locale}`);
  }
  return MARKDOWN_TEXT[normalized];
}

function formatInteger(value) {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function nullable(value) {
  return value === null || value === undefined ? "—" : String(value);
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`expected a finite number, received ${value}`);
  return numeric;
}

function positiveNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new TypeError(`${label} must be a positive number`);
  return numeric;
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requiredText(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function optionalText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function isDirectRelayCheckpoint(checkpoint) {
  return DIRECT_RELAY_RUNNERS.has(optionalText(checkpoint?.runner));
}

function validateDirectRelayCheckpointContract(checkpoint, runIndex) {
  const prefix = `run ${runIndex + 1} Direct Relay`;
  if (checkpoint.schemaVersion !== 1) {
    throw new Error(`${prefix} schemaVersion must be 1`);
  }
  const model = requiredText(checkpoint.model, `${prefix} model`);
  const evidenceVariant = requiredText(
    checkpoint.evidenceVariant,
    `${prefix} evidenceVariant`,
  );
  const caseIds = requiredUniqueTextArray(checkpoint.caseIds, `${prefix} caseIds`);
  const efforts = requiredUniqueTextArray(checkpoint.efforts, `${prefix} efforts`)
    .map((effort) => effort.toLowerCase());
  if (new Set(efforts).size !== efforts.length) {
    throw new Error(`${prefix} efforts must be unique after normalization`);
  }
  for (const effort of efforts) {
    if (!EFFORT_ORDER.has(effort)) throw new Error(`${prefix} effort is unsupported: ${effort}`);
  }
  if (checkpoint.concurrency !== 1) throw new Error(`${prefix} concurrency must be 1`);
  if (checkpoint.retries !== 0) throw new Error(`${prefix} retries must be 0`);
  return {
    model,
    evidenceVariant,
    caseIds,
    caseIdSet: new Set(caseIds),
    efforts,
    effortSet: new Set(efforts),
  };
}

function requiredUniqueTextArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const normalized = value.map((item, index) => requiredText(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must contain unique values`);
  }
  return normalized;
}

function assertDirectRelayDescriptorMatchesCheckpoint(descriptor, contract, label) {
  if (descriptor.model !== contract.model) {
    throw new Error(`Direct Relay ${label} model must match checkpoint.model`);
  }
  if (descriptor.evidenceVariant !== contract.evidenceVariant) {
    throw new Error(`Direct Relay ${label} evidenceVariant must match checkpoint.evidenceVariant`);
  }
  if (!contract.caseIdSet.has(descriptor.caseId)) {
    throw new Error(`Direct Relay ${label} caseId is not declared by checkpoint.caseIds`);
  }
  if (!contract.effortSet.has(descriptor.effort)) {
    throw new Error(`Direct Relay ${label} effort is not declared by checkpoint.efforts`);
  }
}

function directRelayResultKey(caseId, model, effort, evidenceVariant) {
  const base = `${caseId}::${model}::${effort}`;
  return evidenceVariant === "full" ? base : `${base}::${evidenceVariant}`;
}

function isAllowedReturnedModel(requestedModel, returnedModel) {
  const requested = optionalText(requestedModel);
  const returned = optionalText(returnedModel);
  if (!requested || !returned) return false;
  return returned === requested
    || (requested.startsWith("relay-") && returned === requested.slice("relay-".length));
}

function explicitNullableText(object, field, label) {
  if (!Object.prototype.hasOwnProperty.call(object, field)) {
    throw new TypeError(`${label} must be present and may be null`);
  }
  if (object[field] === null) return null;
  return requiredText(object[field], label);
}

function unique(values) {
  return [...new Set(values)];
}

function sortedSetKey(values) {
  return [...new Set(values)].sort().join("\u0000");
}

function parseJson(serialized, label) {
  try {
    return JSON.parse(String(serialized));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error?.message || error}`);
  }
}

export function parseModelEffortMatrixArguments(argv) {
  const options = {
    pairs: [],
    checkpoints: [],
    scored: [],
    semanticReviewFiles: [],
    strictEvidence: true,
    relayCreditToCny: DEFAULT_RELAY_CREDIT_TO_CNY,
  };
  const take = (argument, index) => {
    if (index + 1 >= argv.length) throw new TypeError(`${argument} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--pair") {
      if (index + 2 >= argv.length) throw new TypeError("--pair requires CHECKPOINT and SCORED values");
      options.pairs.push({ checkpointFile: argv[index + 1], scoredFile: argv[index + 2] });
      index += 2;
    } else if (argument === "--checkpoint") {
      options.checkpoints.push(take(argument, index));
      index += 1;
    } else if (argument === "--scored") {
      options.scored.push(take(argument, index));
      index += 1;
    } else if (argument === "--semantic-review") {
      options.semanticReviewFiles.push(take(argument, index));
      index += 1;
    } else if (argument === "--dashboard-metadata") {
      options.dashboardMetadataFile = take(argument, index);
      index += 1;
    } else if (argument === "--case-metadata") {
      options.caseMetadataFile = take(argument, index);
      index += 1;
    } else if (argument === "--expected-case-count") {
      options.expectedCaseCount = Number(take(argument, index));
      index += 1;
    } else if (argument === "--relay-credit-to-cny") {
      options.relayCreditToCny = Number(take(argument, index));
      index += 1;
    } else if (argument === "--json-out") {
      options.jsonOut = take(argument, index);
      index += 1;
    } else if (argument === "--markdown-out") {
      options.markdownOut = take(argument, index);
      index += 1;
    } else if (argument === "--locale") {
      options.locale = take(argument, index).toLowerCase();
      if (!SUPPORTED_MARKDOWN_LOCALES.has(options.locale)) {
        throw new TypeError("--locale must be zh, en or ja");
      }
      index += 1;
    } else if (argument === "--allow-evidence-mismatch") {
      options.strictEvidence = false;
    } else if (argument === "--compact") {
      options.compact = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new TypeError(`unknown argument: ${argument}`);
    }
  }
  if (options.checkpoints.length !== options.scored.length) {
    throw new TypeError("--checkpoint and --scored counts must match");
  }
  options.pairs.push(...options.checkpoints.map((checkpointFile, index) => ({
    checkpointFile,
    scoredFile: options.scored[index],
  })));
  delete options.checkpoints;
  delete options.scored;
  return options;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseModelEffortMatrixArguments(argv);
  const stdout = dependencies.stdout || process.stdout;
  if (options.help) {
    stdout.write([
      "Usage: node scripts/aggregate-model-effort-matrix.mjs --pair CHECKPOINT.json SCORED.json [--pair ...]",
      "  [--semantic-review REVIEW.json] [--semantic-review ...]",
      "  [--expected-case-count 4] [--dashboard-metadata DASHBOARD.json]",
      "  [--case-metadata CASES.json]",
      "  [--relay-credit-to-cny 1]",
      "  [--json-out MATRIX.json] [--markdown-out MATRIX.md] [--locale zh|en|ja] [--allow-evidence-mismatch] [--compact]",
      "",
    ].join("\n"));
    return 0;
  }
  const report = await aggregateModelEffortMatrixFiles({
    pairs: options.pairs,
    semanticReviewFiles: options.semanticReviewFiles,
    dashboardMetadataFile: options.dashboardMetadataFile,
    caseMetadataFile: options.caseMetadataFile,
    expectedCaseCount: options.expectedCaseCount,
    strictEvidence: options.strictEvidence,
    relayCreditToCny: options.relayCreditToCny,
    readFileImpl: dependencies.readFileImpl,
    now: dependencies.now,
  });
  const markdown = renderModelEffortMatrixMarkdown(report, { locale: options.locale });
  const writeFileImpl = dependencies.writeFileImpl || writeFile;
  if (options.jsonOut) {
    await writeFileImpl(resolve(options.jsonOut), `${JSON.stringify(report, null, options.compact ? 0 : 2)}\n`, "utf8");
  }
  if (options.markdownOut) await writeFileImpl(resolve(options.markdownOut), markdown, "utf8");
  if (!options.jsonOut && !options.markdownOut) stdout.write(markdown);
  return 0;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
