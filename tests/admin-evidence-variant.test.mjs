import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminEvidenceDecisionPacket,
  createAdminEvidenceArchive,
} from "../backend/adminEvidenceArchive.mjs";
import {
  ADMIN_EVIDENCE_VARIANTS,
  adminEvidenceVariantIncludesLegacyLua,
  normalizeAdminEvidenceVariant,
} from "../backend/adminEvidenceVariant.mjs";
import {
  buildFinalRulingInput,
  buildFinalRulingModelEvidencePacket,
} from "../backend/adminModelLabService.mjs";
import { buildLegacyLuaPromptModule } from "../backend/legacyLuaPromptModule.mjs";
import {
  canonicalLegacyLuaSha256,
  createLegacyLuaSemanticPacket,
  createLegacyLuaUnknownPacket,
  finalizeLegacyLuaSemanticResource,
} from "../backend/legacyLuaSemanticPacket.mjs";

test("full evidence variant omits unavailable Lua without changing ordinary evidence", () => {
  const snapshot = {
    snapshotId: "snapshot-full-golden",
    contentSha256: "f".repeat(64),
    question: "匿名问题",
    evidence: {
      questions: [{ questionId: "q1", text: "匿名问题" }],
      providedFacts: ["匿名事实"],
      cardResolution: { resolvedCards: [] },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceDecisionPacket: { modelPacket: { evidenceItems: [] } },
    },
  };
  const expected = [
    "以下是从完整、冻结且通过内容哈希校验的 Evidence Snapshot 生成的有界决策资料包。",
    "完整候选与冲突保存在审计归档；这里只给出确定性选出的正文、有界冲突摘要及遗漏/截断计数。",
    "资料准备模型只提供候选卡名与补充检索词，不是裁定；确定性查询始终优先，但模型补充词仍可能扩展候选集合，所以必须独立核对每条可见证据。",
    "只能引用 evidenceDecisionPacket.evidenceItems 中实际展示正文的 evidenceId；omissionSummary 只有计数与审计哈希，不是证据。",
    "不得调用网络搜索，不得引用快照外资料。",
    `{"schemaVersion":2,"evidenceSnapshot":{"id":"snapshot-full-golden","sha256":"${"f".repeat(64)}"},"questions":[{"questionId":"q1","text":"匿名问题"}],"providedFacts":["匿名事实"],"cardResolution":{"resolvedCards":[]},"unresolved":{},"retrievalWarnings":[],"completeness":{},"evidenceDecisionPacket":{"evidenceItems":[]}}`,
  ].join("\n");

  assert.equal(buildFinalRulingInput(snapshot), expected);
  assert.equal(buildFinalRulingInput(snapshot, { evidenceVariant: "full" }), expected);
});

test("final input does not add hand-written topic-specific review instructions", () => {
  const snapshotFor = (decisionFocus) => ({
    snapshotId: "snapshot-preamble-gate",
    contentSha256: "e".repeat(64),
    question: "C2处理后对象离场，已经组成连锁的C1如何继续处理？",
    evidence: {
      questions: [{
        questionId: "q1",
        text: "C2处理后对象离场，已经组成连锁的C1如何继续处理？",
      }],
      providedFacts: [],
      cardResolution: { resolvedCards: [] },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceDecisionPacket: {
        modelPacket: {
          schemaVersion: 2,
          decisionFocus,
          evidenceItems: [],
        },
      },
    },
  });
  const preambleOf = (input) => input.split("\n").slice(0, -1).join("\n");

  const resolutionPreamble = preambleOf(buildFinalRulingInput(snapshotFor({
    asksActivationLegality: false,
    mandatoryConstraintReview: [],
    reviewProtocol: [],
  })));
  assert.doesNotMatch(resolutionPreamble, /mandatoryConstraintReview/u);
  assert.doesNotMatch(resolutionPreamble, /activationLegalityChecks/u);
  assert.doesNotMatch(resolutionPreamble, /selectorSummary/u);

  const activationPreamble = preambleOf(buildFinalRulingInput(snapshotFor({
    asksActivationLegality: true,
    mandatoryConstraintReview: [],
    reviewProtocol: ["activation-review"],
  })));
  assert.doesNotMatch(activationPreamble, /mandatoryConstraintReview/u);
  assert.doesNotMatch(activationPreamble, /activationLegalityChecks/u);
  assert.doesNotMatch(activationPreamble, /selectorSummary/u);

  const mandatoryPreamble = preambleOf(buildFinalRulingInput(snapshotFor({
    asksActivationLegality: false,
    mandatoryConstraintReview: [{ evidenceId: "rule-1" }],
    reviewProtocol: ["activation-review"],
  }), { evidenceVariant: "without_lua" }));
  assert.doesNotMatch(mandatoryPreamble, /mandatoryConstraintReview/u);
  assert.doesNotMatch(mandatoryPreamble, /activationLegalityChecks/u);
});

