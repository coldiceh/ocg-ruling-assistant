import assert from "node:assert/strict";
import test from "node:test";

import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";
import {
  assessSemanticTransitionAuthority,
  attachSemanticTransitionContract,
  SEMANTIC_TRANSITION_SCHEMA,
  SEMANTIC_TRANSITION_VERSION,
} from "../backend/semanticAuthorityGate.mjs";

function resolvedCard(overrides = {}) {
  return {
    id: "alpha-100",
    cardId: "alpha-100",
    input: "测试发动体",
    name: "测试发动体",
    aliases: ["测试发动体"],
    confidence: 0.98,
    resolutionSource: "query",
    ...overrides,
  };
}

function authoritativeTransition(overrides = {}) {
  return attachSemanticTransitionContract({
    status: "resolved",
    complete: true,
    authoritative: true,
    authorityReasons: [],
    activation: "legal",
    resolution: "performed",
    shortAnswer: "可以发动「测试发动体」的①效果，效果处理正常进行。",
    reasoning: ["已经逐项检查发动条件与效果处理。"],
    evidenceIds: ["card-text-alpha-100"],
    ...overrides,
  }, {
    userQuery: "可以发动「测试发动体」的①效果吗？",
  });
}

function publicFinalPayload(shortAnswer, usedCards = []) {
  return JSON.stringify({
    answerLevel: "rule_analysis",
    shortAnswer,
    reasoning: ["最终模型根据冻结的题面、卡文和检索资料独立签发结论。"],
    usedCards,
    usedEvidence: [],
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "high",
  });
}

test("only an explicitly authoritative versioned transition can cross the trust boundary", () => {
  const cardResolution = { resolvedCards: [resolvedCard()] };
  const valid = assessSemanticTransitionAuthority({
    semanticStateTransition: authoritativeTransition(),
    cardResolution,
  });
  assert.equal(valid.trusted, true, JSON.stringify(valid));
  assert.equal(valid.queryCoverage.complete, true);
  assert.equal(valid.identityBinding.complete, true);

  const missingFlag = authoritativeTransition();
  delete missingFlag.authoritative;
  const rejectedFlag = assessSemanticTransitionAuthority({ semanticStateTransition: missingFlag, cardResolution });
  assert.equal(rejectedFlag.trusted, false);
  assert.ok(rejectedFlag.reasons.includes("semantic_transition_not_explicitly_authoritative"));

  const missingContract = { ...authoritativeTransition() };
  delete missingContract.schema;
  delete missingContract.version;
  const rejectedContract = assessSemanticTransitionAuthority({ semanticStateTransition: missingContract, cardResolution });
  assert.equal(rejectedContract.trusted, false);
  assert.ok(rejectedContract.reasons.includes("semantic_transition_schema_missing_or_unsupported"));
  assert.ok(rejectedContract.reasons.includes("semantic_transition_version_missing_or_unsupported"));

  const unresolvedConcern = authoritativeTransition({ authorityReasons: ["unverified_branch"] });
  const rejectedConcern = assessSemanticTransitionAuthority({ semanticStateTransition: unresolvedConcern, cardResolution });
  assert.equal(rejectedConcern.trusted, false);
  assert.ok(rejectedConcern.reasons.includes("semantic_transition_has_authority_reasons"));
});

test("the shared envelope gives every analyzer result explicit schema, version, and authority reasons", () => {
  const transition = attachSemanticTransitionContract({
    status: "resolved",
    complete: true,
    authoritative: true,
    shortAnswer: "可以发动「测试发动体」的①效果。",
  }, { userQuery: "可以发动「测试发动体」的①效果吗？" });
  assert.equal(transition.schema, SEMANTIC_TRANSITION_SCHEMA);
  assert.equal(transition.version, SEMANTIC_TRANSITION_VERSION);
  assert.deepEqual(transition.authorityReasons, []);
  assert.equal(transition.queryCoverage.query, "可以发动「测试发动体」的①效果吗？");
});

