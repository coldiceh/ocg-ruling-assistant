import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const client = app.slice(
  app.indexOf("async function requestBackendAnswer"),
  app.indexOf("function renderPending"),
);

function createClient(fetchImpl, {
  selectedProfile = "relay-gpt-6-astra-max",
  requestId = null,
  onPrepared = null,
} = {}) {
  return new Function("fetch", "TextDecoder", "onPrepared", `
    const appConfig = { answerApiUrl: "https://example.invalid/api/answer" };
    let selectedRulingModelProfile = ${JSON.stringify(selectedProfile)};
    let analysisRequestId = ${JSON.stringify(requestId ?? 0)};
    const preparedProgress = [];
    function applyPendingStageProgressEvent() {}
    function applyPreparedProgress(progress) {
      preparedProgress.push(progress);
      if (typeof onPrepared === "function") onPrepared(progress);
    }
    function readFiniteDuration(value) {
      if (value === null || value === undefined || value === "") return null;
      const duration = Number(value);
      return Number.isFinite(duration) && duration >= 0 ? duration : null;
    }
    ${client}
    return {
      request: requestBackendAnswer,
      preparedProgress,
      setAnalysisRequestId(value) { analysisRequestId = value; },
      getAnalysisRequestId() { return analysisRequestId; },
      getSelectedProfile() { return selectedRulingModelProfile; },
    };
  `)(fetchImpl, TextDecoder, onPrepared);
}

function sse(...events) {
  return new Response(
    events.map(({ type, data = {} }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function preparedEvent(id = "a".repeat(64), totalMs = 120) {
  return {
    type: "prepared",
    data: {
      preparationId: id,
      progress: {
        totalMs,
        stageDurationsMs: { understand: totalMs },
      },
    },
  };
}

function answerEvent() {
  return { type: "answer", data: { answer: { effectiveRulingVersion: "latest", verdict: "synthetic" } } };
}

function endEvent() {
  return { type: "end", data: {} };
}

test("prepare/finalize sends the exact two body shapes in serial order", async () => {
  const requests = [];
  const clientInstance = createClient(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (requests.length === 1) {
      return sse(
        { type: "stage_start", data: { stageId: "understand" } },
        preparedEvent(),
        endEvent(),
      );
    }
    return sse(
      { type: "stage_start", data: { stageId: "generate_ruling" } },
      answerEvent(),
      endEvent(),
    );
  });

  const result = await clientInstance.request("Synthetic question", "latest", { requestId: 0 });
  assert.equal(result.verdict, "synthetic");
  assert.deepEqual(requests.map((item) => item.url), [
    "https://example.invalid/api/answer?progress=1",
    "https://example.invalid/api/answer?progress=1",
  ]);
  assert.deepEqual(requests[0].body, {
    question: "Synthetic question",
    mode: "rag",
    rulingModelProfile: "relay-gpt-6-astra-max",
    rulingVersion: "latest",
    action: "prepare",
  });
  assert.deepEqual(requests[1].body, {
    action: "finalize",
    preparationId: "a".repeat(64),
  });
  assert.equal(clientInstance.preparedProgress.length, 1);
});

test("legacy answer still completes with only the prepare request", async () => {
  let calls = 0;
  const clientInstance = createClient(async () => {
    calls += 1;
    return sse(answerEvent(), endEvent());
  });

  const result = await clientInstance.request("Synthetic question", "latest");
  assert.equal(result.verdict, "synthetic");
  assert.equal(calls, 1);
});

test("preparation progress is applied once and remains accumulated through finalization", async () => {
  const totals = [];
  const clientInstance = createClient(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === "prepare") {
      return sse(
        { type: "stage_end", data: { stageId: "understand", durationMs: 120 } },
        preparedEvent("b".repeat(64), 120),
        endEvent(),
      );
    }
    return sse(
      { type: "tick", data: { stageId: "generate_ruling", serverElapsedMs: 180 } },
      answerEvent(),
      { type: "end", data: { totalMs: 240 } },
    );
  }, { onPrepared: (progress) => totals.push(progress.totalMs) });

  await clientInstance.request("Synthetic question", "latest");
  assert.deepEqual(totals, [120]);
  assert.deepEqual(clientInstance.preparedProgress.map((item) => item.totalMs), [120]);
});

test("no final request occurs after cancellation or stale request", async () => {
  for (const scenario of ["cancel", "stale"]) {
    let calls = 0;
    let controller;
    const requestController = new AbortController();
    const clientInstance = createClient(async (_url, options) => {
      calls += 1;
      controller = options.signal;
      return sse(preparedEvent(), endEvent());
    }, {
      requestId: 1,
      onPrepared: () => {
        if (scenario === "cancel") controller?.abort();
      },
    });
    if (scenario === "stale") clientInstance.setAnalysisRequestId(2);
    await assert.rejects(clientInstance.request("Synthetic question", "latest", {
      requestId: 1,
      signal: requestController.signal,
    }));
    assert.equal(calls, 1, scenario);
    assert.equal(clientInstance.preparedProgress.length, scenario === "stale" ? 0 : 1, scenario);
  }
});

test("errors and malformed terminal events stop before finalization", async () => {
  const cases = [
    ["error", sse({ type: "error", data: { code: "synthetic_failure" } })],
    ["missing end", sse(preparedEvent())],
    ["invalid token", sse(preparedEvent("not-a-token"), endEvent())],
    ["duplicate prepared", sse(preparedEvent(), preparedEvent(), endEvent())],
    ["mixed answer and prepared", sse(answerEvent(), preparedEvent(), endEvent())],
  ];
  for (const [label, response] of cases) {
    let calls = 0;
    const clientInstance = createClient(async () => {
      calls += 1;
      return response;
    });
    await assert.rejects(clientInstance.request("Synthetic question", "latest"), undefined, label);
    assert.equal(calls, 1, label);
  }
});

test("prepared on the final stream is rejected without another request", async () => {
  let calls = 0;
  const clientInstance = createClient(async (_url, options) => {
    calls += 1;
    return calls === 1
      ? sse(preparedEvent("c".repeat(64)), endEvent())
      : sse(preparedEvent("d".repeat(64)), endEvent());
  });
  await assert.rejects(clientInstance.request("Synthetic question", "latest"));
  assert.equal(calls, 2);
});

test("preparation HTTP conflicts and stream failures remain request failures", async () => {
  for (const [status, code] of [[409, "answer_preparation_in_progress"], [410, "answer_preparation_missing"]]) {
    const clientInstance = createClient(async () => ({
      ok: false,
      status,
      json: async () => ({ code, error: "Synthetic preparation state" }),
    }));
    await assert.rejects(clientInstance.request("Synthetic question", "latest"), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.requestFailure, true);
      assert.equal(error.publicMessage, "Synthetic preparation state");
      return true;
    });
  }

  const clientInstance = createClient(async () => sse({
    type: "error",
    data: {
      code: "answer_preparation_storage_unavailable",
      statusCode: 503,
      error: "Synthetic storage failure",
    },
  }));
  await assert.rejects(clientInstance.request("Synthetic question", "latest"), (error) => {
    assert.equal(error.code, "answer_preparation_storage_unavailable");
    assert.equal(error.status, 503);
    assert.equal(error.requestFailure, true);
    assert.equal(error.publicMessage, "Synthetic storage failure");
    return true;
  });
});
