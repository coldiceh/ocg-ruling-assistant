import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  assertFrozenEvidenceCompleteness,
  buildFrozenCaseRecord,
  freezePublicRagFinalInputs,
  runFrozenPublicRagFinalEffort,
} from "../scripts/frozen-public-rag-final-effort.mjs";

const TEST_RELAY_BASE_URL = "https://relay.example/v1";
const TEST_ENV = Object.freeze({
  RELAY_API_KEY: "test-relay-key",
  RELAY_BASE_URL: TEST_RELAY_BASE_URL,
});

function evidenceFixture(question = "网页问题", caseId = "case-001") {
  const card = {
    id: "10001",
    name: "测试卡",
    effectText: "完整卡片效果文本。",
  };
  const qa = {
    id: "qa-complete-1",
    recordType: "qa",
    question: "完整官方问题",
    rawDetailedQuestion: "完整官方场景",
    answer: "完整官方答案",
    text: "",
    sourceUrl: "https://db.example/qa/1",
  };
  const promptPayload = {
    userQuery: question,
    resolvedCards: [{ id: card.id, name: card.name, effectText: card.effectText }],
    evidence: {
      officialQaRelated: [{
        id: qa.id,
        type: "related",
        recordType: "qa",
        question: qa.question,
        detailedScene: qa.rawDetailedQuestion,
        answer: qa.answer,
        sourceUrl: qa.sourceUrl,
        retrievalContext: { relatedOnly: true },
      }],
    },
    allowedEvidenceIds: [qa.id],
  };
  const prompt = [
    "测试普通裁定提示",
    "本次用户问题、卡片原文与检索资料如下：",
    JSON.stringify(promptPayload),
  ].join("\n");
  const evidenceRequirements = {
    schemaVersion: 1,
    cases: {
      [caseId]: {
        questionSha256: sha256(question),
        expectedRoute: "ordinary_rag",
        requiredResolvedCardIds: [card.id],
        requiredEvidenceIds: [qa.id],
        requiredRelatedOnlyEvidenceIds: [qa.id],
        forbiddenEvidenceIds: ["qa-forbidden"],
      },
    },
  };
  const data = { cards: [card], qaRecords: [qa], records: [] };
  return { card, qa, prompt, evidenceRequirements, data };
}

