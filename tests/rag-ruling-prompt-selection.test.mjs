import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import { retrieveRulebookPassages } from "../backend/rulebookPassageRetriever.mjs";

const REFERENCE_BUCKETS = Object.freeze([
  "officialQaDirectCandidates",
  "officialQaRelated",
  "provisionalOfficialResponses",
  "faqRelated",
  "rawRelatedEvidence",
]);

function officialQa(id, retrievalScore, overrides = {}) {
  return {
    id,
    type: "related",
    recordType: "qa",
    official: true,
    source: "official-database-mirror",
    sourceAuthority: "official_database",
    title: `Official reference ${id}`,
    question: `Question ${id}`,
    answer: `Answer ${id}`,
    retrievalScore,
    isDirect: false,
    ...overrides,
  };
}

function officialFaq(id, retrievalScore, overrides = {}) {
  return {
    id,
    type: "related",
    recordType: "card-faq",
    official: true,
    source: "official-database-mirror",
    sourceAuthority: "official_database",
    title: `Official FAQ ${id}`,
    question: `FAQ question ${id}`,
    answer: `FAQ answer ${id}`,
    retrievalScore,
    isDirect: false,
    ...overrides,
  };
}

function communityRule(id, retrievalScore) {
  return {
    id,
    type: "rulebook",
    recordType: "rule-doc",
    official: false,
    source: "community-reference",
    sourceAuthority: "community_reference",
    title: `Rule reference ${id}`,
    text: `Rule text ${id}`,
    retrievalScore,
    isDirect: false,
  };
}

function provisionalOfficialResponse(id, retrievalScore, overrides = {}) {
  return {
    id,
    type: "provisional_official_response",
    recordType: "provisional-official-response",
    official: false,
    sourceAuthority: "other_reference",
    title: `Provisional official response ${id}`,
    text: `Provisional response text ${id}`,
    retrievalScore,
    isDirect: false,
    ...overrides,
  };
}

function emptyEvidence(overrides = {}) {
  return {
    officialQaDirectCandidates: [],
    officialQaRelated: [],
    provisionalOfficialResponses: [],
    faqRelated: [],
    cardTexts: [],
    userProvidedCardTexts: [],
    rawRelatedEvidence: [],
    ...overrides,
  };
}

function buildSelection(evidence, referenceLimit, env = {}) {
  return buildRagRulingPromptBundle({
    userQuery: "How does this anonymous interaction resolve?",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: emptyEvidence(evidence),
    env: {
      RAG_MAX_OFFICIAL_QA: "20",
      RAG_MAX_RELATED_EVIDENCE: "20",
      RAG_MAX_PROMPT_REFERENCE_ITEMS: String(referenceLimit),
      RAG_MAX_EVIDENCE_TEXT_CHARS: "2000",
      RAG_MAX_PROMPT_CHARS: "100000",
      ...env,
    },
  });
}

function selectedReferenceEntries(bundle) {
  return REFERENCE_BUCKETS.flatMap((bucket) => (
    (bundle.modelEvidence?.[bucket] || []).map((item) => ({ bucket, item }))
  ));
}

function selectedReferenceIds(bundle) {
  return selectedReferenceEntries(bundle)
    .map(({ item }) => String(item.id));
}

function reorderEvidence(evidence, reorder) {
  return Object.fromEntries(Object.entries(evidence).map(([bucket, items]) => [
    bucket,
    Array.isArray(items) ? reorder([...items]) : items,
  ]));
}

function fixedShuffle(items) {
  const result = [];
  let left = 0;
  let right = items.length - 1;
  while (left <= right) {
    if (right >= left) result.push(items[right--]);
    if (left <= right) result.push(items[left++]);
  }
  return result;
}

