import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { searchOfficialQaEvidence } from "../backend/officialQaMatcher.mjs";
import {
  evidenceBucketsToList,
  loadRagData,
  normalizeInjectedData,
  retrieveRagEvidence,
} from "../backend/ragEvidenceRetriever.mjs";

test("concurrent cold loads share one normalized data object", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-single-flight-"));
  try {
    await Promise.all([
      writeJson(join(dataDir, "cards.json"), { records: [{ id: "1", name: "并发测试卡" }] }),
      writeJson(join(dataDir, "rulings.json"), { records: [] }),
      writeJson(join(dataDir, "qa-index.json"), { records: [] }),
      writeJson(join(dataDir, "evidence-index.json"), { records: [] }),
      writeJson(join(dataDir, "ocg-rule-corpus.json"), { records: [] }),
      writeJson(join(dataDir, "official-responses.json"), { records: [] }),
    ]);

    const [first, second, third] = await Promise.all([
      loadRagData(dataDir),
      loadRagData(dataDir),
      loadRagData(dataDir),
    ]);
    assert.strictEqual(second, first);
    assert.strictEqual(third, first);
    assert.strictEqual(second.cards, first.cards);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("normalized RAG data is canonical for the same source arrays and its normalized output", () => {
  const cards = [{ id: 1, name: "测试卡", effectText: "①：可以发动。" }];
  const records = [{ id: "rule-1", title: "测试规则", text: "测试规则正文。" }];
  const qaRecords = [{ id: "qa-1", recordType: "qa", question: "可以发动吗？", answer: "可以。" }];

  const first = normalizeInjectedData({ cards, records, qaRecords });
  const second = normalizeInjectedData({ cards, records, qaRecords });
  const alreadyNormalized = normalizeInjectedData(first);

  assert.strictEqual(second, first);
  assert.strictEqual(alreadyNormalized, first);
  assert.strictEqual(alreadyNormalized.records, first.records);
});

test("evidence bucket flattening is cached by evidence object identity", () => {
  const evidence = {
    cardTexts: [{ id: "card-text-1", text: "卡文" }],
    officialQaRelated: [{ id: "qa-1", text: "问答" }],
  };
  assert.strictEqual(evidenceBucketsToList(evidence), evidenceBucketsToList(evidence));
});

test("official Q&A record features are reused across searches", () => {
  let textReads = 0;
  const record = {
    id: "qa-cache-1",
    recordType: "qa",
    question: "这张测试卡可以发动吗？",
    answer: "可以发动。",
    cardIds: ["1"],
    cards: ["测试卡"],
    get text() {
      textReads += 1;
      return "这张测试卡可以发动吗？\n可以发动。";
    },
  };

  const input = { question: "这张测试卡可以发动吗？", records: [record], resolvedCards: [{ id: "1", name: "测试卡" }] };
  assert.equal(searchOfficialQaEvidence(input).exact.length, 1);
  const readsAfterFirstSearch = textReads;
  assert.equal(searchOfficialQaEvidence(input).exact.length, 1);
  assert.equal(textReads, readsAfterFirstSearch);
});

test("local card id and text do not require a Baige request only to fill sourceUrl", async () => {
  let fetchCalls = 0;
  const card = { id: "12345678", cardId: "12345678", name: "本地完整测试卡", effectText: "①：这张卡可以发动。" };
  const evidence = await retrieveRagEvidence({
    userQuery: "本地完整测试卡的①效果可以发动吗？",
    cardResolution: { resolvedCards: [card], unresolvedMentions: [], userProvidedCardTexts: [] },
    cards: [card],
    records: [],
    qaRecords: [],
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("network should not be used");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(evidence.debug.baigeSearchCount, 0);
  assert.match(evidence.cardTexts[0].text, /可以发动/u);
});

test("a rich official QA duplicated in records and qaRecords is canonicalized once outside raw related evidence", async () => {
  const card = {
    id: "71001",
    name: "合成法术机",
    effectText: "①：满足条件时可以发动。",
  };
  const richRecord = {
    id: "qa-synthetic-duplicate",
    stableId: "qa-synthetic-duplicate",
    recordType: "qa",
    question: "「合成法术机」的效果可以发动吗？",
    rawDetailedQuestion: "「合成法术机」的效果可以发动吗？",
    answer: "RICH_RECORD_MARKER：可以发动。",
    cardIds: [card.id],
    questionCardIds: [card.id],
  };
  const compactRecord = {
    ...richRecord,
    rawDetailedQuestion: "",
    answer: "COMPACT_RECORD_MARKER：可以发动。",
  };

  const evidence = await retrieveRagEvidence({
    userQuery: richRecord.question,
    cardResolution: {
      resolvedCards: [card],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [card],
    records: [richRecord],
    qaRecords: [compactRecord],
  });

  assert.equal(evidence.debug.scopedRecordCounts.officialQa, 1);
  assert.equal(evidence.debug.scopedRecordCounts.rawRelated, 0);
  assert.equal(evidence.officialQaDirectCandidates[0]?.id, richRecord.id);
  assert.match(evidence.officialQaDirectCandidates[0]?.fullText || "", /RICH_RECORD_MARKER/u);
  assert.doesNotMatch(evidence.officialQaDirectCandidates[0]?.fullText || "", /COMPACT_RECORD_MARKER/u);
  assert.ok(evidence.rawRelatedEvidence.every((item) => item.id !== richRecord.id));
});

test("rawDetailedQuestion card ids expose and filter an incidental multi-card QA example", async () => {
  const cards = [
    { id: "72001", name: "合成触发甲", effectText: "满足条件时处理。" },
    { id: "72002", name: "合成触发乙", effectText: "满足条件时处理。" },
  ];
  const record = {
    id: "qa-synthetic-incidental-multi-card",
    recordType: "qa",
    title: "多个对象同时出现时的排列",
    question: "多个对象同时出现时怎样排列？",
    rawDetailedQuestion: "「<<72001>>」「<<72991>>」「<<72992>>」同时出现时，它们怎样排列？",
    answer: "按照该合成场景所写的顺序处理。",
    cardIds: ["72001", "72991", "72992"],
  };
  const normalized = normalizeInjectedData({ cards, records: [], qaRecords: [record] });

  assert.deepEqual(normalized.qaRecords[0].questionCardIds, ["72001", "72991", "72992"]);

  const matches = searchOfficialQaEvidence({
    question: "「合成触发甲」「合成触发乙」同时出现时，它们怎样排列？",
    records: normalized.qaRecords,
    resolvedCards: cards,
  });
  const candidate = matches.all.find((item) => item.id === record.id);
  assert.ok(candidate);
  assert.ok(candidate.score >= 0.68);
  assert.deepEqual(candidate.matchedQuestionCardIds, ["72001"]);
  assert.equal(candidate.questionCardIdCount, 3);

  const evidence = await retrieveRagEvidence({
    userQuery: "「合成触发甲」「合成触发乙」同时出现时，它们怎样排列？",
    cardResolution: {
      resolvedCards: cards,
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards,
    records: [],
    qaRecords: [record],
  });

  assert.ok(evidence.officialQaDirectCandidates.every((item) => item.id !== record.id));
  assert.ok(evidence.officialQaRelated.every((item) => item.id !== record.id));
  assert.ok(evidence.rawRelatedEvidence.every((item) => item.id !== record.id));
});

test("card FAQs cannot consume the official QA matcher top-N budget", async () => {
  const card = {
    id: "73001",
    name: "合成边界兽",
    effectText: "①：满足条件时可以发动。",
  };
  const question = "「合成边界兽」的效果可以发动吗？";
  const qaRecord = {
    id: "qa-synthetic-top-n",
    recordType: "qa",
    question,
    answer: "QA_TOP_N_MARKER：可以发动。",
    cardIds: [card.id],
    questionCardIds: [card.id],
  };
  const faqRecords = Array.from({ length: 30 }, (_unused, index) => ({
    id: `card-faq-synthetic-${index}`,
    recordType: "card-faq",
    title: question,
    question,
    answer: `FAQ_MARKER_${index}`,
    cardIds: [card.id],
    questionCardIds: [card.id],
  }));

  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution: {
      resolvedCards: [card],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [card],
    records: [],
    qaRecords: [...faqRecords, qaRecord],
    maxPerBucket: 1,
  });

  assert.equal(evidence.debug.scopedRecordCounts.officialQa, 1);
  assert.equal(evidence.debug.scopedRecordCounts.qa, 1);
  assert.equal(evidence.debug.scopedRecordCounts.faq, faqRecords.length);
  assert.equal(evidence.officialQaDirectCandidates[0]?.id, qaRecord.id);
  assert.match(evidence.officialQaDirectCandidates[0]?.fullText || "", /QA_TOP_N_MARKER/u);
  assert.equal(evidence.faqRelated.length, 1);
  assert.ok(evidence.faqRelated.every((item) => item.recordType === "card-faq"));
});

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}
