import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createAdminEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";
import {
  collectSourceReferences,
  exportAdminSourceSnapshots,
  main,
  parseExportArguments,
} from "../scripts/export-admin-source-snapshots.mjs";

test("source snapshot exporter fetches full frozen sources without answers or goldens", async () => {
  const fixtures = [
    makeSource("case-a", "run-a", "问题 A"),
    makeSource("case-b", "run-b", "问题 B"),
  ];
  const calls = [];
  const bundle = await exportAdminSourceSnapshots({
    reportFiles: ["matrix.json"],
    readFileImpl: async () => JSON.stringify({
      reports: fixtures.map((item) => ({
        caseId: item.caseId,
        question: item.snapshot.question,
        sourceRunId: item.run.runId,
        results: [{ finalRuling: "must not be exported" }],
      })),
      golden: "must not be exported",
    }),
    client: {
      async getRun(runId) {
        calls.push(runId);
        return { run: fixtures.find((item) => item.run.runId === runId).run };
      },
    },
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });

  assert.deepEqual(calls, ["run-a", "run-b"]);
  assert.equal(bundle.kind, "admin-frozen-source-snapshot-bundle");
  assert.equal(bundle.sourceCount, 2);
  assert.deepEqual(bundle.sources.map((item) => item.caseId), ["case-a", "case-b"]);
  assert.deepEqual(bundle.sources[0].evidenceSnapshot, fixtures[0].snapshot);
  assert.deepEqual(bundle.sources[0].executionProfile, fixtures[0].run.executionProfile);
  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /must not be exported/u);
  assert.doesNotMatch(serialized, /"golden"/u);
  assert.equal(Object.hasOwn(bundle.sources[0], "result"), false);
});

test("source snapshot exporter fails closed on mismatched bindings and sensitive profile fields", async () => {
  const fixture = makeSource("case-a", "run-a", "问题 A");
  const report = JSON.stringify({
    reports: [{ caseId: fixture.caseId, sourceRunId: fixture.run.runId, question: "问题 A" }],
  });
  const base = {
    reportFiles: ["matrix.json"],
    readFileImpl: async () => report,
  };

  await assert.rejects(
    exportAdminSourceSnapshots({
      ...base,
      client: {
        getRun: async () => ({
          run: {
            ...fixture.run,
            executionProfile: {
              ...fixture.run.executionProfile,
              evidenceSnapshotId: "evidence_wrong",
            },
          },
        }),
      },
    }),
    /snapshot binding mismatches/u,
  );

  await assert.rejects(
    exportAdminSourceSnapshots({
      ...base,
      client: {
        getRun: async () => ({
          run: {
            ...fixture.run,
            executionProfile: {
              ...fixture.run.executionProfile,
              apiKey: "must-never-export",
            },
          },
        }),
      },
    }),
    /sensitive field is forbidden/u,
  );
});

test("source snapshot exporter accepts known failed runs but rejects ambiguous submissions", async () => {
  const fixture = makeSource("case-a", "run-a", "问题 A");
  const report = JSON.stringify({
    reports: [{ caseId: fixture.caseId, sourceRunId: fixture.run.runId, question: "问题 A" }],
  });
  const failedRun = {
    ...fixture.run,
    status: "FAILED",
    execution: { providerSubmission: { state: "REJECTED" } },
  };
  const accepted = await exportAdminSourceSnapshots({
    reportFiles: ["matrix.json"],
    readFileImpl: async () => report,
    client: { getRun: async () => ({ run: failedRun }) },
  });
  assert.equal(accepted.sources[0].status, "FAILED");

  await assert.rejects(
    exportAdminSourceSnapshots({
      reportFiles: ["matrix.json"],
      readFileImpl: async () => report,
      client: {
        getRun: async () => ({
          run: {
            ...failedRun,
            execution: { providerSubmission: { state: "OUTCOME_UNKNOWN" } },
          },
        }),
      },
    }),
    /ambiguous provider submission/u,
  );
});

test("export CLI accepts repeatable reports and requires the dedicated secret", async () => {
  assert.deepEqual(
    parseExportArguments(["--report", "one.json", "--report", "two.json", "--output", "out.json"]),
    { reportFiles: ["one.json", "two.json"], output: "out.json" },
  );
  await assert.rejects(
    main(["--report", "one.json", "--output", "out.json"], {}, {
      stdout: { write() {} },
    }),
    /ADMIN_MODEL_LAB_PASSWORD is required/u,
  );
});

test("Sol effort workflow is manual, sequential, bounded to 12 calls and exports snapshots", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/admin-sol-effort-pilot.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /ADMIN_MODEL_LAB_PASSWORD: \$\{\{ secrets\.ADMIN_MODEL_LAB_PASSWORD \}\}/u);
  assert.match(workflow, /--concurrency 1/u);
  assert.match(workflow, /--max-final-requests 12/u);
  assert.match(workflow, /:pro:none:full/u);
  assert.match(workflow, /:pro:low:full/u);
  assert.match(workflow, /:pro:medium:full/u);
  assert.match(workflow, /export-admin-source-snapshots\.mjs/u);
  assert.doesNotMatch(workflow, /golden/iu);
  assert.equal((workflow.match(/--config relay:relay-gpt-5\.6-sol/gu) || []).length, 3);
});

test("source reference collection rejects ambiguous report provenance", () => {
  assert.throws(
    () => collectSourceReferences({ reports: [{ caseId: "", sourceRunId: "run-a" }] }),
    /caseId/u,
  );
});

function makeSource(caseId, runId, question) {
  const snapshot = createAdminEvidenceSnapshot({
    question,
    evidence: { rules: [{ id: `${caseId}-rule`, text: "冻结证据" }] },
    dataVersions: { fixture: "v1" },
    metadata: { finalRulingProvider: "relay" },
    createdAt: new Date("2026-08-07T00:00:00.000Z"),
  });
  return {
    caseId,
    snapshot,
    run: {
      runId,
      status: "SUCCEEDED",
      evidenceSnapshot: snapshot,
      executionProfile: {
        status: "evidence_frozen",
        evidenceSnapshotId: snapshot.snapshotId,
        evidenceVariant: "full",
        finalRuling: {
          provider: "relay",
          requestedModel: "relay-gpt-5.6-sol",
          model: "gpt-5.6-sol",
          reasoningMode: "pro",
          reasoningEffort: "none",
          finalAttemptPolicy: "single",
        },
      },
    },
  };
}
