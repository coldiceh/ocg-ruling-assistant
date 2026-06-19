import assert from "node:assert/strict";
import test from "node:test";
import {
  extractVerdictFromEvidence,
  finalAnswerGate,
  mergeModelAnswer,
} from "../backend/engine.mjs";
import {
  detectActionVerdict,
  detectConditionalBranches,
  detectPolarity,
  normalizeEvidenceText,
} from "../backend/verdictExtractor.mjs";

test("A. temporary-banish positive phrases extract can", () => {
  for (const text of ["可以除外。", "可以适用这个效果。", "除外できます。", "You can banish that monster."]) {
    assert.ok(["can", "banished_temporarily"].includes(extract(temporaryBanishQuestion, text).verdict), text);
  }
});

test("B. temporary-banish negative phrases extract cannot with negation priority", () => {
  for (const text of ["不能除外。", "不能适用这个效果。", "除外できません。", "You cannot banish that monster."]) {
    assert.equal(extract(temporaryBanishQuestion, text).verdict, "cannot", text);
  }
  assert.equal(detectPolarity("这个效果不能发动。"), "negative");
});

test("C. graveyard activation phrases extract activates_in_graveyard", () => {
  for (const text of ["这个效果在墓地发动。", "墓地で発動できます。", "This effect can be activated in the Graveyard."]) {
    assert.equal(extract(locationQuestion, text).verdict, "activates_in_graveyard", text);
  }
});

test("D. monster-zone activation phrases extract activates_on_field", () => {
  for (const text of ["这个效果在怪兽区域发动。", "モンスターゾーンで発動できます。", "This effect can be activated in the Monster Zone."]) {
    assert.equal(extract(locationQuestion, text).verdict, "activates_on_field", text);
  }
});

test("E. banished activation phrases extract activates_while_banished", () => {
  for (const text of ["这个效果在除外状态发动。", "除外されている状態で発動できます。", "This effect can be activated while banished."]) {
    assert.equal(extract(locationQuestion, text).verdict, "activates_while_banished", text);
  }
});

test("F. sent-to-graveyard phrases extract sent_to_graveyard", () => {
  for (const text of ["那张卡送去墓地。", "そのカードは墓地へ送られます。", "That card is sent to the Graveyard."]) {
    assert.equal(extract(sendQuestion, text).verdict, "sent_to_graveyard", text);
  }
});

test("G. not-sent-to-graveyard phrases extract not_sent_to_graveyard", () => {
  for (const text of ["那张卡不送去墓地。", "そのカードは墓地へ送られません。", "That card is not sent to the Graveyard."]) {
    assert.equal(extract(sendQuestion, text).verdict, "not_sent_to_graveyard", text);
  }
});

test("H. multiple conditional location branches remain unknown without state", () => {
  const text = "如果未被破坏，在场上发动；如果被破坏并送墓，在墓地发动。";
  assert.equal(detectConditionalBranches(text).conditional, true);
  const extracted = extract(locationQuestion, text);
  assert.equal(extracted.verdict, "unknown");
  assert.match(extracted.reason, /conditional|missing_state|ambiguous/u);
});

test("I. conflicting direct evidence remains unknown with a conflict warning", () => {
  const extracted = extractVerdictFromEvidence(temporaryBanishQuestion, [
    evidence("qa-can", "可以除外。"),
    evidence("qa-cannot", "不能除外。"),
  ]);
  assert.equal(extracted.verdict, "unknown");
  assert.match(extracted.reason, /conflicting_direct_evidence/u);
  assert.ok(extracted.warnings.includes("conflicting_direct_evidence"));
});

test("safety gates still reject missing evidence and unknown verdicts", () => {
  const missingEvidence = finalAnswerGate({
    questionId: "q1",
    status: "confirmed",
    verdict: "can",
    evidenceIds: [],
    warnings: [],
  }, { rulingEvidence: [] });
  assert.notEqual(missingEvidence.status, "confirmed");

  const unknownVerdict = finalAnswerGate({
    questionId: "q1",
    status: "confirmed",
    verdict: "unknown",
    evidenceIds: ["qa-1"],
    warnings: [],
  }, { rulingEvidence: [{ evidenceId: "qa-1" }] });
  assert.notEqual(unknownVerdict.status, "confirmed");
});

test("AI explanation cannot override an extracted program verdict", () => {
  const program = { status: "confirmed", verdict: "cannot", evidenceIds: ["qa-1"], reasoning: "explicit" };
  const merged = mergeModelAnswer({ status: "confirmed", verdict: "can", evidenceIds: ["fake"], explanationText: "冲突解释" }, program);
  assert.equal(merged.status, "confirmed");
  assert.equal(merged.verdict, "cannot");
  assert.deepEqual(merged.evidenceIds, ["qa-1"]);
});

test("normalizer unifies width, case, and whitespace", () => {
  assert.equal(normalizeEvidenceText("  ＣＡＮ\u00a0  BANISH  "), "can banish");
});

function extract(subQuestion, conclusion) {
  return extractVerdictFromEvidence(subQuestion, [evidence("qa-1", conclusion)]);
}

function evidence(id, conclusion) {
  return { id, evidenceId: id, recordType: "qa", conclusion };
}

const temporaryBanishQuestion = {
  id: "q1",
  type: "temporary_banish",
  card: "测试卡",
  askedResult: "can_banish_that_monster",
  sourceText: "能否除外那只怪兽？",
};

const locationQuestion = {
  id: "q1",
  type: "activation_location",
  card: "测试卡",
  askedResult: "effect_activation_location",
  sourceText: "这个效果在哪里发动？",
};

const sendQuestion = {
  id: "q1",
  type: "send_to_gy",
  card: "测试卡",
  askedResult: "is_sent_to_graveyard",
  sourceText: "那张卡会送墓吗？",
};