test("an appended independent question is uncovered and prevents a partial executor from being trusted", () => {
  const transition = attachSemanticTransitionContract({
    status: "resolved",
    complete: true,
    authoritative: true,
    authorityReasons: [],
    activation: "legal",
    shortAnswer: "可以发动「测试发动体」的①效果。",
    reasoning: ["发动条件已经确认。"],
    evidenceIds: ["card-text-alpha-100"],
  }, {
    userQuery: "可以发动「测试发动体」的①效果吗？另外，本回合还可以通常召唤吗？",
  });
  const assessment = assessSemanticTransitionAuthority({
    semanticStateTransition: transition,
    cardResolution: { resolvedCards: [resolvedCard()] },
  });
  assert.equal(assessment.trusted, false);
  assert.ok(assessment.reasons.includes("query_claims_not_fully_covered"));
  assert.equal(assessment.queryCoverage.claims.length, 2);
  assert.deepEqual(assessment.queryCoverage.uncoveredClaimIds, ["query-claim-2"]);
  assert.ok(assessment.queryCoverage.claims[1].uncoveredIntents.includes("normal_summon"));
});

test("evidence and global keywords cannot make an unanswered card claim look covered", () => {
  const cardA = resolvedCard({
    id: "alpha-100",
    cardId: "alpha-100",
    input: "测试卡A",
    name: "测试卡A",
    aliases: ["测试卡A"],
  });
  const cardB = resolvedCard({
    id: "beta-200",
    cardId: "beta-200",
    input: "测试卡B",
    name: "测试卡B",
    aliases: ["测试卡B"],
  });
  const transition = attachSemanticTransitionContract({
    status: "resolved",
    complete: true,
    authoritative: true,
    authorityReasons: [],
    activation: "illegal",
    resolution: "response_condition_not_met",
    shortAnswer: "「测试卡B」不能连锁发动①效果。",
    reasoning: ["「测试卡A」是连锁中被响应的卡，但本执行器没有裁定它能否从手牌发动。"],
    evidenceIds: ["card-text-alpha-100", "card-text-beta-200"],
    program: {
      type: "compiled_activation_event_response",
      responseEffect: { id: "beta-200:effect-1", effectNumber: "1" },
      responseDecision: { status: "DECIDED", matches: false },
    },
  }, {
    userQuery: "我能否从手牌发动「测试卡A」？「测试卡B」能否连锁①？",
  });
  const assessment = assessSemanticTransitionAuthority({
    semanticStateTransition: transition,
    cardResolution: { resolvedCards: [cardA, cardB] },
  });
  assert.equal(assessment.trusted, false, JSON.stringify(assessment));
  assert.ok(assessment.reasons.includes("query_claims_not_fully_covered"));
  assert.deepEqual(assessment.queryCoverage.uncoveredClaimIds, ["query-claim-1"]);
  assert.deepEqual(assessment.queryCoverage.claims[0].decisionBinding.focalDefinitionIds, ["alpha-100"]);
  assert.deepEqual(assessment.queryCoverage.claims[0].decisionBinding.matchedScopeIds, []);
  assert.deepEqual(assessment.queryCoverage.claims[1].decisionBinding.focalDefinitionIds, ["beta-200"]);
  assert.equal(assessment.queryCoverage.claims[1].decisionBinding.complete, true);
});

test("a quantified multi-card claim requires a decisive scope for every named entity", () => {
  const cardA = resolvedCard({
    id: "quantified-alpha",
    cardId: "quantified-alpha",
    input: "并列裁定卡A",
    name: "并列裁定卡A",
    aliases: ["并列裁定卡A"],
  });
  const cardB = resolvedCard({
    id: "quantified-beta",
    cardId: "quantified-beta",
    input: "并列裁定卡B",
    name: "并列裁定卡B",
    aliases: ["并列裁定卡B"],
  });
  const cardResolution = { resolvedCards: [cardA, cardB] };
  const transition = attachSemanticTransitionContract({
    status: "resolved",
    complete: true,
    authoritative: true,
    authorityReasons: [],
    activation: { legal: true },
    shortAnswer: "「并列裁定卡B」可以发动。",
    reasoning: ["「并列裁定卡A」已检索到卡文，但没有对其发动合法性作出裁决。"],
    evidenceIds: ["card-text-quantified-alpha", "card-text-quantified-beta"],
    program: {
      sourceDefinitionId: "quantified-beta",
      sourceEffect: { id: "quantified-beta:effect-1", effectNumber: "1" },
      sourceDecision: { legal: true },
    },
  }, {
    userQuery: "「并列裁定卡A」和「并列裁定卡B」是否都可以发动？",
    cardResolution,
  });
  const assessment = assessSemanticTransitionAuthority({
    semanticStateTransition: transition,
    cardResolution,
  });

  assert.equal(assessment.trusted, false, JSON.stringify(assessment));
  assert.deepEqual(assessment.queryCoverage.uncoveredClaimIds, ["query-claim-1"]);
  assert.equal(assessment.queryCoverage.claims[0].decisionBinding.requireEveryFocalEntity, true);
  assert.deepEqual(
    assessment.queryCoverage.claims[0].decisionBinding.perEntityScopeIds["quantified-alpha"],
    [],
  );
  assert.ok(assessment.queryCoverage.claims[0].uncoveredIntents.includes("activation"));
});

