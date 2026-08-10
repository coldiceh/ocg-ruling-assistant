import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCardText } from "../backend/cardTextNormalizer.mjs";
import {
  analyzeDeterministicOperationLegality,
  OPERATION_PREMISE_SCHEMA_VERSION,
} from "../backend/operationLegalityAnalyzer.mjs";
import {
  analyzePrintedTextReferenceScenario,
  extractPrintedReferenceRequirement,
} from "../backend/printedTextReferences.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import { retrieveRulebookPassages } from "../backend/rulebookPassageRetriever.mjs";

const copyMonster = {
  id: "copy-monster",
  title: "复制怪兽",
  cards: ["复制怪兽"],
  cardType: "monster",
  text: "①：以场上・墓地的1只怪兽为对象可以发动。此卡直至结束阶段为止，获得与该怪兽原本卡名・效果相同的卡名・效果。",
};
const copiedSource = {
  id: "copied-source",
  title: "被复制怪兽",
  cards: ["被复制怪兽"],
  cardType: "monster",
  text: "①：自己场上存在“目标场地”的情况下可以发动。然后，从牌组将记载有“目标场地”卡名的1只怪兽特殊召唤。",
};
const activationCard = {
  id: "activation-spell",
  title: "发动卡",
  cards: ["发动卡"],
  cardType: "spell",
  text: "①：自己场上存在“目标场地”及记载有该卡名的怪兽的情况下可以发动。",
};
const question = "「复制怪兽」复制「被复制怪兽」的卡名和效果后，是不是有「目标场地」卡名记述的怪兽，自己能不能发动「发动卡」？";
const ruleText = [
  "有「○○」卡名记述",
  "这类文本指的是，效果文本栏中记述作为卡名存在的「○○」。",
  "即使是不作为效果处理的文本记述了「○○」卡名，也满足条件。",
  "但记述的如果不是卡名而是字段，不满足条件。",
].join("\n\n");
const rule = {
  id: "ocg-rule:c02/基本用语#printed-reference",
  recordType: "rule-doc",
  sourceId: "ocg-rule",
  title: "基本用语",
  text: ruleText,
};

test("card text IR keeps immutable printed name references", () => {
  const normalized = normalizeCardText({
    id: "source",
    cardType: "monster",
    effectText: copiedSource.text,
  });
  assert.deepEqual(normalized.printedNameReferences, ["目标场地"]);
  assert.equal(normalized.version, "1.4");
});

test("copied effects do not become the receiver's printed name references", () => {
  const scenario = analyzePrintedTextReferenceScenario({
    userQuery: question,
    cardTexts: [copyMonster, copiedSource, activationCard],
  });
  assert.equal(scenario.requiredName, "目标场地");
  assert.equal(scenario.copyReceivers.length, 1);
  assert.equal(scenario.receiversWithPrintedReference.length, 0);
  assert.equal(scenario.activationBlocked, true);
});

test("printed-name requirements are parsed from equivalent Chinese, Japanese, and English card text", () => {
  for (const [text, expected] of [
    ["效果文本里写有「匿名基准卡」的怪兽。", "匿名基准卡"],
    ["「匿名基準カード」のカード名が記されたモンスター。", "匿名基準カード"],
    ["A monster whose card text mentions \"Anonymous Reference\".", "Anonymous Reference"],
  ]) {
    assert.equal(extractPrintedReferenceRequirement(text), expected, text);
  }
});

