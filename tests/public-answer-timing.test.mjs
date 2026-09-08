import assert from "node:assert/strict";
import test from "node:test";

import { answerPublicRulingQuestion } from "../backend/publicAnswerService.mjs";

test("public latency reports no exact-match duration while the shortcut is disabled", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  let exactCalls = 0;
  Date.now = () => now;
  try {
    const result = await answerPublicRulingQuestion({
      payload: { question: "timing probe" },
      env: { MODEL_PROVIDER: "mock" },
      appendAudit: async () => null,
      answerOfficialExact: async () => {
        exactCalls += 1;
        now += 700;
        return null;
      },
      answerRuling: async () => {
        now += 2_300;
        return { answerLevel: "rule_analysis", shortAnswer: "ok" };
      },
    });

    assert.equal(exactCalls, 0);
    assert.equal(result.latency.durationMs, 2_300);
    assert.equal(result.latency.exactMatchMs, 0);
  } finally {
    Date.now = originalNow;
  }
});
