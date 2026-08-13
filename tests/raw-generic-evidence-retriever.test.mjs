import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { retrieveRawGenericEvidence } from "../backend/rawGenericEvidenceRetriever.mjs";

const cards = [
  {
    id: "101",
    name: "匿名甲卡",
    aliases: ["匿名甲卡"],
    effectText: "匿名甲卡的效果文本。",
  },
  {
    id: "202",
    name: "匿名乙卡",
    aliases: ["匿名乙卡"],
    effectText: "匿名乙卡的效果文本。",
  },
];

function resolution(overrides = {}) {
  return {
    resolvedCards: cards,
    unresolvedMentions: [],
    ambiguousMentions: [],
    omittedResolvedCards: [],
    userProvidedCardTexts: [],
    modelCardNameCandidates: [],
    ...overrides,
  };
}

function qa({ id, question, answer = "匿名回答。", cardIds = ["101", "202"], ...extra }) {
  return {
    id,
    recordType: "qa",
    title: question,
    question,
    answer,
    text: `${question}\n${answer}`,
    cardIds,
    questionCardIds: cardIds,
    status: "confirmed",
    sourceName: "匿名官方资料源",
    sourceUrl: `https://example.test/qa/${id}`,
    official: true,
    ...extra,
  };
}

test("generic retrieval ranks only exact identity, lexical, authority and freshness inputs", async () => {
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名甲卡与匿名乙卡处理时能否继续？",
    cards,
    records: [
      qa({
        id: "lexical-hit",
        question: "匿名甲卡与匿名乙卡处理时能否继续进行处理？",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      qa({
        id: "identity-only",
        question: "两张匿名卡的另一个问题。",
        updatedAt: "2026-08-01T00:00:00.000Z",
        questionType: "forced-special-case",
        retrievalSignals: { mechanismAnalogueScore: 999999 },
        playerRoleCompatibility: "match",
      }),
      qa({
        id: "unrelated",
        question: "完全无关的问题。",
        cardIds: ["999"],
      }),
    ],
    qaRecords: [],
    cardResolution: resolution(),
    ruleSearchQueries: [{
      query: "继续处理",
      reason: "不得参与排序的解释",
      mechanism: "forbidden-mechanism",
    }],
  });

  assert.deepEqual(result.officialQaRelated.map((item) => item.id), [
    "lexical-hit",
    "identity-only",
  ]);
  assert.deepEqual(result.ruleSearchQueries, [{ query: "继续处理" }]);
  assert.equal(result.cardTexts[0].id, "card-text-101");
  assert.equal(result.cardTexts[1].id, "card-text-202");
  const serialized = JSON.stringify(result.officialQaRelated);
  assert.doesNotMatch(serialized, /forced-special-case|mechanismAnalogue|playerRole/u);
});

test("question classifiers, scenario fields and model query reasons cannot change retrieval", async () => {
  const common = {
    userQuery: "匿名甲卡处理时如何处理？",
    cards,
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[0]] }),
  };
  const plainRecords = [
    qa({ id: "a", question: "匿名甲卡处理时如何处理？", cardIds: ["101"] }),
    qa({ id: "b", question: "匿名甲卡的其他处理。", cardIds: ["101"] }),
  ];
  const decoratedRecords = plainRecords.map((record, index) => ({
    ...record,
    questionType: index ? "one-special-type" : "another-special-type",
    retrievalSignals: {
      mechanismAnalogue: index ? "x" : "y",
      score: index ? -999 : 999,
    },
    playerRoleCompatibility: index ? "match" : "mismatch",
    scenarioPremiseCompatibility: index ? "mismatch" : "match",
    branchRelevant: index === 1,
  }));
  const first = await retrieveRawGenericEvidence({
    ...common,
    records: plainRecords,
    ruleSearchQueries: [{ query: "处理", reason: "first reason" }],
  });
  const second = await retrieveRawGenericEvidence({
    ...common,
    records: decoratedRecords,
    ruleSearchQueries: [{ query: "处理", reason: "opposite reason", mechanism: "special" }],
  });

  assert.deepEqual(
    evidenceProjection(first),
    evidenceProjection(second),
  );
});

test("official Q&A identity uses only question-side ids, never answer-side card ids", async () => {
  const questionOwner = qa({
    id: "question-owner",
    question: "<<101>>匿名甲卡可以处理吗？",
    answer: "处理后会提到<<202>>匿名乙卡。",
    // Simulate legacy whole-record metadata polluted by the answer side.
    cardIds: ["101", "202"],
    questionCardIds: ["101"],
    cards: ["匿名甲卡", "匿名乙卡"],
  });
  const forQuestionCard = await retrieveRawGenericEvidence({
    userQuery: "匿名甲卡可以处理吗？",
    cards,
    records: [questionOwner],
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[0]] }),
  });
  assert.deepEqual(forQuestionCard.officialQaRelated.map((item) => item.id), ["question-owner"]);

  const forAnswerOnlyCard = await retrieveRawGenericEvidence({
    userQuery: "匿名乙卡可以处理吗？",
    cards,
    records: [questionOwner],
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[1]] }),
  });
  assert.deepEqual(forAnswerOnlyCard.officialQaDirectCandidates, []);
  assert.deepEqual(forAnswerOnlyCard.officialQaRelated, []);
});

