import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { analyzeEffectStateTransition } from "../backend/effectStateReasoner.mjs";
import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import { loadRagData } from "../backend/ragEvidenceRetriever.mjs";

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

const data = await loadRagData();

for (const fixture of corpus.cases) {
  test(`strict five-state corpus wording: ${fixture.id}`, async () => {
    const cardResolution = extractRagCards(fixture.question, {
      cards: data.cards,
      maxCards: 8,
    });
    const result = analyzeEffectStateTransition({
      userQuery: fixture.question,
      resolvedCards: cardResolution.resolvedCards,
    });
    const diagnostic = JSON.stringify({
      id: fixture.id,
      shortAnswer: result.shortAnswer,
      result,
      unresolvedMentions: cardResolution.unresolvedMentions,
    });

    for (const pattern of expectedPatterns.get(fixture.id) || []) {
      assert.match(result.shortAnswer, pattern, diagnostic);
    }
    assert.equal(result.status, "resolved", diagnostic);
    assert.equal(result.complete, true, diagnostic);
    assert.equal(result.authoritative, true, diagnostic);
    assert.deepEqual(cardResolution.unresolvedMentions, [], diagnostic);
  });
}
