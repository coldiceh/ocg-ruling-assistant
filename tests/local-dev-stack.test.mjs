import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCompatibleLegacyLuaCapabilities,
  assertCompatibleEngineHealth,
  createLocalStackChildEnvironments,
  createManagedEngineToken,
  isTcpPortListening,
  probeEngineHealth,
  probeLegacyLuaCapabilities,
  resolveLocalStackSettings,
} from "../scripts/start-with-ocg-engine.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("local stack gives backend, frontend and engine distinct default ports", () => {
  const settings = resolveLocalStackSettings({ PORT: "8787" });
  assert.equal(settings.backendPort, 8787);
  assert.equal(settings.frontendPort, 4173);
  assert.equal(settings.enginePort, 8790);
  assert.equal(settings.engineUrl, "http://127.0.0.1:8790");
});

test("local stack shares one opaque engine token without exposing it to frontend", () => {
  const settings = resolveLocalStackSettings({});
  const token = createManagedEngineToken();
  const children = createLocalStackChildEnvironments({
    env: {
      PATH: "runtime-path",
      NODE_OPTIONS: "--max-old-space-size=768",
      RELAY_API_KEY: "relay-secret",
      RELAY_BASE_URL: "https://private-relay.example/v1",
      ADMIN_RELAY_BASE_URL: "https://private-admin-relay.example/v1",
      DEEPSEEK_API_KEY: "deepseek-secret",
      UPSTASH_REDIS_REST_URL: "https://private-upstash.example",
      UPSTASH_REDIS_REST_TOKEN: "upstash-secret",
      DATABASE_URL: "postgres://user:password@private-db.example/database",
    },
    settings,
    engineToken: token,
  });
  assert.equal(children.engine.PATH, "runtime-path");
  assert.equal(children.engine.NODE_OPTIONS, "--max-old-space-size=768");
  assert.equal(children.engine.OCG_ENGINE_TOKEN, token);
  assert.equal(children.engine.RELAY_API_KEY, undefined);
  assert.equal(children.engine.RELAY_BASE_URL, undefined);
  assert.equal(children.engine.ADMIN_RELAY_BASE_URL, undefined);
  assert.equal(children.engine.DEEPSEEK_API_KEY, undefined);
  assert.equal(children.engine.UPSTASH_REDIS_REST_URL, undefined);
  assert.equal(children.engine.UPSTASH_REDIS_REST_TOKEN, undefined);
  assert.equal(children.engine.DATABASE_URL, undefined);
  assert.equal(children.backend.OCG_ENGINE_TOKEN, token);
  assert.equal(children.backend.RELAY_API_KEY, "relay-secret");
  assert.equal(children.backend.RELAY_BASE_URL, "https://private-relay.example/v1");
  assert.equal(children.backend.DEEPSEEK_API_KEY, "deepseek-secret");
  assert.equal(children.backend.UPSTASH_REDIS_REST_URL, "https://private-upstash.example");
  assert.equal(children.backend.DATABASE_URL, "postgres://user:password@private-db.example/database");
  assert.equal(children.backend.ADMIN_ALLOWED_ORIGINS, "http://127.0.0.1:4173");
  assert.equal(children.frontend.PATH, "runtime-path");
  assert.equal(children.frontend.NODE_OPTIONS, "--max-old-space-size=768");
  assert.equal(children.frontend.OCG_ENGINE_TOKEN, undefined);
  assert.equal(children.frontend.RELAY_API_KEY, undefined);
  assert.equal(children.frontend.RELAY_BASE_URL, undefined);
  assert.equal(children.frontend.ADMIN_RELAY_BASE_URL, undefined);
  assert.equal(children.frontend.DEEPSEEK_API_KEY, undefined);
  assert.equal(children.frontend.UPSTASH_REDIS_REST_URL, undefined);
  assert.equal(children.frontend.UPSTASH_REDIS_REST_TOKEN, undefined);
  assert.equal(children.frontend.DATABASE_URL, undefined);
  assert.equal(children.frontend.LOCAL_BACKEND_URL, "http://127.0.0.1:8787");
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/u);
});