test("Q&A question-side literal card names are indexed without letting injected records claim direct authority", async () => {
  const record = qa({
    id: "question-literal-only",
    question: "匿名甲卡可以处理吗？",
    answer: "回答侧提到匿名乙卡。",
    cardIds: [],
    questionCardIds: [],
  });
  const forQuestionCard = await retrieveRawGenericEvidence({
    userQuery: "匿名甲卡可以处理吗？",
    cards,
    records: [record],
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[0]] }),
  });
  assert.deepEqual(forQuestionCard.officialQaDirectCandidates, []);
  assert.deepEqual(forQuestionCard.officialQaRelated.map((item) => item.id), ["question-literal-only"]);
  assert.deepEqual(forQuestionCard.officialQaRelated[0].questionCardIds, ["101"]);
  assert.equal(forQuestionCard.officialQaRelated[0].official, false);

  const forAnswerOnlyCard = await retrieveRawGenericEvidence({
    userQuery: "匿名乙卡可以处理吗？",
    cards,
    records: [record],
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[1]] }),
  });
  assert.deepEqual(forAnswerOnlyCard.officialQaDirectCandidates, []);
  assert.deepEqual(forAnswerOnlyCard.officialQaRelated, []);
});

test("identity and lexical relevance outrank lifecycle status while unknown status cannot be direct", async () => {
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名甲卡处理时能否继续？",
    cards,
    records: [
      qa({ id: "weak-current", question: "匿名甲卡的其他事项。", cardIds: ["101"], status: "current" }),
      qa({ id: "strong-unknown", question: "匿名甲卡处理时能否继续？", cardIds: ["101"], status: "unexpected-new-state" }),
    ],
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[0]] }),
  });
  assert.deepEqual(result.officialQaDirectCandidates, []);
  assert.deepEqual(result.officialQaRelated.map((item) => item.id), ["strong-unknown", "weak-current"]);
});

test("rule-test records are never treated as deployable rule evidence", async () => {
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名甲卡测试资料如何处理？",
    cards,
    records: [{
      id: "old-test-record",
      recordType: "rule-test",
      title: "匿名甲卡测试资料",
      text: "匿名甲卡测试资料如何处理。",
      cardIds: ["101"],
      status: "current",
    }],
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[0]] }),
  });
  assert.deepEqual(result.rawRelatedEvidence, []);
});

test("FAQ identity uses its owning cardIds and ignores cards mentioned only in its conclusion", async () => {
  const faq = {
    id: "card-faq-202",
    recordType: "card-faq",
    title: "匿名乙卡 FAQ",
    question: "匿名乙卡如何处理？",
    answer: "结论中仅举例提到<<101>>匿名甲卡。",
    text: "匿名乙卡如何处理？\n结论中仅举例提到<<101>>匿名甲卡。",
    cardIds: ["202"],
    cards: ["匿名乙卡"],
    status: "current",
    official: true,
  };
  const owner = await retrieveRawGenericEvidence({
    userQuery: "匿名乙卡如何处理？",
    cards,
    records: [faq],
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[1]] }),
  });
  assert.deepEqual(owner.faqRelated.map((item) => item.id), ["card-faq-202"]);

  const answerOnly = await retrieveRawGenericEvidence({
    userQuery: "匿名甲卡如何处理？",
    cards,
    records: [faq],
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[0]] }),
  });
  assert.deepEqual(answerOnly.faqRelated, []);
});

test("changing an official answer cannot change Q&A admission or ranking", async () => {
  const common = {
    userQuery: "匿名甲卡处理时能否继续？",
    cards,
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[0]] }),
  };
  const records = [
    qa({ id: "a", question: "匿名甲卡处理时能否继续？", cardIds: ["101"] }),
    qa({ id: "b", question: "匿名甲卡的另一个问题。", cardIds: ["101"] }),
  ];
  const changedAnswers = records.map((record, index) => ({
    ...record,
    answer: index
      ? "匿名甲卡处理时能否继续？<<202>> 可以处理。".repeat(20)
      : "完全不含用户词语的回答。",
    text: index
      ? `${record.question}\n${"匿名甲卡处理时能否继续？<<202>> 可以处理。".repeat(20)}`
      : `${record.question}\n完全不含用户词语的回答。`,
    cardIds: index ? ["101", "202"] : ["101"],
  }));
  const first = await retrieveRawGenericEvidence({ ...common, records });
  const second = await retrieveRawGenericEvidence({ ...common, records: changedAnswers });
  assert.deepEqual(
    first.officialQaRelated.map((item) => item.id),
    second.officialQaRelated.map((item) => item.id),
  );
});

