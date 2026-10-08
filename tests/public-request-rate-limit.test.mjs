import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { enforcePublicRequestRateLimit, PUBLIC_REQUEST_RATE_LIMIT_LUA }
  from "../backend/publicRequestRateLimit.mjs";

const env = {
  VERCEL: "1", VERCEL_PROJECT_ID: "synthetic-project", VERCEL_ENV: "production",
  UPSTASH_REDIS_REST_URL: "https://synthetic.invalid",
  UPSTASH_REDIS_REST_TOKEN: "synthetic-redis-secret",
};
const request = (ip = "192.0.2.45") => ({ headers: { "x-vercel-forwarded-for": ip } });
const limited = (options = {}) => enforcePublicRequestRateLimit({ request: request(), env, ...options });
const unavailable = error => error.statusCode === 503 && /^public_request_/u.test(error.code);
const rateLimited = retry => error => error.statusCode === 429
  && error.code === "public_request_rate_limited" && error.retryAfterSeconds === retry;

function transport() {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, options) {
      const args = JSON.parse(options.body);
      calls.push({ url, options, args });
      const windows = Number(args[5]);
      return Response.json({ result: ["allowed", 0,
        ...Array.from({ length: windows }, (_, index) => Number(args[7 + index * 2]) - 1)] });
    },
  };
}

test("status is free; default windows cover every paid action and new-question aliases", async () => {
  assert.deepEqual(await enforcePublicRequestRateLimit({ action: "status", env: {} }),
    { ok: true, exempt: true, action: "status" });
  const redis = transport();
  for (const action of [undefined, "answer", "prepare", "finalize", "translate_source"]) {
    const result = await limited({ action, fetchImpl: redis.fetchImpl });
    const hourly = action === "finalize" ? 60 : action === "translate_source" ? 120 : 30;
    const minute = ["finalize", "translate_source"].includes(action) ? 30 : 6;
    assert.deepEqual(result.windows, [
      { seconds: 60, limit: minute, remaining: minute - 1 },
      { seconds: 3600, limit: hourly, remaining: hourly - 1 },
    ]);
    assert.equal(JSON.stringify(result).includes("192.0.2.45"), false);
  }
  assert.equal(redis.calls[0].args[3], redis.calls[1].args[3]);
  assert.equal(redis.calls[1].args[3], redis.calls[2].args[3]);
  assert.notEqual(redis.calls[2].args[3], redis.calls[3].args[3]);
  assert.notEqual(redis.calls[3].args[3], redis.calls[4].args[3]);
  for (const { url, options, args } of redis.calls) {
    assert.equal(url, env.UPSTASH_REDIS_REST_URL);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer synthetic-redis-secret");
    assert.deepEqual(args.slice(0, 3), ["EVAL", PUBLIC_REQUEST_RATE_LIMIT_LUA, 1]);
    assert.match(args[3], /:[a-f0-9]{64}$/u);
    assert.match(args[4], /^[a-f0-9]{32}$/u);
    assert.equal(args.join(" ").includes("192.0.2.45"), false);
    assert.equal(args.join(" ").includes("synthetic-redis-secret"), false);
  }
});

test("Vercel trusts only a single platform address, ignoring forged forwarding/body values", async () => {
  const redis = transport();
  for (const headers of [
    {}, { "x-forwarded-for": "192.0.2.45" }, { "x-real-ip": "192.0.2.45" },
    { "x-vercel-forwarded-for": "192.0.2.45, 192.0.2.46" },
    { "x-vercel-forwarded-for": ["192.0.2.45"] },
    { "x-vercel-forwarded-for": "192.0.2.45", "X-Vercel-Forwarded-For": "192.0.2.46" },
    { "x-vercel-forwarded-for": "fe80::1%eth0" }, { "x-vercel-forwarded-for": "[::1]" },
    { "x-vercel-forwarded-for": "0127.0.0.1" }, { "x-vercel-forwarded-for": "unknown" },
  ]) await assert.rejects(limited({ request: { headers, body: { ip: "192.0.2.45" },
    socket: { remoteAddress: "192.0.2.45" } }, fetchImpl: redis.fetchImpl }), unavailable);
  assert.equal(redis.calls.length, 0);
  await limited({ request: { headers: new Headers({ "x-vercel-forwarded-for": "192.0.2.45",
    "x-forwarded-for": "198.51.100.1" }), body: { ip: "203.0.113.2" } }, fetchImpl: redis.fetchImpl });
  await limited({ fetchImpl: redis.fetchImpl });
  assert.equal(redis.calls[0].args[3], redis.calls[1].args[3]);
});