test("reference selection is invariant under original, reversed, and fixed-shuffled input order", () => {
  const evidence = emptyEvidence({
    officialQaRelated: [
      officialQa("qa-alpha", 0.98),
      officialQa("qa-beta", 0.87),
      officialQa("qa-gamma", 0.65),
      officialQa("qa-delta", 0.4),
    ],
    faqRelated: [
      officialFaq("faq-alpha", 0.82),
      officialFaq("faq-beta", 0.55),
      officialFaq("faq-gamma", 0.35),
      officialFaq("faq-delta", 0.15),
    ],
    rawRelatedEvidence: [
      communityRule("rule-alpha", 0.99),
      communityRule("rule-beta", 0.88),
      communityRule("rule-gamma", 0.77),
      communityRule("rule-delta", 0.66),
    ],
  });

  const baseline = selectedReferenceIds(buildSelection(evidence, 5));
  const reversed = selectedReferenceIds(buildSelection(
    reorderEvidence(evidence, (items) => items.reverse()),
    5,
  ));
  const shuffled = selectedReferenceIds(buildSelection(
    reorderEvidence(evidence, fixedShuffle),
    5,
  ));

  assert.deepEqual(reversed, baseline);
  assert.deepEqual(shuffled, baseline);
});

test("a target below the old per-bucket cutoff survives original, reversed, and fixed-shuffled order", () => {
  const distractors = Array.from({ length: 18 }, (_unused, index) => (
    officialQa(`low-candidate-${String(index).padStart(2, "0")}`, 0.2 - index * 0.005)
  ));
  const target = officialQa("late-high-candidate", 0.99, {
    question: "Uniquely relevant late official question",
    answer: "Uniquely relevant late official answer",
  });
  const evidence = emptyEvidence({ officialQaRelated: [...distractors, target] });
  const select = (value) => selectedReferenceIds(buildSelection(value, 1, {
    RAG_MAX_RELATED_EVIDENCE: "14",
  }));

  assert.deepEqual(select(evidence), [target.id]);
  assert.deepEqual(select(reorderEvidence(evidence, (items) => items.reverse())), [target.id]);
  assert.deepEqual(select(reorderEvidence(evidence, fixedShuffle)), [target.id]);
});

test("a highly relevant official QA is not displaced by low-relevance FAQs or rule material", () => {
  const target = officialQa("qa-high-relevance", 0.99, {
    question: "The uniquely relevant official question",
    answer: "The complete official answer",
  });
  const bundle = buildSelection({
    officialQaRelated: [target],
    faqRelated: Array.from({ length: 10 }, (_unused, index) => (
      officialFaq(`faq-low-${index}`, 0.08 - index * 0.005)
    )),
    rawRelatedEvidence: Array.from({ length: 10 }, (_unused, index) => (
      communityRule(`rule-low-${index}`, 0.09 - index * 0.005)
    )),
  }, 1);

  assert.deepEqual(selectedReferenceIds(bundle), [target.id]);
  assert.equal(bundle.modelEvidence.officialQaRelated[0]?.question, target.question);
  assert.equal(bundle.modelEvidence.officialQaRelated[0]?.answer, target.answer);
});

test("high-relevance provisional and rule evidence outrank low-relevance official QA", () => {
  const officialDistractors = Array.from({ length: 12 }, (_unused, index) => (
    officialQa(`official-low-${index}`, 0.2 - index * 0.005)
  ));
  const provisional = provisionalOfficialResponse("provisional-high", 0.96);
  const rule = communityRule("rule-high", 0.95);
  const bundle = buildSelection({
    officialQaRelated: officialDistractors,
    provisionalOfficialResponses: [provisional],
    rawRelatedEvidence: [rule],
  }, 2);

  assert.deepEqual(selectedReferenceIds(bundle), [provisional.id, rule.id]);
});

test("official authority wins an equal relevance tie", () => {
  const official = officialQa("official-equal", 0.8);
  const provisional = provisionalOfficialResponse("provisional-equal", 0.8);
  const rule = communityRule("rule-equal", 0.8);
  const bundle = buildSelection({
    officialQaRelated: [official],
    provisionalOfficialResponses: [provisional],
    rawRelatedEvidence: [rule],
  }, 1);

  assert.deepEqual(selectedReferenceIds(bundle), [official.id]);
});

