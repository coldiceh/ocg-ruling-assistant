import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseExternalJudgeText,
  runExternalJudgeTextEvaluation,
} from "../scripts/evaluate-external-judge-text.mjs";

const syntheticQuestions = Array.from(
  { length: 32 },
  (_, index) => `匿名合成场景${String(index + 1).padStart(2, "0")}能否处理？`,
);
const syntheticBlocks = syntheticQuestions.map((question, index) => (
  index === 0
    ? `${question}\n合成裁判结论${index + 1}第一行。\n合成裁判结论${index + 1}第二行。`
    : index === 1
      ? `${question}\n答案\n合成裁判结论${index + 1}第一行。\n合成裁判结论${index + 1}第二行。`
      : `${question}\n合成裁判结论${index + 1}。`
));
const syntheticText = [
  ...syntheticBlocks,
  `${syntheticQuestions[0]}\n合成裁判结论1第一行。\n合成裁判结论1第二行`,
].join("\n\n");

test("external judge parser creates unique anonymous cases with judge-only references", () => {
  const corpus = parseExternalJudgeText(syntheticText);

  assert.equal(corpus.inputBlockCount, 33);
  assert.equal(corpus.duplicateQuestionCount, 1);
  assert.equal(corpus.cases.length, 32);
  assert.equal(new Set(corpus.cases.map((item) => item.id)).size, 32);
  assert.match(corpus.questionSetSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(corpus.modelInputContract.allowedCaseFields, ["question"]);
  assert.deepEqual(
    corpus.modelInputContract.forbiddenCaseFields,
    ["answer", "referenceAnswer", "expectedAnswer"],
  );
  for (const item of corpus.cases) {
    assert.match(item.id, /^external-judge-[a-f0-9]{24}$/u);
    assert.ok(item.question.trim());
    assert.ok(item.referenceAnswer.trim());
  }
  assert.equal(corpus.cases[0].parseStrategy, "legacy_question_boundary");
  assert.equal(corpus.cases[0].referenceAnswer, "合成裁判结论1第一行。\n合成裁判结论1第二行。");
  assert.equal(corpus.cases[1].parseStrategy, "reference_marker");
  assert.equal(corpus.cases[1].referenceAnswer, "合成裁判结论2第一行。\n合成裁判结论2第二行。");
});

test("stable anonymous ids survive reordering and equivalent duplicate punctuation", () => {
  const first = parseExternalJudgeText([
    "匿名问题甲能否处理？\n匿名答案甲。",
    "匿名问题乙能否处理？\n匿名答案乙。",
    "匿名问题甲能否处理？\n匿名答案甲",
  ].join("\n\n"));
  const reordered = parseExternalJudgeText([
    "匿名问题乙能否处理？\n匿名答案乙。",
    "匿名问题甲能否处理？\n匿名答案甲。",
  ].join("\n\n"));

  assert.equal(first.duplicateQuestionCount, 1);
  assert.equal(first.questionSetSha256, reordered.questionSetSha256);
  assert.deepEqual(
    new Map(first.cases.map((item) => [item.question, item.id])),
    new Map(reordered.cases.map((item) => [item.question, item.id])),
  );
});

test("conflicting references for a duplicate question stop evaluation input creation", () => {
  assert.throws(
    () => parseExternalJudgeText([
      "匿名重复问题能否处理？\n匿名结论甲。",
      "匿名重复问题能否处理？\n匿名结论乙。",
    ].join("\n\n")),
    /repeat the same question with conflicting reference answers/u,
  );
});

test("explicit case markers preserve multi-line questions and reference answers", () => {
  const corpus = parseExternalJudgeText([
    "::case",
    "::question",
    "匿名显式问题第一行。",
    "匿名显式问题第二行没有疑问标点",
    "::reference-answer",
    "匿名显式答案第一行。",
    "匿名显式答案第二行。",
    "::end",
  ].join("\n"));

  assert.equal(corpus.sourceFormat, "explicit_case_markers");
  assert.equal(corpus.cases.length, 1);
  assert.equal(corpus.cases[0].parseStrategy, "explicit_markers");
  assert.equal(corpus.cases[0].question, "匿名显式问题第一行。\n匿名显式问题第二行没有疑问标点");
  assert.equal(corpus.cases[0].referenceAnswer, "匿名显式答案第一行。\n匿名显式答案第二行。");
});

test("legacy blocks without a question signal retain the final-line fallback", () => {
  const corpus = parseExternalJudgeText("匿名陈述式测试输入\n匿名末行裁判答案");

  assert.equal(corpus.cases.length, 1);
  assert.equal(corpus.cases[0].parseStrategy, "legacy_last_line");
  assert.equal(corpus.cases[0].question, "匿名陈述式测试输入");
  assert.equal(corpus.cases[0].referenceAnswer, "匿名末行裁判答案");
});

test("external evaluation sends questions without answer or referenceAnswer fields", async (t) => {
  const externalRoot = await mkdtemp(join(tmpdir(), "external-judge-test-"));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  const inputPath = join(externalRoot, "test.txt");
  const outputPath = join(externalRoot, "report.json");
  const checkpointPath = join(externalRoot, "checkpoint.json");
  await writeFile(inputPath, syntheticText, "utf8");
  const requestBodies = [];

  const report = await runExternalJudgeTextEvaluation({
    inputPath,
    outputPath,
    checkpointPath,
    endpoint: "https://example.test/api/answer",
    runners: ["online"],
    resume: false,
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            shortAnswer: "合成模型输出。",
            resolvedCards: [],
            usedEvidence: [],
            debug: { retrievalCounts: {}, unresolvedMentions: [], ambiguousMentions: [] },
          };
        },
      };
    },
  });

  const corpus = parseExternalJudgeText(syntheticText);
  assert.deepEqual(requestBodies, corpus.cases.map((item) => ({
    question: item.question,
    mode: "rag",
  })));
  const serializedRequests = JSON.stringify(requestBodies);
  assert.doesNotMatch(serializedRequests, /referenceAnswer|expectedAnswer|合成裁判结论/u);

  const persistedReport = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(persistedReport, report);
  assert.equal(report.privacy.redacted, true);
  assert.equal(report.cases.length, 32);
  assert.equal(report.cases[0].parseStrategy, "legacy_question_boundary");
  const serializedReport = JSON.stringify(report);
  assert.doesNotMatch(serializedReport, /匿名合成场景|合成裁判结论|合成模型输出/u);
  assert.doesNotMatch(
    serializedReport,
    /"(?:question|referenceAnswer|expectedAnswer|shortAnswer)"\s*:/u,
  );
  assert.doesNotMatch(serializedReport, /expectedVerdicts|actualVerdicts/u);
  assert.equal(report.summary.runs.online.semanticReview.reviewed, 0);
  assert.equal(report.summary.runs.online.semanticReview.notReviewed, 32);
  assert.equal(report.summary.runs.online.semanticReview.strictAccuracy, null);
  assert.equal(Object.hasOwn(report.summary.runs.online, "pass"), false);
  assert.equal(Object.hasOwn(report.summary.runs.online, "fail"), false);

  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  const serializedCheckpoint = JSON.stringify(checkpoint);
  assert.equal(checkpoint.privacy.private, true);
  assert.equal(checkpoint.privacy.publishable, false);
  assert.equal(checkpoint.cases.length, 32);
  assert.doesNotMatch(serializedCheckpoint, /匿名合成场景|合成裁判结论/u);
  assert.match(serializedCheckpoint, /合成模型输出/u);
  assert.doesNotMatch(
    serializedCheckpoint,
    /"(?:question|referenceAnswer|expectedAnswer)"\s*:/u,
  );
  assert.ok(checkpoint.cases.every((item) => Object.values(item.runs).every(
    (run) => run.candidateAnswer === "合成模型输出。"
      && /^[a-f0-9]{64}$/u.test(run.candidateAnswerSha256),
  )));
});

