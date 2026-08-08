import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertReadonlyAction,
  createReadonlyAdminDiagnosticsClient,
  diagnoseAdminRunsReadonly,
  main,
} from "../scripts/diagnose-admin-runs-readonly.mjs";

test("read-only diagnosis includes non-terminal list state and replays its events without GET run", async () => {
  const calls = [];
  const report = await diagnoseAdminRunsReadonly({
    startUtc: "2026-08-08T01:51:00Z",
    endUtc: "2026-08-08T01:54:00Z",
    now: () => new Date("2026-08-08T02:00:00Z"),
    client: {
      async listRuns() {
        return {
          records: [
            runRecord("terminal-in-window", "FAILED", "2026-08-08T01:51:20Z", "2026-08-08T01:53:33Z"),
            {
              ...runRecord("running-in-window", "RUNNING", "2026-08-08T01:52:00Z", null),
              stageTiming: { status: "RUNNING", stages: [{ id: "generate_ruling", status: "RUNNING" }] },
              providerSubmission: { state: "SUBMITTED", requestId: "running-request" },
            },
            runRecord("terminal-outside", "SUCCEEDED", "2026-08-08T02:10:00Z", "2026-08-08T02:11:00Z"),
          ],
          nextCursor: null,
        };
      },
      async getTerminalRun(runId, status) {
        calls.push(["run", runId, status]);
        return {
          run: {
            ...runRecord(runId, "FAILED", "2026-08-08T01:51:20Z", "2026-08-08T01:53:33Z"),
            stageTiming: {
              status: "COMPLETED",
              durationMs: 133000,
              stages: [{ id: "generate_ruling", status: "RUNNING", durationMs: 110000 }],
            },
            error: {
              code: "admin_model_lab_internal_error",
              requestId: "error-request-id",
              submittedModel: "gpt-5.6-sol",
              upstreamCauseCode: "relay_timeout",
              failureMetering: {
                scope: "final_ruling_only",
                usage: { inputTokens: 120, outputTokens: 4, totalTokens: 124, rawPrompt: "secret" },
                cost: { provider: "relay", totalCostCny: 0.03, privateRate: "secret" },
              },
              streamMetrics: {
                requestToFirstContentMs: 90000,
                requestToCompleteMs: 110000,
                networkChunkCount: 4,
                sseEventCount: 3,
                visibleContentBytes: 80,
                finishReason: "timeout",
                hiddenReasoning: "secret",
              },
              message: "must not be exported",
              stack: "secret stack",
            },
            execution: {
              providerSubmission: {
                state: "OUTCOME_UNKNOWN",
                requestId: "request-safe-id",
                apiKey: "must-not-leak",
              },
            },
          },
        };
      },
      async getListedRunEvents(runId) {
        calls.push(["events", runId]);
        if (runId === "running-in-window") {
          return [{ sequence: 2, type: "PROVIDER_SUBMITTED", status: "RUNNING" }];
        }
        return [{
          sequence: 4,
          type: "RUN_FAILED",
          timestamp: "2026-08-08T01:53:33Z",
          status: "FAILED",
          payload: {
            error: { code: "admin_model_lab_internal_error", message: "private" },
            completedAttempt: {
              requestId: "attempt-request-id",
              submittedModel: "gpt-5.6-sol",
              reportedModel: "gpt-5.6-sol",
              usage: { inputTokens: 120, outputTokens: 4, totalTokens: 124, unsafe: "secret" },
              cost: { provider: "relay", totalCostCny: 0.03, unsafe: "secret" },
              streamMetrics: { requestToCompleteMs: 110000, sseEventCount: 3, visibleContentBytes: 80 },
              responseBody: "must not be exported",
            },
            evidenceSnapshot: { question: "must not be exported" },
          },
        }];
      },
    },
  });

  assert.deepEqual(calls, [
    ["run", "terminal-in-window", "FAILED"],
    ["events", "terminal-in-window"],
    ["events", "running-in-window"],
  ]);
  assert.equal(report.zeroPaidOperations, true);
  assert.equal(report.matchedRunCount, 2);
  assert.equal(report.matchedTerminalRunCount, 1);
  assert.equal(report.matchedNonTerminalRunCount, 1);
  assert.equal(report.runs[0].providerSubmission.state, "OUTCOME_UNKNOWN");
  assert.equal(report.runs[0].error.requestId, "error-request-id");
  assert.equal(report.runs[0].error.submittedModel, "gpt-5.6-sol");
  assert.equal(report.runs[0].error.upstreamCauseCode, "relay_timeout");
  assert.equal(report.runs[0].error.failureMetering.usage.totalTokens, 124);
  assert.equal(report.runs[0].error.failureMetering.cost.totalCostCny, 0.03);
  assert.equal(report.runs[0].error.streamMetrics.requestToFirstContentMs, 90000);
  assert.equal(report.runs[0].error.streamMetrics.requestToCompleteMs, 110000);
  assert.equal(report.runs[0].error.streamMetrics.networkChunkCount, 4);
  assert.equal(report.runs[0].error.streamMetrics.sseEventCount, 3);
  assert.equal(report.runs[0].error.streamMetrics.visibleContentBytes, 80);
  assert.equal(report.runs[0].error.streamMetrics.finishReason, "timeout");
  assert.equal(report.runs[0].events[0].error.code, "admin_model_lab_internal_error");
  assert.equal(report.runs[0].events[0].completedAttempt.requestId, "attempt-request-id");
  assert.equal(report.runs[0].events[0].completedAttempt.usage.totalTokens, 124);
  assert.equal(report.runs[0].events[0].completedAttempt.cost.totalCostCny, 0.03);
  assert.equal(report.runs[0].events[0].completedAttempt.streamMetrics.visibleContentBytes, 80);
  assert.equal(report.runs[1].status, "RUNNING");
  assert.equal(report.runs[1].detailSource, "list");
  assert.equal(report.runs[1].providerSubmission.state, "SUBMITTED");
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /must not be exported|secret stack|must-not-leak|"message"|evidenceSnapshot|hiddenReasoning|privateRate|rawPrompt|responseBody/u);
});