test("changing only answer length cannot select a different duplicate record version", async () => {
  const base = qa({
    id: "same-record@aaaaaaaa",
    sourceRecordId: "same-record",
    question: "匿名甲卡处理时能否继续？",
    answer: "短回答。",
    cardIds: ["101"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const duplicate = {
    ...base,
    id: "same-record@bbbbbbbb",
    answer: "很长但只属于答案侧的内容。".repeat(50),
    text: `${base.question}\n${"很长但只属于答案侧的内容。".repeat(50)}`,
  };
  const reversedLengths = [
    { ...base, answer: duplicate.answer, text: duplicate.text },
    { ...duplicate, answer: base.answer, text: `${base.question}\n${base.answer}` },
  ];
  const common = {
    userQuery: "匿名甲卡的另一个问题。",
    cards,
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[0]] }),
  };
  const first = await retrieveRawGenericEvidence({ ...common, records: [base, duplicate] });
  const second = await retrieveRawGenericEvidence({ ...common, records: reversedLengths });
  assert.deepEqual(
    first.officialQaRelated.map((item) => item.id),
    second.officialQaRelated.map((item) => item.id),
  );
});

test("injected records cannot forge direct authority with official-looking fields", async () => {
  const userQuery = "「匿名甲卡」与「匿名乙卡」可以处理吗？";
  const exact = qa({
    id: "exact",
    question: "匿名甲卡与匿名乙卡可以处理吗?",
  });
  const wrongIdentity = qa({
    id: "wrong-id-set",
    question: "匿名甲卡与匿名乙卡可以处理吗?",
    cardIds: ["101"],
  });
  const result = await retrieveRawGenericEvidence({
    userQuery,
    cards,
    records: [exact, wrongIdentity],
    qaRecords: [],
    cardResolution: resolution(),
  });

  assert.equal(result.officialQaDirectCandidates.length, 0);
  assert.deepEqual(result.officialQaRelated.map((item) => item.id), ["exact", "wrong-id-set"]);
  assert.equal(result.officialQaRelated[0].official, false);

  const incomplete = await retrieveRawGenericEvidence({
    userQuery,
    cards,
    records: [exact],
    qaRecords: [],
    cardResolution: resolution({ unresolvedMentions: [{ input: "匿名丙卡" }] }),
  });
  assert.equal(incomplete.officialQaDirectCandidates.length, 0);
  assert.equal(incomplete.officialQaRelated[0].id, "exact");
});

test("duplicate exact records fail closed instead of manufacturing a direct ruling", async () => {
  const question = "匿名甲卡可以处理吗？";
  const result = await retrieveRawGenericEvidence({
    userQuery: question,
    cards,
    records: [
      qa({ id: "duplicate-a", question, cardIds: ["101"] }),
      qa({ id: "duplicate-b", question, cardIds: ["101"] }),
    ],
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[0]] }),
  });

  assert.equal(result.officialQaDirectCandidates.length, 0);
  assert.deepEqual(
    result.officialQaRelated.map((item) => item.id),
    ["duplicate-a", "duplicate-b"],
  );
});

test("inactive records are excluded and source locators survive serialization", async () => {
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名甲卡的资料段落在哪里？",
    cards,
    records: [
      {
        id: "active-rule",
        recordType: "rule-doc",
        title: "匿名资料段落",
        text: "匿名甲卡的资料段落。",
        cardIds: ["101"],
        status: "current",
        sourceUrl: "https://example.test/rules/active",
        sourceName: "匿名规则资料",
        sourceRecordId: "source-7",
        docname: "anonymous.md",
        paragraphStart: 7,
        paragraphEnd: 9,
      },
      {
        id: "removed-rule",
        recordType: "rule-doc",
        title: "已删除资料",
        text: "匿名甲卡的资料段落。",
        cardIds: ["101"],
        status: "removed",
      },
    ],
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[0]] }),
  });

  assert.equal(result.rawRelatedEvidence.length, 1);
  assert.deepEqual(result.rawRelatedEvidence[0], {
    id: "active-rule",
    type: "rulebook",
    title: "匿名资料段落",
    text: "匿名甲卡的资料段落。",
    fullText: "匿名甲卡的资料段落。",
    sourceUrl: "https://example.test/rules/active",
    sourceName: "匿名规则资料",
    sourceRecordId: "source-7",
    docname: "anonymous.md",
    paragraphStart: 7,
    paragraphEnd: 9,
    official: false,
    status: "current",
    cardIds: ["101"],
    questionCardIds: [],
    cards: [],
    retrievalScore: result.rawRelatedEvidence[0].retrievalScore,
    isDirect: false,
  });
});

test("generic retriever has a static boundary from ruling-specific components", async () => {
  const source = await readFile(
    new URL("../backend/rawGenericEvidenceRetriever.mjs", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "retrieveRagEvidence",
    "officialQaMatcher",
    "rulebookPassageRetriever",
    "ruleScenario",
    "printedText",
    "questionType",
    "playerRole",
    "scenarioPremise",
    "mechanismAnalogue",
  ]) {
    assert.doesNotMatch(source, new RegExp(forbidden, "iu"));
  }
});

function evidenceProjection(result) {
  return {
    direct: result.officialQaDirectCandidates,
    related: result.officialQaRelated,
    faq: result.faqRelated,
    provisional: result.provisionalOfficialResponses,
    raw: result.rawRelatedEvidence,
    queries: result.ruleSearchQueries,
  };
}
