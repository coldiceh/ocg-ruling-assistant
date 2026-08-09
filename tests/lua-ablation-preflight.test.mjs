import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminEvidenceDecisionPacket,
  createAdminEvidenceArchive,
} from "../backend/adminEvidenceArchive.mjs";
import { createAdminEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";
import {
  createConfiguredLegacyLuaSemanticPacketFactory,
} from "../backend/legacyLuaSemanticProduction.mjs";
import {
  assertLuaAblationPreflight,
  normalizeLuaAblationPreflightOptions,
  parseLuaAblationPreflightArgs,
} from "../scripts/assert-lua-ablation-preflight.mjs";

test("Lua ablation preflight accepts the bundled Twin Tempests legality check", async () => {
  const packetFactory = createConfiguredLegacyLuaSemanticPacketFactory({ env: {} });
  const legacyLuaSemanticPacket = await packetFactory({
    cards: [{
      cid: "22130",
      passcode: "12197223",
      name: "天雷之双风神 息那",
    }],
  });
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      cardTexts: [{
        id: "twin-tempests-card-text",
        type: "card_text",
        text: "CARD_TEXT_CANARY：天雷之双风神 息那的完整卡片文本。",
      }],
    },
  });
  const snapshot = createAdminEvidenceSnapshot({
    question: "匿名发动合法性问题",
    evidence: {
      questions: [{ questionId: "q1", text: "匿名发动合法性问题" }],
      providedFacts: ["匿名场面事实"],
      cardResolution: {
        resolvedCards: [{
          cid: "22130",
          passcode: "12197223",
          name: "天雷之双风神 息那",
        }],
      },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceArchive: archive,
      evidenceDecisionPacket: buildAdminEvidenceDecisionPacket({ archive }),
      legacyLuaSemanticPacket,
    },
    createdAt: "2026-08-09T00:00:00.000Z",
  });
  const bundle = {
    schemaVersion: 1,
    kind: "admin-frozen-source-snapshot-bundle",
    sources: [{
      caseId: "anonymous-return-to-hand",
      evidenceSnapshot: snapshot,
      executionProfile: {
        evidenceVariant: "full",
        prompt: { instructions: "Return JSON." },
      },
    }],
  };

  const result = assertLuaAblationPreflight({
    bundle,
    caseId: "anonymous-return-to-hand",
    cid: "22130",
    passcode: "12197223",
    atomicOperation: "RETURN_TO_HAND",
    predicateApi: "Card.IsAbleToHand",
    selectorApi: "Duel.IsExistingMatchingCard",
    requiredMinimum: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.selectorApi, "Duel.IsExistingMatchingCard");
  assert.ok(result.cardTextCount > 0);
});

test("Lua ablation preflight CLI parsing is strict and generic", () => {
  const parsed = parseLuaAblationPreflightArgs([
    "--bundle", "bundle.json",
    "--case", "anonymous-case",
    "--cid", "123",
    "--passcode", "456",
    "--atomic-operation", "RETURN_TO_HAND",
    "--predicate-api", "Card.IsAbleToHand",
    "--selector-api", "Duel.IsExistingMatchingCard",
    "--required-minimum", "1",
  ]);
  const normalized = normalizeLuaAblationPreflightOptions(parsed);
  assert.equal(normalized.caseId, "anonymous-case");
  assert.equal(normalized.requiredMinimum, 1);
  assert.throws(
    () => parseLuaAblationPreflightArgs(["--card-name", "special-case"]),
    /unknown argument/u,
  );
});
