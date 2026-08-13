import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildRawEvidenceRagPromptBundle } from "../backend/rawEvidenceRagPrompt.mjs";
import {
  canonicalizeExternalCardIdentity,
  resolveStableLocalIdentity,
  retrieveRawGenericEvidence,
} from "../backend/rawGenericEvidenceRetriever.mjs";

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

test("Q&A and FAQ answer-derived metadata never affects lexical retrieval", async () => {
  const answerOnlyToken = "匿名答案侧诱饵词";
  const questionSideToken = "匿名问题侧目标词";
  const result = await retrieveRawGenericEvidence({
    userQuery: `匿名甲卡的${questionSideToken}如何处理？`,
    cards,
    records: [
      qa({
        id: "anonymous-answer-keyword-qa",
        question: "完全无关的匿名问题？",
        cardIds: ["101"],
        title: questionSideToken,
        keywords: [answerOnlyToken],
        scenario: answerOnlyToken,
      }),
      qa({
        id: "anonymous-question-side-qa",
        question: `匿名甲卡的${questionSideToken}如何处理？`,
        cardIds: ["101"],
      }),
      {
        id: "card-faq-101-anonymous",
        recordType: "card-faq",
        title: questionSideToken,
        status: "confirmed",
        cardIds: ["101"],
        cards: ["匿名甲卡"],
        conclusion: "匿名 FAQ 结论。",
        keywords: [answerOnlyToken],
      },
    ],
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[0]] }),
    ruleSearchQueries: [],
    env: { RAG_MAX_OFFICIAL_QA: "1" },
    fetchImpl: async () => new Response(JSON.stringify({ result: [] }), { status: 200 }),
  });
  assert.equal(result.officialQaRelated.length, 1);
  assert.equal(result.officialQaRelated[0].id, "anonymous-question-side-qa");
  assert.equal(result.officialQaRelated.some((item) => item.id === "anonymous-answer-keyword-qa"), false);
});

