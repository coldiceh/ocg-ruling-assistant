import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCardQaDiscoveryIndex,
  buildQaDetailCoverageStatus,
  buildFairQaCoverageOrder,
  classifyRemoteItemFetchFailure,
  collectDiscoveredQaIds,
  hasCompleteYgoresourcesQaBody,
  isAuthoritativeQaDetailSnapshot,
  isCompleteCardSnapshotRun,
  mergeCardQaDiscoveryIndex,
  mergeQaIndexCumulatively,
  mergeRulingsCumulatively,
  normalizeCard,
  normalizeQa,
  parseManifestPayload,
  quarantineConflictingTrackedAliases,
  rankCardQaIds,
  retainBoundedQaDetails,
  selectQaIdsForSync,
  updateKnownRetiredQaIds,
  updateQaMissingObservations,
  updateQaDetailStaleIds,
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

test("discovered QA missing from the lightweight index is refreshed before ordinary rotation", () => {
  const selected = selectQaIdsForSync({
    changedQaIds: [900],
    recentQaIds: [901],
    priorityQaIds: [902, 903],
    cardQaIds: [904, 905],
    coverageQaIds: [900, 901, 902, 903, 904, 905],
    limit: 4,
  });

  assert.deepEqual(selected.ids, ["900", "901", "902", "903"]);
  assert.equal(selected.prioritySelectedCount, 2);
});

test("unindexed QA rotates independently so a persistent failure cannot starve later IDs", () => {
  const discovered = Array.from({ length: 10 }, (_, index) => String(index + 1));
  const indexed = new Set();
  let priorityCursor = 0;

  for (let run = 0; run < 6; run += 1) {
    const priorityQaIds = discovered.filter((id) => !indexed.has(id));
    const selected = selectQaIdsForSync({
      priorityQaIds,
      priorityCursor,
      limit: 3,
    });
    for (const id of selected.ids) {
      if (id !== "1") indexed.add(id);
    }
    priorityCursor = selected.nextPriorityCursor;
  }

  assert.deepEqual([...indexed].sort((left, right) => Number(left) - Number(right)), discovered.slice(1));
  assert.deepEqual(buildQaDetailCoverageStatus({
    discoveredQaIds: discovered,
    indexedQaIds: [...indexed],
  }).incompleteIds, ["1"]);
});

test("QA detail coverage excludes explicitly retired IDs and reports every other missing body", () => {
  const retiredQaIds = updateKnownRetiredQaIds({
    previousRetiredQaIds: ["2", "4", "99"],
    changedQaIds: ["2"],
    removedQaIds: ["3"],
    recoveredQaIds: ["4"],
    discoveredQaIds: ["1", "2", "3", "4"],
  });
  const coverage = buildQaDetailCoverageStatus({
    discoveredQaIds: ["1", "2", "3", "4"],
    indexedQaIds: ["1"],
    retiredQaIds,
  });

  assert.deepEqual(retiredQaIds, ["3"]);
  assert.deepEqual(coverage, {
    complete: false,
    discoveredCount: 4,
    indexedCount: 1,
    retiredCount: 1,
    incompleteCount: 2,
    incompleteIds: ["2", "4"],
  });
});

test("a transient 404 requires confirmation and a later success clears retirement state", () => {
  const first = updateQaMissingObservations({
    discoveredQaIds: ["1", "2"],
    missingQaIds: ["2"],
  });
  assert.deepEqual(first.observations, { 2: 1 });
  assert.deepEqual(first.confirmedRemovedQaIds, []);

  const second = updateQaMissingObservations({
    previousObservations: first.observations,
    discoveredQaIds: ["1", "2"],
    missingQaIds: ["2"],
  });
  assert.deepEqual(second.observations, { 2: 2 });
  assert.deepEqual(second.confirmedRemovedQaIds, ["2"]);

  const recovered = updateQaMissingObservations({
    previousObservations: second.observations,
    discoveredQaIds: ["1", "2"],
    successfulQaIds: ["2"],
  });
  assert.deepEqual(recovered.observations, {});
  assert.deepEqual(recovered.confirmedRemovedQaIds, []);
  assert.deepEqual(updateKnownRetiredQaIds({
    previousRetiredQaIds: ["2"],
    recoveredQaIds: ["2"],
    discoveredQaIds: ["1", "2"],
  }), []);
});

test("a changed QA counts a same-run 404 as the first missing observation", () => {
  const first = updateQaMissingObservations({
    previousObservations: { 2: 1 },
    discoveredQaIds: ["1", "2"],
    changedQaIds: ["2"],
    missingQaIds: ["2"],
  });
  assert.deepEqual(first.observations, { 2: 1 });
  assert.deepEqual(first.confirmedRemovedQaIds, []);

  const second = updateQaMissingObservations({
    previousObservations: first.observations,
    discoveredQaIds: ["1", "2"],
    missingQaIds: ["2"],
  });
  assert.deepEqual(second.observations, { 2: 2 });
  assert.deepEqual(second.confirmedRemovedQaIds, ["2"]);
});

