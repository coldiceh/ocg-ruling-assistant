import assert from "node:assert/strict";
import test from "node:test";

import { createQaSnapshot } from "../backend/geminiQaTools.mjs";
import { createSourceBackedQaTools } from "../backend/geminiQaSourceRecords.mjs";

function baseTools(records, qaRevision, pageSize = 4) {
  const snapshot = createQaSnapshot({ records, qaRevision });
  snapshot.buildLexicalIndex();
  return snapshot.createQaTools({ pageSize });
}

function response(status, payload, revision = "source-r1") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "x-cache-revision" ? revision : null },
    json: async () => payload,
  };
}

function legacy(id, text = "fixture query") {
  return { id: `ygoresources-qa-${id}`, recordType: "qa", cardIds: ["7"], text };
}

function sourcePayload(id) {
  return {
    cards: [7, 8, 7],
    qaData: { ja: {
      id: Number(id),
      title: `題名 ${id}`,
      question: `質問 ${id}`,
      answer: `回答 ${id}`,
      date: "2026-09-13",
      extra: { preserved: true },
    } },
  };
}

test("a non-legacy local QA record performs no source request", async () => {
  let calls = 0;
  const qaTools = baseTools([{
    ...legacy("91001"), answer: "local answer", conclusion: "local conclusion",
  }], "base-full");
  const tools = createSourceBackedQaTools({ qaTools, fetchImpl: async () => { calls += 1; } });
  const page = await tools.search({ queries: ["fixture"] });
  assert.equal(calls, 0);
  assert.equal(page.items[0].record.answer, "local answer");
  assert.equal(tools.readSelected([page.items[0].handle])[0].record, page.items[0].record);
});

test("a legacy QA is fetched once and binds the full Japanese source object, URL, and revision", async () => {
  const calls = [];
  const qaTools = baseTools([legacy("91002")], "base-legacy");
  const tools = createSourceBackedQaTools({
    qaTools,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, sourcePayload("91002"), "source-r2");
    },
  });
  const page = await tools.search({ queries: ["fixture"] });
  const { record } = page.items[0];

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://db.ygoresources.com/data/qa/91002");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(record.id, "ygoresources-qa-91002");
  assert.equal(record.recordType, "qa");
  assert.deepEqual(record.cardIds, ["7", "8"]);
  assert.equal(record.sourceId, "91002");
  assert.equal(record.sourceName, "YGOResources DB");
  assert.equal(record.sourceUrl, calls[0].url);
  assert.equal(record.sourceRevision, "source-r2");
  assert.deepEqual(record.sourceQa, sourcePayload("91002").qaData.ja);
  assert.equal(Object.hasOwn(record, "title"), false);
  assert.equal(Object.hasOwn(record, "question"), false);
  assert.equal(Object.hasOwn(record, "answer"), false);
  assert.equal(Object.hasOwn(record, "official"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.equal(JSON.stringify(record).match(/題名 91002/gu).length, 1);
  assert.equal(JSON.stringify(record).match(/質問 91002/gu).length, 1);
  assert.equal(JSON.stringify(record).match(/回答 91002/gu).length, 1);
  assert.ok(Object.isFrozen(record));

  const selected = tools.readSelected([page.items[0].handle]);
  assert.equal(selected[0].record, record);
  assert.equal(calls.length, 1);
});

test("one request freezes its source result while the next request observes a newer source revision", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const payload = sourcePayload("91003");
    payload.qaData.ja.answer = `回答 version ${calls}`;
    return response(200, payload, `source-r${calls}`);
  };
  const first = createSourceBackedQaTools({
    qaTools: baseTools([legacy("91003")], "base-shared"), fetchImpl,
  });
  const second = createSourceBackedQaTools({
    qaTools: baseTools([legacy("91003")], "base-shared"), fetchImpl,
  });
  const firstPage = await first.search({ queries: ["fixture"] });
  const repeatedPage = await first.search({ queries: ["fixture"] });
  const secondPage = await second.search({ queries: ["fixture"] });
  assert.equal(calls, 2);
  assert.equal(firstPage.items[0].record.sourceRevision, "source-r1");
  assert.equal(repeatedPage.items[0].record, firstPage.items[0].record);
  assert.equal(repeatedPage.items[0].handle, firstPage.items[0].handle);
  assert.equal(secondPage.items[0].record.sourceRevision, "source-r2");
  assert.equal(secondPage.items[0].record.sourceQa.answer, "回答 version 2");
  assert.notEqual(secondPage.items[0].handle, firstPage.items[0].handle);
});

test("readSelected only accepts delivered handles and never performs network work", async () => {
  let calls = 0;
  const qaTools = baseTools([legacy("91004"), legacy("91005", "other")], "base-delivered", 1);
  const tools = createSourceBackedQaTools({
    qaTools,
    fetchImpl: async (_url) => {
      calls += 1;
      return response(200, sourcePayload("91004"));
    },
  });
  const page = await tools.search({ queries: ["fixture"] });
  assert.equal(calls, 1);
  assert.equal(tools.readSelected([page.items[0].handle])[0].record, page.items[0].record);
  assert.equal(calls, 1);
  const undelivered = qaTools.search({ queries: ["other"] }).items[0].handle;
  assert.throws(() => tools.readSelected([undelivered]), /handle_not_delivered/u);
});