test("printed-text prompt guidance is injected only for a typed operation-subject condition", () => {
  const receiver = {
    id: "abstract-receiver",
    name: "匿名接收者",
    cardType: "monster",
    effectText: "①：以1只怪兽为对象可以发动。这张卡获得那只怪兽的原本卡名和效果。",
  };
  const source = {
    id: "abstract-source",
    name: "匿名来源",
    cardType: "monster",
    effectText: "自己的原始卡文中记述了「匿名基准卡」的卡名。",
  };
  const activationCard = {
    id: "abstract-activation-card",
    name: "匿名发动卡",
    cardType: "spell",
    effectText: "有「匿名基准卡」卡名记述的怪兽存在的场合才能发动。",
  };
  const evidenceFor = (cards) => ({
    cardTexts: cards.map((card) => ({
      id: `card-text-${card.id}`,
      type: "card_text",
      cardIds: [card.id],
      title: card.name,
      text: card.effectText,
    })),
    officialQaDirectCandidates: [],
    officialQaRelated: [],
    faqRelated: [],
    rawRelatedEvidence: [],
    retrievalWarnings: [],
  });

  const typed = buildRagRulingPromptBundle({
    userQuery: "匿名接收者复制匿名来源后，能否发动匿名发动卡？",
    cardResolution: {
      resolvedCards: [receiver, source, activationCard],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: evidenceFor([receiver, source, activationCard]),
    env: { RAG_RECOVERY_PROMPT_CHARS: "12000" },
  });
  for (const prompt of [typed.prompt, typed.recoveryPrompt]) {
    assert.match(prompt, /只检查候选卡自身原始规范 effectText/u);
    assert.match(prompt, /operation_subject_card_text/u);
    assert.match(prompt, /abstract-activation-card/u);
    assert.match(prompt, /card-text-abstract-activation-card/u);
  }

  const unrelated = buildRagRulingPromptBundle({
    userQuery: "匿名接收者在主要阶段能否发动抽卡效果？",
    cardResolution: {
      resolvedCards: [receiver],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence: evidenceFor([receiver]),
  });
  assert.doesNotMatch(unrelated.prompt, /只检查候选卡自身原始规范 effectText/u);
  assert.doesNotMatch(unrelated.recoveryPrompt, /运行时状态与其不可变的卡片定义分开/u);
});

test("generic rule query retrieves the printed-text definition passage", () => {
  const [passage] = retrieveRulebookPassages({
    records: [rule],
    userQuery: question,
    ruleSearchQueries: [{
      query: "有「○○」卡名记述 效果文本栏中记述作为卡名存在 字段不满足条件",
      confidence: "high",
    }],
  });
  assert.ok(passage);
  assert.match(passage.text, /效果文本栏中记述作为卡名存在/u);
});

test("printed-text pattern remains an unknown candidate without typed premises", () => {
  const result = analyzeDeterministicOperationLegality({
    userQuery: question,
    cardTexts: [copyMonster, copiedSource, activationCard],
    ruleEvidence: [rule],
  });
  const check = result.checks.find((item) => item.operationId === "printed-text-name-reference-activation-condition");
  assert.equal(check?.status, "unknown");
  assert.equal(check?.deterministicComplete, false);
  assert.equal(result.hasBlockingCheck, false);
  assert.equal(result.complete, false);
  assert.match(result.shortAnswer, /不能确认/u);
  assert.equal(result.matchedRuleEvidence[0].id, rule.id);
});

test("printed-text candidate completes only with attested evidence-bound premises", () => {
  const result = analyzeDeterministicOperationLegality({
    userQuery: question,
    cardTexts: [copyMonster, copiedSource, activationCard],
    ruleEvidence: [rule],
    typedPremises: {
      schemaVersion: OPERATION_PREMISE_SCHEMA_VERSION,
      attested: true,
      facts: [{
        predicate: "activation.requires_printed_name_reference",
        value: true,
        citations: [{ id: activationCard.id, quote: "记载有该卡名的怪兽" }],
      }, {
        predicate: "candidate.original_printed_text_contains_required_name",
        value: false,
        citations: [{ id: copyMonster.id, quote: "获得与该怪兽原本卡名・效果相同的卡名・效果" }],
      }, {
        predicate: "candidate.only_has_copied_name_or_effect",
        value: true,
        citations: [{ id: copyMonster.id, quote: "获得与该怪兽原本卡名・效果相同的卡名・效果" }],
      }, {
        predicate: "copy.modifies_receiver_printed_text",
        value: false,
        citations: [{ id: rule.id, quote: "效果文本栏中记述作为卡名存在" }],
      }],
    },
  });
  const check = result.checks.find((item) => item.operationId === "printed-text-name-reference-activation-condition");
  assert.equal(check?.status, "illegal");
  assert.equal(check?.deterministicComplete, true);
  assert.equal(result.complete, true);
  assert.equal(result.hasBlockingCheck, true);
  assert.match(result.shortAnswer, /^不能发动/u);
});

test("attested premise labels without matching source quotes cannot complete", () => {
  const result = analyzeDeterministicOperationLegality({
    userQuery: question,
    cardTexts: [copyMonster, copiedSource, activationCard],
    ruleEvidence: [rule],
    typedPremises: {
      schemaVersion: OPERATION_PREMISE_SCHEMA_VERSION,
      attested: true,
      facts: [{
        predicate: "activation.requires_printed_name_reference",
        value: true,
        citations: [{ id: activationCard.id, quote: "这段文字并不存在于证据中" }],
      }, {
        predicate: "candidate.original_printed_text_contains_required_name",
        value: false,
        citations: [{ id: "missing-evidence-id", quote: "不存在的证据" }],
      }, {
        predicate: "candidate.only_has_copied_name_or_effect",
        value: true,
        citations: [{ id: copyMonster.id, quote: "获得与该怪兽原本卡名・效果相同的卡名・效果" }],
      }, {
        predicate: "copy.modifies_receiver_printed_text",
        value: false,
        citations: [{ id: rule.id, quote: "效果文本栏中记述作为卡名存在" }],
      }],
    },
  });
  const check = result.checks.find((item) => item.operationId === "printed-text-name-reference-activation-condition");
  assert.equal(check?.status, "unknown");
  assert.equal(check?.deterministicComplete, false);
  assert.equal(result.complete, false);
  assert.ok(result.warnings.some((item) => /operation_premise_unbound/u.test(item)));
});
