import assert from "node:assert/strict";
import test from "node:test";

import { callCardIdentitySelectionModel } from "../backend/ragModelClient.mjs";

const ENV = Object.freeze({
  RAG_CARD_MODEL_PROVIDER: "deepseek",
  DEEPSEEK_API_KEY: "synthetic-key",
  DEEPSEEK_CARD_MODEL: "identity-selector-test",
  API_DAILY_BUDGET_CNY: "10",
  API_BUDGET_TIMEZONE: "UTC",
});

const candidateSets = [{
  mentionId: "mention-a",
  surface: "测试称呼",
  candidates: [
    { candidateId: "candidate-a", cid: 101, passcode: "10000001", name: "候选甲", aliases: ["甲"], typeLine: "[怪兽]", effectText: "甲的完整卡文。", pendulumEffectText: "甲的完整灵摆卡文。", attribute: 4, race: 2, level: 4, rank: null, link: null, atk: 1800, def: 1200 },
    { candidateId: "candidate-b", cid: 102, passcode: "10000002", name: "候选乙", aliases: ["乙"], typeLine: "[怪兽]", effectText: "乙的完整卡文。" },
  ],
}];

test("identity selection sends one non-thinking JSON request and caches a bound candidate handle", async () => {
  const calls = [];
  const options = {
    userQuery: "这是一个公开测试问题。",
    candidateSets,
    dataRevision: "identity-selection-test-v1",
    env: ENV,
    now: new Date("2051-02-03T00:00:00.000Z"),
    fetchImpl: async (url, request) => {
      calls.push({ url: String(url), body: JSON.parse(request.body) });
      return jsonResponse({
        id: "identity-selection-response",
        model: "identity-selector-test",
        choices: [{ finish_reason: "stop", message: { content: '{"selections":[{"mentionId":"mention-a","candidateId":"candidate-b"}]}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    },
  };

  const first = await callCardIdentitySelectionModel(options);
  const second = await callCardIdentitySelectionModel(options);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(calls[0].body.thinking, { type: "disabled" });
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.match(JSON.stringify(calls[0].body), /甲的完整灵摆卡文/u);
  assert.deepEqual(first.selections, [{ mentionId: "mention-a", candidateId: "candidate-b" }]);
  assert.equal(second.cacheHit, true);
});

test("identity selection accepts null and numeric handles, and drops unknown or conflicting handles independently", async () => {
  const result = await callCardIdentitySelectionModel({
    userQuery: "另一个公开测试问题。",
    candidateSets: [{
      ...candidateSets[0],
      mentionId: "mention-numeric",
      candidates: [{ ...candidateSets[0].candidates[0], candidateId: "7" }],
    }, {
      ...candidateSets[0],
      mentionId: "mention-null",
    }, {
      ...candidateSets[0],
      mentionId: "mention-unknown",
    }, {
      ...candidateSets[0],
      mentionId: "mention-conflict",
    }],
    dataRevision: "identity-selection-normalization-v1",
    env: ENV,
    now: new Date("2051-02-04T00:00:00.000Z"),
    modelInvoker: async () => ({
      selections: [
        { mentionId: "mention-numeric", candidateId: 7 },
        { mentionId: "mention-numeric", candidateId: "7" },
        { mentionId: "mention-null", candidateId: null },
        { mentionId: "mention-unknown", candidateId: "not-in-request" },
        { mentionId: "mention-unknown", candidateId: "candidate-a" },
        { mentionId: "mention-conflict", candidateId: "candidate-a" },
        { mentionId: "mention-conflict", candidateId: "candidate-b" },
      ],
    }),
  });

  assert.deepEqual(result.selections, [
    { mentionId: "mention-numeric", candidateId: "7" },
    { mentionId: "mention-null", candidateId: null },
  ]);
  assert.equal(result.cacheHit, undefined);
  assert.ok(result.warnings.includes("card_identity_selection_unknown_candidate_handle:mention-unknown"));
  assert.ok(result.warnings.includes("card_identity_selection_conflicting_selection:mention-conflict"));
});

test("identity selection accepts an empty selection list without inventing a candidate", async () => {
  const result = await callCardIdentitySelectionModel({
    userQuery: "第三个公开测试问题。",
    candidateSets,
    dataRevision: "identity-selection-empty-v1",
    env: ENV,
    now: new Date("2051-02-05T00:00:00.000Z"),
    modelInvoker: async () => "```json\n{\"selections\":[]}\n```",
  });

  assert.deepEqual(result.selections, []);
  assert.equal(result.warnings.some((warning) => warning.startsWith("card_identity_selection_not_cached:")), false);
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
