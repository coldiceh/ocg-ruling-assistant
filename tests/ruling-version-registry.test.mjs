import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RULING_VERSION,
  answerRagRulingQuestionForVersion,
  getRulingVersionCapabilities,
  normalizeRequestedRulingVersion,
  resolveRulingVersionPipeline,
} from "../backend/rulingVersionRegistry.mjs";
import { answerRagRulingQuestion as answerRawEvidenceRagQuestion } from "../backend/rawEvidenceRagPipeline.mjs";

test("ruling version capabilities expose only latest", () => {
  const capabilities = getRulingVersionCapabilities();
  assert.equal(capabilities.defaultRulingVersion, DEFAULT_RULING_VERSION);
  assert.deepEqual(capabilities.rulingVersions, [
    { id: "latest", label: "最新版", revision: null, legacyCompatibility: false },
  ]);
});

test("missing rulingVersion defaults to latest and illegal values are rejected with 400", async () => {
  assert.equal(normalizeRequestedRulingVersion(undefined), "latest");
  assert.equal(normalizeRequestedRulingVersion(null), "latest");
  assert.equal(normalizeRequestedRulingVersion(" LATEST "), "latest");
  for (const invalid of ["", "previous", "old", "58060bdc6", 42]) {
    await assert.rejects(
      Promise.resolve().then(() => normalizeRequestedRulingVersion(invalid)),
      (error) => error?.code === "invalid_ruling_version" && error?.statusCode === 400,
    );
  }
});

test("latest pipeline resolves without a frozen compatibility implementation", async () => {
  const latest = await resolveRulingVersionPipeline("latest");
  assert.equal(latest.effectiveRulingVersion, "latest");
  assert.equal(latest.legacyCompatibility, false);
  assert.deepEqual(latest.versionWarnings, []);
  assert.equal(typeof latest.answerRagRulingQuestion, "function");
  assert.equal(latest.answerRagRulingQuestion, answerRawEvidenceRagQuestion);
});

test("versioned answer dispatch echoes the requested and effective version", async () => {
  const latest = await answerRagRulingQuestionForVersion({
    question: "",
    rulingVersion: "latest",
  });
  assert.equal(latest.requestedRulingVersion, "latest");
  assert.equal(latest.effectiveRulingVersion, "latest");
  assert.equal(latest.rulingVersion, "latest");
  assert.equal(latest.legacyCompatibility, false);
  assert.deepEqual(latest.versionWarnings, []);
});