function auditedRecord({ id = "case-004", question = "测试问题" } = {}) {
  const fixture = evidenceFixture(question, id);
  const base = buildFrozenCaseRecord({
    item: { id, question, sourceBlocks: [4] },
    captured: {
      prompt: fixture.prompt,
      provider: "relay",
      modelName: "gpt-5.6-sol",
      maxTokens: 32000,
      reasoningEffort: "low",
    },
    transportContract: testTransportContract(),
    answer: {
      resolvedCards: [{ id: fixture.card.id }],
      usedEvidence: [{ id: fixture.qa.id }],
      debug: {
        route: "ordinary_rag",
        dataRevision: "test-data-revision",
        evidenceFingerprint: sha256("test-evidence"),
        finalPromptSha256: sha256(fixture.prompt),
        promptTruncated: false,
      },
    },
  });
  const requirement = {
    ...fixture.evidenceRequirements.cases[id],
  };
  const evidenceAudit = assertFrozenEvidenceCompleteness({
    record: base,
    requirementContext: {
      requirement,
      cardSources: new Map([[fixture.card.id, fixture.card]]),
      evidenceSources: new Map([[fixture.qa.id, fixture.qa]]),
    },
  });
  return { ...base, evidenceAudit };
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function testTransportContract(baseUrl = TEST_RELAY_BASE_URL) {
  const normalized = String(baseUrl).replace(/\/+$/u, "");
  const endpoint = normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
  return {
    provider: "relay",
    transport: "chat_completions_sse",
    outputMode: "plain_text",
    relayHost: new URL(baseUrl).host,
    relayEndpointSha256: sha256(endpoint),
  };
}

function completedResponse({
  effort = "low",
  rawText = "完整裁定",
  returnedModel = "gpt-5.6-sol",
  finishReason = "stop",
  dryRun = false,
  riskFlags = [],
  providerFailure = null,
  warnings = [],
} = {}) {
  return {
    rawText,
    answer: { shortAnswer: rawText || "失败提示", riskFlags },
    generationConfig: {
      requestModel: "gpt-5.6-sol",
      reasoningEffort: effort,
      maxOutputTokens: 32000,
    },
    tokenUsage: {},
    dryRun,
    providerFailure,
    warnings,
    generationAttempts: [{ finishReason, responseModel: returnedModel }],
  };
}

async function writeBundle(snapshotPath, record) {
  const bundle = {
    schemaVersion: 3,
    kind: "frozen_public_rag_final_inputs",
    status: "complete",
    transportContract: record.transportContract,
    cases: [record],
    bundleInvariantSha256: sha256(JSON.stringify([{
      requestInvariantSha256: record.requestInvariantSha256,
      evidenceAuditSha256: record.evidenceAudit.auditSha256,
    }])),
  };
  await writeFile(snapshotPath, `${JSON.stringify(bundle)}\n`, "utf8");
}

test("frozen public RAG record excludes the reference answer and binds the exact prompt", () => {
  const prompt = "PUBLIC_RAG_PROMPT\nREFERENCE_EVIDENCE_TAIL";
  const record = buildFrozenCaseRecord({
    item: {
      id: "case-004",
      question: "测试问题",
      referenceAnswer: "绝不能进入冻结包的标准答案",
      sourceBlocks: [4],
    },
    captured: {
      prompt,
      provider: "relay",
      modelName: "gpt-5.6-sol",
      maxTokens: 32000,
      reasoningEffort: "low",
    },
    transportContract: testTransportContract(),
    answer: {
      resolvedCards: [{ id: "23380" }],
      usedEvidence: [{ id: "qa-decisive" }],
      debug: {},
    },
  });

  assert.equal(record.prompt, prompt);
  assert.equal(record.model, "gpt-5.6-sol");
  assert.equal(record.maxCompletionTokens, 32000);
  assert.equal(Object.hasOwn(record, "referenceAnswer"), false);
  assert.doesNotMatch(JSON.stringify(record), /绝不能进入冻结包的标准答案/u);
});

test("frozen record stores only allowlisted retrieval candidate stage ID arrays", () => {
  const prompt = "PUBLIC_RAG_PROMPT";
  const record = buildFrozenCaseRecord({
    item: { id: "case-004", question: "测试问题", sourceBlocks: [4] },
    captured: {
      prompt,
      provider: "relay",
      modelName: "gpt-5.6-sol",
      maxTokens: 32000,
      reasoningEffort: "low",
    },
    transportContract: testTransportContract(),
    answer: {
      resolvedCards: [{ id: "23380" }],
      usedEvidence: [{ id: "qa-decisive" }],
      debug: {
        retrievalCandidateStages: {
          initialCrossCardQuestionIds: ["qa-initial", " qa-initial ", "问题正文"],
          rulePlannerCandidateIds: ["qa.rule:planner", "private query text", 100],
          ruleQueryQuestionBranchCandidateIds: ["qa@branch#1", { id: "qa-object" }],
          scopedOfficialMatchIds: ["qa-scoped-match-1", "scoped match private body"],
          scopedSupplementalOfficialIds: ["qa-scoped-plan-1", "scoped query private body"],
          scopedOfficialRelatedCandidateIds: ["qa-scoped-2", "scoped private body"],
          crossCardRankedPoolIds: ["qa-ranked_2", "https://private.example/question"],
          crossCardEvidenceCandidateIds: ["qa-evidence-3", "", null],
          allocatedOfficialRelatedIds: ["qa-official-4", "模型答案"],
          allocatedCrossCardIds: ["qa-cross-5", "model output answer"],
          notAllocatedCrossCardIds: ["qa-missed-6", "a".repeat(129)],
          unknownCandidateIds: ["qa-must-not-be-saved"],
          question: "private question body",
          query: "private retrieval query",
          answer: "private answer body",
          modelOutput: "private model output",
        },
      },
    },
  });

  assert.deepEqual(Object.keys(record.retrievalCandidateStages), [
    "initialCrossCardQuestionIds",
    "rulePlannerCandidateIds",
    "ruleQueryQuestionBranchCandidateIds",
    "scopedOfficialMatchIds",
    "scopedSupplementalOfficialIds",
    "scopedOfficialRelatedCandidateIds",
    "crossCardRankedPoolIds",
    "crossCardEvidenceCandidateIds",
    "allocatedOfficialRelatedIds",
    "allocatedCrossCardIds",
    "notAllocatedCrossCardIds",
  ]);
  assert.deepEqual(record.retrievalCandidateStages, {
    initialCrossCardQuestionIds: ["qa-initial"],
    rulePlannerCandidateIds: ["qa.rule:planner"],
    ruleQueryQuestionBranchCandidateIds: ["qa@branch#1"],
    scopedOfficialMatchIds: ["qa-scoped-match-1"],
    scopedSupplementalOfficialIds: ["qa-scoped-plan-1"],
    scopedOfficialRelatedCandidateIds: ["qa-scoped-2"],
    crossCardRankedPoolIds: ["qa-ranked_2"],
    crossCardEvidenceCandidateIds: ["qa-evidence-3"],
    allocatedOfficialRelatedIds: ["qa-official-4"],
    allocatedCrossCardIds: ["qa-cross-5"],
    notAllocatedCrossCardIds: ["qa-missed-6"],
  });
  const serializedStages = JSON.stringify(record.retrievalCandidateStages);
  assert.doesNotMatch(
    serializedStages,
    /问题正文|private|model output|qa-must-not-be-saved|qa-object/u,
  );
});

test("whole-record prompt compaction remains diagnostic when every required body is complete", () => {
  const fixture = evidenceFixture("网页问题", "case-001");
  const record = buildFrozenCaseRecord({
    item: { id: "case-001", question: "网页问题", sourceBlocks: [1] },
    captured: {
      prompt: fixture.prompt,
      provider: "relay",
      modelName: "gpt-5.6-sol",
      maxTokens: 32000,
      reasoningEffort: "low",
    },
    transportContract: testTransportContract(),
    answer: {
      resolvedCards: [{ id: fixture.card.id }],
      usedEvidence: [{ id: fixture.qa.id }],
      debug: {
        route: "ordinary_rag",
        dataRevision: "test-data-revision",
        evidenceFingerprint: sha256("test-evidence"),
        finalPromptSha256: sha256(fixture.prompt),
        promptTruncated: false,
        retrievalWarnings: ["rag_prompt_compacted_to_max_chars"],
      },
    },
  });

  const audit = assertFrozenEvidenceCompleteness({
    record,
    requirementContext: {
      requirement: fixture.evidenceRequirements.cases["case-001"],
      cardSources: new Map([[fixture.card.id, fixture.card]]),
      evidenceSources: new Map([[fixture.qa.id, fixture.qa]]),
    },
  });

  assert.equal(record.promptCompacted, true);
  assert.equal(record.promptTruncated, false);
  assert.equal(audit.status, "complete");
});

test("freeze sends the same explicit mode, profile, and ruling version as the web page", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "frozen-public-rag-freeze-"));
  const datasetPath = path.join(temp, "private-test.txt");
  const snapshotPath = path.join(temp, "snapshot.json");
  const privateReference = "绝不能进入公开问题或冻结 Prompt 的裁判答案";
  await writeFile(datasetPath, `网页问题\n${privateReference}\n`, "utf8");
  let observedPayload = null;
  const fixture = evidenceFixture("网页问题", "case-001");
  const prompt = fixture.prompt;

  await freezePublicRagFinalInputs({
    datasetPath,
    snapshotPath,
    caseIds: ["case-001"],
    maxCalls: 1,
    evidenceRequirements: fixture.evidenceRequirements,
    env: TEST_ENV,
    loadEvidenceData: async () => fixture.data,
    answerPublic: async ({ payload, answerRuling }) => {
      observedPayload = payload;
      return { answer: await answerRuling({ question: payload.question }) };
    },
    answerRuling: async ({ modelInvoker }) => {
      await modelInvoker({
        prompt,
        provider: "relay",
        modelName: "gpt-5.6-sol",
        maxTokens: 32000,
        reasoningEffort: "low",
      });
      return {
        resolvedCards: [{ id: fixture.card.id }],
        usedEvidence: [{ id: fixture.qa.id }],
        debug: {
          route: "ordinary_rag",
          dataRevision: "test-data-revision",
          evidenceFingerprint: sha256("test-evidence"),
          finalPromptSha256: sha256(prompt),
          promptTruncated: false,
        },
      };
    },
    log: () => {},
  });

  assert.deepEqual(observedPayload, {
    question: "网页问题",
    mode: "rag",
    rulingModelProfile: "relay-gpt-5.6-sol-low",
    rulingVersion: "latest",
  });
  const snapshotText = await readFile(snapshotPath, "utf8");
  assert.doesNotMatch(snapshotText, new RegExp(privateReference, "u"));
  const snapshot = JSON.parse(snapshotText);
  assert.equal(snapshot.cases[0].evidenceAudit.status, "complete");
  assert.equal(Object.hasOwn(snapshot, "datasetDigest"), false);
});