test("local requests use the socket; mapped IPv4 and equivalent IPv6 /64 share keys", async () => {
  const redis = transport();
  const localEnv = { ...env, VERCEL: "0" };
  await assert.rejects(limited({ env: localEnv, fetchImpl: redis.fetchImpl }), unavailable);
  for (const ip of ["192.0.2.45", "::ffff:192.0.2.45", "0:0:0:0:0:ffff:c000:22d"]) {
    await limited({ env: localEnv, request: { ...request("198.51.100.20"), socket: { remoteAddress: ip } },
      fetchImpl: redis.fetchImpl });
  }
  assert.equal(new Set(redis.calls.map(call => call.args[3])).size, 1);
  redis.calls.length = 0;
  for (const ip of ["2001:db8:12:34::1", "2001:0DB8:0012:0034:FFFF:0:0:2", "2001:db8:12:34::192.0.2.1"]) {
    await limited({ request: request(ip), fetchImpl: redis.fetchImpl });
  }
  assert.equal(new Set(redis.calls.map(call => call.args[3])).size, 1);
  await limited({ request: request("2001:db8:12:35::1"), fetchImpl: redis.fetchImpl });
  assert.notEqual(redis.calls[0].args[3], redis.calls[3].args[3]);
});

test("namespace survives deployments and isolates environments; HMAC secret changes pseudonym", async () => {
  const redis = transport();
  for (const extra of [{ VERCEL_DEPLOYMENT_ID: "dpl_1", VERCEL_URL: "one.invalid" },
    { VERCEL_DEPLOYMENT_ID: "dpl_2", VERCEL_URL: "two.invalid" }, { VERCEL_ENV: "preview" },
    { PUBLIC_REQUEST_RATE_LIMIT_NAMESPACE: "custom-stable" }, { PUBLIC_REQUEST_RATE_LIMIT_HMAC_SECRET: "other-secret" }]) {
    await limited({ env: { ...env, ...extra }, fetchImpl: redis.fetchImpl });
  }
  assert.equal(redis.calls[0].args[3], redis.calls[1].args[3]);
  assert.notEqual(redis.calls[0].args[3], redis.calls[2].args[3]);
  assert.match(redis.calls[3].args[3], /:custom-stable:/u);
  assert.notEqual(redis.calls[0].args[3], redis.calls[4].args[3]);
});

test("positive integer limit overrides work; invalid configuration fails closed without a request", async () => {
  const redis = transport();
  for (const [action, prefix] of [["prepare", "NEW"], ["finalize", "FINALIZE"], ["translate_source", "TRANSLATE"]]) {
    const result = await limited({ action, env: { ...env,
      [`PUBLIC_REQUEST_RATE_LIMIT_${prefix}_PER_MINUTE`]: "2",
      [`PUBLIC_REQUEST_RATE_LIMIT_${prefix}_PER_HOUR`]: "3" }, fetchImpl: redis.fetchImpl });
    assert.deepEqual(result.windows.map(window => window.limit), [2, 3]);
  }
  redis.calls.length = 0;
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "01", " 2", "9007199254740992", false]) {
    await assert.rejects(limited({ env: { ...env, PUBLIC_REQUEST_RATE_LIMIT_NEW_PER_MINUTE: value },
      fetchImpl: redis.fetchImpl }), unavailable);
  }
  for (const extra of [{ UPSTASH_REDIS_REST_URL: "" }, { UPSTASH_REDIS_REST_TOKEN: "" },
    { UPSTASH_REDIS_REST_URL: "http://synthetic.invalid" },
    { UPSTASH_REDIS_REST_URL: "https://user:secret@synthetic.invalid" },
    { UPSTASH_REDIS_REST_URL: "https://synthetic.invalid/?token=secret" },
    { PUBLIC_REQUEST_RATE_LIMIT_NAMESPACE: "bad{namespace}" },
    { PUBLIC_REQUEST_RATE_LIMIT_REDIS_TIMEOUT_MS: "10001" }]) {
    await assert.rejects(limited({ env: { ...env, ...extra }, fetchImpl: redis.fetchImpl }), unavailable);
  }
  await assert.rejects(limited({ action: "private", fetchImpl: redis.fetchImpl }), unavailable);
  assert.equal(redis.calls.length, 0);
});

