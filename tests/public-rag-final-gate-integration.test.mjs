import assert from "node:assert/strict";
import test from "node:test";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

test("public RAG repairs a grounded conclusion conflict once without retrieving a new packet", async () => {
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

  const answer = await answerRagRulingQuestion({
    question: "对方发动「中立测试陷阱」时，场上没有其他卡。我方能连锁发动「中立测试响应者」的效果吗？",
    cards,
    records: [restrictiveRule],
    qaRecords: [],
    rulebookModelInvoker: async () => JSON.stringify({
      operationChecks: [{
        operationId: "neutral-response-operation",
        action: "连锁发动响应者并完成必做处理",
        status: "illegal",
        conclusion: "不能连锁发动，因为场上没有能完成必做处理的卡。",
        reasoning: ["限制性规则直接阻止发动。"],
        citations: [{
          id: "neutral-public-final-rule#p1-1",
          quote: "发动时不存在能够完成必做处理的卡的场合，那个效果不能发动。",
        }],
      }],
      overallConclusion: "不能发动。",
    }),
    modelInvoker: async ({ prompt }) => {
      prompts.push(prompt);
      finalCalls += 1;
      return JSON.stringify(finalCalls === 1
        ? modelAnswer("可以连锁发动并正常处理。")
        : modelAnswer("不能连锁发动，因为场上没有能完成必做处理的卡。", [{
            id: "neutral-public-final-rule#p1-1",
            type: "rulebook",
            title: "必须处理没有可适用卡时的发动限制",
          }]));
    },
    env: { MODEL_PROVIDER: "mock" },
  });

  assert.equal(finalCalls, 2);
  assert.equal(answer.debug.publicFinalValidation.outcome, "repair_valid");
  assert.equal(answer.debug.publicFinalValidation.callCount, 2);
  assert.match(answer.shortAnswer, /不能连锁发动/u);
  assert.ok(prompts[1].startsWith(prompts[0]));
  assert.match(prompts[1], /同一冻结题面/u);
  assert.ok(answer.riskFlags.includes("public_final_validation_failed"));
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