test("a quantified multi-card claim is trusted when every entity has its own verdict", () => {
  const cardA = resolvedCard({
    id: "quantified-positive-alpha",
    cardId: "quantified-positive-alpha",
    input: "逐项裁定卡A",
    name: "逐项裁定卡A",
    aliases: ["逐项裁定卡A"],
  });
  const cardB = resolvedCard({
    id: "quantified-positive-beta",
    cardId: "quantified-positive-beta",
    input: "逐项裁定卡B",
    name: "逐项裁定卡B",
    aliases: ["逐项裁定卡B"],
  });
  const cardResolution = { resolvedCards: [cardA, cardB] };
  const transition = attachSemanticTransitionContract({
    status: "resolved",
    complete: true,
    authoritative: true,
    authorityReasons: [],
    activation: { legal: true },
    shortAnswer: "「逐项裁定卡A」可以发动；「逐项裁定卡B」也可以发动。",
    reasoning: ["两个发动条件已经分别执行。"],
    evidenceIds: ["card-text-quantified-positive-alpha", "card-text-quantified-positive-beta"],
  }, {
    userQuery: "「逐项裁定卡A」和「逐项裁定卡B」是否都可以发动？",
    cardResolution,
  });
  const assessment = assessSemanticTransitionAuthority({
    semanticStateTransition: transition,
    cardResolution,
  });

  assert.equal(assessment.trusted, true, JSON.stringify(assessment));
  assert.equal(assessment.queryCoverage.claims[0].decisionBinding.requireEveryFocalEntity, true);
  assert.ok(assessment.queryCoverage.claims[0].decisionBinding.perEntityScopeIds["quantified-positive-alpha"].length > 0);
  assert.ok(assessment.queryCoverage.claims[0].decisionBinding.perEntityScopeIds["quantified-positive-beta"].length > 0);
});

test("a structured program participant is not mistaken for an adjudicated source claim", () => {
  const cardA = resolvedCard({
    id: "alpha-structured",
    cardId: "alpha-structured",
    input: "结构测试卡A",
    name: "结构测试卡A",
    aliases: ["结构测试卡A"],
  });
  const cardB = resolvedCard({
    id: "beta-structured",
    cardId: "beta-structured",
    input: "结构测试卡B",
    name: "结构测试卡B",
    aliases: ["结构测试卡B"],
  });
  const transition = attachSemanticTransitionContract({
    status: "resolved",
    complete: true,
    authoritative: true,
    authorityReasons: [],
    activation: "illegal",
    resolution: "response_condition_not_met",
    shortAnswer: "「结构测试卡B」不能连锁发动①效果。",
    evidenceIds: ["card-text-alpha-structured", "card-text-beta-structured"],
    program: {
      type: "compiled_activation_event_response",
      sourceDefinitionId: "alpha-structured",
      sourceEffect: { id: "alpha-structured:effect-1", effectNumber: "1" },
      responseDefinitionId: "beta-structured",
      responseEffect: { id: "beta-structured:effect-1", effectNumber: "1" },
      responseDecision: { status: "DECIDED", matches: false },
    },
  }, {
    userQuery: "可以发动「结构测试卡A」的①效果吗？「结构测试卡B」能否连锁发动①效果？",
    cardResolution: { resolvedCards: [cardA, cardB] },
  });
  const assessment = assessSemanticTransitionAuthority({
    semanticStateTransition: transition,
    cardResolution: { resolvedCards: [cardA, cardB] },
  });

  assert.equal(assessment.trusted, false, JSON.stringify(assessment));
  assert.deepEqual(assessment.queryCoverage.uncoveredClaimIds, ["query-claim-1"]);
  assert.deepEqual(assessment.queryCoverage.claims[0].decisionBinding.matchedScopeIds, []);
  assert.deepEqual(assessment.queryCoverage.claims[1].decisionBinding.matchedScopeIds, [
    "short_answer:1",
    "program:response",
  ]);
  assert.equal(assessment.queryCoverage.claims[1].decisionBinding.complete, true);
});