test("local stack preserves configured admin origins and appends its exact frontend origin", () => {
  const settings = resolveLocalStackSettings({});
  const children = createLocalStackChildEnvironments({
    env: { ADMIN_ALLOWED_ORIGINS: "https://coldiceh.github.io" },
    settings,
    engineToken: "test-token",
  });
  assert.equal(
    children.backend.ADMIN_ALLOWED_ORIGINS,
    "https://coldiceh.github.io,http://127.0.0.1:4173",
  );
});

test("relay launcher provisions the same admin session credential used by the web login", async () => {
  const launcher = await readFile(path.join(root, "scripts", "start-local-relay.ps1"), "utf8");
  assert.match(launcher, /\$env:ADMIN_SESSION_PASSWORD/u);
  assert.match(launcher, /\$env:API_ADMIN_PASSWORD/u);
  assert.doesNotMatch(launcher, /\$env:ADMIN_PASSWORD\s*=/u);
  assert.match(launcher, /\$env:ADMIN_MODEL_LAB_ENABLED = "true"/u);
  assert.match(launcher, /Read-Host -Prompt "输入朋友提供的中转 Base URL/u);
  assert.match(launcher, /Read-Host -Prompt "粘贴 DeepSeek API key[^\r\n]+" -AsSecureString/u);
  assert.match(launcher, /Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue/u);
  for (const model of ["SOL", "TERRA", "LUNA"]) {
    assert.match(
      launcher,
      new RegExp(`ADMIN_FINAL_BUDGET_RELAY_${model}_DAILY_CNY\\)\\) \\{\\s*\\$env:ADMIN_FINAL_BUDGET_RELAY_${model}_DAILY_CNY = "10"`, "u"),
    );
    assert.match(
      launcher,
      new RegExp(`ADMIN_FINAL_BUDGET_RELAY_${model}_RESERVATION_CNY\\)\\) \\{\\s*\\$env:ADMIN_FINAL_BUDGET_RELAY_${model}_RESERVATION_CNY = "5"`, "u"),
    );
  }
  assert.match(launcher, /RELAY_MAX_COMPLETION_TOKENS\)\) \{\s*\$env:RELAY_MAX_COMPLETION_TOKENS = "8192"/u);
  assert.match(launcher, /RELAY_STREAM_TIMEOUT_MS\)\) \{\s*\$env:RELAY_STREAM_TIMEOUT_MS = "270000"/u);
  assert.match(launcher, /ADMIN_MODEL_LAB_SYNC_FINAL_TIMEOUT_MS\)\) \{\s*\$env:ADMIN_MODEL_LAB_SYNC_FINAL_TIMEOUT_MS = "290000"/u);
  assert.match(launcher, /ADMIN_MODEL_LAB_USD_TO_CNY_RATE\)\) \{\s*\$env:ADMIN_MODEL_LAB_USD_TO_CNY_RATE = "7\.5"/u);
  assert.match(launcher, /ADMIN_FINAL_BUDGET_DEEPSEEK_DAILY_CNY\)\) \{\s*\$env:ADMIN_FINAL_BUDGET_DEEPSEEK_DAILY_CNY = "10"/u);
  assert.match(launcher, /ADMIN_FINAL_BUDGET_DEEPSEEK_RESERVATION_CNY\)\) \{\s*\$env:ADMIN_FINAL_BUDGET_DEEPSEEK_RESERVATION_CNY = "2"/u);
  assert.match(launcher, /ADMIN_MODEL_LAB_DEEPSEEK_FLASH_INPUT_CNY_PER_MTOK = "1"/u);
  assert.match(launcher, /ADMIN_MODEL_LAB_DEEPSEEK_PRO_OUTPUT_CNY_PER_MTOK = "6"/u);
});

