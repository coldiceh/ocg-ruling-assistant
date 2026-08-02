"use strict";

// Card identities and aliases must come from the synchronized, versioned data set.
// Keeping an empty offline index prevents the browser fallback from silently
// treating a handful of historical examples as authoritative card knowledge.
const baseCardIndex = [];

const ui = {
  questionInput: document.querySelector("#questionInput"),
  analyzeButton: document.querySelector("#analyzeButton"),
  analyzeButtonText: document.querySelector("#analyzeButtonText"),
  rulingVersionButtons: [...document.querySelectorAll("[data-ruling-version]")],
  clearButton: document.querySelector("#clearButton"),
  resultGrid: document.querySelector("#resultGrid"),
  confidenceText: document.querySelector("#confidenceText"),
  verdictBlock: document.querySelector(".verdict-block"),
  verdictTitle: document.querySelector("#verdictTitle"),
  rulingBasisText: document.querySelector("#rulingBasisText"),
  answerVersionText: document.querySelector("#answerVersionText"),
  verdictBody: document.querySelector("#verdictBody"),
  subAnswersPanel: document.querySelector("#subAnswersPanel"),
  parserDebugPanel: document.querySelector("#parserDebugPanel"),
  parserDebugOutput: document.querySelector("#parserDebugOutput"),
  pipelineDebugToggle: document.querySelector("#pipelineDebugToggle"),
  modelStatusText: document.querySelector("#modelStatusText"),
  stepsTitle: document.querySelector("#stepsTitle"),
  stepsList: document.querySelector("#stepsList"),
  pipelineTimingPanel: document.querySelector("#pipelineTimingPanel"),
  pipelineStageList: document.querySelector("#pipelineStageList"),
  pipelineElapsedText: document.querySelector("#pipelineElapsedText"),
  questionsList: document.querySelector("#questionsList"),
  sourcesList: document.querySelector("#sourcesList"),
  simulationPanel: document.querySelector("#simulationPanel"),
  simulationStatus: document.querySelector("#simulationStatus"),
  simulationSummary: document.querySelector("#simulationSummary"),
  simulationDetails: document.querySelector("#simulationDetails"),
  sourceStatus: document.querySelector("#sourceStatus"),
  statusDot: document.querySelector(".status-dot"),
  syncInfo: document.querySelector("#syncInfo"),
  cardPanel: document.querySelector("#cardPanel"),
  cardTabs: document.querySelector("#cardTabs"),
  cardStatus: document.querySelector("#cardStatus"),
  cardPreview: document.querySelector("#cardPreview"),
  cardImage: document.querySelector("#cardImage"),
  cardImagePlaceholder: document.querySelector("#cardImagePlaceholder"),
  cardName: document.querySelector("#cardName"),
  cardMeta: document.querySelector("#cardMeta"),
  cardEffect: document.querySelector("#cardEffect"),
  cardSourceLink: document.querySelector("#cardSourceLink"),
  themeToggle: document.querySelector("#themeToggle"),
  budgetPanel: document.querySelector("#budgetPanel"),
  budgetSpentText: document.querySelector("#budgetSpentText"),
  budgetLimitText: document.querySelector("#budgetLimitText"),
  budgetHint: document.querySelector("#budgetHint"),
  budgetResetButton: document.querySelector("#budgetResetButton"),
  adminLabPanel: document.querySelector("#adminLabPanel"),
  adminLabWorkspace: document.querySelector("#adminLabWorkspace"),
  adminLoginForm: document.querySelector("#adminLoginForm"),
  adminPasswordInput: document.querySelector("#adminPasswordInput"),
  adminLoginButton: document.querySelector("#adminLoginButton"),
  adminLoginStatus: document.querySelector("#adminLoginStatus"),
  adminSessionBadge: document.querySelector("#adminSessionBadge"),
  adminLogoutButton: document.querySelector("#adminLogoutButton"),
  adminQuestionInput: document.querySelector("#adminQuestionInput"),
  adminCopyPublicQuestionButton: document.querySelector("#adminCopyPublicQuestionButton"),
  adminPreparationProviderSelect: document.querySelector("#adminPreparationProviderSelect"),
  adminPreparationModelSelect: document.querySelector("#adminPreparationModelSelect"),
  adminPreparationEffortSelect: document.querySelector("#adminPreparationEffortSelect"),
  adminPreparationModeSelect: document.querySelector("#adminPreparationModeSelect"),
  adminProviderSelect: document.querySelector("#adminProviderSelect"),
  adminModelSelect: document.querySelector("#adminModelSelect"),
  adminEffortSelect: document.querySelector("#adminEffortSelect"),
  adminModeSelect: document.querySelector("#adminModeSelect"),
  adminPromptVersionSelect: document.querySelector("#adminPromptVersionSelect"),
  adminStartButton: document.querySelector("#adminStartButton"),
  adminCancelButton: document.querySelector("#adminCancelButton"),
  adminRunStatus: document.querySelector("#adminRunStatus"),
  adminRunIdentity: document.querySelector("#adminRunIdentity"),
  adminElapsedText: document.querySelector("#adminElapsedText"),
  adminStageList: document.querySelector("#adminStageList"),
  adminResultSummary: document.querySelector("#adminResultSummary"),
  adminMetrics: document.querySelector("#adminMetrics"),
  adminEvidenceDetails: document.querySelector("#adminEvidenceDetails"),
  adminEvidenceSummary: document.querySelector("#adminEvidenceSummary"),
  adminEvidenceJson: document.querySelector("#adminEvidenceJson"),
  adminResultJson: document.querySelector("#adminResultJson"),
  adminExportJsonButton: document.querySelector("#adminExportJsonButton"),
  adminExportCsvButton: document.querySelector("#adminExportCsvButton"),
  adminRatingForm: document.querySelector("#adminRatingForm"),
  adminRatingSelect: document.querySelector("#adminRatingSelect"),
  adminRatingNotes: document.querySelector("#adminRatingNotes"),
  adminRatingButton: document.querySelector("#adminRatingButton"),
  adminRatingStatus: document.querySelector("#adminRatingStatus"),
  adminHistoryRefreshButton: document.querySelector("#adminHistoryRefreshButton"),
  adminHistoryStatus: document.querySelector("#adminHistoryStatus"),
  adminHistoryList: document.querySelector("#adminHistoryList"),
  adminQuestionHistoryRefreshButton: document.querySelector("#adminQuestionHistoryRefreshButton"),
  adminQuestionHistoryStatus: document.querySelector("#adminQuestionHistoryStatus"),
  adminQuestionHistoryList: document.querySelector("#adminQuestionHistoryList"),
  adminEvaluationRefreshButton: document.querySelector("#adminEvaluationRefreshButton"),
  adminEvaluationStatus: document.querySelector("#adminEvaluationStatus"),
  adminEvaluationSelect: document.querySelector("#adminEvaluationSelect"),
  adminEvaluationLoadButton: document.querySelector("#adminEvaluationLoadButton"),
};

let appConfig = {
  answerApiUrl: "",
  modelLabel: "",
  budgetApiUrl: "",
  engineEnabled: false,
  rulingVersionIds: ["latest"],
};
let syncedCards = [];
let sourceMeta = null;
let sourceLoadError = "";
let analysisRequestId = 0;
let analysisTimer = 0;
const cardDetailsCache = new Map();
let visibleCards = [];
let selectedCardIndex = 0;
let lastRenderedBackendAnswer = null;
let debugUiEnabled = false;
let adminUiEnabled = false;
let adminSession = {
  authenticated: false,
  csrfToken: "",
  expiresAt: "",
};
let adminCapabilityState = null;
let adminCurrentRun = null;
let adminCurrentRunId = "";
let adminAfterSequence = 0;
let adminFollowGeneration = 0;
let adminStreamAbortController = null;
let adminClientStartedAt = 0;
let adminElapsedTimer = 0;
let adminEvaluationCases = [];
const adminExecuteAttemptedRunIds = new Set();
const adminStageStates = new Map();
const adminCurrentRunStorageKey = "ocg-admin-current-run:v1";
const themeStorageKey = "ocg-ruling-theme:v1";
const selectedModelTier = "flash";
let selectedRulingVersion = "latest";
const pendingStages = [
  { id: "understand", label: "理解问题", body: "正在读取问题中的卡片、场面、连锁和时点。" },
  { id: "extract_card_names", label: "提取卡名", body: "正在识别卡名候选，并准备查询卡片资料。" },
  { id: "retrieve_card_texts", label: "检索卡片文本", body: "正在匹配本地资料、百鸽卡片资料和用户提供文本。" },
  { id: "retrieve_rulings", label: "检索规则资料", body: "正在查找相关 Q&A、FAQ 和规则资料。" },
  { id: "generate_ruling", label: "生成裁定", body: "正在根据检索上下文生成未确认裁定分析。" },
];
const simulationPendingStage = {
  id: "simulate",
  label: "编译模拟场景",
  body: "正在将已识别的卡片、区域和操作整理为尽力模拟场景。",
};
const pendingStageDelays = [0, 700, 1600, 2900, 4500, 6200];
let pendingStageTimers = [];
let pendingStageIndex = 0;
let pendingStageTickTimer = 0;
let pendingStageEnteredAt = [];
let pendingStageDurationsMs = [];
let pendingPipelineStartedAt = null;
let pendingPipelineTotalMs = null;
let pendingPipelineStatus = "idle";

function normalizeText(value) {
  return String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[－ー]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function getPendingStages() {
  if (!appConfig.engineEnabled) return pendingStages;
  return [
    ...pendingStages.slice(0, -1),
    simulationPendingStage,
    pendingStages[pendingStages.length - 1],
  ];
}

function allCards() {
  const merged = new Map();
  for (const card of [...syncedCards, ...baseCardIndex]) {
    const existing = merged.get(card.name);
    if (!existing) {
      merged.set(card.name, { ...card, aliases: [...new Set(card.aliases || [card.name])] });
    } else {
      existing.aliases = [...new Set([...(existing.aliases || []), ...(card.aliases || [])])];
      existing.note = existing.note || card.note;
      existing.vague = existing.vague || card.vague;
      existing.id = existing.id || card.id;
      existing.passcode = existing.passcode || card.passcode;
      existing.effectText = existing.effectText || card.effectText;
      existing.cardType = existing.cardType || card.cardType;
    }
  }
  return [...merged.values()];
}

async function loadSyncedData() {
  try {
    const cardsUrl = appConfig.answerApiUrl ? "data/cards-lite.json" : "data/cards.json";
    const [cardsPayload, metaPayload] = await Promise.all([
      readJson(cardsUrl).catch(() => ({ records: [] })),
      readJson("data/snapshot-meta.json"),
    ]);

    syncedCards = normalizeCardRecords(cardsPayload);
    sourceMeta = normalizeSourceMeta(metaPayload);
  } catch (error) {
    sourceLoadError = error instanceof Error ? error.message : String(error);
    syncedCards = [];
    sourceMeta = {
      status: "unavailable",
      generatedAt: null,
      freshnessDays: 0,
      sources: [],
    };
  }
}

async function loadAppConfig() {
  const payload = (await readOptionalJson("config.json")) || {};
  appConfig = {
    answerApiUrl: String(payload.answerApiUrl || "").trim(),
    budgetApiUrl: String(payload.budgetApiUrl || "").trim(),
    modelLabel: "",
    engineEnabled: false,
    rulingVersionIds: ["latest"],
  };
  if (!appConfig.budgetApiUrl) appConfig.budgetApiUrl = getBudgetApiUrl();
}

async function loadBackendModelInfo() {
  if (!appConfig.answerApiUrl) return;
  try {
    const response = await fetch(appConfig.answerApiUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`model info ${response.status}`);
    const info = await response.json();
    appConfig.modelLabel = formatModelInfo(info);
    appConfig.engineEnabled = info?.engineEnabled === true;
    appConfig.rulingVersionIds = normalizeRulingVersionCapabilities(info?.rulingVersions);
    syncRulingVersionButtons();
  } catch {
    appConfig.modelLabel = "后端自动选择";
    appConfig.engineEnabled = false;
    appConfig.rulingVersionIds = ["latest"];
    syncRulingVersionButtons();
  }
}

function normalizeRulingVersionCapabilities(versions) {
  const ids = Array.isArray(versions)
    ? versions
      .map((item) => normalizeRulingVersion(typeof item === "string" ? item : item?.id))
      .filter(Boolean)
    : [];
  return [...new Set(["latest", ...ids])];
}

function formatModelInfo(info) {
  if (!debugUiEnabled) return "裁定分析";
  if (!info?.enabled) return "RAG · Mock";
  const provider = modelProviderLabel(info.provider);
  return `RAG · ${provider}`;
}

async function readJson(url) {
  const response = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

async function readOptionalJson(url) {
  try {
    return await readJson(url);
  } catch {
    return null;
  }
}

function normalizeCardRecords(payload) {
  const records = payload?.records || payload?.cards || [];
  return records
    .map((record) => ({
      id: record.id || record.passcode || "",
      passcode: record.passcode || "",
      name: record.name || record.primaryName || record.cnName || record.jaName || record.enName,
      cnName: record.cnName || "",
      jaName: record.jaName || "",
      enName: record.enName || "",
      aliases: [
        record.name,
        record.primaryName,
        record.cnName,
        record.jaName,
        record.enName,
        ...(record.aliases || []),
      ].filter(Boolean),
      note: record.note || "",
      vague: Boolean(record.vague),
      cardType: record.cardType || "",
      effectText: record.effectText || "",
      sourceUrl: record.sourceUrl || "",
    }))
    .filter((record) => record.name);
}

function normalizeSourceMeta(payload) {
  return {
    status: payload?.status || "seed",
    generatedAt: payload?.generatedAt || null,
    freshnessDays: Number(payload?.freshnessDays || 7),
    sourceRevision: payload?.sourceRevision || null,
    sources: payload?.sources || [],
    warnings: payload?.warnings || [],
  };
}

function updateSourceStatus() {
  const freshness = getFreshness();
  if (ui.statusDot) ui.statusDot.className = `status-dot ${freshness.className}`.trim();
  if (ui.sourceStatus) {
    if (appConfig.answerApiUrl && sourceMeta?.generatedAt) {
      ui.sourceStatus.textContent = `资料服务 · ${formatDateTime(sourceMeta.generatedAt)}`;
    } else if (appConfig.answerApiUrl) {
      ui.sourceStatus.textContent = "资料服务";
    } else if (sourceMeta?.generatedAt) {
      ui.sourceStatus.textContent = `资料库已同步 · ${formatDateTime(sourceMeta.generatedAt)}`;
    } else {
      ui.sourceStatus.textContent = "资料库准备中";
    }
  }
  renderSyncInfo(freshness);
}

function getFreshness() {
  if (sourceLoadError) {
    return {
      label: "读取失败",
      className: "is-error",
      detail: "没有读取到同步快照，当前只使用保守模板。",
    };
  }

  if (!sourceMeta?.generatedAt) {
    return {
      label: "种子资料",
      className: "is-stale",
      detail: "还没有自动同步时间戳。上线后请启用 GitHub Actions 定时同步。",
    };
  }

  const generatedAt = new Date(sourceMeta.generatedAt);
  const ageMs = Date.now() - generatedAt.getTime();
  const freshnessMs = sourceMeta.freshnessDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(generatedAt.getTime())) {
    return {
      label: "时间异常",
      className: "is-error",
      detail: "快照时间戳无法解析，不能视作新资料。",
    };
  }

  if (ageMs > freshnessMs) {
    return {
      label: "已过期",
      className: "is-stale",
      detail: `快照超过 ${sourceMeta.freshnessDays} 天未更新，高风险裁定需要重新查官方资料。`,
    };
  }

  return {
    label: "已同步",
    className: "is-fresh",
    detail: `快照生成于 ${formatDateTime(sourceMeta.generatedAt)}。`,
  };
}

function renderSyncInfo(freshness) {
  if (!ui.syncInfo) return;
  clearElement(ui.syncInfo);
  ui.syncInfo.className = "sync-info";

  const summary = document.createElement("div");
  summary.className = "sync-card";
  appendText(summary, "strong", freshness.label);
  appendText(summary, "p", freshness.detail);
  if (sourceMeta?.sourceRevision) appendText(summary, "p", `来源 revision：${sourceMeta.sourceRevision}`);
  if (sourceLoadError) appendText(summary, "p", sourceLoadError);
  ui.syncInfo.appendChild(summary);

  for (const source of sourceMeta?.sources || []) {
    const node = document.createElement("div");
    node.className = "sync-card";
    appendText(node, "strong", source.name || source.id || "资料来源");
    if (source.url) {
      const link = document.createElement("a");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = source.url;
      node.appendChild(link);
    }
    if (source.role) appendText(node, "p", source.role);
    ui.syncInfo.appendChild(node);
  }

  for (const warning of sourceMeta?.warnings || []) {
    const node = document.createElement("div");
    node.className = "sync-card";
    appendText(node, "strong", "提醒");
    appendText(node, "p", warning);
    ui.syncInfo.appendChild(node);
  }
}

function formatDateTime(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getDetectedCards(text) {
  const normalized = normalizeText(text).toLowerCase();
  return allCards()
    .map((card) => {
      const alias = card.aliases
        .slice()
        .sort((a, b) => b.length - a.length)
        .find((item) => normalized.includes(normalizeText(item).toLowerCase()));
      return alias ? { ...card, matched: alias } : null;
    })
    .filter(Boolean);
}

async function analyzeQuestion() {
  const text = ui.questionInput.value.trim();
  const requestId = ++analysisRequestId;
  if (!text) {
    resetAnalysis();
    return;
  }

  if (appConfig.answerApiUrl) {
    const requestedRulingVersion = selectedRulingVersion;
    setQueryPending(true);
    renderPending();
    try {
      const answer = await requestBackendAnswer(text, requestedRulingVersion);
      if (requestId !== analysisRequestId) return;
      renderBackendAnswer(answer);
      return;
    } catch (error) {
      if (requestId !== analysisRequestId) return;
      console.error("Backend answer or ruling-version verification failed.", error);
      renderBackendVersionError(error, requestedRulingVersion);
      return;
    } finally {
      if (requestId === analysisRequestId) setQueryPending(false);
    }
  }

  renderBackendUnavailable(getDetectedCards(text));
}

async function requestBackendAnswer(text, requestedRulingVersion) {
  const backendMode = "rag";
  let response;
  try {
    response = await fetch(appConfig.answerApiUrl, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: text,
        mode: backendMode,
        modelTier: selectedModelTier,
        rulingVersion: requestedRulingVersion,
      }),
    });
  } catch (error) {
    throw createRulingVersionError({
      code: "ruling_version_request_failed",
      requestedVersion: requestedRulingVersion,
      cause: error,
    });
  }
  if (!response.ok) {
    throw createRulingVersionError({
      code: "ruling_version_request_failed",
      requestedVersion: requestedRulingVersion,
      status: response.status,
    });
  }
  const answer = await response.json();
  const rawEffectiveVersion = String(answer?.effectiveRulingVersion || "").trim();
  const rawRulingVersion = String(answer?.rulingVersion || "").trim();
  const reportedEffectiveVersion = normalizeRulingVersion(answer?.effectiveRulingVersion);
  const reportedRulingVersion = normalizeRulingVersion(answer?.rulingVersion);
  if (
    (rawEffectiveVersion && !reportedEffectiveVersion)
    || (rawRulingVersion && !reportedRulingVersion)
  ) {
    throw createRulingVersionError({
      code: "ruling_version_response_invalid",
      requestedVersion: requestedRulingVersion,
    });
  }
  if (
    reportedEffectiveVersion
    && reportedRulingVersion
    && reportedEffectiveVersion !== reportedRulingVersion
  ) {
    throw createRulingVersionError({
      code: "ruling_version_response_conflict",
      requestedVersion: requestedRulingVersion,
      effectiveVersion: reportedEffectiveVersion,
    });
  }
  let effectiveRulingVersion = reportedEffectiveVersion || reportedRulingVersion;
  let rulingVersionCompatibility = "";
  if (!effectiveRulingVersion) {
    if (requestedRulingVersion === "latest") {
      effectiveRulingVersion = "latest";
      rulingVersionCompatibility = "legacy_unversioned_latest";
    } else {
      throw createRulingVersionError({
        code: "ruling_version_unconfirmed",
        requestedVersion: requestedRulingVersion,
      });
    }
  }
  if (effectiveRulingVersion !== requestedRulingVersion) {
    throw createRulingVersionError({
      code: "ruling_version_mismatch",
      requestedVersion: requestedRulingVersion,
      effectiveVersion: effectiveRulingVersion,
    });
  }
  return {
    ...answer,
    requestedRulingVersion,
    effectiveRulingVersion,
    rulingVersionCompatibility,
  };
}

