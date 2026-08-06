import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createAdminEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";
import { buildFinalRulingInput } from "../backend/adminModelLabService.mjs";
import { createLegacyLuaUnknownPacket } from "../backend/legacyLuaSemanticPacket.mjs";
import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import {
  createAllowlistedCommunityCardFetch,
  createLocalDryRunLegacyLuaSemanticPacketFactory,
  createLocalEngineOnlyFetch,
  normalizeLocalDryRunEngineUrl,
  parseAdminEvidenceDryRunArguments,
  runAdminEvidenceDryRunCli,
} from "../scripts/admin-evidence-snapshot-dry-run.mjs";
import {
  ADMIN_DRY_RUN_PAID_GATE_BLOCKED,
  inspectAdminEvidencePaidGate,
  normalizeAdminEvidenceDryRunCases,
  readAdminEvidenceDryRunCases,
  runAdminEvidenceSnapshotDryRun,
} from "../scripts/lib/admin-evidence-snapshot-dry-run.mjs";

const casesUrl = new URL("./fixtures/admin-evidence-dry-run-cases.json", import.meta.url);
const goldensUrl = new URL("./fixtures/admin-evidence-dry-run-goldens.json", import.meta.url);

test("four-case fixture contains inputs only and uses the corrected card name", async () => {
  const fixture = JSON.parse(await readFile(casesUrl, "utf8"));
  const normalized = normalizeAdminEvidenceDryRunCases(fixture);
  assert.equal(normalized.cases.length, 4);
  for (const item of fixture.cases) {
    assert.deepEqual(Object.keys(item).sort(), ["candidateCards", "id", "question"]);
    assert.equal(Object.hasOwn(item, "answer"), false);
    assert.equal(Object.hasOwn(item, "expectedAnswer"), false);
    assert.equal(Object.hasOwn(item, "leakCanary"), false);
  }
  const serialized = JSON.stringify(fixture);
  assert.match(serialized, /绚岚之达维/u);
  assert.doesNotMatch(serialized, /绚岚之达象/u);
});

test("helper and CLI contain no case-specific ids or card-name branches", async () => {
  const cases = await readAdminEvidenceDryRunCases(casesUrl);
  const sources = await Promise.all([
    readFile(new URL("../scripts/lib/admin-evidence-snapshot-dry-run.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/admin-evidence-snapshot-dry-run.mjs", import.meta.url), "utf8"),
  ]);
  const productionText = sources.join("\n");
  for (const item of cases.cases) {
    assert.equal(productionText.includes(item.id), false, `helper must not special-case ${item.id}`);
    for (const cardName of item.candidateCards) {
      assert.equal(
        productionText.includes(cardName),
        false,
        `helper must not special-case ${cardName}`,
      );
    }
  }
});

