import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createCloudRequestBudget,
  runOfficialLunaCardRequest,
} from "../../../backend/cloudRequestBudget.mjs";
import { createBenchFetch } from "../lib/bench-fetch.mjs";
import { createCostTracker } from "../lib/cost-tracker.mjs";
import { createMemoryLedgerStore } from "../lib/memory-ledger.mjs";
import { createMockResponder } from "../lib/mock-providers.mjs";

const LEDGER_URL = "https://bench-ledger.invalid/";
const pricingTable = { models: { "gpt-6-astra": {} }, aliases: {} };

function scopeEnv(extra = {}) {
  return {
    CLOUD_BUDGET_RUN_ID: "bench_test", CLOUD_BUDGET_PERIOD: "run",
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY: "100", CLOUD_BUDGET_THEORETICAL_LIMIT_USD: "100",
    UPSTASH_BUDGET_KV_REST_API_URL: LEDGER_URL, UPSTASH_BUDGET_KV_REST_API_TOKEN: "t",
    PUBLIC_OPENAI_BUDGET_RUN_ID: "bench_test", PUBLIC_OPENAI_DAILY_LIMIT_USD: "100",
    ...extra,
  };
}

async function withTracker(budgetUsd, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bench-ledger-"));
  try {
    const tracker = createCostTracker({ logPath: path.join(directory, "ledger.jsonl"), budgetUsd, pricingTable,
      sessionId: "s1" });
    await run(tracker, path.join(directory, "ledger.jsonl"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("production scope ledger reserves and settles against the in-process store", async () => {
  const store = createMemoryLedgerStore();
  const budget = createCloudRequestBudget({ env: scopeEnv(), command: async (args) => store.execute(args) });
  const raw = await budget.gemini({ body: { requests: [{}, {}] }, operation: "embed_content", model: "gemini-embedding-2",
    invoke: async () => ({ usageMetadata: { promptTokenCount: 1000 } }) });
  assert.deepEqual(raw, { usageMetadata: { promptTokenCount: 1000 } });
  const snapshot = budget.snapshot();
  assert.equal(snapshot.calls.length, 1);
  assert.equal(snapshot.calls[0].status, "usage_settled");
  assert.ok(Math.abs(snapshot.theoreticalUsd - 1000 * 0.2 / 1e6) < 1e-12);
  const fields = new Map(Object.entries(Object.fromEntries(
    chunk(store.execute(["HGETALL", "ruling-cloud-budget:v1:bench_test"]), 2))));
  assert.equal(fields.get("theoreticalNano"), String(Math.ceil(1000 * 0.2 / 1e6 * 1e9)));
  assert.equal(JSON.parse(fields.get(snapshot.calls[0].id)).status, "usage_settled");
  assert.equal(await budget.remainingPreparationUsd({ provider: "gemini" }), 100 - 1000 * 0.2 / 1e6);
});

function chunk(values, size) {
  const rows = [];
  for (let index = 0; index < values.length; index += size) rows.push(values.slice(index, index + size));
  return rows;
}

test("store blocks a reservation above the configured limit exactly like the Lua script", async () => {
  const store = createMemoryLedgerStore();
  const budget = createCloudRequestBudget({ env: scopeEnv({ CLOUD_BUDGET_THEORETICAL_LIMIT_USD: "0.000001" }),
    command: async (args) => store.execute(args) });
  await assert.rejects(budget.gemini({ body: { requests: [{}] }, operation: "embed_content", model: "gemini-embedding-2",
    invoke: async () => assert.fail("must not dispatch") }), /cloud_budget_total_exceeded/u);
  assert.throws(() => store.execute(["EVAL", "return 1", "0"]), /bench_ledger_script_unsupported/u);
  assert.throws(() => store.execute(["SET", "k", "v"]), /bench_ledger_command_unsupported/u);
});

test("official daily ledger runs through bench fetch, is attributed per job and logged", async () => {
  await withTracker(10, async (tracker, logPath) => {
    const store = createMemoryLedgerStore();
    let context;
    const fetchImpl = createBenchFetch({ mode: "mock", originalFetch: () => assert.fail("no network"), ledgerMode: "memory",
      ledgerUrls: [LEDGER_URL], memoryLedger: store, mockResponder: async () => null, tracker,
      getContext: () => context });
    context = { jobKey: "Q1__baseline__r1", network: [] };
    const result = await runOfficialLunaCardRequest({ env: scopeEnv(), fetchImpl,
      body: { model: "gpt-6-luna", input: "x", max_output_tokens: 100 },
      invoke: async () => ({ model: "gpt-6-luna", usage: { input_tokens: 1000, output_tokens: 100 } }) });
    assert.equal(result.model, "gpt-6-luna");
    const calls = tracker.jobCalls("Q1__baseline__r1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, "usage_settled");
    assert.equal(calls[0].provider, "openai");
    assert.equal(calls[0].priceSource, "backend_builtin_list_price");
    assert.ok(Math.abs(calls[0].costUsd - (1000 * 0.10 + 100 * 0.50) / 1e6) < 1e-9);
    assert.deepEqual(context.network.map((entry) => entry.command), ["EVAL:reserve", "EVAL:settle"]);
    const logged = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(logged.map((event) => event.type), ["reserve", "settle"]);
  });
});

test("bench budget blocks new reservations once spending reaches --budget-usd and marks the job", async () => {
  await withTracker(0.0001, async (tracker) => {
    const store = createMemoryLedgerStore();
    let context = { jobKey: "A", network: [] };
    const fetchImpl = createBenchFetch({ mode: "mock", originalFetch: () => assert.fail("no network"), ledgerMode: "memory",
      ledgerUrls: [LEDGER_URL], memoryLedger: store, mockResponder: async () => null, tracker,
      getContext: () => context });
    const call = () => runOfficialLunaCardRequest({ env: scopeEnv(), fetchImpl,
      body: { model: "gpt-6-luna", input: "x", max_output_tokens: 100 },
      invoke: async () => ({ model: "gpt-6-luna", usage: { input_tokens: 1000, output_tokens: 1000 } }) });
    await call(); // $0.0006 settled, above the $0.0001 budget
    context = { jobKey: "B", network: [] };
    await assert.rejects(call(), /official_daily_budget_exceeded/u);
    assert.equal(tracker.budgetExceeded, true);
    assert.ok(tracker.blockedJobs.has("B"));
    assert.equal(context.network[0].result, "blocked_by_bench_budget");
  });
});

test("upstash mode forwards ledger commands, observes settlements and blocks over budget without forwarding", async () => {
  await withTracker(0.000001, async (tracker) => {
    const upstash = createMemoryLedgerStore();
    const forwarded = [];
    const upstashUrl = "https://example-upstash.invalid";
    const originalFetch = async (url, init) => {
      forwarded.push(JSON.parse(init.body)[0]);
      assert.equal(String(url), `${upstashUrl}/`);
      return Response.json({ result: upstash.execute(JSON.parse(init.body)) });
    };
    const context = { jobKey: "Q2__toc__r1", network: [] };
    const fetchImpl = createBenchFetch({ mode: "real", originalFetch, ledgerMode: "upstash", ledgerUrls: [upstashUrl],
      memoryLedger: null, mockResponder: null, tracker, getContext: () => context });
    const env = scopeEnv({ UPSTASH_BUDGET_KV_REST_API_URL: upstashUrl });
    await runOfficialLunaCardRequest({ env, fetchImpl, body: { model: "gpt-6-luna", input: "x", max_output_tokens: 10 },
      invoke: async () => ({ model: "gpt-6-luna-2026-10-01", usage: { input_tokens: 10, output_tokens: 10 } }) });
    assert.deepEqual(forwarded, ["EVAL", "EVAL"]);
    assert.equal(tracker.jobCalls("Q2__toc__r1")[0].status, "usage_settled");
    // $0.000006 settled > $0.000001 budget: the next reservation never reaches Upstash.
    await assert.rejects(runOfficialLunaCardRequest({ env, fetchImpl,
      body: { model: "gpt-6-luna", input: "x", max_output_tokens: 10 },
      invoke: async () => assert.fail("must not dispatch") }), /official_daily_budget_exceeded/u);
    assert.deepEqual(forwarded, ["EVAL", "EVAL"]);
  });
});

test("mock responder fails closed for unknown hosts and echoes local card references", async () => {
  const responder = createMockResponder({ getContext: () => ({ question: "题面" }) });
  assert.equal(await responder(new URL("https://example.com/x"), { method: "GET" }), null);
  const prompt = ["你负责游戏王问题的提及抽取", "以下是本地匹配得到的卡库名称参考；input只是匹配到的题面片段",
    JSON.stringify([{ input: "黑蔷薇龙", name: "黑蔷薇龙", enName: "Black Rose Dragon" }]), "玩家问题：", "题面"].join("\n");
  const handled = await responder(new URL("https://api.openai.com/v1/responses"), { method: "POST",
    body: JSON.stringify({ model: "gpt-6-luna", input: prompt }) });
  assert.equal(handled.task, "card_name_extraction");
  const payload = await handled.response.json();
  const output = JSON.parse(payload.output[0].content[0].text);
  assert.deepEqual(output.cardNames.map((item) => [item.originalText, item.enName]), [["黑蔷薇龙", "Black Rose Dragon"]]);
  const fetchImpl = createBenchFetch({ mode: "mock", originalFetch: () => assert.fail("no network"), ledgerMode: "memory",
    ledgerUrls: [LEDGER_URL], memoryLedger: createMemoryLedgerStore(), mockResponder: responder,
    tracker: createCostTracker({ pricingTable, sessionId: "s" }), getContext: () => undefined,
    onUnattributedNetwork: () => {} });
  await assert.rejects(fetchImpl("https://example.com/x"), /bench_mock_unrouted_request/u);
});

test("mock input counting supports shared budgets without making a generation request", async () => {
  const responder = createMockResponder();
  const count = async (input) => {
    const result = await responder(new URL("https://api.openai.com/v1/responses/input_tokens"), {
      method: "POST", body: JSON.stringify({ model: "gpt-6-luna", input }),
    });
    assert.equal(result.task, "official_input_tokens");
    const payload = await result.response.json();
    assert.equal(payload.object, "response.input_tokens");
    assert.ok(Number.isSafeInteger(payload.input_tokens) && payload.input_tokens > 0);
    assert.equal(payload.output, undefined);
    assert.equal(payload.usage, undefined);
    return payload.input_tokens;
  };
  assert.ok(await count("reading material ".repeat(100)) > await count("short input"));
  const input = [{ role: "user", content: "read this material" }];
  const generated = await responder(new URL("https://api.openai.com/v1/responses"), {
    method: "POST", body: JSON.stringify({ model: "gpt-6-luna", input,
      max_output_tokens: 1000, prompt_cache_options: { key: "mock-cache" } }),
  });
  assert.equal((await generated.response.json()).usage.input_tokens, await count(input),
    "input counting and generation usage agree despite output/cache settings");
});

test("mock responder answers the rule-ToC request with unit 101 only when the table lists it", async () => {
  const responder = createMockResponder({ getContext: () => ({ question: "题面" }) });
  const tocRequest = (table, extraUser = []) => ({ method: "POST", body: JSON.stringify({ model: "gpt-6-luna", input: [
    { role: "system", content: "Return the response as JSON." },
    { role: "user", content: ['只输出JSON：{"unitIndexes":[目录中的序号整数],"note":"一句话说明"}', table,
      JSON.stringify({ question: "题面" })].join("\n\n") },
    ...extraUser.map((content) => ({ role: "user", content })),
  ] }) });
  const read = async (handled) => JSON.parse((await handled.response.json()).output[0].content[0].text);
  const listed = await responder(new URL("https://api.openai.com/v1/responses"),
    tocRequest(["100\tc02\t标题甲", "101\tc02\t同一时点适用"].join("\n")));
  assert.equal(listed.task, "rule_toc");
  assert.deepEqual(await read(listed), { unitIndexes: [101], note: "mock" });
  const short = await responder(new URL("https://api.openai.com/v1/responses"), tocRequest("1\tc01\t标题",
    ["只返回JSON对象，包含unitIndexes整数数组和note字符串。"]));
  assert.deepEqual(await read(short), { unitIndexes: [], note: "mock" });
  const selection = await responder(new URL("https://api.openai.com/v1/responses"), { method: "POST",
    body: JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: `说明\n${JSON.stringify({ groups: [] })}` }] }) });
  assert.equal(selection.task, "evidence_selection");
});