test("dedicated client performs one login POST and only allowlisted Model Lab GETs", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, options });
    if (parsed.pathname === "/api/admin-auth") {
      return response({ authenticated: true, csrfToken: "unused" }, {
        headers: new Headers({ "set-cookie": "admin_session=test; Path=/; HttpOnly" }),
      });
    }
    const action = parsed.searchParams.get("action");
    if (action === "list") {
      return response({ ok: true, data: {
        records: [runRecord("run-1", "FAILED"), runRecord("running-1", "RUNNING")],
        nextCursor: null,
      } });
    }
    if (action === "run") {
      return response({ ok: true, data: { run: runRecord("run-1", "FAILED") } });
    }
    return textResponse("event: end\ndata: {\"runId\":\"run-1\",\"terminal\":true}\n\n");
  };
  const client = createReadonlyAdminDiagnosticsClient({
    baseUrl: "https://lab.example.test",
    origin: "https://admin.example.test",
    password: "test-password",
    fetchImpl,
  });

  await client.login();
  await client.listRuns();
  await client.getTerminalRun("run-1", "FAILED");
  await client.getListedRunEvents("running-1");

  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests.slice(1).every((item) => item.options.method === "GET"), true);
  assert.deepEqual(
    requests.slice(1).map((item) => item.url.searchParams.get("action")),
    ["list", "run", "events"],
  );
  assert.deepEqual(Object.keys(client).sort(), [
    "getListedRunEvents",
    "getTerminalRun",
    "listRuns",
    "login",
  ]);
  assert.doesNotMatch(JSON.stringify(requests.slice(1)), /test-password/u);
});

test("write actions and non-terminal detail reads fail closed", async () => {
  for (const action of ["create", "fork", "execute", "cancel", "reconcile", "release-budget-reservation"]) {
    assert.throws(() => assertReadonlyAction(action), /forbidden admin diagnostics action/u);
  }
  const client = createReadonlyAdminDiagnosticsClient({
    baseUrl: "https://lab.example.test",
    password: "test-password",
    fetchImpl: async () => response({ authenticated: true }, {
      headers: new Headers({ "set-cookie": "admin_session=test" }),
    }),
  });
  await client.login();
  await assert.rejects(client.getTerminalRun("running-1", "RUNNING"), /refusing GET run/u);
  await assert.rejects(client.getListedRunEvents("running-1"), /refusing GET events/u);
});

test("CLI requires the dedicated admin password and workflow has safe defaults", async () => {
  await assert.rejects(
    main(["--output", "diagnostic.json"], {}, { stdout: { write() {} } }),
    /ADMIN_MODEL_LAB_PASSWORD is required/u,
  );
  const workflow = await readFile(
    new URL("../.github/workflows/admin-readonly-run-diagnostics.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /default: "2026-08-08T01:51:00Z"/u);
  assert.match(workflow, /default: "2026-08-08T01:54:00Z"/u);
  assert.match(workflow, /secrets\.ADMIN_MODEL_LAB_PASSWORD/u);
  assert.match(workflow, /diagnose-admin-runs-readonly\.mjs/u);
  assert.doesNotMatch(workflow, /admin-model-matrix|--question|--config relay/iu);
});

function runRecord(runId, status, createdAt = "2026-08-08T01:51:20Z", endedAt = "2026-08-08T01:53:33Z") {
  return { runId, status, createdAt, updatedAt: endedAt || createdAt, endedAt };
}

function response(payload, { status = 200, headers = new Headers() } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    async json() { return payload; },
  };
}

function textResponse(text, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    async text() { return text; },
  };
}
