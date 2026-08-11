import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRagRulingPromptBundle,
  selectAuthoritativeOfficialDirectCandidate,
} from "../backend/ragRulingPrompt.mjs";

const userQuery = "对方分别用以上两只怪兽攻击我方里侧守备表示的怪兽，各自能否由战斗或怪兽效果破坏？";

const cardResolution = {
  resolvedCards: [
    { id: "100", name: "里侧目标", effectText: "此卡翻开后适用一个永续效果。" },
    { id: "200", name: "攻击者甲", effectText: "通常怪兽。" },
    { id: "300", name: "攻击者乙", effectText: "此卡可以在守备表示进行攻击。" },
  ],
  unresolvedMentions: [],
  ambiguousMentions: [],
};

const branchQa = {
  id: "qa-anonymous-battle-branch",
  type: "official_qa",
  title: "里侧守备目标被普通怪兽攻击时的处理",
  text: "伤害计算前将里侧守备目标翻开。攻击怪兽改变表示形式后，战斗结束且不进行伤害计算。",
  isDirect: false,
  matchLevel: "official_qa_near",
  matchedBy: ["question_type", "effect_phrase", "multi_branch_related_evidence"],
  cardIds: ["100"],
  matchedQuestionCardIds: ["100"],
  questionCardIdCoverage: 1 / 3,
  questionCardIdCount: 1,
  sourceUrl: "https://example.test/official-qa",
};

function evidence() {
  return {
    officialQaDirectCandidates: [],
    officialQaRelated: [branchQa],
    faqRelated: [],
    cardTexts: cardResolution.resolvedCards.map((card) => ({
      id: `card-text-${card.id}`,
      type: "card_text",
      title: `${card.name} 的卡片文本`,
      cardIds: [card.id],
      cards: [card.name],
      text: card.effectText,
    })),
    userProvidedCardTexts: [],
    rawRelatedEvidence: [],
    formalEngineProofs: [],
    retrievalWarnings: [],
  };
}

test("battle prompts retain the ordered checkpoints and branch-only evidence scope", () => {
  const bundle = buildRagRulingPromptBundle({
    userQuery,
    cardResolution,
    evidence: evidence(),
  });

  for (const prompt of [bundle.prompt, bundle.recoveryPrompt]) {
    assert.match(prompt, /伤害步骤开始时/u);
    assert.match(prompt, /里侧/u);
    assert.match(prompt, /(?:如适用|若战斗对象)/u);
    assert.match(prompt, /永续.*效果/u);
    assert.match(prompt, /(?:状态变化时重检攻击许可|按变化后的表示形式重新检查)/u);
    assert.match(prompt, /不能.*整道多分支问题.*official_confirmed/u);
    assert.match(prompt, /multi_branch_related_evidence/u);
    assert.match(prompt, /matchedQuestionCardIds/u);
  }
});

test("a size-limited battle prompt keeps the same non-authoritative checklist", () => {
  const bundle = buildRagRulingPromptBundle({
    userQuery,
    cardResolution,
    evidence: evidence(),
    env: {
      RAG_MAX_PROMPT_CHARS: "8000",
      RAG_RECOVERY_PROMPT_CHARS: "8000",
    },
  });

  assert.ok(bundle.warnings.includes("rag_prompt_compacted_to_max_chars"));
  for (const prompt of [bundle.prompt, bundle.recoveryPrompt]) {
    assert.match(prompt, /伤害步骤开始时/u);
    assert.match(prompt, /(?:如适用|若.*里侧守备)/u);
    assert.match(prompt, /multi_branch_related_evidence/u);
  }
});

test("a partial single-card QA cannot enter the focused direct route for a multi-branch question", () => {
  const candidate = {
    ...branchQa,
    isDirect: true,
    matchLevel: "official_qa_exact",
    authoritativeSceneMatch: true,
    authoritativeSceneMatchReason: "raw_or_normalized_query",
    questionCardIdCoverage: 1,
    fullText: branchQa.text,
  };

  const selected = selectAuthoritativeOfficialDirectCandidate({
    candidates: [candidate],
    cardResolution,
    decisionScope: {
      detected: true,
      multiBranch: true,
    },
  });

  assert.equal(selected, null);
});

test("unrelated non-battle prompts do not pay the battle-checklist token cost", () => {
  for (const query of [
    "这个效果能否在主要阶段发动？",
    "战斗阶段结束时可以发动这个效果吗？",
  ]) {
    const bundle = buildRagRulingPromptBundle({
      userQuery: query,
      cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
      evidence: evidence(),
    });
    assert.doesNotMatch(bundle.prompt, /战斗题只按实际适用的检查点|战斗处理题先识别题面实际涉及/u);
  }
});