test("readSelected relies on the base tool identity contract without imposing a hash format", async () => {
  const record = Object.freeze({
    id: "local-fixture", recordType: "qa", answer: "local", conclusion: "local",
  });
  const qaTools = Object.freeze({
    qaRevision: "base-arbitrary-handle",
    search: () => Object.freeze({
      qaRevision: "base-arbitrary-handle",
      items: Object.freeze([Object.freeze({ handle: "fixture-handle", record })]),
      handles: Object.freeze(["fixture-handle"]),
      nextCursor: null,
    }),
    readSelected: () => { throw new Error("base read must not be called"); },
  });
  const tools = createSourceBackedQaTools({ qaTools, fetchImpl: async () => { throw new Error("no fetch"); } });
  const page = await tools.search({ queries: ["fixture"] });
  assert.equal(tools.readSelected(["fixture-handle"])[0].record, record);
  assert.throws(() => tools.readSelected(["unknown-handle"]), /handle_not_delivered/u);
  assert.deepEqual(page.handles, ["fixture-handle"]);
});

test("source numeric ID mismatch is a binding hard failure", async () => {
  const tools = createSourceBackedQaTools({
    qaTools: baseTools([legacy("91006")], "base-id-mismatch"),
    fetchImpl: async () => response(200, sourcePayload("99999")),
  });
  await assert.rejects(tools.search({ queries: ["fixture"] }), /source_qa_id_binding_invalid/u);
});

test("missing source title, question, or answer is a mechanical schema failure", async () => {
  const payload = sourcePayload("91010");
  delete payload.qaData.ja.answer;
  const tools = createSourceBackedQaTools({
    qaTools: baseTools([legacy("91010")], "base-body-missing"),
    fetchImpl: async () => response(200, payload),
  });
  await assert.rejects(tools.search({ queries: ["fixture"] }), /source_qa_body_fields_invalid/u);
});

test("HTTP 429 remains explicit and is not cached", async () => {
  let calls = 0;
  const tools = createSourceBackedQaTools({
    qaTools: baseTools([legacy("91007")], "base-http-retry"),
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? response(429, {}) : response(200, sourcePayload("91007"));
    },
  });
  await assert.rejects(tools.search({ queries: ["fixture"] }), (error) => {
    assert.equal(error.code, "source_http_429");
    assert.equal(error.status, 429);
    return true;
  });
  const page = await tools.search({ queries: ["fixture"] });
  assert.equal(page.items[0].record.sourceQa.answer, "回答 91007");
  assert.equal(calls, 2);
});

test("404 is an independent unavailable page item without a stale body or handle", async () => {
  let calls = 0;
  const records = [legacy("91008"), {
    ...legacy("91009"), answer: "local answer", conclusion: "local conclusion",
  }];
  const tools = createSourceBackedQaTools({
    qaTools: baseTools(records, "base-unavailable", 4),
    fetchImpl: async () => { calls += 1; return response(404, {}); },
  });
  const page = await tools.search({ queries: ["fixture"] });
  await tools.search({ queries: ["fixture"] });
  const unavailable = page.items.find((item) => item.unavailable);
  const complete = page.items.find((item) => item.record);
  assert.deepEqual(unavailable, {
    unavailable: true,
    id: "ygoresources-qa-91008",
    recordType: "qa",
    sourceUrl: "https://db.ygoresources.com/data/qa/91008",
    httpStatus: 404,
  });
  assert.equal(Object.hasOwn(unavailable, "handle"), false);
  assert.equal(Object.hasOwn(unavailable, "record"), false);
  assert.equal(complete.record.answer, "local answer");
  assert.deepEqual(page.handles, [complete.handle]);
  assert.equal(calls, 1);
});

test("one page runs at most four source requests concurrently", async () => {
  let active = 0;
  let peak = 0;
  const records = Array.from({ length: 7 }, (_, index) => legacy(String(91100 + index)));
  const tools = createSourceBackedQaTools({
    qaTools: baseTools(records, "base-concurrency", 7),
    fetchImpl: async (url) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return response(200, sourcePayload(url.split("/").at(-1)));
    },
  });
  const page = await tools.search({ queries: ["fixture"] });
  assert.equal(page.items.length, 7);
  assert.equal(peak, 4);
});

test("one request abort does not poison a later request", async () => {
  const controller = new AbortController();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) await pending;
    return response(200, sourcePayload("91200"));
  };
  const first = createSourceBackedQaTools({
    qaTools: baseTools([legacy("91200")], "base-abort"), fetchImpl, signal: controller.signal,
  });
  const second = createSourceBackedQaTools({
    qaTools: baseTools([legacy("91200")], "base-abort"), fetchImpl,
  });
  const abortedSearch = first.search({ queries: ["fixture"] });
  controller.abort();
  await assert.rejects(abortedSearch, /source_request_aborted/u);
  const continuingSearch = second.search({ queries: ["fixture"] });
  const page = await continuingSearch;
  assert.equal(page.items[0].record.sourceQa.answer, "回答 91200");
  assert.equal(calls, 2);
  release();
});
