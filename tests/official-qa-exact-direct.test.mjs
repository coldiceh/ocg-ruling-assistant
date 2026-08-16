import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalizeOfficialQaExactQuestion,
  OfficialQaBodyUnavailableError,
  OfficialQaDataIntegrityError,
  normalizeOfficialQaExactText,
  retrieveExactOfficialQaDirect,
} from "../backend/officialQaExactDirect.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/official-qa-exact-retrieval.json", import.meta.url),
  "utf8",
));

const recordsById = new Map(fixture.records.map((record) => [record.sourceId, record]));
const neverFetch = async (url) => {
  throw new Error(`exact fixture unexpectedly fetched ${url}`);
};

for (const item of fixture.positiveCases) {
  test(`retrieval-only exact route: ${item.name}`, async () => {
    const result = await retrieveExactOfficialQaDirect({
      question: item.question,
      cards: fixture.cards,
      qaRecords: fixture.records,
      qaDiscovery: fixture.discovery,
      fetchImpl: neverFetch,
    });
    const expected = recordsById.get(item.qaId);

    assert.equal(result.status, "matched");
    assert.equal(result.route, "official_qa_exact_direct");
    assert.equal(result.qaId, item.qaId);
    assert.equal(result.modelCalls, 0);
    assert.equal(
      normalizeOfficialQaExactText(result.officialAnswerJapanese),
      normalizeOfficialQaExactText(materialize(expected.rawAnswer)),
    );
    assert.equal(
      normalizeOfficialQaExactText(result.officialQuestionJapanese),
      normalizeOfficialQaExactText(materialize(expected.rawDetailedQuestion)),
    );
  });
}

test("an unquoted rules word that is also a card name cannot pollute exact card identity", async () => {
  const item = fixture.positiveCases.find((entry) => entry.qaId === "10072");
  const result = await retrieveExactOfficialQaDirect({
    question: item.question,
    cards: [
      ...fixture.cards,
      { id: "5362", name: "無効", jaName: "無効", aliases: ["無効"] },
    ],
    qaRecords: fixture.records,
    qaDiscovery: fixture.discovery,
    fetchImpl: neverFetch,
  });

  assert.equal(result.route, "official_qa_exact_direct");
  assert.equal(result.qaId, "10072");
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(result.mentionedCardIds.sort(), ["4758", "4956"]);
});

test("HTML, Unicode width, punctuation and whitespace variants retain the same exact identity", async () => {
  const base = fixture.positiveCases.find((item) => item.qaId === "22804").question;
  const variant = `  ${base
    .replaceAll("「", "&quot;")
    .replaceAll("」", "&#34;")
    .replaceAll("？", "?")
    .replaceAll("、", "，")
    .replaceAll(" ", "　")}  `;
  const result = await retrieveExactOfficialQaDirect({
    question: variant,
    cards: fixture.cards,
    qaRecords: fixture.records,
    qaDiscovery: fixture.discovery,
    fetchImpl: neverFetch,
  });

  assert.equal(result.qaId, "22804");
  assert.equal(result.route, "official_qa_exact_direct");
});

test("same-card different official questions remain distinct", async () => {
  const other = recordsById.get("21546");
  const result = await retrieveExactOfficialQaDirect({
    question: materialize(other.rawDetailedQuestion),
    cards: fixture.cards,
    qaRecords: fixture.records,
    qaDiscovery: fixture.discovery,
    fetchImpl: neverFetch,
  });

  assert.equal(result.qaId, "21546");
  assert.notEqual(result.qaId, "21547");
  assert.equal(result.officialAnswerJapanese, materialize(other.rawAnswer));
});

test("a discovered Q&A whose body is missing locally is fetched only by its explicit candidate ID", async () => {
  const targetIds = new Set(["21546", "21547"]);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const qaId = String(url).match(/\/data\/qa\/(\d+)$/u)?.[1];
    if (!qaId || !targetIds.has(qaId)) throw new Error(`unexpected URL ${url}`);
    const record = recordsById.get(qaId);
    return jsonResponse({
      cards: [13469],
      qaData: { ja: {
        id: Number(qaId),
        title: record.title,
        question: record.rawDetailedQuestion,
        answer: record.rawAnswer,
      } },
    });
  };
  const item = fixture.positiveCases.find((entry) => entry.qaId === "21547");
  const result = await retrieveExactOfficialQaDirect({
    question: item.question,
    cards: fixture.cards,
    qaRecords: fixture.records.filter((record) => !targetIds.has(record.sourceId)),
    qaDiscovery: fixture.discovery,
    fetchImpl,
  });

  assert.equal(result.qaId, "21547");
  assert.deepEqual(
    calls.map((url) => url.match(/\/data\/qa\/(\d+)$/u)?.[1]).sort(),
    ["21546", "21547"],
  );
  assert.equal(result.officialAnswerJapanese, materialize(recordsById.get("21547").rawAnswer));
});

