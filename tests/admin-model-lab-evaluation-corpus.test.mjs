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
    assert.ok(
      Array.isArray(item.expectedEvidenceIds) && item.expectedEvidenceIds.length >= 1,
      `${item.id}: missing expectedEvidenceIds`,
    );
    assert.ok(item.expectedAssertions && typeof item.expectedAssertions === "object", item.id);
    const structuredAssertionCount = [
      ...(item.expectedAssertions.verdicts || []),
      ...(item.expectedAssertions.claims || []),
      ...(item.expectedAssertions.timelineOrder || []),
    ].length;
    assert.ok(structuredAssertionCount >= 1, `${item.id}: missing structured assertions`);
    for (const assertion of item.expectedAssertions.verdicts || []) {
      assert.ok(String(assertion.questionId || ""), `${item.id}: verdict questionId`);
      assert.ok(
        ["TRUE", "FALSE", "CONDITIONAL", "UNKNOWN"].includes(assertion.value),
        `${item.id}: invalid verdict assertion`,
      );
    }
    for (const assertion of item.expectedAssertions.claims || []) {
      assert.ok(String(assertion.assertionId || ""), `${item.id}: claim assertionId`);
      assert.ok(
        Array.isArray(assertion.proposition?.allOf)
          && assertion.proposition.allOf.length >= 1,
        `${item.id}: claim assertion must select a structured proposition`,
      );
    }
    for (const assertion of item.expectedAssertions.timelineOrder || []) {
      assert.ok(String(assertion.assertionId || ""), `${item.id}: timeline assertionId`);
      assert.ok(
        Array.isArray(assertion.steps) && assertion.steps.length >= 2,
        `${item.id}: timeline order needs at least two steps`,
      );
    }
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
