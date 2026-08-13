import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRagRulingPromptBundle,
  selectAuthoritativeOfficialDirectCandidate,
} from "../backend/ragRulingPrompt.mjs";

function fixtureEvidence() {
  return {
    officialQaDirectCandidates: [],
    officialQaRelated: [{
      id: "qa-anonymous-applicability-contrast",
      type: "related",
      title: "相似但前提不同的官方问答",
      text: "来源题面中的玩家被禁止执行操作，因此结论只适用于该限制。",
      isDirect: false,
      matchLevel: "official_related",
      scenarioPremiseCompatibility: "mismatch",
      scenarioPremiseConflicts: [{
        family: "scenario_fact",
        reason: "premise_not_equivalent",
        queryFact: "special_summon:operand_availability:absent:both_players",
        evidenceFacts: ["special_summon:actor_permission:prohibited:both_players"],
      }],
      queryApplicabilityFrame: {
        schema: "evidence-applicability-frame/v2",
        requestedTargets: [{ stage: "activation_legality", operation: "activate" }],
        scenarioFacts: [{
          operation: "special_summon",
          dimension: "operand_availability",
          state: "absent",
          scope: "both_players",
        }],
      },
      evidenceApplicabilityFrame: {
        schema: "evidence-applicability-frame/v2",
        requestedTargets: [{ stage: "activation_legality", operation: "activate" }],
        scenarioFacts: [{
          operation: "special_summon",
          dimension: "actor_permission",
          state: "prohibited",
          scope: "both_players",
        }],
      },
      requestedTargetCoverage: { missingQueryTargets: [], extraEvidenceTargets: [], conflicts: [] },
      scenarioFactCoverage: {
        missingQueryFacts: [],
        extraEvidenceFacts: [],
        conflicts: [{ family: "scenario_fact", reason: "premise_not_equivalent" }],
      },
    }],
    faqRelated: [],
    cardTexts: [{
      id: "card-text-anonymous",
      type: "card_text",
      title: "场景魔法的卡片文本",
      text: "双方各自可以执行一项任意处理。",
    }],
    userProvidedCardTexts: [],
    rawRelatedEvidence: [],
    formalEngineProofs: [],
    retrievalWarnings: [],
  };
}

test("public prompt keeps source IDs and text but hides applicability classifications", () => {
  for (const maxPromptChars of ["60000", "8000"]) {
    const bundle = buildRagRulingPromptBundle({
      userQuery: "双方都没有合格候选时，能否发动场景魔法？",
      cardResolution: {
        resolvedCards: [{ id: "5300", name: "场景魔法", effectText: "双方各自可以执行一项任意处理。" }],
        unresolvedMentions: [],
        ambiguousMentions: [],
      },
      evidence: fixtureEvidence(),
      env: {
        RAG_MAX_PROMPT_CHARS: maxPromptChars,
        RAG_RECOVERY_PROMPT_CHARS: maxPromptChars,
      },
    });

    assert.equal(bundle.recoveryPrompt, "");
    assert.doesNotMatch(bundle.prompt, /scenarioPremiseCompatibility/u);
    assert.doesNotMatch(bundle.prompt, /playerRoleCompatibility/u);
    assert.doesNotMatch(bundle.prompt, /(?:query|evidence)ApplicabilityFrame/u);
    assert.doesNotMatch(bundle.prompt, /scenarioPremiseConflicts/u);
    assert.match(bundle.prompt, /来源题面中的玩家被禁止执行操作/u);
    assert.match(bundle.prompt, /qa-anonymous-applicability-contrast/u);
  }
});