test("rulebook passage scores share the reference selector relevance scale", () => {
  const [passage] = retrieveRulebookPassages({
    records: [{
      id: "anonymous-rule-source",
      recordType: "rule-doc",
      title: "正在发动的通常陷阱与返回手牌",
      text: "通常陷阱卡发动中的场合，该卡不能由返回手牌的处理返回。场上没有其他能处理的魔法或陷阱卡时，要求该处理的效果不能发动。",
    }],
    userQuery: "一张正在发动中的通常陷阱是唯一的魔法陷阱时，能否发动把场上魔法陷阱返回手牌的效果？",
    ruleSearchQueries: [{
      query: "正在发动 通常陷阱 返回手牌 | 発動中 通常罠カード 手札に戻す",
      confidence: "high",
      source: "model_rule_query",
    }],
  });

  assert.ok(passage);
  assert.equal(passage.retrievalScore, passage.score);
  assert.ok(passage.retrievalScore > 0.45);
  assert.equal(passage.sourceAuthority, "community_reference");
  assert.equal(passage.sourceTier, "S2_COMMUNITY_REFERENCE");
});

test("a discarded low-priority long candidate does not emit a truncation warning", () => {
  const retained = officialQa("retained-complete-reference", 0.99, {
    question: "Short complete question",
    answer: "Short complete answer",
  });
  const discarded = officialQa("discarded-long-reference", 0.01, {
    question: "Low-priority question",
    answer: `DISCARDED_HEAD ${"irrelevant long body ".repeat(300)} DISCARDED_TAIL`,
  });
  const bundle = buildSelection({
    officialQaRelated: [discarded, retained],
  }, 1, {
    RAG_MAX_EVIDENCE_TEXT_CHARS: "200",
  });

  assert.deepEqual(selectedReferenceIds(bundle), [retained.id]);
  assert.equal(bundle.warnings.some((warning) => warning.includes(discarded.id)), false);
  assert.equal(bundle.promptTruncated, false);
});

test("duplicate evidence identity keeps the projection with the complete body", () => {
  const sharedId = "shared-reference";
  const completeQuestion = "Complete official question with every premise and event node.";
  const completeScene = "Complete official detailed scene with all relevant state transitions.";
  const completeAnswer = "Complete official answer with the full ruling explanation.";
  const bundle = buildSelection({
    officialQaRelated: [officialQa(sharedId, 0.9, {
      question: "",
      answer: "",
      text: "short fragment",
    })],
    faqRelated: [officialFaq(sharedId, 0.9, {
      question: completeQuestion,
      rawDetailedQuestion: completeScene,
      answer: completeAnswer,
    })],
  }, 1);

  const selected = selectedReferenceEntries(bundle);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].bucket, "faqRelated");
  assert.equal(selected[0].item.question, completeQuestion);
  assert.equal(selected[0].item.detailedScene, completeScene);
  assert.equal(selected[0].item.answer, completeAnswer);
  assert.equal(Object.hasOwn(selected[0].item, "text"), false);
});

test("same-bucket duplicate identity prefers a long projected body over a tiny complete fragment in both orders", () => {
  const sharedId = "same-bucket-shared-reference";
  const short = officialQa(sharedId, 0.99, {
    question: "Q",
    answer: "A",
  });
  const completeAnswer = `LONGER_COMPLETE_ANSWER_HEAD ${"complete explanation ".repeat(300)} LONGER_COMPLETE_ANSWER_TAIL`;
  const complete = officialQa(sharedId, 0.8, {
    question: "Complete question with every premise",
    detailedScene: "Native detailed scene with the full event sequence",
    answer: completeAnswer,
  });

  for (const items of [[short, complete], [complete, short]]) {
    const selected = selectedReferenceEntries(buildSelection({
      officialQaRelated: items,
    }, 1));
    assert.equal(selected.length, 1);
    assert.match(selected[0].item.answer, /LONGER_COMPLETE_ANSWER_HEAD/u);
    assert.match(selected[0].item.answer, /LONGER_COMPLETE_ANSWER_TAIL/u);
    assert.ok(selected[0].item.answer.length > short.answer.length);
    assert.equal(selected[0].item.detailedScene, complete.detailedScene);
  }
});

