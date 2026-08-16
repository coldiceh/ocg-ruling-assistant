import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyPublicRequestChannel,
  DEFAULT_AUTHOR_CONTACT_TEXT,
  formatAuthorContactSentence,
  presentPublicAnswer,
  PUBLIC_REQUEST_CHANNELS,
  resolveAuthorContactText,
} from "../backend/publicAnswerPresentation.mjs";
import { buildPublicOfftopicRiskControlAnswer } from "../backend/publicOfftopicRiskControl.mjs";
import { publicAnswerHttpError } from "../backend/publicAnswerService.mjs";

const webBody = {
  question: "公式データベースの質問ですか？",
  mode: "rag",
  rulingModelProfile: "relay-gpt-5.6-sol-low",
  rulingVersion: "latest",
};
const testNotice = "外部表示テスト通知";

test("the current browser request contract is classified as web", () => {
  assert.equal(classifyPublicRequestChannel(webBody), PUBLIC_REQUEST_CHANNELS.WEB);
  assert.equal(classifyPublicRequestChannel(JSON.stringify(webBody)), PUBLIC_REQUEST_CHANNELS.WEB);
});

test("a question-only body is external_api and mixed or incomplete bodies are unknown", () => {
  assert.equal(
    classifyPublicRequestChannel({ question: "裁定を確認できますか？" }),
    PUBLIC_REQUEST_CHANNELS.EXTERNAL_API,
  );
  for (const body of [
    { question: "裁定を確認できますか？", extra: true },
    { question: "裁定を確認できますか？", mode: "rag" },
    { ...webBody, extra: true },
    { ...webBody, mode: "other" },
  ]) {
    assert.equal(classifyPublicRequestChannel(body), PUBLIC_REQUEST_CHANNELS.UNKNOWN);
  }
});

test("invalid bodies never impersonate external_api", () => {
  for (const body of [
    null,
    [],
    {},
    { question: "" },
    { question: "   " },
    { question: 123 },
    { question: [] },
    "not json",
  ]) {
    assert.equal(classifyPublicRequestChannel(body), PUBLIC_REQUEST_CHANNELS.UNKNOWN);
  }
});

test("external_api receives one notice without mutating the core answer", () => {
  const core = Object.freeze({
    answerLevel: "rule_analysis",
    shortAnswer: "裁定回答",
    reasoning: Object.freeze(["根拠"]),
    usedEvidence: Object.freeze([{ id: "evidence-1" }]),
    debug: Object.freeze({ tokenUsage: Object.freeze({ total_tokens: 12 }), estimatedCostUsd: 0.01 }),
  });
  const first = presentPublicAnswer(core, {
    channel: PUBLIC_REQUEST_CHANNELS.EXTERNAL_API,
    env: { EXTERNAL_API_TEST_NOTICE: testNotice },
  });
  const second = presentPublicAnswer(first, {
    channel: PUBLIC_REQUEST_CHANNELS.EXTERNAL_API,
    env: { EXTERNAL_API_TEST_NOTICE: testNotice },
  });

  assert.notEqual(first, core);
  assert.equal(core.shortAnswer, "裁定回答");
  assert.equal(first.shortAnswer, `裁定回答\n\n${testNotice}`);
  assert.equal(second.shortAnswer, first.shortAnswer);
  assert.equal(second.shortAnswer.split(testNotice).length - 1, 1);
  assert.equal(first.reasoning, core.reasoning);
  assert.equal(first.usedEvidence, core.usedEvidence);
  assert.equal(first.debug, core.debug);
  assert.deepEqual(first.debug.tokenUsage, { total_tokens: 12 });
  assert.equal(first.debug.estimatedCostUsd, 0.01);
});

test("exact official fields and evidence remain byte-for-byte unchanged", () => {
  const exact = {
    answerLevel: "official_confirmed",
    shortAnswer: "公式回答原文",
    officialQuestionJapanese: "公式質問原文",
    officialAnswerJapanese: "公式回答原文",
    officialQaId: "22804",
    usedEvidence: [{ id: "ygoresources-qa-22804", text: "原始証拠" }],
    debug: { providerUsed: "none", modelUsed: "none", tokenUsage: {}, estimatedCostUsd: 0 },
  };
  const snapshot = structuredClone(exact);
  const shown = presentPublicAnswer(exact, {
    channel: PUBLIC_REQUEST_CHANNELS.EXTERNAL_API,
    env: { EXTERNAL_API_TEST_NOTICE: testNotice },
  });

  assert.match(shown.shortAnswer, new RegExp(`${testNotice}$`, "u"));
  assert.equal(shown.officialQuestionJapanese, snapshot.officialQuestionJapanese);
  assert.equal(shown.officialAnswerJapanese, snapshot.officialAnswerJapanese);
  assert.equal(shown.officialQaId, snapshot.officialQaId);
  assert.deepEqual(shown.usedEvidence, snapshot.usedEvidence);
  assert.deepEqual(shown.debug, snapshot.debug);
  assert.deepEqual(exact, snapshot);
});