test("historical topic instructions stay archived but are absent from every model projection", () => {
  const historicalPacket = {
    schemaVersion: 2,
    decisionFocus: {
      mandatoryConstraintReview: [],
      reviewProtocol: ["legacy-unconditional-activation-review"],
    },
    evidenceItems: [],
  };
  const snapshotFor = (question) => ({
    snapshotId: "snapshot-historical-review",
    contentSha256: "d".repeat(64),
    question,
    evidence: {
      questions: [{ questionId: "q1", text: question }],
      providedFacts: [],
      cardResolution: { resolvedCards: [] },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceDecisionPacket: { modelPacket: structuredClone(historicalPacket) },
    },
  });

  const resolutionPacket = buildFinalRulingModelEvidencePacket(snapshotFor(
    "已经组成连锁的效果如何继续处理？",
  ));
  const activationPacket = buildFinalRulingModelEvidencePacket(snapshotFor(
    "当前效果能否发动？",
  ));
  assert.equal(resolutionPacket.decisionFocus, undefined);
  assert.equal(activationPacket.decisionFocus, undefined);
  assert.deepEqual(
    historicalPacket.decisionFocus.reviewProtocol,
    ["legacy-unconditional-activation-review"],
    "model projection must not mutate the archived packet",
  );
});

test("generic evidence projections expose full, no-Lua, card-text-only, and card-text-plus-Lua views", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      cardTexts: [{
        id: "arbitrary-card-text",
        type: "card_text",
        text: "CARD_TEXT_ONLY_CANARY：任意卡的完整效果文本。",
      }],
      officialQaDirectCandidates: [{
        id: "arbitrary-direct-qa",
        type: "official_qa",
        question: "QA_ONLY_QUESTION_CANARY",
        answer: "QA_ONLY_ANSWER_CANARY",
        isDirect: true,
      }],
      rulebookCandidates: [{
        id: "arbitrary-rule",
        type: "rulebook",
        text: "RULE_ONLY_CANARY",
      }],
    },
  });
  const decisionPacket = buildAdminEvidenceDecisionPacket({ archive });
  const legacyLuaSemanticPacket = createLegacyLuaUnknownPacket({
    code: "ARBITRARY_LUA_UNAVAILABLE",
    message: "LUA_ONLY_CANARY",
  });
  const snapshot = {
    snapshotId: "snapshot-generic-ablation",
    contentSha256: "a".repeat(64),
    question: "SCENARIO_ONLY_CANARY",
    evidence: {
      questions: [{ questionId: "q1", text: "QUESTION_ONLY_CANARY" }],
      providedFacts: ["PROVIDED_FACT_ONLY_CANARY"],
      cardResolution: {
        resolvedCards: [{
          id: "arbitrary-card",
          passcode: "31415926",
          name: "任意测试卡",
        }],
      },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceArchive: archive,
      evidenceDecisionPacket: decisionPacket,
      legacyLuaSemanticPacket,
      goldens: [{ answer: "GOLD_ONLY_ANSWER_MUST_NOT_LEAK" }],
      expectedAnswer: "GOLD_ONLY_EXPECTED_MUST_NOT_LEAK",
    },
  };

  const full = buildFinalRulingInput(snapshot, { evidenceVariant: "full" });
  const withoutLua = buildFinalRulingInput(snapshot, { evidenceVariant: "without_lua" });
  const fullPlusLua = buildFinalRulingInput(snapshot, { evidenceVariant: "full_plus_lua" });
  const cardTextOnly = buildFinalRulingInput(snapshot, { evidenceVariant: "card_text_only" });
  const cardTextPlusLua = buildFinalRulingInput(snapshot, {
    evidenceVariant: "card_text_plus_lua",
  });

  assert.match(full, /QA_ONLY_ANSWER_CANARY/u);
  assert.match(full, /RULE_ONLY_CANARY/u);
  assert.doesNotMatch(full, /ARBITRARY_LUA_UNAVAILABLE/u);
  assert.match(withoutLua, /QA_ONLY_ANSWER_CANARY/u);
  assert.match(withoutLua, /RULE_ONLY_CANARY/u);
  assert.doesNotMatch(withoutLua, /ARBITRARY_LUA_UNAVAILABLE/u);
  assert.equal(fullPlusLua, full);
  assert.equal(withoutLua, full);
  assert.match(cardTextOnly, /QUESTION_ONLY_CANARY/u);
  assert.match(cardTextOnly, /PROVIDED_FACT_ONLY_CANARY/u);
  assert.match(cardTextOnly, /CARD_TEXT_ONLY_CANARY/u);
  assert.doesNotMatch(cardTextOnly, /QA_ONLY_(?:QUESTION|ANSWER)_CANARY/u);
  assert.doesNotMatch(cardTextOnly, /RULE_ONLY_CANARY/u);
  assert.doesNotMatch(cardTextOnly, /ARBITRARY_LUA_UNAVAILABLE/u);
  assert.match(cardTextPlusLua, /QUESTION_ONLY_CANARY/u);
  assert.match(cardTextPlusLua, /PROVIDED_FACT_ONLY_CANARY/u);
  assert.match(cardTextPlusLua, /CARD_TEXT_ONLY_CANARY/u);
  assert.doesNotMatch(cardTextPlusLua, /ARBITRARY_LUA_UNAVAILABLE/u);
  assert.doesNotMatch(cardTextPlusLua, /QA_ONLY_(?:QUESTION|ANSWER)_CANARY/u);
  assert.doesNotMatch(cardTextPlusLua, /RULE_ONLY_CANARY/u);
  for (const input of [full, withoutLua, cardTextOnly, cardTextPlusLua]) {
    assert.doesNotMatch(input, /GOLD_ONLY_(?:ANSWER|EXPECTED)_MUST_NOT_LEAK/u);
  }

  const cardPayload = JSON.parse(cardTextOnly.split("\n").at(-1));
  assert.deepEqual(
    cardPayload.evidenceDecisionPacket,
    buildFinalRulingModelEvidencePacket(snapshot, {
      evidenceVariant: "card_text_only",
    }),
    "the final input and validator must consume the identical projection",
  );
  assert.deepEqual(
    buildFinalRulingModelEvidencePacket(snapshot, { evidenceVariant: "without_lua" }),
    buildFinalRulingModelEvidencePacket(snapshot, { evidenceVariant: "full" }),
    "without_lua removes only the independent Lua packet",
  );
  assert.deepEqual(
    cardPayload.evidenceDecisionPacket.evidenceItems.map((item) => item.category),
    ["parsed_card_text"],
  );
  assert.equal(cardPayload.evidenceDecisionPacket.evidenceItems[0].bodyExcerpted, false);
  const cardPlusLuaPayload = JSON.parse(cardTextPlusLua.split("\n").at(-1));
  assert.deepEqual(
    cardPlusLuaPayload.evidenceDecisionPacket,
    cardPayload.evidenceDecisionPacket,
    "the two card-text projections must differ only by the independent Lua packet",
  );
  assert.equal(cardPlusLuaPayload.legacyLuaPromptHints, undefined);
  assert.equal(
    cardTextPlusLua,
    cardTextOnly,
    "an unavailable Lua packet must preserve the exact no-Lua model input",
  );
});