test("four local cases freeze snapshots, never leak goldens, and never use a paid transport", async () => {
  const cases = await readAdminEvidenceDryRunCases(casesUrl);
  const goldenFixture = JSON.parse(await readFile(goldensUrl, "utf8"));
  const artifacts = new Map();
  const result = await runAdminEvidenceSnapshotDryRun({
    cases,
    async onCaseArtifacts(value) {
      artifacts.set(value.definition.id, value);
    },
  });

  assert.equal(result.mode, "LOCAL_ONLY_ZERO_COST");
  assert.equal(result.legacyLuaMode, "UNAVAILABLE");
  assert.equal(result.enginePasscodeHydrationEnabled, false);
  assert.equal(result.caseCount, 4);
  assert.equal(result.realProviderTransportCalls, 0);
  assert.equal(result.allSnapshotsFrozen, true);
  assert.equal(result.allPaidTransportsPrevented, true);
  assert.equal(result.reports.some((item) => item.paidGateBlocked), true);
  for (const report of result.reports) {
    const definition = cases.cases.find((item) => item.id === report.id);
    assert.ok(definition, `missing fixture definition for ${report.id}`);
    assert.equal(
      report.candidateBindings.length,
      definition.candidateCards.length,
      "the paid sentinel must validate every fixture candidate even after question decomposition",
    );
    assert.match(report.snapshot.id, /^evidence_[a-f0-9]{24}$/u);
    assert.match(report.snapshot.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(report.snapshot.frozen, true);
    assert.ok(report.snapshot.bytes > 0);
    assert.ok(report.finalInput.bytes > 0);
    assert.match(report.finalInput.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(report.lua.verdict, "UNKNOWN");
    assert.ok(report.lua.serializedBytes > 0);
    assert.equal(report.transport.realProviderCalls, 0);
    assert.equal(report.transport.externalFetchAllowedCount, 0);
    assert.equal(
      report.transport.externalFetchAttemptCount,
      report.transport.externalFetchBlockedCount,
    );
    assert.equal(report.transport.allExternalFetchesIntercepted, true);
    const missingCount = report.missing.unresolvedCandidates.length
      + report.missing.missingVisibleCardTexts.length
      + report.missing.incompleteVisibleCardTexts.length;
    assert.equal(
      report.paidGateBlocked,
      missingCount > 0 || !report.productionReadiness.ready,
    );
    assert.equal(
      report.paidGateCode,
      !report.productionReadiness.ready
        ? "admin_final_evidence_not_ready"
        : missingCount > 0
          ? ADMIN_DRY_RUN_PAID_GATE_BLOCKED
          : null,
    );
    if (!report.productionReadiness.ready) {
      assert.equal(
        report.transport.localFinalProviderCreateCount,
        0,
        "production readiness gate must block before even the local provider sentinel",
      );
    } else {
      assert.equal(
        report.transport.localFinalProviderCreateCount,
        1,
        "a production-ready run must reach the local no-cost provider sentinel exactly once",
      );
    }
    assert.ok(Number.isFinite(report.timingsMs.total));
    assert.ok(Number.isFinite(report.timingsMs.luaSemantic));
    assert.ok(Number.isFinite(report.timingsMs.snapshotBuild));
    assert.ok(Number.isFinite(report.timingsMs.localPaidGateValidation));
  }

  for (const golden of goldenFixture.goldens) {
    const artifact = artifacts.get(golden.id);
    assert.ok(artifact, `missing artifact for ${golden.id}`);
    const snapshotText = JSON.stringify(artifact.snapshot);
    assert.equal(snapshotText.includes(golden.leakCanary), false);
    assert.equal(snapshotText.includes(golden.expectedAnswer), false);
    assert.equal(artifact.finalInput.includes(golden.leakCanary), false);
    assert.equal(artifact.finalInput.includes(golden.expectedAnswer), false);
  }
});

test("CLI enables local Lua only through an explicit loopback engine URL", async () => {
  const parsed = parseAdminEvidenceDryRunArguments([
    "--engine-url", "http://127.0.0.1:8790",
    "--case", "anonymous-case",
    "--compact",
  ]);
  assert.equal(parsed.engineUrl, "http://127.0.0.1:8790");

  const cases = {
    schemaVersion: 1,
    cases: [{
      id: "anonymous-case",
      question: "匿名问题",
      candidateCards: ["匿名卡"],
    }],
  };
  const localFactory = async () => createLegacyLuaUnknownPacket({
    code: "LOCAL_ENGINE_TEST",
    message: "local engine test packet",
  });
  let factoryOptions = null;
  let dryRunOptions = null;
  let output = "";
  const expected = {
    mode: "LOCAL_ONLY_ZERO_COST",
    legacyLuaMode: "INJECTED_LOCAL_ENGINE",
    realProviderTransportCalls: 0,
  };
  const result = await runAdminEvidenceDryRunCli([
    "--engine-url", "http://localhost:8790",
    "--case", "anonymous-case",
    "--compact",
  ], {
    readCases: async () => cases,
    createLegacyLuaFactory(options) {
      factoryOptions = options;
      return localFactory;
    },
    async runDryRun(options) {
      dryRunOptions = options;
      return expected;
    },
    fetchImpl: async () => {
      throw new Error("CLI composition test must not fetch");
    },
    engineToken: "local-engine-token",
    stdout: { write(value) { output += value; } },
  });
  assert.equal(result, expected);
  assert.equal(factoryOptions.engineUrl, "http://localhost:8790");
  assert.equal(factoryOptions.engineToken, "local-engine-token");
  assert.equal(dryRunOptions.legacyLuaSemanticPacketFactory, localFactory);
  assert.equal(dryRunOptions.enginePasscodeHydrationEnabled, true);
  assert.equal(dryRunOptions.retrievalFetchImpl, null);
  assert.equal(JSON.parse(output).realProviderTransportCalls, 0);
  assert.equal(output.includes("local-engine-token"), false);
});

test("local Lua factory and transport fail closed outside the exact loopback origin", async () => {
  assert.equal(
    normalizeLocalDryRunEngineUrl("http://127.0.0.1:8790/"),
    "http://127.0.0.1:8790",
  );
  assert.equal(
    normalizeLocalDryRunEngineUrl("http://LOCALHOST:8790"),
    "http://localhost:8790",
  );
  for (const rejected of [
    "https://127.0.0.1:8790",
    "http://engine.example.test:8790",
    "http://user:secret@127.0.0.1:8790",
    "http://127.0.0.1:8790/formal",
    "http://127.0.0.1:8790/?token=secret",
    "http://127.0.0.1:8790/#fragment",
    "http://[::1]:8790",
  ]) {
    assert.throws(
      () => normalizeLocalDryRunEngineUrl(rejected),
      /only accepts|valid local HTTP URL/u,
    );
  }

  const fetchCalls = [];
  const localFetch = createLocalEngineOnlyFetch({
    engineUrl: "http://127.0.0.1:8790",
    async fetchImpl(url, init) {
      fetchCalls.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    },
  });
  await localFetch("http://127.0.0.1:8790/health", {
    headers: { authorization: "Bearer local-token" },
  });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init.redirect, "error");
  await assert.rejects(
    () => localFetch("http://localhost:8790/health"),
    /blocked a non-local request/u,
  );
  await assert.rejects(
    () => localFetch("https://engine.example.test/health"),
    /blocked a non-local request/u,
  );

  let configuredOptions = null;
  const factory = createLocalDryRunLegacyLuaSemanticPacketFactory({
    engineUrl: "http://127.0.0.1:8790",
    engineToken: "local-token",
    fetchImpl: async () => {
      throw new Error("factory composition must not fetch eagerly");
    },
    configuredFactory(options) {
      configuredOptions = options;
      return async () => ({ verdict: "TRUE" });
    },
  });
  assert.deepEqual(configuredOptions.env, {
    OCG_ENGINE_URL: "http://127.0.0.1:8790",
    OCG_ENGINE_TOKEN: "local-token",
  });
  const packet = await factory({});
  assert.equal(packet.verdict, "UNKNOWN");
  assert.equal(
    packet.unknownReasons[0].code,
    "LOCAL_DRY_RUN_LUA_NON_UNKNOWN_REJECTED",
  );
});

test("CLI rejects remote and credential-bearing engine URLs before running a dry-run", async () => {
  const cases = {
    schemaVersion: 1,
    cases: [{
      id: "anonymous-case",
      question: "匿名问题",
      candidateCards: ["匿名卡"],
    }],
  };
  for (const engineUrl of [
    "https://127.0.0.1:8790",
    "http://engine.example.test:8790",
    "http://user:secret@127.0.0.1:8790",
  ]) {
    let dryRunCalls = 0;
    await assert.rejects(
      () => runAdminEvidenceDryRunCli([
        "--engine-url", engineUrl,
        "--compact",
      ], {
        readCases: async () => cases,
        async runDryRun() {
          dryRunCalls += 1;
          return {};
        },
        fetchImpl: async () => {
          throw new Error("rejected CLI URL must not fetch");
        },
        stdout: { write() {} },
      }),
      /only accepts/u,
    );
    assert.equal(dryRunCalls, 0);
  }
});

test("an injected local Lua packet remains UNKNOWN and cannot enable paid transport", async () => {
  const fixture = await readAdminEvidenceDryRunCases(casesUrl);
  const oneCase = {
    schemaVersion: fixture.schemaVersion,
    cases: [fixture.cases[0]],
  };
  const result = await runAdminEvidenceSnapshotDryRun({
    cases: oneCase,
    legacyLuaSemanticPacketFactory: async () => createLegacyLuaUnknownPacket({
      code: "LOCAL_ENGINE_TEST",
      message: "local engine test packet",
    }),
    enginePasscodeHydrationEnabled: true,
  });
  assert.equal(result.legacyLuaMode, "INJECTED_LOCAL_ENGINE");
  assert.equal(result.enginePasscodeHydrationEnabled, true);
  assert.equal(result.realProviderTransportCalls, 0);
  assert.equal(result.allPaidTransportsPrevented, true);
  assert.equal(result.reports[0].lua.verdict, "UNKNOWN");
  assert.equal(result.reports[0].transport.realProviderCalls, 0);
});

test("passcode hydration is absent by default and enabled only for explicit local-engine mode", async () => {
  const fixture = await readAdminEvidenceDryRunCases(casesUrl);
  const oneCase = {
    schemaVersion: fixture.schemaVersion,
    cases: [fixture.cases[0]],
  };
  const observed = [];
  const run = (enginePasscodeHydrationEnabled) =>
    runAdminEvidenceSnapshotDryRun({
      cases: oneCase,
      enginePasscodeHydrationEnabled,
      retrieveEvidence(options) {
        observed.push(options.env.OCG_ENGINE_URL ?? null);
        return retrieveRagEvidence(options);
      },
    });

  const defaultResult = await run(false);
  const localEngineResult = await run(true);

  assert.deepEqual(observed, [null, "http://127.0.0.1"]);
  assert.equal(defaultResult.enginePasscodeHydrationEnabled, false);
  assert.equal(localEngineResult.enginePasscodeHydrationEnabled, true);
  assert.equal(defaultResult.realProviderTransportCalls, 0);
  assert.equal(localEngineResult.realProviderTransportCalls, 0);
  assert.equal(defaultResult.allPaidTransportsPrevented, true);
  assert.equal(localEngineResult.allPaidTransportsPrevented, true);
});

test("community-card evidence network is narrowly allowlisted and never carries credentials", async () => {
  const calls = [];
  const allowed = createAllowlistedCommunityCardFetch({
    async fetchImpl(url, init) {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await allowed("https://ygocdb.com/api/v0/?search=test", {
    headers: { accept: "application/json" },
  });
  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(new Headers(calls[0].init.headers).has("authorization"), false);

  await assert.rejects(
    () => allowed("https://api.deepseek.com/chat/completions"),
    /not allowlisted/u,
  );
  await assert.rejects(
    () => allowed("https://ygocdb.com/api/v0/?search=test", {
      headers: { authorization: "Bearer secret" },
    }),
    /must not send authorization/u,
  );
  await assert.rejects(
    () => allowed("https://ygocdb.com/api/v0/other?search=test"),
    /not allowlisted/u,
  );
});

test("generic paid gate accepts complete visible text and blocks missing visible text", () => {
  const complete = minimalSnapshot({ includeVisibleCardText: true });
  const accepted = inspectAdminEvidencePaidGate({
    snapshot: complete,
    finalInput: buildFinalRulingInput(complete),
    candidateCards: ["匿名测试卡A"],
  });
  assert.equal(accepted.ready, true);

  const incomplete = minimalSnapshot({ includeVisibleCardText: false });
  const blocked = inspectAdminEvidencePaidGate({
    snapshot: incomplete,
    finalInput: buildFinalRulingInput(incomplete),
    candidateCards: ["匿名测试卡A"],
  });
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.missingVisibleCardTexts, ["匿名测试卡A"]);
});

function minimalSnapshot({ includeVisibleCardText }) {
  return createAdminEvidenceSnapshot({
    question: "匿名测试卡A的效果如何处理？",
    evidence: {
      questions: [{ questionId: "q1", text: "匿名测试卡A的效果如何处理？" }],
      providedFacts: [],
      cardResolution: {
        resolvedCards: [{ id: "test-card-a", name: "匿名测试卡A", input: "匿名测试卡A" }],
        unresolvedMentions: [],
        ambiguousMentions: [],
        omittedResolvedCards: [],
        userProvidedCardTexts: [],
      },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceDecisionPacket: {
        modelPacket: {
          evidenceItems: includeVisibleCardText ? [{
            evidenceId: "test-card-a",
            evidenceIds: ["test-card-a"],
            category: "parsed_card_text",
            body: "①：这个效果只用于匿名门禁测试。",
            bodyExcerpted: false,
          }] : [],
        },
      },
    },
    dataVersions: { fixture: "local-test" },
    metadata: { fixture: true },
    createdAt: "2026-08-05T00:00:00.000Z",
  });
}