function normalizeRulingVersion(value) {
  const version = String(value || "").trim().toLowerCase();
  return version === "latest" || version === "previous" ? version : "";
}

function createRulingVersionError({
  code,
  requestedVersion,
  effectiveVersion = "",
  status = 0,
  cause,
}) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  error.requestedVersion = requestedVersion;
  error.effectiveVersion = effectiveVersion;
  error.status = status;
  return error;
}

function renderPending() {
  ui.resultGrid.hidden = false;
  renderAnswerVersion(null);
  renderCards([]);
  renderEngineSimulation(null, null);
  updateModelStatus("分析中");
  ui.verdictBlock.className = "result-block verdict-block";
  ui.confidenceText.textContent = "分析中";
  ui.verdictTitle.textContent = "正在分析";
  ui.rulingBasisText.textContent = "";
  ui.verdictBody.textContent = getPendingStages()[0].body;
  ui.stepsTitle.textContent = "裁定流程";
  ui.stepsList.hidden = true;
  renderSubAnswers([]);
  renderParserDebug(null);
  startPendingStages();
  renderList(ui.questionsList, []);
  renderSources([]);
}

function renderBackendAnswer(answer) {
  completePendingStages(answer);
  ui.stepsTitle.textContent = "理由";
  ui.stepsList.hidden = false;
  lastRenderedBackendAnswer = answer || null;
  renderAnswerVersion(answer);
  renderEngineSimulation(null, null);
  if (answer?.mode === "rag_baseline") {
    renderRagAnswer(answer);
    return;
  }
  if (answer?.pipeline === "fast_judge" || answer?.answerType) {
    renderFastJudgeAnswer(answer);
    return;
  }
  if (answer?.status === "data_source_missing") {
    ui.resultGrid.hidden = false;
    renderCards([]);
    updateModelStatus("数据源未初始化");
    ui.verdictBlock.className = "result-block verdict-block is-risky";
    ui.confidenceText.textContent = "不可用";
    ui.verdictTitle.textContent = "数据源未初始化";
    ui.rulingBasisText.textContent = "数据加载失败";
    ui.verdictBody.textContent = answer.message || "数据源未初始化，请先运行 node scripts/sync-data.mjs";
    renderSubAnswers([]);
    renderParserDebug({ dataHealth: answer.stats || {} });
    renderList(ui.stepsList, ["运行 node scripts/sync-data.mjs 后重新分析。"]);
    renderList(ui.questionsList, []);
    renderSources([]);
    renderFeedbackPanel(null);
    return;
  }
  const confidence = answer?.confidence || { label: "不能确定", className: "is-risky" };
  ui.resultGrid.hidden = false;
  renderCards(answer?.cards || []);
  updateModelStatus(modelStatusFromAnswer(answer));
  ui.verdictBlock.className = `result-block verdict-block ${confidence.className || ""}`.trim();
  ui.confidenceText.textContent = confidence.label || "不能确定";
  const hasCardResolutionIssue = (answer?.subAnswers || []).some((item) => item.cardResolutionIssue || item.clarification?.question?.includes("哪张卡"));
  ui.verdictTitle.textContent = answer?.mode === "confirmed"
    ? "官方直接裁定"
    : hasCardResolutionIssue
      ? "卡名需要确认"
      : answer?.verdictTitle || "后端没有返回结论";
  ui.rulingBasisText.textContent = answer?.rulingBasis || basisFromBackendMode(answer?.mode);
  ui.verdictBody.textContent = answer?.verdict || "暂时不能给确定裁定。";
  renderSubAnswers(answer?.subAnswers || []);
  renderParserDebug(answer?.parserDebug || null);
  renderList(ui.stepsList, answer?.steps || []);
  renderList(ui.questionsList, [...(answer?.needsConfirmation || []), ...(answer?.warnings || [])]);
  renderSources(answer?.sources || []);
  renderFeedbackPanel(answer);
}

function renderAnswerVersion(answer) {
  if (!ui.answerVersionText) return;
  const effectiveVersion = normalizeRulingVersion(
    answer?.effectiveRulingVersion || answer?.rulingVersion,
  );
  ui.answerVersionText.classList.remove("is-error");
  if (!effectiveVersion) {
    ui.answerVersionText.hidden = true;
    ui.answerVersionText.textContent = "";
    return;
  }
  const label = effectiveVersion === "previous" ? "上一版（兼容）" : "最新版";
  ui.answerVersionText.textContent = `本次回答：${label}`;
  ui.answerVersionText.hidden = false;
}

function renderBackendVersionError(error, requestedRulingVersion) {
  failPendingStages();
  lastRenderedBackendAnswer = null;
  ui.resultGrid.hidden = false;
  renderCards([]);
  renderEngineSimulation(null, null);
  renderParserDebug(null);
  renderFeedbackPanel(null);
  updateModelStatus("版本不可用");
  ui.verdictBlock.className = "result-block verdict-block is-risky";
  ui.confidenceText.textContent = "版本不可用";
  ui.verdictTitle.textContent = "无法确认回答版本";
  ui.rulingBasisText.textContent = "版本协议校验失败";
  const requestedLabel = requestedRulingVersion === "previous" ? "上一版（兼容）" : "最新版";
  const effectiveVersion = normalizeRulingVersion(error?.effectiveVersion);
  const effectiveLabel = effectiveVersion === "previous" ? "上一版（兼容）" : "最新版";
  ui.answerVersionText.classList.add("is-error");
  ui.answerVersionText.hidden = false;
  ui.answerVersionText.textContent = effectiveVersion
    ? `版本不可用：请求${requestedLabel}，后端返回${effectiveLabel}`
    : "版本未确认 / 不可用";
  ui.verdictBody.textContent = effectiveVersion
    ? "后端返回的实际版本与本次请求不一致，已拒绝展示该回答。"
    : "后端没有确认本次实际使用的回答版本，已拒绝展示回答，也不会降级到本地模板。";
  renderSubAnswers([]);
  ui.stepsTitle.textContent = "理由";
  ui.stepsList.hidden = false;
  renderList(ui.stepsList, ["请稍后重试；若问题持续存在，需要先完成前端与后端的版本协议部署。"]);
  renderList(ui.questionsList, [
    error?.status ? `后端返回 HTTP ${error.status}。` : "未取得可验证的版本化回答。",
  ]);
  renderSources([]);
}

function renderRagAnswer(answer) {
  ui.resultGrid.hidden = false;
  renderCards(answer?.resolvedCards || []);
  renderBudgetStatus(answer.debug?.budgetStatus || null);
  renderEngineSimulation(answer?.engine || null, answer?.engineSimulation || null);
  const labels = {
    official_confirmed: { confidence: "官方依据", className: "is-confirmed", title: "官方直接裁定", basis: "官方 direct Q&A" },
    rule_analysis: { confidence: "规则分析", className: "is-rule-derived", title: "裁定分析", basis: "卡片文本 / FAQ / 相关资料" },
    low_confidence_analysis: { confidence: "低置信", className: "is-risky", title: "低置信分析", basis: "资料不足或仅有弱相关资料" },
    needs_more_info: { confidence: "需要补充", className: "is-risky", title: "需要补充信息", basis: "当前检索资料不足" },
    budget_limited: { confidence: "预算限制", className: "is-risky", title: "今日预算已用完", basis: "API 预算守卫" },
  };
  const state = labels[answer.answerLevel] || labels.needs_more_info;
  const providerLabel = modelProviderLabel(answer.debug?.providerUsed);
  const modelLabel = answer.debug?.modelUsed || answer.debug?.modelName || "";
  updateModelStatus(debugUiEnabled
    ? (answer.debug?.dryRun ? "RAG MOCK" : [providerLabel, modelLabel].filter(Boolean).join(" · ") || "RAG")
    : "分析完成");
  ui.verdictBlock.className = `result-block verdict-block ${state.className}`;
  ui.confidenceText.textContent = state.confidence;
  ui.verdictTitle.textContent = state.title;
  ui.rulingBasisText.textContent = state.basis;
  ui.verdictBody.textContent = answer.shortAnswer || "当前无法给出可靠分析。";
  renderSubAnswers([]);
  ui.stepsTitle.textContent = "理由";
  ui.stepsList.hidden = false;
  renderList(ui.stepsList, answer.reasoning || []);
  renderList(ui.questionsList, [
    ...publicFormalQueryLines(answer.formalQueryResults || []),
    ...(answer.missingInfo || []),
    ...publicRiskLines(answer.riskFlags || []),
    ...(debugUiEnabled ? ragBudgetLines(answer.debug?.budgetStatus) : []),
  ]);
  renderSources((answer.usedEvidence || []).map((item) => ({
    label: ragEvidenceLabel(item.type),
    detail: item.title || item.id || "",
    id: item.id || "",
    url: item.sourceUrl || item.url || "",
  })));
  renderParserDebug(answer.debug || null);
  renderFeedbackPanel(answer);
}

function ragEvidenceLabel(type) {
  if (type === "official_qa") return "官方 Q&A";
  if (type === "card_text") return "卡片文本";
  if (type === "baige_card_text") return "百鸽卡片文本";
  if (type === "user_provided_text") return "用户提供文本";
  if (type === "rulebook") return "规则书资料";
  if (type === "operation_check") return "逐步证据判读";
  if (type === "formal_engine_proof") return "形式规则验证";
  if (type === "faq") return "FAQ";
  return "相关资料";
}

function publicFormalQueryLines(results) {
  if (!Array.isArray(results)) return [];
  return results.map((item, index) => {
    const queryId = String(item?.queryId || `问题 ${index + 1}`);
    const claim = String(item?.claimText || item?.predicate || "").trim();
    const prefix = `形式验证 ${queryId}`;
    const suffix = claim ? `：${claim}` : "";
    const verdict = String(item?.verdict || "UNKNOWN").toUpperCase();

    if ((verdict === "TRUE" || verdict === "FALSE") && item?.trusted === true) {
      return `${prefix}：${verdict}（证明已验证）${suffix}`;
    }

    const reasons = (Array.isArray(item?.unknownReasons) ? item.unknownReasons : [])
      .map((reason) => String(reason?.code || reason || "").trim())
      .filter(Boolean);
    const assumptions = (Array.isArray(item?.assumptions) ? item.assumptions : [])
      .map((assumption, assumptionIndex) => {
        if (typeof assumption === "string") return assumption.trim();
        return String(
          assumption?.type
          || assumption?.assumptionId
          || assumption?.assumesFactId
          || `假设 ${assumptionIndex + 1}`,
        ).trim();
      })
      .filter(Boolean);
    const parts = ["UNKNOWN（尚未得出结论，不等于“不能”）"];
    if (item?.conditional === true || assumptions.length) {
      parts.push(`条件分析所用假设：${assumptions.join("、") || "未提供假设说明"}`);
    }
    if (reasons.length) parts.push(`原因码：${[...new Set(reasons)].join("、")}`);
    return `${prefix}：${parts.join("；")}${suffix}`;
  });
}

function publicRiskLines(flags) {
  const hiddenExact = new Set([
    "model_omitted_used_evidence",
    "low_confidence_upgraded_to_rule_analysis_with_card_text",
    "needs_more_info_upgraded_to_rule_analysis_with_card_text",
    "needs_more_info_downgraded_to_low_confidence_with_evidence",
    "card_name_not_resolved_raw_query_fallback_used",
  ]);
  const hiddenPrefixes = [
    "persistent_budget_storage_missing",
    "budget_",
    "dropped_unknown_evidence:",
    "card_text_truncated:",
    "official_related_limited:",
    "faq_related_limited:",
    "raw_related_limited:",
    "baige_missing_",
    "baige_fetch_failed:",
    "baige_http_",
  ];
  return [...new Set(flags || [])]
    .filter((flag) => !hiddenExact.has(String(flag)))
    .filter((flag) => !hiddenPrefixes.some((prefix) => String(flag).startsWith(prefix)))
    .map(formatRiskFlag)
    .filter(Boolean);
}

function ragBudgetLines(status) {
  if (!status) return [];
  const lines = [];
  if (typeof status.estimatedThisCallCny === "number") {
    lines.push(`预算估算：本次 ${status.estimatedThisCallCny} 元，今日已用 ${status.spentTodayCny ?? 0}/${status.dailyBudgetCny ?? "?"} 元。`);
  }
  if (status.budgetStorage && status.budgetStorage !== "redis") {
    lines.push("预算提示：未配置持久预算存储时，Vercel 上这是 per-instance 软限制。");
  }
  return lines;
}

async function loadBudgetStatus() {
  if (!appConfig.budgetApiUrl) {
    renderBudgetStatus(null, "未配置后端预算接口。");
    updateBudgetResetVisibility(false);
    return;
  }
  try {
    const response = await fetch(appConfig.budgetApiUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`budget ${response.status}`);
    const status = await response.json();
    renderBudgetStatus(status);
    updateBudgetResetVisibility(Boolean(status?.resetEnabled));
  } catch {
    renderBudgetStatus(null, "暂时无法读取今日用量。");
    updateBudgetResetVisibility(false);
  }
}

async function resetBudgetStatus() {
  if (!appConfig.budgetApiUrl || !ui.budgetResetButton) return;
  const password = window.prompt("请输入重置额度密码");
  if (!password) return;
  ui.budgetResetButton.disabled = true;
  if (ui.budgetHint) ui.budgetHint.textContent = "正在重置今日额度...";
  try {
    const response = await fetch(appConfig.budgetApiUrl, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("owner authorization failed");
    }
    if (!response.ok) throw new Error(`budget reset ${response.status}`);
    renderBudgetStatus(await response.json(), "已重置今日累计用量。");
  } catch {
    renderBudgetStatus(null, "重置失败：没有权限或后端暂时不可用。");
  } finally {
    ui.budgetResetButton.disabled = false;
  }
}

function renderBudgetStatus(status, message = "") {
  if (!ui.budgetPanel) return;
  const storageMissing = status?.budgetStorage === "unconfigured"
    || (status?.budgetPersistent === false && status?.budgetStorage !== "memory");
  const spent = Number(status?.spentTodayCny);
  const limit = Number(status?.dailyBudgetCny);
  ui.budgetSpentText.textContent = storageMissing
    ? "未持久化"
    : Number.isFinite(spent) ? `${formatCny(spent)} 元` : "未读取";
  ui.budgetLimitText.textContent = Number.isFinite(limit) && limit > 0 ? ` / ${formatCny(limit)} 元` : "";
  const storage = status?.budgetStorage ? `存储：${status.budgetStorage}` : "";
  const mode = status?.budgetMode ? `模式：${status.budgetMode}` : "";
  ui.budgetHint.textContent = message
    || status?.storageWarning
    || [storage, mode].filter(Boolean).join(" · ")
    || "统计后端今日累计模型用量。";
}

function updateBudgetResetVisibility(resetEnabled) {
  if (!ui.budgetResetButton) return;
  ui.budgetResetButton.hidden = !resetEnabled;
}