test("Redis failures and malformed results never authorize or retry or expose backend errors", async () => {
  for (const response of [new Response("failure with secret", { status: 500 }),
    new Response("not-json"), Response.json({ error: "backend-secret" }), Response.json({}),
    ...[null, [], ["allowed", 0], ["allowed", 0, 6, 29], ["allowed", 0, 5, -1],
      ["blocked", 0], ["blocked", 3600001], ["blocked", "1000"], ["unexpected"]]
      .map(result => Response.json({ result }))]) {
    let calls = 0;
    await assert.rejects(limited({ fetchImpl: async () => { calls += 1; return response; } }), error => {
      assert.equal(error.message.includes("secret"), false);
      return unavailable(error);
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(limited({ fetchImpl: async () => { calls += 1; throw new Error("secret"); } }), unavailable);
  assert.equal(calls, 1);
  await assert.rejects(limited({ fetchImpl: async () => Response.json({ result: ["blocked", 1001] }) }), rateLimited(2));
});

test("pre-abort and in-flight abort stop work; Redis timeout fails closed", async () => {
  const controller = new AbortController();
  const reason = new Error("client disconnected");
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(limited({ signal: controller.signal, fetchImpl: async () => { calls += 1; } }),
    error => error === reason);
  assert.equal(calls, 0);
  const during = new AbortController();
  const pending = limited({ signal: during.signal, fetchImpl: async (_url, { signal }) => {
    during.abort(reason);
    signal.throwIfAborted();
  } });
  await assert.rejects(pending, error => error === reason);
  await assert.rejects(limited({ env: { ...env, PUBLIC_REQUEST_RATE_LIMIT_REDIS_TIMEOUT_MS: "5" },
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) }), unavailable);
});

const python = process.env.CLOUD_BUDGET_LUA_PYTHON;
function luaRedis(t) {
  const helper = fileURLToPath(new URL("./helpers/public-request-rate-limit-lua.py", import.meta.url));
  const child = spawn(python, [helper], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = [];
  let failure;
  let atMs = 1_800_000_000_000;
  const commands = [];
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const fail = error => {
    failure = error;
    while (pending.length) pending.shift().reject(error);
  };
  createInterface({ input: child.stdout }).on("line", line => {
    const callback = pending.shift();
    if (!callback) return;
    const reply = JSON.parse(line);
    if (reply.error) callback.reject(new Error(reply.error));
    else callback.resolve(reply.result);
  });
  child.on("error", fail);
  child.on("exit", code => fail(new Error(`Lua adapter exited ${code}: ${stderr}`)));
  t.after(() => child.kill());
  const command = args => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    pending.push({ resolve, reject });
    child.stdin.write(`${JSON.stringify({ args, atMs })}\n`);
  });
  return {
    commands, advance: ms => { atMs += ms; }, command,
    fetchImpl: async (_url, options) => {
      const args = JSON.parse(options.body);
      commands.push(args);
      return Response.json({ result: await command(args) });
    },
  };
}

test("production Lua atomically admits only six of 40 concurrent new questions and obeys exact rolling boundaries",
  { skip: !python }, async t => {
    const redis = luaRedis(t);
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) =>
      limited({ action: index % 2 ? "prepare" : undefined, fetchImpl: redis.fetchImpl })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 6);
    const rejections = results.filter(result => result.status === "rejected");
    assert.equal(rejections.length, 34);
    assert.ok(rejections.every(result => rateLimited(60)(result.reason)));
    assert.equal(await redis.command(["PTTL", redis.commands[0][3]]), 3600000);
    redis.advance(59999);
    await assert.rejects(limited({ fetchImpl: redis.fetchImpl }), rateLimited(1));
    redis.advance(1);
    const next = await limited({ fetchImpl: redis.fetchImpl });
    assert.equal(next.windows[0].remaining, 5);
    assert.equal(next.windows[1].remaining, 23);
  });