test("reference answers cannot change the question-only frozen input digest", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "frozen-public-rag-reference-"));
  const fixture = evidenceFixture("同一个网页问题", "case-001");
  const freeze = async (referenceAnswer, suffix) => {
    const datasetPath = path.join(temp, `private-${suffix}.txt`);
    const snapshotPath = path.join(temp, `snapshot-${suffix}.json`);
    await writeFile(datasetPath, `同一个网页问题\n${referenceAnswer}\n`, "utf8");
    await freezePublicRagFinalInputs({
      datasetPath,
      snapshotPath,
      caseIds: ["case-001"],
      maxCalls: 1,
      evidenceRequirements: fixture.evidenceRequirements,
      env: TEST_ENV,
      loadEvidenceData: async () => fixture.data,
      answerPublic: async ({ payload, answerRuling }) => ({
        answer: await answerRuling({ question: payload.question }),
      }),
      answerRuling: async ({ modelInvoker }) => {
        await modelInvoker({
          prompt: fixture.prompt,
          provider: "relay",
          modelName: "gpt-5.6-sol",
          maxTokens: 32000,
          reasoningEffort: "low",
        });
        return {
          resolvedCards: [{ id: fixture.card.id }],
          usedEvidence: [{ id: fixture.qa.id }],
          debug: {
            route: "ordinary_rag",
            dataRevision: "test-data-revision",
            evidenceFingerprint: sha256("test-evidence"),
            finalPromptSha256: sha256(fixture.prompt),
            promptTruncated: false,
          },
        };
      },
      log: () => {},
    });
    return JSON.parse(await readFile(snapshotPath, "utf8"));
  };

  const first = await freeze("第一个标准答案", "a");
  const second = await freeze("完全不同的第二个标准答案", "b");
  assert.equal(first.questionDatasetDigest, second.questionDatasetDigest);
  assert.equal(first.cases[0].promptUtf8Sha256, second.cases[0].promptUtf8Sha256);
  assert.equal(first.cases[0].evidenceAudit.auditSha256, second.cases[0].evidenceAudit.auditSha256);
});

