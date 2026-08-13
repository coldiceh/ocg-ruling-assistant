import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { answerRagRulingQuestion } from "../backend/rawEvidenceRagPipeline.mjs";

const cards = [{
  id: "901",
  name: "匿名测试卡",
  cnName: "匿名测试卡",
  aliases: ["匿名测试卡"],
  cardType: "monster",
  effectText: "①：自己主要阶段可以发动。抽1张卡。",
}];

function makeAnswer(overrides = {}) {
  return {
    answerLevel: "rule_analysis",
    shortAnswer: "匿名模型结论。",
    reasoning: ["依据原始卡片文本。"],
    usedCards: ["匿名测试卡"],
    usedEvidence: [{ id: "card-text-901", type: "card_text", title: "匿名测试卡 的卡片文本" }],
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "medium",
    ...overrides,
  };
}

test("public raw pipeline calls only retrieval helpers and one final model", async () => {
  const calls = { card: 0, rule: 0, final: 0, forbidden: 0 };
  const poison = async () => {
    calls.forbidden += 1;
    throw new Error("legacy ruling component must not run");
  };
  let finalPrompt = "";
  const answer = await answerRagRulingQuestion({
    question: "「匿名测试卡」的①效果如何处理？",
    cards,
    records: [],
    qaRecords: [],
    env: { RAG_MODEL_PROVIDER: "mock", RAG_LIVE_OFFICIAL_QA: "false" },
    cardModelInvoker: async () => {
      calls.card += 1;
      return JSON.stringify({ cardNames: [{ name: "匿名测试卡", originalText: "匿名测试卡" }] });
    },
    ruleModelInvoker: async () => {
      calls.rule += 1;
      return JSON.stringify({ ruleQueries: [{ query: "主要阶段 发动" }] });
    },
    modelInvoker: async ({ prompt }) => {
      calls.final += 1;
      finalPrompt = prompt;
      return JSON.stringify(makeAnswer());
    },
    legacyLuaSemanticPacketFactory: poison,
    rulebookModelInvoker: poison,
    applicabilityModelInvoker: poison,
    formalScenarioDraftInvoker: poison,
    engineFetchImpl: poison,
    formalFetchImpl: poison,
    engineScenario: { marker: "forbidden" },
  });

  assert.deepEqual(calls, { card: 1, rule: 1, final: 1, forbidden: 0 });
  assert.equal(answer.debug.rawEvidenceOnly, true);
  assert.equal(answer.debug.retrievalMode, "raw_generic");
  assert.equal(answer.debug.publicFinalValidation.callCount, 1);
  assert.deepEqual(answer.debug.finalOutputCheck, answer.debug.publicFinalValidation);
  assert.equal(answer.debug.publicFinalValidation.repairAttempted, false);
  assert.equal(answer.engine.status, "disabled");
  assert.equal(answer.formalEngine.status, "disabled");
  assert.equal(answer.legacyLua.status, "disabled");
  assert.match(finalPrompt, /匿名测试卡/u);
  assert.doesNotMatch(finalPrompt, /summonLegalityContext|playerRoleBindings|legacyLuaSemanticPacket|operationLegality/u);
});

test("public raw pipeline never repairs malformed final output with another call", async () => {
  let finalCalls = 0;
  const answer = await answerRagRulingQuestion({
    question: "「匿名测试卡」的①效果如何处理？",
    cards,
    records: [],
    qaRecords: [],
    env: { RAG_MODEL_PROVIDER: "mock", RAG_LIVE_OFFICIAL_QA: "false" },
    cardModelInvoker: async () => ({ cardNames: [] }),
    ruleModelInvoker: async () => ({ ruleQueries: [] }),
    modelInvoker: async () => {
      finalCalls += 1;
      return "这不是 JSON，但声称可以发动。";
    },
  });
  assert.equal(finalCalls, 1);
  assert.equal(answer.debug.publicFinalValidation.outcome, "primary_invalid_no_ruling");
  assert.equal(answer.debug.publicFinalValidation.callCount, 1);
  assert.doesNotMatch(answer.shortAnswer, /可以发动/u);
});