test("fuzzy external identity needs a unique stable local identifier match", async () => {
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名模糊简称如何处理？",
    cards: [],
    records: [],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      unresolvedMentions: [{ input: "匿名模糊简称" }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ result: [{
      id: "91919191",
      cn_name: "匿名模糊简称扩展",
      desc: "匿名外部文本。",
    }] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.deepEqual(result.cardResolution.resolvedCards, []);
  assert.equal(result.cardResolution.ambiguousMentions[0].reason, "fuzzy_identity_not_corroborated_by_local_catalog");
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

test("derived FAQ title, conclusion and keywords cannot change owner-scoped ranking", async () => {
  const target = "匿名问题侧目标机制";
  const common = {
    userQuery: `匿名甲卡的${target}如何处理？`,
    cards,
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [cards[0]] }),
    env: { RAG_MAX_RELATED_EVIDENCE: "1" },
  };
  const plain = [
    {
      id: "card-faq-101-a",
      recordType: "card-faq",
      cardId: "101",
      cardName: "匿名甲卡",
      title: "普通标题甲",
      conclusion: "普通结论甲",
      status: "confirmed",
    },
    {
      id: "card-faq-101-b",
      recordType: "card-faq",
      cardId: "101",
      cardName: "匿名甲卡",
      title: "普通标题乙",
      conclusion: "普通结论乙",
      status: "confirmed",
    },
  ];
  const polluted = plain.map((record, index) => index === 1 ? {
    ...record,
    title: target,
    conclusion: target,
    keywords: [target],
  } : record);
  const first = await retrieveRawGenericEvidence({ ...common, records: plain });
  const second = await retrieveRawGenericEvidence({ ...common, records: polluted });
  assert.deepEqual(first.faqRelated.map((item) => item.id), second.faqRelated.map((item) => item.id));
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

test("long global rule documents expose the lexically matching later passage to evidence and prompt", async () => {
  const hiddenAnswerDecoy = "匿名目标窗口 后续动作";
  const relevantPassage = "匿名目标窗口的处理条件满足时，按照原始资料继续检查后续动作。";
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名目标窗口关闭后，后续动作如何处理？",
    cards: [],
    records: [
      {
        id: "global-long-source",
        recordType: "rule-doc",
        sourceId: "ocg-rule",
        title: "规则资料总览",
        text: [
          ...Array.from({ length: 220 }, (_, index) => (
            `前置章节${index}只介绍占位概念与基础术语。`
          )),
          "匿名目标窗口 ¶",
          relevantPassage,
          "本节相邻段落保留该处理所需的原始上下文。",
          "末尾是另一项无关资料。".repeat(8),
        ].join("\n\n"),
        // Compatibility-shaped answer fields are not part of a rule document's
        // source body and therefore must not influence ranking or selection.
        answer: hiddenAnswerDecoy,
        status: "current",
      },
      {
        id: "answer-only-decoy",
        recordType: "rule-doc",
        sourceId: "ocg-rule",
        title: "另一份资料",
        text: "这份资料正文与用户问题没有词法重叠。",
        answer: hiddenAnswerDecoy.repeat(20),
        status: "current",
      },
    ],
    qaRecords: [],
    cardResolution: resolution({ resolvedCards: [] }),
    ruleSearchQueries: [{ query: "匿名目标窗口 后续动作" }],
    env: {
      RAG_MAX_RELATED_EVIDENCE: "1",
      RAG_MAX_EVIDENCE_TEXT_CHARS: "150",
    },
  });

  assert.deepEqual(result.rawRelatedEvidence.map((item) => item.id), ["global-long-source"]);
  assert.equal(result.debug.candidateCounts.rawRelated, 1);
  const evidence = result.rawRelatedEvidence[0];
  assert.equal(evidence.text.length <= 150, true);
  assert.equal(evidence.fullText, evidence.text);
  assert.match(evidence.text, new RegExp(relevantPassage, "u"));
  assert.match(evidence.text, /相邻段落保留/u);
  assert.doesNotMatch(evidence.text, /前置章节/u);
  assert.doesNotMatch(JSON.stringify(result.rawRelatedEvidence), /answer-only-decoy/u);

  const prompt = buildRawEvidenceRagPromptBundle({
    userQuery: "匿名目标窗口关闭后，后续动作如何处理？",
    cardResolution: result.cardResolution,
    evidence: result,
    env: {
      RAG_MAX_RELATED_EVIDENCE: "1",
      RAG_MAX_EVIDENCE_TEXT_CHARS: "150",
      RAG_MAX_PROMPT_CHARS: "12000",
    },
  }).prompt;
  assert.match(prompt, new RegExp(relevantPassage, "u"));
  assert.doesNotMatch(prompt, /前置章节|answer-only-decoy/u);
});

test("an unresolved literal surface may be linked by one exact external primary identity", async () => {
  const externalCard = {
    id: "30303030",
    cn_name: "匿名外部正式卡",
    jp_name: "匿名外部正式卡JP",
    desc: "匿名外部卡片文本。",
  };
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名外部正式卡可以处理吗？",
    cards: [],
    records: [],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      unresolvedMentions: [{ input: "匿名外部正式卡" }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ result: [externalCard] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.deepEqual(result.cardResolution.unresolvedMentions, []);
  assert.deepEqual(result.cardResolution.ambiguousMentions, []);
  assert.equal(result.cardResolution.resolvedCards[0].id, "30303030");
  assert.equal(result.cardTexts[0].text, "匿名外部卡片文本。");
  assert.equal(result.baigeResolvedCards[0].externalIdentityResolution, "unique_exact_primary_name");
  assert.equal(result.debug.baigeSearchCount, 1);
});

test("an external identity canonicalizes to the local card and uses local card text", async () => {
  const canonical = {
    id: "40404",
    name: "匿名本地正式卡",
    aliases: ["匿名本地正式卡"],
    effectText: "同步卡库中的匿名卡片文本。",
    source: "local_snapshot",
  };
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名本地正式卡可以处理吗？",
    cards: [canonical],
    records: [],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      unresolvedMentions: [{ input: "匿名本地正式卡" }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ result: [{
      id: "40404040",
      cid: "40404",
      cn_name: "匿名本地正式卡",
      desc: "外部镜像中的旧文本。",
    }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(result.cardResolution.resolvedCards[0].source, "local_snapshot");
  assert.equal(result.cardResolution.resolvedCards[0].id, "40404");
  assert.equal(result.cardResolution.resolvedCards[0].passcode, "40404040");
  assert.equal(result.cardResolution.resolvedCards[0].canonicalLocalIdentity, true);
  assert.equal(result.cardTexts[0].text, "同步卡库中的匿名卡片文本。");
});

test("an unmatched external CID never falls back to an exact local name or unlocks local records", async () => {
  const canonical = {
    id: "45454",
    name: "匿名同名身份卡",
    aliases: ["匿名同名身份卡"],
    effectText: "不应越权使用的本地文本。",
    source: "local_snapshot",
  };
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名同名身份卡如何处理？",
    cards: [canonical],
    records: [{
      id: "card-faq-45454-anonymous",
      recordType: "card-faq",
      cardId: "45454",
      cardName: "匿名同名身份卡",
      title: "匿名本地 FAQ",
      conclusion: "不应被第三方身份解锁。",
      status: "confirmed",
    }, {
      id: "identity-scoped-note-45454-anonymous",
      recordType: "related-note",
      cardId: "45454",
      cardName: "匿名同名身份卡",
      question: "匿名同名身份卡如何处理？",
      answer: "任何本地身份限定资料都不能由未绑定的第三方名称解锁。",
      status: "confirmed",
    }],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      unresolvedMentions: [{ input: "匿名同名身份卡" }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ result: [{
      id: "45454545",
      cid: "99999",
      cn_name: "匿名同名身份卡",
      desc: "只允许作为非官方辅助的外部文本。",
    }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(result.cardResolution.resolvedCards[0].canonicalLocalIdentity, undefined);
  assert.equal(result.cardResolution.resolvedCards[0].id, "45454545");
  assert.equal(result.cardTexts[0].text, "只允许作为非官方辅助的外部文本。");
  assert.deepEqual(result.faqRelated, []);
  assert.deepEqual(result.officialQaRelated, []);
  assert.deepEqual(result.officialQaDirectCandidates, []);
  assert.deepEqual(result.rawRelatedEvidence, []);
});

test("an unmatched external passcode never falls back to an exact local name", async () => {
  const canonical = {
    id: "46464",
    passcode: "11112222",
    name: "匿名密码同名卡",
    aliases: ["匿名密码同名卡"],
    effectText: "不应使用的本地密码卡文本。",
    source: "local_snapshot",
  };
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名密码同名卡如何处理？",
    cards: [canonical],
    records: [],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      unresolvedMentions: [{ input: "匿名密码同名卡" }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ result: [{
      id: "33334444",
      cn_name: "匿名密码同名卡",
      desc: "外部密码身份文本。",
    }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(result.cardResolution.resolvedCards[0].canonicalLocalIdentity, undefined);
  assert.equal(result.cardTexts[0].text, "外部密码身份文本。");
});

test("duplicate local CIDs remain a conflict even when one local name matches", async () => {
  const localCards = [
    { id: "47474", name: "匿名重复身份卡", effectText: "本地甲文本。" },
    { id: "47474", name: "匿名另一身份卡", effectText: "本地乙文本。" },
  ];
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名重复身份卡如何处理？",
    cards: localCards,
    records: [],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      unresolvedMentions: [{ input: "匿名重复身份卡" }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ result: [{
      id: "47474747",
      cid: "47474",
      cn_name: "匿名重复身份卡",
      desc: "外部冲突身份文本。",
    }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(result.cardResolution.resolvedCards[0].canonicalLocalIdentity, undefined);
  assert.equal(result.cardTexts[0].text, "外部冲突身份文本。");
});

test("conservative name diagnostics preserve particles but never grant local corpus authority", () => {
  const different = resolveStableLocalIdentity({
    providerPrimaryNames: ["匿名卡"],
  }, [{ id: "56565", name: "匿名之卡" }]);
  assert.equal(different.status, "unmatched");
  assert.equal(different.namespace, "name");

  const exact = resolveStableLocalIdentity({
    providerPrimaryNames: ["匿名之卡"],
  }, [{ id: "56565", name: "匿名之卡" }]);
  assert.equal(exact.status, "matched");
  assert.equal(exact.namespace, "name");
  assert.equal(exact.card.id, "56565");

  const external = {
    name: "匿名之卡",
    providerPrimaryNames: ["匿名之卡"],
    resolutionSource: "baige_identity_lookup",
    effectText: "只可作为外部辅助的文本。",
  };
  const canonical = canonicalizeExternalCardIdentity(external, [{
    id: "56565",
    name: "匿名之卡",
    effectText: "不应被名称授权替换的本地文本。",
  }]);
  assert.strictEqual(canonical, external);
  assert.equal(canonical.canonicalLocalIdentity, undefined);
  assert.equal(canonical.effectText, "只可作为外部辅助的文本。");
});

test("a single external search result cannot erase a known local ambiguity", async () => {
  const localCards = [
    { id: "51515", name: "匿名歧义全名甲", effectText: "本地甲文本。" },
    { id: "52525", name: "匿名歧义全名乙", effectText: "本地乙文本。" },
  ];
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名歧义简称如何处理？",
    cards: localCards,
    records: [],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      ambiguousMentions: [{
        input: "匿名歧义简称",
        candidateCards: localCards.map((card) => ({ id: card.id, name: card.name })),
      }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ result: [{
      id: "51515151",
      cid: "99999",
      cn_name: "匿名歧义简称",
      desc: "第三方唯一结果并不能证明本地二选一。",
    }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.deepEqual(result.cardResolution.resolvedCards, []);
  assert.equal(result.cardResolution.ambiguousMentions.length, 1);
  assert.equal(result.cardResolution.ambiguousMentions[0].reason, "external_identity_does_not_resolve_local_ambiguity");
  assert.deepEqual(
    result.cardResolution.ambiguousMentions[0].candidateCards.slice(0, 2).map((card) => card.id),
    ["51515", "52525"],
  );
  assert.deepEqual(result.cardTexts, []);
});

test("an unresolved duplicate cannot erase the same surface's local ambiguity", async () => {
  const localCards = [
    { id: "57575", name: "匿名重复表面甲", effectText: "本地甲文本。" },
    { id: "58585", name: "匿名重复表面乙", effectText: "本地乙文本。" },
  ];
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名重复表面如何处理？",
    cards: localCards,
    records: [],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      unresolvedMentions: [{
        input: "匿名重复表面",
        reason: "another_extractor_could_not_resolve",
      }],
      ambiguousMentions: [{
        input: "匿名重复表面",
        candidateCards: localCards.map((card) => ({ id: card.id, name: card.name })),
      }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ result: [{
      id: "57575757",
      cid: "99998",
      cn_name: "匿名重复表面",
      desc: "第三方单一结果不得覆盖本地歧义。",
    }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.deepEqual(result.cardResolution.resolvedCards, []);
  assert.equal(result.cardResolution.ambiguousMentions.length, 1);
  assert.equal(result.cardResolution.ambiguousMentions[0].reason, "external_identity_does_not_resolve_local_ambiguity");
  assert.deepEqual(
    result.cardResolution.ambiguousMentions[0].candidateCards.slice(0, 2).map((card) => card.id),
    ["57575", "58585"],
  );
  assert.deepEqual(result.cardTexts, []);
  assert.deepEqual(result.faqRelated, []);
  assert.deepEqual(result.officialQaDirectCandidates, []);
});

test("a stable external CID may resolve exactly one candidate from a known local ambiguity", async () => {
  const localCards = [
    { id: "53535", name: "匿名歧义候选甲", effectText: "唯一 CID 对应的本地甲文本。" },
    { id: "54545", name: "匿名歧义候选乙", effectText: "本地乙文本。" },
  ];
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名稳定歧义简称如何处理？",
    cards: localCards,
    records: [{
      id: "card-faq-53535-anonymous",
      recordType: "card-faq",
      cardId: "53535",
      cardName: "匿名歧义候选甲",
      title: "匿名候选甲 FAQ",
      conclusion: "匿名 FAQ 内容。",
      status: "confirmed",
    }],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      ambiguousMentions: [{
        input: "匿名稳定歧义简称",
        candidateCards: localCards.map((card) => ({ id: card.id, name: card.name })),
      }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ result: [{
      id: "53535353",
      cid: "53535",
      cn_name: "匿名稳定歧义简称",
      desc: "外部文本。",
    }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(result.cardResolution.resolvedCards[0].id, "53535");
  assert.equal(result.cardResolution.resolvedCards[0].canonicalLocalIdentity, true);
  assert.deepEqual(result.cardResolution.ambiguousMentions, []);
  assert.equal(result.cardTexts[0].text, "唯一 CID 对应的本地甲文本。");
  assert.deepEqual(result.faqRelated.map((item) => item.id), ["card-faq-53535-anonymous"]);
});

test("a Baige passcode never aliases an unrelated local KONAMI CID", async () => {
  const localCard = {
    id: "414141",
    name: "匿名本地不同卡",
    aliases: ["匿名本地不同卡"],
    effectText: "不应被选中的本地文本。",
    source: "local_snapshot",
  };
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名外部另一卡可以处理吗？",
    cards: [localCard],
    records: [],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      unresolvedMentions: [{ input: "匿名外部另一卡" }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ result: [{
      // This is a Baige password, deliberately equal to the unrelated local CID.
      id: "414141",
      cn_name: "匿名外部另一卡",
      desc: "应当使用的外部文本。",
    }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(result.cardResolution.resolvedCards[0].name, "匿名外部另一卡");
  assert.equal(result.cardResolution.resolvedCards[0].canonicalLocalIdentity, undefined);
  assert.equal(result.cardTexts[0].text, "应当使用的外部文本。");
});

test("Baige cid has precedence over its passcode when binding the local corpus", async () => {
  const localByCid = {
    id: "43210",
    name: "匿名本地CID卡",
    aliases: ["匿名本地CID卡"],
    effectText: "CID 对应的同步卡片文本。",
    source: "local_snapshot",
  };
  const unrelatedPasscodeMatch = {
    id: "54321",
    passcode: "87654321",
    name: "匿名密码碰撞卡",
    aliases: ["匿名密码碰撞卡"],
    effectText: "不应通过密码覆盖 CID 绑定。",
    source: "local_snapshot",
  };
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名外部表面名如何处理？",
    cards: [localByCid, unrelatedPasscodeMatch],
    records: [],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      unresolvedMentions: [{ input: "匿名外部表面名" }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ result: [{
      id: "87654321",
      cid: "43210",
      cn_name: "匿名外部表面名",
      desc: "外部卡片文本。",
    }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(result.cardResolution.resolvedCards[0].id, "43210");
  assert.equal(result.cardResolution.resolvedCards[0].cardId, "43210");
  assert.equal(result.cardResolution.resolvedCards[0].name, "匿名本地CID卡");
  assert.equal(result.cardResolution.resolvedCards[0].passcode, "87654321");
  assert.equal(result.cardTexts[0].text, "CID 对应的同步卡片文本。");
});

test("failed external lookups do not consume the independent resolved-card slot", async () => {
  const requested = [];
  const result = await retrieveRawGenericEvidence({
    userQuery: "两个匿名提及如何处理？",
    cards: [],
    records: [],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      unresolvedMentions: [
        { input: "匿名无结果提及" },
        { input: "匿名后续正式卡" },
      ],
    }),
    env: {
      RAG_MAX_CARDS: "1",
      RAG_BAIGE_MAX_IDENTITY_SEARCHES: "2",
    },
    fetchImpl: async (url) => {
      const query = new URL(url).searchParams.get("search");
      requested.push(query);
      return new Response(JSON.stringify({ result: query === "匿名后续正式卡" ? [{
        id: "42424242",
        cn_name: "匿名后续正式卡",
        desc: "匿名后续卡片文本。",
      }] : [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  // One logical identity lookup may make several provider-level fallback
  // requests. Those fallbacks must not consume the independent identity slot:
  // the second literal mention is still queried and can resolve.
  assert.equal(requested[0], "匿名无结果提及");
  assert.equal(requested.includes("匿名后续正式卡"), true);
  assert.equal(result.debug.baigeSearchCount, 2);
  assert.equal(result.cardResolution.resolvedCards.length, 1);
  assert.equal(result.cardResolution.resolvedCards[0].name, "匿名后续正式卡");
  assert.equal(result.cardResolution.unresolvedMentions[0].input, "匿名无结果提及");
});

test("conflicting external identities remain ambiguous and can never unlock direct Q&A", async () => {
  const literalQuestion = "匿名简称可以处理吗？";
  const result = await retrieveRawGenericEvidence({
    userQuery: literalQuestion,
    cards: [],
    records: [qa({
      id: "untrusted-exact-question",
      question: literalQuestion,
      cardIds: ["50505050"],
    })],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      ambiguousMentions: [{
        input: "匿名简称",
        candidateCards: [{ id: "model-only", name: "模型猜测全名" }],
      }],
    }),
    env: {
      RAG_BAIGE_MIN_CONFIDENCE: "0.8",
      RAG_BAIGE_CONFIDENCE_MARGIN: "0.16",
    },
    fetchImpl: async () => new Response(JSON.stringify({ result: [
      { id: "50505050", cn_name: "匿名简称甲", desc: "匿名甲文本。" },
      { id: "60606060", cn_name: "匿名简称乙", desc: "匿名乙文本。" },
    ] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.deepEqual(result.cardResolution.resolvedCards, []);
  assert.equal(result.cardResolution.ambiguousMentions.length > 0, true);
  assert.deepEqual(result.cardTexts, []);
  assert.deepEqual(result.officialQaDirectCandidates, []);
  assert.deepEqual(result.baigeResolvedCards, []);
});

test("model proposed canonical expansions do not initiate or prove external identity", async () => {
  const requestedUrls = [];
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名用户表面文本如何处理？",
    cards: [],
    records: [],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [],
      unresolvedMentions: [{ input: "匿名用户表面文本" }],
      modelCardNameCandidates: [{
        originalText: "匿名用户表面文本",
        name: "模型提议的完整正式名",
        confidence: "high",
      }],
    }),
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  // The provider may retry lexical fallbacks derived from the literal user
  // surface. None may originate from the model-proposed canonical expansion.
  assert.equal(requestedUrls.length >= 1, true);
  assert.match(decodeURIComponent(requestedUrls[0]), /匿名用户表面文本/u);
  assert.equal(requestedUrls.every((url) => (
    !decodeURIComponent(url).includes("模型提议的完整正式名")
  )), true);
  assert.equal(result.debug.baigeSearchCount, 1);
  assert.deepEqual(result.cardResolution.resolvedCards, []);
  assert.equal(result.cardResolution.unresolvedMentions.length, 1);
});

test("a locally existing model expansion is still a hypothesis until the user surface verifies it", async () => {
  const modelGuess = {
    id: "707",
    name: "模型猜测全名",
    effectText: "模型所猜卡片的本地文本。",
    input: "匿名用户简称",
    matchedQuery: "匿名用户简称",
    resolutionSource: "model_surface",
    identityMatchKind: "model_exact_canonical",
  };
  const requested = [];
  const result = await retrieveRawGenericEvidence({
    userQuery: "匿名用户简称如何处理？",
    cards: [modelGuess],
    records: [],
    qaRecords: [],
    cardResolution: resolution({
      resolvedCards: [modelGuess],
      modelCardNameCandidates: [{
        originalText: "匿名用户简称",
        name: "模型猜测全名",
        confidence: "high",
      }],
    }),
    fetchImpl: async (url) => {
      requested.push(new URL(url).searchParams.get("search"));
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(requested.length >= 1, true);
  assert.equal(requested[0], "匿名用户简称");
  assert.equal(requested.every((query) => query !== "模型猜测全名"), true);
  assert.equal(result.debug.baigeSearchCount, 1);
  assert.deepEqual(result.cardResolution.resolvedCards, []);
  assert.equal(result.cardResolution.unresolvedMentions[0].input, "匿名用户简称");
  assert.deepEqual(result.cardTexts, []);
  assert.deepEqual(result.officialQaDirectCandidates, []);
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