test("source-backed evidence audit rejects a silently shortened card text", () => {
  const fixture = evidenceFixture("测试问题", "case-004");
  const shortenedPrompt = fixture.prompt.replace(fixture.card.effectText, "不完整卡文");
  const record = buildFrozenCaseRecord({
    item: { id: "case-004", question: "测试问题", sourceBlocks: [4] },
    captured: {
      prompt: shortenedPrompt,
      provider: "relay",
      modelName: "gpt-5.6-sol",
      maxTokens: 32000,
      reasoningEffort: "low",
    },
    transportContract: testTransportContract(),
    answer: {
      resolvedCards: [{ id: fixture.card.id }],
      usedEvidence: [{ id: fixture.qa.id }],
      debug: {
        route: "ordinary_rag",
        dataRevision: "test-data-revision",
        evidenceFingerprint: sha256("test-evidence"),
        finalPromptSha256: sha256(shortenedPrompt),
        promptTruncated: false,
      },
    },
  });
  assert.throws(() => assertFrozenEvidenceCompleteness({
    record,
    requirementContext: {
      requirement: fixture.evidenceRequirements.cases["case-004"],
      cardSources: new Map([[fixture.card.id, fixture.card]]),
      evidenceSources: new Map([[fixture.qa.id, fixture.qa]]),
    },
  }), /effect text is incomplete/u);
});

