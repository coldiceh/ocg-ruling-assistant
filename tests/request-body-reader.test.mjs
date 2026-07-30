import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { readRequestBody } from "../backend/requestBodyReader.mjs";

test("declared oversized request bodies are rejected before stream listeners are attached", async () => {
  const request = new PassThrough();
  request.headers = { "content-length": "257" };
  let pauseCalls = 0;
  const originalPause = request.pause.bind(request);
  request.pause = () => {
    pauseCalls += 1;
    return originalPause();
  };

  await assert.rejects(
    readRequestBody(request, { maxBytes: 256 }),
    (error) => (
      error?.code === "request_body_too_large"
      && error?.details?.declaredBytes === 257
    ),
  );
  assert.equal(pauseCalls, 1);
  assert.equal(request.listenerCount("data"), 0);
  assert.equal(request.listenerCount("end"), 0);
  request.destroy();
});

test("streamed oversized request bodies stop reading and remove owned listeners", async () => {
  const request = new PassThrough();
  request.headers = {};
  const result = readRequestBody(request, { maxBytes: 16 });
  request.write(Buffer.alloc(8));
  request.write(Buffer.alloc(9));

  await assert.rejects(
    result,
    (error) => (
      error?.code === "request_body_too_large"
      && error?.details?.receivedBytes === 17
    ),
  );
  assert.equal(request.isPaused(), true);
  assert.equal(request.listenerCount("data"), 0);
  assert.equal(request.listenerCount("end"), 0);
  assert.equal(request.listenerCount("error"), 0);
  assert.equal(request.listenerCount("aborted"), 0);
  request.destroy();
});

test("bounded request body reader preserves valid UTF-8 input", async () => {
  const body = JSON.stringify({ question: "测试" });
  const request = new PassThrough();
  request.headers = { "content-length": String(Buffer.byteLength(body)) };
  const result = readRequestBody(request, { maxBytes: 256 });
  request.end(body);
  assert.equal(await result, body);
});

test("local admin 413 response closes and destroys the oversized request connection", async () => {
  const source = await readFile(new URL("../backend/server.mjs", import.meta.url), "utf8");
  assert.match(source, /response\.setHeader\("connection", "close"\)/u);
  assert.match(source, /response\.once\("finish", destroyRequest\)/u);
  assert.match(source, /response\.once\("close", destroyRequest\)/u);
  assert.match(source, /request\.destroy\(\)/u);
});