test("independent relay judge receives reference and candidate while the answer model never does", async (t) => {
  const externalRoot = await mkdtemp(join(tmpdir(), "external-semantic-judge-test-"));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  const inputPath = join(externalRoot, "test.txt");
  const outputPath = join(externalRoot, "public-report.json");
  const checkpointPath = join(externalRoot, "private-checkpoint.json");
  await writeFile(inputPath, syntheticBlocks[0], "utf8");
  const answerBodies = [];
  const judgeBodies = [];

  const report = await runExternalJudgeTextEvaluation({
    inputPath,
    outputPath,
    checkpointPath,
    endpoint: "https://answer.example/api/answer",
    runners: ["online"],
    resume: false,
    fetchImpl: async (_url, options) => {
      answerBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        async json() {
          return { shortAnswer: "匿名候选输出。", resolvedCards: [], usedEvidence: [], debug: {} };
        },
      };
    },
    judgeEndpoint: "https://relay.example/v1",
    judgeApiKey: "judge-secret",
    judgeModel: "anonymous-judge-model",
    judgeReasoningEffort: "low",
    judgeFetchImpl: async (url, options) => {
      assert.equal(url, "https://relay.example/v1/chat/completions");
      assert.equal(options.headers.authorization, "Bearer judge-secret");
      judgeBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{ message: { content: JSON.stringify({
              rating: "correct",
              rationale: "候选与裁判参考的结论及必要条件一致。",
            }) } }],
          };
        },
      };
    },
  });

  assert.deepEqual(answerBodies, [{ question: syntheticQuestions[0], mode: "rag" }]);
  assert.doesNotMatch(JSON.stringify(answerBodies), /合成裁判结论|匿名候选输出/u);
  assert.equal(judgeBodies.length, 1);
  const judgeInput = JSON.parse(judgeBodies[0].messages[1].content);
  assert.deepEqual(judgeInput, {
    question: syntheticQuestions[0],
    referenceAnswer: "合成裁判结论1第一行。\n合成裁判结论1第二行。",
    candidateAnswer: "匿名候选输出。",
  });
  assert.match(judgeBodies[0].messages[0].content, /ground truth/u);

  const serializedPublicReport = JSON.stringify(report);
  assert.equal(report.cases[0].runs.online.semanticReview.rating, "correct");
  assert.equal(report.summary.runs.online.semanticReview.strictAccuracy, 1);
  assert.doesNotMatch(serializedPublicReport, /匿名合成场景|合成裁判结论|匿名候选输出|judge-secret|候选与裁判/u);

  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  assert.equal(checkpoint.checkpointKind, "external_judge_private_evaluation");
  assert.equal(checkpoint.judgeConfiguration.model, "anonymous-judge-model");
  assert.equal(checkpoint.cases[0].runs.online.candidateAnswer, "匿名候选输出。");
  assert.equal(checkpoint.cases[0].runs.online.semanticReview.rating, "correct");
  assert.match(checkpoint.cases[0].runs.online.semanticReview.rationale, /结论及必要条件一致/u);
  assert.doesNotMatch(JSON.stringify(checkpoint), /合成裁判结论|judge-secret/u);
});

