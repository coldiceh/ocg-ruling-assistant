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
  assert.match(html, /id="flashModelButton"/u);
  assert.match(html, /id="proModelButton"/u);
  assert.match(app, /modelTier: selectedModelTier/u);
  assert.match(app, /buildBackendCacheKey\(text, backendMode, selectedModelTier\)/u);
  assert.doesNotMatch(app, /deepAnalyzeButton|ragModeToggle|legacyPipelineToggle/u);
  assert.doesNotMatch(html, /裁判结论/u);
  assert.doesNotMatch(app, /裁判结论/u);
  assert.doesNotMatch(app, /FAST JUDGE/u);
  assert.doesNotMatch(app, /damage\.reasonCode|timing\.reasonCode/u);
  assert.doesNotMatch(app, /blocker\.id/u);
});

test("ui_hides_engine_details_by_default", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /裁定流程/u);
  assert.match(html, /今日额度/u);
  assert.match(html, /id="budgetResetButton"/u);
  assert.match(html, /id="themeToggle"/u);
  assert.match(html, /class="page-background"/u);
  assert.doesNotMatch(html, /ANALYSIS CORE|DeepSeek|TOKEN|provider debug/u);
  assert.doesNotMatch(html, /AI裁定分析|RAG 裁定分析|RAG 分析/u);
  assert.doesNotMatch(html, /后端模式|公开资料检索|卡片文本分析/u);
  assert.doesNotMatch(html, /terminal-theme|OCG RULING TERMINAL/u);
  assert.match(app, /debugUiEnabled/u);
  assert.match(app, /params\.get\("debug"\) === "1"/u);
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
  assert.match(css, /\.model-tier-toggle/u);
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