test("a newly updated multi-card Q&A body is fetched by the unique discovery intersection", async () => {
  const target = recordsById.get("22804");
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (!String(url).endsWith("/data/qa/22804")) throw new Error(`unexpected URL ${url}`);
    return jsonResponse({
      cards: [10006, 11257, 14741],
      qaData: { ja: {
        id: 22804,
        title: target.title,
        question: target.rawDetailedQuestion,
        answer: target.rawAnswer,
      } },
    });
  };
  const item = fixture.positiveCases.find((entry) => entry.qaId === "22804");
  const result = await retrieveExactOfficialQaDirect({
    question: item.question,
    cards: fixture.cards,
    qaRecords: fixture.records.filter((record) => record.sourceId !== "22804"),
    qaDiscovery: fixture.discovery,
    fetchImpl,
  });

  assert.equal(result.qaId, "22804");
  assert.deepEqual(calls, ["https://db.ygoresources.com/data/qa/22804"]);
  assert.equal(result.officialQuestionJapanese, materialize(target.rawDetailedQuestion));
  assert.equal(result.officialAnswerJapanese, materialize(target.rawAnswer));
});

test("a unique discovered Q&A with an unavailable body fails closed before every model stage", async () => {
  const item = fixture.positiveCases.find((entry) => entry.qaId === "22804");
  const questionHash = canonicalizeOfficialQaExactQuestion(item.question, fixture.cards).hash;
  let modelCalls = 0;
  const rejectModelCall = async () => {
    modelCalls += 1;
    throw new Error("body-unavailable exact route must not invoke a model");
  };

  await assert.rejects(
    answerRagRulingQuestion({
      question: item.question,
      cards: fixture.cards,
      records: [],
      qaRecords: fixture.records.filter((record) => record.sourceId !== "22804"),
      officialQaDiscovery: {
        ...fixture.discovery,
        exactQuestionIdentities: [{ qaId: "22804", questionHash }],
      },
      fetchImpl: async () => {
        throw new Error("fixture body unavailable");
      },
      modelInvoker: rejectModelCall,
      cardModelInvoker: rejectModelCall,
      ruleModelInvoker: rejectModelCall,
    }),
    (error) => error instanceof OfficialQaBodyUnavailableError
      && error.code === "OFFICIAL_QA_BODY_UNAVAILABLE"
      && error.statusCode === 503
      && error.details.qaId === "22804"
      && error.details.sourceRevision === "fixture-current"
      && /^[a-f0-9]{64}$/u.test(error.details.questionHash)
      && error.details.failureReason === "official_qa_body_fetch_failed",
  );
  assert.equal(modelCalls, 0);
});

test("one card-intersection candidate without a question hash is not treated as an exact identity", async () => {
  const result = await retrieveExactOfficialQaDirect({
    question: "「エルシャドール・ミドラーシュ」や「ヴェルズ・オピオン」が存在する別の状況について教えてください。",
    cards: fixture.cards,
    qaRecords: fixture.records.filter((record) => record.sourceId !== "22804"),
    qaDiscovery: fixture.discovery,
    fetchImpl: async () => {
      throw new Error("fixture body unavailable");
    },
  });

  assert.equal(result.status, "not_matched");
  assert.equal(result.reason, "exact_candidate_pool_incomplete");
});

test("a legacy compact snapshot can recover its complete question and answer without a model", async () => {
  const current = recordsById.get("12336");
  const compactTitle = current.title;
  const compact = {
    id: current.id,
    sourceId: current.sourceId,
    recordType: "qa",
    status: "current",
    title: compactTitle,
    text: `${current.rawDetailedQuestion}\n${compactTitle} ${current.rawAnswer}`,
  };
  const item = fixture.positiveCases.find((entry) => entry.qaId === "12336");
  const result = await retrieveExactOfficialQaDirect({
    question: item.question,
    cards: fixture.cards,
    qaRecords: [compact],
    candidatePoolComplete: true,
    fetchImpl: null,
  });

  assert.equal(result.qaId, "12336");
  assert.equal(result.officialQuestionJapanese, materialize(current.rawDetailedQuestion));
  assert.equal(result.officialAnswerJapanese, materialize(current.rawAnswer));
});

test("an extra decisive condition cannot inherit the shorter official question's direct route", async () => {
  const exact = fixture.positiveCases.find((item) => item.qaId === "21547").question;
  const result = await retrieveExactOfficialQaDirect({
    question: `${exact}\nさらに「停戦協定」が適用されている場合はどうなりますか？`,
    cards: fixture.cards,
    qaRecords: fixture.records,
    qaDiscovery: fixture.discovery,
    fetchImpl: neverFetch,
  });

  assert.equal(result.status, "not_matched");
  assert.equal(result.route, "ordinary_rag");
});

test("superseded records never certify an exact route", async () => {
  const current = recordsById.get("10072");
  const result = await retrieveExactOfficialQaDirect({
    question: materialize(current.rawDetailedQuestion),
    cards: fixture.cards,
    qaRecords: [{ ...current, status: "superseded" }],
    candidatePoolComplete: true,
    fetchImpl: null,
  });

  assert.equal(result.status, "not_matched");
  assert.notEqual(result.route, "official_qa_exact_direct");
});

