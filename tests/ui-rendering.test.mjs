import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildConditionalBranchLines,
  buildUserFacingSubAnswerSummary,
  statusLabelForSubAnswer,
} from "../src/uiPresentation.mjs";

test("confirmed answer displays 官方直接裁定", () => {
  const summary = buildUserFacingSubAnswerSummary({
    status: "confirmed",
    verdict: "can",
    evidenceIds: ["qa-1"],
  });
  assert.equal(summary.statusLabel, "官方直接裁定");
  assert.equal(summary.verdictText, "can");
});

test("provisionalAnswer displays unconfirmed official-response screenshot wording", () => {
  const summary = buildUserFacingSubAnswerSummary({
    status: "unknown",
    verdict: "unknown",
    provisionalAnswer: {
      sourceType: "official_response_screenshot",
      verdict: {
        activation: "can_activate",
        cost: "can_pay_cost",
        resolution: "does_not_perform_fusion_material_processing",
      },
    },
  });
  assert.equal(summary.statusLabel, "事务局回答参考");
  assert.match(summary.provisionalText, /可以发动/);
  assert.notEqual(summary.statusLabel, "已确认");
});

test("conditionalAnswer shows all branches and clarification question", () => {
  const conditionalAnswer = {
    branches: [
      { label: "如果仍在怪兽区域", explanation: "在怪兽区域发动。", evidenceIds: ["faq-1"] },
      { label: "如果已经送去墓地", explanation: "在墓地发动。", evidenceIds: ["faq-1"] },
      { label: "如果已经被除外", explanation: "在除外状态发动。", evidenceIds: ["faq-1"] },
    ],
    clarificationQuestion: "请补充：这个时点该怪兽是仍在怪兽区域、已经送去墓地，还是已经被除外？",
  };
  const summary = buildUserFacingSubAnswerSummary({
    status: "unknown",
    verdict: "unknown",
    conditionalAnswer,
  });
  assert.equal(summary.statusLabel, "条件不足");
  assert.equal(buildConditionalBranchLines(conditionalAnswer).length, 3);
  assert.match(summary.clarificationQuestion, /怪兽区域/);
  assert.match(summary.clarificationQuestion, /墓地/);
  assert.match(summary.clarificationQuestion, /除外/);
});

test("unknown answer displays a non-empty reason", () => {
  const summary = buildUserFacingSubAnswerSummary({
    status: "unknown",
    verdict: "unknown",
    reason: "no_direct_evidence",
  });
  assert.equal(summary.statusLabel, "资料不足");
  assert.match(summary.reason, /没有直接回答当前问题/);
  assert.doesNotMatch(summary.reason, /no_direct_evidence/u);
});

test("bare unknown answer shows a fallback clarification prompt", () => {
  const summary = buildUserFacingSubAnswerSummary({
    status: "unknown",
    verdict: "unknown",
  });
  assert.match(summary.clarificationQuestion, /需要确认/);
  assert.match(summary.clarificationQuestion, /官方 Q&A/);
});

test("likelyAnswer displays as unconfirmed possible handling", () => {
  const summary = buildUserFacingSubAnswerSummary({
    status: "unknown",
    verdict: "unknown",
    sourceText: "能否处理这个场景？",
    likelyAnswer: {
      status: "best_effort",
      verdict: "unknown",
      reasoning: "根据卡片文本只能给出未确认参考。",
      disclaimer: "未确认裁定，不能替代官方 Q&A",
    },
  });
  assert.equal(summary.statusLabel, "可能处理（未确认）");
  assert.match(summary.likelyAnswerText, /未确认裁定/);
  assert.match(summary.likelyAnswerText, /问题核心/);
  assert.match(summary.likelyAnswerText, /为什么不能确认/);
});

test("unresolved card clarification is visible as a normal prompt", () => {
  const summary = buildUserFacingSubAnswerSummary({
    status: "unknown",
    verdict: "unknown",
    cardResolutionIssue: {
      unresolvedCardName: "卡通青眼究极龙",
      candidateCards: [{ name: "青眼究极龙" }],
    },
    clarification: {
      question: "请确认你指的是哪张卡：卡通青眼究极龙？",
      options: ["青眼究极龙"],
    },
  });
  assert.match(summary.reason, /卡名没有 exact match/);
  assert.match(summary.clarificationQuestion, /卡通青眼究极龙/);
});

test("confirmed answer exposes evidence ids in ordinary summary", () => {
  const summary = buildUserFacingSubAnswerSummary({
    status: "confirmed",
    verdict: "can",
    evidenceIds: ["qa-1"],
    officialAnswer: { status: "confirmed", verdict: "can", evidenceIds: ["qa-1"] },
  });
  assert.equal(summary.statusLabel, "官方直接裁定");
  assert.deepEqual(summary.evidenceIds, ["qa-1"]);
});

test("pipeline_debug_hidden_by_default", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<title>游戏王 OCG AI裁定<\/title>/u);
  assert.match(html, /property="og:title" content="游戏王 OCG AI裁定"/u);
  assert.doesNotMatch(html, /规则助手|Ruling Assistant/u);
  assert.match(html, /<details[^>]+parser-debug/u);
  assert.match(html, /id="parserDebugPanel" hidden/u);
  assert.match(html, /id="pipelineDebugToggle" hidden/u);
  assert.equal(statusLabelForSubAnswer({ status: "unknown" }), "资料不足");
});

test("ui_has_single_query_button", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /查询/u);
  assert.doesNotMatch(html, /快速结论/u);
  assert.doesNotMatch(html, /深度解析/u);
  assert.doesNotMatch(html, /RAG 分析模式/u);
  assert.doesNotMatch(html, /使用旧管线结果/u);
  assert.match(app, /mode: backendMode/u);
  assert.match(app, /const backendMode = "rag"/u);
  assert.match(app, /isDebugUiEnabled/u);
  assert.match(app, /user_provided_text/u);
  assert.match(app, /用户提供文本/u);
  assert.match(app, /pendingStages/u);
  assert.match(app, /检索规则资料/u);
  assert.match(app, /pendingStageTickTimer/u);
  assert.match(app, /formatPendingStageDuration/u);
  assert.match(app, /progress-step-time/u);
  assert.match(app, /readMonotonicNow/u);
  assert.match(app, /extractBackendPipelineTimings/u);
  assert.match(app, /low_confidence_analysis:\s*\{[^}]+className:\s*"is-caution"/u);
  assert.match(app, /needs_more_info:\s*\{[^}]+className:\s*"is-caution"/u);
  assert.match(app, /budget_limited:\s*\{[^}]+className:\s*"is-risky"/u);
  assert.match(app, /publicSystemFailurePresentation/u);
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.verdict-block\.is-caution\s*\{[^}]*var\(--warn\)/su);
  assert.match(app, /startPendingStages/u);
  assert.match(html, /id="pipelineTimingPanel" hidden/u);
  assert.match(html, /id="pipelineStageList"/u);
  assert.match(html, /id="pipelineElapsedText"/u);
  assert.match(html, /id="rulingModelSelect"[^>]+disabled/u);
  assert.match(html, /value="relay-gpt-5\.6-sol-low" selected>GPT-5\.6 Sol · 思考 low</u);
  assert.doesNotMatch(html, /第三方中转/u);
  assert.doesNotMatch(html, /value="glm-5\.2-high"/u);
  assert.doesNotMatch(html, /value="kimi-[^"]+"/u);
  assert.doesNotMatch(html, /value="relay-gpt-5\.6-sol-high"/u);
  assert.match(html, /id="rulingModelStatus" hidden><\/small>/u);
  assert.doesNotMatch(html, /当前默认。旧匿名 10 题小样本/u);
  assert.match(html, /id="rulingModelLatency"[^>]+aria-live="polite"/u);
  assert.match(app, /最近 \$\{latency\.sampleCount\} 次成功回答/u);
  assert.doesNotMatch(html, /id="flashModelButton"|id="proModelButton"|>Pro</u);
  assert.match(app, /let selectedRulingModelProfile = DEFAULT_RULING_MODEL_PROFILE/u);
  assert.match(app, /rulingModelProfile: selectedRulingModelProfile/u);
  assert.doesNotMatch(app, /modelTier: selectedModelTier/u);
  assert.doesNotMatch(app, /thinkingMode:\s*selected|reasoningEffort:\s*selected/u);
  assert.match(html, /data-ruling-version="latest"[^>]+aria-pressed="true"[^>]*>最新版</u);
  assert.doesNotMatch(html, /data-ruling-version="previous"|上一版（兼容）/u);
  assert.match(app, /let selectedRulingVersion = "latest"/u);
  assert.match(app, /rulingVersion: requestedRulingVersion/u);
  assert.match(app, /selectRulingVersion\(button\.dataset\.rulingVersion\)/u);
  assert.match(html, /id="answerVersionText" hidden/u);
  assert.match(app, /effectiveRulingVersion \|\| answer\?\.rulingVersion/u);
  assert.match(app, /本次回答：最新版/u);
  assert.doesNotMatch(app, /上一版（兼容）|data-ruling-version="previous"/u);
  assert.match(app, /ruling_version_unconfirmed/u);
  assert.match(app, /ruling_version_mismatch/u);
  assert.match(app, /ruling_version_response_invalid/u);
  assert.match(app, /renderBackendVersionError\(error, requestedRulingVersion\)/u);
  assert.match(app, /后端没有确认本次实际使用的回答版本/u);
  assert.match(app, /不会降级到本地模板/u);
  assert.match(app, /normalizeRulingVersionCapabilities\(info\?\.rulingVersions\)/u);
  assert.match(app, /typeof item === "string" \? item : item\?\.id/u);
  assert.match(app, /setAttribute\("aria-disabled", String\(disabled\)\)/u);
  assert.match(app, /if \(!isRulingVersionSupported\(nextVersion\)\) return/u);
  assert.doesNotMatch(app, /Backend answer failed, using static fallback/u);
  assert.match(app, /const disabled = Boolean\(isPending\) \|\| !supported/u);
  assert.match(app, /button\.disabled = disabled/u);
  const versionSelectorStart = app.indexOf("function selectRulingVersion");
  const scheduleAnalysisStart = app.indexOf("function scheduleAnalysis", versionSelectorStart);
  assert.notEqual(versionSelectorStart, -1);
  assert.notEqual(scheduleAnalysisStart, -1);
  const versionSelectorBody = app.slice(versionSelectorStart, scheduleAnalysisStart);
  assert.doesNotMatch(versionSelectorBody, /analyzeQuestion\(/u);
  assert.match(app, /cache: "no-store"/u);
  assert.doesNotMatch(app, /backendAnswerCacheTtlMs|buildBackendCacheKey|readCachedBackendAnswer|writeCachedBackendAnswer|ocg-ruling-answer:v/u);
  assert.doesNotMatch(app, /setModelTier|readInitialModelTier/u);
  assert.doesNotMatch(app, /deepAnalyzeButton|ragModeToggle|legacyPipelineToggle/u);
  assert.doesNotMatch(html, /裁判结论/u);
  assert.doesNotMatch(app, /裁判结论/u);
  assert.doesNotMatch(app, /FAST JUDGE/u);
  assert.doesNotMatch(app, /damage\.reasonCode|timing\.reasonCode/u);
  assert.doesNotMatch(app, /blocker\.id/u);
});

