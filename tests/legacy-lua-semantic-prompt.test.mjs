import assert from "node:assert/strict";
import test from "node:test";

import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";

const identity = "a".repeat(64);

function legacyPacket() {
  return {
    schemaVersion: "ocg-assistant-lua-semantic-packet/v1",
    packetId: "legacy_lua_prompt_test",
    packetSha256: "b".repeat(64),
    authority: "LEGACY_COMPATIBILITY",
    canConfirmOfficialRuling: false,
    legacyAcceptedAsTruth: false,
    verdict: "UNKNOWN",
    resources: [{
      resourceId: "script:test",
      status: "READY",
      candidateCount: 1,
      resourceBinding: {
        sourceDocumentId: "legacy-script:test",
        sourceContentSha256: "c".repeat(64),
      },
      unknownReasons: [],
    }],
    effectCandidates: [{
      resourceId: "script:test",
      semanticEffectIdentity: identity,
      kind: "CANDIDATE",
      semanticArtifact: {
        plan: {
          costAtomicOperations: [],
          atomicOperations: ["SPECIAL_SUMMON", "RETURN_TO_HAND"],
          activationLegalityDependencies: ["CARD_CAN_RETURN_TO_HAND"],
          activationLegalityChecks: [{
            callbackSlot: "TARGET",
            predicateApi: "Card.IsAbleToHand",
            atomicOperation: "RETURN_TO_HAND",
            requiredMinimum: 1,
            dependencyGraph: { nodes: ["CARD_CAN_RETURN_TO_HAND"] },
          }],
          operationApis: ["Duel.SpecialSummon", "Duel.SendtoHand"],
          requiredLegacyApis: ["Card.IsAbleToHand"],
          unresolvedSemantics: [],
        },
      },
      analysisArtifact: {
        candidateVerdict: "FALSE",
      },
      unknownReasons: [],
    }],
    omittedCandidates: [],
    truncation: { omittedCandidateCount: 0 },
    unknownReasons: [],
  };
}

test("legacy Lua packet is visible as a non-authoritative operation hint", () => {
  const result = buildRagRulingPromptBundle({
    userQuery: "测试问题",
    evidence: { legacyLuaSemanticPacket: legacyPacket() },
  });

  assert.match(result.prompt, /legacyLuaSemanticPacket/u);
  assert.match(result.prompt, /RETURN_TO_HAND/u);
  assert.match(result.prompt, /CARD_CAN_RETURN_TO_HAND/u);
  assert.match(result.prompt, /正式 verdict 永远是 UNKNOWN/u);
  assert.match(result.prompt, /candidateVerdict 只描述旧脚本/u);
  assert.match(result.prompt, /可引用 evidence id 列表：\(none\)/u);
  assert.doesNotMatch(
    result.prompt,
    new RegExp(`可引用 evidence id 列表：[^\\n]*${identity}`, "u"),
  );
});

test("compact recovery prompt retains bounded Lua dependencies outside allowed evidence", () => {
  const result = buildRagRulingPromptBundle({
    userQuery: "测试问题",
    evidence: { legacyLuaSemanticPacket: legacyPacket() },
    env: { RAG_RECOVERY_PROMPT_CHARS: "12000" },
  });

  assert.match(result.recoveryPrompt, /legacyLuaSemanticPacket/u);
  assert.match(result.recoveryPrompt, /RETURN_TO_HAND/u);
  assert.match(result.recoveryPrompt, /CARD_CAN_RETURN_TO_HAND/u);
  assert.match(result.recoveryPrompt, /"allowedEvidenceIds":\[\]/u);
});