test("an incomplete candidate pool never certifies an exact route", async () => {
  const current = recordsById.get("10072");
  const result = await retrieveExactOfficialQaDirect({
    question: materialize(current.rawDetailedQuestion),
    cards: fixture.cards,
    qaRecords: [current],
    qaDiscovery: { ...fixture.discovery, complete: false },
    fetchImpl: null,
  });

  assert.equal(result.status, "not_matched");
  assert.equal(result.reason, "exact_candidate_pool_not_certified");
});

test("an ambiguous card alias never certifies an exact route", async () => {
  const current = recordsById.get("10072");
  const ambiguousCards = [
    ...fixture.cards,
    { id: "999999", jaName: "停戦協定", aliases: ["停戦協定"] },
  ];
  const result = await retrieveExactOfficialQaDirect({
    question: materialize(current.rawDetailedQuestion),
    cards: ambiguousCards,
    qaRecords: [current],
    candidatePoolComplete: true,
    fetchImpl: null,
  });

  assert.equal(result.status, "not_matched");
  assert.equal(result.reason, "card_identity_not_unique");
});

test("incompatible current answers for one exact identity raise DATA_INTEGRITY_ERROR", async () => {
  const current = recordsById.get("10072");
  await assert.rejects(
    retrieveExactOfficialQaDirect({
      question: materialize(current.rawDetailedQuestion),
      cards: fixture.cards,
      qaRecords: [current, { ...current, id: "duplicate-current", rawAnswer: "互換性のない回答です。" }],
      candidatePoolComplete: true,
      fetchImpl: null,
    }),
    (error) => error instanceof OfficialQaDataIntegrityError
      && error.code === "DATA_INTEGRITY_ERROR",
  );
});

test("two current Q&A IDs with the same question and incompatible answers raise DATA_INTEGRITY_ERROR", async () => {
  const current = recordsById.get("10072");
  const conflict = {
    ...current,
    id: "ygoresources-qa-99998",
    sourceId: "99998",
    rawAnswer: "互換性のない別回答です。",
  };
  await assert.rejects(
    retrieveExactOfficialQaDirect({
      question: materialize(current.rawDetailedQuestion),
      cards: fixture.cards,
      qaRecords: [current, conflict],
      candidatePoolComplete: true,
      fetchImpl: null,
    }),
    (error) => error instanceof OfficialQaDataIntegrityError
      && error.code === "DATA_INTEGRITY_ERROR",
  );
});

test("pipeline exact hit bypasses card extraction, rule query, validator and final model", async () => {
  const item = fixture.positiveCases.find((entry) => entry.qaId === "10072");
  let modelCalls = 0;
  const rejectModelCall = async () => {
    modelCalls += 1;
    throw new Error("model must not be called for exact official Q&A");
  };
  const answer = await answerRagRulingQuestion({
    question: item.question,
    cards: fixture.cards,
    records: [],
    qaRecords: fixture.records,
    officialQaDiscovery: fixture.discovery,
    fetchImpl: neverFetch,
    modelInvoker: rejectModelCall,
    cardModelInvoker: rejectModelCall,
    ruleModelInvoker: rejectModelCall,
  });

  assert.equal(modelCalls, 0);
  assert.equal(answer.debug.route, "official_qa_exact_direct");
  assert.equal(answer.debug.modelCalls, 0);
  assert.equal(answer.debug.providerUsed, "none");
  assert.equal(answer.debug.modelUsed, "none");
  assert.equal(answer.officialQaId, "10072");
  assert.equal(answer.shortAnswer, answer.officialAnswerJapanese);
  assert.deepEqual(answer.debug.tokenUsage, {});
  assert.equal(answer.debug.estimatedCostUsd, 0);
});

test("exact-only pipeline miss returns without invoking any model", async () => {
  let modelCalls = 0;
  const rejectModelCall = async () => {
    modelCalls += 1;
    throw new Error("exact-only miss must not enter the ordinary pipeline");
  };
  const answer = await answerRagRulingQuestion({
    question: "「停戦協定」の似ているが公式原文ではない質問ですか？",
    cards: fixture.cards,
    records: [],
    qaRecords: fixture.records,
    officialQaDiscovery: fixture.discovery,
    officialQaExactOnly: true,
    fetchImpl: neverFetch,
    modelInvoker: rejectModelCall,
    cardModelInvoker: rejectModelCall,
    ruleModelInvoker: rejectModelCall,
  });

  assert.equal(answer, null);
  assert.equal(modelCalls, 0);
});

function materialize(value) {
  const names = new Map(fixture.cards.map((card) => [card.id, card.jaName]));
  return String(value || "").replace(/<<\s*(\d{1,10})\s*>>/gu, (match, id) => names.get(id) || match);
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