test("an implicit primary program subject cannot borrow a verdict naming only another entity", () => {
  const cardA = resolvedCard({
    id: "alpha-primary",
    cardId: "alpha-primary",
    input: "主程序卡A",
    name: "主程序卡A",
    aliases: ["主程序卡A"],
  });
  const cardB = resolvedCard({
    id: "beta-primary",
    cardId: "beta-primary",
    input: "另一个裁定卡B",
    name: "另一个裁定卡B",
    aliases: ["另一个裁定卡B"],
  });
  const transition = attachSemanticTransitionContract({
    status: "resolved",
    complete: true,
    authoritative: true,
    authorityReasons: [],
    activation: "legal",
    shortAnswer: "可以发动「另一个裁定卡B」的①效果。",
    evidenceIds: ["card-text-alpha-primary", "card-text-beta-primary"],
    program: {
      type: "compiled_generic_program",
      sourceDefinitionId: "alpha-primary",
      sourceEffect: { id: "alpha-primary:effect-1", effectNumber: "1" },
    },
  }, {
    userQuery: "可以发动「主程序卡A」的①效果吗？可以发动「另一个裁定卡B」的①效果吗？",
    cardResolution: { resolvedCards: [cardA, cardB] },
  });
  const assessment = assessSemanticTransitionAuthority({
    semanticStateTransition: transition,
    cardResolution: { resolvedCards: [cardA, cardB] },
  });

  assert.equal(assessment.trusted, false, JSON.stringify(assessment));
  assert.deepEqual(assessment.queryCoverage.uncoveredClaimIds, ["query-claim-1"]);
  assert.deepEqual(assessment.queryCoverage.claims[0].decisionBinding.matchedScopeIds, []);
  assert.equal(assessment.queryCoverage.claims[1].decisionBinding.complete, true);
});

test("scenario chain activations and attack position do not become separate adjudication claims", () => {
  const suppressor = resolvedCard({
    id: "field-suppressor",
    cardId: "field-suppressor",
    input: "场上压制卡",
    name: "场上压制卡",
    aliases: ["场上压制卡"],
  });
  const source = resolvedCard({
    id: "chain-source",
    cardId: "chain-source",
    input: "连锁源卡A",
    name: "连锁源卡A",
    aliases: ["连锁源卡A"],
  });
  const responder = resolvedCard({
    id: "chain-response",
    cardId: "chain-response",
    input: "替换响应卡B",
    name: "替换响应卡B",
    aliases: ["替换响应卡B"],
  });
  const cardResolution = { resolvedCards: [suppressor, source, responder] };
  const query = "对方场上的「场上压制卡」以守备表示存在。我方C1发动场上攻击表示的「连锁源卡A」效果，C2从手牌发动「替换响应卡B」效果，连锁逆算处理时，C1的效果还会生效吗？";
  const transition = attachSemanticTransitionContract({
    status: "resolved",
    complete: true,
    authoritative: true,
    authorityReasons: [],
    activation: "assumed_legal",
    resolution: "negated",
    shortAnswer: "C2处理后，C1的「连锁源卡A」效果被无效，不进行这个连锁项的效果处理。",
    evidenceIds: ["card-text-field-suppressor", "card-text-chain-source", "card-text-chain-response"],
    program: {
      type: "compiled_duel_state_simulation",
      preparedChainLinks: [
        { id: "C1", sourceDefinitionId: "chain-source", effectNumber: "1" },
        { id: "C2", sourceDefinitionId: "chain-response", effectNumber: "1" },
      ],
    },
  }, { userQuery: query, cardResolution });
  const assessment = assessSemanticTransitionAuthority({
    semanticStateTransition: transition,
    cardResolution,
  });

  assert.equal(assessment.trusted, true, JSON.stringify(assessment));
  assert.deepEqual(assessment.queryCoverage.claims[0].intents, ["effect_resolution"]);
  assert.equal(assessment.queryCoverage.claims[0].decisionPredicate, "C1的效果还会生效吗");
  assert.deepEqual(
    assessment.queryCoverage.claims[0].decisionBinding.focalDefinitionIds,
    ["chain-source"],
  );
});