test("redacted checkpoint resumes successful cases and binds to the question-set hash", async (t) => {
  const externalRoot = await mkdtemp(join(tmpdir(), "external-judge-resume-test-"));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  const inputPath = join(externalRoot, "test.txt");
  const outputPath = join(externalRoot, "report.json");
  const checkpointPath = join(externalRoot, "checkpoint.json");
  const compactText = syntheticBlocks.slice(0, 3).join("\n\n");
  await writeFile(inputPath, compactText, "utf8");
  const requestBodies = [];
  const fetchImpl = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          shortAnswer: "匿名生成输出。",
          resolvedCards: [],
          usedEvidence: [],
          debug: { retrievalCounts: {}, unresolvedMentions: [], ambiguousMentions: [] },
        };
      },
    };
  };

  await runExternalJudgeTextEvaluation({
    inputPath,
    outputPath,
    checkpointPath,
    endpoint: "https://example.test/api/answer",
    runners: ["online"],
    limit: 2,
    fetchImpl,
  });
  assert.equal(requestBodies.length, 2);

  await runExternalJudgeTextEvaluation({
    inputPath,
    outputPath,
    checkpointPath,
    endpoint: "https://example.test/api/answer",
    runners: ["online"],
    fetchImpl,
  });
  assert.equal(requestBodies.length, 3);

  await writeFile(inputPath, `${compactText}\n\n匿名新增问题能否处理？\n匿名新增答案。`, "utf8");
  await assert.rejects(
    () => runExternalJudgeTextEvaluation({
      inputPath,
      outputPath,
      checkpointPath,
      endpoint: "https://example.test/api/answer",
      runners: ["online"],
      fetchImpl,
    }),
    /checkpoint does not match the question set/u,
  );
});

