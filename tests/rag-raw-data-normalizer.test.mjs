import assert from "node:assert/strict";
import test from "node:test";

import { normalizeInjectedData } from "../backend/ragEvidenceRetriever.mjs";
import { normalizeRawGenericInjectedData } from "../backend/rawGenericDataStore.mjs";
import { normalizeRagSourceData } from "../backend/ragRawDataNormalizer.mjs";

test("legacy and raw-generic normalization entry points share one byte-exact canonical snapshot", () => {
  const cards = [
    {
      cid: "ignored-cid",
      cardId: 101,
      cnName: "匿名测试卡",
      jpName: "ignored-jp-name",
      aliases: ["匿名别名", "匿名别名"],
    },
    { id: "", name: "" },
  ];
  const records = [
    {
      evidenceId: "card-faq-fixture",
      recordType: "card-faq",
      title: "匿名 FAQ",
      question: "「<<00101>>」可以发动吗？",
      rawDetailedQuestion: "「<<00101>>」在匿名条件下可以发动吗？",
      conclusion: "可以。",
      cardId: "00101",
    },
    {
      stableId: "ygoresources-qa-12345",
      recordType: "qa",
      text: "匿名问题？\n匿名回答。",
      questionCardIds: ["101"],
    },
    { id: "empty-record" },
  ];
  const qaRecords = [
    {
      sourceId: "54321",
      recordType: "qa",
      question: "另一个匿名问题？",
      answer: "不能。",
      cardIds: ["202"],
    },
  ];

  const direct = normalizeRagSourceData({ cards, records, qaRecords });
  const legacy = normalizeInjectedData({ cards, records, qaRecords });
  const rawGeneric = normalizeRawGenericInjectedData({ cards, records, qaRecords });

  assert.strictEqual(legacy, direct);
  assert.strictEqual(rawGeneric, direct);
  assert.equal(JSON.stringify(rawGeneric), JSON.stringify(legacy));
  assert.equal(rawGeneric.cards[0].id, "101");
  assert.deepEqual(rawGeneric.cards[0].aliases, ["匿名测试卡", "匿名别名", "匿名别名"]);
  assert.deepEqual(rawGeneric.records[0].cardIds, ["00101"]);
  assert.deepEqual(rawGeneric.records[0].questionCardIds, ["00101"]);
  assert.equal(
    rawGeneric.records[0].sourceUrl,
    "https://www.db.yugioh-card.com/yugiohdb/faq_search.action?ope=4&cid=101&request_locale=ja",
  );
  assert.equal(
    rawGeneric.qaRecords[0].sourceUrl,
    "https://www.db.yugioh-card.com/yugiohdb/faq_search.action?ope=5&fid=54321&keyword=&tag=-1&request_locale=ja",
  );
});

test("the shared normalizer preserves canonical reinjection and source-array caching", () => {
  const cards = [{ id: 1, name: "匿名卡" }];
  const records = [{ id: "rule-1", text: "匿名规则正文。" }];
  const qaRecords = [];

  const first = normalizeRawGenericInjectedData({ cards, records, qaRecords });
  assert.strictEqual(normalizeInjectedData({ cards, records, qaRecords }), first);
  assert.strictEqual(normalizeRagSourceData(first), first);
  assert.strictEqual(normalizeRawGenericInjectedData(first), first);
  assert.strictEqual(normalizeInjectedData(first).records, first.records);
});