test("mixed official QA keeps its structured question and complementary text body", () => {
  const completeText = [
    "Official answer: the operation can be performed.",
    "Supplement: the preceding result remains applied.",
  ].join("\n");
  const mixed = officialQa("mixed-question-text", 0.95, {
    question: "Can the operation be performed in the stated situation?",
    answer: "",
    text: completeText,
  });
  const selected = selectedReferenceEntries(buildSelection({
    officialQaRelated: [mixed],
  }, 1));

  assert.equal(selected.length, 1);
  assert.equal(selected[0].item.question, mixed.question);
  assert.equal(selected[0].item.text, completeText);
  assert.equal(Object.hasOwn(selected[0].item, "answer"), false);
});

test("native detailedScene is preserved as a structured official QA field", () => {
  const nativeScene = "Native detailed scene retained without requiring rawDetailedQuestion.";
  const selected = selectedReferenceEntries(buildSelection({
    officialQaRelated: [officialQa("native-detailed-scene", 0.95, {
      detailedScene: nativeScene,
    })],
  }, 1));

  assert.equal(selected.length, 1);
  assert.equal(selected[0].item.detailedScene, nativeScene);
});

test("short structured fields return unused budget to a long official answer", () => {
  const longAnswer = [
    "WEIGHTED_ANSWER_HEAD",
    "long answer body ".repeat(400),
    "WEIGHTED_ANSWER_TAIL",
  ].join("\n");
  const selected = selectedReferenceEntries(buildSelection({
    officialQaRelated: [officialQa("weighted-budget-reference", 0.95, {
      question: "Q?",
      answer: longAnswer,
    })],
  }, 1, {
    RAG_MAX_EVIDENCE_TEXT_CHARS: "2800",
  }));

  assert.equal(selected.length, 1);
  assert.ok(selected[0].item.answer.length >= 2750);
  assert.match(selected[0].item.answer, /WEIGHTED_ANSWER_HEAD/u);
  assert.match(selected[0].item.answer, /WEIGHTED_ANSWER_TAIL/u);
});

test("a text-only official QA is complete evidence and retains its full body", () => {
  const fullOfficialBody = [
    "Official question: an anonymous operation occurs.",
    "Official answer: the operation is handled exactly as described.",
    "Supplement: this sentence is part of the same current official record.",
  ].join("\n");
  const textOnly = officialQa("z-text-only-official", 0.9, {
    question: "",
    answer: "",
    text: fullOfficialBody,
  });
  const bundle = buildSelection({
    officialQaRelated: [textOnly],
    faqRelated: [officialFaq("a-short-structured-record", 0.9, {
      question: "Q",
      answer: "A",
    })],
  }, 1);

  const selected = selectedReferenceEntries(bundle);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].item.id, textOnly.id);
  assert.equal(selected[0].item.text, fullOfficialBody);
  assert.equal(bundle.warnings.some((warning) => warning.includes(textOnly.id)), false);
});

test("the unified selector contains no role slots, question-type branches, or fixture identifiers", () => {
  const source = readFileSync(new URL("../backend/ragRulingPrompt.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function selectCompactEvidenceEntries");
  const end = source.indexOf("function compactEvidenceEntryKey", start);
  assert.ok(start >= 0 && end > start, "selector implementation must remain directly auditable");
  const selector = source.slice(start, end);

  assert.doesNotMatch(selector, /reserve(?:First|CrossCard|Entry)|role\s*slot|角色槽/iu);
  assert.doesNotMatch(selector, /is(?:CrossCardOfficialMechanism|SameCardOfficialQa|RuleMaterial)Entry/u);
  assert.doesNotMatch(selector, /question[_ -]?type|题型/iu);
  assert.doesNotMatch(selector, /(?:ygoresources-qa|card-faq)-\d+|case-\d+|Q&A\s*ID/iu);
});
