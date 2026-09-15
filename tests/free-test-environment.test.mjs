import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FREE_TEST_INHERITED_ENV_NAMES,
  isolateFreeTestEnvironment,
} from "../scripts/lib/free-test-environment.mjs";

test("free-test isolation removes only inherited Relay sentinels", () => {
  const inherited = {
    RELAY_API_KEY: "sentinel-key",
    RELAY_BASE_URL: "https://relay.invalid/v1",
    FREE_TEST_OTHER_SENTINEL: "keep-me",
  };
  const explicitFixture = {
    RAG_RULE_MODEL_PROVIDER: "relay",
    RELAY_API_KEY: "fixture-key",
    RELAY_BASE_URL: "https://relay.invalid/v1",
  };

  isolateFreeTestEnvironment(inherited);

  for (const name of FREE_TEST_INHERITED_ENV_NAMES) {
    assert.equal(inherited[name], undefined);
  }
  assert.equal(inherited.FREE_TEST_OTHER_SENTINEL, "keep-me");
  assert.equal(explicitFixture.RAG_RULE_MODEL_PROVIDER, "relay");
  assert.equal(explicitFixture.RELAY_API_KEY, "fixture-key");
  assert.equal(explicitFixture.RELAY_BASE_URL, "https://relay.invalid/v1");
});

test("a child process can apply free-test isolation without network access", () => {
  const helperUrl = pathToFileURL(
    path.resolve("scripts/lib/free-test-environment.mjs"),
  ).href;
  const childCode = `(async () => {
    const { isolateFreeTestEnvironment } = await import(${JSON.stringify(helperUrl)});
    isolateFreeTestEnvironment(process.env);
    if (process.env.RELAY_API_KEY || process.env.RELAY_BASE_URL) process.exit(2);
    if (process.env.FREE_TEST_OTHER_SENTINEL !== "keep-me") process.exit(3);
  })().catch(() => process.exit(4));`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", childCode],
    {
      cwd: path.resolve("."),
      env: {
        RELAY_API_KEY: "sentinel-key",
        RELAY_BASE_URL: "https://relay.invalid/v1",
        FREE_TEST_OTHER_SENTINEL: "keep-me",
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});
