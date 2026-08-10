import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRemoteItemFetchFailure,
  mergeRulingsCumulatively,
  normalizeCard,
  normalizeQa,
  parseManifestPayload,
  quarantineConflictingTrackedAliases,
  rankCardQaIds,
  selectQaIdsForSync,
} from "../scripts/sync-ygoresources.mjs";
import { quarantineRulingData } from "../backend/rulingDataQuality.mjs";

test("manifest parser reads real nested paths and response-header revision", () => {
  const parsed = parseManifestPayload({
    data: {
      qa: { 22803: 1, 13330: 1 },
      card: { 23486: 1 },
    },
  }, { revision: "32081" });

  assert.equal(parsed.revision, "32081");
  assert.deepEqual(parsed.changedQaIds, ["13330", "22803"]);
  assert.ok(parsed.changedPaths.includes("/data/card/23486"));
});

test("manifest parser treats a null no-change response as an empty manifest", () => {
  const parsed = parseManifestPayload(null, { revision: "32082" });

  assert.equal(parsed.revision, "32082");
  assert.deepEqual(parsed.changedPaths, []);
  assert.deepEqual(parsed.changedQaIds, []);
});

test("changed and recent QA IDs cannot be displaced by the all-card cap", () => {
  const selected = selectQaIdsForSync({
    changedQaIds: [22803],
    recentQaIds: [13330],
    cardQaIds: [1, 2, 3, 4, 5],
    limit: 2,
  });

  assert.deepEqual(selected.ids, ["22803", "13330"]);
  assert.equal(selected.changedSelectedCount, 1);
  assert.equal(selected.recentSelectedCount, 1);
  assert.equal(selected.truncatedCount, 5);
});

test("card QA ranking prioritizes interactions referenced by multiple cards", () => {
  const ranked = rankCardQaIds([
    { payload: { qaIndex: [5, 22803, 7] } },
    { payload: { qaIndex: [8, 22803, 9] } },
    { payload: { qaIndex: [10, 13330] } },
    { payload: { qaIndex: [13330, 11] } },
  ]);

  assert.deepEqual(ranked.slice(0, 2), ["22803", "13330"]);
});

test("QA normalization falls back from translation placeholders to the Japanese original per field", () => {
  const record = normalizeQa({
    cards: [12345],
    qaData: {
      en: {
        question: "Can this effect be activated?",
        answer: "Yes. (Translation mismatch error: the source text changed.)",
      },
      ja: {
        question: "この効果を発動できますか？",
        answer: "この効果は発動でき、通常通り処理します。",
      },
    },
  }, "99999", []);

  assert.equal(record.question, "この効果を発動できますか?");
  assert.equal(record.conclusion, "この効果は発動でき、通常通り処理します。");
  assert.equal(record.questionLocale, "ja");
  assert.equal(record.answerLocale, "ja");
  assert.deepEqual(record.cardIds, ["12345"]);
});

test("QA normalization retains a clean non-Japanese locale when no Japanese text exists", () => {
  const record = normalizeQa({
    qaData: {
      en: {
        question: "Can this effect be activated?",
        answer: "It can be activated.",
      },
    },
  }, "99998", []);

  assert.equal(record.question, "Can this effect be activated?");
  assert.equal(record.conclusion, "It can be activated.");
  assert.equal(record.questionLocale, "en");
  assert.equal(record.answerLocale, "en");
});

test("card normalization persists structured monster metadata without a card-specific branch", () => {
  const propertyMetadata = [
    null,
    ...Array.from({ length: 22 }, () => null),
    { en: "Link" },
    ...Array.from({ length: 6 }, () => null),
    { en: "Cyberse" },
  ];
  const record = normalizeCard({
    cardData: {
      ja: {
        name: "架空连接怪兽",
        cardType: "monster",
        effectText: "效果怪兽2只以上",
        atk: 2300,
        def: "",
        attribute: "dark",
        linkRating: 3,
        linkArrows: "813",
        properties: [30, 23, 4],
      },
    },
  }, { aliases: ["Fictional Link Monster"] }, "90001", propertyMetadata);
  const levelRecord = normalizeCard({
    cardData: {
      en: {
        name: "Fictional Level Monster",
        cardType: "monster",
        atk: 3000,
        def: 600,
        level: 11,
      },
    },
  }, {}, "90002", propertyMetadata);
  const rankRecord = normalizeCard({
    cardData: {
      en: {
        name: "Fictional Rank Monster",
        cardType: "monster",
        rank: 8,
      },
    },
  }, {}, "90003", propertyMetadata);

  assert.equal(record.type, "monster");
  assert.equal(record.cardType, "monster");
  assert.equal(record.race, "Cyberse");
  assert.equal(record.attribute, "dark");
  assert.equal(record.attack, 2300);
  assert.equal(record.atk, 2300);
  assert.equal("defense" in record, false);
  assert.equal(record.link, 3);
  assert.equal(record.linkRating, 3);
  assert.equal(record.linkArrows, "813");
  assert.deepEqual(record.monsterPropertyIds, ["30", "23", "4"]);
  assert.deepEqual(record.monsterProperties, ["Cyberse", "Link"]);
  assert.equal(levelRecord.level, 11);
  assert.equal(levelRecord.attack, 3000);
  assert.equal(levelRecord.defense, 600);
  assert.equal(rankRecord.rank, 8);
});