test("a verdict for one numbered effect cannot cover another effect of the same card", () => {
  const card = resolvedCard({
    id: "beta-200",
    cardId: "beta-200",
    input: "测试卡B",
    name: "测试卡B",
    aliases: ["测试卡B"],
    effectText: "①：可以发动。②：可以发动。",
  });
  const transition = attachSemanticTransitionContract({
    status: "resolved",
    complete: true,
    authoritative: true,
    authorityReasons: [],
    activation: "legal",
    shortAnswer: "可以发动「测试卡B」的①效果。",
    evidenceIds: ["card-text-beta-200"],
    program: {
      type: "compiled_activation_event_response",
      responseEffect: { id: "beta-200:effect-1", effectNumber: "1" },
      responseDecision: { status: "DECIDED", matches: true },
    },
  }, {
    userQuery: "可以发动「测试卡B」的①效果吗？可以发动「测试卡B」的②效果吗？",
  });
  const assessment = assessSemanticTransitionAuthority({
    semanticStateTransition: transition,
    cardResolution: { resolvedCards: [card] },
  });
  assert.equal(assessment.trusted, false, JSON.stringify(assessment));
  assert.deepEqual(assessment.queryCoverage.uncoveredClaimIds, ["query-claim-2"]);
  assert.deepEqual(assessment.queryCoverage.claims[0].decisionBinding.uncoveredEffectMarkers, []);
  assert.deepEqual(assessment.queryCoverage.claims[1].decisionBinding.uncoveredEffectMarkers, ["②"]);
});

test("ambiguous and low-confidence card identities cannot authorize a semantic verdict", () => {
  const transition = authoritativeTransition();
  const ambiguous = assessSemanticTransitionAuthority({
    semanticStateTransition: transition,
    cardResolution: {
      resolvedCards: [resolvedCard()],
      ambiguousMentions: [{ input: "测试发动体", candidateCards: [{ id: "a" }, { id: "b" }] }],
    },
  });
  assert.equal(ambiguous.trusted, false);
  assert.ok(ambiguous.reasons.includes("card_mentions_ambiguous"));

  const lowConfidence = assessSemanticTransitionAuthority({
    semanticStateTransition: transition,
    cardResolution: { resolvedCards: [resolvedCard({ confidence: 0.68 })] },
  });
  assert.equal(lowConfidence.trusted, false);
  assert.ok(lowConfidence.reasons.includes("semantic_participating_card_provenance_untrusted"));
  assert.equal(lowConfidence.identityBinding.bindings[0].proofKind, "untrusted");
});

