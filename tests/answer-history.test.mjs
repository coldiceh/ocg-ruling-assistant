import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAnswerHistoryItem,
  recordAnswerHistory,
  shouldRecordAnswerHistory,
} from "../backend/answerHistory.mjs";

test("confirmed answer does not enter watch queue", () => {
  const answer = baseAnswer({ mode: "confirmed", subAnswers: [{ status: "confirmed", verdict: "can", evidenceIds: ["qa-1"], reason: "explicit" }] });
  assert.equal(shouldRecordAnswerHistory(answer), false);
});

test("provisionalAnswer enters watch queue with composite verdict and watch terms", () => {
  const answer = baseAnswer({
    mode: "unknown",
    subAnswers: [provisionalSubAnswer()],
  });
  const item = buildAnswerHistoryItem(answer, { now: "2026-06-26T00:00:00.000Z" });
  assert.equal(shouldRecordAnswerHistory(answer), true);
  assert.equal(item.finalStatus, "unknown");
  assert.equal(item.provisionalAnswer.verdict.activation, "can_activate");
  assert.ok(item.watchCardIds.includes(22090));
  assert.ok(item.watchTerms.includes("アルバスの落胤"));
  assert.ok(item.unknownReasons.includes("provisional_official_response"));
});

test("unknown no_direct_evidence enters watch queue", () => {
  const answer = baseAnswer({
    mode: "unknown",
    subAnswers: [{
      questionId: "q1",
      status: "unknown",
      verdict: "unknown",
      evidenceIds: [],
      reason: "no_evidence",
      warnings: [],
    }],
  });
  const item = buildAnswerHistoryItem(answer);
  assert.equal(shouldRecordAnswerHistory(answer), true);
  assert.ok(item.unknownReasons.includes("no_direct_evidence"));
});

test("duplicate watched answer updates instead of inserting another record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "answer-history-"));
  const answer = baseAnswer({
    mode: "unknown",
    subAnswers: [provisionalSubAnswer()],
  });
  const first = await recordAnswerHistory(answer, { dataDir: dir, now: "2026-06-26T00:00:00.000Z" });
  const second = await recordAnswerHistory(answer, { dataDir: dir, now: "2026-06-26T00:10:00.000Z" });
  const payload = JSON.parse(await readFile(join(dir, "answer-history.json"), "utf8"));

  assert.equal(first.recorded, true);
  assert.equal(second.recorded, true);
  assert.equal(second.updatedExisting, true);
  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0].createdAt, "2026-06-26T00:00:00.000Z");
  assert.equal(payload.records[0].lastEvaluatedAt, "2026-06-26T00:10:00.000Z");
});

function baseAnswer(overrides = {}) {
  const subAnswers = overrides.subAnswers || [];
  return {
    mode: overrides.mode || "unknown",
    verdict: "structured summary",
    formalQuery: formalQueryFixture(),
    parserDebug: {
      rawQuestion: "アルバスの落胤①効果を発動できるか。",
      evidenceTrace: [{
        questionId: "q1",
        resolvedCardIds: ["22090", "16493"],
        directEvidence: [],
        similarEvidence: [],
        rejectedEvidence: [],
        finalStatus: subAnswers[0]?.status || "unknown",
        reason: subAnswers[0]?.reason || "no_evidence",
      }],
    },
    cards: [
      { id: "22090", name: "アルバスの落胤", jaName: "アルバスの落胤" },
      { id: "16493", name: "導きの聖女エクレシア", jaName: "導きの聖女エクレシア" },
    ],
    subAnswers,
    evidenceIds: subAnswers.flatMap((item) => item.evidenceIds || []),
    ...overrides,
  };
}

function provisionalSubAnswer() {
  return {
    questionId: "q1",
    status: "unknown",
    verdict: "unknown",
    evidenceIds: [],
    reason: "provisional_official_response_available",
    warnings: ["provisional_official_response_not_confirmed"],
    provisionalAnswer: {
      status: "provisional_official_response",
      sourceType: "official_response_screenshot",
      verdict: {
        activation: "can_activate",
        cost: "can_pay_cost",
        resolution: "does_not_perform_fusion_material_processing",
      },
      explanation: "可以发动并支付 cost，但处理不进行。",
      watchOfficialDb: true,
      canRevalidate: true,
      revalidationReason: "official_database_direct_evidence_watch",
      watchOfficialDbConfig: {
        enabled: true,
        cardIds: [22090, 16493],
        queryTerms: ["アルバスの落胤", "導きの聖女エクレシア", "聖痕喰らいし竜", "融合素材", "コスト", "処理は何も行われません"],
      },
    },
  };
}

function formalQueryFixture() {
  return {
    originalText: "アルバスの落胤①効果を発動できるか。",
    cards: [{ name: "アルバスの落胤", role: "question_card" }],
    scenario: { rawContext: "", events: [], chainState: "unknown" },
    subQuestions: [{
      id: "q1",
      type: "activation_condition",
      card: "アルバスの落胤",
      askedResult: "can_activate_pay_cost_and_skip_fusion_material_processing",
      sourceText: "アルバスの落胤①効果を発動できるか。",
    }],
  };
}