function formatCny(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  if (number === 0) return "0";
  if (number < 0.0001) return number.toExponential(2);
  return number.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

function renderFastJudgeAnswer(answer) {
  ui.resultGrid.hidden = false;
  renderCards(answer?.cards || []);
  const labels = {
    direct_official: { confidence: "官方依据", className: "is-confirmed", basis: "官方 direct Q&A" },
    official_case_based: { confidence: "官方相似案例", className: "is-rule-derived", basis: "官方相似案例 / 条件推导" },
    rule_judgment: { confidence: "规则判断", className: "is-rule-derived", basis: "卡片文本与公开规则" },
    needs_clarification: { confidence: "需要补充", className: "is-risky", basis: "当前信息不足" },
    cannot_answer_safely: { confidence: "无法安全判断", className: "is-risky", basis: "验证未通过" },
  };
  const state = labels[answer.answerType] || labels.cannot_answer_safely;
  updateModelStatus(debugUiEnabled ? (answer.pending ? "Legacy · pending" : "Legacy") : "分析完成");
  ui.verdictBlock.className = `result-block verdict-block ${state?.className || "is-risky"}`;
  ui.confidenceText.textContent = answer.statusChip || state?.confidence || "NEEDS-INFO";
  const routeTitles = {
    official_qa_exact_match: "官方 Q&A 结论",
    official_qa_near_case_match: "官方相似案例",
    rule_engine_answer: "规则推导结论",
    conditional_branch_answer: "条件分支",
    needs_more_info: "需要补充信息",
  };
  ui.verdictTitle.textContent = answer.pending ? "正在深度判断" : routeTitles[answer.answerRoute] || "结论";
  ui.rulingBasisText.textContent = state?.basis || "验证未通过";
  ui.verdictBody.textContent = answer.shortAnswer || "当前无法安全判断。";
  renderSubAnswers([]);
  renderList(ui.stepsList, [
    ...(answer.normalRuling?.reason ? [`正常情况下：${answer.normalRuling.reason}`] : []),
    ...(answer.judgeReasoning || []).map((item) => item.text).filter(Boolean),
    ...(answer.hypotheticalBranch?.assumption ? [`假设情况下：${answer.hypotheticalBranch.assumption}`] : []),
    ...(answer.conditionalBranches || []).map((item) => `如果${String(item.condition || "").replace(/^如果/u, "")}：${item.result || ""}`),
    ...fastJudgeRuleDomainLines(answer),
    ...(answer.resolutionSteps || []).map((item) => `处理顺序 ${item.chainLink || ""}：${item.action || ""}`),
    ...(answer.finalJudgeSummary || []).map((item) => `裁定式总结：${item}`),
    ...(answer.warnings || []),
  ]);
  const required = [
    ...(answer.requiredFacts || []),
    ...(answer.unresolvedCardPrompts || []).map((item) => {
      const candidates = (item.candidateCards || []).map((card) => card.name).filter(Boolean).join("、");
      return `请确认卡名“${item.unresolvedCardName}”${candidates ? `；候选：${candidates}` : ""}`;
    }),
  ];
  renderList(ui.questionsList, required);
  renderSources(fastJudgeSources(answer.sourceSummary));
  renderParserDebug(answer.debug || null);
  renderFeedbackPanel(answer);
}

function fastJudgeRuleDomainLines(answer) {
  const lines = [];
  const damage = answer.damageStepAnalysis;
  if (damage?.isDamageStep) {
    const subphases = {
      damage_step_start: "伤害步骤开始时",
      before_damage_calculation: "伤害计算前",
      during_damage_calculation: "伤害计算时",
      after_damage_calculation: "伤害计算后",
      damage_step_end: "伤害步骤结束时",
      unknown_damage_step_timing: "伤害步骤内的具体时点尚未确认",
    };
    const permission = damage.allowedInDamageStep === true ? "该效果类别可继续进行发动合法性检查"
      : damage.allowedInDamageStep === false ? "该效果类别没有伤害步骤发动许可"
        : "尚不能确定该效果类别是否允许发动";
    lines.push(`伤害步骤分析：${subphases[damage.subphase] || "具体时点待确认"}；${permission}。`);
  }
  const timing = answer.triggerTimingAnalysis;
  if (timing) {
    const labels = {
      optional_when: "可选的“当……时”诱发",
      optional_if: "可选的“如果……的场合”诱发",
      mandatory_when: "强制的“当……时”诱发",
      mandatory_if: "强制的“如果……的场合”诱发",
      unknown: "诱发措辞尚未确认",
    };
    const result = timing.canActivate === false ? "诱发事件不是最后发生事件，不能发动"
      : timing.canActivate === true ? "未被可选诱发的错过时点规则拦截"
        : "仍需确认事件顺序或同时诱发排序";
    lines.push(`诱发时点分析：${labels[timing.triggerType] || labels.unknown}；${result}。`);
  }
  return lines;
}

function fastJudgeSources(summary = {}) {
  const groups = [
    ["卡片文本", summary.cardTextRefs],
    ["官方 Q&A / FAQ", summary.officialQaRefs],
    ["规则片段", summary.ruleRefs],
    ["类比资料", summary.analogyRefs],
  ];
  return groups.flatMap(([label, refs]) => (refs || []).map((ref) => ({ label, detail: String(ref) })));
}

function setQueryPending(isPending) {
  if (!ui.analyzeButton) return;
  ui.analyzeButton.disabled = Boolean(isPending);
  ui.analyzeButton.setAttribute("aria-busy", String(Boolean(isPending)));
  syncRulingVersionButtons(Boolean(isPending));
  if (ui.analyzeButtonText) {
    ui.analyzeButtonText.textContent = isPending ? "查询中…" : "查询";
  }
}

function syncRulingVersionButtons(isPending = false) {
  for (const button of ui.rulingVersionButtons || []) {
    const version = normalizeRulingVersion(button.dataset.rulingVersion);
    const supported = isRulingVersionSupported(version);
    const disabled = Boolean(isPending) || !supported;
    button.disabled = disabled;
    button.setAttribute("aria-disabled", String(disabled));
    button.title = supported ? "" : "当前后端暂未提供上一版兼容实现";
  }
}

function isRulingVersionSupported(version) {
  return version === "latest" || appConfig.rulingVersionIds.includes(version);
}
function resetAnalysis() {
  setQueryPending(false);
  clearPendingStages();
  lastRenderedBackendAnswer = null;
  renderAnswerVersion(null);
  ui.resultGrid.hidden = true;
  renderCards([]);
  renderEngineSimulation(null, null);
  renderParserDebug(null);
  renderFeedbackPanel(null);
  updateModelStatus(debugUiEnabled ? appConfig.modelLabel || "后端自动选择" : "准备就绪");
}

function renderParserDebug(debug) {
  if (!ui.parserDebugPanel || !ui.parserDebugOutput) return;
  if (!debugUiEnabled || !debug) {
    ui.parserDebugPanel.hidden = true;
    ui.parserDebugOutput.textContent = "";
    return;
  }
  ui.parserDebugPanel.hidden = false;
  ui.parserDebugOutput.textContent = JSON.stringify(debug, null, 2);
  console.debug("[Formal Query Trace]", debug);
}

function renderBackendUnavailable(detectedCards = []) {
  clearPendingStages();
  lastRenderedBackendAnswer = null;
  renderAnswerVersion(null);
  ui.resultGrid.hidden = false;
  renderCards(detectedCards);
  renderEngineSimulation(null, null);
  renderParserDebug(null);
  renderFeedbackPanel(null);
  updateModelStatus("服务不可用");
  ui.verdictBlock.className = "result-block verdict-block is-risky";
  ui.confidenceText.textContent = "无法裁定";
  ui.verdictTitle.textContent = "裁定服务不可用";
  ui.rulingBasisText.textContent = "后端裁定服务未配置";
  ui.verdictBody.textContent =
    "当前页面没有可用的后端裁定服务，无法生成或验证这道题的裁定。已识别的本地卡片资料仅供查看，不会被当作裁定答案。";
  renderSubAnswers([]);
  ui.stepsTitle.textContent = "理由";
  ui.stepsList.hidden = false;
  renderList(ui.stepsList, ["请在后端裁定服务恢复或完成配置后重试。"]);
  renderList(ui.questionsList, []);
  renderSources([]);
}

function renderCards(cards) {
  visibleCards = normalizeVisibleCards(cards);
  selectedCardIndex = 0;
  clearElement(ui.cardTabs);

  if (!visibleCards.length) {
    ui.cardPanel.hidden = true;
    ui.cardPreview.hidden = true;
    ui.cardStatus.textContent = "";
    return;
  }

  ui.cardPanel.hidden = false;
  ui.cardStatus.textContent = `${visibleCards.length} 张`;

  visibleCards.forEach((card, index) => {
    const button = document.createElement("button");
    button.className = `card-tab ${index === selectedCardIndex ? "is-active" : ""}`.trim();
    button.type = "button";
    button.textContent = cardDisplayName(card);
    button.title = card.matched ? `匹配到：${card.matched}` : cardDisplayName(card);
    button.addEventListener("click", () => selectCard(index));
    ui.cardTabs.appendChild(button);
  });

  selectCard(0);
}

function normalizeVisibleCards(cards) {
  const normalizedCards = (cards || []).map((card) => ({
    id: String(card.id || card.cardId || "").trim(),
    passcode: String(card.passcode || card.cardId || card.id || "").trim(),
    name: String(card.name || card.cnName || card.jaName || card.enName || "").trim(),
    cnName: String(card.cnName || "").trim(),
    jaName: String(card.jaName || card.jpName || "").trim(),
    enName: String(card.enName || "").trim(),
    matched: String(card.matched || "").trim(),
    cardType: String(card.cardType || card.type || "").trim(),
    effectText: String(card.effectText || card.text || "").trim(),
    source: String(card.source || "").trim(),
    sourceLabel: String(card.sourceLabel || "").trim(),
    official: card.official === true,
    sourceUrl: String(card.sourceUrl || "").trim(),
    imageUrl: String(card.imageUrl || "").trim(),
    imageCandidates: Array.isArray(card.imageCandidates) ? card.imageCandidates.map((url) => String(url || "").trim()).filter(Boolean) : [],
    ygoResourcesUrl: String(card.ygoResourcesUrl || "").trim(),
    liveId: String(card.liveId || "").trim(),
    aliases: Array.isArray(card.aliases) ? card.aliases.map((alias) => String(alias || "").trim()).filter(Boolean) : [],
  })).filter((card) => card.name);
  const ambiguousAliasKeys = collectAmbiguousVisibleAliasKeys(normalizedCards);
  const map = new Map();
  for (const normalized of normalizedCards) {
    const key = findVisibleMergeKey(map, normalized, ambiguousAliasKeys) || canonicalVisibleCardKey(normalized);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, normalized);
      continue;
    }
    existing.effectText = preferChineseDisplayText(existing.effectText, normalized.effectText);
    existing.matched = existing.matched || normalized.matched;
    existing.cnName = existing.cnName || normalized.cnName;
    existing.jaName = existing.jaName || normalized.jaName;
    existing.enName = existing.enName || normalized.enName;
    existing.name = preferVisibleDisplayName(existing, normalized);
    existing.passcode = existing.passcode || normalized.passcode;
    existing.source = existing.source || normalized.source;
    existing.sourceLabel = existing.sourceLabel || normalized.sourceLabel;
    existing.official = existing.official || normalized.official;
    existing.sourceUrl = existing.sourceUrl || normalized.sourceUrl;
    existing.imageUrl = existing.imageUrl || normalized.imageUrl;
    existing.imageCandidates = [...new Set([...(existing.imageCandidates || []), ...(normalized.imageCandidates || [])])];
    existing.ygoResourcesUrl = existing.ygoResourcesUrl || normalized.ygoResourcesUrl;
    existing.liveId = existing.liveId || normalized.liveId;
    existing.aliases = [...new Set([...(existing.aliases || []), ...(normalized.aliases || [])])];
  }
  return [...map.values()];
}

function findVisibleMergeKey(map, card, ambiguousAliasKeys = new Set()) {
  const key = canonicalVisibleCardKey(card);
  if (map.has(key)) return key;
  const keys = visibleCardIdentityKeys(card, ambiguousAliasKeys);
  for (const [existingKey, existing] of map.entries()) {
    const existingKeys = visibleCardIdentityKeys(existing, ambiguousAliasKeys);
    if ([...keys].some((item) => existingKeys.has(item))) return existingKey;
  }
  return "";
}

function canonicalVisibleCardKey(card) {
  const numeric = normalizeCardId(card.passcode || card.id || card.liveId);
  if (numeric) return `id:${numeric}`;
  const sourceId = extractCardIdFromUrl(card.ygoResourcesUrl || card.sourceUrl);
  const normalizedSourceId = normalizeCardId(sourceId);
  if (normalizedSourceId) return `id:${normalizedSourceId}`;
  return `name:${normalizeText(card.name).toLowerCase()}`;
}

function visibleCardIdentityKeys(card, ambiguousAliasKeys = new Set()) {
  const keys = new Set();
  const numeric = normalizeCardId(card.passcode || card.id || card.liveId);
  if (numeric) keys.add(`id:${numeric}`);
  const sourceId = extractCardIdFromUrl(card.ygoResourcesUrl || card.sourceUrl);
  const normalizedSourceId = normalizeCardId(sourceId);
  if (normalizedSourceId) keys.add(`id:${normalizedSourceId}`);
  for (const alias of [card.name, card.cnName, card.jaName, card.enName, card.matched, ...(card.aliases || [])]) {
    const key = normalizeText(alias).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (key.length >= 3 && !ambiguousAliasKeys.has(key)) keys.add(`alias:${key}`);
  }
  return keys;
}

function preferVisibleDisplayName(existing, card) {
  const candidates = [existing.cnName, card.cnName, existing.name, card.name, existing.jaName, card.jaName, existing.enName, card.enName]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return candidates.find((item) => /[\u3400-\u9fff]/.test(item)) || candidates[0] || "";
}

function preferChineseDisplayText(left, right) {
  const current = String(left || "").trim();
  const next = String(right || "").trim();
  if (!current) return next;
  if (next && /[\u3400-\u9fff]/.test(next) && !/[\u3400-\u9fff]/.test(current)) return next;
  return current;
}

function collectAmbiguousVisibleAliasKeys(cards = []) {
  const identitiesByAlias = new Map();
  for (const card of cards) {
    const identity = canonicalVisibleCardKey(card);
    if (!identity || identity === "name:") continue;
    for (const alias of [card.name, card.cnName, card.jaName, card.enName, card.matched, ...(card.aliases || [])]) {
      const key = normalizeText(alias).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      if (key.length < 3) continue;
      const identities = identitiesByAlias.get(key) || new Set();
      identities.add(identity);
      identitiesByAlias.set(key, identities);
    }
  }
  return new Set(
    [...identitiesByAlias.entries()]
      .filter(([, identities]) => identities.size > 1)
      .map(([key]) => key),
  );
}

function normalizeCardId(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (!digits) return "";
  return digits.length <= 8 ? digits.padStart(8, "0") : digits;
}

