import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAcceptanceCaseFromSmoke,
  buildManualAcceptanceReport,
  saveManualAcceptanceReport,
} from "../scripts/manual-acceptance-check.mjs";

test("manual acceptance report can be generated and saved", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "acceptance-"));
  try {
    const report = buildManualAcceptanceReport([
      buildAcceptanceCaseFromSmoke(confirmedSmokeCase()),
      buildAcceptanceCaseFromSmoke(likelySmokeCase()),
      buildAcceptanceCaseFromSmoke(conditionalSmokeCase()),
    ]);
    const path = join(tempDir, "acceptance-report.json");
    await saveManualAcceptanceReport(report, path);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.total, 3);
    assert.equal(saved.passCount, 3);
    assert.equal(saved.needsReviewCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manual acceptance keeps unsafe, useless, and internal leak counters at zero for valid cases", () => {
  const report = buildManualAcceptanceReport([
    buildAcceptanceCaseFromSmoke(confirmedSmokeCase()),
    buildAcceptanceCaseFromSmoke(likelySmokeCase()),
  ]);
  assert.equal(report.unsafeConfirmedCount, 0);
  assert.equal(report.uselessUnknownCount, 0);
  assert.equal(report.internalReasonLeakCount, 0);
});

test("wrong card resolution suspicion is marked when a shorter alias is auto-resolved", () => {
  const report = buildManualAcceptanceReport([
    buildAcceptanceCaseFromSmoke({
      ...likelySmokeCase(),
      cardResolutionConfirmations: [{ unresolvedCardName: "卡通青眼究极龙", autoResolved: true }],
    }),
  ]);
  assert.equal(report.wrongCardResolutionCount, 1);
  assert.equal(report.needsReviewCount, 1);
  assert.equal(report.feedbackDrafts[0].type, "wrong_card_resolution");
});

test("failed acceptance case generates feedback draft", () => {
  const report = buildManualAcceptanceReport([
    buildAcceptanceCaseFromSmoke({
      id: "unsafe",
      input: "测试问题",
      finalStatus: "confirmed",
      finalVerdict: "can",
      evidenceIds: [],
      reason: "bad",
      subAnswers: [{
        questionId: "q1",
        status: "confirmed",
        verdict: "can",
        reason: "bad",
        evidenceIds: [],
        directEvidenceCount: 0,
        extractedVerdict: "unknown",
        presentation: { reason: "用户可读原因" },
      }],
      userFacingSummary: "已确认：can",
    }),
  ]);
  assert.equal(report.needsReviewCount, 1);
  assert.ok(report.feedbackDrafts.some((draft) => draft.type === "unsafe_confirmed"));
});

test("manual acceptance script does not modify benchmark cases directly", async () => {
  const benchmarkSource = await readFile(new URL("./benchmark-real-rulings.test.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(benchmarkSource, /acceptance-report|manual-acceptance/u);
});

function confirmedSmokeCase() {
  return {
    id: "confirmed",
    input: "确认问题",
    finalStatus: "confirmed",
    finalVerdict: "can",
    evidenceIds: ["qa-1"],
    reason: "explicit",
    subAnswers: [{
      questionId: "q1",
      status: "confirmed",
      verdict: "can",
      reason: "explicit",
      evidenceIds: ["qa-1"],
      directEvidenceCount: 1,
      extractedVerdict: "can",
      officialAnswer: { status: "confirmed", verdict: "can", evidenceIds: ["qa-1"], reason: "explicit" },
      presentation: { reason: "已有 direct evidence 且 verdict 明确。" },
    }],
    userFacingSummary: "已确认：can",
  };
}

function likelySmokeCase() {
  return {
    id: "likely",
    input: "未确认问题",
    finalStatus: "unknown",
    finalVerdict: "unknown",
    evidenceIds: [],
    reason: "no direct",
    subAnswers: [{
      questionId: "q1",
      status: "unknown",
      verdict: "unknown",
      reason: "no direct",
      evidenceIds: [],
      directEvidenceCount: 0,
      extractedVerdict: "unknown",
      likelyAnswer: {
        status: "best_effort",
        verdict: "unknown",
        reasoning: "未确认参考。",
        basis: ["card_text"],
        riskFlags: ["no_direct_evidence"],
        disclaimer: "未确认裁定，不能替代官方 Q&A",
      },
      presentation: { reason: "找到的资料与本题相关，但没有直接回答当前问题。" },
    }],
    userFacingSummary: "可能处理（未确认）：未确认参考。",
  };
}

function conditionalSmokeCase() {
  return {
    id: "conditional",
    input: "条件问题",
    finalStatus: "unknown",
    finalVerdict: "unknown",
    evidenceIds: ["faq-1"],
    conditionalAnswer: {
      branches: [{ label: "如果 A", explanation: "处理 A", evidenceIds: ["faq-1"] }],
      clarificationQuestion: "请补充状态。",
    },
    reason: "condition missing",
    subAnswers: [{
      questionId: "q1",
      status: "unknown",
      verdict: "unknown",
      reason: "condition missing",
      evidenceIds: ["faq-1"],
      directEvidenceCount: 1,
      extractedVerdict: "unknown",
      conditionalAnswer: {
        branches: [{ label: "如果 A", explanation: "处理 A", evidenceIds: ["faq-1"] }],
        clarificationQuestion: "请补充状态。",
      },
      presentation: { reason: "已找到相关 FAQ，但当前问题缺少必要状态，无法确定适用哪个分支。" },
    }],
    userFacingSummary: "条件不足：如果 A：处理 A。请补充状态。",
  };
}