test("READY Lua variants append exactly one isolated addon to byte-identical baselines", () => {
  const resolvedCard = {
    id: "12345",
    cid: "12345",
    passcode: "87654321",
    name: "匿名卡甲",
  };
  const legacyLuaSemanticPacket = readyLegacyLuaPacket();
  const luaModule = buildLegacyLuaPromptModule({
    packet: legacyLuaSemanticPacket,
    resolvedCards: [resolvedCard],
    enabled: true,
  });
  assert.equal(luaModule.status, "READY");

  const modelPacket = {
    schemaVersion: 2,
    evidenceItems: [{
      evidenceId: "anonymous-card-text",
      category: "parsed_card_text",
      body: "匿名卡甲的完整卡片文本。",
      bodyExcerpted: false,
    }],
  };
  const snapshot = {
    snapshotId: "snapshot-ready-lua-ab",
    contentSha256: "a".repeat(64),
    question: "匿名规则问题",
    evidence: {
      questions: [{ questionId: "q1", text: "匿名规则问题" }],
      providedFacts: ["匿名场面事实"],
      cardResolution: { resolvedCards: [resolvedCard] },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceDecisionPacket: { modelPacket },
      legacyLuaSemanticPacket,
    },
  };

  const full = buildFinalRulingInput(snapshot, { evidenceVariant: "full" });
  const fullPlusLua = buildFinalRulingInput(snapshot, {
    evidenceVariant: "full_plus_lua",
  });
  const cardTextOnly = buildFinalRulingInput(snapshot, {
    evidenceVariant: "card_text_only",
  });
  const cardTextPlusLua = buildFinalRulingInput(snapshot, {
    evidenceVariant: "card_text_plus_lua",
  });

  assert.equal(fullPlusLua, `${full}\n${luaModule.promptAddon}`);
  assert.equal(cardTextPlusLua, `${cardTextOnly}\n${luaModule.promptAddon}`);
  assert.equal(countExactSubstring(fullPlusLua, luaModule.promptAddon), 1);
  assert.equal(countExactSubstring(cardTextPlusLua, luaModule.promptAddon), 1);
  assert.doesNotMatch(full, /legacyLuaPromptHints/u);
  assert.doesNotMatch(cardTextOnly, /legacyLuaPromptHints/u);

  const fullPayload = JSON.parse(full.split("\n").at(-1));
  const cardTextPayload = JSON.parse(cardTextOnly.split("\n").at(-1));
  assert.equal(fullPayload.legacyLuaPromptHints, undefined);
  assert.equal(cardTextPayload.legacyLuaPromptHints, undefined);
  assert.deepEqual(
    buildFinalRulingModelEvidencePacket(snapshot, {
      evidenceVariant: "full_plus_lua",
    }),
    buildFinalRulingModelEvidencePacket(snapshot, { evidenceVariant: "full" }),
  );
  assert.deepEqual(
    buildFinalRulingModelEvidencePacket(snapshot, {
      evidenceVariant: "card_text_plus_lua",
    }),
    buildFinalRulingModelEvidencePacket(snapshot, {
      evidenceVariant: "card_text_only",
    }),
  );
  assert.deepEqual(
    fullPayload.evidenceDecisionPacket,
    buildFinalRulingModelEvidencePacket(snapshot, { evidenceVariant: "full" }),
  );
  assert.deepEqual(
    cardTextPayload.evidenceDecisionPacket,
    buildFinalRulingModelEvidencePacket(snapshot, {
      evidenceVariant: "card_text_only",
    }),
  );
});