test("raw public pipeline has a static import boundary from ruling components", async () => {
  const publicModules = new Map(await Promise.all([
    "rawEvidenceRagPipeline.mjs",
    "rawGenericCardResolver.mjs",
    "rawGenericDataStore.mjs",
    "rawGenericEvidenceRetriever.mjs",
  ].map(async (name) => [
    name,
    await readFile(new URL(`../backend/${name}`, import.meta.url), "utf8"),
  ])));
  const source = publicModules.get("rawEvidenceRagPipeline.mjs");
  const validatorSource = await readFile(new URL("../backend/rawEvidenceAnswerValidator.mjs", import.meta.url), "utf8");
  const forbiddenImports = [
    "ragCardExtractor",
    "ragEvidenceRetriever",
    "officialQaMatcher",
    "rulebookPassageRetriever",
    "ragRulingPrompt",
    "publicRagAnswerValidator",
    "legacyLuaSemantic",
    "formalEngine",
    "ocgEngine",
    "summonLegality",
    "effectApplicability",
    "playerRoleBindings",
    "effectStateReasoner",
    "rulebookGrounding",
  ];
  for (const [name, moduleSource] of publicModules) {
    for (const forbidden of forbiddenImports) {
      assert.doesNotMatch(
        moduleSource,
        new RegExp(`(?:from\\s*["'][^"']*|import\\(\\s*["'][^"']*)${forbidden}`, "iu"),
        `${name} must not import legacy semantic module ${forbidden}`,
      );
    }
  }
  assert.match(source, /from\s+["']\.\/rawGenericCardResolver\.mjs["']/u);
  assert.match(source, /from\s+["']\.\/rawGenericDataStore\.mjs["']/u);
  assert.match(source, /from\s+["']\.\/rawGenericEvidenceRetriever\.mjs["']/u);
  assert.doesNotMatch(source, /enableDerivedRuleQueries|enableMechanismAnalogues|enableOperationSubjectDefinitionFaqPromotion/u);
  assert.doesNotMatch(validatorSource, /officialDirectFallbackApplied|buildOfficialDirectFallback|extractOfficialQaAnswer/u);
});

test("latest statically stays on one final-ruling call with engines and repair disabled", async () => {
  const [pipelineSource, validatorSource, registrySource, publicServiceSource] = await Promise.all([
    readFile(new URL("../backend/rawEvidenceRagPipeline.mjs", import.meta.url), "utf8"),
    readFile(new URL("../backend/rawEvidenceAnswerValidator.mjs", import.meta.url), "utf8"),
    readFile(new URL("../backend/rulingVersionRegistry.mjs", import.meta.url), "utf8"),
    readFile(new URL("../backend/publicAnswerService.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(registrySource, /answerRagRulingQuestion[^\n]+rawEvidenceRagPipeline\.mjs/u);
  assert.doesNotMatch(registrySource, /ragRulingPipeline\.mjs/u);
  assert.equal((pipelineSource.match(/=>\s*callRagModel\s*\(/gu) || []).length, 1);
  assert.doesNotMatch(pipelineSource, /recoveryPrompt/u);
  assert.equal((validatorSource.match(/await\s+invoke\s*\(/gu) || []).length, 1);
  assert.match(validatorSource, /callCount:\s*1/u);
  assert.match(validatorSource, /repairAttempted:\s*false/u);
  assert.match(validatorSource, /maxRepairAttempts:\s*0/u);
  assert.match(publicServiceSource, /const\s+engineEnabled\s*=\s*false/u);
  assert.match(pipelineSource, /formalEngine:\s*\{\s*mode:\s*["']off["'],\s*status:\s*["']disabled["']/u);
  assert.match(pipelineSource, /legacyLua:\s*\{[\s\S]{0,160}?status:\s*["']disabled["']/u);
});

test("ordinary public analysis cannot self-promote to official confirmation", async () => {
  const answer = await answerRagRulingQuestion({
    question: "「匿名测试卡」的①效果如何处理？",
    cards,
    records: [],
    qaRecords: [],
    env: { RAG_MODEL_PROVIDER: "mock", RAG_LIVE_OFFICIAL_QA: "false" },
    cardModelInvoker: async () => ({ cardNames: [] }),
    ruleModelInvoker: async () => ({ ruleQueries: [] }),
    modelInvoker: async () => JSON.stringify(makeAnswer({ answerLevel: "official_confirmed" })),
  });
  assert.equal(answer.debug.publicFinalValidation.outcome, "primary_invalid_no_ruling");
  assert.equal(answer.answerLevel, "needs_more_info");
});

test("public output and prompt are invariant to local engine configuration", async () => {
  async function run(env) {
    let prompt = "";
    const answer = await answerRagRulingQuestion({
      question: "「匿名测试卡」的①效果如何处理？",
      cards,
      records: [],
      qaRecords: [],
      env: { RAG_MODEL_PROVIDER: "mock", RAG_LIVE_OFFICIAL_QA: "false", ...env },
      cardModelInvoker: async () => JSON.stringify({ cardNames: [{ name: "匿名测试卡", originalText: "匿名测试卡" }] }),
      ruleModelInvoker: async () => JSON.stringify({ ruleQueries: [] }),
      modelInvoker: async (request) => {
        prompt = request.prompt;
        return JSON.stringify(makeAnswer());
      },
    });
    return {
      prompt,
      resolvedCards: answer.resolvedCards,
      usedEvidence: answer.usedEvidence,
      retrievalCounts: answer.debug.retrievalCounts,
    };
  }

  assert.deepEqual(
    await run({ OCG_ENGINE_URL: "http://127.0.0.1:8790", RAG_AUTO_ENGINE_SIMULATION: "true" }),
    await run({}),
  );
});
