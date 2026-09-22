import assert from "node:assert/strict";
import test from "node:test";
import { compileImmutablePrintedCardDefinitions } from "../backend/printedCardNameReferenceReasoner.mjs";
import { extractPrintedReferenceRequirement } from "../backend/printedTextReferences.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

test("quoted text tokens are typed as exact card names, archetypes, or unresolved references", () => {
  const compiled = compileImmutablePrintedCardDefinitions({
    resolvedCards: [{
      id: "receiver",
      name: "文本载体",
      effectText: "记载有“精确场地”卡名的怪兽。也可选择“测试系列”怪兽，但不处理“未绑定称呼”。",
    }, {
      id: "field",
      name: "精确场地",
      aliases: ["精确场地"],
      effectText: "场地效果。",
    }],
  });
  const receiver = compiled.definitions.find((definition) => definition.definitionId === "receiver");
  assert.deepEqual(
    receiver.printedReferences.map((reference) => reference.kind),
    ["exact_card_name", "archetype_or_field_label", "unresolved"],
  );
  assert.equal(receiver.printedReferences[0].definitionId, "field");
  assert.equal(receiver.rawQuotedTokens[0].surface, "精确场地");
});

test("multiple names in the printed-text complement do not resolve an anaphoric target", () => {
  const required = extractPrintedReferenceRequirement(
    "复制效果后，能否认定自己的卡面效果文本框记载了「匿名场地甲」或「匿名场地乙」，从而满足有该卡名记述的条件？",
  );
  assert.equal(required, "");
});

test("the public RAG path forwards raw card text to one final model without local reasoner output", async () => {
  const card = {
    id: "synthetic-printed-reference-carrier",
    name: "合成载体甲",
    effectText: "①：自己主要阶段可以发动。抽1张卡。",
  };
  let finalModelCalls = 0;
  let finalPrompt = "";
  const expectedOutput = "SYNTHETIC_FINAL_OUTPUT";
  const answer = await answerRagRulingQuestion({
    question: "请读取「合成载体甲」的卡片文本。",
    cards: [card], records: [], qaRecords: [],
    env: { MODEL_PROVIDER: "mock", RAG_MODEL_PROVIDER: "mock", RAG_DRY_RUN: "0", OCG_ENGINE_ENABLED: "0" },
    dryRun: false,
    cardModelInvoker: async () => JSON.stringify({ cardNames: [] }),
    ruleModelInvoker: async () => JSON.stringify({ ruleQueries: [] }),
    modelInvoker: async ({ prompt }) => {
      finalModelCalls += 1;
      finalPrompt = prompt;
      return JSON.stringify({
        answerLevel: "rule_analysis", shortAnswer: expectedOutput,
        reasoning: ["SYNTHETIC_REASONING"], usedCards: [card.name],
        usedEvidence: [], missingInfo: [], riskFlags: [], confidenceSelfEstimate: "high",
      });
    },
  });
  assert.equal(finalModelCalls, 1);
  assert.equal(answer.shortAnswer, expectedOutput);
  assert.equal(answer.debug.deterministicDecision, null);
  assert.equal(answer.debug.semanticStateTransition, null);
  assert.equal(answer.debug.semanticStateTransitionDiagnostic, null);
  assert.equal(answer.debug.modelUsed, "mock-rag");
  assert.ok(finalPrompt.includes(card.id));
  assert.ok(finalPrompt.includes(card.effectText));
  assert.match(finalPrompt, /^evidence: \{/mu);
  assert.doesNotMatch(finalPrompt, /semanticStateTransition|semantic_state_transition|canDecideFinalRuling|printed_card_name_reference_after_runtime_copy|copiedTextCountsAsReceiverPrintedReference|runtimeAcquisition|immutablePrintedDefinitions/u);
  assert.deepEqual(answer.resolvedCards.map(item => item.id), [card.id]);
});
