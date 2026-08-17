import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createAdminModelLabService } from "../backend/adminModelLabService.mjs";
import {
  createMemoryAdminFinalCallBudgetLedger,
} from "../backend/adminFinalCallBudgetLedger.mjs";
import {
  createAdminRunStore,
  createMemoryAdminRunStorage,
} from "../backend/adminRunStore.mjs";
import { evaluateAdminLabResult } from "../backend/adminLabEvaluation.mjs";

const evaluationCorpus = JSON.parse(await readFile(
  new URL("../data/test/admin-model-lab-evaluations.json", import.meta.url),
  "utf8",
));

test("local Evidence Snapshot covers every expected card without network or model calls", async (t) => {
  let runSequence = 0;
  const openAIRequests = [];
  const blockedFetches = [];
  const runStore = createAdminRunStore({
    storage: createMemoryAdminRunStorage(),
    runIdFactory: () => `offline-evidence-coverage-${++runSequence}`,
  });
  const service = createAdminModelLabService({
    runStore,
    finalCallBudgetLedger: createMemoryAdminFinalCallBudgetLedger({
      timezone: "UTC",
      pools: {
        openai: { dailyBudgetCny: 1_000, reservationCny: 10 },
      },
    }),
    env: {
      ADMIN_MODEL_LAB_ENABLED: "true",
      ADMIN_OPENAI_ENABLED: "true",
      OPENAI_API_KEY: "offline-placeholder",
      DEEPSEEK_API_KEY: "offline-placeholder",
      ADMIN_MODEL_LAB_LIVE_OFFICIAL_QA: "false",
      RAG_LIVE_OFFICIAL_QA: "false",
    },
    preparationProviders: { relay: {
      providerId: "relay",
      async prepareEvidence() {
        return {
          provider: "relay",
          model: "deterministic-empty-fixture",
          result: {
            cardNameCandidates: [],
            ruleSearchQueries: [],
            unresolvedNotes: [],
            conflicts: [],
          },
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
          },
        };
      },
    } },
    openAIProvider: {
      async create(request) {
        openAIRequests.push(request);
        return {
          id: `offline-captured-response-${openAIRequests.length}`,
          status: "queued",
          model: request.model,
        };
      },
    },
    retrievalFetchImpl: async (url) => {
      blockedFetches.push(String(url));
      const identityFixture = matchIdentityFixture(url);
      if (identityFixture) return jsonResponse(identityFixture);
      return new Response("", { status: 404 });
    },
    promptLoader: async () => "Offline Evidence Snapshot coverage test.",
  });

  const diagnostics = [];
  for (const evaluationCase of evaluationCorpus.cases) {
    const created = await service.createRun({
      body: {
        question: evaluationCase.question,
        label: evaluationCase.id,
      },
    });
    const execution = await service.executeRun({ runId: created.runId });
    const snapshot = execution.run.evidenceSnapshot;
    const evidence = snapshot.evidence;
    const resolvedCards = evidence.cardResolution?.resolvedCards || [];
    const resolvedIds = new Set(resolvedCards.map(cardId));
    const archive = evidence.evidenceArchive;
    const decisionPacket = evidence.evidenceDecisionPacket;
    const documentByHash = new Map(
      (archive?.documents || []).map((document) => [document.bodyHash, document.text]),
    );
    const textById = new Map(
      (archive?.evidenceIndex || []).map((entry) => [
        String(entry.evidenceId),
        (entry.bodyHashes || []).map((hash) => documentByHash.get(hash) || "").join("\n"),
      ]),
    );
    const missingCardIds = evaluationCase.expectedCardIds
      .map(String)
      .filter((id) => !resolvedIds.has(id));
    const missingCardTextIds = evaluationCase.expectedCardIds
      .map(String)
      .filter((id) => !textById.get(id)?.trim());
    const bucketCounts = Object.fromEntries(
      Object.entries(evidence.evidenceBuckets || {})
        .filter(([, value]) => Array.isArray(value))
        .map(([key, value]) => [key, value.length]),
    );
    const conflictTypes = {};
    for (const conflict of evidence.conflicts || []) {
      const type = String(conflict.type || "unknown");
      conflictTypes[type] = (conflictTypes[type] || 0) + 1;
    }

    assert.deepEqual(missingCardIds, [], `${evaluationCase.id}: expected cards must resolve`);
    assert.deepEqual(missingCardTextIds, [], `${evaluationCase.id}: expected cards must include card text`);
    assert.equal(
      evidence.initialRequest.evidence.request.liveOfficialQaEnabled,
      false,
      `${evaluationCase.id}: live official QA must remain disabled`,
    );
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(archive), true);
    assert.equal(execution.providerRequest.status, "queued");
    const packetEvidenceIds = new Set(
      (decisionPacket?.modelPacket?.evidenceItems || []).flatMap(
        (item) => item.evidenceIds || [item.evidenceId],
      ),
    );
    const packetEvidenceRanks = new Map();
    for (const [index, item] of (
      decisionPacket?.modelPacket?.evidenceItems || []
    ).entries()) {
      for (const evidenceId of item.evidenceIds || [item.evidenceId]) {
        if (!packetEvidenceRanks.has(evidenceId)) {
          packetEvidenceRanks.set(evidenceId, index + 1);
        }
      }
    }
    for (const expectedEvidenceId of evaluationCase.expectedEvidenceIds || []) {
      assert.equal(
        packetEvidenceIds.has(expectedEvidenceId),
        true,
        `${evaluationCase.id}: decisive evidence ${expectedEvidenceId} must reach the final-model packet`,
      );
      assert.match(
        openAIRequests.at(-1)?.input || "",
        new RegExp(escapeRegExp(expectedEvidenceId), "u"),
        `${evaluationCase.id}: final-model input must contain ${expectedEvidenceId}`,
      );
      if (Number.isInteger(evaluationCase.expectedEvidenceMaxRank)) {
        assert.ok(
          packetEvidenceRanks.get(expectedEvidenceId) <= evaluationCase.expectedEvidenceMaxRank,
          `${evaluationCase.id}: ${expectedEvidenceId} rank ${packetEvidenceRanks.get(expectedEvidenceId)} must be within the first ${evaluationCase.expectedEvidenceMaxRank} visible items`,
        );
      }
    }
    const packetOnlyAssessment = evaluateAdminLabResult({
      testCase: evaluationCase,
      structuredResult: {
        conciseAnswer: "packet coverage probe",
        verdicts: [],
        claims: [],
        timeline: [],
      },
      evidenceSnapshot: snapshot,
    });
    assert.equal(
      packetOnlyAssessment.summary.cardEvidenceCoverage,
      1,
      `${evaluationCase.id}: every expected card text must be visible to the final model`,
    );
    assert.equal(
      packetOnlyAssessment.summary.evidenceCoverage,
      1,
      `${evaluationCase.id}: every decisive evidence id must be visible within its declared packet rank: ${JSON.stringify(packetOnlyAssessment.checks.evidenceCoverage)}`,
    );
    const finalModelInputBytes = Buffer.byteLength(openAIRequests.at(-1)?.input || "");
    assert.ok(
      finalModelInputBytes < 150_000,
      `${evaluationCase.id}: final-model input must stay bounded (actual ${finalModelInputBytes} bytes)`,
    );

    diagnostics.push({
      id: evaluationCase.id,
      expectedCardCount: evaluationCase.expectedCardIds.length,
      resolvedCardCount: resolvedCards.length,
      unresolvedMentionCount: evidence.cardResolution?.unresolvedMentions?.length || 0,
      ambiguousMentionCount: evidence.cardResolution?.ambiguousMentions?.length || 0,
      directOfficialQaCount: bucketCounts.officialQaDirectCandidates || 0,
      archivedOccurrenceCount: archive?.statistics?.inputOccurrenceCount || 0,
      uniqueEvidenceBodyCount: archive?.statistics?.uniqueBodyCount || 0,
      decisionPacketEvidenceCount:
        decisionPacket?.statistics?.includedSubstanceCount || 0,
      decisionPacketBytes: decisionPacket?.statistics?.modelPacketBytes || 0,
      expectedEvidenceRanks: Object.fromEntries(
        (evaluationCase.expectedEvidenceIds || []).map((evidenceId) => [
          evidenceId,
          packetEvidenceRanks.get(evidenceId) || null,
        ]),
      ),
      finalModelInputBytes,
      bucketCounts,
      conflictTypes,
      conflictSample: (evidence.conflicts || []).slice(0, 5).map((conflict) => ({
        type: conflict.type,
        evidenceId: conflict.evidenceId || null,
        differenceSummary: conflict.differenceSummary || null,
      })),
      retrievalWarnings: evidence.retrievalWarnings || [],
      completeness: evidence.completeness,
      snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    });
  }

  assert.equal(openAIRequests.length, evaluationCorpus.cases.length);
  t.diagnostic(JSON.stringify({
    blockedExternalFetchCount: blockedFetches.length,
    diagnostics,
  }));
});