test("the public pipeline calls the final model when a semantic executor covered only the first question", async () => {
  const cards = [{
    id: "trap-1",
    name: "测试均衡陷阱",
    aliases: ["测试均衡陷阱"],
    cardType: "trap",
    effectText: "自己场上不存在卡的情况下，此卡也可从手牌发动。①：战斗阶段结束时可以发动。进行某个处理。",
  }, {
    id: "responder-1",
    name: "测试区域监察者",
    aliases: ["测试区域监察者"],
    cardType: "monster",
    effectText: "①：此卡通常召唤的情况下，对方发动手牌・墓地・除外状态的卡的效果时可以发动。那个效果无效并破坏。",
  }];
  let finalModelCalls = 0;
  const answer = await answerRagRulingQuestion({
    question: "对方场上存在通常召唤的「测试区域监察者」。自己场上没有卡，自己在战斗阶段结束时从手牌发动「测试均衡陷阱」。对方可以直接连锁发动「测试区域监察者」的①效果吗？另外，本回合还可以通常召唤吗？",
    cards,
    records: [],
    qaRecords: [],
    cardModelInvoker: async () => JSON.stringify({ cardNames: [] }),
    ruleModelInvoker: async () => JSON.stringify({ ruleQueries: [] }),
    rulebookModelInvoker: async () => JSON.stringify({ operationChecks: [], constraintReviews: [] }),
    modelInvoker: async () => {
      finalModelCalls += 1;
      return publicFinalPayload(
        "不能直接连锁发动「测试区域监察者」的①效果；题面没有施加通常召唤限制，本回合仍可以通常召唤。",
        cards.map((card) => card.name),
      );
    },
    env: {
      MODEL_PROVIDER: "mock",
      RAG_MODEL_PROVIDER: "mock",
      RAG_DRY_RUN: "0",
      OCG_ENGINE_ENABLED: "0",
    },
    dryRun: false,
  });
  assert.equal(finalModelCalls, 1);
  assert.equal(answer.debug.deterministicDecision, null);
  assert.notEqual(answer.debug.modelUsed, "trusted-semantic-state-executor");
  assert.equal(answer.debug.semanticStateTransition, null);
  assert.equal(answer.debug.semanticStateTransitionDiagnostic, null);
});

test("a locally complete executor still cannot skip the final model", async () => {
  const cards = [{
    id: "trap-coverage",
    name: "覆盖均衡陷阱",
    aliases: ["覆盖均衡陷阱"],
    cardType: "trap",
    effectText: "自己场上不存在卡的情况下，此卡也可从手牌发动。①：战斗阶段结束时可以发动。进行某个处理。",
  }, {
    id: "responder-coverage",
    name: "覆盖区域监察者",
    aliases: ["覆盖区域监察者"],
    cardType: "monster",
    effectText: "①：此卡通常召唤的情况下，对方发动手牌・墓地・除外状态的卡的效果时可以发动。那个效果无效并破坏。",
  }];
  let finalModelCalls = 0;
  const answer = await answerRagRulingQuestion({
    question: "对方场上存在通常召唤的「覆盖区域监察者」。自己场上没有卡，自己在战斗阶段结束时从手牌发动「覆盖均衡陷阱」。对方可以直接连锁发动「覆盖区域监察者」的①效果吗？",
    cards,
    records: [],
    qaRecords: [],
    env: { MODEL_PROVIDER: "mock", RAG_MODEL_PROVIDER: "mock", RAG_DRY_RUN: "0", OCG_ENGINE_ENABLED: "0" },
    dryRun: false,
    cardModelInvoker: async () => JSON.stringify({ cardNames: [] }),
    ruleModelInvoker: async () => JSON.stringify({ ruleQueries: [] }),
    modelInvoker: async () => {
      finalModelCalls += 1;
      return publicFinalPayload(
        "不能直接连锁发动「覆盖区域监察者」的①效果。",
        cards.map((card) => card.name),
      );
    },
  });
  assert.equal(finalModelCalls, 1);
  assert.equal(answer.debug.deterministicDecision, null);
  assert.equal(answer.debug.semanticStateTransition, null);
  assert.match(answer.shortAnswer, /^不能直接连锁发动/u);
});

test("a complete production-data question still requires a final-model signature", async () => {
  let finalModelCalls = 0;
  const answer = await answerRagRulingQuestion({
    question: "对方场上通常召唤的「天下独步的大义贼（天下独歩の大義賊）」存在。自己场上没有卡，在战斗阶段结束时从手牌发动「颉颃胜负」。对方可以直接连锁发动「天下独步的大义贼（天下独歩の大義賊）」的①效果吗？",
    env: { MODEL_PROVIDER: "mock", RAG_MODEL_PROVIDER: "mock", RAG_DRY_RUN: "0", OCG_ENGINE_ENABLED: "0" },
    dryRun: false,
    cardModelInvoker: async () => JSON.stringify({ cardNames: [] }),
    ruleModelInvoker: async () => JSON.stringify({ ruleQueries: [] }),
    modelInvoker: async () => {
      finalModelCalls += 1;
      return publicFinalPayload(
        "不能直接连锁发动「天下独步的大义贼」的①效果。",
        ["天下独步的大义贼", "颉颃胜负"],
      );
    },
  });
  assert.equal(finalModelCalls, 1);
  assert.equal(answer.debug.deterministicDecision, null);
  assert.equal(answer.debug.semanticStateTransition, null);
  assert.equal(answer.debug.semanticStateTransitionDiagnostic, null);
  assert.ok(answer.debug.retrievalCounts.officialQaDirectCandidates > 0);
});

