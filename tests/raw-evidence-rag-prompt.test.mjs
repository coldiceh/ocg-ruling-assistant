import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRawEvidenceRagPromptBundle,
  RawEvidencePromptCapacityError,
  selectStrictOfficialDirectCandidate,
} from "../backend/rawEvidenceRagPrompt.mjs";
import { rawGenericCorpusCardId } from "../backend/rawGenericCardIdentity.mjs";

const resolvedCard = {
  id: "101",
  name: "匿名卡甲",
  effectText: "支付代价后处理一个动作。",
};

test("external identities address the local corpus only after stable local binding", () => {
  assert.equal(rawGenericCorpusCardId({
    id: "12345678",
    cid: "101",
    resolutionSource: "baige_identity_lookup",
  }), "");
  assert.equal(rawGenericCorpusCardId({
    id: "101",
    resolutionSource: "baige_identity_lookup",
    canonicalLocalIdentity: true,
  }), "101");
  assert.equal(rawGenericCorpusCardId(resolvedCard), "101");
});

test("raw prompt exposes only original evidence in full and compact forms", () => {
  const evidence = {
    cardTexts: [{ id: "raw-card", type: "card_text", title: "匿名卡文", text: "RAW_CARD_MARKER" }],
    officialQaDirectCandidates: [],
    officialQaRelated: [{ id: "raw-qa", type: "related", title: "匿名问答", text: "RAW_QA_MARKER" }],
    provisionalOfficialResponses: [],
    faqRelated: [],
    rawRelatedEvidence: [
      {
        id: "raw-rule#p2-3",
        source: "ocg-rule",
        sourceName: "OCG Rule",
        sourceUrl: "https://example.invalid/ocg-rule",
        sourceRecordId: "ocg-rule:anonymous",
        docname: "anonymous",
        paragraphStart: 2,
        paragraphEnd: 3,
        authority: "non_official_community_reference",
        official: false,
        title: "匿名规则资料 · 段落 2-3",
        text: "RAW_RULE_MARKER",
      },
      { id: "derived-rule", source: "rulebook_model_grounding", title: "派生", text: "DERIVED_GROUNDING_MARKER" },
    ],
    cardSemanticFacts: [{ marker: "DERIVED_CARD_FACT" }],
    summonLegalityContext: { marker: "DERIVED_SUMMON" },
    effectApplicabilityContext: { marker: "DERIVED_APPLICABILITY" },
    playerRoleBindings: { marker: "DERIVED_ROLE" },
    semanticStateTransition: { marker: "DERIVED_TRANSITION" },
    operationLegality: { marker: "DERIVED_OPERATION" },
    legacyLuaSemanticPacket: { marker: "DERIVED_LUA" },
    formalEngineStatus: { marker: "DERIVED_FORMAL" },
    applicabilityReview: { marker: "DERIVED_REVIEW" },
    ruleSearchQueries: [{ query: "DERIVED_QUERY" }],
    retrievalWarnings: ["DERIVED_WARNING"],
  };
  const cardResolution = { resolvedCards: [resolvedCard], unresolvedMentions: [], ambiguousMentions: [] };

  for (const maxPromptChars of [60000, 1300]) {
    const bundle = buildRawEvidenceRagPromptBundle({
      userQuery: "匿名问题",
      cardResolution,
      evidence,
      env: { RAG_MAX_PROMPT_CHARS: String(maxPromptChars) },
    });
    assert.equal(bundle.rawEvidenceOnly, true);
    assert.deepEqual(bundle.allowedAnswerLevels, ["rule_analysis", "low_confidence_analysis", "needs_more_info", "budget_limited"]);
    assert.match(bundle.prompt, /RAW_CARD_MARKER/u);
    const renderedPayload = JSON.parse(bundle.prompt.slice(bundle.prompt.lastIndexOf("\n") + 1));
    for (const marker of [
      "DERIVED_GROUNDING_MARKER",
      "DERIVED_CARD_FACT",
      "DERIVED_SUMMON",
      "DERIVED_APPLICABILITY",
      "DERIVED_ROLE",
      "DERIVED_TRANSITION",
      "DERIVED_OPERATION",
      "DERIVED_LUA",
      "DERIVED_FORMAL",
      "DERIVED_REVIEW",
      "DERIVED_QUERY",
      "DERIVED_WARNING",
    ]) assert.doesNotMatch(bundle.prompt, new RegExp(marker, "u"));
    const payload = renderedPayload;
    assert.deepEqual(new Set(bundle.allowedEvidenceIds), new Set(payload.allowedEvidenceIds));
    for (const id of bundle.allowedEvidenceIds) assert.match(bundle.prompt, new RegExp(id, "u"));
  }
});