function cardId(card = {}) {
  return String(card.id || card.cardId || "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matchIdentityFixture(url) {
  const parsed = new URL(String(url));
  const search = parsed.searchParams.get("search") || "";
  if (parsed.hostname !== "ygocdb.com") return null;
  const fixtures = [
    {
      matches: /(?:教导.*圣女|艾克|莉西亚|教導の聖女|Dogmatika Ecclesia)/iu,
      card: {
        cid: 15239,
        id: 60303688,
        cn_name: "教导的圣女 艾克莉西亚",
        sc_name: "教导之圣女 艾克利西亚",
        jp_name: "教導の聖女エクレシア",
        en_name: "Dogmatika Ecclesia, the Virtuous",
      },
    },
    {
      matches: /(?:闪刀姬.*零[萝露]|閃刀姫.*ゼロ|Sky Striker Ace.*Zero)/iu,
      card: {
        cid: 21460,
        id: 76072561,
        cn_name: "闪刀姬＝零萝",
        sc_name: "闪刀姬＝零露",
        jp_name: "閃刀姫＝ゼロ",
        en_name: "Sky Striker Ace = Zero",
      },
    },
    {
      matches: /(?:千[察查]万别|センサー万別|There Can Be Only One)/iu,
      card: {
        cid: 13447,
        id: 24207889,
        cn_name: "千察万别",
        sc_name: "千查万别",
        jp_name: "センサー万別",
        en_name: "There Can Be Only One",
      },
    },
  ];
  const fixture = fixtures.find((item) => item.matches.test(search));
  if (!fixture) return null;
  return {
    result: [{
      ...fixture.card,
      text: { desc: "测试身份夹具；卡片正文仍必须取自本地稳定 CID 记录。" },
    }],
    next: 0,
  };
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