test("public ruling model selector uses the allowlisted backend profiles without silent fallback", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const definitions = sourceBetween(
    app,
    "const DEFAULT_RULING_MODEL_PROFILE",
    "const ui =",
  );
  const functions = sourceBetween(
    app,
    "function normalizeRulingModelCapabilities",
    "function normalizeRulingVersionCapabilities",
  );
  const normalizeCapabilities = new Function(
    `${definitions}\n${functions}\nreturn normalizeRulingModelCapabilities;`,
  )();
  assert.match(definitions, /const DEFAULT_RULING_MODEL_PROFILE = "relay-gpt-5\.6-sol-low"/u);
  const capabilities = normalizeCapabilities({
    defaultRulingModelProfile: "relay-gpt-5.6-sol-low",
    rulingModelProfiles: [
      { id: "relay-gpt-5.6-luna-low", available: true, label: "OpenAI official" },
      { id: "relay-gpt-5.6-sol-low", available: true, label: "OpenAI official" },
      { id: "deepseek-v4-flash-standard", available: true },
      { id: "deepseek-v4-flash-low", available: true },
      { id: "deepseek-v4-flash-high", available: true, label: "untrusted label" },
      { id: "deepseek-v4-flash-max", available: true },
      { id: "glm-5.2-high", available: true },
      { id: "relay-gpt-5.6-sol-high", available: true, label: "OpenAI official" },
      { id: "not-allowlisted", available: true },
    ],
  });

  assert.equal(capabilities.defaultProfile, "relay-gpt-5.6-sol-low");
  assert.deepEqual(capabilities.profiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    provider: profile.provider,
    available: profile.available,
  })), [
    { id: "relay-gpt-5.6-luna-low", label: "GPT-5.6 Luna · 思考 low", provider: "relay", available: true },
    { id: "relay-gpt-5.6-sol-low", label: "GPT-5.6 Sol · 思考 low", provider: "relay", available: true },
    { id: "deepseek-v4-flash-standard", label: "DeepSeek V4 Flash · standard（实验性）", provider: "deepseek", available: true },
    { id: "deepseek-v4-flash-low", label: "DeepSeek V4 Flash · 思考 low（实验性）", provider: "deepseek", available: true },
    { id: "deepseek-v4-flash-high", label: "DeepSeek V4 Flash · 思考 high（实验性）", provider: "deepseek", available: true },
    { id: "deepseek-v4-flash-max", label: "DeepSeek V4 Flash · 思考 max（实验性）", provider: "deepseek", available: true },
  ]);
  assert.equal(capabilities.profiles[0].benchmarkSummary, "旧匿名 10 题小样本：10/10，平均 34.6 秒；之后出现样本外错误，不再作为推荐依据。");
  assert.equal(capabilities.profiles[1].benchmarkSummary, undefined);
  assert.equal(capabilities.profiles[2].benchmarkSummary, "匿名 10 题评测：5/10，另有 4 题部分正确；平均 12.4 秒，仅供实验。");
  for (const profile of capabilities.profiles) {
    assert.equal(profile.answerLatency.profileId, profile.id);
    assert.equal(profile.answerLatency.status, "unavailable");
  }
  const partialAvailability = normalizeCapabilities({
    defaultRulingModelProfile: "relay-gpt-5.6-sol-low",
    rulingModelProfiles: [
      { id: "glm-5.2-high", available: false },
      { id: "deepseek-v4-flash-high", available: true },
      { id: "relay-gpt-5.6-luna-low", available: false },
      { id: "relay-gpt-5.6-sol-low", available: false },
    ],
  });
  assert.deepEqual(
    partialAvailability.profiles.map((profile) => [profile.id, profile.available]),
    [
      ["relay-gpt-5.6-luna-low", false],
      ["relay-gpt-5.6-sol-low", false],
      ["deepseek-v4-flash-standard", false],
      ["deepseek-v4-flash-low", false],
      ["deepseek-v4-flash-high", true],
      ["deepseek-v4-flash-max", false],
    ],
  );
  assert.throws(
    () => normalizeCapabilities({
      defaultRulingModelProfile: "not-allowlisted",
      rulingModelProfiles: ["glm-5.2-high", "deepseek-v4-flash-high"],
    }),
    /invalid default ruling model profile/u,
  );
  assert.match(app, /setRulingModelCapabilitiesUnavailable\("模型能力接口不可用/u);
  assert.doesNotMatch(app, /默认 GPT-5\.6 Luna low|平均 34\.6 秒；推荐/u);
  assert.match(app, /默认 GPT-5\.6 Sol low/u);
  assert.match(app, /系统不会自动改用其他模型/u);
  assert.match(app, /selectedRulingModelProfile = DEFAULT_RULING_MODEL_PROFILE/u);
  assert.match(app, /if \(value === "relay"\) return "ChatGPT"/u);
});

test("public ruling model selector renders measured latency and explicit fallback states", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function renderSelectedRulingModelLatency",
    "function syncRulingModelSelect",
  );
  const latencyNode = { textContent: "" };
  const render = new Function(
    "ui",
    `${source}; return renderSelectedRulingModelLatency;`,
  )({ rulingModelLatency: latencyNode });

  render({
    answerLatency: {
      status: "available",
      averageMs: 83_000,
      sampleCount: 7,
      windowSize: 20,
    },
  });
  assert.equal(latencyNode.textContent, "最近 7 次成功回答：平均 1 分 23 秒（最多统计 20 次）。");

  render({ answerLatency: { status: "no_samples" } });
  assert.equal(latencyNode.textContent, "暂无该模型的成功回答耗时样本。");

  render({ answerLatency: { status: "unavailable", reason: "storage_error" } });
  assert.equal(latencyNode.textContent, "平均出答案时间暂时读取失败。");

  render({ answerLatency: { status: "unavailable", storage: "unconfigured" } });
  assert.match(latencyNode.textContent, /未配置统计存储/u);
  assert.doesNotMatch(latencyNode.textContent, /\d+ 秒|\d+ 分/u);
});

