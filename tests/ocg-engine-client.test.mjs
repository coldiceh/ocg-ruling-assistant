import assert from "node:assert/strict";
import test from "node:test";

import { requestOcgEngineSimulation } from "../backend/ocgEngineClient.mjs";

const binding = {
  lockId: "1".repeat(64),
  snapshotId: "2".repeat(64),
  manifestSha256: "3".repeat(64),
  coreSha256: "4".repeat(64),
  dbSetSha256: "5".repeat(64),
  scriptSetSha256: "6".repeat(64),
  patchSetSha256: "7".repeat(64),
  apiAbi: "ocgcore/11.0",
};

test("engine simulation remains non-official evidence", async () => {
  const result = await requestOcgEngineSimulation({
    engineScenario: { seed: "test" },
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      simulation: {
        sourceType: "engine_simulation",
        canConfirmOfficialRuling: false,
        resourceBinding: binding,
        traceSha256: "8".repeat(64),
      },
    }), { status: 200 }),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.simulation.canConfirmOfficialRuling, false);
});

test("engine failure is explicit and does not invent a trace", async () => {
  const result = await requestOcgEngineSimulation({
    engineScenario: { seed: "test" },
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: async () => { throw new Error("connection refused"); },
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.simulation, undefined);
  assert.match(result.error.message, /connection refused/u);
});

test("engine is not contacted without an executable scenario", async () => {
  let called = false;
  const result = await requestOcgEngineSimulation({
    env: { OCG_ENGINE_URL: "http://127.0.0.1:8790" },
    fetchImpl: async () => { called = true; },
  });
  assert.equal(result.status, "not_requested");
  assert.equal(called, false);
});