test("semantic judge resume reuses the private candidate and retries only the failed judge", async (t) => {
  const externalRoot = await mkdtemp(join(tmpdir(), "external-semantic-resume-test-"));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  const inputPath = join(externalRoot, "test.txt");
  const outputPath = join(externalRoot, "public-report.json");
  const checkpointPath = join(externalRoot, "private-checkpoint.json");
  await writeFile(inputPath, syntheticBlocks[0], "utf8");
  let answerCalls = 0;
  let judgeCalls = 0;
  const common = {
    inputPath,
    outputPath,
    checkpointPath,
    endpoint: "https://answer.example/api/answer",
    runners: ["online"],
    fetchImpl: async () => {
      answerCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { shortAnswer: "可续跑候选。", resolvedCards: [], usedEvidence: [], debug: {} };
        },
      };
    },
    judgeEndpoint: "https://relay.example/v1",
    judgeApiKey: "secret",
    judgeModel: "judge-model",
    judgeFetchImpl: async () => {
      judgeCalls += 1;
      if (judgeCalls === 1) return { ok: false, status: 503, async json() { return {}; } };
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: "{\"rating\":\"incorrect\",\"rationale\":\"关键结论相反。\"}" } }] };
        },
      };
    },
  };

  await runExternalJudgeTextEvaluation({ ...common, resume: false });
  const firstCheckpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  assert.equal(firstCheckpoint.cases[0].runs.online.semanticReview.error, "judge_request_failed");

  const report = await runExternalJudgeTextEvaluation(common);
  assert.equal(answerCalls, 1);
  assert.equal(judgeCalls, 2);
  assert.equal(report.cases[0].runs.online.semanticReview.rating, "incorrect");
});

test("semantic judging is opt-in and cannot silently reuse the production answer endpoint", async (t) => {
  const externalRoot = await mkdtemp(join(tmpdir(), "external-semantic-config-test-"));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  const inputPath = join(externalRoot, "test.txt");
  const outputPath = join(externalRoot, "report.json");
  await writeFile(inputPath, syntheticBlocks[0], "utf8");

  await assert.rejects(
    () => runExternalJudgeTextEvaluation({
      inputPath,
      outputPath,
      endpoint: "https://answer.example/api/answer",
      runners: ["online"],
      judgeModel: "judge-model",
      judgeEnv: {},
      fetchImpl: async () => { throw new Error("must not call answer model"); },
    }),
    /semantic judge endpoint must be a valid HTTPS URL/u,
  );
});

test("model profile is the only extra selector added to online question requests", async (t) => {
  const externalRoot = await mkdtemp(join(tmpdir(), "external-judge-profile-test-"));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  const inputPath = join(externalRoot, "test.txt");
  const outputPath = join(externalRoot, "report.json");
  const checkpointPath = join(externalRoot, "checkpoint.json");
  await writeFile(inputPath, syntheticBlocks[0], "utf8");
  const requestBodies = [];

  await runExternalJudgeTextEvaluation({
    inputPath,
    outputPath,
    checkpointPath,
    endpoint: "https://example.test/api/answer",
    runners: ["online"],
    modelProfile: "anonymous-public-profile",
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        async json() {
          return { shortAnswer: "匿名输出。", resolvedCards: [], usedEvidence: [], debug: {} };
        },
      };
    },
  });

  assert.deepEqual(requestBodies, [{
    question: syntheticQuestions[0],
    mode: "rag",
    rulingModelProfile: "anonymous-public-profile",
  }]);
});