test("tracked aliases that uniquely belong to another canonical card are quarantined", () => {
  const warnings = [];
  const entries = [
    {
      tracked: { lookupName: "Card A", aliases: ["神炎龙"] },
      payload: { cardData: { en: { name: "Card A" }, cn: { name: "烙印龙 阿尔比昂" } } },
      record: { id: "a", aliases: ["Card A", "烙印龙 阿尔比昂", "神炎龙"] },
    },
    {
      tracked: { lookupName: "Card B", aliases: [] },
      payload: { cardData: { en: { name: "Card B" }, cn: { name: "神炎龙 卢绯里昂" } } },
      record: { id: "b", aliases: ["Card B", "神炎龙 卢绯里昂"] },
    },
  ];

  quarantineConflictingTrackedAliases(entries, (warning) => warnings.push(warning));

  assert.equal(entries[0].record.aliases.includes("神炎龙"), false);
  assert.equal(entries[1].record.aliases.includes("神炎龙 卢绯里昂"), true);
  assert.match(warnings[0], /card a.*canonical card b/u);
});

test("cumulative ruling merge keeps healthy old QA and lets new records override the same ID", () => {
  const previous = [
    { id: "ygoresources-qa-old", recordType: "qa", conclusion: "旧但仍有效的裁定" },
    { id: "ygoresources-qa-updated", recordType: "qa", conclusion: "旧答案" },
  ];
  const current = [
    { id: "ygoresources-qa-updated", recordType: "qa", conclusion: "新答案" },
  ];

  const merged = mergeRulingsCumulatively(previous, current);
  assert.equal(merged.find((item) => item.id === "ygoresources-qa-old")?.conclusion, "旧但仍有效的裁定");
  assert.equal(merged.find((item) => item.id === "ygoresources-qa-updated")?.conclusion, "新答案");

  const invalidCurrent = mergeRulingsCumulatively(previous, [
    {
      id: "ygoresources-qa-updated",
      recordType: "qa",
      conclusion: "Translation mismatch error: source changed",
    },
  ]);
  const quarantined = quarantineRulingData(invalidCurrent, previous);
  assert.equal(quarantined.records.find((item) => item.id === "ygoresources-qa-updated")?.conclusion, "旧答案");
});

test("withdrawn remote QA is non-fatal and removed from the cumulative snapshot", () => {
  assert.deepEqual(classifyRemoteItemFetchFailure({ status: 404 }), {
    kind: "removed",
    fatal: false,
    status: 404,
  });
  assert.deepEqual(classifyRemoteItemFetchFailure({ status: 410 }), {
    kind: "removed",
    fatal: false,
    status: 410,
  });
  assert.equal(classifyRemoteItemFetchFailure({ status: 503 }).fatal, true);
  assert.equal(classifyRemoteItemFetchFailure(new Error("network unavailable")).fatal, true);

  const previous = [
    {
      id: "ygoresources-qa-retired",
      sourceId: "70001",
      sourceName: "YGOResources DB",
      recordType: "qa",
      conclusion: "已被上游撤回",
    },
    {
      id: "ygoresources-qa-70002",
      recordType: "qa",
      conclusion: "仍然存在",
    },
    {
      id: "card-faq-70001-1",
      sourceId: "70001",
      recordType: "card-faq",
      conclusion: "卡片 FAQ 不属于独立 QA 条目",
    },
  ];

  const merged = mergeRulingsCumulatively(previous, [], { removedQaIds: ["70001"] });
  assert.equal(merged.some((record) => record.id === "ygoresources-qa-retired"), false);
  assert.equal(merged.some((record) => record.id === "ygoresources-qa-70002"), true);
  assert.equal(merged.some((record) => record.id === "card-faq-70001-1"), true);
});

test("a complete card snapshot replaces vanished card text and FAQ while retaining unsynchronized QA", () => {
  const previous = [
    { id: "card-text-100", recordType: "card-text", conclusion: "旧卡文" },
    { id: "card-faq-100-1", recordType: "card-faq", conclusion: "已撤回 FAQ" },
    { id: "card-faq-100-2", recordType: "card-faq", conclusion: "旧 FAQ" },
    { id: "ygoresources-qa-900", recordType: "qa", conclusion: "本轮未刷新但仍有效" },
  ];
  const current = [
    { id: "card-text-100", recordType: "card-text", conclusion: "新卡文" },
    { id: "card-faq-100-2", recordType: "card-faq", conclusion: "新 FAQ" },
  ];

  const merged = mergeRulingsCumulatively(previous, current, {
    authoritativeRecordTypes: ["card-text", "card-faq"],
  });

  assert.equal(merged.find((record) => record.id === "card-text-100")?.conclusion, "新卡文");
  assert.equal(merged.some((record) => record.id === "card-faq-100-1"), false);
  assert.equal(merged.find((record) => record.id === "card-faq-100-2")?.conclusion, "新 FAQ");
  assert.equal(merged.some((record) => record.id === "ygoresources-qa-900"), true);
});