test("evidence variants are a strict generic enum", () => {
  assert.deepEqual(ADMIN_EVIDENCE_VARIANTS, [
    "full",
    "full_plus_lua",
    "card_text_only",
    "card_text_plus_lua",
    "without_lua",
  ]);
  assert.equal(adminEvidenceVariantIncludesLegacyLua("full"), false);
  assert.equal(adminEvidenceVariantIncludesLegacyLua("without_lua"), false);
  assert.equal(adminEvidenceVariantIncludesLegacyLua("card_text_only"), false);
  assert.equal(adminEvidenceVariantIncludesLegacyLua("full_plus_lua"), true);
  assert.equal(adminEvidenceVariantIncludesLegacyLua("card_text_plus_lua"), true);
  assert.equal(normalizeAdminEvidenceVariant(undefined), "full");
  assert.throws(
    () => normalizeAdminEvidenceVariant("case-specific-override"),
    (error) => error?.code === "admin_evidence_variant_invalid",
  );
});

function readyLegacyLuaPacket() {
  const identityScheme = "ocg-legacy-lua-semantic-effect-identity/v1";
  const sourceDocumentId =
    "legacy-script:cid-12345:passcode-87654321:anonymous";
  const sourceHash = "1".repeat(64);
  const semanticEffectIdentity = "2".repeat(64);
  const registryHash = "3".repeat(64);
  const versions = anonymousEngineVersions();
  const plan = {
    schemaVersion: "ocg-legacy-lua-activation-plan/v2",
    sourceDocumentId,
    sourceContentHash: sourceHash,
    verificationStatus: "LEGACY_DISCOVERY_ONLY",
    semanticEffectIdentity,
    identityScheme,
    semanticFingerprint: "4".repeat(64),
    apiSemanticsRegistryId: "anonymous-registry",
    apiSemanticsRegistryVersion: "1.0.0-anonymous",
    apiSemanticsRegistryHash: registryHash,
    costAtomicOperations: [],
    atomicOperations: ["RETURN_TO_HAND"],
    operationApis: ["Duel.SendtoHand"],
    requiredLegacyApis: ["Card.IsAbleToHand"],
    activationLegalityChecks: [{
      callbackSlot: "TARGET",
      predicateApi: "Card.IsAbleToHand",
      atomicOperation: "RETURN_TO_HAND",
      requiredMinimum: 1,
      dependencyGraph: { dependencies: ["CARD_CAN_RETURN_TO_HAND"] },
      predicateSubject: { kind: "VARIABLE", name: "FILTER_CARD" },
    }],
    versions: anonymousArtifactVersions(versions),
  };
  const semanticArtifact = {
    kind: "CANDIDATE",
    semanticEffectIdentity,
    identityScheme,
    plan,
  };
  const candidateBody = {
    kind: "CANDIDATE",
    verdict: "UNKNOWN",
    legacyAcceptedAsTruth: false,
    semanticEffectIdentity,
    identityScheme,
    semanticArtifactSha256: canonicalLegacyLuaSha256(semanticArtifact),
    compileResultSha256: "5".repeat(64),
    analysisArtifactSha256: null,
    semanticArtifact,
    analysisArtifact: null,
    unknownReasons: [],
  };
  const candidate = {
    ...candidateBody,
    candidateSha256: canonicalLegacyLuaSha256(candidateBody),
  };
  const resource = finalizeLegacyLuaSemanticResource({
    status: "READY",
    resourceId: "anonymous-ready-lua-resource",
    resourceBinding: {
      sourceDocumentId,
      sourceContentSha256: sourceHash,
      documentVersion: "anonymous-fixture@1",
      locator: "fixture://anonymous/legacy.lua",
      retrievedAt: "2026-08-13T00:00:00.000Z",
    },
    engineBinding: {
      versions,
      versionsSha256: canonicalLegacyLuaSha256(versions),
      capabilitiesSha256: "6".repeat(64),
      requiredCapabilities: [],
    },
    registryBinding: {
      registryId: "anonymous-registry",
      registryVersion: "1.0.0-anonymous",
      registrySha256: registryHash,
      pinnedCoreRepository: "https://example.invalid/anonymous-core.git",
      pinnedCoreCommit: "7".repeat(40),
      pinnedCoreApiAbi: "anonymous-core/1",
    },
    candidateSetSha256: "8".repeat(64),
    effectCandidates: [candidate],
    unknownReasons: [],
  });
  return createLegacyLuaSemanticPacket({ resources: [resource] });
}

