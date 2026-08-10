import assert from "node:assert/strict";
import test from "node:test";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

const localEnv = {
  MODEL_PROVIDER: "mock",
  RAG_MODEL_PROVIDER: "mock",
  RAG_DRY_RUN: "0",
  RAG_LIVE_OFFICIAL_QA_ENABLED: "false",
  RAG_AUTO_ENGINE_SIMULATION: "false",
  RAG_FORMAL_ENGINE_MODE: "off",
  OCG_ENGINE_ENABLED: "0",
};

const completeScenarioCards = [{
  id: "architecture-source",
  name: "测试融合术士",
  effectText: "这张卡召唤・特殊召唤的场合，舍弃1张手牌可以发动。将包含此卡在内的自己或对方场上的怪兽作为融合素材进行融合召唤。不可将自己场上其他怪兽作为融合素材。",
}, {
  id: "architecture-cost",
  name: "圣女代价卡",
  effectText: "“圣女”怪兽。",
}, {
  id: "architecture-protected",
  name: "测试抗性龙",
  cardType: "fusion",
  effectText: "只要自己或对方的场上或墓地存在“圣女”怪兽，此卡不受此卡以外的效果影响。",
}, {
  id: "architecture-target",
  name: "测试冰剑融合龙",
  cardType: "fusion",
  effectText: "“测试融合术士”＋融合・同步・超量・连接怪兽",
}];

test("a complete scene still runs both evidence extractors and exactly one final judge", async () => {
  let cardExtractorCalls = 0;
  let ruleExtractorCalls = 0;
  let finalModelCalls = 0;
  let finalPrompt = "";

  const answer = await answerRagRulingQuestion({
    question: "我方额外卡组有「测试冰剑融合龙」。对方场上只有表侧表示的「测试抗性龙」。我方召唤「测试融合术士」时，可以将「圣女代价卡」作为Cost丢弃来发动其效果吗，后续怎么处理？",
    cards: completeScenarioCards,
    records: [],
    qaRecords: [],
    env: localEnv,
    dryRun: false,
    cardModelInvoker: async () => {
      cardExtractorCalls += 1;
      return JSON.stringify({ cardNames: [] });
    },
    ruleModelInvoker: async () => {
      ruleExtractorCalls += 1;
      return JSON.stringify({ ruleQueries: [] });
    },
    modelInvoker: async ({ prompt }) => {
      finalModelCalls += 1;
      finalPrompt = prompt;
      return JSON.stringify({
        answerLevel: "rule_analysis",
        shortAnswer: "可以发动；支付代价后重新检查效果处理，不能使用已不受影响的怪兽作素材时，不进行融合召唤。",
        reasoning: [
          "发动时手牌可支付，发动合法。",
          "代价支付后场面状态改变，处理时必须按当前状态重新判断可用融合素材。",
        ],
        usedCards: ["测试融合术士", "圣女代价卡", "测试抗性龙", "测试冰剑融合龙"],
        usedEvidence: [
          { id: "card-text-architecture-source", type: "card_text", title: "测试融合术士 的卡片文本" },
          { id: "card-text-architecture-protected", type: "card_text", title: "测试抗性龙 的卡片文本" },
        ],
        missingInfo: [],
        riskFlags: ["no_official_direct_qa"],
        confidenceSelfEstimate: "medium",
      });
    },
  });

  assert.equal(cardExtractorCalls, 1);
  assert.equal(ruleExtractorCalls, 1);
  assert.equal(finalModelCalls, 1);
  assert.match(answer.shortAnswer, /^可以发动/u);
  assert.equal(answer.debug.deterministicDecision, null);
  assert.equal(answer.debug.semanticStateTransition?.authoritative, false);
  assert.equal(answer.debug.semanticStateTransitionDiagnostic, null);
  assert.equal(answer.usedEvidence.some((item) => item.type === "semantic_state_transition"), false);
  assert.match(finalPrompt, /"semanticStateTransition": \{/u);
  assert.match(finalPrompt, /"status": "resolved"/u);
  assert.match(finalPrompt, /"canDecideFinalRuling": false/u);
  assert.doesNotMatch(finalPrompt, /"stateSnapshot"/u);
  assert.doesNotMatch(finalPrompt, /trusted-semantic-state-executor|trusted_local_semantic_execution|final_model_skipped/u);
});

test("an unresolved card cannot revive a local fast path and still reaches the final judge", async () => {
  let finalModelCalls = 0;
  let finalPrompt = "";

  const answer = await answerRagRulingQuestion({
    question: "「尚未收录的测试龙」的效果可以发动吗？",
    cards: [],
    records: [],
    qaRecords: [],
    env: localEnv,
    dryRun: false,
    cardModelInvoker: async () => JSON.stringify({ cardNames: ["尚未收录的测试龙"] }),
    ruleModelInvoker: async () => JSON.stringify({ ruleQueries: ["效果发动条件"] }),
    modelInvoker: async ({ prompt }) => {
      finalModelCalls += 1;
      finalPrompt = prompt;
      return JSON.stringify({
        answerLevel: "needs_more_info",
        shortAnswer: "尚未取得这张卡的卡片文本，暂时无法判断能否发动。",
        reasoning: [
          "当前证据中没有这张卡的效果文本。",
          "必须先确认效果文本、所在区域和当前时点，才能检查发动条件。",
        ],
        usedCards: [],
        usedEvidence: [],
        missingInfo: ["尚未收录的测试龙的完整卡片文本"],
        riskFlags: ["unresolved_card_name"],
        confidenceSelfEstimate: "low",
      });
    },
  });

  assert.ok(finalModelCalls >= 1, "an unresolved card must still reach the final judge");
  assert.ok(answer.debug.unresolvedMentions.some((mention) => mention.input === "尚未收录的测试龙"));
  assert.equal(answer.debug.deterministicDecision, null);
  assert.equal(answer.debug.semanticStateTransition?.authoritative, false);
  assert.equal(answer.debug.semanticStateTransitionDiagnostic, null);
  assert.match(finalPrompt, /尚未收录的测试龙/u);
  assert.notEqual(answer.debug.modelUsed, "trusted-semantic-state-executor");
  assert.doesNotMatch(JSON.stringify(answer.usedEvidence), /semantic|state_transition/u);
});
