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

test("full and compact prompts preserve generic applicability dimensions and mismatch boundaries", () => {
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

    for (const prompt of [bundle.prompt, bundle.recoveryPrompt]) {
      assert.match(prompt, /scenarioPremiseCompatibility/u);
      assert.match(prompt, /actor_permission/u);
      assert.match(prompt, /operand_availability/u);
      assert.match(prompt, /zone_capacity/u);
      assert.match(prompt, /cost_payability/u);
      assert.match(prompt, /premise_not_equivalent/u);
      assert.match(prompt, /queryApplicabilityFrame/u);
      assert.match(prompt, /evidenceApplicabilityFrame/u);
    }
  }
});

test("real-size compact fallback keeps per-source applicability boundaries and ruling text", () => {
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

  for (const prompt of [bundle.prompt, bundle.recoveryPrompt]) {
    assert.ok(prompt.length <= 8000);
    assert.match(prompt, /officialEvidenceBoundaries/u);
    assert.match(prompt, /qa-anonymous-boundary-a/u);
    assert.match(prompt, /qa-anonymous-boundary-b/u);
    assert.match(prompt, /scenarioPremiseCompatibility/u);
    assert.match(prompt, /scenarioPremiseConflicts/u);
    assert.match(prompt, /queryApplicabilityFrame/u);
    assert.match(prompt, /evidenceApplicabilityFrame/u);
    assert.match(prompt, /actor_permission/u);
    assert.match(prompt, /operand_availability/u);
    assert.match(prompt, /target_not_covered/u);
    assert.match(prompt, /A题面开头/u);
    assert.match(prompt, /A结论末尾/u);
    assert.match(prompt, /B题面开头/u);
    assert.match(prompt, /B结论末尾/u);
    const contextStart = prompt.lastIndexOf('{"userQuery"');
    assert.ok(contextStart >= 0);
    const context = JSON.parse(prompt.slice(contextStart));
    assert.ok(context.allowedEvidenceIds.includes("qa-anonymous-boundary-a"));
    assert.ok(context.allowedEvidenceIds.includes("qa-anonymous-boundary-b"));
    assert.equal(context.officialEvidenceBoundaries.length, 2);
  }
});

test("the final direct selector independently enforces applicability compatibility", () => {
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
  })?.id, baseCandidate.id);

  for (const compatibility of ["partial", "conditional", "mismatch"]) {
    assert.equal(select({
      ...baseCandidate,
      scenarioPremiseCompatibility: compatibility,
    }), null);
  }

  assert.equal(select({
    ...baseCandidate,
    scenarioPremiseCompatibility: "unknown",
  }), null);

  assert.equal(select({
    ...baseCandidate,
    scenarioPremiseCompatibility: "unknown",
    authoritativeSceneMatchReason: "raw_or_normalized_query",
  })?.id, baseCandidate.id);
});