test("Vercel deployment pins the Relay deadline ladder below the function limit", async () => {
  const config = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
  assert.equal(config.buildCommand, "pnpm run check:rag-revision && pnpm run check:rag-runtime");
  assert.equal(config.env.RELAY_STREAM_TIMEOUT_MS, "270000");
  assert.equal(config.env.ADMIN_MODEL_LAB_SYNC_FINAL_TIMEOUT_MS, "290000");
  assert.equal(config.env.RAG_RUNTIME_BUNDLE_REQUIRED, "true");
  assert.equal(config.functions["api/admin-model-lab.js"].maxDuration, 300);
  assert.equal(config.functions["api/answer.js"].maxDuration, 300);
  for (const route of ["api/answer.js", "api/admin-model-lab.js"]) {
    const included = config.functions[route].includeFiles;
    const excluded = config.functions[route].excludeFiles;
    assert.match(included, /data\/rag-data-revision-manifest\.json/u);
    assert.match(included, /data\/rag-runtime-v1\/\*\*/u);
    assert.doesNotMatch(included, /data\/(?:cards|rulings|qa-index|evidence-index|ocg-rule-corpus|official-responses)\.json/u);
    for (const rawSource of [
      "cards",
      "rulings",
      "qa-index",
      "evidence-index",
      "ocg-rule-corpus",
      "official-responses",
    ]) {
      assert.match(excluded, new RegExp(`(?:^|[,{}])${rawSource}(?:[,{}]|\\.json)`, "u"));
    }
    assert.doesNotMatch(excluded, /rag-data-revision-manifest|rag-runtime-v1|legacy-lua-semantic-cache-v2/u);
  }
});

test("engine health probe and compatibility check identify a reusable engine", async (t) => {
  const token = "test-token";
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      service: "ocg-engine",
      profile: { id: "ygopro" },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(await isTcpPortListening({ port: address.port }), true);
  const probe = await probeEngineHealth({
    engineUrl: `http://127.0.0.1:${address.port}`,
    engineToken: token,
  });
  assert.equal(assertCompatibleEngineHealth(probe, "ygopro").profile.id, "ygopro");
  assert.throws(
    () => assertCompatibleEngineHealth(probe, "ygopro2"),
    /profile mismatch/u,
  );
});

test("local stack verifies the versioned legacy Lua capability before declaring readiness", async (t) => {
  const token = "test-token";
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
      return;
    }
    if (request.url !== "/formal/v1/legacy-lua/capabilities") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      schemaVersion: "ocg-legacy-lua-http-capabilities/v1",
      kind: "LEGACY_LUA_HTTP_CAPABILITIES",
      authority: "LEGACY_DISCOVERY_ONLY",
      verdict: "UNKNOWN",
      legacyAcceptedAsTruth: false,
      sourceResolution: { lockedExactCardNames: true },
      endpoints: {
        cardIdentities: {
          path: "/formal/v1/legacy-lua/card-identities",
          method: "POST",
        },
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const probe = await probeLegacyLuaCapabilities({
    engineUrl: `http://127.0.0.1:${address.port}`,
    engineToken: token,
  });
  assert.equal(
    assertCompatibleLegacyLuaCapabilities(probe).endpoints.cardIdentities.method,
    "POST",
  );

  assert.throws(
    () => assertCompatibleLegacyLuaCapabilities({
      ...probe,
      payload: {
        ...probe.payload,
        endpoints: {},
      },
    }),
    /lacks locked exact-name/u,
  );
});

test("local static server injects backend endpoints without changing config.json", async (t) => {
  const reserved = createServer();
  await new Promise((resolve) => reserved.listen(0, "127.0.0.1", resolve));
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const child = spawn(process.execPath, [path.join(root, "scripts", "serve.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      LOCAL_BACKEND_URL: "http://127.0.0.1:8787",
    },
    stdio: "ignore",
    windowsHide: true,
  });
  t.after(() => child.kill("SIGTERM"));
  const config = await pollJson(`http://127.0.0.1:${port}/config.json`);
  assert.equal(config.answerApiUrl, "http://127.0.0.1:8787/api/answer");
  assert.equal(config.budgetApiUrl, "http://127.0.0.1:8787/api/budget");
});

async function pollJson(url) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // The child may not be listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${url}`);
}