function extractCardIdFromUrl(url) {
  const match = String(url || "").match(/\/(?:card|data\/card)\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function selectCard(index) {
  selectedCardIndex = index;
  const card = visibleCards[index];
  if (!card) return;

  [...ui.cardTabs.querySelectorAll(".card-tab")].forEach((button, buttonIndex) => {
    button.classList.toggle("is-active", buttonIndex === index);
  });

  ui.cardPreview.hidden = false;
  renderCardDetail(card, null, "loading");
  loadCardDetail(card).then((detail) => {
    if (visibleCards[selectedCardIndex] !== card) return;
    renderCardDetail(card, detail, detail ? "ready" : "fallback");
  });
}

async function loadCardDetail(card) {
  const key = card.passcode || card.id || card.name;
  if (cardDetailsCache.has(key)) return cardDetailsCache.get(key);
  if (card.source === "user_provided_text") {
    cardDetailsCache.set(key, null);
    return null;
  }

  const endpoint = getCardApiUrl();
  if (!endpoint) {
    cardDetailsCache.set(key, null);
    return null;
  }

  const url = new URL(endpoint);
  const numericId = card.passcode || (/^\d{7,12}$/.test(card.id) ? card.id : "");
  if (numericId) url.searchParams.set("id", numericId);
  url.searchParams.set("name", card.cnName || card.name);
  if (card.jaName) url.searchParams.set("jaName", card.jaName);
  if (card.enName) url.searchParams.set("enName", card.enName);

  try {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`card api ${response.status}`);
    const detail = await response.json();
    cardDetailsCache.set(key, detail);
    return detail;
  } catch {
    cardDetailsCache.set(key, null);
    return null;
  }
}

const ADMIN_STAGES = [
  { id: "understand", label: "理解问题" },
  { id: "extract_card_names", label: "提取卡名" },
  { id: "retrieve_card_texts", label: "检索卡片文本" },
  { id: "retrieve_rulings_evidence", label: "检索裁定与证据" },
  { id: "generate_ruling", label: "生成最终裁定" },
];

const ADMIN_TERMINAL_STATUSES = new Set([
  "completed",
  "succeeded",
  "failed",
  "cancelled",
  "canceled",
]);

async function initializeAdminLab() {
  if (!adminUiEnabled || !ui.adminLabPanel) return;
  resetAdminStageStates();
  renderAdminStageStates();
  setAdminAuthenticated(false);
  setAdminLoginStatus("正在确认登录状态…");
  try {
    const payload = await requestAdminAuth("session");
    setAdminAuthenticated(payload.authenticated === true, payload);
    if (payload.authenticated === true) await loadAdminLabBootstrap();
  } catch (error) {
    setAdminAuthenticated(false);
    setAdminLoginStatus(adminErrorMessage(error, "尚未登录，请输入管理员密码。"));
  }
}

async function handleAdminLogin(event) {
  event.preventDefault();
  const password = String(ui.adminPasswordInput?.value || "");
  if (!password) {
    setAdminLoginStatus("请输入管理员密码。", "error");
    return;
  }
  ui.adminLoginButton.disabled = true;
  setAdminLoginStatus("正在登录…");
  try {
    const payload = await requestAdminAuth("login", { password });
    if (ui.adminPasswordInput) ui.adminPasswordInput.value = "";
    setAdminAuthenticated(payload.authenticated === true, payload);
    await loadAdminLabBootstrap();
  } catch (error) {
    setAdminAuthenticated(false);
    setAdminLoginStatus(adminErrorMessage(error, "登录失败。"), "error");
  } finally {
    ui.adminLoginButton.disabled = false;
  }
}

async function handleAdminLogout() {
  ui.adminLogoutButton.disabled = true;
  try {
    await requestAdminAuth("logout");
  } catch (error) {
    setAdminLoginStatus(adminErrorMessage(error, "退出登录失败。"), "error");
    ui.adminLogoutButton.disabled = false;
    return;
  }
  stopFollowingAdminRun();
  clearStoredAdminRunId();
  adminCurrentRun = null;
  adminCurrentRunId = "";
  setAdminAuthenticated(false);
  setAdminLoginStatus("已安全退出。");
}

async function requestAdminAuth(action, body = {}) {
  const isSessionRead = action === "session";
  const headers = { accept: "application/json" };
  if (!isSessionRead) {
    headers["content-type"] = "application/json";
    if (action === "logout" && adminSession.csrfToken) {
      headers["x-csrf-token"] = adminSession.csrfToken;
    }
  }
  const response = await fetch(getAdminEndpointUrl("/api/admin-auth"), {
    method: isSessionRead ? "GET" : "POST",
    cache: "no-store",
    credentials: "include",
    headers,
    ...(isSessionRead ? {} : { body: JSON.stringify({ action, ...body }) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw createAdminRequestError(response.status, payload);
  }
  return payload;
}

function setAdminAuthenticated(authenticated, payload = {}) {
  adminSession = {
    authenticated: authenticated === true,
    csrfToken: authenticated === true ? String(payload.csrfToken || adminSession.csrfToken || "") : "",
    expiresAt: authenticated === true ? String(payload.expiresAt || "") : "",
  };
  if (ui.adminLabWorkspace) ui.adminLabWorkspace.hidden = !adminSession.authenticated;
  if (ui.adminLoginForm) ui.adminLoginForm.hidden = adminSession.authenticated;
  if (ui.adminLogoutButton) {
    ui.adminLogoutButton.hidden = !adminSession.authenticated;
    ui.adminLogoutButton.disabled = false;
  }
  if (ui.adminSessionBadge) {
    ui.adminSessionBadge.textContent = adminSession.authenticated ? "已登录" : "未登录";
    ui.adminSessionBadge.classList.toggle("is-authenticated", adminSession.authenticated);
  }
  if (adminSession.authenticated) {
    const expires = formatAdminDate(adminSession.expiresAt);
    setAdminLoginStatus(expires ? `登录有效期至 ${expires}` : "管理员登录有效。");
  } else {
    adminCapabilityState = null;
    setAdminControlsEnabled(false);
  }
}

function setAdminLoginStatus(message, tone = "") {
  if (!ui.adminLoginStatus) return;
  ui.adminLoginStatus.textContent = String(message || "");
  ui.adminLoginStatus.classList.toggle("is-error", tone === "error");
  ui.adminLoginStatus.classList.toggle("is-good", tone === "good");
}

async function loadAdminLabBootstrap() {
  setAdminLoginStatus("管理员登录有效。", "good");
  await loadAdminCapabilities();
  await Promise.allSettled([
    adminFeatureEnabled("history") ? loadAdminHistory() : showAdminFeatureUnavailable("history"),
    loadAdminQuestionHistory(),
    adminFeatureEnabled("evaluation") ? loadAdminEvaluationCases() : showAdminFeatureUnavailable("evaluation"),
  ]);
  await restoreStoredAdminRun();
}

async function loadAdminCapabilities() {
  setAdminControlsEnabled(false);
  setAdminRunStatus("正在读取可用模型与配置…");
  try {
    const data = await requestAdminLab({
      method: "GET",
      action: "capabilities",
    });
    adminCapabilityState = normalizeAdminCapabilities(data);
    renderAdminCapabilities(adminCapabilityState);
    const hasModels = adminCapabilityState.models.length > 0
      && adminCapabilityState.preparationModels.length > 0;
    setAdminControlsEnabled(hasModels);
    setAdminRunStatus(hasModels ? "配置已就绪，可以开始实验。" : "后端没有返回可用模型。", hasModels ? "good" : "error");
  } catch (error) {
    adminCapabilityState = null;
    setAdminControlsEnabled(false);
    setAdminRunStatus(adminErrorMessage(error, "暂时无法读取可用模型。"), "error");
  }
}

function normalizeAdminCapabilities(data) {
  const source = data?.capabilities || data || {};
  const providerSource = Array.isArray(source.providers)
    ? source.providers
    : source.providers?.providers;
  const rawProviders = normalizeAdminOptionList(providerSource);
  const rawModels = [];
  const providerModelById = new Map();
  for (const provider of rawProviders) {
    if (!provider || typeof provider === "string" || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      const id = String(typeof model === "string" ? model : model?.modelId || model?.id || "");
      if (id) providerModelById.set(id, typeof model === "string" ? { id } : model);
    }
  }

  if (Array.isArray(source.models)) {
    rawModels.push(...source.models);
  } else if (source.models && typeof source.models === "object") {
    for (const [modelId, descriptor] of Object.entries(source.models)) {
      if (Array.isArray(descriptor)) {
        for (const model of descriptor) {
          rawModels.push(typeof model === "string"
            ? { id: model, provider: modelId }
            : { ...model, provider: model.provider || model.providerId || modelId });
        }
      } else if (descriptor && typeof descriptor === "object") {
        rawModels.push({
          id: modelId,
          ...descriptor,
          ...(providerModelById.get(modelId) || {}),
        });
      }
    }
  }

  for (const provider of rawProviders) {
    if (!provider || typeof provider === "string" || !Array.isArray(provider.models)) continue;
    const providerId = provider.providerId || provider.id || provider.value || provider.name;
    for (const model of provider.models) {
      const descriptor = typeof model === "string" ? source.models?.[model] : model;
      rawModels.push(typeof descriptor === "string" || !descriptor
        ? { id: model, provider: providerId }
        : {
            ...descriptor,
            id: descriptor.id || descriptor.modelId || model,
            provider: descriptor.provider || descriptor.providerId || providerId,
          });
    }
  }

  const normalizedModels = uniqueAdminOptions(rawModels
    .map((item) => normalizeAdminModelOption(item, source))
    .filter((item) => item.available !== false));
  const hasStageCapabilities = normalizedModels.some((item) => Array.isArray(item.allowedStages));
  const models = hasStageCapabilities
    ? normalizedModels.filter((item) => (
        item.allowedStages.includes("final_ruling")
        || item.allowedStages.includes("experimental_final_ruling")
      ))
    : normalizedModels;
  const preparationModels = hasStageCapabilities
    ? normalizedModels.filter((item) => item.allowedStages.includes("evidence_preparation"))
    : normalizedModels.filter((item) => item.provider !== "openai");
  const inferredProviders = models.map((model) => ({ id: model.provider, label: adminProviderLabel(model.provider) }));
  const providers = uniqueAdminOptions([
    ...rawProviders.map(normalizeAdminBasicOption),
    ...inferredProviders,
  ]).filter((item) => item.id && models.some((model) => model.provider === item.id));
  const inferredPreparationProviders = preparationModels.map((model) => ({
    id: model.provider,
    label: adminProviderLabel(model.provider),
  }));
  const preparationProviders = uniqueAdminOptions([
    ...rawProviders.map(normalizeAdminBasicOption),
    ...inferredPreparationProviders,
  ]).filter((item) => item.id && preparationModels.some((model) => model.provider === item.id));

  return {
    providers,
    models,
    preparationProviders,
    preparationModels,
    efforts: uniqueAdminOptions(normalizeAdminOptionList(
      source.reasoningEfforts || source.efforts || source.reasoning_efforts,
    ).map(normalizeAdminBasicOption)),
    modes: uniqueAdminOptions(normalizeAdminOptionList(source.modes).map(normalizeAdminBasicOption)),
    promptVersions: uniqueAdminOptions(normalizeAdminOptionList(
      source.promptVersions || source.prompt_versions || source.prompts,
    ).map(normalizeAdminBasicOption)),
    features: source.features && typeof source.features === "object" ? source.features : {},
  };
}

function normalizeAdminOptionList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.entries(value).map(([id, item]) => {
      if (item && typeof item === "object" && !Array.isArray(item)) return { id, ...item };
      return { id, label: String(item || id) };
    });
  }
  return [];
}

function normalizeAdminBasicOption(item) {
  if (typeof item === "string") return { id: item, label: item };
  return {
    ...item,
    id: String(
      item?.id
      || item?.value
      || item?.providerId
      || item?.modelId
      || item?.name
      || item?.model
      || "",
    ),
    label: String(
      item?.label
      || item?.displayName
      || item?.providerId
      || item?.modelId
      || item?.id
      || item?.value
      || item?.name
      || "",
    ),
  };
}

function normalizeAdminModelOption(item, source) {
  const normalized = normalizeAdminBasicOption(item);
  const provider = String(item?.provider || item?.providerId || (
    normalized.id.startsWith("gpt-") ? "openai" : source.defaultProvider || ""
  ));
  return {
    ...normalized,
    provider,
    efforts: normalizeAdminOptionList(
      item?.supportedReasoningEfforts
      || item?.reasoningEfforts
      || item?.efforts
      || source.reasoningEfforts
      || source.efforts,
    ).map(normalizeAdminBasicOption),
    modes: normalizeAdminOptionList(
      item?.supportedReasoningModes || item?.modes || source.modes,
    ).map(normalizeAdminBasicOption),
    promptVersions: normalizeAdminOptionList(
      item?.promptVersions || item?.prompts || source.promptVersions || source.prompts,
    ).map(normalizeAdminBasicOption),
  };
}

function uniqueAdminOptions(options) {
  const seen = new Set();
  return options.filter((option) => {
    const id = String(option?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function renderAdminCapabilities(capabilities) {
  populateAdminSelect(
    ui.adminPreparationProviderSelect,
    capabilities.preparationProviders,
    "没有可用资料服务",
  );
  const preferredPreparationProvider = capabilities.preparationProviders.some(
    (item) => item.id === "deepseek",
  ) ? "deepseek" : capabilities.preparationProviders[0]?.id;
  if (preferredPreparationProvider) {
    ui.adminPreparationProviderSelect.value = preferredPreparationProvider;
  }
  syncAdminPreparationModelControls();
  populateAdminSelect(ui.adminProviderSelect, capabilities.providers, "没有可用服务");
  const preferredProvider = capabilities.providers.some((item) => item.id === "openai") ? "openai" : capabilities.providers[0]?.id;
  if (preferredProvider) ui.adminProviderSelect.value = preferredProvider;
  syncAdminModelControls();
  applyAdminFeatureAvailability();
}

function syncAdminPreparationModelControls() {
  if (!adminCapabilityState) return;
  const provider = String(ui.adminPreparationProviderSelect?.value || "");
  const models = adminCapabilityState.preparationModels.filter(
    (model) => !model.provider || model.provider === provider,
  );
  const previousModel = String(ui.adminPreparationModelSelect?.value || "");
  populateAdminSelect(ui.adminPreparationModelSelect, models, "没有可用资料模型");
  if (models.some((item) => item.id === previousModel)) {
    ui.adminPreparationModelSelect.value = previousModel;
  } else if (models[0]) {
    ui.adminPreparationModelSelect.value = models[0].id;
  }
  syncAdminPreparationModelSpecificControls();
}

function syncAdminPreparationModelSpecificControls() {
  if (!adminCapabilityState) return;
  const model = adminCapabilityState.preparationModels.find(
    (item) => item.id === ui.adminPreparationModelSelect?.value,
  );
  populateAdminSelect(ui.adminPreparationEffortSelect, model?.efforts || [], "无");
  populateAdminSelect(ui.adminPreparationModeSelect, model?.modes || [], "标准");
  selectPreferredAdminOption(ui.adminPreparationEffortSelect, [
    model?.defaultReasoningEffort,
    "none",
    "low",
  ].filter(Boolean));
  selectPreferredAdminOption(ui.adminPreparationModeSelect, [
    model?.defaultReasoningMode,
    "standard",
    "pro",
  ].filter(Boolean));
}

function adminFeatureEnabled(name) {
  if (!adminCapabilityState) return false;
  const aliases = {
    history: ["history", "list", "runHistory"],
    evaluation: ["evaluation", "evaluations", "evaluationCorpus"],
    export: ["export", "exports"],
    rating: ["rating", "ratings", "humanRating"],
    cancel: ["cancelRun", "cancel", "cancellation"],
    events: ["eventReplay", "events", "streaming", "sse"],
    create: ["createRun", "create"],
    execute: ["executeRun", "execute"],
  };
  const features = adminCapabilityState.features || {};
  for (const key of aliases[name] || [name]) {
    if (features[key] === false) return false;
    if (features[key] === true) return true;
    if (features[key] && typeof features[key] === "object" && "enabled" in features[key]) {
      return features[key].enabled === true;
    }
  }
  return true;
}

function applyAdminFeatureAvailability() {
  const controls = [
    [ui.adminHistoryRefreshButton, "history"],
    [ui.adminEvaluationRefreshButton, "evaluation"],
    [ui.adminEvaluationLoadButton, "evaluation"],
    [ui.adminExportJsonButton, "export"],
    [ui.adminExportCsvButton, "export"],
    [ui.adminRatingButton, "rating"],
  ];
  for (const [control, feature] of controls) {
    if (!control) continue;
    const available = adminFeatureEnabled(feature);
    control.dataset.capabilityUnavailable = String(!available);
    control.title = available ? "" : "当前后端尚未提供这项能力";
    if (!available) control.disabled = true;
  }
  showAdminFeatureUnavailable("history");
  showAdminFeatureUnavailable("evaluation");
}

function showAdminFeatureUnavailable(feature) {
  if (adminFeatureEnabled(feature)) return;
  if (feature === "history" && ui.adminHistoryStatus) {
    ui.adminHistoryStatus.textContent = "当前后端尚未提供实验历史。";
  }
  if (feature === "evaluation" && ui.adminEvaluationStatus) {
    ui.adminEvaluationStatus.textContent = "当前后端尚未提供评估题集。";
  }
}

function syncAdminModelControls() {
  if (!adminCapabilityState) return;
  const provider = String(ui.adminProviderSelect?.value || "");
  const models = adminCapabilityState.models.filter((model) => !model.provider || model.provider === provider);
  const previousModel = String(ui.adminModelSelect?.value || "");
  populateAdminSelect(ui.adminModelSelect, models, "没有可用模型");
  if (models.some((item) => item.id === previousModel)) {
    ui.adminModelSelect.value = previousModel;
  } else {
    const preferred = models.find((item) => item.id === "gpt-5.6-terra") || models[0];
    if (preferred) ui.adminModelSelect.value = preferred.id;
  }
  syncAdminModelSpecificControls();
}

function syncAdminModelSpecificControls() {
  if (!adminCapabilityState) return;
  const model = adminCapabilityState.models.find((item) => item.id === ui.adminModelSelect?.value);
  const efforts = model?.efforts?.length ? model.efforts : adminCapabilityState.efforts;
  const modes = model?.modes?.length ? model.modes : adminCapabilityState.modes;
  const prompts = model?.promptVersions?.length ? model.promptVersions : adminCapabilityState.promptVersions;
  populateAdminSelect(ui.adminEffortSelect, efforts, "默认");
  populateAdminSelect(ui.adminModeSelect, modes, "标准");
  populateAdminSelect(ui.adminPromptVersionSelect, prompts, "后端默认");
  selectPreferredAdminOption(ui.adminModeSelect, [
    model?.defaultReasoningMode,
    "standard",
    "pro",
  ].filter(Boolean));
  syncAdminFinalReasoningCompatibility();
  selectPreferredAdminOption(ui.adminPromptVersionSelect, ["openai-ruling-v1"]);
}

function syncAdminFinalReasoningCompatibility() {
  if (!adminCapabilityState) return;
  const model = adminCapabilityState.models.find((item) => item.id === ui.adminModelSelect?.value);
  const mode = String(ui.adminModeSelect?.value || "");
  const preferredEfforts = mode === "standard" && model?.provider !== "openai"
    ? ["none"]
    : mode === "pro" && model?.provider === "deepseek"
      ? ["high", "max", "none"]
      : [model?.defaultReasoningEffort, "medium", "high", "max", "low", "none"].filter(Boolean);
  selectPreferredAdminOption(ui.adminEffortSelect, preferredEfforts);
}

function populateAdminSelect(select, options, emptyLabel) {
  if (!select) return;
  clearElement(select);
  if (!options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.appendChild(option);
    return;
  }
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label || item.id;
    select.appendChild(option);
  }
}

function selectPreferredAdminOption(select, preferred) {
  if (!select) return;
  const values = [...select.options].map((option) => option.value);
  const selected = preferred.find((item) => values.includes(item));
  if (selected) select.value = selected;
}

function setAdminControlsEnabled(enabled) {
  for (const control of [
    ui.adminPreparationProviderSelect,
    ui.adminPreparationModelSelect,
    ui.adminPreparationEffortSelect,
    ui.adminPreparationModeSelect,
    ui.adminProviderSelect,
    ui.adminModelSelect,
    ui.adminEffortSelect,
    ui.adminModeSelect,
    ui.adminPromptVersionSelect,
  ]) {
    if (control) control.disabled = !enabled;
  }
  if (ui.adminStartButton) {
    ui.adminStartButton.disabled = !enabled
      || !adminSession.authenticated
      || !adminFeatureEnabled("create")
      || !adminFeatureEnabled("execute");
  }
}

async function startAdminExperiment() {
  if (
    !adminSession.authenticated
    || !adminCapabilityState
    || !adminFeatureEnabled("create")
    || !adminFeatureEnabled("execute")
  ) return;
  const question = String(ui.adminQuestionInput?.value || "").trim();
  if (!question) {
    setAdminRunStatus("请先输入完整的裁定问题。", "error");
    ui.adminQuestionInput?.focus();
    return;
  }

  stopFollowingAdminRun();
  adminCurrentRun = null;
  adminCurrentRunId = "";
  adminAfterSequence = 0;
  adminClientStartedAt = Date.now();
  resetAdminStageStates();
  renderAdminStageStates();
  renderAdminRun(null);
  startAdminElapsedTimer();
  setAdminRunningState(true);
  setAdminRunStatus("正在建立实验记录…");

  const configuration = {
    preparationProvider: String(ui.adminPreparationProviderSelect?.value || ""),
    preparationModel: String(ui.adminPreparationModelSelect?.value || ""),
    preparationReasoningEffort: String(ui.adminPreparationEffortSelect?.value || ""),
    preparationReasoningMode: String(ui.adminPreparationModeSelect?.value || ""),
    provider: String(ui.adminProviderSelect?.value || ""),
    model: String(ui.adminModelSelect?.value || ""),
    effort: String(ui.adminEffortSelect?.value || ""),
    reasoningEffort: String(ui.adminEffortSelect?.value || ""),
    mode: String(ui.adminModeSelect?.value || ""),
    reasoningMode: String(ui.adminModeSelect?.value || ""),
    promptVersion: String(ui.adminPromptVersionSelect?.value || ""),
  };

  try {
    const created = await requestAdminLab({
      method: "POST",
      action: "create",
      body: {
        question,
        ...configuration,
        configuration,
      },
    });
    adminCurrentRun = extractAdminRun(created);
    adminCurrentRunId = extractAdminRunId(created);
    if (!adminCurrentRunId) throw new Error("后端没有返回运行编号。");
    storeAdminRunId(adminCurrentRunId);
    renderAdminRun(adminCurrentRun);
    void followAdminRun(adminCurrentRunId);
    triggerAdminRunExecution(adminCurrentRunId);
  } catch (error) {
    setAdminRunStatus(adminErrorMessage(error, "实验启动失败。"), "error");
    if (!adminCurrentRunId) {
      stopAdminElapsedTimer();
      setAdminRunningState(false);
    }
  }
}

function shouldTriggerAdminRunExecution(run, nowMs = Date.now()) {
  const status = String(run?.status || "").trim().toUpperCase();
  if (!["QUEUED", "RUNNING"].includes(status) || run?.result) return false;

  const execution = run?.execution;
  const submission = execution?.providerSubmission;
  if (submission && typeof submission === "object") {
    const state = String(submission.state || "NONE").trim().toUpperCase();
    if (state !== "NONE") return false;
    if (
      submission.requestId
      || submission.attemptId
      || submission.intentAt
      || submission.outcomeUnknownAt
    ) return false;
  }

  const lease = execution?.lease;
  if (lease === null || lease === undefined) return true;
  if (!lease || typeof lease !== "object") return false;
  const expiresAt = Date.parse(String(lease.expiresAt || ""));
  const now = Number(nowMs);
  return Number.isFinite(expiresAt) && Number.isFinite(now) && expiresAt <= now;
}

function isAdminRunQueued(run) {
  return String(run?.status || "").trim().toUpperCase() === "QUEUED";
}

function triggerAdminRunExecution(runId) {
  const id = normalizeStoredAdminRunId(runId);
  if (
    !id
    || adminExecuteAttemptedRunIds.has(id)
    || !shouldTriggerAdminRunExecution(adminCurrentRun)
  ) return;
  adminExecuteAttemptedRunIds.add(id);
  void requestAdminLab({
    method: "POST",
    action: "execute",
    body: { runId: id },
  }).then((executed) => {
    if (id !== adminCurrentRunId) return;
    mergeAdminRun(extractAdminRun(executed));
    renderAdminRun(adminCurrentRun);
    if (isAdminRunTerminal(adminCurrentRun)) finishAdminRunDisplay();
  }).catch(async (error) => {
    if (id !== adminCurrentRunId) return;
    await refreshAdminRun(id).catch(() => {});
    // A second page may have started the same queued run first. Once the
    // persisted state has advanced, the failed duplicate execute is harmless.
    if (isAdminRunQueued(adminCurrentRun)) {
      setAdminRunStatus(adminErrorMessage(error, "运行尚未启动，请刷新后重试。"), "error");
    }
  }).finally(() => {
    adminExecuteAttemptedRunIds.delete(id);
  });
}

async function cancelAdminExperiment() {
  if (!adminFeatureEnabled("cancel") || !adminCurrentRunId || isAdminRunTerminal(adminCurrentRun)) return;
  ui.adminCancelButton.disabled = true;
  setAdminRunStatus("正在请求取消；已经产生的记录会保留…");
  try {
    const cancelled = await requestAdminLab({
      method: "POST",
      action: "cancel",
      body: { runId: adminCurrentRunId },
    });
    mergeAdminRun(extractAdminRun(cancelled));
    renderAdminRun(adminCurrentRun);
    await refreshAdminRun(adminCurrentRunId);
  } catch (error) {
    setAdminRunStatus(adminErrorMessage(error, "取消失败，运行可能仍在继续。"), "error");
    ui.adminCancelButton.disabled = false;
  }
}

async function followAdminRun(runId) {
  const generation = ++adminFollowGeneration;
  while (
    generation === adminFollowGeneration
    && runId === adminCurrentRunId
    && !isAdminRunTerminal(adminCurrentRun)
  ) {
    if (!adminFeatureEnabled("events")) {
      await refreshAdminRun(runId).catch(() => {});
      if (!isAdminRunTerminal(adminCurrentRun)) await adminDelay(1200);
      continue;
    }
    try {
      await streamAdminEventsOnce(runId, generation);
    } catch (error) {
      if (generation !== adminFollowGeneration || error?.name === "AbortError") return;
      setAdminRunStatus("进度连接暂时中断，正在从上次事件继续…");
    }
    if (generation !== adminFollowGeneration || isAdminRunTerminal(adminCurrentRun)) break;
    await refreshAdminRun(runId).catch(() => {});
    if (isAdminRunTerminal(adminCurrentRun)) break;
    await adminDelay(1200);
  }
  if (generation === adminFollowGeneration && isAdminRunTerminal(adminCurrentRun)) {
    finishAdminRunDisplay();
  }
}

async function streamAdminEventsOnce(runId, generation) {
  const url = new URL(getAdminEndpointUrl("/api/admin-model-lab"));
  url.searchParams.set("action", "events");
  url.searchParams.set("runId", runId);
  url.searchParams.set("afterSequence", String(adminAfterSequence));
  const controller = new AbortController();
  adminStreamAbortController = controller;
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
    headers: {
      accept: "text/event-stream",
      "last-event-id": String(adminAfterSequence),
    },
    signal: controller.signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) setAdminAuthenticated(false);
    throw createAdminRequestError(response.status, payload);
  }
  if (!response.body?.getReader) {
    const payload = await response.json().catch(() => ({}));
    for (const event of payload?.data?.events || payload?.events || []) applyAdminRunEvent(event);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (generation === adminFollowGeneration) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const event = parseAdminSseBlock(block);
      if (event) applyAdminRunEvent(event);
    }
    if (done || isAdminRunTerminal(adminCurrentRun)) break;
  }
  if (buffer.trim()) {
    const event = parseAdminSseBlock(buffer);
    if (event) applyAdminRunEvent(event);
  }
}

function parseAdminSseBlock(block) {
  let id = "";
  let type = "message";
  const dataLines = [];
  for (const line of String(block || "").split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  const rawData = dataLines.join("\n");
  let data;
  try {
    data = JSON.parse(rawData);
  } catch {
    data = { message: rawData };
  }
  return {
    ...data,
    type: data?.type || type,
    sequence: Number(data?.sequence || id || 0),
  };
}

function applyAdminRunEvent(event) {
  const sequence = Number(event?.sequence || event?.seq || 0);
  if (Number.isFinite(sequence) && sequence > adminAfterSequence) adminAfterSequence = sequence;
  const eventRun = extractAdminRun(event?.run || event?.data?.run || event?.payload?.run);
  if (eventRun) mergeAdminRun(eventRun);
  updateAdminStageFromEvent(event);

  const terminalStatus = String(
    event?.status
    || event?.data?.status
    || event?.payload?.status
    || (event?.terminal ? event?.type : ""),
  ).toLowerCase();
  if (ADMIN_TERMINAL_STATUSES.has(terminalStatus)) {
    mergeAdminRun({ status: terminalStatus });
  }
  renderAdminRun(adminCurrentRun);
  if (isAdminRunTerminal(adminCurrentRun)) finishAdminRunDisplay();
}

function updateAdminStageFromEvent(event) {
  const type = String(event?.type || event?.event || "").toLowerCase();
  const payload = event?.data || event?.payload || event;
  const stages = payload?.stageTiming?.stages || payload?.stages;
  if (Array.isArray(stages)) {
    for (const stage of stages) updateAdminStageState(stage);
    renderAdminStageStates();
  }
  const id = normalizeAdminStageId(
    payload?.stageId || payload?.stage || payload?.name || event?.stageId || event?.stage,
  );
  if (!id) return;
  const previous = adminStageStates.get(id) || {};
  let status = String(payload?.stageStatus || payload?.status || "").toLowerCase();
  if (!status) {
    if (/complete|finish|success/u.test(type)) status = "completed";
    else if (/fail|error/u.test(type)) status = "failed";
    else if (/cancel/u.test(type)) status = "cancelled";
    else status = "running";
  }
  adminStageStates.set(id, {
    ...previous,
    ...payload,
    id,
    status,
    durationMs: readAdminDuration(payload) ?? previous.durationMs,
  });
  renderAdminStageStates();
}

async function refreshAdminRun(runId) {
  const data = await requestAdminLab({
    method: "GET",
    action: "run",
    query: { runId },
  });
  mergeAdminRun(extractAdminRun(data));
  renderAdminRun(adminCurrentRun);
  if (isAdminRunTerminal(adminCurrentRun)) {
    finishAdminRunDisplay();
  } else {
    triggerAdminRunExecution(runId);
  }
}

function mergeAdminRun(run) {
  if (!run || typeof run !== "object") return;
  const previousRunId = extractAdminRunId(adminCurrentRun);
  const incomingRunId = extractAdminRunId(run);
  const previousRun = (
    previousRunId
    && incomingRunId
    && previousRunId !== incomingRunId
  ) ? null : adminCurrentRun;
  const mergedRun = {
    ...(previousRun || {}),
    ...run,
  };
  const mergedMetrics = {
      ...(previousRun?.metrics || {}),
      ...(run.metrics || {}),
  };
  const mergedUsage = {
      ...(previousRun?.usage || {}),
      ...(run.usage || {}),
  };
  if (Object.keys(mergedMetrics).length) mergedRun.metrics = mergedMetrics;
  else delete mergedRun.metrics;
  if (Object.keys(mergedUsage).length) mergedRun.usage = mergedUsage;
  else delete mergedRun.usage;
  adminCurrentRun = mergedRun;
  adminCurrentRunId = extractAdminRunId(adminCurrentRun) || adminCurrentRunId;
  storeAdminRunId(adminCurrentRunId);
  updateAdminStagesFromRun(adminCurrentRun);
}

function extractAdminRun(data) {
  if (!data || typeof data !== "object") return null;
  return data.run || data.record || data.item || data;
}

function extractAdminRunId(data) {
  const run = extractAdminRun(data);
  return String(run?.runId || run?.id || data?.runId || "");
}

function updateAdminStagesFromRun(run) {
  const stages = run?.stageTiming?.stages
    || run?.stages
    || run?.stageTimings
    || run?.timings?.stages
    || run?.metrics?.stages;
  if (Array.isArray(stages)) {
    for (const stage of stages) updateAdminStageState(stage);
  } else if (stages && typeof stages === "object") {
    for (const [id, stage] of Object.entries(stages)) {
      updateAdminStageState({ id, ...(stage && typeof stage === "object" ? stage : {}) });
    }
  }
}

function updateAdminStageState(stage) {
  const id = normalizeAdminStageId(stage?.id || stage?.stageId || stage?.stage || stage?.name);
  if (!id) return;
  const previous = adminStageStates.get(id) || {};
  adminStageStates.set(id, {
    ...previous,
    ...stage,
    id,
    status: String(stage?.status || previous.status || "pending").toLowerCase(),
    durationMs: readAdminDuration(stage) ?? previous.durationMs,
  });
}

function normalizeAdminStageId(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[.\s-]+/gu, "_");
  const aliases = {
    understand_question: "understand",
    understanding: "understand",
    extract_names: "extract_card_names",
    card_names: "extract_card_names",
    retrieve_cards: "retrieve_card_texts",
    card_texts: "retrieve_card_texts",
    retrieve_evidence: "retrieve_rulings_evidence",
    rulings: "retrieve_rulings_evidence",
    generate: "generate_ruling",
    final_ruling: "generate_ruling",
  };
  const id = aliases[normalized] || normalized;
  return ADMIN_STAGES.some((stage) => stage.id === id) ? id : "";
}

function resetAdminStageStates() {
  adminStageStates.clear();
  for (const stage of ADMIN_STAGES) adminStageStates.set(stage.id, { ...stage, status: "pending" });
}

function renderAdminStageStates() {
  if (!ui.adminStageList) return;
  for (const item of ui.adminStageList.querySelectorAll("[data-admin-stage]")) {
    const id = item.dataset.adminStage;
    const state = adminStageStates.get(id) || { status: "pending" };
    const status = normalizeAdminStageStatus(state.status);
    item.className = `is-${status}`;
    const small = item.querySelector("small");
    if (small) small.textContent = adminStageStatusText(state);
  }
}

function normalizeAdminStageStatus(status) {
  const value = String(status || "").toLowerCase();
  if (/complete|success|succeed|done/u.test(value)) return "completed";
  if (/running|active|start|progress/u.test(value)) return "running";
  if (/fail|error/u.test(value)) return "failed";
  if (/cancel/u.test(value)) return "cancelled";
  return "pending";
}

function adminStageStatusText(state) {
  const status = normalizeAdminStageStatus(state?.status);
  const duration = readAdminDuration(state);
  const parts = [{
    pending: "等待开始",
    running: "处理中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }[status]];
  if (Number.isFinite(duration)) {
    const serverLabel = String(state?.speedLabel || state?.speed_label || "").toUpperCase();
    parts.push(
      formatAdminDuration(duration),
      ["FAST", "NORMAL", "SLOW"].includes(serverLabel) ? serverLabel : adminDurationCategory(duration),
    );
  }
  return parts.filter(Boolean).join(" · ");
}

function readAdminDuration(value) {
  const candidates = [
    value?.durationMs,
    value?.elapsedMs,
    value?.wallClockMs,
    value?.timing?.durationMs,
  ];
  for (const candidate of candidates) {
    const number = Number(candidate);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  const startedAt = Date.parse(String(value?.startedAt || ""));
  const completedAt = Date.parse(String(value?.completedAt || value?.finishedAt || value?.endedAt || ""));
  return Number.isFinite(startedAt) && Number.isFinite(completedAt)
    ? Math.max(0, completedAt - startedAt)
    : null;
}

function adminDurationCategory(durationMs) {
  if (!Number.isFinite(Number(durationMs))) return "";
  if (Number(durationMs) <= 10_000) return "FAST";
  if (Number(durationMs) <= 30_000) return "NORMAL";
  return "SLOW";
}

function renderAdminRun(run) {
  updateAdminStagesFromRun(run);
  renderAdminStageStates();
  const runId = extractAdminRunId(run) || adminCurrentRunId;
  const status = String(run?.status || "").toLowerCase();
  if (ui.adminRunIdentity) {
    ui.adminRunIdentity.textContent = runId
      ? `运行 ${runId} · ${adminRunStatusLabel(status)}`
      : "尚未开始运行。";
  }
  if (runId) setAdminRunStatus(adminRunStatusMessage(status));
  renderAdminStructuredResult(run);
  renderAdminMetrics(run);
  renderAdminEvidence(run);
  if (ui.adminResultJson) ui.adminResultJson.textContent = run ? safeAdminJson(run) : "";
  const terminal = isAdminRunTerminal(run);
  if (ui.adminExportJsonButton) ui.adminExportJsonButton.disabled = !runId || !adminFeatureEnabled("export");
  if (ui.adminExportCsvButton) ui.adminExportCsvButton.disabled = !runId || !adminFeatureEnabled("export");
  if (ui.adminRatingButton) ui.adminRatingButton.disabled = !runId || !terminal || !adminFeatureEnabled("rating");
  setAdminRunningState(Boolean(runId) && !terminal);
}

function renderAdminStructuredResult(run) {
  if (!ui.adminResultSummary) return;
  clearElement(ui.adminResultSummary);
  const result = run?.result?.finalRuling
    || run?.result?.ruling
    || run?.result?.output
    || run?.result
    || run?.output
    || run?.response;
  if (!result || typeof result !== "object") {
    appendText(ui.adminResultSummary, "p", run ? "最终裁定尚未生成。" : "运行完成后会在这里显示结构化裁定。");
    return;
  }

  if (run?.result?.experimental === true) {
    const notice = appendText(
      ui.adminResultSummary,
      "p",
      "实验结果：由国产模型在隔离管理实验中生成，不代表官方裁定，也不会进入普通用户回答。",
    );
    notice.className = "admin-experimental-notice";
  }

  const conciseAnswer = String(result.conciseAnswer || "").trim();
  const verdicts = firstAdminArray(result.verdicts);
  const claims = firstAdminArray(result.claims);
  const timeline = firstAdminArray(result.timeline);
  const unresolved = firstAdminArray(result.unresolved);
  const isCurrentRulingSchema = Boolean(
    conciseAnswer
    || verdicts.length
    || claims.length
    || timeline.length
    || unresolved.length,
  );

  if (isCurrentRulingSchema) {
    if (conciseAnswer) appendText(ui.adminResultSummary, "h4", conciseAnswer);

    if (verdicts.length) {
      appendText(ui.adminResultSummary, "strong", "逐题结论");
      const verdictList = document.createElement("ul");
      for (const verdict of verdicts) {
        const item = document.createElement("li");
        const questionId = String(verdict?.questionId || "").trim();
        const value = adminRulingVerdictLabel(verdict?.value);
        appendText(item, "strong", [questionId, value].filter(Boolean).join(" · ") || "结论");
        const conclusion = String(verdict?.conclusion || "").trim();
        if (conclusion && conclusion !== conciseAnswer) appendText(item, "p", conclusion);
        appendAdminStringList(item, verdict?.conditions, "适用条件");
        verdictList.appendChild(item);
      }
      ui.adminResultSummary.appendChild(verdictList);
    }

    if (claims.length) {
      appendText(ui.adminResultSummary, "strong", "判断依据");
      const claimList = document.createElement("ul");
      for (const claim of claims) {
        const proposition = String(claim?.proposition || "").trim();
        if (!proposition) continue;
        const item = document.createElement("li");
        const status = adminRulingVerdictLabel(claim?.status);
        const scope = String(claim?.questionId || "").trim();
        appendText(item, "span", [
          proposition,
          scope ? `题目 ${scope}` : "",
          status,
          claim?.decisive === true ? "关键判断" : "",
        ].filter(Boolean).join(" · "));
        claimList.appendChild(item);
      }
      if (claimList.childNodes.length) ui.adminResultSummary.appendChild(claimList);
    }

    if (timeline.length) {
      appendText(ui.adminResultSummary, "strong", "处理顺序");
      const timelineList = document.createElement("ol");
      const orderedTimeline = [...timeline].sort(
        (left, right) => Number(left?.order || 0) - Number(right?.order || 0),
      );
      for (const step of orderedTimeline) {
        const action = String(step?.action || "").trim();
        const stepResult = String(step?.result || "").trim();
        if (!action && !stepResult) continue;
        appendText(timelineList, "li", [action, stepResult].filter(Boolean).join(" → "));
      }
      if (timelineList.childNodes.length) ui.adminResultSummary.appendChild(timelineList);
    }

    if (unresolved.length) {
      appendText(ui.adminResultSummary, "strong", "仍需确认");
      const unresolvedList = document.createElement("ul");
      for (const item of unresolved) {
        const explanation = String(item?.explanation || "").trim();
        if (!explanation) continue;
        const questionId = String(item?.questionId || "").trim();
        const code = String(item?.code || "").trim();
        appendText(unresolvedList, "li", [
          explanation,
          questionId ? `题目 ${questionId}` : "",
          code,
          item?.decisive === true ? "会影响最终结论" : "",
        ].filter(Boolean).join(" · "));
      }
      if (unresolvedList.childNodes.length) ui.adminResultSummary.appendChild(unresolvedList);
    }

    appendAdminStringList(
      ui.adminResultSummary,
      result?.confidence?.reasons,
      result?.confidence?.level
        ? `置信度：${String(result.confidence.level)}`
        : "置信度说明",
    );
  }

  if (isCurrentRulingSchema && ui.adminResultSummary.childNodes.length) return;

  // Compatibility fallback for older or externally supplied result shapes.
  const verdict = firstAdminValue(
    result.verdict,
    result.conclusion,
    result.shortAnswer,
    result.short_answer,
    result.answer,
    result.finalAnswer,
  );
  if (verdict) appendText(ui.adminResultSummary, "h4", String(verdict));

  const explanation = firstAdminValue(result.explanation, result.summary, result.ruling);
  if (typeof explanation === "string" && explanation !== verdict) {
    appendText(ui.adminResultSummary, "p", explanation);
  }

  const reasons = firstAdminArray(result.reasons, result.reasoning, result.steps);
  if (reasons.length) {
    appendText(ui.adminResultSummary, "strong", "理由");
    const list = document.createElement("ol");
    for (const reason of reasons) appendText(list, "li", adminDisplayValue(reason));
    ui.adminResultSummary.appendChild(list);
  }

  const risks = firstAdminArray(result.uncertainties, result.risks, result.warnings);
  if (risks.length) {
    appendText(ui.adminResultSummary, "strong", "风险与未确定项");
    const list = document.createElement("ul");
    for (const risk of risks) appendText(list, "li", adminDisplayValue(risk));
    ui.adminResultSummary.appendChild(list);
  }

  if (!ui.adminResultSummary.childNodes.length) {
    appendText(ui.adminResultSummary, "p", "已收到结构化结果，请展开下方查看完整内容。");
  }
}

function appendAdminStringList(parent, values, label) {
  const items = Array.isArray(values)
    ? values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (!items.length) return;
  appendText(parent, "strong", label);
  const list = document.createElement("ul");
  for (const item of items) appendText(list, "li", item);
  parent.appendChild(list);
}

function adminRulingVerdictLabel(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return {
    TRUE: "可以／成立",
    FALSE: "不可以／不成立",
    CONDITIONAL: "视条件而定",
    UNKNOWN: "尚不能确定",
  }[normalized] || normalized;
}

function renderAdminMetrics(run) {
  if (!ui.adminMetrics) return;
  clearElement(ui.adminMetrics);
  const firstNonEmptyObject = (...values) => values.find((value) => (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length > 0
  )) || {};
  const metrics = firstNonEmptyObject(run?.metrics, run?.result?.metrics);
  const meteringTotals = run?.result?.metering?.totals || {};
  const usage = firstNonEmptyObject(
    run?.usage,
    metrics?.usage,
    meteringTotals?.usage,
    run?.result?.usage,
  );
  const aggregateCost = firstNonEmptyObject(metrics?.cost, meteringTotals?.cost);
  const finalStageCost = run?.result?.cost || {};
  const latency = run?.result?.latency || metrics?.latency || {};
  const usdCostIncomplete = (
    aggregateCost.completeInUsd === false
    && aggregateCost.totalCostUsd == null
    && aggregateCost.knownCostUsd != null
  );
  const cnyCostIncomplete = (
    aggregateCost.completeInCny === false
    && aggregateCost.totalCostCny == null
    && aggregateCost.knownCostCny != null
  );
  const formatMissingCostStages = (values) => {
    if (!Array.isArray(values) || !values.length) return "";
    const labels = {
      evidencePreparation: "证据准备模型",
      finalRuling: "最终裁定模型",
    };
    return values
      .map((value) => labels[String(value || "")] || String(value || ""))
      .filter(Boolean)
      .join("、");
  };
  const configuration = run?.configuration
    || run?.executionProfile
    || run?.config
    || run?.options
    || {};
  const finalConfiguration = configuration.finalRuling || configuration;
  const fields = [
    ["状态", adminRunStatusLabel(run?.status)],
    ["服务提供方", run?.provider || finalConfiguration.provider],
    ["模型", run?.model || finalConfiguration.model || finalConfiguration.requestedModel],
    ["推理强度", finalConfiguration.reasoningEffort || finalConfiguration.effort || run?.reasoningEffort],
    ["运行模式", finalConfiguration.reasoningMode || finalConfiguration.mode || run?.reasoningMode || run?.mode],
    ["提示词版本", configuration.prompt?.version || configuration.promptVersion || run?.promptVersion],
    ["输入 Token", usage.inputTokens ?? usage.input_tokens ?? metrics.inputTokens],
    ["缓存输入 Token", usage.cachedInputTokens ?? usage.cached_input_tokens ?? metrics.cachedInputTokens],
    ["输出 Token", usage.outputTokens ?? usage.output_tokens ?? metrics.outputTokens],
    ["推理 Token", usage.reasoningTokens ?? usage.reasoning_tokens ?? metrics.reasoningTokens],
    ["总 Token", usage.totalTokens ?? usage.total_tokens ?? metrics.totalTokens],
    [usdCostIncomplete ? "估算成本（仅已知部分）" : "估算成本", formatAdminCost(
      metrics.estimatedCostUsd
      ?? metrics.costUsd
      ?? aggregateCost.totalCostUsd
      ?? aggregateCost.knownCostUsd
      ?? (typeof finalStageCost === "number" ? finalStageCost : undefined)
      ?? finalStageCost.estimatedUsd
      ?? finalStageCost.usd
      ?? run?.estimatedCostUsd,
    )],
    ["美元成本缺失阶段", usdCostIncomplete
      ? formatMissingCostStages(aggregateCost.missingUsdStages)
      : ""],
    [cnyCostIncomplete ? "人民币估算（仅已知部分）" : "人民币估算", formatAdminCnyCost(
      metrics.estimatedCostCny
      ?? metrics.costCny
      ?? aggregateCost.totalCostCny
      ?? aggregateCost.knownCostCny
      ?? (typeof finalStageCost === "object" ? finalStageCost.totalCostCny : undefined)
      ?? finalStageCost.estimatedCny
      ?? finalStageCost.cny
      ?? run?.estimatedCostCny,
    )],
    ["人民币成本缺失阶段", cnyCostIncomplete
      ? formatMissingCostStages(aggregateCost.missingCnyStages)
      : ""],
    ["服务端总耗时", formatAdminMetricDuration(
      latency.totalWallClockMs
      ?? metrics.wallClockMs
      ?? metrics.totalDurationMs
      ?? (typeof latency === "number" ? latency : undefined)
      ?? latency.wallClockMs
      ?? latency.totalMs
      ?? run?.wallClockMs
      ?? run?.durationMs,
      metrics.speedLabel || latency.speedLabel,
    )],
  ];
  for (const [label, value] of fields) {
    if (value === undefined || value === null || value === "") continue;
    const term = document.createElement("div");
    appendText(term, "dt", label);
    appendText(term, "dd", String(value));
    ui.adminMetrics.appendChild(term);
  }
}

function renderAdminEvidence(run) {
  const evidence = run?.evidenceSnapshot
    || run?.evidence_snapshot
    || run?.snapshot
    || run?.result?.evidenceSnapshot
    || run?.result?.evidence_snapshot;
  if (ui.adminEvidenceJson) ui.adminEvidenceJson.textContent = evidence ? safeAdminJson(evidence) : "";
  if (!ui.adminEvidenceSummary) return;
  clearElement(ui.adminEvidenceSummary);
  if (!evidence) {
    appendText(ui.adminEvidenceSummary, "p", "尚未取得冻结证据快照。");
    return;
  }
  const cards = evidence.cards || evidence.cardTexts || evidence.card_texts;
  const rulings = evidence.rulings || evidence.faqs || evidence.evidence;
  const queries = evidence.queries || evidence.retrievalQueries || evidence.retrieval_queries;
  const summary = [
    Array.isArray(cards) ? `${cards.length} 张卡片` : "",
    Array.isArray(rulings) ? `${rulings.length} 条裁定/证据` : "",
    Array.isArray(queries) ? `${queries.length} 个检索词` : "",
  ].filter(Boolean);
  appendText(ui.adminEvidenceSummary, "p", summary.length ? summary.join(" · ") : "证据快照已冻结。");
}

function finishAdminRunDisplay() {
  stopAdminElapsedTimer();
  setAdminRunningState(false);
  renderAdminRun(adminCurrentRun);
  void loadAdminHistory();
}

function setAdminRunningState(isRunning) {
  if (ui.adminStartButton) {
    ui.adminStartButton.disabled = isRunning
      || !adminSession.authenticated
      || !adminCapabilityState?.models?.length
      || !adminFeatureEnabled("create")
      || !adminFeatureEnabled("execute");
    ui.adminStartButton.textContent = isRunning ? "运行中…" : "开始实验";
  }
  if (ui.adminCancelButton) {
    ui.adminCancelButton.disabled = !isRunning || !adminCurrentRunId || !adminFeatureEnabled("cancel");
  }
}

function startAdminElapsedTimer() {
  stopAdminElapsedTimer();
  updateAdminElapsedText();
  adminElapsedTimer = window.setInterval(updateAdminElapsedText, 250);
}

function stopAdminElapsedTimer() {
  if (adminElapsedTimer) window.clearInterval(adminElapsedTimer);
  adminElapsedTimer = 0;
  updateAdminElapsedText();
}

function updateAdminElapsedText() {
  if (!ui.adminElapsedText) return;
  const serverDuration = readAdminDuration(adminCurrentRun?.metrics || adminCurrentRun);
  if (isAdminRunTerminal(adminCurrentRun) && Number.isFinite(serverDuration)) {
    ui.adminElapsedText.textContent = `${formatAdminDuration(serverDuration)} · ${adminDurationCategory(serverDuration)}（服务端）`;
    return;
  }
  if (adminClientStartedAt && !isAdminRunTerminal(adminCurrentRun)) {
    ui.adminElapsedText.textContent = `${formatAdminDuration(Date.now() - adminClientStartedAt)}（浏览器计时）`;
    return;
  }
  ui.adminElapsedText.textContent = "—";
}

function stopFollowingAdminRun() {
  adminFollowGeneration += 1;
  adminStreamAbortController?.abort();
  adminStreamAbortController = null;
  stopAdminElapsedTimer();
}

async function loadAdminHistory() {
  if (!adminFeatureEnabled("history") || !adminSession.authenticated || !ui.adminHistoryList) {
    showAdminFeatureUnavailable("history");
    return;
  }
  ui.adminHistoryRefreshButton.disabled = true;
  ui.adminHistoryStatus.textContent = "正在读取最近的实验…";
  try {
    const data = await requestAdminLab({
      method: "GET",
      action: "list",
      query: { limit: 100 },
    });
    const records = firstAdminArray(data?.runs, data?.items, data?.entries, Array.isArray(data) ? data : null);
    renderAdminHistory(records);
  } catch (error) {
    ui.adminHistoryStatus.textContent = adminErrorMessage(error, "暂时无法读取实验历史。");
  } finally {
    ui.adminHistoryRefreshButton.disabled = false;
  }
}

function renderAdminHistory(records) {
  clearElement(ui.adminHistoryList);
  ui.adminHistoryStatus.textContent = records.length ? `最近 ${records.length} 次实验。` : "暂时没有实验记录。";
  for (const record of records) {
    const runId = extractAdminRunId(record);
    if (!runId) continue;
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    const question = String(record?.question || record?.input?.question || "未命名问题");
    appendText(button, "strong", question);
    appendText(button, "small", [
      formatAdminDate(record?.createdAt || record?.startedAt),
      adminRunStatusLabel(record?.status),
      String(record?.model || record?.configuration?.model || ""),
    ].filter(Boolean).join(" · "));
    button.addEventListener("click", () => loadAdminRunFromHistory(runId));
    item.appendChild(button);
    ui.adminHistoryList.appendChild(item);
  }
}

async function loadAdminRunFromHistory(runId) {
  stopFollowingAdminRun();
  adminCurrentRunId = normalizeStoredAdminRunId(runId);
  if (!adminCurrentRunId) return false;
  storeAdminRunId(adminCurrentRunId);
  adminAfterSequence = 0;
  resetAdminStageStates();
  setAdminRunStatus("正在读取实验记录…");
  try {
    await refreshAdminRun(adminCurrentRunId);
    if (!isAdminRunTerminal(adminCurrentRun)) {
      adminClientStartedAt = Date.now();
      startAdminElapsedTimer();
      void followAdminRun(adminCurrentRunId);
      triggerAdminRunExecution(adminCurrentRunId);
    }
    return true;
  } catch (error) {
    if (error?.code === "admin_run_not_found") clearStoredAdminRunId();
    setAdminRunStatus(adminErrorMessage(error, "无法读取这次实验。"), "error");
    return false;
  }
}

async function restoreStoredAdminRun() {
  const runId = readStoredAdminRunId();
  if (!runId || !adminSession.authenticated) return;
  setAdminRunStatus("正在恢复刷新前的实验…");
  await loadAdminRunFromHistory(runId);
}

function storeAdminRunId(runId) {
  const id = normalizeStoredAdminRunId(runId);
  if (!id) return;
  try {
    sessionStorage.setItem(adminCurrentRunStorageKey, id);
  } catch {
    // Run recovery remains available from persistent experiment history.
  }
}

function readStoredAdminRunId() {
  try {
    return normalizeStoredAdminRunId(sessionStorage.getItem(adminCurrentRunStorageKey));
  } catch {
    return "";
  }
}

function clearStoredAdminRunId() {
  try {
    sessionStorage.removeItem(adminCurrentRunStorageKey);
  } catch {
    // Session storage is an optional convenience, never an authentication layer.
  }
}

function normalizeStoredAdminRunId(value) {
  const text = String(value || "").trim();
  return text && text.length <= 200 && !/[\u0000-\u001f{}\s]/u.test(text) ? text : "";
}

async function loadAdminQuestionHistory() {
  if (!adminSession.authenticated || !ui.adminQuestionHistoryList) return;
  ui.adminQuestionHistoryRefreshButton.disabled = true;
  ui.adminQuestionHistoryStatus.textContent = "正在读取后台最近保存的提问…";
  try {
    const payload = await requestAdminQuestionHistory();
    const entries = firstAdminArray(
      payload?.entries,
      payload?.records,
      payload?.items,
      Array.isArray(payload) ? payload : null,
    );
    renderAdminQuestionHistory(entries.slice(0, 100));
  } catch (error) {
    ui.adminQuestionHistoryStatus.textContent = adminErrorMessage(
      error,
      "暂时无法读取后台历史提问。",
    );
  } finally {
    ui.adminQuestionHistoryRefreshButton.disabled = false;
  }
}

async function requestAdminQuestionHistory() {
  const url = new URL(getAdminEndpointUrl("/api/admin-queries"));
  url.searchParams.set("limit", "100");
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    stopFollowingAdminRun();
    setAdminAuthenticated(false);
    setAdminLoginStatus("登录已过期，请重新登录。", "error");
  }
  if (!response.ok || payload.ok === false) throw createAdminRequestError(response.status, payload);
  return payload.data ?? payload;
}

function renderAdminQuestionHistory(entries) {
  clearElement(ui.adminQuestionHistoryList);
  ui.adminQuestionHistoryStatus.textContent = entries.length
    ? `后台最近保存的 ${entries.length} 条提问（最多 100 条）。`
    : "后台暂时没有已保存的提问。";
  for (const entry of entries) {
    const question = String(entry?.question || "").trim();
    if (!question) continue;
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.title = "载入到新实验";
    appendText(button, "strong", question);
    appendText(button, "small", [
      formatAdminDate(entry?.createdAt),
      entry?.mode ? `来源：${String(entry.mode)}` : "",
      "点击载入",
    ].filter(Boolean).join(" · "));
    button.addEventListener("click", () => {
      ui.adminQuestionInput.value = question;
      ui.adminQuestionInput.focus();
      ui.adminQuestionHistoryStatus.textContent = "已载入这条历史提问，可直接开始新实验。";
    });
    item.appendChild(button);
    ui.adminQuestionHistoryList.appendChild(item);
  }
}

async function loadAdminEvaluationCases() {
  if (!adminFeatureEnabled("evaluation") || !adminSession.authenticated || !ui.adminEvaluationSelect) {
    showAdminFeatureUnavailable("evaluation");
    return;
  }
  ui.adminEvaluationRefreshButton.disabled = true;
  ui.adminEvaluationStatus.textContent = "正在读取评估题集…";
  try {
    const data = await requestAdminLab({
      method: "GET",
      action: "evaluation",
    });
    adminEvaluationCases = firstAdminArray(data?.cases, data?.items, data?.entries, Array.isArray(data) ? data : null);
    renderAdminEvaluationCases();
  } catch (error) {
    adminEvaluationCases = [];
    renderAdminEvaluationCases();
    ui.adminEvaluationStatus.textContent = adminErrorMessage(error, "暂时无法读取评估题集。");
  } finally {
    ui.adminEvaluationRefreshButton.disabled = false;
  }
}

function renderAdminEvaluationCases() {
  clearElement(ui.adminEvaluationSelect);
  for (let index = 0; index < adminEvaluationCases.length; index += 1) {
    const item = adminEvaluationCases[index];
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = String(item?.title || item?.name || item?.id || `评估题 ${index + 1}`);
    ui.adminEvaluationSelect.appendChild(option);
  }
  ui.adminEvaluationLoadButton.disabled = !adminEvaluationCases.length;
  ui.adminEvaluationStatus.textContent = adminEvaluationCases.length
    ? `已读取 ${adminEvaluationCases.length} 道固定评估题。`
    : "当前没有可用评估题。";
}

function loadSelectedAdminEvaluation() {
  const index = Number(ui.adminEvaluationSelect?.value || 0);
  const item = adminEvaluationCases[index];
  const question = String(item?.question || item?.input?.question || item?.prompt || "");
  if (!item || !question) {
    ui.adminEvaluationStatus.textContent = "这条评估记录没有问题文本。";
    return;
  }
  ui.adminQuestionInput.value = question;
  ui.adminQuestionInput.focus();
  ui.adminEvaluationStatus.textContent = "已载入问题，可调整配置后开始实验。";
}

async function submitAdminRating(event) {
  event.preventDefault();
  if (!adminFeatureEnabled("rating") || !adminCurrentRunId || !isAdminRunTerminal(adminCurrentRun)) return;
  ui.adminRatingButton.disabled = true;
  ui.adminRatingStatus.textContent = "正在保存评分…";
  try {
    await requestAdminLab({
      method: "POST",
      action: "rating",
      body: {
        runId: adminCurrentRunId,
        rating: String(ui.adminRatingSelect?.value || ""),
        notes: String(ui.adminRatingNotes?.value || "").trim(),
      },
    });
    ui.adminRatingStatus.textContent = "评分已保存。";
    await loadAdminHistory();
  } catch (error) {
    ui.adminRatingStatus.textContent = adminErrorMessage(error, "评分保存失败。");
  } finally {
    ui.adminRatingButton.disabled = false;
  }
}

async function exportAdminRun(format) {
  if (!adminFeatureEnabled("export") || !adminCurrentRunId) return;
  const button = format === "csv" ? ui.adminExportCsvButton : ui.adminExportJsonButton;
  button.disabled = true;
  setAdminRunStatus(`正在准备 ${format.toUpperCase()} 文件…`);
  try {
    const data = await requestAdminLab({
      method: "GET",
      action: "export",
      query: { runId: adminCurrentRunId, format },
    });
    const serverContent = typeof data?.content === "string" ? data.content : null;
    const fileName = String(
      data?.fileName || `ocg-model-lab-${adminCurrentRunId}.${format}`,
    );
    const content = serverContent
      ?? (format === "csv" ? adminObjectToCsv(data) : safeAdminJson(data));
    const contentType = String(
      data?.contentType
        || (format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8"),
    );
    downloadAdminFile(fileName, content, contentType);
    setAdminRunStatus("导出文件已生成。", "good");
  } catch (error) {
    setAdminRunStatus(adminErrorMessage(error, "导出失败。"), "error");
  } finally {
    button.disabled = false;
  }
}

async function requestAdminLab({
  method = "GET",
  action,
  query = {},
  body = {},
}) {
  const url = new URL(getAdminEndpointUrl("/api/admin-model-lab"));
  if (method === "GET") {
    url.searchParams.set("action", action);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const headers = { accept: "application/json" };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["x-csrf-token"] = adminSession.csrfToken;
  }
  const response = await fetch(url, {
    method,
    cache: "no-store",
    credentials: "include",
    headers,
    ...(method === "GET" ? {} : { body: JSON.stringify({ action, ...body }) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    stopFollowingAdminRun();
    setAdminAuthenticated(false);
    setAdminLoginStatus("登录已过期，请重新登录。", "error");
  }
  if (!response.ok || payload.ok === false) throw createAdminRequestError(response.status, payload);
  return payload.data ?? payload;
}

function getAdminEndpointUrl(pathname) {
  const path = String(pathname || "");
  if (appConfig.answerApiUrl) {
    try {
      const url = new URL(appConfig.answerApiUrl, window.location.href);
      url.pathname = path;
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      // Fall through to the current origin.
    }
  }
  return new URL(path, window.location.origin).toString();
}

function createAdminRequestError(status, payload) {
  const error = new Error(String(payload?.message || payload?.error || `管理接口返回 ${status}`));
  error.status = status;
  error.code = String(payload?.error || "");
  return error;
}

function adminErrorMessage(error, fallback) {
  const messages = {
    admin_login_invalid: "管理员密码不正确。",
    admin_login_rate_limited: "登录尝试过多，请稍后再试。",
    admin_session_required: "请先登录管理员实验室。",
    admin_session_invalid: "登录已失效，请重新登录。",
    admin_session_expired: "登录已过期，请重新登录。",
    admin_csrf_invalid: "安全令牌已失效，请重新登录。",
    capability_unavailable: "后端尚未提供这项实验能力。",
    query_audit_storage_unavailable: "后台历史提问存储尚未配置。",
  };
  return messages[error?.code] || String(error?.message || fallback || "请求失败。");
}

function setAdminRunStatus(message, tone = "") {
  if (!ui.adminRunStatus) return;
  ui.adminRunStatus.textContent = String(message || "");
  ui.adminRunStatus.classList.toggle("is-error", tone === "error");
  ui.adminRunStatus.classList.toggle("is-good", tone === "good");
}

function adminRunStatusMessage(status) {
  const normalized = String(status || "").toLowerCase();
  if (isAdminRunTerminal({ status: normalized })) return `运行${adminRunStatusLabel(normalized)}。`;
  if (normalized) return `运行${adminRunStatusLabel(normalized)}；关闭页面后后端仍可继续。`;
  return "实验记录已建立。";
}

function adminRunStatusLabel(status) {
  const labels = {
    queued: "排队中",
    pending: "等待中",
    created: "已建立",
    running: "进行中",
    in_progress: "进行中",
    completing: "收尾中",
    completed: "已完成",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
    canceled: "已取消",
  };
  const key = String(status || "").toLowerCase();
  return labels[key] || (key ? key : "未知");
}

function isAdminRunTerminal(run) {
  return ADMIN_TERMINAL_STATUSES.has(String(run?.status || "").toLowerCase());
}

function formatAdminDuration(durationMs) {
  const milliseconds = Number(durationMs);
  if (!Number.isFinite(milliseconds)) return "";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} 秒`;
}

function formatAdminMetricDuration(durationMs, serverLabel = "") {
  const number = Number(durationMs);
  const normalizedLabel = String(serverLabel || "").toUpperCase();
  const label = ["FAST", "NORMAL", "SLOW"].includes(normalizedLabel)
    ? normalizedLabel
    : adminDurationCategory(number);
  return Number.isFinite(number)
    ? `${formatAdminDuration(number)} · ${label}`
    : "";
}

function formatAdminCost(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(6)}` : "";
}

function formatAdminCnyCost(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `¥${formatCny(number)}` : "";
}

function formatAdminDate(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

function safeAdminJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || "");
  }
}

function adminDisplayValue(value) {
  if (typeof value === "string") return value;
  return String(value?.text || value?.reason || value?.message || safeAdminJson(value));
}

function firstAdminValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function firstAdminArray(...values) {
  return values.find(Array.isArray) || [];
}

function adminProviderLabel(value) {
  const labels = { openai: "OpenAI", deepseek: "DeepSeek", glm: "智谱 GLM", kimi: "Kimi" };
  return labels[String(value || "").toLowerCase()] || String(value || "");
}

function adminObjectToCsv(value) {
  const rows = [["字段", "值"]];
  flattenAdminCsv(value, "", rows);
  return "\ufeff" + rows.map((row) => row.map(adminCsvCell).join(",")).join("\r\n");
}

function flattenAdminCsv(value, path, rows) {
  if (value === null || value === undefined || typeof value !== "object") {
    rows.push([path || "value", value ?? ""]);
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) rows.push([path, "[]"]);
    value.forEach((item, index) => flattenAdminCsv(item, `${path}[${index}]`, rows));
    return;
  }
  const entries = Object.entries(value);
  if (!entries.length) rows.push([path, "{}"]);
  for (const [key, item] of entries) {
    flattenAdminCsv(item, path ? `${path}.${key}` : key, rows);
  }
}

function adminCsvCell(value) {
  return `"${String(value ?? "").replace(/"/gu, "\"\"")}"`;
}

function downloadAdminFile(fileName, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function adminDelay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function getCardApiUrl() {
  if (!appConfig.answerApiUrl) return "";
  try {
    const url = new URL(appConfig.answerApiUrl);
    url.pathname = url.pathname.replace(/\/api\/answer\/?$/, "/api/card");
    url.search = "";
    return url.toString();
  } catch {
    return appConfig.answerApiUrl.replace(/\/api\/answer\/?$/, "/api/card");
  }
}

function getBudgetApiUrl() {
  if (!appConfig.answerApiUrl) return "";
  try {
    const url = new URL(appConfig.answerApiUrl);
    url.pathname = url.pathname.replace(/\/api\/answer\/?$/, "/api/budget");
    url.search = "";
    return url.toString();
  } catch {
    return appConfig.answerApiUrl.replace(/\/api\/answer\/?$/, "/api/budget");
  }
}

function renderCardDetail(card, detail, status) {
  const name = detail?.name || cardDisplayName(card);
  const aliases = detail?.names?.filter((item) => item && item !== name).slice(0, 3) || [card.jaName, card.enName].filter(Boolean);
  const effect = cleanDisplayText(detail?.effectText || card.effectText || "暂未读取到效果文本。");
  const sourceUrl = detail?.sourceUrl || card.sourceUrl || "";
  const sourceLabel = card.source === "user_provided_text"
    ? "用户提供文本"
    : detail?.sourceLabel || card.sourceLabel || (card.source === "baige" ? "百鸽" : "本地数据库");

  ui.cardName.textContent = name;
  ui.cardMeta.textContent = [detail?.meta || card.cardType, aliases.length ? aliases.join(" / ") : ""].filter(Boolean).join(" · ");
  ui.cardEffect.textContent = effect;
  ui.cardSourceLink.textContent = sourceLabel;
  if (sourceUrl) {
    ui.cardSourceLink.href = sourceUrl;
    ui.cardSourceLink.hidden = false;
    ui.cardSourceLink.removeAttribute("aria-disabled");
  } else {
    ui.cardSourceLink.removeAttribute("href");
    ui.cardSourceLink.hidden = sourceLabel !== "用户提供文本";
    ui.cardSourceLink.setAttribute("aria-disabled", "true");
  }
  ui.cardStatus.textContent = card.source === "user_provided_text"
    ? "用户提供文本"
    : status === "loading" ? "读取资料中" : `${visibleCards.length} 张`;

  const imageCandidates = detail?.imageCandidates?.length ? detail.imageCandidates : buildLocalImageCandidates(card);
  setCardImage(imageCandidates, name);
}

function setCardImage(candidates, altText) {
  const uniqueCandidates = [...new Set((candidates || []).filter(Boolean))];
  ui.cardImage.alt = altText ? `${altText} 卡图` : "卡图";
  ui.cardImagePlaceholder.hidden = false;

  if (!uniqueCandidates.length) {
    ui.cardImage.removeAttribute("src");
    ui.cardImage.hidden = true;
    return;
  }

  let index = 0;
  ui.cardImage.hidden = true;
  ui.cardImage.onload = () => {
    ui.cardImage.hidden = false;
    ui.cardImagePlaceholder.hidden = true;
  };
  ui.cardImage.onerror = () => {
    index += 1;
    if (index >= uniqueCandidates.length) {
      ui.cardImage.hidden = true;
      ui.cardImagePlaceholder.hidden = false;
      return;
    }
    ui.cardImage.hidden = true;
    ui.cardImagePlaceholder.hidden = false;
    ui.cardImage.src = uniqueCandidates[index];
  };
  ui.cardImage.src = uniqueCandidates[index];
}

function buildLocalImageCandidates(card) {
  const providedImages = [card.imageUrl, ...(card.imageCandidates || [])].filter(Boolean);
  const id = (card.passcode || card.id || "").replace(/\D+/g, "");
  if (!id) return providedImages;
  const normalizedId = id.length <= 8 ? id.padStart(8, "0") : id;
  const compactId = normalizedId.replace(/^0+/, "") || normalizedId;
  return [
    ...providedImages,
    getCardImageApiUrl(normalizedId),
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg!half`,
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${compactId}.webp!half`,
    `https://images.ygoprodeck.com/images/cards/${compactId}.jpg`,
    `https://images.ygoprodeck.com/images/cards_cropped/${compactId}.jpg`,
    `https://images.ygoprodeck.com/images/cards_small/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygopro/pics/${normalizedId}.jpg`,
    `https://cdn.233.momobako.com/ygopro/pics/${normalizedId}.jpg!half`,
    `https://cdn.233.momobako.com/ygopro/pics/${normalizedId}.jpg!thumb`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${normalizedId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${normalizedId}.webp!half`,
  ];
}

function getCardImageApiUrl(id) {
  if (!appConfig.answerApiUrl || !id) return "";
  try {
    const url = new URL(appConfig.answerApiUrl);
    url.pathname = url.pathname.replace(/\/api\/answer\/?$/, "/api/card-image");
    url.search = "";
    url.searchParams.set("id", id);
    return url.toString();
  } catch {
    return "";
  }
}

function cleanDisplayText(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\/\s*(p|div|li|tr|section|article)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
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

function cardDisplayName(card) {
  return card.cnName || card.name || card.jaName || card.enName || "未命名卡片";
}

function modelStatusFromAnswer(answer) {
  if (!debugUiEnabled) return "分析完成";
  if (answer?.modelUsed) {
    const provider = modelProviderLabel(answer.modelProvider);
    return answer.modelName ? `${provider} · ${answer.modelName}` : provider;
  }
  if (answer?.warnings?.some((item) => /模型回答失败|模型.*不可用/.test(item))) return "资料检索";
  return "资料检索";
}

function modelProviderLabel(provider) {
  const value = String(provider || "").toLowerCase();
  if (value === "deepseek") return "DeepSeek";
  if (value === "gemini") return "Gemini";
  if (value === "openai") return "OpenAI";
  if (value === "ollama") return "Ollama";
  if (value === "mock") return "RAG Mock";
  if (value === "auto") return "自动";
  return "模型";
}

function basisFromBackendMode(mode) {
  if (mode === "confirmed") return "找到直接问答资料";
  if (mode === "inferred") return "类推/规则推理";
  return "资料不足";
}

function updateModelStatus(text) {
  if (!ui.modelStatusText) return;
  ui.modelStatusText.textContent = text;
}

function renderSubAnswers(subAnswers) {
  if (!ui.subAnswersPanel) return;
  clearElement(ui.subAnswersPanel);
  const items = Array.isArray(subAnswers)
    ? subAnswers.filter((item) => item?.question || item?.verdict || item?.reasoning || item?.reason || item?.conditionalAnswer || item?.provisionalAnswer || item?.ruleDerivedAnswer)
    : [];
  const shouldShowPanel = items.length > 1 || items.some(hasDetailedSubAnswerDisplay);
  if (!items.length || !shouldShowPanel) {
    ui.subAnswersPanel.hidden = true;
    return;
  }

  ui.subAnswersPanel.hidden = false;
  items.forEach((item, index) => {
    const block = document.createElement("div");
    block.className = `sub-answer ${subAnswerVisualClass(item)}`.trim();

    const answerNumber = document.createElement("span");
    answerNumber.className = "sub-answer-number";
    answerNumber.textContent = `Q-${String(index + 1).padStart(2, "0")}`;
    block.appendChild(answerNumber);

    const question = document.createElement("div");
    question.className = "sub-q";
    question.textContent = `问题${index + 1}：${item.question || "未命名子问题"}`;
    block.appendChild(question);

    const status = document.createElement("div");
    status.className = "sub-status";
    status.textContent = subAnswerStatusLabel(item);
    block.appendChild(status);

    const verdict = document.createElement("div");
    verdict.className = "sub-verdict";
    verdict.textContent = formatSubAnswerVerdict(item.verdict);
    if (!item.ruleDerivedAnswer && !item.cardResolutionIssue) block.appendChild(verdict);

    const official = document.createElement("p");
    official.className = "sub-reasoning";
    official.textContent = formatOfficialAnswerLine(item);
    block.appendChild(official);

    if (item.reasoning && !item.ruleDerivedAnswer) {
      const reasoning = document.createElement("p");
      reasoning.className = "sub-reasoning";
      reasoning.textContent = publicReasonForSubAnswer(item);
      block.appendChild(reasoning);
    }

    if (!item.reasoning && item.reason && !item.ruleDerivedAnswer) {
      const reason = document.createElement("p");
      reason.className = "sub-reasoning";
      reason.textContent = publicReasonForSubAnswer(item);
      block.appendChild(reason);
    }

    if (item.stateMessage) {
      const stateMessage = document.createElement("p");
      stateMessage.className = "sub-reasoning";
      stateMessage.textContent = item.stateMessage;
      block.appendChild(stateMessage);
    }

    if (item.conditionalAnswer) {
      renderConditionalAnswer(block, item.conditionalAnswer);
    }

    if (item.provisionalAnswer) {
      renderProvisionalAnswer(block, item.provisionalAnswer);
    }

    if (item.ruleDerivedAnswer && !item.provisionalAnswer) {
      renderRuleDerivedAnswer(block, item.ruleDerivedAnswer);
    } else if (item.likelyAnswer && item.likelyAnswer.status !== "not_available" && !item.provisionalAnswer && !item.cardResolutionIssue) {
      renderLikelyAnswer(block, item.likelyAnswer, item);
    }

    if (item.clarification?.question && !item.conditionalAnswer) {
      renderClarification(block, item.clarification);
    } else if (shouldRenderFallbackClarification(item)) {
      renderClarification(block, {
        question: "需要确认：请补充正式卡名、效果编号、具体时点，或提供能直接覆盖该场景的官方 Q&A / FAQ。",
        options: ["补充正式卡名", "补充效果编号", "补充具体时点", "提供官方 Q&A / FAQ"],
      });
    }

    if (Array.isArray(item.dependencies) && item.dependencies.length) {
      const dependencies = document.createElement("p");
      dependencies.className = "sub-reasoning";
      dependencies.textContent = `依赖的问题：${item.dependencies.map((edge) => `${edge.fromQuestionId}（${edge.relation}）`).join("、")}`;
      block.appendChild(dependencies);
    }

    if (Array.isArray(item.unresolvedDependencies) && item.unresolvedDependencies.length) {
      const unresolved = document.createElement("p");
      unresolved.className = "sub-reasoning";
      unresolved.textContent = `未解决依赖：${item.unresolvedDependencies.join("、")}`;
      block.appendChild(unresolved);
    }

    if (Array.isArray(item.transitionReasoning) && item.transitionReasoning.length) {
      const transition = document.createElement("p");
      transition.className = "sub-reasoning";
      transition.textContent = `状态转移推理：${item.transitionReasoning.map((rule) => rule.reason).join("；")}`;
      block.appendChild(transition);
    }

    if (Array.isArray(item.ruleSources) && item.ruleSources.length) {
      const ruleSources = document.createElement("p");
      ruleSources.className = "sub-source";
      ruleSources.textContent = `规则来源：${item.ruleSources.map((sourceItem) => {
        const ids = sourceItem.sourceIds?.length ? ` ${sourceItem.sourceIds.join(", ")}` : " 无证据 ID";
        return `${sourceItem.sourceType}${ids}`;
      }).join("；")}`;
      block.appendChild(ruleSources);
    }

    if (Array.isArray(item.evidenceIds) && item.evidenceIds.length) {
      const evidenceIds = document.createElement("p");
      evidenceIds.className = "sub-source";
      evidenceIds.textContent = `依据 ID：${item.evidenceIds.join("、")}`;
      block.appendChild(evidenceIds);
    }

    const source = document.createElement("p");
    source.className = "sub-source";
    source.textContent = item.source ? `来源：${item.source}` : "来源：[推理，需确认]";
    block.appendChild(source);

    ui.subAnswersPanel.appendChild(block);
  });
}

function hasDetailedSubAnswerDisplay(item) {
  return Boolean(
    item?.conditionalAnswer ||
    item?.provisionalAnswer ||
    item?.ruleDerivedAnswer ||
    item?.likelyAnswer ||
    item?.clarification ||
    item?.reasoning ||
    item?.reason ||
    item?.stateMessage ||
    item?.dependencies?.length ||
    item?.unresolvedDependencies?.length ||
    item?.transitionReasoning?.length ||
    item?.ruleSources?.length ||
    item?.evidenceIds?.length
  );
}

function subAnswerStatusLabel(item) {
  if (item?.officialAnswer?.status === "confirmed" || item?.status === "confirmed") return "OFFICIAL · 官方直接裁定";
  if (item?.ruleDerivedAnswer?.status === "rule_derived") return "RULE-DERIVED · 规则推导结论";
  if (item?.provisionalAnswer) return "PROVISIONAL · 事务局回答参考";
  if (item?.conditionalAnswer) return "条件不足";
  if (item?.cardResolutionIssue || item?.clarification?.question?.includes("哪张卡")) return "VERIFY-CARD · 卡名需要确认";
  if (item?.likelyAnswer && item.likelyAnswer.status !== "not_available") return "可能处理（未确认）";
  if (item?.status === "inferred") return "可能处理（未确认）";
  if (item?.status === "parse_failed") return "解析失败";
  return "资料不足";
}

function subAnswerVisualClass(item) {
  if (item?.officialAnswer?.status === "confirmed" || item?.status === "confirmed") return "is-official";
  if (item?.ruleDerivedAnswer?.status === "rule_derived") return "is-rule-derived";
  if (item?.provisionalAnswer) return "is-provisional";
  if (item?.conditionalAnswer) return "is-needs-state";
  if (item?.clarification?.question || item?.cardResolutionIssue) return "is-verify-card";
  return "is-unknown";
}

function formatSubAnswerVerdict(verdict) {
  if (!verdict) return "需要确认";
  if (typeof verdict === "object") return JSON.stringify(verdict);
  return String(verdict);
}

function renderConditionalAnswer(parent, conditionalAnswer) {
  const wrapper = document.createElement("div");
  wrapper.className = "sub-reasoning";

  const intro = document.createElement("p");
  intro.textContent = "当前无法确定唯一结论。已找到相关 FAQ/Q&A，但需要确认适用哪个条件分支。";
  wrapper.appendChild(intro);

  if (Array.isArray(conditionalAnswer.branches) && conditionalAnswer.branches.length) {
    const title = document.createElement("p");
    title.textContent = "可能分支：";
    wrapper.appendChild(title);

    const list = document.createElement("ul");
    conditionalAnswer.branches.forEach((branch) => {
      const item = document.createElement("li");
      item.textContent = `${branch.label || "如果满足该分支条件"}：${branch.explanation || branch.verdict || "unknown"}`;
      list.appendChild(item);
    });
    wrapper.appendChild(list);
  }

  if (conditionalAnswer.clarificationQuestion) {
    const clarify = document.createElement("p");
    clarify.textContent = conditionalAnswer.clarificationQuestion;
    wrapper.appendChild(clarify);
  }

  parent.appendChild(wrapper);
}

function renderProvisionalAnswer(parent, provisionalAnswer) {
  const wrapper = document.createElement("div");
  wrapper.className = "sub-reasoning";

  const title = document.createElement("p");
  title.textContent = "事务局回答参考（截图，官方数据库未收录）：";
  wrapper.appendChild(title);

  const verdict = document.createElement("p");
  verdict.textContent = formatProvisionalVerdict(provisionalAnswer.verdict, provisionalAnswer.explanation);
  wrapper.appendChild(verdict);

  const note = document.createElement("p");
  note.textContent = "注意：该回答目前未在官方数据库中找到直接 Q&A。后续如果数据库更新，系统会优先改用官方数据库裁定。";
  wrapper.appendChild(note);

  parent.appendChild(wrapper);
}

function renderRuleDerivedAnswer(parent, answer) {
  const wrapper = document.createElement("section");
  wrapper.className = "rule-derived-answer";

  const title = document.createElement("h4");
  title.textContent = answer.displayLabel || "规则推导结论";
  wrapper.appendChild(title);

  const shortAnswer = document.createElement("p");
  shortAnswer.className = "rule-derived-short";
  shortAnswer.textContent = answer.shortAnswer || formatSubAnswerVerdict(answer.verdict);
  wrapper.appendChild(shortAnswer);

  if (Array.isArray(answer.reasoningSteps) && answer.reasoningSteps.length) {
    const list = document.createElement("ol");
    list.className = "rule-derived-steps";
    answer.reasoningSteps.forEach((reasoningStep) => {
      const item = document.createElement("li");
      const basis = reasoningStep.ruleBasis ? ` [${reasoningStep.ruleBasis}]` : "";
      item.textContent = `${reasoningStep.explanation}${basis}`;
      list.appendChild(item);
    });
    wrapper.appendChild(list);
  }

  if (Array.isArray(answer.assumptions) && answer.assumptions.length) {
    const assumptions = document.createElement("p");
    assumptions.className = "rule-derived-meta";
    assumptions.textContent = `推导前提：${answer.assumptions.join("；")}`;
    wrapper.appendChild(assumptions);
  }

  const notice = document.createElement("p");
  notice.className = "rule-derived-notice";
  notice.textContent = answer.notice || "未找到完全同场景的直接 Q&A。如存在相反裁定，应以官方数据库或事务局回答为准。";
  wrapper.appendChild(notice);

  parent.appendChild(wrapper);
}

function renderLikelyAnswer(parent, likelyAnswer, context = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "sub-reasoning";

  const title = document.createElement("p");
  title.textContent = "未确认分析：";
  wrapper.appendChild(title);

  const body = document.createElement("div");
  const verdict = likelyAnswer.verdict && likelyAnswer.verdict !== "unknown"
    ? `倾向：${formatSubAnswerVerdict(likelyAnswer.verdict)}。`
    : "";
  const structured = [
    likelyAnswer.issueSummary ? `问题核心：${likelyAnswer.issueSummary}` : "",
    likelyAnswer.possibleHandling ? `未确认分析：${likelyAnswer.possibleHandling}` : "",
    likelyAnswer.whyNotConfirmed ? `为什么不能确认：${likelyAnswer.whyNotConfirmed}` : "",
    likelyAnswer.neededEvidence ? `需要确认：${likelyAnswer.neededEvidence}` : "",
  ].filter(Boolean);
  const fallbackStructured = [
    context.sourceText ? `问题核心：${context.sourceText}` : "",
    "未确认分析：",
    likelyAnswer.reasoning || "只能给出未确认处理参考。",
    "为什么不能确认：目前没有能直接回答当前问题的官方 Q&A / FAQ。",
    "需要确认：需要能覆盖该场景的官方 Q&A / FAQ / 事务局回答。",
  ].filter(Boolean).join(" ");
  body.textContent = `${verdict}${structured.length ? structured.join(" ") : fallbackStructured} ${likelyAnswer.disclaimer || "未确认裁定，不能替代官方 Q&A"}`.trim();
  wrapper.appendChild(body);

  if (Array.isArray(likelyAnswer.riskFlags) && likelyAnswer.riskFlags.length) {
    const risk = document.createElement("p");
    risk.textContent = `风险提示：${likelyAnswer.riskFlags.map(formatRiskFlag).join("、")}`;
    wrapper.appendChild(risk);
  }

  parent.appendChild(wrapper);
}

function renderClarification(parent, clarification) {
  const wrapper = document.createElement("div");
  wrapper.className = "sub-reasoning";
  const question = document.createElement("p");
  question.textContent = clarification.question;
  wrapper.appendChild(question);
  if (Array.isArray(clarification.options) && clarification.options.length) {
    const options = document.createElement("p");
    options.textContent = `可选项：${clarification.options.join("、")}`;
    wrapper.appendChild(options);
  }
  parent.appendChild(wrapper);
}

function shouldRenderFallbackClarification(item) {
  if (!item || item.status !== "unknown") return false;
  if (item.ruleDerivedAnswer || (item.likelyAnswer && item.likelyAnswer.status !== "not_available") || item.conditionalAnswer || item.provisionalAnswer || item.clarification?.question) return false;
  return true;
}

function formatOfficialAnswerLine(item) {
  const official = item?.officialAnswer || {};
  if (official.status === "confirmed") {
    return `官方直接裁定：已确认。依据 ID：${(official.evidenceIds || item.evidenceIds || []).join("、") || "未列出"}`;
  }
  if (official.status === "parse_failed") return "官方确认：形式化解析失败，无法进入裁定判断。";
  return "官方直接裁定：未检索到完全同场景的 Q&A / FAQ。";
}

function publicReasonForSubAnswer(item) {
  if (item?.displayReason) return item.displayReason;
  if (item?.cardResolutionIssue) return "卡名没有 exact match，不能自动套用较短候选卡。";
  if (item?.ruleDerivedAnswer?.status === "rule_derived") return "以下处理由公开规则、卡片文本与官方裁定结构推导，不改变 official confirmed 状态。";
  if (item?.provisionalAnswer) return "官方数据库暂无直接裁定；存在事务局回答截图，需要后续复核。";
  if (item?.conditionalAnswer) return "已找到相关 FAQ，但当前问题缺少必要状态，无法确定适用哪个分支。";
  if (item?.unresolvedDependencies?.length) return "该问题依赖另一个子问题的结果，当前不能确认。";
  const reason = String(item?.reason || item?.reasoning || "");
  if (/conflicting_direct_evidence|conflicting_similar_evidence|冲突/u.test(reason)) return "候选资料结论冲突，不能确认。";
  if (/condition_branch_missing_state|condition_branch_ambiguous/u.test(reason)) return "已找到条件分支证据，但当前场景不足以选择唯一分支。";
  if (/no_direct_evidence|similar_evidence|evidence_mentions_action_but_not_asked_result|no_explicit_polarity/u.test(reason)) return "找到的资料与本题相关，但没有直接回答当前问题。";
  if (/card_text_only/u.test(reason)) return "目前只有卡片文本，没有直接 Q&A。";
  if (/rejected_evidence_only|matcher_rejected_all|different_question|question_type_mismatch/u.test(reason)) return "候选资料回答的是不同问题或场景不一致。";
  if (/parse_failed|formal_query_parse_failed/u.test(reason)) return "形式化解析失败，需要补充卡名、效果编号或问题类型。";
  if (/parser_warning/u.test(reason)) return "形式化解析存在不确定项，不能确认裁定。";
  return "暂时不能确认，需要官方 Q&A 或补充场景。";
}

function formatRiskFlag(flag) {
  const labels = {
    card_name_unresolved: "卡名未确认",
    card_name_not_resolved: "没有完全确认全部卡名。",
    question_type_unknown: "问题类型未确认",
    official_database_not_found: "官方数据库未收录",
    official_direct_qa_not_found: "没有命中官方直接 Q&A。",
    no_official_direct_qa: "没有命中官方直接 Q&A，以下为未确认分析。",
    no_retrieved_evidence: "当前没有检索到可用资料。",
    user_provided_text_not_official: "使用了用户提供文本，不能视作官方资料。",
    official_confirmed_requires_direct_evidence: "缺少官方直接依据，不能标记为官方确认。",
    card_text_grounding_only: "主要依据卡片文本，仍需官方资料复核。",
    card_text_only: "目前只有卡片文本，没有直接 Q&A。",
    baige_ambiguous: "百鸽检索存在多个相近候选，需要复核卡名。",
    baige_no_result: "百鸽没有找到对应卡片。",
    model_json_parse_failed: "模型返回格式异常，已做保守处理。",
    model_json_repaired: "模型返回格式不完整，系统已做保守恢复。",
    model_reasoning_missing: "模型没有返回可核对的理由，请结合资料来源复核结论。",
    model_reasoning_recovered_from_short_answer: "模型未分离结论与理由，系统已保留可识别的解释。",
    model_output_not_json: "模型没有按预期格式返回。",
    no_card_text: "没有拿到全部关键卡片的效果文本。",
    ambiguous_card_name: "部分卡名存在歧义，需要复核。",
    condition_branch_requires_state: "缺少条件分支状态",
    similar_evidence_only: "只有相似资料",
    unresolved_dependency: "依赖子问题未解决",
    conflicting_evidence: "候选资料冲突",
    different_question_evidence: "候选资料回答不同问题",
    no_direct_evidence: "没有 direct evidence",
    insufficient_context: "上下文不足",
    formal_engine_unknown: "形式规则内核本次未签发确定性证明；这不等于“不能”。",
    formal_engine_conditional: "形式规则内核只得到依赖显式假设的条件分析。",
    formal_engine_unverified: "形式规则内核结果尚未通过证明校验，不能作为权威结论。",
  };
  const text = labels[flag] || labels[String(flag).split(":")[0]];
  if (text) return text;
  return String(flag || "")
    .replace(/_/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function formatProvisionalVerdict(verdict, fallback) {
  if (verdict && typeof verdict === "object") {
    const activation = verdict.activation === "can_activate" ? "可以发动" : "";
    const cost = verdict.cost === "can_pay_cost" ? "并支付 cost" : "";
    const resolution = verdict.resolution === "does_not_perform_fusion_material_processing"
      ? "但后续处理不进行"
      : "";
    const text = [activation + cost, resolution].filter(Boolean).join("，");
    if (text) return `${text}。`;
  }
  return fallback || "存在事务局回答截图，但当前不作为 confirmed。";
}

function renderList(container, items) {
  clearElement(container);
  container.classList.remove("progress-steps");
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "暂无";
    container.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    container.appendChild(li);
  }
}

function startPendingStages() {
  clearPendingStages(false);
  const stages = getPendingStages();
  pendingStageIndex = 0;
  pendingStageEnteredAt = stages.map(() => null);
  pendingStageDurationsMs = stages.map(() => null);
  pendingPipelineStartedAt = readMonotonicNow();
  pendingPipelineTotalMs = null;
  pendingPipelineStatus = "running";
  pendingStageEnteredAt[0] = pendingPipelineStartedAt;
  if (ui.pipelineTimingPanel) ui.pipelineTimingPanel.hidden = false;
  renderPendingStages(0, stages);
  pendingStageDelays.slice(0, stages.length).forEach((delay, index) => {
    if (index === 0) return;
    const timer = setTimeout(() => {
      const now = readMonotonicNow();
      const previousIndex = pendingStageIndex;
      if (
        previousIndex < index
        && pendingStageEnteredAt[previousIndex] !== null
        && pendingStageDurationsMs[previousIndex] === null
      ) {
        pendingStageDurationsMs[previousIndex] = Math.max(
          0,
          now - pendingStageEnteredAt[previousIndex],
        );
      }
      pendingStageIndex = index;
      if (pendingStageEnteredAt[index] === null) pendingStageEnteredAt[index] = now;
      renderPendingStages(index, stages);
    }, delay);
    pendingStageTimers.push(timer);
  });
  pendingStageTickTimer = window.setInterval(() => {
    renderPendingStages(pendingStageIndex, stages);
  }, 250);
}

function clearPendingStages(clearClass = true) {
  for (const timer of pendingStageTimers) clearTimeout(timer);
  pendingStageTimers = [];
  if (pendingStageTickTimer) window.clearInterval(pendingStageTickTimer);
  pendingStageTickTimer = 0;
  if (clearClass) {
    pendingPipelineStartedAt = null;
    pendingPipelineTotalMs = null;
    pendingPipelineStatus = "idle";
    pendingStageEnteredAt = [];
    pendingStageDurationsMs = [];
    if (ui.pipelineTimingPanel) ui.pipelineTimingPanel.hidden = true;
    if (ui.pipelineStageList) clearElement(ui.pipelineStageList);
    if (ui.pipelineElapsedText) ui.pipelineElapsedText.textContent = "";
  }
}

function renderPendingStages(activeIndex, stages = getPendingStages()) {
  if (!ui.pipelineStageList) return;
  clearElement(ui.pipelineStageList);
  stages.forEach((stage, index) => {
    const item = document.createElement("li");
    item.className = pendingPipelineStatus === "failed" && index === activeIndex
      ? "progress-step is-failed"
      : index < activeIndex ? "progress-step is-done"
      : index === activeIndex && pendingPipelineStatus === "running" ? "progress-step is-current"
        : "progress-step is-waiting";
    const marker = document.createElement("span");
    marker.className = "progress-step-marker";
    marker.textContent = pendingPipelineStatus === "failed" && index === activeIndex
      ? "!"
      : index < activeIndex ? "✓"
      : index === activeIndex && pendingPipelineStatus === "running" ? "•" : "·";
    const label = document.createElement("span");
    label.textContent = stage.label;
    const time = document.createElement("span");
    time.className = "progress-step-time";
    const durationMs = index < activeIndex
      ? pendingStageDurationsMs[index]
      : index === activeIndex && pendingStageEnteredAt[index] !== null
        ? Math.max(0, readMonotonicNow() - pendingStageEnteredAt[index])
        : null;
    time.textContent = durationMs === null
      ? ""
      : formatPendingStageDuration(durationMs);
    item.append(marker, label, time);
    ui.pipelineStageList.appendChild(item);
  });
  renderPendingPipelineTotal();
  if (pendingPipelineStatus !== "running") return;
  const stage = stages[Math.min(activeIndex, stages.length - 1)];
  ui.verdictTitle.textContent = stage.label === "生成裁定" ? "正在生成裁定" : `正在${stage.label}`;
  ui.verdictBody.textContent = stage.body;
}

function completePendingStages(answer) {
  const stages = getPendingStages();
  const completedAt = readMonotonicNow();
  const clientTotalMs = pendingPipelineStartedAt === null
    ? null
    : Math.max(0, completedAt - pendingPipelineStartedAt);
  const backend = extractBackendPipelineTimings(answer, stages);
  clearPendingStages(false);
  pendingPipelineStatus = "completed";
  pendingPipelineTotalMs = backend.totalMs ?? clientTotalMs ?? 0;
  pendingStageDurationsMs = stages.map((stage, index) => (
    backend.stageDurationsMs[stage.id]
    ?? pendingStageDurationsMs[index]
    ?? (pendingStageEnteredAt[index] === null ? 0 : Math.max(0, completedAt - pendingStageEnteredAt[index]))
  ));
  pendingStageEnteredAt = stages.map(() => null);
  pendingStageIndex = stages.length;
  if (ui.pipelineTimingPanel) ui.pipelineTimingPanel.hidden = false;
  if (ui.pipelineElapsedText) {
    ui.pipelineElapsedText.title = backend.usesServerTiming
      ? "总计采用后端实测墙钟耗时；部分阶段可能并行。"
      : "后端未返回总耗时，当前采用浏览器单调计时。";
  }
  renderPendingStages(stages.length, stages);
}

function failPendingStages() {
  const stages = getPendingStages();
  const now = readMonotonicNow();
  clearPendingStages(false);
  if (pendingPipelineStartedAt === null) {
    clearPendingStages();
    return;
  }
  const activeStartedAt = pendingStageEnteredAt[pendingStageIndex];
  if (activeStartedAt !== null && pendingStageDurationsMs[pendingStageIndex] === null) {
    pendingStageDurationsMs[pendingStageIndex] = Math.max(0, now - activeStartedAt);
  }
  pendingPipelineTotalMs = Math.max(0, now - pendingPipelineStartedAt);
  pendingPipelineStatus = "failed";
  if (ui.pipelineTimingPanel) ui.pipelineTimingPanel.hidden = false;
  if (ui.pipelineElapsedText) ui.pipelineElapsedText.title = "请求失败前的浏览器单调计时。";
  renderPendingStages(pendingStageIndex, stages);
}

function renderPendingPipelineTotal() {
  if (!ui.pipelineElapsedText) return;
  const runningMs = pendingPipelineStartedAt === null
    ? null
    : Math.max(0, readMonotonicNow() - pendingPipelineStartedAt);
  const durationMs = pendingPipelineTotalMs ?? runningMs;
  ui.pipelineElapsedText.textContent = durationMs === null
    ? ""
    : `总计 ${formatPendingStageDuration(durationMs)}`;
}

function extractBackendPipelineTimings(answer, stages = getPendingStages()) {
  const pipeline = answer?.debug?.timingsMs || answer?.timingsMs || {};
  const retrieval = answer?.debug?.retrievalStageTimingsMs
    || answer?.retrievalStageTimingsMs
    || {};
  const stageDurationsMs = {
    understand: sumFiniteDurations(pipeline.dataLoad, pipeline.deterministicPreflight),
    extract_card_names: readFiniteDuration(pipeline.auxiliaryExtractionModels),
    retrieve_card_texts: readFiniteDuration(retrieval.cardResolution),
    retrieve_rulings: sumFiniteDurations(
      retrieval.data,
      retrieval.rulebook,
      retrieval.officialQa,
      retrieval.relatedEvidence,
    ),
    simulate: sumFiniteDurations(pipeline.formalEngineAwait, pipeline.engineAwait),
    generate_ruling: sumFiniteDurations(
      pipeline.localReasoning,
      pipeline.rulebookGrounding,
      pipeline.finalModel,
    ),
  };
  const knownStageIds = new Set(stages.map((stage) => stage.id));
  for (const key of Object.keys(stageDurationsMs)) {
    if (!knownStageIds.has(key) || stageDurationsMs[key] === null) delete stageDurationsMs[key];
  }
  const totalMs = readFiniteDuration(pipeline.total);
  return {
    stageDurationsMs,
    totalMs,
    usesServerTiming: totalMs !== null || Object.keys(stageDurationsMs).length > 0,
  };
}

function readFiniteDuration(value) {
  if (value === null || value === undefined || value === "") return null;
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function sumFiniteDurations(...values) {
  const durations = values.map(readFiniteDuration).filter((value) => value !== null);
  return durations.length ? durations.reduce((sum, value) => sum + value, 0) : null;
}

function readMonotonicNow() {
  if (globalThis.performance && typeof globalThis.performance.now === "function") {
    return globalThis.performance.now();
  }
  return Date.now();
}

function formatPendingStageDuration(milliseconds) {
  const seconds = Math.max(0, Number(milliseconds) || 0) / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} 秒`;
}

function renderEngineSimulation(engine, simulation) {
  if (!ui.simulationPanel || !ui.simulationStatus || !ui.simulationSummary || !ui.simulationDetails) return;
  const status = String(engine?.status || "not_requested");
  if (!engine || (!debugUiEnabled && (status !== "completed" || !simulation))) {
    ui.simulationPanel.hidden = true;
    ui.simulationPanel.className = "result-block simulation-panel";
    ui.simulationStatus.textContent = "";
    ui.simulationSummary.textContent = "";
    clearElement(ui.simulationDetails);
    return;
  }

  const details = [];
  let className = "is-unavailable";
  let statusLabel = "尚未执行";
  let summary = "本题尚未生成可复现的对局场景，以上结论仅来自资料分析。";

  if (status === "completed" && simulation) {
    const stepCount = Array.isArray(simulation.steps) ? simulation.steps.length : 0;
    const consumedResponses = Number(simulation.consumedResponses || 0);
    const trace = String(simulation.traceSha256 || "");
    const complete = simulation.status === "ended" && simulation.incomplete !== true;
    const bestEffort = engine.bestEffort === true || simulation.bestEffort === true;
    className = complete ? "is-completed" : "is-incomplete";
    statusLabel = complete
      ? (bestEffort ? "尽力轨迹完成" : "轨迹完成")
      : (bestEffort ? "尽力轨迹待续" : "轨迹待继续");
    summary = complete
      ? "模拟器已完成一条可复现轨迹。资料分析与模拟结果分别展示。"
      : bestEffort
        ? "已按题目尽力编译并运行场景；轨迹停在需要下一次操作的位置。"
        : "模拟器已运行到需要下一次操作的位置，当前轨迹尚未结束。";
    const plannedResponses = Number(engine.planSummary?.responseCount || 0);
    details.push(`执行节点：${stepCount}；已处理操作：${Number.isFinite(consumedResponses) ? consumedResponses : 0}${bestEffort ? ` / 计划 ${plannedResponses}` : ""}。`);
    if (bestEffort && engine.planSummary) {
      details.push(`自动场景包含 ${Number(engine.planSummary.cardCount || 0)} 张题目相关卡片。`);
    }
    if (simulation.responseFailure) {
      details.push(`自动操作在第 ${Number(simulation.responseFailure.responseIndex || 0) + 1} 步停止，已执行轨迹仍保留。`);
    }
    if (trace) details.push(`轨迹编号：${trace.slice(0, 16)}。`);
    const zoneSummary = engineZoneSummary(simulation.zoneCounts);
    const promptSummary = complete ? "" : enginePromptSummary(simulation);
    if (zoneSummary) details.push(zoneSummary);
    if (promptSummary) details.push(promptSummary);
    details.push(simulation.policy?.warning || "模拟器结果不是官方裁定，卡片脚本也可能存在缺陷。");
  } else if (status === "disabled") {
    statusLabel = "未启用";
    summary = "当前部署没有连接模拟器，以上结论仅来自资料分析。";
  } else if (status === "unavailable") {
    statusLabel = "暂不可用";
    summary = "模拟器本次没有返回可验证轨迹，资料分析结果仍独立保留。";
    if (debugUiEnabled && engine.error?.message) details.push(engine.error.message);
  } else {
    details.push("本题没有生成可执行场景，资料分析结果不受影响。");
  }

  ui.simulationPanel.hidden = false;
  ui.simulationPanel.className = `result-block simulation-panel ${className}`;
  ui.simulationStatus.textContent = statusLabel;
  ui.simulationSummary.textContent = summary;
  renderList(ui.simulationDetails, details);
}

function engineZoneSummary(zoneCounts) {
  const self = zoneCounts?.[0] || zoneCounts?.["0"];
  const opponent = zoneCounts?.[1] || zoneCounts?.["1"];
  if (!self || !opponent) return "";
  const side = (label, zones) => `${label}手牌 ${Number(zones.hand || 0)}、怪兽区 ${Number(zones.monster_zone || 0)}、魔法陷阱区 ${Number(zones.spell_trap_zone || 0)}`;
  return `引擎场面：${side("我方", self)}；${side("对方", opponent)}。`;
}

function enginePromptSummary(simulation) {
  const messages = (simulation?.steps || []).flatMap((step) => step.messages || []);
  const prompt = [...messages].reverse().find((message) => String(message?.messageName || "").startsWith("select_"));
  if (!prompt) return "";
  const labels = {
    select_idle_command: "选择主要阶段操作",
    select_effect_yes_no: "确认是否发动效果",
    select_yes_no: "确认下一步操作",
    select_option: "选择效果选项",
    select_card: "选择卡片",
    select_chain: "选择是否连锁",
    select_place: "选择放置区域",
    select_disabled_field: "选择区域",
    select_position: "选择表示形式",
    select_unselect_card: "调整所选卡片",
  };
  const semantic = prompt.semantic || {};
  let count = null;
  if (Array.isArray(semantic.cards)) count = semantic.cards.length;
  else if (Array.isArray(semantic.options)) count = semantic.options.length;
  else if (Array.isArray(semantic.selectable)) count = semantic.selectable.length;
  else if (semantic.actions) {
    count = Object.values(semantic.actions).reduce((total, value) => (
      total + (Array.isArray(value) ? value.length : value === true ? 1 : 0)
    ), 0);
  }
  const label = labels[prompt.messageName] || "继续选择操作";
  return `当前等待：${label}${Number.isInteger(count) ? `（${count} 个可选项）` : ""}。`;
}

function renderSources(sources) {
  clearElement(ui.sourcesList);
  if (!sources.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无出处";
    ui.sourcesList.appendChild(empty);
    return;
  }

  for (const source of sources) {
    const normalizedSource = typeof source === "string" ? { label: "资料来源", detail: source } : source;
    const detail = normalizedSource.detail || normalizedSource.title || "";
    const url = normalizedSource.url || normalizedSource.sourceUrl || (/^https?:\/\//i.test(detail) ? detail : "");
    const node = document.createElement("div");
    node.className = "source-item";
    appendText(node, "strong", normalizedSource.label || normalizedSource.name || "资料来源");
    const hasDetailLine = Boolean(detail && detail !== url);
    if (hasDetailLine) appendText(node, "p", normalizedSource.id ? `${detail} (${normalizedSource.id})` : detail);
    if (/^https?:\/\//i.test(url)) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = url;
      node.appendChild(link);
    } else if (!hasDetailLine) {
      appendText(node, "p", detail || "未提供链接");
    }
    ui.sourcesList.appendChild(node);
  }
}

function renderFeedbackPanel(answer) {
  if (!ui.verdictBlock) return;
  const existing = ui.verdictBlock.querySelector(".feedback-panel");
  if (existing) existing.remove();
  if (!answer || answer.status === "data_source_missing") return;

  const panel = document.createElement("div");
  panel.className = "feedback-panel";
  const link = document.createElement("a");
  link.className = "feedback-link";
  link.href = buildFeedbackIssueUrl(answer);
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "在 GitHub 反馈这个回答";
  panel.appendChild(link);
  ui.verdictBlock.appendChild(panel);
}

function buildFeedbackIssueUrl(answer) {
  const question = answer?.formalQuery?.originalText || ui.questionInput.value.trim() || "未提供问题";
  const currentAnswer = String(answer?.shortAnswer || answer?.verdict || "未返回结论").trim();
  const reasoning = (Array.isArray(answer?.reasoning) ? answer.reasoning : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((item, index) => `${index + 1}. ${item}`);
  const rulingVersion = normalizeRulingVersion(
    answer?.effectiveRulingVersion || answer?.rulingVersion,
  );
  const rulingVersionLabel = rulingVersion === "previous" ? "上一版（兼容）" : "最新版";
  const body = [
    "## 原问题",
    question,
    "",
    "## 当前回答",
    currentAnswer,
    ...(reasoning.length ? ["", "## 当前理由", ...reasoning] : []),
    "",
    "## 使用模型",
    "DeepSeek V4 Flash",
    "",
    "## 回答版本",
    rulingVersion ? rulingVersionLabel : "版本未确认",
    "",
    "## 反馈内容",
    "请说明错误之处，并尽量附上官方 Q&A、规则书或其他可核对来源。",
  ].join("\n");
  const url = new URL("https://github.com/coldiceh/ocg-ruling-assistant/issues/new");
  url.searchParams.set("title", `[回答反馈] ${question.slice(0, 60)}`);
  url.searchParams.set("body", body);
  return url.href;
}

function appendText(parent, tagName, text) {
  const node = document.createElement(tagName);
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

function clearElement(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

async function init() {
  debugUiEnabled = isDebugUiEnabled();
  adminUiEnabled = isAdminUiEnabled();
  if (ui.adminLabPanel) ui.adminLabPanel.hidden = !adminUiEnabled;
  applyTheme(readInitialTheme());
  await loadAppConfig();
  await loadBackendModelInfo();
  await loadSyncedData();
  if (ui.pipelineDebugToggle) ui.pipelineDebugToggle.hidden = !debugUiEnabled;
  await loadBudgetStatus();
  updateSourceStatus();
  resetAnalysis();
  if (adminUiEnabled) await initializeAdminLab();

  ui.analyzeButton.addEventListener("click", () => analyzeQuestion());
  ui.questionInput.addEventListener("input", scheduleAnalysis);
  ui.clearButton.addEventListener("click", () => {
    clearTimeout(analysisTimer);
    ui.questionInput.value = "";
    analyzeQuestion();
    ui.questionInput.focus();
  });
  ui.themeToggle?.addEventListener("click", () => {
    const nextTheme = document.body.classList.contains("theme-night") ? "day" : "night";
    applyTheme(nextTheme);
    try {
      localStorage.setItem(themeStorageKey, nextTheme);
    } catch {
      // Theme persistence is optional.
    }
  });
  for (const button of ui.rulingVersionButtons || []) {
    button.addEventListener("click", () => selectRulingVersion(button.dataset.rulingVersion));
  }
  ui.budgetResetButton?.addEventListener("click", () => resetBudgetStatus());
  ui.adminLoginForm?.addEventListener("submit", handleAdminLogin);
  ui.adminLogoutButton?.addEventListener("click", handleAdminLogout);
  ui.adminCopyPublicQuestionButton?.addEventListener("click", () => {
    ui.adminQuestionInput.value = ui.questionInput.value;
    ui.adminQuestionInput.focus();
  });
  ui.adminProviderSelect?.addEventListener("change", syncAdminModelControls);
  ui.adminModelSelect?.addEventListener("change", syncAdminModelSpecificControls);
  ui.adminModeSelect?.addEventListener("change", syncAdminFinalReasoningCompatibility);
  ui.adminPreparationProviderSelect?.addEventListener("change", syncAdminPreparationModelControls);
  ui.adminPreparationModelSelect?.addEventListener("change", syncAdminPreparationModelSpecificControls);
  ui.adminStartButton?.addEventListener("click", startAdminExperiment);
  ui.adminCancelButton?.addEventListener("click", cancelAdminExperiment);
  ui.adminHistoryRefreshButton?.addEventListener("click", loadAdminHistory);
  ui.adminQuestionHistoryRefreshButton?.addEventListener("click", loadAdminQuestionHistory);
  ui.adminEvaluationRefreshButton?.addEventListener("click", loadAdminEvaluationCases);
  ui.adminEvaluationLoadButton?.addEventListener("click", loadSelectedAdminEvaluation);
  ui.adminRatingForm?.addEventListener("submit", submitAdminRating);
  ui.adminExportJsonButton?.addEventListener("click", () => exportAdminRun("json"));
  ui.adminExportCsvButton?.addEventListener("click", () => exportAdminRun("csv"));
}

function selectRulingVersion(version) {
  const nextVersion = version === "previous" ? "previous" : "latest";
  if (!isRulingVersionSupported(nextVersion)) return;
  if (nextVersion === selectedRulingVersion) return;
  selectedRulingVersion = nextVersion;
  analysisRequestId += 1;
  clearTimeout(analysisTimer);
  for (const button of ui.rulingVersionButtons || []) {
    const selected = button.dataset.rulingVersion === selectedRulingVersion;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  resetAnalysis();
}

function scheduleAnalysis() {
  clearTimeout(analysisTimer);
  if (!ui.questionInput.value.trim()) {
    analyzeQuestion();
    return;
  }
  if (appConfig.answerApiUrl) {
    analysisRequestId += 1;
    resetAnalysis();
    return;
  }
  analysisTimer = setTimeout(analyzeQuestion, appConfig.answerApiUrl ? 650 : 250);
}

init();

function isDebugUiEnabled() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("debug") === "1";
  } catch {
    return false;
  }
}

function isAdminUiEnabled() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("admin") === "1";
  } catch {
    return false;
  }
}
function readInitialTheme() {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    if (stored === "day" || stored === "night") return stored;
  } catch {
    // Ignore unavailable storage.
  }
  return "night";
}

function applyTheme(theme) {
  const normalized = theme === "night" ? "night" : "day";
  document.body.classList.toggle("theme-night", normalized === "night");
  document.body.classList.toggle("theme-day", normalized !== "night");
  if (ui.themeToggle) ui.themeToggle.textContent = normalized === "night" ? "白天模式" : "黑夜模式";
}
