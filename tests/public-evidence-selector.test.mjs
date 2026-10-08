import assert from "node:assert/strict";
import test from "node:test";
import {
  answerPublicRulingQuestion,
  getPublicAnswerModelInfo,
  parsePublicAnswerPayload,
} from "../backend/publicAnswerService.mjs";
import { classifyPublicRequestChannel } from "../backend/publicAnswerPresentation.mjs";

const webBody = {
  question: "Synthetic question",
  mode: "rag",
  rulingModelProfile: "bai-astra-low",
  rulingVersion: "latest",
};

test("public evidence selector accepts only Decisions or Luna on new questions", () => {
  for (const evidenceSelector of ["decisions", "luna"]) {
    for (const action of [undefined, "prepare"]) {
      const payload = { ...webBody, evidenceSelector, ...(action ? { action } : {}) };
      assert.equal(parsePublicAnswerPayload(payload).evidenceSelector, evidenceSelector);
      assert.equal(classifyPublicRequestChannel(payload), "web");
      assert.equal(classifyPublicRequestChannel({ ...payload, answerLocale: "ja" }), "web");
    }
  }
  for (const evidenceSelector of ["other", "Luna", "", null, {}, []]) {
    assert.throws(() => parsePublicAnswerPayload({ ...webBody, evidenceSelector }), {
      code: "invalid_evidence_selector",
    });
    assert.equal(classifyPublicRequestChannel({ ...webBody, evidenceSelector }), "unknown");
  }
});

test("saved preparations cannot have their evidence selector replaced", () => {
  for (const action of ["finalize", "status"]) {
    const body = { action, preparationId: "a".repeat(64) };
    assert.deepEqual(parsePublicAnswerPayload(body), body);
    for (const evidenceSelector of ["decisions", "luna"]) {
      assert.throws(() => parsePublicAnswerPayload({ ...body, evidenceSelector }), {
        code: "invalid_preparation_id",
      });
    }
  }
});

test("new requests default to Decisions and isolate explicit Luna from other requests", async () => {
  const env = { MODEL_PROVIDER: "mock", EVIDENCE_SELECTOR: "luna" };
  for (const prepareForContinuation of [false, true]) {
    for (const requested of [undefined, "luna", "decisions", undefined]) {
      let seen;
      await answerPublicRulingQuestion({
        payload: { question: "Synthetic question", ...(requested ? { evidenceSelector: requested } : {}) },
        env,
        prepareForContinuation,
        appendAudit: async () => null,
        preloadAssets: () => ({}),
        answerRuling: async (options) => {
          seen = options;
          return { status: "evidence_prepared", shortAnswer: "Synthetic answer" };
        },
      });
      assert.equal(seen.env.EVIDENCE_SELECTOR, requested || "decisions");
      assert.equal(seen.prepareForContinuation, prepareForContinuation ? true : undefined);
      assert.equal(env.EVIDENCE_SELECTOR, "luna");
    }
  }
});

test("public capabilities expose the default and both evidence selectors", async () => {
  const info = await getPublicAnswerModelInfo({ env: { MODEL_PROVIDER: "mock" } });
  assert.equal(info.defaultEvidenceSelector, "decisions");
  assert.deepEqual(info.evidenceSelectors, [
    { id: "decisions", label: "Decisions" },
    { id: "luna", label: "Luna" },
  ]);
});