test("public pipeline timing prefers backend stage measurements and wall-clock total", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function extractBackendPipelineTimings");
  const end = app.indexOf("function readMonotonicNow", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const extractTimings = new Function(
    `${app.slice(start, end)}; return extractBackendPipelineTimings;`,
  )();
  const stages = [
    { id: "understand" },
    { id: "extract_card_names" },
    { id: "retrieve_card_texts" },
    { id: "retrieve_rulings" },
    { id: "simulate" },
    { id: "generate_ruling" },
  ];
  const result = extractTimings({
    debug: {
      timingsMs: {
        dataLoad: 10,
        deterministicPreflight: 5,
        auxiliaryExtractionModels: 100,
        officialQaApplicability: 30_000,
        localReasoning: 4,
        rulebookGrounding: 6,
        formalEngineAwait: 2,
        finalModel: 1_000,
        engineAwait: 3,
        total: 1_200,
      },
      retrievalStageTimingsMs: {
        data: 1,
        cardResolution: 20,
        rulebook: 30,
        officialQa: 40,
        relatedEvidence: 50,
      },
    },
  }, stages);
  assert.deepEqual(result, {
    stageDurationsMs: {
      understand: 15,
      extract_card_names: 100,
      retrieve_card_texts: 20,
      retrieve_rulings: 121,
      simulate: 5,
      generate_ruling: 31_010,
    },
    totalMs: 1_200,
    usesServerTiming: true,
  });
  assert.deepEqual(extractTimings({}, stages), {
    stageDurationsMs: {},
    totalMs: null,
    usesServerTiming: false,
  });
});

test("missing answer API fails closed instead of answering from local ruling notes", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const analyzeSource = sourceBetween(
    app,
    "async function analyzeQuestion",
    "async function requestBackendAnswer",
  );
  const unavailableRenderer = sourceBetween(
    app,
    "function renderBackendUnavailable",
    "function renderCards",
  );

  assert.match(analyzeSource, /renderBackendUnavailable\(getDetectedCards\(text\)\);/u);
  assert.match(unavailableRenderer, /裁定服务不可用/u);
  assert.match(unavailableRenderer, /无法生成或验证这道题的裁定/u);
  assert.match(unavailableRenderer, /本地卡片资料仅供查看，不会被当作裁定答案/u);
  assert.doesNotMatch(app, /normalizeRulingRecords|scoreNote|findMatches|filterRelevantMatches|confidenceFor/u);
  assert.doesNotMatch(app, /readJson\("data\/rulings\.json"\)|note\.conclusion/u);
  assert.doesNotMatch(app, /status:\s*record\.status\s*\|\|\s*"confirmed"/u);
});

test("versioned backend answers require a matching server confirmation", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const requestStart = app.indexOf("async function requestBackendAnswer");
  const renderPendingStart = app.indexOf("function renderPending", requestStart);
  assert.notEqual(requestStart, -1);
  assert.notEqual(renderPendingStart, -1);
  const versionClientSource = app.slice(requestStart, renderPendingStart);
  const buildRequest = (fetchImpl) => new Function(
    "fetch",
    `const appConfig = { answerApiUrl: "https://example.test/api/answer" };
     const selectedRulingModelProfile = "deepseek-v4-flash-high";
     ${versionClientSource}
     return requestBackendAnswer;`,
  )(fetchImpl);

  let requestBody = null;
  const confirmedRequest = buildRequest(async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ rulingVersion: "latest", shortAnswer: "已确认" }),
    };
  });
  const confirmed = await confirmedRequest("问题", "latest");
  assert.deepEqual(requestBody, {
    question: "问题",
    mode: "rag",
    rulingModelProfile: "deepseek-v4-flash-high",
    rulingVersion: "latest",
  });
  assert.equal(confirmed.effectiveRulingVersion, "latest");

  const missingConfirmationRequest = buildRequest(async () => ({
    ok: true,
    json: async () => ({ shortAnswer: "旧后端未回显版本" }),
  }));
  const compatibleLatest = await missingConfirmationRequest("问题", "latest");
  assert.equal(compatibleLatest.effectiveRulingVersion, "latest");
  assert.equal(compatibleLatest.rulingVersionCompatibility, "legacy_unversioned_latest");
  assert.equal(compatibleLatest.shortAnswer, "旧后端未回显版本");

  const removedVersionResponse = buildRequest(async () => ({
    ok: true,
    json: async () => ({ rulingVersion: "previous", shortAnswer: "已删除版本" }),
  }));
  await assert.rejects(
    removedVersionResponse("问题", "latest"),
    (error) => error?.code === "ruling_version_response_invalid",
  );
});

test("feedback_opens_a_prefilled_github_issue", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /https:\/\/github\.com\/coldiceh\/ocg-ruling-assistant\/issues\/new/u);
  assert.match(app, /在 GitHub 反馈这个回答/u);
  assert.match(app, /url\.searchParams\.set\("body", body\)/u);
  assert.match(app, /function feedbackModelLabel/u);
  assert.match(app, /通用规则执行器（未调用最终大模型）/u);
  assert.doesNotMatch(app, /"## 使用模型",\s*"DeepSeek V4 Flash"/u);
  assert.doesNotMatch(app, /feedbackApiUrl|submitFeedbackCase|saveFeedbackCaseLocally/u);
});

test("backend answers bypass persistent browser cache and bust static assets", async () => {
  const [app, html, configText] = await Promise.all([
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../config.json", import.meta.url), "utf8"),
  ]);
  const config = JSON.parse(configText.replace(/^\uFEFF/u, ""));
  assert.match(html, /src\/app\.js\?v=20260814-risk-control-1/u);
  assert.match(html, /src\/styles\.css\?v=20260814-risk-control-1/u);
  assert.match(config.answerApiUrl, /\?client=20260722-answer-version-1$/u);
  assert.match(app, /cache: "no-store"/u);
  assert.doesNotMatch(app, /backendAnswerCacheTtlMs|buildBackendCacheKey|readCachedBackendAnswer|writeCachedBackendAnswer|ocg-ruling-answer:v/u);
});

