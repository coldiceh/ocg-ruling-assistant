import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RULING_VERSION,
  PREVIOUS_RULING_REVISION,
  answerRagRulingQuestionForVersion,
  getRulingVersionCapabilities,
  normalizeRequestedRulingVersion,
  resolveRulingVersionPipeline,
} from "../backend/rulingVersionRegistry.mjs";

test("ruling version capabilities expose latest and the frozen previous revision", () => {
  const capabilities = getRulingVersionCapabilities();
  assert.equal(capabilities.defaultRulingVersion, DEFAULT_RULING_VERSION);
  assert.deepEqual(capabilities.rulingVersions, [
    { id: "latest", label: "最新版", revision: null },
    { id: "previous", label: "上一版", revision: PREVIOUS_RULING_REVISION },
  ]);
});

test("missing rulingVersion defaults to latest and illegal values are rejected with 400", async () => {
  assert.equal(normalizeRequestedRulingVersion(undefined), "latest");
  assert.equal(normalizeRequestedRulingVersion(null), "latest");
  assert.equal(normalizeRequestedRulingVersion(" PREVIOUS "), "previous");
  for (const invalid of ["", "old", "58060bdc6", 42]) {
    await assert.rejects(
      Promise.resolve().then(() => normalizeRequestedRulingVersion(invalid)),
      (error) => error?.code === "invalid_ruling_version" && error?.statusCode === 400,
    );
  }
});

test("previous pipeline is dynamically loaded once and never aliases latest", async () => {
  const latest = await resolveRulingVersionPipeline("latest");
  const previousA = await resolveRulingVersionPipeline("previous");
  const previousB = await resolveRulingVersionPipeline("previous");
  assert.equal(latest.effectiveRulingVersion, "latest");
  assert.equal(previousA.effectiveRulingVersion, "previous");
  assert.equal(previousA.answerRagRulingQuestion, previousB.answerRagRulingQuestion);
  assert.notEqual(previousA.answerRagRulingQuestion, latest.answerRagRulingQuestion);
});

test("versioned answer dispatch echoes the requested and effective version", async () => {
  const latest = await answerRagRulingQuestionForVersion({
    question: "",
    rulingVersion: "latest",
  });
  assert.equal(latest.requestedRulingVersion, "latest");
  assert.equal(latest.effectiveRulingVersion, "latest");
  assert.equal(latest.rulingVersion, "latest");

  const previous = await answerRagRulingQuestionForVersion({
    question: "",
    rulingVersion: "previous",
  });
  assert.equal(previous.requestedRulingVersion, "previous");
  assert.equal(previous.effectiveRulingVersion, "previous");
  assert.equal(previous.rulingVersion, "previous");
});
