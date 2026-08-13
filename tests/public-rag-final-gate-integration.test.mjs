import assert from "node:assert/strict";
import test from "node:test";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

test("public RAG does not let the preparation model sign or veto the final answer", async () => {
  const prompts = [];
  const cards = [
    {
      id: "neutral-source-1",
      name: "中立测试陷阱",
      cardType: "通常陷阱",
      effectText: "处理时执行一个必须完成的操作。",
      aliases: ["中立测试陷阱"],
    },
    {
      id: "neutral-response-1",
      name: "中立测试响应者",
      cardType: "怪兽",
      effectText: "对方发动陷阱卡时才能发动。进行必须完成的返回处理。",
      aliases: ["中立测试响应者"],
    },
  ];
  const restrictiveRule = {
    id: "neutral-public-final-rule",
    recordType: "rule-doc",
    title: "必须处理没有可适用卡时的发动限制",
    text: "发动时不存在能够完成必做处理的卡的场合，那个效果不能发动。",
  };
  let finalCalls = 0;
  let preparationCalls = 0;

  const answer = await answerRagRulingQuestion({
    question: "对方发动「中立测试陷阱」时，场上没有其他卡。我方能连锁发动「中立测试响应者」的效果吗？",
    cards,
    records: [restrictiveRule],
    qaRecords: [],
    rulebookModelInvoker: async () => {
      preparationCalls += 1;
      return JSON.stringify({
        operationChecks: [{
          status: "illegal",
          conclusion: "这是旧准备模型的判断，不得签发公开结论。",
        }],
      });
    },
    modelInvoker: async ({ prompt }) => {
      prompts.push(prompt);
      finalCalls += 1;
      return JSON.stringify(modelAnswer("可以连锁发动并正常处理。"));
    },
    env: { MODEL_PROVIDER: "mock" },
  });

  assert.equal(preparationCalls, 0);
  assert.equal(finalCalls, 1);
  assert.equal(answer.debug.publicFinalValidation.outcome, "primary_valid");
  assert.equal(answer.debug.publicFinalValidation.callCount, 1);
  assert.match(answer.shortAnswer, /^可以连锁发动/u);
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /这是旧准备模型的判断/u);
  assert.equal(answer.debug.rulebookGroundingWarnings.includes("pure_llm_pipeline"), true);
});

function modelAnswer(shortAnswer, usedEvidence = []) {
  return {
    answerLevel: "rule_analysis",
    shortAnswer,
    reasoning: ["先检查发动手续。", "再检查必做处理是否存在可适用卡。"],
    usedCards: ["中立测试陷阱", "中立测试响应者"],
    usedEvidence,
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "medium",
  };
}