for (const fixture of [{
  id: "albaz",
  question: "我方额外卡组只有「冰剑龙 幻冰龙」，手牌只有「教导的圣女 艾克莉西亚」和「阿不思的落胤」。对方场上只有表侧表示的「吞食圣痕之龙」，双方墓地都没有卡。我方召唤「阿不思的落胤」时，可以将「教导的圣女 艾克莉西亚」作为COST丢弃来发动①效果吗？如果可以，效果如何处理？",
  shortAnswer: "可以发动；支付 COST 后「吞食圣痕之龙」不受这次效果影响，效果处理时不进行融合召唤。",
}, {
  id: "historical-albaz",
  question: "我方的额外卡组有「冰剑龙 幻冰龙」，手牌只有「教导的圣女 艾克莉西娅」和「阿不思的落胤」各1张。\n\n对方场上存在的卡只有表侧表示的「吞食圣痕之龙」1只，双方墓地没有卡。\n\n我方召唤「阿不思的落胤」时，可以将「教导的圣女 艾克莉西娅」作为Cost丢弃送去墓地，来发动「阿不思的落胤」的『①』效果吗",
  shortAnswer: "可以发动；支付 Cost 后「吞食圣痕之龙」不受这次效果影响，效果处理时不进行融合召唤。",
}, {
  id: "silver",
  question: "「月光银狗」的①效果适用后，以该效果特殊召唤的怪兽控制权转移给对方，之后又回到自己场上的场合，『自己不是「月光」怪兽不能从额外卡组特殊召唤』如何适用？",
  shortAnswer: "控制权变更后限制立即不再适用，之后控制权归还也不会恢复适用。",
}, {
  id: "printed-reference",
  question: "自己场上有「霸王眷龙 凶饿猛毒」与「光之黄金柜」。该「霸王眷龙 凶饿猛毒」复制了「破坏龙 钢多拉G」的原本卡名和效果。此时它是否成为效果文本框内记载有「光之黄金柜」卡名的怪兽，并可据此发动要求该记载的卡？",
  shortAnswer: "不能仅凭复制满足卡面记载条件，复制不会改写卡面原本印刷文本，因此不能据此发动。",
}, {
  id: "rewrite-attribution",
  question: "我方场上表侧表示存在「尤贝尔之精灵」和「纳祭魔鬼莲」，对方场上表侧表示存在「尤贝尔」。对方结束阶段发动「尤贝尔」的③效果，我方连锁发动「纳祭魔鬼莲」②效果，把那个效果改为破坏场上1只「尤贝尔」怪兽；对方选择破坏自己的「尤贝尔」。这只「尤贝尔」是否算被自身③效果破坏，之后能否发动④效果？",
  shortAnswer: "不算被自身③效果原本的处理破坏，之后可以发动④效果。",
}]) {
  test(`existing complete executor remains offline while the final model signs: ${fixture.id}`, async () => {
    let finalModelCalls = 0;
    const answer = await answerRagRulingQuestion({
      question: fixture.question,
      env: { MODEL_PROVIDER: "mock", RAG_MODEL_PROVIDER: "mock", RAG_DRY_RUN: "0", OCG_ENGINE_ENABLED: "0" },
      dryRun: false,
      cardModelInvoker: async () => JSON.stringify({ cardNames: [] }),
      ruleModelInvoker: async () => JSON.stringify({ ruleQueries: [] }),
      modelInvoker: async () => {
        finalModelCalls += 1;
        return publicFinalPayload(fixture.shortAnswer);
      },
    });
    assert.equal(finalModelCalls, 1, fixture.id);
    assert.equal(answer.debug.deterministicDecision, null, fixture.id);
    assert.equal(answer.debug.semanticStateTransition, null, fixture.id);
    assert.equal(answer.debug.semanticStateTransitionDiagnostic, null, fixture.id);
    assert.equal(answer.shortAnswer, fixture.shortAnswer, fixture.id);
  });
}
