import assert from "node:assert/strict";
import test from "node:test";

import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";

const SYNTHETIC_RULE_QUERY = {
  query: "同一时点有多个诱发效果要发动时，回合玩家的必发效果、对方的必发效果、已公开的选发效果按什么顺序组成连锁？",
  source: "synthetic-global-mechanism-growth-query",
};

const FULLY_QUALIFIED_CANDIDATE = {
  id: "synthetic-full-qualified-mechanism",
  recordType: "qa",
  status: "current",
  question: "同一时点存在多个必须发动的诱发效果与已公开的选发诱发效果时，回合玩家与对方应按怎样的先后顺序组成连锁？",
  answer: "按对应的同时处理顺序适用。",
};

const CORE_ONLY_NOISE = Array.from({ length: 320 }, (_, index) => ({
  id: `synthetic-core-noise-${String(index).padStart(3, "0")}`,
  recordType: "qa",
  status: "current",
  question: `同一时点有多个处理时，按什么顺序组成连锁？合成变体 ${index}。`,
  answer: "按适用的通用顺序处理。",
}));

function deterministicShuffle(items) {
  const shuffled = [...items];
  let state = 0x9e3779b9;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function selectedEvidenceSignature(evidence) {
  return {
    relatedIds: evidence.officialQaRelated.map((item) => item.id),
    relatedMechanisms: evidence.officialQaRelated.map(
      (item) => item.retrievalSignals?.mechanismAnalogues || [],
    ),
    directIds: evidence.officialQaDirectCandidates.map((item) => item.id),
  };
}

test("global mechanism recall is invariant under core-only corpus growth and QA shuffling", async () => {
  const corpus = [...CORE_ONLY_NOISE, FULLY_QUALIFIED_CANDIDATE];
  const run = (records) => retrieveRagEvidence({
    userQuery: "请检索这个完全合成的规则场景。",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records,
    qaRecords: [],
    ruleSearchQueries: [SYNTHETIC_RULE_QUERY],
    maxPerBucket: 1,
    enableLiveOfficialQa: false,
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "1",
      RAG_MAX_RULE_SEARCH_QUERIES: "16",
    },
  });

  const baseline = await run(corpus);
  const reversed = await run([...corpus].reverse());
  const shuffled = await run(deterministicShuffle(corpus));
  const expectedMechanism = baseline.ruleSearchQueries.find(
    (item) => item.source === SYNTHETIC_RULE_QUERY.source,
  )?.mechanism;

  assert.ok(expectedMechanism?.startsWith("semantic:"));
  for (const evidence of [baseline, reversed, shuffled]) {
    assert.deepEqual(
      evidence.officialQaRelated.map((item) => item.id),
      [FULLY_QUALIFIED_CANDIDATE.id],
    );
    assert.equal(evidence.officialQaDirectCandidates.length, 0);

    const retained = evidence.officialQaRelated[0];
    assert.equal(retained.isDirect, false);
    assert.ok(
      (retained.retrievalSignals?.mechanismAnalogues || []).includes(expectedMechanism),
    );
    assert.equal(retained.retrievalSignals?.mechanismQueryCoverage, 1);
  }

  assert.deepEqual(
    selectedEvidenceSignature(reversed),
    selectedEvidenceSignature(baseline),
  );
  assert.deepEqual(
    selectedEvidenceSignature(shuffled),
    selectedEvidenceSignature(baseline),
  );
});