test("real-size compact fallback keeps each source's ruling text without synthetic applicability output", () => {
  const repeated = "用于模拟真实证据体量的无关说明。".repeat(80);
  const evidence = fixtureEvidence();
  evidence.officialQaRelated = [
    {
      ...evidence.officialQaRelated[0],
      id: "qa-anonymous-boundary-a",
      title: "匿名来源 A",
      text: `A题面开头：玩家被禁止执行操作。${repeated}A结论末尾：只适用于操作禁止。`,
    },
    {
      ...evidence.officialQaRelated[0],
      id: "qa-anonymous-boundary-b",
      title: "匿名来源 B",
      text: `B题面开头：询问效果处理。${repeated}B结论末尾：不回答发动合法性。`,
      scenarioPremiseConflicts: [{
        family: "requested_target",
        reason: "target_not_covered",
        queryTargets: ["activation_legality:activate"],
        evidenceTargets: ["resolution_handling:resolve_effect"],
      }],
      evidenceApplicabilityFrame: {
        schema: "evidence-applicability-frame/v2",
        requestedTargets: [{ stage: "resolution_handling", operation: "resolve_effect" }],
        scenarioFacts: [],
      },
    },
  ];
  evidence.faqRelated = Array.from({ length: 5 }, (_unused, index) => ({
    id: `faq-anonymous-${index}`,
    type: "faq",
    title: `匿名 FAQ ${index}`,
    text: repeated,
    isDirect: false,
  }));
  evidence.rawRelatedEvidence = Array.from({ length: 4 }, (_unused, index) => ({
    id: `rule-anonymous-${index}`,
    type: "rulebook",
    title: `匿名规则 ${index}`,
    text: repeated,
    isDirect: false,
  }));

  const bundle = buildRagRulingPromptBundle({
    userQuery: "双方都没有合格候选时，能否发动匿名魔法？",
    cardResolution: {
      resolvedCards: [{
        id: "5300",
        name: "匿名魔法",
        effectText: "双方各自可以执行一项任意处理。".repeat(30),
      }],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    evidence,
    env: {
      RAG_MAX_PROMPT_CHARS: "8000",
      RAG_RECOVERY_PROMPT_CHARS: "8000",
    },
  });

  for (const prompt of [bundle.prompt]) {
    assert.ok(prompt.length <= 8000);
    assert.doesNotMatch(prompt, /officialEvidenceBoundaries/u);
    assert.match(prompt, /qa-anonymous-boundary-a/u);
    assert.match(prompt, /qa-anonymous-boundary-b/u);
    assert.doesNotMatch(prompt, /scenarioPremiseCompatibility/u);
    assert.doesNotMatch(prompt, /playerRoleCompatibility/u);
    assert.doesNotMatch(prompt, /(?:query|evidence)ApplicabilityFrame/u);
    assert.doesNotMatch(prompt, /scenarioPremiseConflicts/u);
    assert.match(prompt, /A题面开头/u);
    assert.match(prompt, /A结论末尾/u);
    assert.match(prompt, /B题面开头/u);
    assert.match(prompt, /B结论末尾/u);
    const contextStart = prompt.lastIndexOf('{"userQuery"');
    assert.ok(contextStart >= 0);
    const context = JSON.parse(prompt.slice(contextStart));
    assert.ok(context.allowedEvidenceIds.includes("qa-anonymous-boundary-a"));
    assert.ok(context.allowedEvidenceIds.includes("qa-anonymous-boundary-b"));
    const related = Array.isArray(context.evidence)
      ? context.evidence.filter((item) => item.bucket === "officialQaRelated")
      : context.evidence.officialQaRelated;
    assert.equal(related.length, 2);
    assert.equal(related[0].id, "qa-anonymous-boundary-a");
    assert.match(related[0].text, /A题面开头/u);
    assert.match(related[0].text, /A结论末尾/u);
    assert.equal(related[1].id, "qa-anonymous-boundary-b");
    assert.match(related[1].text, /B题面开头/u);
    assert.match(related[1].text, /B结论末尾/u);
  }
  assert.equal(bundle.recoveryPrompt, "");
});

test("the final direct selector accepts only a raw exact question, not structured-scene promotion", () => {
  const baseCandidate = {
    id: "qa-anonymous-direct-candidate",
    type: "official_qa",
    text: "匿名官方回答。",
    isDirect: true,
    matchLevel: "official_qa_exact",
    authoritativeSceneMatch: true,
    authoritativeSceneMatchReason: "unique_structured_scene",
    candidatePoolComplete: true,
    questionCardIdCoverage: 1,
    questionCardIdCount: 1,
    matchedQuestionCardIds: ["5400"],
  };
  const select = (candidate) => selectAuthoritativeOfficialDirectCandidate({
    candidates: [candidate],
    cardResolution: {
      resolvedCards: [{ id: "5400", name: "匿名场景卡" }],
      unresolvedMentions: [],
      ambiguousMentions: [],
      omittedResolvedCards: [],
    },
  });

  assert.equal(select({
    ...baseCandidate,
    scenarioPremiseCompatibility: "compatible",
  }), null);

  for (const compatibility of ["partial", "conditional", "mismatch"]) {
    assert.equal(select({
      ...baseCandidate,
      scenarioPremiseCompatibility: compatibility,
    }), null);
  }

  assert.equal(select({
    ...baseCandidate,
    scenarioPremiseCompatibility: "compatible",
    playerRoleCompatibility: "mismatch",
  }), null);

  assert.equal(select({
    ...baseCandidate,
    scenarioPremiseCompatibility: "unknown",
  }), null);

  assert.equal(select({
    ...baseCandidate,
    scenarioPremiseCompatibility: "unknown",
    authoritativeSceneMatchReason: "raw_or_normalized_query",
  })?.id, baseCandidate.id);

  assert.equal(select({
    ...baseCandidate,
    scenarioPremiseCompatibility: "compatible",
    playerRoleCompatibility: "mismatch",
    authoritativeSceneMatchReason: "raw_or_normalized_query",
  })?.id, baseCandidate.id);
});
