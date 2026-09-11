import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const client = app.slice(
  app.indexOf("async function requestBackendAnswer"),
  app.indexOf("function renderPending"),
);

function createClient(fetchImpl, {
  selectedProfile = "official-astra-low",
  requestId = null,
  onPrepared = null,
  sessionStorageImpl = {
    values: new Map(),
    setItem(key, value) { this.values.set(key, value); },
    getItem(key) { return this.values.get(key) ?? null; },
    removeItem(key) { this.values.delete(key); },
  },
} = {}) {
  return new Function("fetch", "TextDecoder", "onPrepared", "sessionStorage", `
    const appConfig = { answerApiUrl: "https://example.invalid/api/answer" };
    const publicAnswerPreparationStorageKey = "ocg-public-answer-preparation-id";
    let selectedRulingModelProfile = ${JSON.stringify(selectedProfile)};
    let selectedRulingVersion = "latest";
    let analysisRequestId = ${JSON.stringify(requestId ?? 0)};
    let activeAnalysisPhase = null;
    let preparedEvidencePackage = null;
    const ui = {
      evidencePackagePanel: { hidden: true },
      evidencePackageStatus: { textContent: "" },
      evidencePackageDownload: { hidden: true },
    };
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
      getPreparedEvidencePackage() { return preparedEvidencePackage; },
      getActiveAnalysisPhase() { return activeAnalysisPhase; },
      recover: recoverStoredPublicAnswer,
      readStoredPreparationId: readStoredPublicAnswerPreparationId,
    };
  `)(fetchImpl, TextDecoder, onPrepared, sessionStorageImpl);
}

