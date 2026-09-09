import assert from "node:assert/strict";
import test from "node:test";
import {
  answerRagRulingQuestion,
  finalizePreparedRagRulingQuestion,
} from "../backend/ragRulingPipeline.mjs";
import { finalizePreparedRagRulingQuestionForVersion } from "../backend/rulingVersionRegistry.mjs";
import {
  CLOUD_BUDGET_RESERVE,
  createCloudRequestBudget,
} from "../backend/cloudRequestBudget.mjs";

const finalResponse = JSON.stringify({
  answerLevel: "rule_analysis",
  shortAnswer: "这是二次请求复用准备结果的回答。",
  reasoning: ["使用已保存的最终提示。"],
  usedCards: [],
  usedEvidence: [],
  missingInfo: [],
  riskFlags: [],
  confidenceSelfEstimate: "medium",
});

test("preparation can be JSON round-tripped and finalized without upstream calls", async () => {
  let preparationCalls = 0;
  let finalCalls = 0;
  const prompts = [];
  const preparationStages = [];
  const options = {
    question: "【匿名测试卡】\n①：可以发动。抽1张卡。\n这个效果如何处理？",
    cards: [],
    records: [],
    qaRecords: [],
    env: { RAG_MODEL_PROVIDER: "mock", RAG_AUTO_ENGINE_SIMULATION: "false" },
    fetchImpl: async () => { throw new Error("upstream fetch must not run"); },
    cardModelInvoker: async () => {
      preparationCalls += 1;
      return JSON.stringify({ candidates: [] });
    },
    ruleModelInvoker: async () => {
      preparationCalls += 1;
      return JSON.stringify({ queries: [], candidateAssessments: [] });
    },
    modelInvoker: async ({ prompt }) => {
      finalCalls += 1;
      prompts.push(prompt);
      return finalResponse;
    },
  };

  const legacy = await answerRagRulingQuestion(options);
  const callsAfterLegacy = preparationCalls;
  assert.equal(finalCalls, 1);

  const prepared = await answerRagRulingQuestion({
    ...options,
    prepareForContinuation: true,
    progress: { transition: (stage) => preparationStages.push(stage) },
  });
  assert.equal(prepared.status, "evidence_prepared");
  assert.ok(preparationCalls >= 1);
  assert.equal(finalCalls, 1);
  assert.equal(prepared.continuation.schemaVersion, 1);
  assert.equal(preparationStages.includes("generate_ruling"), false);
  const roundTripped = JSON.parse(JSON.stringify(prepared.continuation));

  const progressStages = [];
  const first = await finalizePreparedRagRulingQuestion({
    continuation: roundTripped,
    env: options.env,
    fetchImpl: options.fetchImpl,
    modelInvoker: options.modelInvoker,
    progress: { transition: (stage) => progressStages.push(stage) },
  });
  assert.equal(finalCalls, 2);
  const callsBeforeFinalize = preparationCalls;
  assert.equal(prompts[0], roundTripped.promptBundle.prompt);
  assert.deepEqual(progressStages, ["generate_ruling"]);
  assert.equal(callsBeforeFinalize > callsAfterLegacy, true);
  assert.equal(preparationCalls, callsBeforeFinalize);
  assert.deepEqual(stripTimings(first), stripTimings(legacy));
  assert.equal(prompts[1], prompts[0]);
  assert.equal(first.debug.finalPromptSha256, roundTripped.finalPromptSha256);
  assert.equal(first.debug.timingsMs.total >= roundTripped.timingsMs.total, true);
});

function stripTimings(answer) {
  const copy = structuredClone(answer);
  delete copy.debug?.timingsMs;
  delete copy.debug?.retrievalStageTimingsMs;
  // The evidence fingerprint covers retriever timing diagnostics in the
  // legacy evidence object, so it is observationally timing-derived too.
  delete copy.debug?.evidenceFingerprint;
  return copy;
}

test("cloud finalization scopes one serialized relay call with the saved prompt", async () => {
  const env = {
    RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1",
    RAG_MODEL_PROVIDER: "relay",
    RAG_MODEL: "gpt-6-astra",
    RAG_REASONING_EFFORT: "low",
    RELAY_API_KEY: "synthetic-key",
    RELAY_BASE_URL: "https://relay.example.test/v1",
    CLOUD_BUDGET_RUN_ID: "finalizer-test",
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY: "10",
    CLOUD_BUDGET_THEORETICAL_LIMIT_USD: "5",
    RELAY_PRICING_MULTIPLIER: "0.27",
    RELAY_SITE_DOLLAR_CNY: "1",
  };
  const budgetCommands = [];
  const budget = createCloudRequestBudget({
    env,
    command: async (args) => {
      budgetCommands.push(args);
      return args[1] === CLOUD_BUDGET_RESERVE
        ? ["reserved", "100000", "100000"]
        : ["settled", "100000", "100000"];
    },
  });
  const continuation = {
    schemaVersion: 1,
    mode: "cloud_evidence_v1",
    dataRevision: "cloud-test-revision",
    evidenceFingerprint: "cloud-test-evidence",
    finalPromptSha256: "cloud-test-prompt",
    promptBundle: {
      prompt: "SAVED PROMPT \u0000 with exact spacing",
      modelEvidence: {},
      allowedEvidenceIds: [],
    },
    evidence: {},
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    displayCards: [],
    frozenCardResolutionRejections: [],
    cardNameModel: {},
    ruleQueryModel: {},
    timingsMs: { total: 41, finalModel: 0 },
  };
  let requestBody;
  const result = await finalizePreparedRagRulingQuestion({
    continuation: JSON.parse(JSON.stringify(continuation)),
    env,
    cloudBudget: budget,
    fetchImpl: async (_url, request) => {
      requestBody = JSON.parse(request.body);
      return new Response([
        `data: ${JSON.stringify({
          model: "gpt-6-astra",
          choices: [{
            index: 0,
            finish_reason: "stop",
            message: { content: finalResponse },
          }],
          usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });

  assert.equal(requestBody.model, "gpt-6-astra");
  assert.equal(requestBody.messages[0].content, continuation.promptBundle.prompt);
  assert.equal(requestBody.reasoning_effort, "low");
  assert.equal(result.shortAnswer, "这是二次请求复用准备结果的回答。");
  assert.equal(Array.isArray(result.debug.cloudCosts.calls), true);
  assert.equal(result.debug.cloudCosts.calls.length, 1);
  assert.equal(budgetCommands.length, 2);
});

test("versioned finalization validates and stamps the latest ruling version", async () => {
  const answer = await finalizePreparedRagRulingQuestionForVersion({
    rulingVersion: "latest",
    continuation: {
      schemaVersion: 1,
      mode: "rag_baseline",
      dataRevision: "test-revision",
      evidenceFingerprint: "test-evidence",
      finalPromptSha256: "test-prompt",
      promptBundle: {
        prompt: "saved prompt",
        modelEvidence: {},
        allowedEvidenceIds: [],
      },
      evidence: {},
      cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
      displayCards: [],
      frozenCardResolutionRejections: [],
      cardNameModel: {},
      ruleQueryModel: {},
      timingsMs: { total: 7, finalModel: 0 },
    },
    env: { RAG_MODEL_PROVIDER: "mock" },
    modelInvoker: async () => finalResponse,
  });
  assert.equal(answer.rulingVersion, "latest");
  assert.equal(answer.effectiveRulingVersion, "latest");
  assert.equal(answer.requestedRulingVersion, "latest");
});
