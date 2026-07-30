import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCardText } from "../backend/cardTextNormalizer.mjs";
import { analyzeDeterministicOperationLegality } from "../backend/operationLegalityAnalyzer.mjs";
import { analyzePrintedTextReferenceScenario } from "../backend/printedTextReferences.mjs";
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
  assert.equal(normalized.version, "1.3");
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

test("deterministic legality blocks activation when only copied text mentions the required name", () => {
  const result = analyzeDeterministicOperationLegality({
    userQuery: question,
    cardTexts: [copyMonster, copiedSource, activationCard],
    ruleEvidence: [rule],
  });
  assert.equal(result.hasBlockingCheck, true);
  assert.equal(result.complete, true);
  assert.match(result.shortAnswer, /^不能发动/u);
  assert.match(result.shortAnswer, /不会改写其印刷文本/u);
  assert.equal(result.matchedRuleEvidence[0].id, rule.id);
});