function sse(...events) {
  return new Response(
    events.map(({ type, data = {} }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function preparedEvent(id = "a".repeat(64), totalMs = 120, evidencePackage = null) {
  return {
    type: "prepared",
    data: {
      preparationId: id,
      ...(evidencePackage ? { evidencePackage } : {}),
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
  const stored = new Map();
  const sessionStorageImpl = {
    setItem(key, value) { stored.set(key, value); },
    getItem(key) { return stored.get(key) ?? null; },
    removeItem(key) { stored.delete(key); },
  };
  const clientInstance = createClient(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (requests.length === 1) {
      return sse(
        { type: "stage_start", data: { stageId: "understand" } },
        preparedEvent(),
        endEvent(),
      );
    }
    assert.equal(clientInstance.readStoredPreparationId(), "a".repeat(64));
    return sse(
      { type: "stage_start", data: { stageId: "generate_ruling" } },
      answerEvent(),
      endEvent(),
    );
  }, { sessionStorageImpl });

  const result = await clientInstance.request("Synthetic question", "latest", { requestId: 0 });
  assert.equal(result.verdict, "synthetic");
  assert.deepEqual(requests.map((item) => item.url), [
    "https://example.invalid/api/answer?progress=1",
    "https://example.invalid/api/answer?progress=1",
  ]);
  assert.deepEqual(requests[0].body, {
    question: "Synthetic question",
    mode: "rag",
    rulingModelProfile: "official-astra-low",
    rulingVersion: "latest",
    action: "prepare",
  });
  assert.deepEqual(requests[1].body, {
    action: "finalize",
    preparationId: "a".repeat(64),
  });
  assert.equal(clientInstance.preparedProgress.length, 1);
  assert.equal(clientInstance.readStoredPreparationId(), "");
});

test("a completed stored preparation is recovered through a read-only status request", async () => {
  const preparationId = "9".repeat(64);
  const stored = new Map([["ocg-public-answer-preparation-id", preparationId]]);
  const sessionStorageImpl = {
    setItem(key, value) { stored.set(key, value); },
    getItem(key) { return stored.get(key) ?? null; },
    removeItem(key) { stored.delete(key); },
  };
  const requests = [];
  const recoveredAnswer = { effectiveRulingVersion: "latest", verdict: "recovered" };
  const clientInstance = createClient(async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      status: "completed",
      result: { answer: recoveredAnswer, progress: { totalMs: 240 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, { sessionStorageImpl });

  const recovered = await clientInstance.recover();
  assert.equal(recovered.verdict, recoveredAnswer.verdict);
  assert.equal(recovered.effectiveRulingVersion, "latest");
  assert.equal(recovered.requestedRulingVersion, "latest");
  assert.deepEqual(requests[0].body, { action: "status", preparationId });
  assert.equal(requests[0].options.signal, undefined);
  assert.equal(clientInstance.readStoredPreparationId(), "");
  assert.deepEqual(clientInstance.preparedProgress, [{ totalMs: 240 }]);
});

test("ready and running recovery poll only status for the same preparation until completion", async () => {
  const preparationId = "8".repeat(64);
  const stored = new Map([["ocg-public-answer-preparation-id", preparationId]]);
  const sessionStorageImpl = {
    setItem(key, value) { stored.set(key, value); },
    getItem(key) { return stored.get(key) ?? null; },
    removeItem(key) { stored.delete(key); },
  };
  const requests = [];
  const states = ["ready", "running", "completed"];
  const clientInstance = createClient(async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const status = states.shift();
    return new Response(JSON.stringify(status === "completed"
      ? { status, result: { answer: { effectiveRulingVersion: "latest", verdict: "recovered-after-poll" } } }
      : { status }), { status: 200, headers: { "content-type": "application/json" } });
  }, { sessionStorageImpl });
  const waits = [];

  const recovered = await clientInstance.recover({
    maxAttempts: 3,
    pollIntervalMs: 5,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(recovered.verdict, "recovered-after-poll");
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ({ action: "status", preparationId })));
  assert.deepEqual(waits, [5, 5]);
  assert.equal(requests.some((body) => body.action === "finalize"), false);
  assert.equal(clientInstance.readStoredPreparationId(), "");
});

test("prepare-only sends one prepare request and retains the downloadable package", async () => {
  const requests = [];
  const evidencePackage = { text: "PROMPT_VISIBLE", filename: "question-evidence.txt" };
  const clientInstance = createClient(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return sse(preparedEvent("f".repeat(64), 80, evidencePackage), endEvent());
  });

  const result = await clientInstance.request("Synthetic question", "latest", { prepareOnly: true });
  assert.equal(result.kind, "prepared");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, "prepare");
  assert.deepEqual(clientInstance.getPreparedEvidencePackage(), evidencePackage);
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

test("a prepared evidence package remains available when finalization fails", async () => {
  let calls = 0;
  const evidencePackage = { text: "PROMPT_VISIBLE", filename: "retained-evidence.txt" };
  const clientInstance = createClient(async () => {
    calls += 1;
    return calls === 1
      ? sse(preparedEvent("e".repeat(64), 120, evidencePackage), endEvent())
      : sse({ type: "error", data: { code: "model_provider_timeout" } });
  });

  await assert.rejects(clientInstance.request("Synthetic question", "latest"));
  assert.equal(calls, 2);
  assert.deepEqual(clientInstance.getPreparedEvidencePackage(), evidencePackage);
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

test("editing the question does not abort or invalidate a dispatched final request", () => {
  const source = app.slice(
    app.indexOf("function scheduleAnalysis"),
    app.indexOf("init();", app.indexOf("function scheduleAnalysis")),
  );
  let cleared = 0;
  let reset = 0;
  const run = new Function("clearTimeout", "clearPreparedEvidencePackage", "resetAnalysis", `
    let analysisTimer = 7;
    let analysisRequestId = 11;
    let activeAnalysisPhase = "finalize";
    const appConfig = { answerApiUrl: "https://example.invalid/api/answer" };
    const ui = { questionInput: { value: "edited while finalizing" } };
    function analyzeQuestion() {}
    function setTimeout() { throw new Error("must not schedule another request"); }
    ${source}
    scheduleAnalysis();
    return { analysisRequestId, activeAnalysisPhase };
  `)(() => {}, () => { cleared += 1; }, () => { reset += 1; });

  assert.deepEqual(run, { analysisRequestId: 11, activeAnalysisPhase: "finalize" });
  assert.equal(cleared, 0);
  assert.equal(reset, 0);
});