test("freeze preserves a failed evidence-audit base record, continues, and forbids replay", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "frozen-public-rag-audit-failure-"));
  const datasetPath = path.join(temp, "private-test.txt");
  const snapshotPath = path.join(temp, "snapshot.json");
  const cases = [
    { id: "case-001", question: "第一个测试问题" },
    { id: "case-002", question: "第二个测试问题" },
    { id: "case-003", question: "第三个测试问题" },
  ];
  await writeFile(datasetPath, cases.map((item, index) => (
    `${item.question}\n私有参考答案${index + 1}`
  )).join("\n\n"), "utf8");
  const fixtures = new Map(cases.map((item) => [
    item.question,
    evidenceFixture(item.question, item.id),
  ]));
  const evidenceRequirements = {
    schemaVersion: 1,
    cases: Object.fromEntries(cases.map((item) => [
      item.id,
      fixtures.get(item.question).evidenceRequirements.cases[item.id],
    ])),
  };
  const prepared = [];

  await assert.rejects(() => freezePublicRagFinalInputs({
    datasetPath,
    snapshotPath,
    caseIds: cases.map((item) => item.id),
    maxCalls: cases.length,
    evidenceRequirements,
    env: TEST_ENV,
    loadEvidenceData: async () => fixtures.get(cases[0].question).data,
    answerPublic: async ({ payload, answerRuling }) => ({
      answer: await answerRuling({ question: payload.question }),
    }),
    answerRuling: async ({ question, modelInvoker }) => {
      prepared.push(question);
      const fixture = fixtures.get(question);
      const prompt = question === cases[1].question
        ? fixture.prompt.replace(fixture.card.effectText, "不完整卡文")
        : fixture.prompt;
      await modelInvoker({
        prompt,
        provider: "relay",
        modelName: "gpt-5.6-sol",
        maxTokens: 32000,
        reasoningEffort: "low",
      });
      return {
        resolvedCards: [{ id: fixture.card.id }],
        usedEvidence: [{ id: fixture.qa.id }],
        debug: {
          route: "ordinary_rag",
          dataRevision: "test-data-revision",
          evidenceFingerprint: sha256("test-evidence"),
          finalPromptSha256: sha256(prompt),
          promptTruncated: false,
        },
      };
    },
    log: () => {},
  }), (error) => {
    assert.equal(error.code, "FROZEN_EVIDENCE_AUDIT_FAILED");
    return true;
  });

  assert.deepEqual(prepared, cases.map((item) => item.question));
  const snapshotText = await readFile(snapshotPath, "utf8");
  assert.doesNotMatch(snapshotText, /私有参考答案/u);
  const snapshot = JSON.parse(snapshotText);
  assert.equal(snapshot.status, "failed_evidence_audit");
  assert.equal(snapshot.finalModelCallCount, 0);
  assert.deepEqual(snapshot.failedEvidenceAuditCaseIds, ["case-002"]);
  assert.deepEqual(snapshot.cases.map((item) => item.id), cases.map((item) => item.id));
  assert.equal(snapshot.cases[0].evidenceAudit.status, "complete");
  assert.equal(snapshot.cases[1].evidenceAudit.status, "failed_evidence_audit");
  assert.equal(snapshot.cases[1].question, cases[1].question);
  assert.equal(snapshot.cases[1].promptUtf8Sha256, sha256(snapshot.cases[1].prompt));
  assert.match(snapshot.cases[1].evidenceAudit.error.message, /effect text is incomplete/u);
  assert.match(snapshot.cases[1].evidenceAudit.error.messageSha256, /^[a-f0-9]{64}$/u);
  assert.equal(snapshot.cases[2].evidenceAudit.status, "complete");
  assert.equal(Object.hasOwn(snapshot, "bundleInvariantSha256"), false);

  let finalCalls = 0;
  await assert.rejects(() => runFrozenPublicRagFinalEffort({
    snapshotPath,
    outputPath: path.join(temp, "result.json"),
    effort: "low",
    caseIds: cases.map((item) => item.id),
    maxCalls: cases.length,
    env: TEST_ENV,
    callModel: async () => {
      finalCalls += 1;
      return completedResponse();
    },
    log: () => {},
  }), /snapshot must be a completed frozen public RAG bundle/u);
  assert.equal(finalCalls, 0);
});

