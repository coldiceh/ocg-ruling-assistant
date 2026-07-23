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
  assert.match(app, /startPendingStages/u);
  assert.match(html, /DeepSeek V4 Flash/u);
  assert.doesNotMatch(html, /id="flashModelButton"|id="proModelButton"|>Pro</u);
  assert.match(app, /const selectedModelTier = "flash"/u);
  assert.match(app, /modelTier: selectedModelTier/u);
  assert.match(html, /data-ruling-version="latest"[^>]+aria-pressed="true"[^>]*>最新版</u);
  assert.match(html, /data-ruling-version="previous"[^>]+aria-pressed="false"[^>]+disabled[^>]*>上一版</u);
  assert.match(app, /let selectedRulingVersion = "latest"/u);
  assert.match(app, /rulingVersion: requestedRulingVersion/u);
  assert.match(app, /selectRulingVersion\(button\.dataset\.rulingVersion\)/u);
  assert.match(html, /id="answerVersionText" hidden/u);
  assert.match(app, /effectiveRulingVersion \|\| answer\?\.rulingVersion/u);
  assert.match(app, /本次回答：\$\{label\}/u);
  assert.doesNotMatch(app, /请求版本：\$\{label\}/u);
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
     const selectedModelTier = "flash";
     ${versionClientSource}
     return requestBackendAnswer;`,
  )(fetchImpl);

  let requestBody = null;
  const confirmedRequest = buildRequest(async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ rulingVersion: "previous", shortAnswer: "已确认" }),
    };
  });
  const confirmed = await confirmedRequest("问题", "previous");
  assert.equal(requestBody.rulingVersion, "previous");
  assert.equal(confirmed.effectiveRulingVersion, "previous");

  const missingConfirmationRequest = buildRequest(async () => ({
    ok: true,
    json: async () => ({ shortAnswer: "旧后端未回显版本" }),
  }));
  await assert.rejects(
    missingConfirmationRequest("问题", "previous"),
    (error) => error?.code === "ruling_version_unconfirmed",
  );

  const mismatchedRequest = buildRequest(async () => ({
    ok: true,
    json: async () => ({ rulingVersion: "latest", shortAnswer: "错误版本" }),
  }));
  await assert.rejects(
    mismatchedRequest("问题", "previous"),
    (error) => error?.code === "ruling_version_mismatch",
  );
});

test("feedback_opens_a_prefilled_github_issue", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /https:\/\/github\.com\/coldiceh\/ocg-ruling-assistant\/issues\/new/u);
  assert.match(app, /在 GitHub 反馈这个回答/u);
  assert.match(app, /url\.searchParams\.set\("body", body\)/u);
  assert.doesNotMatch(app, /feedbackApiUrl|submitFeedbackCase|saveFeedbackCaseLocally/u);
});

test("backend answers bypass persistent browser cache and bust static assets", async () => {
  const [app, html, configText] = await Promise.all([
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../config.json", import.meta.url), "utf8"),
  ]);
  const config = JSON.parse(configText.replace(/^\uFEFF/u, ""));
  assert.match(html, /src\/app\.js\?v=20260722-answer-version-1/u);
  assert.match(config.answerApiUrl, /\?client=20260722-answer-version-1$/u);
  assert.match(app, /cache: "no-store"/u);
  assert.doesNotMatch(app, /backendAnswerCacheTtlMs|buildBackendCacheKey|readCachedBackendAnswer|writeCachedBackendAnswer|ocg-ruling-answer:v/u);
});

test("readme_keeps_only_requested_future_plans", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(readme, /## 技术架构|## 本地运行/u);
  const future = readme.match(/## 未来计划([\s\S]*?)## Disclaimer/u)?.[1] || "";
  assert.match(future, /模拟器验证/u);
  assert.match(future, /支持日文版本/u);
  assert.match(future, /支持 TCG 版本/u);
  assert.doesNotMatch(future, /validator|critic|更强规则分析/u);
});

test("ui_hides_engine_details_by_default", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /裁定流程/u);
  assert.match(html, /今日额度/u);
  assert.match(html, /id="budgetResetButton"[^>]+hidden/u);
  assert.match(html, /免责声明/u);
  assert.match(html, /不是 KONAMI 官方项目/u);
  assert.match(html, /id="themeToggle"/u);
  assert.match(html, /class="page-background"/u);
  assert.doesNotMatch(html, /ANALYSIS CORE|TOKEN|provider debug/u);
  assert.match(html, /DeepSeek V4 Flash/u);
  assert.doesNotMatch(html, /AI裁定分析|RAG 裁定分析|RAG 分析/u);
  assert.doesNotMatch(html, /后端模式|公开资料检索|卡片文本分析/u);
  assert.doesNotMatch(html, /terminal-theme|OCG RULING TERMINAL/u);
  assert.match(app, /debugUiEnabled/u);
  assert.match(app, /params\.get\("debug"\) === "1"/u);
  assert.match(app, /prompt\("请输入重置额度密码"\)/u);
  assert.match(app, /JSON\.stringify\(\{ password \}\)/u);
  assert.match(app, /未持久化/u);
  assert.match(app, /storageWarning/u);
  assert.match(app, /rulebook/u);
  assert.match(app, /publicRiskLines/u);
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
  assert.match(app, /analyzeButton\.disabled = Boolean\(isPending\)/u);
  assert.match(app, /setAttribute\("aria-busy"/u);
  assert.match(app, /查询中…/u);
  assert.match(css, /\.primary-button:disabled/u);
  assert.match(css, /cursor: wait/u);
});

test("owner_query_log_is_hidden_and_server_authorized", async () => {
  const [html, app, adminApi, adminAuth] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../api/admin-queries.js", import.meta.url), "utf8"),
    readFile(new URL("../backend/adminAuth.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="adminQueryPanel"[^>]+hidden/u);
  assert.doesNotMatch(html, /最多保留 30 天的提问文本|不记录 IP/u);
  assert.match(app, /params\.get\("admin"\) === "1"/u);
  assert.match(app, /\/api\/admin-queries/u);
  assert.match(app, /prompt\("请输入管理员密码"\)/u);
  assert.match(app, /JSON\.stringify\(\{ password, limit: 100 \}\)/u);
  assert.match(adminApi, /authorizeAdminRequest/u);
  assert.match(adminAuth, /timingSafeEqual/u);
  assert.doesNotMatch(adminAuth, /allure/u);
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
