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
            dependencyGraph: {
              dependencies: ["CARD_CAN_RETURN_TO_HAND"],
            },
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

test("the public RAG prompt ignores legacy Lua packets", () => {
  const result = buildRagRulingPromptBundle({
    userQuery: "测试问题",
    evidence: { legacyLuaSemanticPacket: legacyPacket() },
  });

  assert.match(result.prompt, /测试问题/u);
  assert.doesNotMatch(result.prompt, /legacyLuaSemanticPacket|RETURN_TO_HAND|CARD_CAN_RETURN_TO_HAND/u);
  assert.doesNotMatch(result.recoveryPrompt, /legacyLuaSemanticPacket|RETURN_TO_HAND|CARD_CAN_RETURN_TO_HAND/u);
});

test("legacy Lua cannot revive the removed public recovery prompt", () => {
  const result = buildRagRulingPromptBundle({
    userQuery: "测试问题",
    evidence: { legacyLuaSemanticPacket: legacyPacket() },
    env: { RAG_RECOVERY_PROMPT_CHARS: "12000" },
  });

  assert.doesNotMatch(result.recoveryPrompt, /legacyLuaSemanticPacket|RETURN_TO_HAND|CARD_CAN_RETURN_TO_HAND/u);
  assert.doesNotMatch(result.prompt, /legacyLuaSemanticPacket|RETURN_TO_HAND|CARD_CAN_RETURN_TO_HAND/u);
});