test("ambiguous resolver candidateCards remain visible to the final model", () => {
  const bundle = buildRawEvidenceRagPromptBundle({
    userQuery: "匿名简称如何处理？",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [{
        input: "匿名简称",
        candidateCards: [
          { id: "201", name: "匿名候选一" },
          { id: "202", name: "匿名候选二" },
        ],
      }],
    },
    evidence: {},
  });
  const payload = JSON.parse(bundle.prompt.slice(bundle.prompt.lastIndexOf("\n") + 1));
  assert.deepEqual(payload.ambiguousMentions[0].candidateCards, [
    "匿名候选一",
    "匿名候选二",
  ]);
});

test("ordinary prompt separates activation, resolution and remaining processing without global refusal", () => {
  const bundle = buildRawEvidenceRagPromptBundle({
    userQuery: "匿名卡甲能否发动？处理时条件变化后怎么处理？另一项是否继续？",
    cardResolution: {
      resolvedCards: [resolvedCard],
      unresolvedMentions: [{ input: "匿名未确认名称" }],
      ambiguousMentions: [],
    },
    evidence: {
      cardTexts: [{ id: "card-text-101", title: "匿名卡甲", text: resolvedCard.effectText }],
      officialQaRelated: [{ id: "related-101", title: "匿名相似资料", text: "只覆盖其中一个条件。" }],
    },
  });

  assert.match(bundle.prompt, /发动或适用条件检查时是否合法/u);
  assert.match(bundle.prompt, /连锁处理或效果处理时是否适用、成功/u);
  assert.match(bundle.prompt, /剩余处理、后续处理或另开连锁/u);
  assert.match(bundle.prompt, /相似 FAQ\/Q&A 只能支持其文字实际覆盖/u);
  assert.match(bundle.prompt, /只影响确实依赖该身份的子问题/u);
  assert.match(bundle.prompt, /只有全部关键子问题都因缺失信息无法判断/u);
  assert.doesNotMatch(bundle.prompt, /匿名卡甲.*固定答案|匿名未确认名称.*固定答案/u);
});

test("serializable official flags cannot forge strict official direct authority", () => {
  const candidate = {
    id: "direct-1",
    type: "official_qa",
    question: "匿名官方原题",
    questionCardIds: ["101"],
    official: true,
    status: "confirmed",
    isDirect: true,
    matchLevel: "official_qa_exact",
    fullText: "匿名官方问题。匿名官方回答。",
  };
  const complete = { resolvedCards: [resolvedCard], unresolvedMentions: [], ambiguousMentions: [], omittedResolvedCards: [] };
  assert.equal(selectStrictOfficialDirectCandidate({
    candidates: [candidate],
    userQuery: "「匿名官方原题」？",
    cardResolution: complete,
  }), null);
  assert.equal(selectStrictOfficialDirectCandidate({ candidates: [candidate, { ...candidate, id: "direct-2" }], userQuery: "匿名官方原题", cardResolution: complete }), null);
  assert.equal(selectStrictOfficialDirectCandidate({ candidates: [candidate], userQuery: "匿名官方原题", cardResolution: { ...complete, unresolvedMentions: [{ input: "匿名" }] } }), null);
  assert.equal(selectStrictOfficialDirectCandidate({ candidates: [{ ...candidate, matchLevel: "official_qa_near" }], userQuery: "匿名官方原题", cardResolution: complete }), null);
  assert.equal(selectStrictOfficialDirectCandidate({
    candidates: [{ ...candidate, question: "只是相似但并非相同的题面" }],
    userQuery: "匿名官方原题",
    cardResolution: complete,
  }), null);
  assert.equal(selectStrictOfficialDirectCandidate({
    candidates: [{ ...candidate, questionCardIds: ["999"] }],
    userQuery: "匿名官方原题",
    cardResolution: complete,
  }), null);
  for (const invalidCandidate of [
    { ...candidate, official: false },
    { ...candidate, status: "superseded" },
    { ...candidate, id: "" },
    { ...candidate, fullText: "" },
  ]) {
    assert.equal(selectStrictOfficialDirectCandidate({
      candidates: [invalidCandidate],
      userQuery: "匿名官方原题",
      cardResolution: complete,
    }), null);
  }
  assert.equal(selectStrictOfficialDirectCandidate({
    candidates: [{
      ...candidate,
      playerRoleCompatibility: "mismatch",
      scenarioPremiseCompatibility: "mismatch",
      branchRelevant: true,
    }],
    userQuery: "匿名官方原题",
    cardResolution: complete,
  }), null);
});