function anonymousEngineVersions() {
  return {
    engineVersion: "ocg-formal-engine/anonymous",
    irVersion: "ocg-effect-ir/v1",
    rulesetVersion: "ocg-ruleset/anonymous",
    schemaVersion: "ocg-formal-engine/v1",
    compilerVersion: "ocg-card-compiler/v1",
    patternLibraryVersion: "ocg-pattern-library/v1",
    proofVerifierVersion: "ocg-proof-verifier/v1",
    artifacts: {
      luaApiSemanticsRegistryVersion: "ocg-lua-api-semantics-registry/v2",
      operationDependencyGraphVersion: "ocg-operation-dependency-graph/v1",
      legacyLuaActivationPlanVersion: "ocg-legacy-lua-activation-plan/v2",
      legacyLuaCompileResultVersion: "ocg-legacy-lua-compile-result/v2",
      legacyLuaEffectCandidateSetVersion:
        "ocg-legacy-lua-effect-candidate-set/v1",
      activationLegalityScenarioVersion:
        "ocg-activation-legality-scenario/v1",
      legacyLuaCandidateAnalysisVersion:
        "ocg-legacy-lua-candidate-analysis/v2",
    },
  };
}

function anonymousArtifactVersions(versions) {
  const { artifacts: _artifacts, ...result } = versions;
  return structuredClone(result);
}

function countExactSubstring(value, substring) {
  return String(value).split(String(substring)).length - 1;
}
