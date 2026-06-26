import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildConditionalBranchLines,
  buildUserFacingSubAnswerSummary,
  statusLabelForSubAnswer,
} from "../src/uiPresentation.mjs";

test("confirmed answer displays 已确认", () => {
  const summary = buildUserFacingSubAnswerSummary({
    status: "confirmed",
    verdict: "can",
    evidenceIds: ["qa-1"],
  });
  assert.equal(summary.statusLabel, "已确认");
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
  assert.equal(summary.statusLabel, "未确认处理方式");
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
  assert.equal(summary.reason, "no_direct_evidence");
});

test("debug trace is backed by collapsed details in the page", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<details[^>]+parser-debug/u);
  assert.match(html, /id="parserDebugPanel" hidden/u);
  assert.equal(statusLabelForSubAnswer({ status: "unknown" }), "资料不足");
});
