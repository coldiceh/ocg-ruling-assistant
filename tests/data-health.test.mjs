import assert from "node:assert/strict";
import test from "node:test";
import { buildDataHealth } from "../backend/dataHealth.mjs";

const card = { id: "card-a", name: "测试卡A", aliases: ["测试卡A", "卡A"] };
const qa = { id: "qa-a", recordType: "qa", title: "测试问答", conclusion: "可以。" };
const faq = { id: "faq-a", recordType: "card-faq", title: "测试 FAQ", conclusion: "可以。" };
const alias = { alias: "测试卡A", normalizedAlias: "测试卡a", cardId: "card-a", cardName: "测试卡A" };
const qaIndexEntry = { id: "qa-a", recordType: "qa" };

test("cards=0 and qa=0 reports data_source_missing", () => {
  const health = buildDataHealth();
  assert.equal(health.status, "data_source_missing");
  assert.equal(health.usable, false);
});

test("an alias without a card id reports alias_without_card_id", () => {
  const health = buildDataHealth({
    cards: [card],
    rulings: [qa, faq],
    aliases: [{ alias: "坏别名", cardId: "" }],
    qaIndex: [qaIndexEntry],
  });
  assert.equal(health.status, "alias_without_card_id");
});

test("qaCount>0 with an empty QA index reports qa_index_empty", () => {
  const health = buildDataHealth({ cards: [card], rulings: [qa, faq], aliases: [alias], qaIndex: [] });
  assert.equal(health.status, "qa_index_empty");
  assert.equal(health.usable, false);
});

test("complete data reports ok", () => {
  const health = buildDataHealth({ cards: [card], rulings: [qa, faq], aliases: [alias], qaIndex: [qaIndexEntry] });
  assert.equal(health.status, "ok");
  assert.equal(health.readinessLevel, "dev_ok");
  assert.equal(health.usable, true);
});

test("a production-sized card snapshot cannot silently omit all monster race metadata", () => {
  const cards = Array.from({ length: 5_000 }, (_, index) => ({
    id: `card-${index + 1}`,
    name: `测试怪兽${index + 1}`,
    cardType: "monster",
  }));
  const health = buildDataHealth({
    cards,
    rulings: [qa, faq],
    aliases: [{ ...alias, cardId: cards[0].id }],
    qaIndex: [qaIndexEntry],
  });

  assert.equal(health.monsterCardsCount, 5_000);
  assert.equal(health.monsterRaceMetadataCount, 0);
  assert.equal(health.monsterRaceMetadataCoverage, 0);
  assert.equal(health.status, "monster_metadata_incomplete");
  assert.equal(health.usable, false);
});
