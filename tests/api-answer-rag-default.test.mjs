import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/answer.js";

test("api_answer_defaults_to_rag_baseline", async () => {
  const previousProvider = process.env.MODEL_PROVIDER;
  process.env.MODEL_PROVIDER = "mock";
  try {
    const response = createJsonResponse();
    await handler({
      method: "POST",
      body: { question: "「宇宙耀变龙」的效果能否结算？" },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.mode, "rag_baseline");
    assert.equal(response.payload.debug.providerUsed, "mock");
  } finally {
    if (previousProvider === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = previousProvider;
  }
});

test("api_answer_reports_engine_availability_from_backend_configuration", async () => {
  const previousUrl = process.env.OCG_ENGINE_URL;
  const previousAuto = process.env.RAG_AUTO_ENGINE_SIMULATION;
  try {
    delete process.env.OCG_ENGINE_URL;
    delete process.env.RAG_AUTO_ENGINE_SIMULATION;
    const disabled = createJsonResponse();
    await handler({ method: "GET" }, disabled);
    assert.equal(disabled.payload.engineEnabled, false);

    process.env.OCG_ENGINE_URL = "https://engine.example.test";
    const enabled = createJsonResponse();
    await handler({ method: "GET" }, enabled);
    assert.equal(enabled.payload.engineEnabled, true);

    process.env.RAG_AUTO_ENGINE_SIMULATION = "false";
    const optedOut = createJsonResponse();
    await handler({ method: "GET" }, optedOut);
    assert.equal(optedOut.payload.engineEnabled, false);
  } finally {
    if (previousUrl === undefined) delete process.env.OCG_ENGINE_URL;
    else process.env.OCG_ENGINE_URL = previousUrl;
    if (previousAuto === undefined) delete process.env.RAG_AUTO_ENGINE_SIMULATION;
    else process.env.RAG_AUTO_ENGINE_SIMULATION = previousAuto;
  }
});
function createJsonResponse() {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}
