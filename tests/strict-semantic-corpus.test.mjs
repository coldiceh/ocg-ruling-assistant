import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

const corpus = JSON.parse(readFileSync(
  new URL("../data/test/five-state-transition-regressions.json", import.meta.url),
  "utf8",
));

const expectedPatterns = new Map([
  ["albaz-cost-enables-opponent-immunity", [/^可以发动/u, /不受这次效果影响/u, /不进行融合召唤/u]],
  ["evenly-from-hand-is-field-card-activation", [/(?:不能连锁发动|できません)/u, /(?:魔法与陷阱区域|魔法・罠カード)/u]],
  ["lotus-changes-yubel-effect-destruction-source", [/^不算被/u, /可以发动④效果/u]],
  ["zero-resolves-before-tcboo-cleanup", [/^可以发动/u, /同时特殊召唤/u, /两只怪兽都正常留在场上/u, /选择1只送去墓地/u]],
  ["silver-hound-control-condition-does-not-restart", [/立即不再适用/u, /不会恢复适用/u]],
]);

const env = {
  MODEL_PROVIDER: "mock",
  RAG_MODEL_PROVIDER: "mock",
  RAG_DRY_RUN: "1",
  OCG_ENGINE_ENABLED: "0",
};

for (const fixture of corpus.cases) {
  test(`strict five-state corpus wording: ${fixture.id}`, async () => {
    const answer = await answerRagRulingQuestion({
      question: fixture.question,
      env,
      dryRun: true,
    });
    const diagnostic = JSON.stringify({
      id: fixture.id,
      shortAnswer: answer.shortAnswer,
      modelUsed: answer.debug.modelUsed,
      decision: answer.debug.deterministicDecision,
      semanticDiagnostic: answer.debug.semanticStateTransitionDiagnostic,
      unresolvedMentions: answer.debug.unresolvedMentions,
    });

    for (const pattern of expectedPatterns.get(fixture.id) || []) {
      assert.match(answer.shortAnswer, pattern, diagnostic);
    }
    if (fixture.id === "evenly-from-hand-is-field-card-activation") {
      assert.equal(answer.debug.deterministicDecision, null, diagnostic);
      assert.equal(answer.debug.semanticStateTransitionDiagnostic?.status, "resolved", diagnostic);
      assert.equal(answer.debug.semanticStateTransitionDiagnostic?.authoritative, true, diagnostic);
      assert.ok(answer.usedEvidence.some((item) => item.type === "official_qa"), diagnostic);
    } else {
      assert.equal(answer.debug.deterministicDecision, "state_transition", diagnostic);
      assert.equal(answer.debug.modelUsed, "trusted-semantic-state-executor", diagnostic);
      assert.equal(answer.debug.timingsMs.finalModel, 0, diagnostic);
    }
    assert.deepEqual(answer.debug.unresolvedMentions, [], diagnostic);
  });
}