test("an explicit 410 removal clears a prior 404 observation", () => {
  const removed = updateQaMissingObservations({
    previousObservations: { 2: 1 },
    discoveredQaIds: ["1", "2"],
    removedQaIds: ["2"],
  });
  assert.deepEqual(removed.observations, {});
  assert.deepEqual(removed.confirmedRemovedQaIds, []);
});

test("a changed QA stays stale after fetch failure until a later successful refresh", () => {
  const failed = updateQaDetailStaleIds({
    previousStaleQaIds: ["4"],
    changedQaIds: ["2"],
    failedQaIds: ["2"],
    successfulQaIds: ["4"],
    discoveredQaIds: ["1", "2", "3", "4"],
  });
  assert.deepEqual(failed, ["2"]);
  assert.deepEqual(buildQaDetailCoverageStatus({
    discoveredQaIds: ["1", "2", "3"],
    indexedQaIds: ["1", "2", "3"],
    staleQaIds: failed,
  }).incompleteIds, ["2"]);

  const recovered = updateQaDetailStaleIds({
    previousStaleQaIds: failed,
    successfulQaIds: ["2"],
    discoveredQaIds: ["1", "2", "3"],
  });
  assert.deepEqual(recovered, []);
});

test("QA detail coverage recognizes only a mechanically bounded question and answer body", () => {
  const title = "匿名完整问题的省略标题足够长…";
  const completeCompact = {
    id: "ygoresources-qa-88001",
    recordType: "qa",
    sourceName: "YGOResources DB",
    title,
    text: `匿名完整问题应当如何处理？\n${title}\n按照记述处理。`,
  };
  const answerOnly = {
    id: "ygoresources-qa-88002",
    recordType: "qa",
    sourceName: "YGOResources DB",
    title: "匿名答案资料标题足够长",
    text: "按照记述处理。",
  };

  assert.equal(hasCompleteYgoresourcesQaBody(completeCompact), true);
  assert.equal(hasCompleteYgoresourcesQaBody(answerOnly), false);
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

test("card QA discovery preserves every relation independently of the bounded hot-detail ranking", () => {
  const discovery = buildCardQaDiscoveryIndex([
    {
      record: { id: "300" },
      payload: { qaIndex: [900, 901, 902, 903, 904] },
    },
    {
      record: { id: "100" },
      payload: { qaIndex: [{ id: 905 }, { qaId: 906 }, 905] },
    },
  ]);

  assert.deepEqual(discovery, [
    { cardId: "100", qaIds: ["905", "906"] },
    { cardId: "300", qaIds: ["900", "901", "902", "903", "904"] },
  ]);
  assert.deepEqual(collectDiscoveredQaIds(discovery), ["900", "901", "902", "903", "904", "905", "906"]);
});

test("partial discovery refresh retains untouched cards while an authoritative refresh removes vanished relations", () => {
  const previous = [
    { cardId: "100", qaIds: ["900"] },
    { cardId: "200", qaIds: ["901"] },
  ];
  const current = [{ cardId: "200", qaIds: ["902"] }];

  assert.deepEqual(mergeCardQaDiscoveryIndex(previous, current), [
    { cardId: "100", qaIds: ["900"] },
    { cardId: "200", qaIds: ["902"] },
  ]);
  assert.deepEqual(mergeCardQaDiscoveryIndex(previous, current, { authoritative: true }), current);
});

test("bounded or warning-bearing sync runs cannot replace complete card or QA snapshots", () => {
  assert.equal(isCompleteCardSnapshotRun({
    syncAllReleasedCards: true,
    maxCards: 100,
    sourceWarningCount: 0,
  }), false);
  assert.equal(isCompleteCardSnapshotRun({
    syncAllReleasedCards: true,
    maxCards: 0,
    sourceWarningCount: 1,
  }), false);
  assert.equal(isCompleteCardSnapshotRun({
    syncAllReleasedCards: true,
    maxCards: 0,
    sourceWarningCount: 0,
  }), true);

  assert.equal(isAuthoritativeQaDetailSnapshot({
    maxQaTotal: 3000,
    cardSnapshotAuthoritative: false,
    sourceWarningCount: 0,
    detailSnapshotComplete: true,
  }), false);
  assert.equal(isAuthoritativeQaDetailSnapshot({
    maxQaTotal: 3000,
    cardSnapshotAuthoritative: true,
    sourceWarningCount: 1,
    detailSnapshotComplete: true,
  }), false);
});

test("fair QA coverage visits one relation per card before deep popular-card tails", () => {
  const order = buildFairQaCoverageOrder([
    { cardId: "100", qaIds: ["900", "901", "902"] },
    { cardId: "200", qaIds: ["903"] },
    { cardId: "300", qaIds: ["904", "905"] },
  ]);

  assert.deepEqual(order, ["900", "903", "904", "901", "905", "902"]);
});

test("bounded QA detail selection rotates through long-tail relations instead of permanently repeating the hot cap", () => {
  const coverageQaIds = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const seen = new Set();
  let cursor = 0;
  for (let run = 0; run < 4; run += 1) {
    const selected = selectQaIdsForSync({
      cardQaIds: [1, 2, 3],
      coverageQaIds,
      cursor,
      limit: 4,
    });
    assert.ok(selected.ids.length <= 4);
    selected.ids.forEach((id) => seen.add(id));
    cursor = selected.nextCursor;
  }

  assert.deepEqual([...seen].sort((left, right) => Number(left) - Number(right)), coverageQaIds.map(String));
});

test("a clean bounded snapshot prunes only unselected YGOResources QA details", () => {
  const records = [
    { id: "card-faq-100-1", recordType: "card-faq" },
    { id: "ygoresources-qa-900", recordType: "qa", sourceName: "YGOResources DB", sourceId: "900" },
    { id: "ygoresources-qa-901", recordType: "qa", sourceName: "YGOResources DB", sourceId: "901" },
    { id: "independent-qa", recordType: "qa", sourceName: "Independent Source" },
  ];

  const bounded = retainBoundedQaDetails(records, {
    selectedQaIds: [901],
    limit: 1,
    authoritative: true,
  });
  assert.deepEqual(bounded.map((record) => record.id), [
    "card-faq-100-1",
    "ygoresources-qa-901",
    "independent-qa",
  ]);
  assert.equal(retainBoundedQaDetails(records, {
    selectedQaIds: [901],
    limit: 1,
    authoritative: false,
  }).length, records.length);
});

test("lightweight QA index survives detail rotation while non-QA records rebuild from the current snapshot", () => {
  const previous = [
    { id: "qa-retained", recordType: "qa", sourceId: "81001", sourceName: "YGOResources DB", answer: "Retained answer" },
    { id: "qa-refreshed", recordType: "qa", sourceId: "81002", sourceName: "YGOResources DB", answer: "Old answer" },
    { id: "card-faq-stale", recordType: "card-faq", answer: "Stale card FAQ" },
  ];
  const current = [
    { id: "qa-refreshed", recordType: "qa", sourceId: "81002", sourceName: "YGOResources DB", answer: "Fresh answer" },
    { id: "qa-new", recordType: "qa", sourceId: "81003", sourceName: "YGOResources DB", answer: "New answer" },
    { id: "card-faq-current", recordType: "card-faq", answer: "Current card FAQ" },
  ];

  const merged = mergeQaIndexCumulatively(previous, current);

  assert.equal(merged.find((record) => record.id === "qa-retained")?.answer, "Retained answer");
  assert.equal(merged.find((record) => record.id === "qa-refreshed")?.answer, "Fresh answer");
  assert.equal(merged.find((record) => record.id === "qa-new")?.answer, "New answer");
  assert.equal(merged.some((record) => record.id === "card-faq-stale"), false);
  assert.equal(merged.some((record) => record.id === "card-faq-current"), true);
});

test("lightweight QA index removes only QA explicitly withdrawn upstream", () => {
  const previous = [
    { id: "ygoresources-qa-retired", recordType: "qa", sourceId: "82001", sourceName: "YGOResources DB" },
    { id: "ygoresources-qa-current", recordType: "qa", sourceId: "82002", sourceName: "YGOResources DB" },
    { id: "independent-qa", recordType: "qa", sourceId: "82001", sourceName: "Independent Source" },
  ];

  const merged = mergeQaIndexCumulatively(previous, [], { removedQaIds: ["82001"] });

  assert.equal(merged.some((record) => record.id === "ygoresources-qa-retired"), false);
  assert.equal(merged.some((record) => record.id === "ygoresources-qa-current"), true);
  assert.equal(merged.some((record) => record.id === "independent-qa"), true);
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

test("QA normalization preserves a short official heading separately from its detailed scenario", () => {
  const record = normalizeQa({
    cards: [101, 202],
    qaData: {
      ja: {
        title: "一時的に除外されたモンスターのコントロールはどうなりますか?",
        question: "条件(A)と条件(B)では、戻ったモンスターのコントロールはどうなりますか?",
        answer: "(A)は維持し、(B)は元に戻ります。",
      },
    },
  }, "77777", []);

  assert.equal(record.question, "一時的に除外されたモンスターのコントロールはどうなりますか?");
  assert.equal(record.rawQuestion, record.question);
  assert.equal(
    record.rawDetailedQuestion,
    "条件(A)と条件(B)では、戻ったモンスターのコントロールはどうなりますか?",
  );
  assert.match(record.rawDetailedQuestion, /条件\(A\)/u);
  assert.match(record.conclusion, /\(A\)は維持/u);
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

test("a 404 is provisional while a 410 is an immediate non-fatal retirement", () => {
  assert.deepEqual(classifyRemoteItemFetchFailure({ status: 404 }), {
    kind: "missing",
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