test("readme_keeps_only_requested_future_plans", async () => {
  const [readme, english, japanese] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../README.en.md", import.meta.url), "utf8"),
    readFile(new URL("../README.ja.md", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(readme, /## 技术架构|## 本地运行|## 贡献|## 未来计划/u);
  assert.match(readme, /```mermaid[\s\S]*裁定模型分析/u);
  assert.match(readme, /MODEL_EFFORT_MATRIX:START/u);
  assert.doesNotMatch(readme, /Lua|Fluorohydride\/ygopro-core/u);
  assert.match(readme, /space\.bilibili\.com\/869711/u);
  assert.match(readme, /\[English\]\(README\.en\.md\)/u);
  assert.match(readme, /\[日本語\]\(README\.ja\.md\)/u);
  assert.match(readme, /^# 游戏王 OCG AI裁定 \/ Yu-Gi-Oh! OCG AI Rulings/mu);
  assert.match(english, /^# Yu-Gi-Oh! OCG AI Rulings/mu);
  assert.match(japanese, /^# 遊戯王OCG AI裁定/mu);
  assert.doesNotMatch(`${readme}\n${english}\n${japanese}`, /规则助手|Ruling Assistant|裁定アシスタント/u);
  assert.match(english, /## How it works/u);
  assert.match(japanese, /## 仕組み/u);
  assert.match(readme, /旧的 10 题小样本.*Luna low/u);
  assert.match(readme, /样本外规则问题中出现错误/u);
  assert.match(readme, /当前公开版本优先使用 \*\*Sol low\*\*/u);
  assert.match(readme, /仍可能答错新的复杂规则问题/u);
  assert.match(readme, /Luna \| low \| 10\/10[\s\S]*120,457 \/ 18,133 \/ 2,014 \/ 138,590[\s\S]*USD 0\.045851/u);
  assert.match(readme, /Terra \| low \| 10\/10[\s\S]*120,457 \/ 21,090 \/ 3,307 \/ 141,547[\s\S]*USD 0\.493994/u);
  assert.match(readme, /全部输入 Token 当作未缓存输入/u);
  assert.doesNotMatch(readme, /因此当前公开版本使用它/u);
  assert.match(english, /old, small 10-case sample/u);
  assert.match(english, /failed an out-of-sample ruling question/u);
  assert.match(english, /current public default prioritizes \*\*Sol low\*\*/u);
  assert.match(english, /every input token as uncached/u);
  assert.match(japanese, /以前の小規模な 10 問サンプル/u);
  assert.match(japanese, /サンプル外のルール問題で誤答/u);
  assert.match(japanese, /現在のデフォルトは \*\*Sol low\*\*/u);
  assert.match(japanese, /すべての入力 Token をキャッシュなし/u);
  assert.doesNotMatch(english, /Lua|Fluorohydride\/ygopro-core/u);
  assert.doesNotMatch(japanese, /Lua|Fluorohydride\/ygopro-core/u);
  for (const localizedReadme of [readme, english, japanese]) {
    const publicMatrix = localizedReadme.match(
      /<!-- MODEL_EFFORT_MATRIX:START -->([\s\S]*?)<!-- MODEL_EFFORT_MATRIX:END -->/u,
    )?.[1] || "";
    assert.ok(publicMatrix);
    assert.doesNotMatch(
      publicMatrix,
      /Validator|Case ID|Full question|完整问题|質問全文|prompt SHA|Q1(?:\D|$)/u,
    );
    assert.match(publicMatrix, /Luna[\s\S]*Terra[\s\S]*Sol[\s\S]*DeepSeek/u);
  }
});

test("ui_hides_engine_details_by_default", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /裁定流程/u);
  assert.match(html, /今日 API 额度（分币种）/u);
  assert.match(html, /id="budgetBucketList"/u);
  assert.doesNotMatch(html, /budgetSpentText|budgetLimitText/u);
  assert.doesNotMatch(app, /budgetSpentText|budgetLimitText/u);
  assert.match(html, /id="budgetResetButton"[^>]+hidden/u);
  assert.match(html, /id="budgetCapButton"[^>]+hidden/u);
  const publicBudget = sourceBetween(html, '<section class="budget-panel"', '<section class="admin-lab"');
  const adminPanel = sourceBetween(html, '<section class="admin-lab"', '<section class="disclaimer-panel"');
  assert.doesNotMatch(publicBudget, /budgetResetButton|budgetCapButton|重置额度|封顶至/u);
  assert.match(adminPanel, /id="budgetResetButton"[^>]+hidden>重置公开问答额度/u);
  assert.match(adminPanel, /id="budgetCapButton"[^>]+hidden>立即将公开 ChatGPT 今日额度封顶至 10 美元/u);
  assert.match(html, /免责声明/u);
  assert.match(html, /不是 KONAMI 官方项目/u);
  assert.match(html, /id="themeToggle"/u);
  assert.match(html, /class="page-background"/u);
  assert.doesNotMatch(html, /ANALYSIS CORE|TOKEN|provider debug/u);
  assert.match(html, /GPT-5\.6 Sol/u);
  assert.doesNotMatch(html, /AI裁定分析|RAG 裁定分析|RAG 分析/u);
  assert.doesNotMatch(html, /后端模式|公开资料检索|卡片文本分析/u);
  assert.doesNotMatch(html, /terminal-theme|OCG RULING TERMINAL/u);
  assert.match(app, /debugUiEnabled/u);
  assert.match(app, /params\.get\("debug"\) === "1"/u);
  assert.match(app, /prompt\("请输入重置额度密码"\)/u);
  assert.match(app, /JSON\.stringify\(\{ password \}\)/u);
  assert.match(app, /JSON\.stringify\(\{ action: "cap_public_chatgpt", password \}\)/u);
  assert.match(app, /不会影响管理员实验额度/u);
  assert.match(app, /storageWarning/u);
  assert.match(app, /bucket\?\.id !== "final_ruling:glm"/u);
  assert.match(app, /label: "ChatGPT 最终裁定"/u);
  assert.match(app, /spentTodayUsd/u);
  assert.match(app, /dailyBudgetUsd/u);
  assert.match(app, /\$\$\{formatUsd\(spent\)\}/u);
  assert.match(app, /!adminUiEnabled \|\| !resetEnabled/u);
  assert.match(app, /rulebook/u);
  assert.match(app, /publicRiskLines/u);
  assert.doesNotMatch(app, /publicLegacyLuaLines|内核 Lua 语义辅助|不等于完整场景模拟/u);
  assert.doesNotMatch(html, /中国玩家/u);
  assert.match(app, /"trusted_local_semantic_execution"/u);
  assert.match(app, /"semantic_state_transition_applied"/u);
  assert.match(app, /"final_model_skipped"/u);
});

test("card_dossier_nodes_and_theme_backgrounds_exist", async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="cardPanel"/u);
  assert.match(html, /id="cardImagePlaceholder"/u);
  assert.match(html, /相关卡片/u);
  assert.match(css, /\.page-background/u);
  assert.match(css, /assets\/bg-day\.png/u);
  assert.match(css, /assets\/bg-night\.png/u);
  assert.match(css, /theme-night/u);
  assert.match(css, /\.progress-step/u);
  assert.match(css, /\.model-tier-label/u);
  assert.doesNotMatch(css, /\.model-tier-toggle/u);
  assert.match(css, /\.budget-panel/u);
  assert.match(css, /\.budget-bucket/u);
  assert.match(app, /status\?\.buckets \|\| \(status\?\.bucket/u);
  assert.doesNotMatch(css, /body::before|body::after/u);
  assert.match(app, /baige_card_text/u);
  assert.match(app, /百鸽卡片文本/u);
});

test("pages_deploy_includes_background_assets", async () => {
  const workflow = await readFile(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8");
  assert.match(workflow, /cp -R assets _site\/assets/u);
  assert.match(workflow, /test -s _site\/assets\/bg-day\.png/u);
  assert.match(workflow, /test -s _site\/assets\/bg-night\.png/u);
});
test("query_button_has_visible_pending_state", async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="analyzeButtonText">查询</u);
  assert.match(app, /setQueryPending\(true\)/u);
  assert.match(app, /analyzeButton\.disabled = Boolean\(isPending\) \|\| !selectedRulingModelIsAvailable\(\)/u);
  assert.match(app, /setAttribute\("aria-busy"/u);
  assert.match(app, /syncRulingModelSelect\(Boolean\(isPending\)\)/u);
  assert.match(app, /rulingModelSelect\.disabled = disabled/u);
  assert.match(app, /查询中…/u);
  assert.match(css, /\.primary-button:disabled/u);
  assert.match(css, /cursor: wait/u);
});

test("admin_model_lab_is_hidden_and_requires_a_real_session", async () => {
  const [html, app, css, adminAuthApi, adminSession] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../api/admin-auth.js", import.meta.url), "utf8"),
    readFile(new URL("../backend/adminSession.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="adminLabPanel"[^>]+hidden/u);
  assert.match(html, /admin=1<\/code> 只负责显示本区域，并不代表已经登录/u);
  assert.match(html, /id="adminPasswordInput" type="password"/u);
  assert.match(html, /data-admin-stage="understand"/u);
  assert.match(html, /data-admin-stage="generate_ruling"/u);
  assert.match(html, /FAST \/ NORMAL \/ SLOW 只是耗时标签，不会触发自动取消/u);
  assert.match(app, /params\.get\("admin"\) === "1"/u);
  assert.match(app, /\/api\/admin-auth/u);
  assert.match(app, /\/api\/admin-model-lab/u);
  assert.match(app, /credentials: "include"/u);
  assert.match(app, /headers\["x-csrf-token"\] = adminSession\.csrfToken/u);
  assert.match(app, /afterSequence/u);
  assert.match(app, /"last-event-id": String\(adminAfterSequence\)/u);
  assert.match(app, /adminDurationCategory/u);
  assert.match(app, /run\?\.stageTiming\?\.stages/u);
  assert.match(app, /adminFeatureEnabled\("history"\)/u);
  assert.match(html, /id="adminHistoryTitle">实验历史/u);
  assert.match(html, /id="adminBudgetPools"/u);
  assert.match(html, /保留预约[^<]*不代表供应商已经收费/u);
  assert.match(app, /实际结算/u);
  assert.match(app, /保留预约/u);
  assert.match(app, /历史未分类占用/u);
  assert.match(css, /\.admin-budget-pools/u);
  assert.match(html, /id="adminQuestionHistoryTitle">后台历史提问/u);
  assert.match(css, /\.admin-history-list li\s*\{[^}]*min-width:\s*0/u);
  assert.match(css, /\.admin-history-list button\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/u);
  assert.match(html, /id="adminComparisonTitle">同一冻结证据模型对比/u);
  assert.match(html, /不会重新检索资料/u);
  assert.match(html, /最多 100 条；不等同于上方的模型实验历史/u);
  assert.match(app, /getAdminEndpointUrl\("\/api\/admin-queries"\)/u);
  assert.match(app, /url\.searchParams\.set\("limit", "100"\)/u);
  assert.match(app, /sessionStorage\.setItem\(adminCurrentRunStorageKey, id\)/u);
  assert.match(app, /sessionStorage\.getItem\(adminCurrentRunStorageKey\)/u);
  assert.match(app, /await restoreStoredAdminRun\(\)/u);
  assert.match(app, /triggerAdminRunExecution\(adminCurrentRunId\)/u);
  assert.match(app, /adminExecuteAttemptedRunIds\.has\(id\)/u);
  assert.match(app, /!shouldTriggerAdminRunExecution\(adminCurrentRun\)/u);
  assert.match(app, /latency\.totalWallClockMs/u);
  assert.match(app, /latency\.totalWallClockMs[\s\S]{0,120}\?\? metrics\.wallClockMs/u);
  assert.match(app, /\["推理 Token", usage\.reasoningTokens/u);
  assert.match(app, /cnyCostIncomplete \? "人民币估算（仅已知部分）" : "人民币估算"/u);
  assert.match(app, /adminObjectToCsv/u);
  assert.match(app, /query: \{ runId: adminCurrentRunId, format \}/u);
  assert.match(app, /action: "fork"/u);
  assert.match(app, /forkFromRunId: sourceRunId/u);
  assert.match(app, /action: "execute"/u);
  assert.doesNotMatch(sourceBetween(
    app,
    "async function runAdminModelComparison",
    "function createAdminComparisonIdempotencyKey",
  ), /action: "create"|question:/u);
  assert.match(app, /typeof data\?\.content === "string"/u);
  assert.match(app, /finalAttemptPolicy: "single"/u);
  assert.match(app, /data\?\.fileName/u);
  assert.match(app, /data\?\.contentType/u);
  assert.match(html, /option value="partially_correct">部分正确/u);
  assert.match(app, /rating: String\(ui\.adminRatingSelect\?\.value \|\| ""\)/u);
  assert.doesNotMatch(app, /prompt\("请输入管理员密码"\)/u);
  assert.doesNotMatch(app, /body:\s*\{[^}]*password[^}]*\}[\s\S]{0,240}\/api\/admin-queries/u);
  assert.doesNotMatch(html, /OPENAI_API_KEY|DEEPSEEK_API_KEY/u);
  assert.match(adminAuthApi, /createAdminSessionManager/u);
  assert.match(adminAuthApi, /defaultHandler \|\|=/u);
  assert.match(adminSession, /timingSafeEqual/u);
  assert.match(adminSession, /HttpOnly/u);
  assert.match(adminSession, /SameSite=None/u);
});

test("admin frozen-evidence comparison offers supported configured model combinations", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function buildAdminComparisonOptions",
    "function renderAdminComparisonOptions",
  );
  const build = new Function(`${source}; return buildAdminComparisonOptions;`)();
  const models = [
    {
      id: "deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      provider: "deepseek",
      modes: [{ id: "standard" }, { id: "pro" }],
      efforts: [{ id: "none" }, { id: "low" }, { id: "high" }, { id: "max" }],
      defaultReasoningMode: "standard",
      defaultReasoningEffort: "none",
      preferredComparisonReasoningEffort: "low",
    },
    {
      id: "deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
      provider: "deepseek",
      modes: [{ id: "pro" }],
      efforts: [{ id: "low" }, { id: "high" }, { id: "max" }],
      preferredComparisonReasoningEffort: "high",
    },
    {
      id: "glm-5.2",
      label: "GLM-5.2",
      provider: "glm",
      modes: [{ id: "standard" }, { id: "pro" }],
      efforts: [{ id: "none" }, { id: "high" }, { id: "max" }],
      defaultReasoningMode: "pro",
      defaultReasoningEffort: "max",
    },
    {
      id: "kimi-k2.6",
      label: "Kimi K2.6",
      provider: "kimi",
      modes: [{ id: "standard" }, { id: "pro" }],
      efforts: [{ id: "none" }],
    },
    {
      id: "kimi-k3",
      label: "Kimi K3",
      provider: "kimi",
      modes: [{ id: "pro" }],
      efforts: [{ id: "low" }, { id: "high" }, { id: "max" }],
      defaultReasoningMode: "pro",
      defaultReasoningEffort: "max",
    },
    {
      id: "relay-gpt-5.6-sol",
      label: "第三方中转 · GPT-5.6 Sol",
      provider: "relay",
      modes: [{ id: "pro" }],
      efforts: [{ id: "high" }],
      defaultReasoningMode: "pro",
      defaultReasoningEffort: "high",
    },
  ];
  const options = build(models);

  assert.deepEqual(options.map((item) => item.id), [
    "deepseek-v4-flash:standard:none",
    "deepseek-v4-flash:pro:low",
    "deepseek-v4-pro:pro:high",
    "glm-5.2:standard:none",
    "glm-5.2:pro:max",
    "kimi-k2.6:standard:none",
    "kimi-k2.6:pro:none",
    "kimi-k3:pro:max",
    "relay-gpt-5.6-sol:pro:high",
  ]);
  assert.equal(options.some((item) => (
    item.model === "deepseek-v4-pro"
    && item.reasoningMode === "pro"
    && item.reasoningEffort === "high"
  )), true);
});

test("admin frozen-evidence comparison summarizes answer latency tokens and available cost", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function summarizeAdminComparisonRun",
    "function shouldTriggerAdminRunExecution",
  );
  const summarize = new Function(
    "formatAdminCnyCost",
    "formatAdminCost",
    "adminRunStatusLabel",
    "formatAdminDuration",
    `${source}; return summarizeAdminComparisonRun;`,
  )(
    (value) => Number.isFinite(Number(value)) ? `¥${Number(value).toFixed(4)}` : "",
    (value) => Number.isFinite(Number(value)) ? `$${Number(value).toFixed(6)}` : "",
    () => "已完成",
    (value) => Number.isFinite(Number(value)) ? `${Number(value)}ms` : "",
  );
  const summary = summarize({
    status: "SUCCEEDED",
    result: {
      finalRuling: { conciseAnswer: "可以发动，但处理时不进行特殊召唤。" },
      latency: { totalWallClockMs: 4200, finalRulingMs: 3100 },
      provider: {
        streamMetrics: {
          requestToFirstContentMs: 1800,
          requestToCompleteMs: 3000,
        },
      },
      metering: {
        totals: {
          usage: { totalTokens: 1234 },
          cost: { totalCostCny: 0.08, totalCostUsd: 0.011 },
        },
      },
    },
  });

  assert.equal(summary.answer, "可以发动，但处理时不进行特殊召唤。");
  assert.deepEqual(summary.metrics, [
    "状态 已完成",
    "总耗时 4200ms",
    "final 3100ms",
    "Token 1,234",
    "成本 ¥0.0800 / $0.011000",
    "SSE 首正文 1800ms",
    "SSE 完成 3000ms",
  ]);
});

test("admin frozen-evidence comparison labels relay identity and ambiguous billing without fabricating usage", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function summarizeAdminComparisonRun",
    "function shouldTriggerAdminRunExecution",
  );
  const summarize = new Function(
    "formatAdminCnyCost",
    "formatAdminCost",
    "adminRunStatusLabel",
    "formatAdminDuration",
    `${source}; return summarizeAdminComparisonRun;`,
  )(
    () => "",
    () => "",
    () => "失败",
    (value) => Number.isFinite(Number(value)) ? `${Number(value)}ms` : "",
  );
  const summary = summarize({
    status: "FAILED",
    executionProfile: {
      finalRuling: {
        provider: "relay",
        requestedModel: "relay-gpt-5.6-luna",
        model: "gpt-5.6-luna",
      },
    },
    stageTiming: {
      totalElapsedMs: 240_100,
      stages: [{ id: "generate_ruling", durationMs: 240_000 }],
    },
    error: {
      code: "provider_submission_outcome_unknown",
      message: "Provider submission outcome is unknown",
    },
  });

  assert.match(summary.metrics.join("\n"), /总耗时 240100ms/u);
  assert.match(summary.metrics.join("\n"), /历史记录未保存 reportedModel，无法核验/u);
  assert.match(summary.metrics.join("\n"), /可能已扣费.*中转后台/u);
  assert.match(summary.metrics.join("\n"), /Token 未知/u);
});

test("admin frozen-evidence comparison keeps failed final-call metering separate from pipeline totals", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function summarizeAdminComparisonRun",
    "function shouldTriggerAdminRunExecution",
  );
  const summarize = new Function(
    "formatAdminCnyCost",
    "formatAdminCost",
    "adminRunStatusLabel",
    "formatAdminDuration",
    `${source}; return summarizeAdminComparisonRun;`,
  )(
    (value) => Number.isFinite(Number(value)) ? `¥${Number(value)}` : "",
    (value) => Number.isFinite(Number(value)) ? `$${Number(value)}` : "",
    () => "失败",
    () => "",
  );
  const summary = summarize({
    status: "FAILED",
    executionProfile: {
      finalRuling: {
        provider: "relay",
        requestedModel: "relay-gpt-5.6-luna",
        submittedModel: "gpt-5.6-luna",
        pricingMultiplier: 0.27,
      },
    },
    error: {
      code: "relay_returned_model_mismatch",
      reportedModel: "gpt-5.6-terra",
      failureMetering: {
        scope: "final_ruling_only",
        usage: { totalTokens: 321 },
        cost: { totalCostUsd: 0.01, totalCostCny: 0.075, pricingMultiplier: 0.27 },
      },
    },
  });
  const text = summary.metrics.join("\n");
  assert.match(text, /final-only Token 321/u);
  assert.match(text, /final-only 成本 未验证估算/u);
  assert.match(text, /仅最终裁定调用（非整条 pipeline）/u);
  assert.match(text, /定价倍率 0\.27×/u);
  assert.doesNotMatch(text, /^Token 321$/mu);
});

test("admin model lab renders the current structured ruling schema", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function renderAdminStructuredResult",
    "function renderAdminMetrics",
  );
  const document = createTestDocument();
  const summary = document.createElement("section");
  const render = new Function(
    "ui",
    "document",
    "clearElement",
    "appendText",
    "firstAdminArray",
    "firstAdminValue",
    "adminDisplayValue",
    `${source}; return renderAdminStructuredResult;`,
  )(
    { adminResultSummary: summary },
    document,
    clearTestElement,
    appendTestText,
    (...values) => values.find(Array.isArray) || [],
    (...values) => values.find((value) => value !== undefined && value !== null && value !== ""),
    (value) => String(value?.text || value?.reason || value?.message || value || ""),
  );

  render({
    result: {
      experimental: true,
      finalRuling: {
        schemaVersion: "1.0",
        conciseAnswer: "可以发动，但处理时不会进行特殊召唤。",
        verdicts: [{
          questionId: "q1",
          value: "TRUE",
          conclusion: "发动合法。",
          conditions: ["手牌中存在可支付的卡"],
        }],
        claims: [{
          questionId: "q1",
          claimId: "c1",
          proposition: "发动条件在发动时满足。",
          status: "TRUE",
          decisive: true,
          evidenceIds: ["faq-1"],
          inferenceType: "DIRECT_OFFICIAL",
        }],
        timeline: [{
          order: 1,
          action: "支付代价",
          result: "手牌送去墓地",
          evidenceIds: ["faq-1"],
        }],
        unresolved: [{
          questionId: "q1",
          code: "FOLLOW_UP",
          decisive: false,
          explanation: "后续对象仍需确认。",
        }],
        confidence: {
          level: "HIGH",
          reasons: ["存在直接官方资料"],
        },
      },
    },
  });

  const text = testNodeText(summary);
  assert.match(text, /可以发动，但处理时不会进行特殊召唤/u);
  assert.match(text, /实验结果.*不代表官方裁定/u);
  assert.match(text, /q1 · 可以／成立/u);
  assert.match(text, /手牌中存在可支付的卡/u);
  assert.match(text, /发动条件在发动时满足/u);
  assert.match(text, /支付代价 → 手牌送去墓地/u);
  assert.match(text, /后续对象仍需确认/u);
  assert.doesNotMatch(text, /已收到结构化结果/u);
});

test("admin model lab explains outcome-unknown billing instead of showing a generic empty result", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function renderAdminStructuredResult",
    "function renderAdminMetrics",
  );
  const document = createTestDocument();
  const summary = document.createElement("section");
  const render = new Function(
    "ui",
    "document",
    "clearElement",
    "appendText",
    "firstAdminArray",
    "firstAdminValue",
    "adminDisplayValue",
    `${source}; return renderAdminStructuredResult;`,
  )(
    { adminResultSummary: summary },
    document,
    clearTestElement,
    appendTestText,
    (...values) => values.find(Array.isArray) || [],
    (...values) => values.find((value) => value !== undefined && value !== null && value !== ""),
    (value) => String(value?.text || value?.reason || value?.message || value || ""),
  );

  render({
    status: "FAILED",
    error: { code: "provider_submission_outcome_unknown" },
  });
  const text = testNodeText(summary);
  assert.match(text, /可能已经产生费用/u);
  assert.match(text, /禁止自动重试/u);
  assert.match(text, /中转后台记录/u);
  assert.doesNotMatch(text, /最终裁定尚未生成/u);
});

test("admin model lab rejects a relay response with a missing reportedModel and warns about billing", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function renderAdminStructuredResult",
    "function renderAdminMetrics",
  );
  const document = createTestDocument();
  const summary = document.createElement("section");
  const render = new Function(
    "ui",
    "document",
    "clearElement",
    "appendText",
    "firstAdminArray",
    "firstAdminValue",
    "adminDisplayValue",
    `${source}; return renderAdminStructuredResult;`,
  )(
    { adminResultSummary: summary },
    document,
    clearTestElement,
    appendTestText,
    (...values) => values.find(Array.isArray) || [],
    (...values) => values.find((value) => value !== undefined && value !== null && value !== ""),
    (value) => String(value?.text || value?.reason || value?.message || value || ""),
  );
  render({
    status: "FAILED",
    error: {
      code: "relay_returned_model_missing",
      requestedModel: "relay-gpt-5.6-sol",
      submittedModel: "gpt-5.6-sol",
    },
  });
  const text = testNodeText(summary);
  assert.match(text, /缺少 reportedModel/u);
  assert.match(text, /请求模型：relay-gpt-5\.6-sol/u);
  assert.match(text, /提交模型：gpt-5\.6-sol/u);
  assert.match(text, /可能已经产生费用/u);
});

test("admin model lab distinguishes relay requested, submitted, returned and dashboard-attributed identities", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function renderAdminMetrics",
    "function renderAdminEvidence",
  );
  const document = createTestDocument();
  const metricsNode = document.createElement("dl");
  const render = new Function(
    "ui",
    "document",
    "clearElement",
    "appendText",
    "adminRunStatusLabel",
    "formatAdminCost",
    "formatAdminCnyCost",
    "formatAdminMetricDuration",
    "formatAdminDuration",
    `${source}; return renderAdminMetrics;`,
  )(
    { adminMetrics: metricsNode },
    document,
    clearTestElement,
    appendTestText,
    (value) => String(value || ""),
    (value) => Number.isFinite(Number(value)) ? `$${Number(value).toFixed(6)}` : "",
    (value) => Number.isFinite(Number(value)) ? `¥${Number(value).toFixed(4)}` : "",
    (value) => String(value ?? ""),
  );

  render({
    status: "SUCCEEDED",
    executionProfile: {
      finalRuling: {
        provider: "relay",
        requestedModel: "relay-gpt-5.6-terra",
        submittedModel: "gpt-5.6-terra",
        pricingMultiplier: 0.27,
      },
    },
    result: {
      provider: { reportedModel: "gpt-5.6-terra" },
      metering: {
        totals: {
          usage: { totalTokens: 100 },
          cost: { totalCostUsd: 0.01, totalCostCny: 0.075 },
        },
      },
    },
  });

  const text = testNodeText(metricsNode);
  assert.match(text, /请求模型\nrelay-gpt-5\.6-terra/u);
  assert.match(text, /提交给中转的模型\ngpt-5\.6-terra/u);
  assert.match(text, /供应商自报返回模型\ngpt-5\.6-terra/u);
  assert.match(text, /真实上游身份仍未验证/u);
  assert.match(text, /中转后台模型归因\n本记录不保存后台归因/u);
  assert.match(text, /Relay 定价倍率\n0\.27×/u);
  assert.match(text, /美元估算（未验证费率）\n\$0\.010000/u);
  assert.match(text, /人民币估算（未验证费率）\n¥0\.0750/u);
});

test("admin model lab never treats legacy provider.model or error.model as reportedModel", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function renderAdminMetrics",
    "function renderAdminEvidence",
  );
  const document = createTestDocument();
  const metricsNode = document.createElement("dl");
  const render = new Function(
    "ui",
    "document",
    "clearElement",
    "appendText",
    "adminRunStatusLabel",
    "formatAdminCost",
    "formatAdminCnyCost",
    "formatAdminMetricDuration",
    "formatAdminDuration",
    `${source}; return renderAdminMetrics;`,
  )(
    { adminMetrics: metricsNode },
    document,
    clearTestElement,
    appendTestText,
    (value) => String(value || ""),
    () => "",
    () => "",
    () => "",
  );
  render({
    status: "FAILED",
    executionProfile: {
      finalRuling: {
        provider: "relay",
        requestedModel: "relay-gpt-5.6-luna",
        submittedModel: "gpt-5.6-luna",
      },
    },
    result: { provider: { model: "gpt-5.6-terra" } },
    error: { model: "gpt-5.6-terra" },
  });
  const text = testNodeText(metricsNode);
  assert.match(text, /历史记录未保存 reportedModel，无法核验/u);
  assert.doesNotMatch(text, /供应商自报返回模型\ngpt-5\.6-terra/u);
});

test("admin model lab labels failure metering as final-only instead of pipeline totals", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function renderAdminMetrics",
    "function renderAdminEvidence",
  );
  const document = createTestDocument();
  const metricsNode = document.createElement("dl");
  const render = new Function(
    "ui",
    "document",
    "clearElement",
    "appendText",
    "adminRunStatusLabel",
    "formatAdminCost",
    "formatAdminCnyCost",
    "formatAdminMetricDuration",
    "formatAdminDuration",
    `${source}; return renderAdminMetrics;`,
  )(
    { adminMetrics: metricsNode },
    document,
    clearTestElement,
    appendTestText,
    (value) => String(value || ""),
    (value) => Number.isFinite(Number(value)) ? `$${Number(value).toFixed(6)}` : "",
    (value) => Number.isFinite(Number(value)) ? `¥${Number(value).toFixed(4)}` : "",
    () => "",
    (value) => Number.isFinite(Number(value)) ? `${Number(value)}ms` : "",
  );
  render({
    status: "FAILED",
    executionProfile: {
      finalRuling: {
        provider: "relay",
        requestedModel: "relay-gpt-5.6-sol",
        submittedModel: "gpt-5.6-sol",
      },
    },
    error: {
      code: "provider_submission_outcome_unknown",
      reportedModel: "gpt-5.6-sol",
      streamMetrics: {
        requestToResponseHeadersMs: 50,
        requestToFirstByteMs: 70,
        requestToFirstEventMs: 80,
        requestToFirstContentMs: null,
        requestToCompleteMs: null,
        networkChunkCount: 2,
        sseEventCount: 2,
        responseBytes: 400,
        visibleContentBytes: 0,
        finishReason: null,
      },
      failureMetering: {
        scope: "final_ruling_only",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        cost: { totalCostUsd: 0.01, totalCostCny: 0.075 },
      },
    },
  });
  const text = testNodeText(metricsNode);
  assert.match(text, /失败计量范围\n仅最终裁定调用（非整条 pipeline）/u);
  assert.match(text, /最终裁定失败总 Token\n12/u);
  assert.match(text, /最终裁定失败美元估算（未验证费率）\n\$0\.010000/u);
  assert.match(text, /计费状态\n供应商已返回最终裁定 usage；已按 final-only 计量/u);
  assert.match(text, /SSE 首字节\n70ms/u);
  assert.match(text, /SSE 网络块 \/ 事件\n2 \/ 2/u);
  assert.doesNotMatch(text, /(?:^|\n)总 Token\n12(?:\n|$)/u);
});

test("admin model lab displays aggregate two-stage cost before final-stage cost", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function renderAdminMetrics",
    "function renderAdminEvidence",
  );
  const document = createTestDocument();
  const metricsNode = document.createElement("dl");
  const render = new Function(
    "ui",
    "document",
    "clearElement",
    "appendText",
    "adminRunStatusLabel",
    "formatAdminCost",
    "formatAdminCnyCost",
    "formatAdminMetricDuration",
    `${source}; return renderAdminMetrics;`,
  )(
    { adminMetrics: metricsNode },
    document,
    clearTestElement,
    appendTestText,
    (value) => String(value || ""),
    (value) => Number.isFinite(Number(value)) ? `$${Number(value).toFixed(6)}` : "",
    (value) => Number.isFinite(Number(value)) ? `¥${Number(value).toFixed(4)}` : "",
    (value) => String(value ?? ""),
  );

  render({
    status: "SUCCEEDED",
    metrics: {},
    usage: {},
    result: {
      cost: {
        totalCostUsd: 99,
        totalCostCny: 999,
      },
      metrics: {
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
        },
        cost: {
          totalCostUsd: 3,
          totalCostCny: 21,
          knownCostUsd: 3,
          knownCostCny: 21,
        },
      },
      metering: {
        totals: {
          cost: {
            totalCostUsd: 3,
            totalCostCny: 21,
          },
        },
      },
    },
  });

  const text = testNodeText(metricsNode);
  assert.match(text, /输入 Token\n12/u);
  assert.match(text, /总 Token\n15/u);
  assert.match(text, /\$3\.000000/u);
  assert.match(text, /¥21\.0000/u);
  assert.doesNotMatch(text, /\$99\.000000|¥999\.0000/u);
});

test("admin model lab labels incomplete aggregate costs as known portions", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function renderAdminMetrics",
    "function renderAdminEvidence",
  );
  const document = createTestDocument();
  const metricsNode = document.createElement("dl");
  const render = new Function(
    "ui",
    "document",
    "clearElement",
    "appendText",
    "adminRunStatusLabel",
    "formatAdminCost",
    "formatAdminCnyCost",
    "formatAdminMetricDuration",
    `${source}; return renderAdminMetrics;`,
  )(
    { adminMetrics: metricsNode },
    document,
    clearTestElement,
    appendTestText,
    (value) => String(value || ""),
    (value) => Number.isFinite(Number(value)) ? `$${Number(value).toFixed(6)}` : "",
    (value) => Number.isFinite(Number(value)) ? `¥${Number(value).toFixed(4)}` : "",
    (value) => String(value ?? ""),
  );

  render({
    status: "SUCCEEDED",
    metrics: {},
    usage: {},
    result: {
      metrics: {
        cost: {
          totalCostUsd: null,
          knownCostUsd: 1.25,
          totalCostCny: null,
          knownCostCny: 8.75,
          completeInUsd: false,
          completeInCny: false,
          missingUsdStages: ["evidencePreparation"],
          missingCnyStages: ["finalRuling"],
        },
      },
    },
  });

  const text = testNodeText(metricsNode);
  assert.match(text, /估算成本（仅已知部分）\n\$1\.250000/u);
  assert.match(text, /美元成本缺失阶段\n证据准备模型/u);
  assert.match(text, /人民币估算（仅已知部分）\n¥8\.7500/u);
  assert.match(text, /人民币成本缺失阶段\n最终裁定模型/u);
});

test("admin run merge replaces state across run ids and does not create empty metric shadows", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = sourceBetween(
    app,
    "function mergeAdminRun",
    "function extractAdminRun",
  );
  const merge = new Function(
    "previous",
    "incoming",
    `
      let adminCurrentRun = previous;
      let adminCurrentRunId = previous?.runId || "";
      const extractAdminRunId = (value) => String(value?.runId || value?.id || "");
      const storeAdminRunId = () => {};
      const updateAdminStagesFromRun = () => {};
      ${source}
      mergeAdminRun(incoming);
      return adminCurrentRun;
    `,
  );

  const merged = merge({
    runId: "run-a",
    oldOnly: true,
    metrics: { inputTokens: 999 },
    usage: { totalTokens: 999 },
  }, {
    runId: "run-b",
    status: "SUCCEEDED",
    result: {
      metrics: {
        usage: { totalTokens: 15 },
      },
    },
  });

  assert.equal(merged.runId, "run-b");
  assert.equal(merged.oldOnly, undefined);
  assert.equal(merged.metrics, undefined);
  assert.equal(merged.usage, undefined);
  assert.equal(merged.result.metrics.usage.totalTokens, 15);
});

test("admin run recovery retries only a safely unclaimed execution", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const predicateSource = sourceBetween(
    app,
    "function shouldTriggerAdminRunExecution",
    "function isAdminRunQueued",
  );
  const shouldTrigger = new Function(
    `${predicateSource}; return shouldTriggerAdminRunExecution;`,
  )();
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const baseRun = {
    status: "RUNNING",
    result: null,
    execution: {
      lease: null,
      providerSubmission: {
        state: "NONE",
        requestId: null,
        attemptId: null,
        intentAt: null,
        outcomeUnknownAt: null,
      },
    },
  };

  assert.equal(shouldTrigger({ ...baseRun, status: "QUEUED" }, now), true);
  assert.equal(shouldTrigger(baseRun, now), true);
  assert.equal(shouldTrigger({
    ...baseRun,
    execution: {
      ...baseRun.execution,
      lease: { expiresAt: "2026-07-30T11:59:59.000Z" },
    },
  }, now), true);
  assert.equal(shouldTrigger({
    ...baseRun,
    execution: {
      ...baseRun.execution,
      lease: { expiresAt: "2026-07-30T12:00:01.000Z" },
    },
  }, now), false);
  assert.equal(shouldTrigger({
    ...baseRun,
    execution: {
      ...baseRun.execution,
      lease: { expiresAt: "invalid" },
    },
  }, now), false);

  for (const state of ["SUBMITTING", "SUBMITTED", "REJECTED", "OUTCOME_UNKNOWN", "UNRECOGNIZED"]) {
    assert.equal(shouldTrigger({
      ...baseRun,
      execution: {
        lease: null,
        providerSubmission: {
          ...baseRun.execution.providerSubmission,
          state,
        },
      },
    }, now), false, `${state} must never be resubmitted by the browser`);
  }
  assert.equal(shouldTrigger({
    ...baseRun,
    execution: {
      lease: null,
      providerSubmission: {
        ...baseRun.execution.providerSubmission,
        requestId: "resp_existing",
      },
    },
  }, now), false);
  assert.equal(shouldTrigger({ ...baseRun, status: "CANCEL_REQUESTED" }, now), false);
  assert.equal(shouldTrigger({ ...baseRun, result: { finalRuling: {} } }, now), false);

  const triggerSource = sourceBetween(
    app,
    "function triggerAdminRunExecution",
    "async function cancelAdminExperiment",
  );
  assert.match(triggerSource, /shouldTriggerAdminRunExecution\(adminCurrentRun\)/u);
  assert.match(triggerSource, /\.finally\(\(\) => \{[\s\S]*adminExecuteAttemptedRunIds\.delete\(id\)/u);
  const refreshSource = sourceBetween(
    app,
    "async function refreshAdminRun",
    "function mergeAdminRun",
  );
  assert.match(refreshSource, /triggerAdminRunExecution\(runId\)/u);
});

test("local admin routes lazily share one session manager and omit legacy token auth", async () => {
  const server = await readFile(new URL("../backend/server.mjs", import.meta.url), "utf8");

  assert.match(server, /localAdminHandlersPromise \|\|= createLocalAdminHandlers\(\)/u);
  assert.match(server, /manager: createAdminSessionManager/u);
  assert.match(server, /allowMemoryStore: allowLocalMemoryStore/u);
  assert.match(server, /ADMIN_SESSION_STORAGE:[\s\S]*allowLocalMemoryStore \? "memory" : "redis"/u);
  assert.match(server, /createAdminAuthHandler\(shared\)/u);
  assert.match(server, /createProductionAdminModelLabHandler\(\{[\s\S]*?\.\.\.shared,/u);
  assert.match(server, /createAdminQueriesHandler\(shared\)/u);
  assert.doesNotMatch(server, /authorizeAdminRequest/u);
  assert.doesNotMatch(server, /x-admin-token/u);
});

test("rag_displays_simulator_output_as_a_separate_result", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="simulationPanel"[^>]+hidden/u);
  assert.match(html, /模拟器验证/u);
  assert.match(app, /function renderEngineSimulation/u);
  assert.match(app, /资料分析与模拟结果分别展示/u);
  assert.match(app, /模拟器结果不是官方裁定/u);
  assert.match(app, /function engineZoneSummary/u);
  assert.match(app, /当前等待/u);
  assert.match(app, /选择是否连锁/u);
  assert.match(app, /answer\?\.engineSimulation/u);
  assert.match(app, /info\?\.engineEnabled === true/u);
  assert.match(app, /if \(!appConfig\.engineEnabled\) return pendingStages/u);
  assert.match(app, /status !== "completed" \|\| !simulation/u);
});

test("rag UI presents every formal query without turning UNKNOWN into a negative", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const helperSource = sourceBetween(
    app,
    "function publicFormalQueryLines",
    "function publicRiskLines",
  );
  const publicFormalQueryLines = new Function(
    `${helperSource}; return publicFormalQueryLines;`,
  )();

  const lines = publicFormalQueryLines([
    { queryId: "q1", claimText: "第一问", verdict: "TRUE", trusted: true },
    { queryId: "q2", claimText: "第二问", verdict: "FALSE", trusted: true },
    {
      queryId: "q3",
      claimText: "第三问",
      verdict: "UNKNOWN",
      trusted: false,
      unknownReasons: [{ code: "MISSING_STATE_FACT" }],
    },
    {
      queryId: "q4",
      claimText: "第四问",
      verdict: "TRUE",
      trusted: false,
      conditional: true,
      assumptions: [{ assumptionId: "a1", type: "OPPONENT_PASSES_PRIORITY" }],
    },
  ]);

  assert.equal(lines.length, 4);
  assert.match(lines[0], /TRUE（证明已验证）/u);
  assert.match(lines[1], /FALSE（证明已验证）/u);
  assert.match(lines[2], /UNKNOWN（尚未得出结论，不等于“不能”）/u);
  assert.match(lines[2], /原因码：MISSING_STATE_FACT/u);
  assert.doesNotMatch(lines[2], /不能发动|不能特殊召唤/u);
  assert.match(lines[3], /UNKNOWN/u);
  assert.match(lines[3], /条件分析所用假设：OPPONENT_PASSES_PRIORITY/u);
  assert.match(app, /\.\.\.publicFormalQueryLines\(answer\.formalQueryResults \|\| \[\]\)/u);
  assert.match(app, /type === "formal_engine_proof"\) return "形式规则验证"/u);
  assert.match(app, /formal_engine_unknown: "形式规则内核本次未签发确定性证明；这不等于“不能”。"/u);
});

test("public pending stages merge evidence review into optional simulation and final generation", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const definitions = sourceBetween(
    app,
    "const pendingStages =",
    "let pendingStageTimers =",
  );
  const functionSource = sourceBetween(
    app,
    "function getPendingStages",
    "function allCards",
  );
  const inspect = new Function(
    "engineEnabled",
    `${definitions}\nconst appConfig = { engineEnabled };\n${functionSource}\nreturn { stages: getPendingStages(), delays: pendingStageDelays };`,
  );

  const withoutEngine = inspect(false);
  assert.deepEqual(withoutEngine.stages.map((stage) => stage.id), [
    "understand",
    "extract_card_names",
    "retrieve_card_texts",
    "retrieve_rulings",
    "generate_ruling",
  ]);
  const withEngine = inspect(true);
  assert.deepEqual(withEngine.stages.map((stage) => stage.id), [
    "understand",
    "extract_card_names",
    "retrieve_card_texts",
    "retrieve_rulings",
    "simulate",
    "generate_ruling",
  ]);
  assert.equal(withEngine.delays.length, withEngine.stages.length);
  assert.ok(withEngine.delays.every((delay, index) => index === 0 || delay > withEngine.delays[index - 1]));
});

test("rag UI presents provider failures as model service unavailable in Chinese", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const presentationSource = sourceBetween(
    app,
    "function providerFailurePresentation",
    "function renderRagAnswer",
  );
  const presentation = new Function(
    `${presentationSource}; return providerFailurePresentation;`,
  )();
  const systemPresentation = new Function(
    `${presentationSource}; return publicSystemFailurePresentation;`,
  )();
  const formatSource = sourceBetween(
    app,
    "function formatRiskFlag",
    "function formatProvisionalVerdict",
  );
  const format = new Function(`${formatSource}; return formatRiskFlag;`)();
  const riskSource = sourceBetween(app, "function publicRiskLines", "function ragBudgetLines");
  const riskLines = new Function(
    "formatRiskFlag",
    `${riskSource}; return publicRiskLines;`,
  )(format);

  assert.equal(presentation([]), null);
  assert.deepEqual(presentation(["model_provider_access_denied"]), {
    confidence: "暂不可用",
    className: "is-risky",
    title: "模型服务暂不可用",
    basis: "所选模型当前无访问权限",
  });
  assert.equal(
    presentation(["model_provider_timeout"]).basis,
    "模型服务调用超时",
  );
  assert.equal(
    presentation(["model_provider_call_failed"]).basis,
    "模型服务调用失败",
  );
  assert.deepEqual(riskLines([
    "model_provider_call_failed",
    "model_provider_access_denied",
  ]), ["所选裁定模型当前无访问权限，请切换模型或稍后重试。"]);
  assert.deepEqual(riskLines([
    "public_final_nonblocking_semantic_diagnostic",
    "public_final_repair_nonblocking_semantic_diagnostic",
  ]), []);
  assert.equal(
    format("model_provider_timeout"),
    "模型服务调用超时，模型没有生成裁定，请稍后重试。",
  );
  assert.deepEqual(systemPresentation(["model_output_schema_validation_failed"]), {
    confidence: "生成异常",
    className: "is-risky",
    title: "裁定生成未通过校验",
    basis: "模型输出无法解析",
  });
  assert.match(app, /providerFailureState\s*\? "模型服务暂不可用"\s*:\s*\(systemFailureState \? "裁定生成异常" : "分析完成"\)/u);
});

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function createTestDocument() {
  return {
    createElement(tagName) {
      return {
        tagName,
        textContent: "",
        childNodes: [],
        appendChild(child) {
          this.childNodes.push(child);
          return child;
        },
      };
    },
  };
}

function clearTestElement(element) {
  element.textContent = "";
  element.childNodes.length = 0;
}

function appendTestText(parent, tagName, text) {
  const node = {
    tagName,
    textContent: String(text ?? ""),
    childNodes: [],
    appendChild(child) {
      this.childNodes.push(child);
      return child;
    },
  };
  parent.appendChild(node);
  return node;
}

function testNodeText(node) {
  return [
    String(node?.textContent || ""),
    ...(node?.childNodes || []).map(testNodeText),
  ].filter(Boolean).join("\n");
}
