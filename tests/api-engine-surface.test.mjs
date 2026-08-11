import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/engine.js";

test("public engine endpoint does not expose direct scenario simulation", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("direct engine transport must not run");
  };

  try {
    const response = createResponse();
    await handler({
      method: "POST",
      body: { scenario: { seed: "must-not-be-forwarded" } },
    }, response);

    assert.equal(response.statusCode, 405);
    assert.deepEqual(response.payload, { error: "Method not allowed" });
    assert.equal(fetchCalls, 0);
    assert.equal(response.headers["access-control-allow-methods"], "GET,OPTIONS");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createResponse() {
  return {
    statusCode: 0,
    payload: null,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    end() {},
  };
}