test("freeze records one redacted evidence-preparation failure, continues, and keeps final calls at zero", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "frozen-public-rag-preparation-failure-"));
  const datasetPath = path.join(temp, "private-test.txt");
  const snapshotPath = path.join(temp, "snapshot.json");
  const cases = [
    { id: "case-001", question: "第一个匿名测试问题" },
    { id: "case-002", question: "第二个私密超时问题" },
    { id: "case-003", question: "第三个匿名测试问题" },
  ];
  await writeFile(datasetPath, cases.map((item, index) => (
    `${item.question}\n私有参考答案${index + 1}`
  )).join("\n\n"), "utf8");
  const fixtures = new Map(cases.map((item) => [
    item.question,
    evidenceFixture(item.question, item.id),
  ]));
  const evidenceRequirements = {
    schemaVersion: 1,
    cases: Object.fromEntries(cases.map((item) => [
      item.id,
      fixtures.get(item.question).evidenceRequirements.cases[item.id],
    ])),
  };
  const prepared = [];
  let capturePathsReached = 0;

  await assert.rejects(() => freezePublicRagFinalInputs({
    datasetPath,
    snapshotPath,
    caseIds: cases.map((item) => item.id),
    maxCalls: cases.length,
    evidenceRequirements,
    env: TEST_ENV,
    loadEvidenceData: async () => fixtures.get(cases[0].question).data,
    answerPublic: async ({ payload, answerRuling }) => ({
      answer: await answerRuling({ question: payload.question }),
    }),
    answerRuling: async ({ question, modelInvoker }) => {
      prepared.push(question);
      if (question === cases[1].question) {
        const error = new Error(`private timeout details: ${question}`);
        error.code = "rule_query_model_timeout";
        throw error;
      }
      const fixture = fixtures.get(question);
      capturePathsReached += 1;
      await modelInvoker({
        prompt: fixture.prompt,
        provider: "relay",
        modelName: "gpt-5.6-sol",
        maxTokens: 32000,
        reasoningEffort: "low",
      });
      return {
        resolvedCards: [{ id: fixture.card.id }],
        usedEvidence: [{ id: fixture.qa.id }],
        debug: {
          route: "ordinary_rag",
          dataRevision: "test-data-revision",
          evidenceFingerprint: sha256("test-evidence"),
          finalPromptSha256: sha256(fixture.prompt),
          promptTruncated: false,
        },
      };
    },
    log: () => {},
  }), (error) => {
    assert.equal(error.code, "FROZEN_EVIDENCE_PREPARATION_FAILED");
    return true;
  });

  assert.deepEqual(prepared, cases.map((item) => item.question));
  assert.equal(capturePathsReached, 2);
  const snapshotText = await readFile(snapshotPath, "utf8");
  assert.doesNotMatch(snapshotText, /第二个私密超时问题|private timeout details/u);
  const snapshot = JSON.parse(snapshotText);
  assert.equal(snapshot.status, "failed_evidence_preparation");
  assert.equal(snapshot.finalModelCallCount, 0);
  assert.deepEqual(snapshot.failedEvidencePreparationCaseIds, ["case-002"]);
  assert.deepEqual(snapshot.cases.map((item) => item.id), cases.map((item) => item.id));
  assert.deepEqual(snapshot.cases.map((item) => item.status), [
    "complete",
    "failed_evidence_preparation",
    "complete",
  ]);
  const failed = snapshot.cases[1];
  assert.equal(failed.evidencePreparation.error.code, "rule_query_model_timeout");
  assert.equal(failed.evidencePreparation.error.message, "evidence preparation failed");
  assert.match(failed.evidencePreparation.error.messageSha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(failed, "question"), false);
  assert.equal(Object.hasOwn(failed, "prompt"), false);
  assert.equal(Object.hasOwn(snapshot, "bundleInvariantSha256"), false);

  let finalCalls = 0;
  await assert.rejects(() => runFrozenPublicRagFinalEffort({
    snapshotPath,
    outputPath: path.join(temp, "result.json"),
    effort: "low",
    caseIds: cases.map((item) => item.id),
    maxCalls: cases.length,
    env: TEST_ENV,
    callModel: async () => {
      finalCalls += 1;
      return completedResponse();
    },
    log: () => {},
  }), /snapshot must be a completed frozen public RAG bundle/u);
  assert.equal(finalCalls, 0);
});

test("freeze fails fast on non-domain preparation errors instead of redacting them", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "frozen-public-rag-programming-failure-"));
  const datasetPath = path.join(temp, "private-test.txt");
  const snapshotPath = path.join(temp, "snapshot.json");
  const cases = [
    { id: "case-001", question: "第一个匿名测试问题" },
    { id: "case-002", question: "第二个不应运行的问题" },
  ];
  await writeFile(datasetPath, cases.map((item, index) => (
    `${item.question}\n私有参考答案${index + 1}`
  )).join("\n\n"), "utf8");
  const fixture = evidenceFixture(cases[0].question, cases[0].id);
  const evidenceRequirements = {
    schemaVersion: 1,
    cases: Object.fromEntries(cases.map((item) => [
      item.id,
      evidenceFixture(item.question, item.id).evidenceRequirements.cases[item.id],
    ])),
  };
  const attempted = [];

  await assert.rejects(() => freezePublicRagFinalInputs({
    datasetPath,
    snapshotPath,
    caseIds: cases.map((item) => item.id),
    maxCalls: cases.length,
    evidenceRequirements,
    env: TEST_ENV,
    loadEvidenceData: async () => fixture.data,
    answerPublic: async ({ payload }) => {
      attempted.push(payload.question);
      throw new TypeError("programming failure must remain visible");
    },
    log: () => {},
  }), /programming failure must remain visible/u);

  assert.deepEqual(attempted, [cases[0].question]);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.finalModelCallCount, 0);
  assert.deepEqual(snapshot.cases, []);
  assert.equal(Object.hasOwn(snapshot, "failedEvidencePreparationCaseIds"), false);
});

