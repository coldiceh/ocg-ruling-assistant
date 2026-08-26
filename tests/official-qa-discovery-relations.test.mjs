import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bindOfficialQaDiscoveryRelations,
  getOfficialQaDiscoveryCardIds,
  getOfficialQaDiscoveryRelationStatus,
} from "../backend/officialQaDiscoveryRelations.mjs";
import { searchOfficialQaEvidence } from "../backend/officialQaMatcher.mjs";
import {
  normalizeInjectedData,
  retrieveRagEvidence,
} from "../backend/ragEvidenceRetriever.mjs";

test("a current discovery relation recalls an official QA as related-only", async (context) => {
  const dataDir = await discoveryFixture(context, {
    sourceRevision: "fixture-current",
    records: [{ cardId: "92002", qaIds: ["81001"] }],
  });
  const card = {
    id: "92002",
    cardId: "92002",
    name: "匿名发现关系卡",
    aliases: ["匿名发现关系卡"],
    effectText: "这张卡离场时适用其记述的处理。",
  };
  const officialQa = {
    id: "ygoresources-qa-81001",
    sourceId: "81001",
    recordType: "qa",
    title: "匿名超量素材处理问题",
    question: "「<<92001>>」适用中，超量怪兽离场时其素材如何处理？",
    answer: "按照该效果记述处理其素材。",
    text: "「<<92001>>」适用中，超量怪兽离场时其素材如何处理？\n按照该效果记述处理其素材。",
    sourceName: "YGOResources DB",
    status: "current",
  };
  const data = normalizeInjectedData({ cards: [card], records: [], qaRecords: [officialQa] });
  const unboundMatches = searchOfficialQaEvidence({
    question: "「匿名发现关系卡」适用中，超量怪兽离场时其素材如何处理？",
    records: data.qaRecords,
    resolvedCards: [card],
    limit: 5,
    subsumptionCandidatePoolComplete: true,
  });
  const status = await bindOfficialQaDiscoveryRelations({ dataDir, data });

  assert.equal(status.available, true);
  assert.equal(status.missingBodyCount, 0);
  assert.deepEqual(getOfficialQaDiscoveryCardIds(data.qaRecords[0]), [card.id]);

  const matches = searchOfficialQaEvidence({
    question: "「匿名发现关系卡」适用中，超量怪兽离场时其素材如何处理？",
    records: data.qaRecords,
    resolvedCards: [card],
    limit: 5,
    subsumptionCandidatePoolComplete: true,
  });
  assert.equal(matches.all.length, 1);
  assert.deepEqual(matches.all[0].matchedDiscoveryCardIds, [card.id]);
  assert.ok(matches.all[0].matchedBy.includes("related_discovery_card_id"));
  for (const field of [
    "matchLevel",
    "score",
    "cardMatch",
    "cardIdCoverage",
    "relatedCardIdCoverage",
    "rawSceneMatch",
    "structuredSceneMatch",
    "authoritativeSceneMatch",
    "semanticSubsumptionCertified",
    "questionCardSubsumptionCertified",
  ]) {
    assert.equal(matches.all[0][field], unboundMatches.all[0][field], field);
  }
  assert.equal(matches.exact.length, 0);

  const evidence = await retrieveRagEvidence({
    userQuery: "「匿名发现关系卡」适用中，超量怪兽离场时其素材如何处理？",
    cardResolution: {
      resolvedCards: [card],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  });
  const related = evidence.officialQaRelated.find((item) => item.id === officialQa.id);
  assert.ok(related);
  assert.deepEqual(related.matchedDiscoveryCardIds, [card.id]);
  assert.ok(related.matchedBy.includes("related_discovery_card_id"));
  assert.equal(evidence.officialQaDirectCandidates.some((item) => item.id === officialQa.id), false);
  assert.equal(evidence.debug.officialQaDiscoveryRelations.available, true);
});

test("live QA hydration preserves a local discovery relation for the same stable QA", async (context) => {
  const dataDir = await discoveryFixture(context, {
    sourceRevision: "fixture-live-merge-current",
    records: [{ cardId: "92002", qaIds: ["81002"] }],
    prefix: "official-qa-discovery-live-merge-",
  });
  const card = {
    id: "92002",
    cardId: "92002",
    name: "匿名实时发现关系卡",
    aliases: ["匿名实时发现关系卡"],
    effectText: "这张卡离场时适用其记述的处理。",
  };
  const localQa = {
    id: "ygoresources-qa-81002",
    sourceId: "81002",
    recordType: "qa",
    title: "匿名实时超量素材处理问题",
    question: "「<<92001>>」适用中，超量怪兽离场时其素材如何处理？",
    answer: "按照该效果记述处理其素材。",
    text: "「<<92001>>」适用中，超量怪兽离场时其素材如何处理？\n按照该效果记述处理其素材。",
    sourceName: "YGOResources DB",
    status: "current",
  };
  const data = normalizeInjectedData({ cards: [card], records: [], qaRecords: [localQa] });
  await bindOfficialQaDiscoveryRelations({ dataDir, data });

  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith("/data/meta/mprop")) return new Response("[]", { status: 200 });
    if (value.endsWith("/data/card/92002")) {
      return new Response(JSON.stringify({
        cardData: { en: { id: 92002, cardType: "monster", properties: [] } },
        qaIndex: [81002],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.endsWith("/data/qa/81002")) {
      return new Response(JSON.stringify({
        cards: [92001],
        qaData: { ja: {
          id: 81002,
          title: "「<<92001>>」适用中，超量怪兽离场时其素材如何处理？",
          question: "「<<92001>>」适用中，超量怪兽离场时其素材如何处理？",
          answer: "按照该效果记述处理其素材。",
        } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected_url:${url}`);
  };

  const evidence = await retrieveRagEvidence({
    userQuery: "「匿名实时发现关系卡」适用中，超量怪兽离场时其素材如何处理？",
    cardResolution: {
      resolvedCards: [card],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
    env: {
      RAG_LIVE_OFFICIAL_QA: "true",
      YGORESOURCES_BASE_URL: "https://fixture.invalid",
    },
    fetchImpl,
  });

  const related = evidence.officialQaRelated.find((item) => item.id === localQa.id);
  assert.ok(related);
  assert.deepEqual(related.matchedDiscoveryCardIds, [card.id]);
  assert.ok(related.matchedBy.includes("related_discovery_card_id"));
  assert.equal(evidence.officialQaDirectCandidates.some((item) => item.id === localQa.id), false);
  assert.equal(related.matchLevel, "official_qa_near");
});

test("a discovery-only relation survives saturated ordinary pools as related-only", async (context) => {
  const card = {
    id: "98001",
    cardId: "98001",
    name: "匿名发现目标卡",
    aliases: ["匿名发现目标卡"],
    effectText: "这张卡适用中，超量素材按记述处理。",
  };
  const question = "「匿名发现目标卡」适用中，超量怪兽离场时其素材如何处理？";
  const distractors = Array.from({ length: 257 }, (_, index) => {
    const qaId = String(10_000 + index);
    return completeQaWithQuestion(
      qaId,
      `「<<${20_000 + index}>>」适用中，超量怪兽离场时其素材如何处理？`,
    );
  });
  const targetQa = completeQaWithQuestion(
    "99999",
    "「<<97001>>」适用中，超量怪兽离场时其素材如何处理？",
  );
  const data = normalizeInjectedData({
    cards: [card],
    records: [],
    qaRecords: [...distractors, targetQa],
  });
  const retrievalInput = {
    userQuery: question,
    cardResolution: {
      resolvedCards: [card],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
    enableLiveOfficialQa: false,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
  };

  const unbound = await retrieveRagEvidence(retrievalInput);
  assert.equal(unbound.officialQaDirectCandidates.some((item) => item.id === targetQa.id), false);
  assert.equal(unbound.officialQaRelated.some((item) => item.id === targetQa.id), false);

  const dataDir = await discoveryFixture(context, {
    sourceRevision: "fixture-saturated-current",
    records: [{ cardId: card.id, qaIds: ["99999"] }],
    prefix: "official-qa-discovery-saturated-",
  });
  await bindOfficialQaDiscoveryRelations({ dataDir, data });
  const bound = await retrieveRagEvidence(retrievalInput);
  const related = bound.officialQaRelated.find((item) => item.id === targetQa.id);

  assert.ok(related);
  assert.deepEqual(related.matchedDiscoveryCardIds, [card.id]);
  assert.ok(related.matchedBy.includes("related_discovery_card_id"));
  assert.equal(bound.officialQaDirectCandidates.some((item) => item.id === targetQa.id), false);
});

test("incomplete or stale discovery indexes bind no related identities", async (context) => {
  const cases = [
    { complete: false, discoveryRevision: "same", metadataRevision: "same" },
    { complete: true, discoveryRevision: "old", metadataRevision: "current" },
  ];
  for (const [index, fixture] of cases.entries()) {
    const dataDir = await discoveryFixture(context, {
      sourceRevision: fixture.discoveryRevision,
      metadataRevision: fixture.metadataRevision,
      complete: fixture.complete,
      records: [{ cardId: "93001", qaIds: ["82001"] }],
      prefix: `stale-${index}-`,
    });
    const data = normalizeInjectedData({
      cards: [],
      records: [],
      qaRecords: [completeQa("82001")],
    });
    const status = await bindOfficialQaDiscoveryRelations({ dataDir, data });
    assert.equal(status.available, false);
    assert.deepEqual(getOfficialQaDiscoveryCardIds(data.qaRecords[0]), []);
  }
});

test("missing, removed or incomplete QA bodies are reported and never bound", async (context) => {
  const dataDir = await discoveryFixture(context, {
    sourceRevision: "fixture-current",
    records: [{ cardId: "94001", qaIds: ["83001", "83002", "83003"] }],
  });
  const data = normalizeInjectedData({
    cards: [],
    records: [],
    qaRecords: [
      { ...completeQa("83001"), answer: "", text: "只有问题？" },
      { ...completeQa("83002"), status: "removed" },
    ],
  });
  const status = await bindOfficialQaDiscoveryRelations({ dataDir, data });

  assert.equal(status.available, true);
  assert.equal(status.reason, "qa_discovery_bodies_partially_unavailable");
  assert.equal(status.missingBodyCount, 3);
  assert.deepEqual(getOfficialQaDiscoveryCardIds(data.qaRecords[0]), []);
  assert.deepEqual(getOfficialQaDiscoveryCardIds(data.qaRecords[1]), []);
  assert.equal(getOfficialQaDiscoveryRelationStatus(data), status);
});

test("complete-looking stale or retired QA bodies never bind discovery relations", async (context) => {
  for (const fixture of [
    {
      label: "stale",
      qaDetailStaleIds: ["84001"],
      expectedReason: "qa_discovery_bodies_stale",
      expectedField: "staleBodyQaIds",
    },
    {
      label: "retired",
      retiredQaIds: ["84001"],
      expectedReason: "qa_discovery_bodies_retired",
      expectedField: "retiredBodyQaIds",
    },
  ]) {
    const dataDir = await discoveryFixture(context, {
      sourceRevision: `fixture-${fixture.label}`,
      records: [{ cardId: "96001", qaIds: ["84001"] }],
      prefix: `blocked-${fixture.label}-`,
      qaDetailStaleIds: fixture.qaDetailStaleIds,
      retiredQaIds: fixture.retiredQaIds,
    });
    const data = normalizeInjectedData({
      cards: [],
      records: [],
      qaRecords: [completeQa("84001")],
    });

    const status = await bindOfficialQaDiscoveryRelations({ dataDir, data });

    assert.equal(status.available, true);
    assert.equal(status.reason, fixture.expectedReason);
    assert.deepEqual(status[fixture.expectedField], ["84001"]);
    assert.deepEqual(getOfficialQaDiscoveryCardIds(data.qaRecords[0]), []);
  }
});

test("rebinding clears a previously current discovery relation when its body becomes stale", async (context) => {
  const data = normalizeInjectedData({
    cards: [],
    records: [],
    qaRecords: [completeQa("85001")],
  });
  const freshDir = await discoveryFixture(context, {
    sourceRevision: "fixture-rebind-fresh",
    records: [{ cardId: "97001", qaIds: ["85001"] }],
    prefix: "official-qa-discovery-rebind-fresh-",
  });
  const staleDir = await discoveryFixture(context, {
    sourceRevision: "fixture-rebind-stale",
    records: [{ cardId: "97001", qaIds: ["85001"] }],
    prefix: "official-qa-discovery-rebind-stale-",
    qaDetailStaleIds: ["85001"],
  });

  await bindOfficialQaDiscoveryRelations({ dataDir: freshDir, data });
  assert.deepEqual(getOfficialQaDiscoveryCardIds(data.qaRecords[0]), ["97001"]);
  const rebound = await bindOfficialQaDiscoveryRelations({ dataDir: staleDir, data });
  assert.equal(rebound.reason, "qa_discovery_bodies_stale");
  assert.deepEqual(getOfficialQaDiscoveryCardIds(data.qaRecords[0]), []);
});

test("malformed discovery counts and state arrays fail closed", async (context) => {
  const cases = [
    {
      label: "count",
      discoveryOverrides: { cardCount: 2 },
    },
    {
      label: "state-type",
      metadataOverrides: { qaDetailStaleIds: "86001" },
    },
    {
      label: "state-overlap",
      qaDetailStaleIds: ["86001"],
      retiredQaIds: ["86001"],
    },
  ];
  for (const fixture of cases) {
    const dataDir = await discoveryFixture(context, {
      sourceRevision: `fixture-invalid-${fixture.label}`,
      records: [{ cardId: "98002", qaIds: ["86001"] }],
      prefix: `official-qa-discovery-invalid-${fixture.label}-`,
      qaDetailStaleIds: fixture.qaDetailStaleIds,
      retiredQaIds: fixture.retiredQaIds,
      discoveryOverrides: fixture.discoveryOverrides,
      metadataOverrides: fixture.metadataOverrides,
    });
    const data = normalizeInjectedData({
      cards: [],
      records: [],
      qaRecords: [completeQa("86001")],
    });
    const status = await bindOfficialQaDiscoveryRelations({ dataDir, data });
    assert.equal(status.available, false, fixture.label);
    assert.deepEqual(getOfficialQaDiscoveryCardIds(data.qaRecords[0]), [], fixture.label);
  }
});

function completeQa(qaId) {
  return completeQaWithQuestion(qaId, "「<<95001>>」的效果如何处理？");
}

function completeQaWithQuestion(qaId, question) {
  return {
    id: `ygoresources-qa-${qaId}`,
    sourceId: qaId,
    recordType: "qa",
    title: "匿名完整官方问题",
    question,
    answer: "按照记述处理。",
    text: `${question}\n按照记述处理。`,
    sourceName: "YGOResources DB",
    status: "current",
  };
}

async function discoveryFixture(context, {
  sourceRevision,
  metadataRevision = sourceRevision,
  complete = true,
  records,
  prefix = "official-qa-discovery-",
  qaDetailStaleIds = [],
  retiredQaIds = [],
  discoveryOverrides = {},
  metadataOverrides = {},
}) {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const generatedAt = "2026-08-25T00:00:00.000Z";
  const qaCount = new Set(records.flatMap((item) => item.qaIds || []).map(String)).size;
  await Promise.all([
    writeFile(join(dataDir, "qa-discovery-index.json"), JSON.stringify({
      schemaVersion: 1,
      generatedAt,
      sourceRevision,
      complete,
      cardCount: records.length,
      qaCount,
      records,
      ...discoveryOverrides,
    }), "utf8"),
    writeFile(join(dataDir, "snapshot-meta.json"), JSON.stringify({
      schemaVersion: 1,
      generatedAt,
      sourceRevision: metadataRevision,
      qaDiscoveryComplete: true,
      qaDiscoveryCardCount: records.length,
      qaDiscoveryQaCount: qaCount,
      qaDetailStaleIds,
      retiredQaIds,
      ...metadataOverrides,
    }), "utf8"),
  ]);
  return dataDir;
}
