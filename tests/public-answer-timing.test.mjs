import assert from "node:assert/strict";
import test from "node:test";

import { answerPublicRulingQuestion } from "../backend/publicAnswerService.mjs";

test("public latency includes exact matching and reports its separate duration", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const result = await answerPublicRulingQuestion({
      payload: { question: "timing probe" },
      env: { MODEL_PROVIDER: "mock" },
      appendAudit: async () => null,
      answerOfficialExact: async () => {
        now += 700;
        return null;
      },
      answerRuling: async () => {
        now += 2_300;
        return { answerLevel: "rule_analysis", shortAnswer: "ok" };
      },
    });

    assert.equal(result.latency.durationMs, 3_000);
    assert.equal(result.latency.exactMatchMs, 700);
  } finally {
    Date.now = originalNow;
  }
});