test("low and medium replay reuse every frozen request field except reasoning effort", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "frozen-public-rag-"));
  const snapshotPath = path.join(temp, "snapshot.json");
  const record = auditedRecord();
  const prompt = record.prompt;
  await writeBundle(snapshotPath, record);

  const observed = [];
  const callModel = async (request) => {
    observed.push({
      prompt: request.prompt,
      reasoningEffort: request.reasoningEffort,
      outputMode: request.outputMode,
      model: request.env.RAG_MODEL,
      maxOutputTokens: request.env.RAG_MAX_OUTPUT_TOKENS,
      relayBaseUrl: request.env.RELAY_BASE_URL,
    });
    return completedResponse({
      effort: request.reasoningEffort,
      rawText: `answer-${request.reasoningEffort}`,
    });
  };

  for (const effort of ["low", "medium"]) {
    await runFrozenPublicRagFinalEffort({
      snapshotPath,
      outputPath: path.join(temp, `${effort}.json`),
      effort,
      caseIds: ["case-004"],
      maxCalls: 1,
      env: TEST_ENV,
      callModel,
      log: () => {},
    });
  }

  assert.deepEqual(observed, [{
    prompt,
    reasoningEffort: "low",
    outputMode: "plain_text",
    model: "gpt-5.6-sol",
    maxOutputTokens: "32000",
    relayBaseUrl: TEST_RELAY_BASE_URL,
  }, {
    prompt,
    reasoningEffort: "medium",
    outputMode: "plain_text",
    model: "gpt-5.6-sol",
    maxOutputTokens: "32000",
    relayBaseUrl: TEST_RELAY_BASE_URL,
  }]);
  const low = JSON.parse(await readFile(path.join(temp, "low.json"), "utf8"));
  const medium = JSON.parse(await readFile(path.join(temp, "medium.json"), "utf8"));
  assert.equal(low.results[0].promptUtf8Sha256, medium.results[0].promptUtf8Sha256);
  assert.equal(low.results[0].messagesSha256, medium.results[0].messagesSha256);
  assert.equal(low.results[0].requestInvariantSha256, medium.results[0].requestInvariantSha256);
  assert.equal(low.scoringAnswerField, "displayedAnswer");
  assert.equal(low.endToEndWebParity, false);
});

test("replay fails closed before dispatch when the Relay endpoint differs from the snapshot", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "frozen-public-rag-endpoint-"));
  const snapshotPath = path.join(temp, "snapshot.json");
  const record = auditedRecord();
  await writeBundle(snapshotPath, record);
  let calls = 0;

  await assert.rejects(() => runFrozenPublicRagFinalEffort({
    snapshotPath,
    outputPath: path.join(temp, "result.json"),
    effort: "low",
    caseIds: ["case-004"],
    maxCalls: 1,
    env: { RELAY_API_KEY: "test", RELAY_BASE_URL: "https://different.example/v1" },
    callModel: async () => {
      calls += 1;
      return completedResponse();
    },
    log: () => {},
  }), /endpoint or transport differs/u);
  assert.equal(calls, 0);
});

test("replay preflights every selected evidence audit before the first final call", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "frozen-public-rag-preflight-"));
  const snapshotPath = path.join(temp, "snapshot.json");
  const first = auditedRecord({ id: "case-004", question: "第一个问题" });
  const second = auditedRecord({ id: "case-018", question: "第二个问题" });
  const damagedSecond = {
    ...second,
    evidenceAudit: { ...second.evidenceAudit, status: "damaged" },
  };
  const records = [first, damagedSecond];
  await writeFile(snapshotPath, `${JSON.stringify({
    schemaVersion: 3,
    kind: "frozen_public_rag_final_inputs",
    status: "complete",
    transportContract: first.transportContract,
    cases: records,
    bundleInvariantSha256: sha256(JSON.stringify(records.map((record) => ({
      requestInvariantSha256: record.requestInvariantSha256,
      evidenceAuditSha256: record.evidenceAudit.auditSha256,
    })))),
  })}\n`, "utf8");
  let calls = 0;
  await assert.rejects(() => runFrozenPublicRagFinalEffort({
    snapshotPath,
    outputPath: path.join(temp, "result.json"),
    effort: "low",
    caseIds: ["case-004", "case-018"],
    maxCalls: 2,
    env: TEST_ENV,
    callModel: async () => {
      calls += 1;
      return completedResponse();
    },
    log: () => {},
  }), /no completed evidence audit/u);
  assert.equal(calls, 0);
});