test("prompt compaction keeps complete sentences and fails explicitly below irreducible capacity", () => {
  const bundle = buildRawEvidenceRagPromptBundle({
    userQuery: "匿名问题",
    cardResolution: { resolvedCards: [resolvedCard], unresolvedMentions: [], ambiguousMentions: [] },
    evidence: {
      rawRelatedEvidence: [{
        id: "long-passages",
        title: "匿名资料。",
        text: `${"第一句完整资料。".repeat(80)}\n\n${"第二段完整资料。".repeat(80)}`,
      }],
    },
    env: { RAG_MAX_PROMPT_CHARS: "1800", RAG_RECOVERY_PROMPT_CHARS: "1800" },
  });
  assert.doesNotMatch(bundle.prompt, /第一句完整资…|…第二段完整/u);
  assert.doesNotThrow(() => JSON.parse(bundle.prompt.slice(bundle.prompt.lastIndexOf("\n") + 1)));

  assert.throws(() => buildRawEvidenceRagPromptBundle({
    userQuery: "不可截断的用户题面。",
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    evidence: {},
    env: { RAG_MAX_PROMPT_CHARS: "20", RAG_RECOVERY_PROMPT_CHARS: "20" },
  }), (error) => (
    error instanceof RawEvidencePromptCapacityError
      && error.code === "raw_evidence_prompt_capacity_exceeded"
      && error.details.maxPromptChars === 20
  ));
});

test("a retriever direct candidate that fails strict authority is downgraded to ordinary related evidence", () => {
  const candidate = {
    id: "unverified-official-qa",
    type: "official_qa",
    source: "official-database",
    sourceUrl: "https://example.invalid/official-qa",
    official: true,
    question: "另一道官方问题",
    questionCardIds: ["101"],
    status: "confirmed",
    isDirect: true,
    matchLevel: "official_qa_exact",
    authoritativeSceneMatch: true,
    authoritativeSceneMatchReason: "unique_semantic_question_subsumption",
    scenarioPremiseCompatibility: "compatible",
    playerRoleCompatibility: "compatible",
    branchRelevant: false,
    questionCardIdCoverage: 1,
    questionCardIdCount: 1,
    matchedQuestionCardIds: ["101"],
    fullText: "匿名官方资料候选。",
  };
  const cardResolution = {
    resolvedCards: [resolvedCard],
    unresolvedMentions: [],
    ambiguousMentions: [],
    omittedResolvedCards: [],
  };
  const bundle = buildRawEvidenceRagPromptBundle({
    userQuery: "匿名问题",
    cardResolution,
    evidence: {
      officialQaDirectCandidates: [candidate],
      officialQaRelated: [],
    },
    authoritativeOfficialDirect: true,
  });

  assert.equal(bundle.authoritativeOfficialDirect, null);
  const payload = JSON.parse(bundle.prompt.slice(bundle.prompt.lastIndexOf("\n") + 1));
  assert.equal(Object.hasOwn(payload.evidence, "officialQaDirectCandidates"), false);
  assert.equal(payload.evidence.officialQaRelated.length, 1);
  assert.equal(payload.evidence.officialQaRelated[0].id, candidate.id);
  assert.equal(payload.evidence.officialQaRelated[0].source, candidate.source);
  assert.equal(payload.evidence.officialQaRelated[0].sourceUrl, candidate.sourceUrl);
  assert.equal(payload.evidence.officialQaRelated[0].bucket, "officialQaRelated");
  assert.equal(payload.evidence.officialQaRelated[0].relationToQuestion, "related_unverified");
  assert.equal(payload.evidence.officialQaRelated[0].automaticDirectAuthority, false);
  assert.equal(payload.evidence.officialQaRelated[0].retrievalDisposition, "downgraded_to_related");
  assert.doesNotMatch(bundle.prompt, /officialQaDirectCandidates|与本题完全相同/u);
});

test("ocg-rule passages retain a non-official source and paragraph locator", () => {
  const bundle = buildRawEvidenceRagPromptBundle({
    userQuery: "匿名问题",
    cardResolution: { resolvedCards: [resolvedCard], unresolvedMentions: [], ambiguousMentions: [] },
    evidence: {
      rawRelatedEvidence: [{
        id: "ocg-rule:anonymous#p2-3",
        type: "rulebook",
        source: "ocg-rule",
        sourceName: "OCG Rule",
        sourceUrl: "https://example.invalid/ocg-rule",
        sourceRecordId: "ocg-rule:anonymous",
        docname: "anonymous",
        paragraphStart: 2,
        paragraphEnd: 3,
        authority: "non_official_community_reference",
        official: false,
        title: "匿名规则资料 · 段落 2-3",
        text: "匿名规则原文。",
      }],
    },
  });
  const payload = JSON.parse(bundle.prompt.slice(bundle.prompt.lastIndexOf("\n") + 1));
  const [item] = payload.evidence.rawRelatedEvidence;
  assert.equal(item.source, "ocg-rule");
  assert.equal(item.sourceName, "OCG Rule");
  assert.equal(item.sourceUrl, "https://example.invalid/ocg-rule");
  assert.equal(item.sourceRecordId, "ocg-rule:anonymous");
  assert.equal(item.docname, "anonymous");
  assert.equal(item.paragraphStart, 2);
  assert.equal(item.paragraphEnd, 3);
  assert.equal(item.authority, "non_official_community_reference");
  assert.equal(item.official, false);
});