test("production Lua enforces the hour cap despite minute resets and rejection floods",
  { skip: !python }, async t => {
    const redis = luaRedis(t);
    for (let batch = 0; batch < 5; batch += 1) {
      await Promise.all(Array.from({ length: 6 }, () => limited({ fetchImpl: redis.fetchImpl })));
      redis.advance(60000);
    }
    const rejected = await Promise.allSettled(Array.from({ length: 12 }, () => limited({ fetchImpl: redis.fetchImpl })));
    assert.ok(rejected.every(result => result.status === "rejected" && rateLimited(3300)(result.reason)));
    redis.advance(3299999);
    await assert.rejects(limited({ fetchImpl: redis.fetchImpl }), rateLimited(1));
    redis.advance(1);
    const results = await Promise.allSettled(Array.from({ length: 7 }, () => limited({ fetchImpl: redis.fetchImpl })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 6);
    assert.ok(rateLimited(60)(results.find(result => result.status === "rejected").reason));
  });

test("production Lua gives finalize and translation independent minute/hour quotas",
  { skip: !python }, async t => {
    const redis = luaRedis(t);
    const config = { ...env, PUBLIC_REQUEST_RATE_LIMIT_FINALIZE_PER_MINUTE: "2",
      PUBLIC_REQUEST_RATE_LIMIT_FINALIZE_PER_HOUR: "3", PUBLIC_REQUEST_RATE_LIMIT_TRANSLATE_PER_MINUTE: "2",
      PUBLIC_REQUEST_RATE_LIMIT_TRANSLATE_PER_HOUR: "4" };
    const call = action => limited({ action, env: config, fetchImpl: redis.fetchImpl });
    for (const action of ["finalize", "translate_source"]) {
      await Promise.all([call(action), call(action)]);
      await assert.rejects(call(action), rateLimited(60));
    }
    await call("prepare");
    redis.advance(60000);
    await call("finalize");
    await assert.rejects(call("finalize"), rateLimited(3540));
    await Promise.all([call("translate_source"), call("translate_source")]);
    await assert.rejects(call("translate_source"), rateLimited(3540));
  });

test("production Lua shares mapped IPv4 and /64 quota, and retries correctly when an administrator lowers limits",
  { skip: !python }, async t => {
    const redis = luaRedis(t);
    await Promise.all(Array.from({ length: 6 }, (_, index) => limited({
      request: request(index % 2 ? "::ffff:c000:22d" : "192.0.2.45"), fetchImpl: redis.fetchImpl })));
    await assert.rejects(limited({ request: request("::ffff:192.0.2.45"), fetchImpl: redis.fetchImpl }), rateLimited(60));
    for (let index = 0; index < 6; index += 1) {
      await limited({ request: request(`2001:db8:1:2::${index + 1}`), fetchImpl: redis.fetchImpl });
      redis.advance(1000);
    }
    await assert.rejects(limited({ request: request("2001:0db8:0001:0002:ffff::1"),
      env: { ...env, PUBLIC_REQUEST_RATE_LIMIT_NEW_PER_MINUTE: "3" }, fetchImpl: redis.fetchImpl }), rateLimited(57));
    await limited({ request: request("2001:db8:1:3::1"), fetchImpl: redis.fetchImpl });
  });