test("provider failure, empty or truncated output, and returned-model drift are never completed", async (t) => {
  const failures = [{
    name: "dry run without dispatch",
    response: completedResponse({ dryRun: true }),
  }, {
    name: "provider failure",
    response: completedResponse({
      rawText: "",
      providerFailure: { code: "relay_stream_timeout" },
    }),
  }, {
    name: "empty output",
    response: completedResponse({ rawText: "" }),
  }, {
    name: "truncated output",
    response: completedResponse({
      rawText: "部分正文",
      finishReason: "length",
      riskFlags: ["model_output_not_displayable"],
    }),
  }, {
    name: "returned-model drift",
    response: completedResponse({ returnedModel: "gpt-5.6-terra" }),
  }];

  for (const [index, failure] of failures.entries()) {
    await t.test(failure.name, async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), `frozen-public-rag-failure-${index}-`));
      const snapshotPath = path.join(temp, "snapshot.json");
      const outputPath = path.join(temp, "result.json");
      const record = auditedRecord();
      await writeBundle(snapshotPath, record);

      await assert.rejects(() => runFrozenPublicRagFinalEffort({
        snapshotPath,
        outputPath,
        effort: "low",
        caseIds: ["case-004"],
        maxCalls: 1,
        env: TEST_ENV,
        callModel: async () => failure.response,
        log: () => {},
      }));
      const result = JSON.parse(await readFile(outputPath, "utf8"));
      assert.equal(result.results[0].status, "failed_non_scorable");
      assert.notEqual(result.results[0].status, "completed");
    });
  }
});

test("targeted-eight workflow keeps private evidence requirements outside the repository", async () => {
  const workflow = await readFile(new URL(
    "../.github/workflows/frozen-public-rag-targeted-eight.yml",
    import.meta.url,
  ), "utf8");

  assert.match(
    workflow,
    /PURE_LLM_EVALUATION_TARGETED_EIGHT_REQUIREMENTS_BASE64/u,
  );
  assert.match(
    workflow,
    /--requirements "\$RUNNER_TEMP\/frozen-eight-requirements\.json"/u,
  );
  assert.match(workflow, /RAG_RULE_MODEL_TIMEOUT_MS:\s*"180000"/u);
  assert.doesNotMatch(
    workflow,
    /--requirements\s+\.github\//u,
  );
  assert.match(workflow, /frozen-public-rag-reusable\.tar\.gz\.enc\.hmac-sha256/u);
  assert.match(workflow, /target_sha256=/u);
  assert.match(workflow, /mapfile -t binding_run_ids/u);
  assert.match(workflow, /test "\$\{#binding_run_ids\[@\]\}" -eq 1/u);
  assert.match(workflow, /binding_source_key="\$\{binding_run_ids\[0\]\}-\$\{binding_run_attempts\[0\]\}"/u);
  assert.match(workflow, /test "\$binding_source_key" = "\$SOURCE_KEY"/u);
  assert.match(workflow, /replay_allowed=\$replay_allowed/u);
  assert.match(workflow, /test "\$\(sed -n 's\/\^replay_allowed=\/\/p' "\$binding"\)" = "true"/u);

  const preflightStart = workflow.indexOf("- name: Preflight private inputs and preservation before paid calls");
  const executeStart = workflow.indexOf("- name: Freeze or replay the selected cases serially");
  assert.ok(preflightStart >= 0 && executeStart > preflightStart);
  const preflight = workflow.slice(preflightStart, executeStart);
  const executeEnd = workflow.indexOf("- name: Print private-safe execution metadata", executeStart);
  const execute = workflow.slice(executeStart, executeEnd);
  assert.match(preflight, /set -euo pipefail/u);
  assert.match(preflight, /PRIVATE_DATASET_BASE64/u);
  assert.match(preflight, /base64 --decode/u);
  assert.match(preflight, /parseDatasetText/u);
  assert.match(preflight, /freeze selection is not exactly the reviewed targeted eight cases/u);
  assert.match(preflight, /matched\.length !== 8/u);
  assert.match(preflight, /mv -- "\$dataset_candidate" "\$RUNNER_TEMP\/private-dataset\.txt"/u);
  assert.doesNotMatch(execute, /PRIVATE_DATASET_BASE64|base64 --decode/u);
  assert.match(execute, /--dataset "\$RUNNER_TEMP\/private-dataset\.txt"/u);
  assert.match(execute, /--requirements "\$RUNNER_TEMP\/frozen-eight-requirements\.json"/u);
  assert.match(execute, /replay_allowed=false/u);
  assert.match(execute, /\[ "\$STAGE" = "freeze" \] && \[ "\$runner_status" -eq 0 \]/u);
  assert.match(workflow, /\[ "\$STAGE" = "freeze" \] && \[ "\$REPLAY_ALLOWED" = "true" \]/u);
  assert.doesNotMatch(workflow, /^ {12}(?:NODE|PY)$/mu);
});
