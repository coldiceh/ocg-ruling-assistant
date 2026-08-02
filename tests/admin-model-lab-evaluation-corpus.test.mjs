import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const corpusUrl = new URL("../data/test/admin-model-lab-evaluations.json", import.meta.url);
const cardsUrl = new URL("../data/cards-lite.json", import.meta.url);

test("admin model lab corpus keeps the eight mechanism regressions complete and resolvable", async () => {
  const corpus = JSON.parse(await readFile(corpusUrl, "utf8"));
  const cardData = JSON.parse(await readFile(cardsUrl, "utf8"));
  const cards = Array.isArray(cardData) ? cardData : cardData.records;
  const knownCardIds = new Set(cards.map((card) => String(card.id)));

  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.cases.length, 8);
  assert.equal(new Set(corpus.cases.map((item) => item.id)).size, 8);

  const requiredUserCases = new Set([
    "procedure-banishing-creates-two-trigger-opportunities",
    "albaz-cost-enables-opponent-immunity",
    "evenly-from-hand-is-field-card-activation",
    "lotus-changes-yubel-effect-destruction-source",
    "zero-rivalry-sequential-resolution",
    "silver-hound-control-change-ends-lingering-restriction",
  ]);
  for (const id of requiredUserCases) {
    assert.equal(corpus.cases.some((item) => item.id === id), true, `missing required case ${id}`);
  }

  for (const item of corpus.cases) {
    assert.ok(String(item.question || "").length >= 20, item.id);
    assert.ok(String(item.expectedVerdict || "").length >= 4, item.id);
    assert.ok(Array.isArray(item.mechanisms) && item.mechanisms.length >= 1, item.id);
    assert.ok(Array.isArray(item.expectedAnswerKeyPoints) && item.expectedAnswerKeyPoints.length >= 2, item.id);
    assert.ok(Array.isArray(item.mustNotInclude), item.id);
    if (item.expectedEvidenceMaxRank !== undefined) {
      assert.ok(
        Number.isInteger(item.expectedEvidenceMaxRank)
          && item.expectedEvidenceMaxRank >= 5
          && item.expectedEvidenceMaxRank <= 32,
        `${item.id}: invalid expectedEvidenceMaxRank`,
      );
    }
    for (const cardId of item.expectedCardIds || []) {
      assert.equal(knownCardIds.has(String(cardId)), true, `${item.id}: missing card ${cardId}`);
    }
  }
});
