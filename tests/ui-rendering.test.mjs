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
  const compatibleLatest = await missingConfirmationRequest("问题", "latest");
  assert.equal(compatibleLatest.effectiveRulingVersion, "latest");
  assert.equal(compatibleLatest.rulingVersionCompatibility, "legacy_unversioned_latest");
  assert.equal(compatibleLatest.shortAnswer, "旧后端未回显版本");

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

test("admin_model_lab_is_hidden_and_requires_a_real_session", async () => {
  const [html, app, adminAuthApi, adminSession] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
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
  assert.match(html, /id="adminQuestionHistoryTitle">后台历史提问/u);
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
  assert.match(app, /typeof data\?\.content === "string"/u);
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
  assert.match(text, /q1 · 可以／成立/u);
  assert.match(text, /手牌中存在可支付的卡/u);
  assert.match(text, /发动条件在发动时满足/u);
  assert.match(text, /支付代价 → 手牌送去墓地/u);
  assert.match(text, /后续对象仍需确认/u);
  assert.doesNotMatch(text, /已收到结构化结果/u);
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
  assert.match(text, /美元成本缺失阶段\n证据准备（DeepSeek）/u);
  assert.match(text, /人民币估算（仅已知部分）\n¥8\.7500/u);
  assert.match(text, /人民币成本缺失阶段\n最终裁定（OpenAI）/u);
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
