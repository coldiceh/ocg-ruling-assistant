import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildAdminEvidenceDecisionPacket,
  createAdminEvidenceArchive,
} from "../backend/adminEvidenceArchive.mjs";
import { createAdminEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";
import {
  createConfiguredLegacyLuaSemanticPacketFactory,
} from "../backend/legacyLuaSemanticProduction.mjs";
import { buildLegacyLuaPromptModule } from "../backend/legacyLuaPromptModule.mjs";
import {
  assertLuaAblationPreflight,
  normalizeLuaAblationPreflightOptions,
  parseLuaAblationPreflightArgs,
} from "../scripts/assert-lua-ablation-preflight.mjs";
import { normalizeAdminEvidenceDryRunCases } from "../scripts/lib/admin-evidence-snapshot-dry-run.mjs";
import { validateAssertionFixture } from "../scripts/lib/offline-experiment-scorer.mjs";

test("Lua ablation fixtures isolate only return-to-hand candidate availability", async () => {
  const [caseText, goldenText] = await Promise.all([
    readFile(new URL("./fixtures/lua-return-to-hand-ablation-cases.json", import.meta.url), "utf8"),
    readFile(new URL("./fixtures/lua-return-to-hand-ablation-goldens.json", import.meta.url), "utf8"),
  ]);
  const cases = normalizeAdminEvidenceDryRunCases(JSON.parse(caseText));
  const goldens = validateAssertionFixture(JSON.parse(goldenText));

  assert.equal(cases.cases.length, 2);
  assert.deepEqual(
    cases.cases.map((item) => item.id).sort(),
    [...goldens.keys()].sort(),
  );
  assert.doesNotMatch(caseText, /expectedAnswer|leakCanary|LUA_ABLATION_GOLD_ONLY/u);
  for (const item of cases.cases) {
    assert.match(item.question, /本回合尚未使用过/u);
    assert.match(item.question, /怪兽区域有可用区域/u);
    assert.match(item.question, /不存在阻止对方特殊召唤/u);
  }
  const noExtraCandidate = cases.cases.find((item) => (
    item.id === "double-tempest-impermanence"
  ));
  const withExtraCandidate = cases.cases.find((item) => (
    item.id === "double-tempest-impermanence-extra-returnable"
  ));
  assert.match(noExtraCandidate.question, /场上没有其他魔法·陷阱卡/u);
  assert.doesNotMatch(noExtraCandidate.question, /强制脱出装置/u);
  assert.match(withExtraCandidate.question, /盖放、尚未发动的『强制脱出装置』/u);
  assert.match(withExtraCandidate.question, /使『强制脱出装置』不能回到手牌/u);
});

test("Lua ablation preflight accepts the bundled Twin Tempests legality check", async () => {
  const packetFactory = createConfiguredLegacyLuaSemanticPacketFactory({ env: {} });
  const legacyLuaSemanticPacket = await packetFactory({
    cards: [{
      cid: "22130",
      passcode: "12197223",
      name: "天雷之双风神 息那",
    }],
  });
  const resolvedCard = {
    cid: "22130",
    passcode: "12197223",
    name: "天雷之双风神 息那",
  };
  const luaModule = buildLegacyLuaPromptModule({
    packet: legacyLuaSemanticPacket,
    resolvedCards: [resolvedCard],
    enabled: true,
  });
  assert.equal(luaModule.status, "READY");
  assert.equal(luaModule.audit.reasonCategory, "AVAILABLE_PARTIAL_COVERAGE");
  assert.deepEqual(luaModule.modelPayload.coverage, {
    complete: false,
    knownEffectCount: 1,
    unknownEffectCount: 1,
    negativeInferenceAllowed: false,
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
        resolvedCards: [resolvedCard],
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

  assert.throws(
    () => assertLuaAblationPreflight({
      bundle,
      caseId: "anonymous-return-to-hand",
      cid: "22131",
      passcode: "12197223",
      atomicOperation: "RETURN_TO_HAND",
      predicateApi: "Card.IsAbleToHand",
      selectorApi: "Duel.IsExistingMatchingCard",
      requiredMinimum: 1,
    }),
    /not uniquely bound to resolved card CID 22131 and passcode 12197223/u,
  );

  assert.throws(
    () => assertLuaAblationPreflight({
      bundle,
      caseId: "anonymous-return-to-hand",
      cid: "22130",
      passcode: "12197224",
      atomicOperation: "RETURN_TO_HAND",
      predicateApi: "Card.IsAbleToHand",
      selectorApi: "Duel.IsExistingMatchingCard",
      requiredMinimum: 1,
    }),
    /not uniquely bound to resolved card CID 22130 and passcode 12197224/u,
  );
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
