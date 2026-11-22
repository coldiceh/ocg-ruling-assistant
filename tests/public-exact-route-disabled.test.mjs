import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import handler from "../api/answer.js";
import {
  answerPublicRulingQuestion,
  PUBLIC_EXACT_QA_ROUTE_ENABLED,
} from "../backend/publicAnswerService.mjs";

test("public exact shortcut is disabled while the ordinary RAG answer still runs", async () => {
  let exactCalls = 0;
  let ragCalls = 0;
  const result = await answerPublicRulingQuestion({
    payload: { question: "官方原题入口停用后仍应执行普通资料检索。" },
    env: { MODEL_PROVIDER: "mock" },
    appendAudit: async () => null,
    classifyScope: async () => ({ scope: 'in_scope' }),
    answerOfficialExact: async () => {
      exactCalls += 1;
      return { answerLevel: "official_confirmed" };
    },
    answerRuling: async (options) => {
      ragCalls += 1;
      assert.equal(options.officialQaExactAlreadyChecked, true);
      return { mode: "rag_baseline", answerLevel: "rule_analysis", shortAnswer: "普通 RAG 回答" };
    },
  });

  assert.equal(PUBLIC_EXACT_QA_ROUTE_ENABLED, false);
  assert.equal(exactCalls, 0);
  assert.equal(ragCalls, 1);
  assert.equal(result.answer.shortAnswer, "普通 RAG 回答");
  assert.equal(result.latency.exactMatchMs, 0);
});

test("public exact mode remains rejected by the endpoint", async () => {
  for (const mode of ["exact", "official_qa_exact", "exact-only"]) {
    const response = createJsonResponse();
    await handler({
      method: "POST",
      body: { question: "直接旧模式不应恢复。", mode },
    }, response);

    assert.equal(response.statusCode, 400, mode);
    assert.equal(response.payload.code, "unsupported_answer_mode", mode);
  }
});

test("player page has no visible or operable exact-question entry", async () => {
  // public/ is generated from these sources by scripts/build-web-assets.mjs at deploy time.
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(html, /找原题/u, "index.html");
  assert.doesNotMatch(app, /\/api\/answer\/exact|mode\s*:\s*["']exact["']/u, "src/app.js");
  assert.match(app, /const backendMode = ["']rag["']/u);
});

function createJsonResponse() {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
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
