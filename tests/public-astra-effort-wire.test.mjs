import assert from "node:assert/strict";
import test, { after } from "node:test";
import { writeFile } from "node:fs/promises";
import { callRagModel, createPublicAnswerModelEnv } from "../backend/ragModelClient.mjs";

const cases = ["low", "medium", "high", "xhigh", "max"].map((effort) => ({
  profile: `relay-gpt-6-astra-${effort}`,
  effort,
}));
cases.push({ profile: undefined, effort: "max" });
const records = [];

for (const [index, { profile, effort }] of cases.entries()) {
  test(`public Astra ${profile ? effort : "default without profile"} reaches serialized Chat Completions as ${effort}`, async () => {
    const record = { profile: profile ?? null, expectedEffort: effort, requests: [], pass: false };
    records.push(record);
    const prompt = "Synthetic transport contract check. No ruling question or evidence.";
    const env = createPublicAnswerModelEnv({
      RELAY_API_KEY: "synthetic-test-key",
      RELAY_BASE_URL: "https://relay.example.invalid/v1",
      RELAY_MAX_COMPLETION_TOKENS: "512",
      API_DAILY_BUDGET_CNY: "100",
      API_BUDGET_TIMEZONE: "UTC",
    }, profile);
    const result = await callRagModel({
      prompt,
      env,
      outputMode: "plain_text",
      now: new Date(Date.UTC(2095, 0, index + 1)),
      fetchImpl: async (url, options) => {
        assert.equal(typeof options.body, "string");
        const body = JSON.parse(options.body);
        record.requests.push({ url, method: options.method, serializedBody: options.body, body });
        assert.equal(record.requests.length, 1, "The public model path must issue only one request");
        assert.equal(url, "https://relay.example.invalid/v1/chat/completions");
        assert.equal(options.method, "POST");
        assert.deepEqual(body, {
          model: "gpt-6-astra",
          messages: [{ role: "user", content: prompt }],
          reasoning_effort: effort,
          max_completion_tokens: 512,
          stream: true,
          stream_options: { include_usage: true },
        });
        const chunk = { id: `synthetic-${index}`, model: "gpt-6-astra", choices: [{
          index: 0, finish_reason: "stop", delta: { content: "Synthetic response." },
        }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      },
    });
    assert.equal(record.requests.length, 1);
    assert.equal(record.requests[0].body.model, "gpt-6-astra");
    assert.equal(record.requests[0].body.reasoning_effort, effort);
    assert.equal(result.providerUsed, "relay");
    assert.equal(result.modelUsed, "gpt-6-astra");
    assert.equal(result.generationAttempts.length, 1);
    assert.equal(result.generationAttempts[0].finishReason, "stop");
    record.pass = true;
  });
}

after(async () => {
  if (!process.env.ASTRA_PROFILE_WIRE_TEST_REPORT) return;
  await writeFile(process.env.ASTRA_PROFILE_WIRE_TEST_REPORT, `${JSON.stringify({
    testedAt: new Date().toISOString(),
    path: "createPublicAnswerModelEnv -> callRagModel -> real serialized fetch body",
    scope: "Injected local fetch mock with synthetic input only",
    externalNetworkRequests: 0,
    total: records.length,
    passed: records.filter((record) => record.pass).length,
    records,
  }, null, 2)}\n`);
});