test("web and unknown responses never receive the external notice", () => {
  const answer = { shortAnswer: "原始回答" };
  const env = { EXTERNAL_API_TEST_NOTICE: testNotice };
  assert.equal(presentPublicAnswer(answer, { channel: PUBLIC_REQUEST_CHANNELS.WEB, env }), answer);
  assert.equal(presentPublicAnswer(answer, { channel: PUBLIC_REQUEST_CHANNELS.UNKNOWN, env }), answer);
  assert.equal(answer.shortAnswer, "原始回答");
});

test("an empty external notice preserves a successful response", () => {
  const answer = { shortAnswer: "原始回答", answerLevel: "rule_analysis" };
  const shown = presentPublicAnswer(answer, {
    channel: PUBLIC_REQUEST_CHANNELS.EXTERNAL_API,
    env: {},
  });
  assert.notEqual(shown, answer);
  assert.deepEqual(shown, answer);
});

test("presentation state never leaks between external_api and web calls", () => {
  const shared = { shortAnswer: "共享核心回答", cacheKey: "same-question" };
  const env = { EXTERNAL_API_TEST_NOTICE: testNotice };
  const externalFirst = presentPublicAnswer(shared, { channel: PUBLIC_REQUEST_CHANNELS.EXTERNAL_API, env });
  const webSecond = presentPublicAnswer(shared, { channel: PUBLIC_REQUEST_CHANNELS.WEB, env });
  const webFirst = presentPublicAnswer(shared, { channel: PUBLIC_REQUEST_CHANNELS.WEB, env });
  const externalSecond = presentPublicAnswer(shared, { channel: PUBLIC_REQUEST_CHANNELS.EXTERNAL_API, env });

  assert.match(externalFirst.shortAnswer, new RegExp(testNotice, "u"));
  assert.equal(webSecond.shortAnswer, shared.shortAnswer);
  assert.equal(webFirst.shortAnswer, shared.shortAnswer);
  assert.match(externalSecond.shortAnswer, new RegExp(testNotice, "u"));
  assert.equal(shared.shortAnswer, "共享核心回答");
});

test("contact messages share the configured author identity", () => {
  assert.equal(DEFAULT_AUTHOR_CONTACT_TEXT, "B站 おmaginai，或 QQ 1195362230");
  assert.equal(resolveAuthorContactText({}), DEFAULT_AUTHOR_CONTACT_TEXT);
  assert.equal(
    formatAuthorContactSentence("如有需要，请联系作者", {}),
    "如有需要，请联系作者：B站 おmaginai，或 QQ 1195362230。",
  );
  assert.equal(resolveAuthorContactText({ AUTHOR_CONTACT_TEXT: "自定义公开联系方式" }), "自定义公开联系方式");

  const triggered = buildPublicOfftopicRiskControlAnswer({
    status: { remainingMinutes: 12 },
    triggered: true,
    env: {},
  });
  const blocked = buildPublicOfftopicRiskControlAnswer({
    status: { remainingMinutes: 4 },
    env: {},
  });
  for (const answer of [triggered, blocked]) {
    assert.match(answer.shortAnswer, /QQ 1195362230/u);
    assert.match(answer.shortAnswer, /B站 おmaginai/u);
    assert.match(answer.shortAnswer, /如需提前解除/u);
  }
  assert.match(triggered.shortAnswer, /系统自动关闭 12 分钟/u);
  assert.match(blocked.shortAnswer, /预计还需 4 分钟/u);
});

test("typed official body errors retain safe retrieval diagnostics", () => {
  const error = Object.assign(new Error("body unavailable"), {
    code: "OFFICIAL_QA_BODY_UNAVAILABLE",
    statusCode: 503,
    details: {
      qaId: "22804",
      sourceRevision: "revision-1",
      questionHash: "a".repeat(64),
      failureReason: "official_qa_body_fetch_failed",
      ignored: "not public",
    },
  });
  const result = publicAnswerHttpError(error);
  assert.equal(result.statusCode, 503);
  assert.equal(result.payload.code, "OFFICIAL_QA_BODY_UNAVAILABLE");
  assert.deepEqual(result.payload.details, {
    qaId: "22804",
    sourceRevision: "revision-1",
    questionHash: "a".repeat(64),
    failureReason: "official_qa_body_fetch_failed",
  });
});

test("channel presentation is wired only at the final HTTP success boundary", async () => {
  const [apiSource, serverSource, pipelineSource, promptSource] = await Promise.all([
    readFile(new URL("../api/answer.js", import.meta.url), "utf8"),
    readFile(new URL("../backend/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../backend/ragRulingPipeline.mjs", import.meta.url), "utf8"),
    readFile(new URL("../backend/ragRulingPrompt.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(apiSource, /json\(presentPublicAnswer\(result\.answer/u);
  assert.match(serverSource, /sendJson\(response, 200, presentPublicAnswer\(result\.answer/u);
  assert.doesNotMatch(pipelineSource, /EXTERNAL_API_TEST_NOTICE/u);
  assert.doesNotMatch(promptSource, /EXTERNAL_API_TEST_NOTICE|external_api/u);
});
