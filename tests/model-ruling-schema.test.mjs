import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_RULING_COUNTER_CHECK_TYPES,
  MODEL_RULING_RESULT_JSON_SCHEMA,
  parseAndValidateModelRulingResult,
  validateModelRulingResult,
} from "../backend/modelRulingSchema.mjs";

test("valid structured ruling passes schema and semantic validation", () => {
  const result = makeResult();
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
  assert.deepEqual(validation.normalized, result);
  assert.equal(MODEL_RULING_RESULT_JSON_SCHEMA.additionalProperties, false);
  assert.ok(MODEL_RULING_RESULT_JSON_SCHEMA.properties.claims.items.required.includes("questionId"));
  assert.ok(MODEL_RULING_RESULT_JSON_SCHEMA.properties.unresolved.items.required.includes("questionId"));
  assert.match(
    MODEL_RULING_RESULT_JSON_SCHEMA.properties.verdicts.items.properties.value.description,
    /Answer to the user question/u,
  );
  assert.match(
    MODEL_RULING_RESULT_JSON_SCHEMA.properties.claims.items.properties.status.description,
    /Truth value of proposition itself/u,
  );
  assert.match(
    MODEL_RULING_RESULT_JSON_SCHEMA.properties.claims.items.properties.status.description,
    /decisive branch propositions with status TRUE or FALSE/u,
  );
});

test("legacy single-question reasoning without questionId remains accepted", () => {
  const result = makeResult();
  delete result.claims[0].questionId;
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
});

test("every determinate question requires a decisive claim backed by visible evidence", () => {
  const emptyReasoning = makeResult();
  emptyReasoning.claims = [];
  emptyReasoning.timeline = [];
  emptyReasoning.evidenceUsage = [];
  const emptyValidation = validateModelRulingResult(emptyReasoning, {
    evidenceSnapshot: makeSnapshot(),
    modelVisibleEvidencePacket: makeVisiblePacket(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(emptyValidation.ok, false);
  assert.ok(emptyValidation.errors.some(
    (error) => error.includes(
      "TRUE verdict q1 must have at least one decisive TRUE claim with model-visible evidence",
    ),
  ));

  const unrelatedQuestionClaim = makeResult();
  unrelatedQuestionClaim.claims[0].questionId = "q2";
  const unrelatedValidation = validateModelRulingResult(unrelatedQuestionClaim, {
    evidenceSnapshot: makeSnapshot(),
    modelVisibleEvidencePacket: makeVisiblePacket(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(unrelatedValidation.ok, false);
  assert.ok(unrelatedValidation.errors.some(
    (error) => error.includes(
      "TRUE verdict q1 must have at least one decisive TRUE claim with model-visible evidence",
    ),
  ));
  assert.ok(unrelatedValidation.errors.includes("claim references unknown questionId: q2"));
});

test("failed evidence or missing-fact counter-check blocks determinate verdicts", () => {
  for (const type of ["EVIDENCE_ENTAILMENT", "MISSING_FACT"]) {
    const result = makeResult();
    result.counterChecks.find((item) => item.type === type).passed = false;
    result.counterChecks.find((item) => item.type === type).note = "关键检查未通过。";
    const validation = validateModelRulingResult(result, {
      evidenceSnapshot: makeSnapshot(),
      expectedQuestionIds: ["q1"],
    });
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.includes(
      `determinate verdict cannot pass with failed critical counterCheck: ${type}`,
    ));
  }
});

test("TRUE activation verdict is not inverted by a later negative resolution clause", () => {
  const result = makeResult();
  result.verdicts[0].conclusion = "可以发动，但后续不会进行任何效果处理。";
  result.conciseAnswer = "可以发动，但是后续不会进行任何效果处理，因此不会进行融合召唤。";
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
});

test("fabricated evidence and fabricated DIRECT_OFFICIAL claims fail closed", () => {
  const fabricated = makeResult();
  fabricated.claims[0].evidenceIds = ["faq-invented"];
  fabricated.evidenceUsage[0].evidenceId = "faq-invented";
  const missing = validateModelRulingResult(fabricated, {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.includes("not present in Evidence Snapshot")));

  const wrongType = makeResult();
  const validation = validateModelRulingResult(wrongType, {
    evidenceSnapshot: {
      selectedEvidence: [{ id: "faq-1", sourceType: "card_text", text: "卡片文本" }],
    },
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("non-direct evidence")));
});

test("provider provenance overclaims can be deterministically downgraded without changing the ruling", () => {
  const overclaimed = makeResult();
  const cardTextPacket = {
    evidenceItems: [{
      evidenceId: "faq-1",
      category: "parsed_card_text",
      authority: "other",
      direct: false,
      current: true,
      bodyExcerpted: false,
      body: "舍弃1张手牌可以发动。",
    }],
  };

  const strict = parseAndValidateModelRulingResult(JSON.stringify(overclaimed), {
    evidenceSnapshot: makeSnapshot(),
    modelVisibleEvidencePacket: cardTextPacket,
    expectedQuestionIds: ["q1"],
  });
  assert.equal(strict.ok, false);

  const normalized = parseAndValidateModelRulingResult(JSON.stringify(overclaimed), {
    evidenceSnapshot: makeSnapshot(),
    modelVisibleEvidencePacket: cardTextPacket,
    expectedQuestionIds: ["q1"],
    normalizeEvidenceProvenance: true,
  });
  assert.equal(normalized.ok, true, normalized.errors?.join("\n"));
  assert.equal(normalized.normalized.verdicts[0].value, overclaimed.verdicts[0].value);
  assert.equal(normalized.normalized.conciseAnswer, overclaimed.conciseAnswer);
  assert.equal(normalized.normalized.claims[0].inferenceType, "CARD_TEXT");
  assert.equal(normalized.normalized.evidenceUsage[0].relation, "SUPPORTS_STEP");
  assert.equal(normalized.provenanceCorrections.length, 2);
});

test("evidence relation lexical variants and narrow exact aliases normalize with an audit trail", () => {
  for (const [relation, expected, expectedReason] of [
    [" directly-entails ", "DIRECTLY_ENTAILS", "canonical lexical variant"],
    ["directlyEntails", "DIRECTLY_ENTAILS", "canonical lexical variant"],
    ["ＤＩＲＥＣＴＬＹ＿ＥＮＴＡＩＬＳ", "DIRECTLY_ENTAILS", "canonical lexical variant"],
    ["direct entailment", "DIRECTLY_ENTAILS", "approved exact alias"],
    ["直接蕴含", "DIRECTLY_ENTAILS", "approved exact alias"],
  ]) {
    const result = makeResult();
    result.evidenceUsage[0].relation = relation;
    const validation = parseAndValidateModelRulingResult(JSON.stringify(result), {
      evidenceSnapshot: makeSnapshot(),
      expectedQuestionIds: ["q1"],
      normalizeEvidenceProvenance: true,
    });

    assert.equal(validation.ok, true, validation.errors?.join("\n"));
    assert.equal(validation.normalized.evidenceUsage[0].relation, expected);
    assert.deepEqual(validation.provenanceCorrections, [{
      kind: "evidence_relation_token_normalization",
      path: "evidenceUsage[0].relation",
      evidenceId: "faq-1",
      from: relation,
      to: expected,
      reason: expectedReason,
    }]);
    assert.equal(result.evidenceUsage[0].relation, relation, "normalization must not mutate input");
  }
});

test("relation alias normalization composes with conservative provenance downgrade", () => {
  const overclaimed = makeResult();
  overclaimed.evidenceUsage[0].relation = "direct entailment";
  const cardTextPacket = {
    evidenceItems: [{
      evidenceId: "faq-1",
      category: "parsed_card_text",
      authority: "other",
      direct: false,
      current: true,
      bodyExcerpted: false,
      body: "舍弃1张手牌可以发动。",
    }],
  };

  const validation = parseAndValidateModelRulingResult(JSON.stringify(overclaimed), {
    evidenceSnapshot: makeSnapshot(),
    modelVisibleEvidencePacket: cardTextPacket,
    expectedQuestionIds: ["q1"],
    normalizeEvidenceProvenance: true,
  });

  assert.equal(validation.ok, true, validation.errors?.join("\n"));
  assert.equal(validation.normalized.evidenceUsage[0].relation, "SUPPORTS_STEP");
  assert.equal(validation.normalized.claims[0].inferenceType, "CARD_TEXT");
  assert.deepEqual(
    validation.provenanceCorrections.map((correction) => correction.kind),
    [
      "evidence_relation_token_normalization",
      "evidence_relation_downgrade",
      "claim_inference_downgrade",
    ],
  );
});

test("ambiguous or unknown evidence relation values remain fail-closed", () => {
  for (const relation of ["SUPPORTS", "RELATED", "RELEVANT", "DIRECT", "OFFICIAL", "NOT_APPLICABLE", "unknown relation", "constructor", "__proto__"]) {
    const result = makeResult();
    result.evidenceUsage[0].relation = relation;
    const validation = parseAndValidateModelRulingResult(JSON.stringify(result), {
      evidenceSnapshot: makeSnapshot(),
      expectedQuestionIds: ["q1"],
      normalizeEvidenceProvenance: true,
    });

    assert.equal(validation.ok, false, `${relation} must not be guessed`);
    assert.ok(validation.errors.some((error) => error.includes("evidenceUsage[0].relation")));
    assert.equal(
      validation.provenanceCorrections?.some(
        (correction) => correction.kind === "evidence_relation_token_normalization",
      ) === true,
      false,
    );
  }
});

test("relation token normalization is opt-in and never repairs unrelated schema failures", () => {
  const lexicalVariant = makeResult();
  lexicalVariant.evidenceUsage[0].relation = "directly-entails";
  const strict = parseAndValidateModelRulingResult(JSON.stringify(lexicalVariant), {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(strict.ok, false);
  assert.equal(Object.hasOwn(strict, "provenanceCorrections"), false);

  const malformed = makeResult();
  malformed.evidenceUsage[0].relation = "directly-entails";
  malformed.evidenceUsage[0].evidenceId = "fabricated-evidence";
  malformed.claims[0].evidenceIds = ["fabricated-evidence"];
  const normalizedButInvalid = parseAndValidateModelRulingResult(JSON.stringify(malformed), {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
    normalizeEvidenceProvenance: true,
  });
  assert.equal(normalizedButInvalid.ok, false);
  assert.ok(normalizedButInvalid.errors.some((error) => error.includes("not present in Evidence Snapshot")));
  assert.equal(normalizedButInvalid.provenanceCorrections.length, 1);
  assert.equal(
    normalizedButInvalid.provenanceCorrections[0].kind,
    "evidence_relation_token_normalization",
  );
});

test("provenance normalization never repairs fabricated evidence references", () => {
  const fabricated = makeResult();
  fabricated.claims[0].evidenceIds = ["fabricated-evidence"];
  fabricated.timeline[0].evidenceIds = ["fabricated-evidence"];
  fabricated.evidenceUsage[0].evidenceId = "fabricated-evidence";

  const validation = parseAndValidateModelRulingResult(JSON.stringify(fabricated), {
    evidenceSnapshot: makeSnapshot(),
    modelVisibleEvidencePacket: makeVisiblePacket(),
    expectedQuestionIds: ["q1"],
    normalizeEvidenceProvenance: true,
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("not present in model-visible Evidence Packet")));
});

test("provenance normalization preserves schema failures instead of throwing", () => {
  const malformed = makeResult();
  delete malformed.claims[0].evidenceIds;
  const validation = parseAndValidateModelRulingResult(JSON.stringify(malformed), {
    evidenceSnapshot: makeSnapshot(),
    modelVisibleEvidencePacket: makeVisiblePacket(),
    expectedQuestionIds: ["q1"],
    normalizeEvidenceProvenance: true,
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("claims[0]")));
});

test("final-model citations are limited to evidence bodies visible in the bounded packet", () => {
  const hiddenEvidenceId = "faq-hidden-in-audit-only";
  const snapshot = makeSnapshot();
  snapshot.auditArchive = [{
    id: hiddenEvidenceId,
    sourceType: "card_faq",
    text: "该正文只保存在完整审计快照中，没有发送给最终模型。",
    current: true,
    isDirect: true,
  }];
  const visiblePacket = {
    evidenceItems: [{
      evidenceId: "faq-1",
      evidenceIds: ["faq-1", "faq-1-equivalent-visible-id"],
      category: "direct_official_qa",
      authority: "official",
      direct: true,
      current: true,
      body: "可以发动，并进行效果处理。",
    }],
  };
  const hiddenCitation = makeResult();
  hiddenCitation.claims[0].evidenceIds = [hiddenEvidenceId];
  hiddenCitation.timeline[0].evidenceIds = [hiddenEvidenceId];
  hiddenCitation.evidenceUsage[0].evidenceId = hiddenEvidenceId;

  const rejected = validateModelRulingResult(hiddenCitation, {
    evidenceSnapshot: snapshot,
    modelVisibleEvidencePacket: visiblePacket,
    expectedQuestionIds: ["q1"],
  });

  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some(
    (error) => error.includes(
      `not present in model-visible Evidence Packet: ${hiddenEvidenceId}`,
    ),
  ));

  const equivalentVisibleCitation = makeResult();
  equivalentVisibleCitation.claims[0].evidenceIds = ["faq-1-equivalent-visible-id"];
  equivalentVisibleCitation.timeline[0].evidenceIds = ["faq-1-equivalent-visible-id"];
  equivalentVisibleCitation.evidenceUsage[0].evidenceId = "faq-1-equivalent-visible-id";
  const accepted = validateModelRulingResult(equivalentVisibleCitation, {
    evidenceSnapshot: snapshot,
    modelVisibleEvidencePacket: visiblePacket,
    expectedQuestionIds: ["q1"],
  });
  assert.equal(accepted.ok, true, accepted.errors?.join("\n"));
});

test("excerpted visible evidence cannot be asserted as direct entailment or DIRECT_OFFICIAL", () => {
  const result = makeResult();
  const packet = makeCompleteVisiblePacket();
  packet.evidenceItems[0].bodyExcerpted = true;
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: makeSnapshot(),
    modelVisibleEvidencePacket: packet,
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("excerpted evidence faq-1 cannot DIRECTLY_ENTAIL"));
  assert.ok(validation.errors.includes(
    "DIRECT_OFFICIAL claim claim-1 cites excerpted evidence: faq-1",
  ));

  const derived = makeResult();
  derived.claims[0].inferenceType = "OFFICIAL_RULE_DERIVATION";
  derived.evidenceUsage[0].relation = "SUPPORTS_STEP";
  const derivedValidation = validateModelRulingResult(derived, {
    evidenceSnapshot: makeSnapshot(),
    modelVisibleEvidencePacket: packet,
    expectedQuestionIds: ["q1"],
  });
  assert.equal(derivedValidation.ok, true, derivedValidation.errors?.join("\n"));
});

test("explicit model-visible validation fails closed when the packet is missing", () => {
  const validation = validateModelRulingResult(makeResult(), {
    evidenceSnapshot: makeSnapshot(),
    modelVisibleEvidencePacket: null,
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some(
    (error) => error.includes("modelVisibleEvidencePacket.evidenceItems is required"),
  ));
});

test("IRRELEVANT evidence cannot support a decisive claim", () => {
  const result = makeResult();
  result.evidenceUsage[0].relation = "IRRELEVANT";
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("cannot support decisive claim")));
});

test("relevant official related QA may support a derivation without being mislabeled direct", () => {
  const result = makeResult();
  result.claims[0].inferenceType = "OFFICIAL_RULE_DERIVATION";
  result.evidenceUsage[0].relation = "SUPPORTS_STEP";
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: {
      selectedEvidence: [{
        id: "faq-1",
        category: "related_qa",
        authority: "official",
        direct: false,
        current: true,
        body: "官方问答正文支持该处理步骤。",
      }],
    },
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
});

test("definite verdict cannot depend on decisive UNKNOWN or unresolved facts", () => {
  const result = makeResult();
  result.claims[0].status = "UNKNOWN";
  result.unresolved.push({ code: "MISSING_STATE", decisive: true, explanation: "缺少决定性状态。" });
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("decisive UNKNOWN")));
  assert.ok(validation.errors.some((error) => error.includes("decisive unresolved")));
});

test("multiple questions need independent verdicts with no extras", () => {
  const result = makeResult();
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1", "q2"],
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("missing verdict for questionId: q2"));
});

test("question-scoped claims and unresolved facts allow q1 TRUE with q2 UNKNOWN", () => {
  const result = makeResult();
  result.claims[0].questionId = "q1";
  result.verdicts.push({
    questionId: "q2",
    value: "UNKNOWN",
    conclusion: "控制者未说明，因此无法确定。",
    conditions: [],
  });
  result.claims.push({
    questionId: "q2",
    claimId: "claim-2",
    proposition: "该分支取决于处理时的控制者。",
    status: "UNKNOWN",
    decisive: true,
    evidenceIds: ["faq-1"],
    inferenceType: "CARD_TEXT",
  });
  result.evidenceUsage[0].supportedClaimIds.push("claim-2");
  result.unresolved.push({
    questionId: "q2",
    code: "MISSING_CONTROLLER",
    decisive: true,
    explanation: "问题未说明处理时由自己还是对方控制该怪兽。",
  });
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: makeSnapshot(),
    modelVisibleEvidencePacket: makeVisiblePacket(),
    expectedQuestionIds: ["q1", "q2"],
  });
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
});

test("unscoped reasoning is rejected as ambiguous for multiple questions", () => {
  const result = makeResult();
  delete result.claims[0].questionId;
  result.verdicts.push({
    questionId: "q2",
    value: "TRUE",
    conclusion: "可以处理。",
    conditions: [],
  });
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1", "q2"],
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some(
    (error) => error.includes("claim claim-1 must include questionId when multiple questions are present"),
  ));
  assert.ok(validation.errors.some(
    (error) => error.includes(
      "TRUE verdict q2 must have at least one decisive TRUE claim with model-visible evidence",
    ),
  ));
});

test("CONDITIONAL and UNKNOWN verdicts require explicit conditions or unresolved reasons", () => {
  const conditional = makeResult();
  conditional.verdicts[0].value = "CONDITIONAL";
  conditional.verdicts[0].conditions = [];
  assert.equal(validateModelRulingResult(conditional, {
    evidenceSnapshot: makeSnapshot(),
  }).errors.some((error) => error.includes("must list conditions")), true);

  const unknown = makeResult();
  unknown.verdicts[0].value = "UNKNOWN";
  unknown.claims[0].status = "TRUE";
  const validation = validateModelRulingResult(unknown, {
    evidenceSnapshot: makeSnapshot(),
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("decisive unresolved")));
});

test("complete evidence rejects generic UNKNOWN but permits a concrete missing game-state fact", () => {
  const generic = makeUnknownResult({
    code: "INSUFFICIENT_EVIDENCE",
    explanation: "资料不足，无法判断。",
  });
  const rejected = validateModelRulingResult(generic, {
    evidenceSnapshot: makeCompleteSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((error) => error.includes("concrete decisive missing fact")));
  assert.ok(rejected.errors.some((error) => error.includes("Evidence Snapshot completeness is sufficient")));

  const concrete = makeUnknownResult({
    code: "MISSING_MONSTER_POSITION",
    explanation: "问题未说明该怪兽当前是表侧攻击表示还是里侧守备表示。",
  });
  const accepted = validateModelRulingResult(concrete, {
    evidenceSnapshot: makeCompleteSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(accepted.ok, true, accepted.errors?.join("\n"));
});

test("anti-refusal uses objective packet completeness and rejects a missing fact already stated", () => {
  const generic = makeUnknownResult({
    code: "RETRIEVAL_INSUFFICIENT",
    explanation: "未检索到足够的规则资料，无法判断。",
  });
  const completeWithoutSelfCertification = makeCompleteSnapshot();
  completeWithoutSelfCertification.evidence.completeness.decisiveMechanismCoverageComplete = false;
  completeWithoutSelfCertification.evidence.retrievalWarnings.push(
    "rule_search_queries_used:12",
    "official_direct_qa_not_found",
  );
  const genericValidation = validateModelRulingResult(generic, {
    evidenceSnapshot: completeWithoutSelfCertification,
    expectedQuestionIds: ["q1"],
  });
  assert.equal(genericValidation.ok, false);
  assert.ok(genericValidation.errors.some(
    (error) => error.includes("Evidence Snapshot completeness is sufficient"),
  ));

  const inventedGap = makeUnknownResult({
    code: "MISSING_MONSTER_POSITION",
    explanation: "问题未说明「匿名怪兽」当前是表侧攻击表示还是里侧守备表示。",
  });
  const inventedGapValidation = validateModelRulingResult(inventedGap, {
    evidenceSnapshot: {
      ...makeCompleteSnapshot(),
      question: "「匿名怪兽」当前为表侧攻击表示。此时可以发动这个效果吗？",
    },
    expectedQuestionIds: ["q1"],
  });
  assert.equal(inventedGapValidation.ok, false);
  assert.ok(inventedGapValidation.errors.some(
    (error) => error.includes("already present in the question"),
  ));
});

test("model-visible packet coverage risks prevent anti-refusal from overstating completeness", () => {
  const makeRetrievalGap = () => makeUnknownResult({
    code: "MISSING_MECHANISM_RULE_BODY",
    explanation: "检索结果未提供该机制的完整规则正文，因此无法确认具体处理顺序。",
  });
  const completePacketValidation = validateModelRulingResult(makeRetrievalGap(), {
    evidenceSnapshot: makeCompleteSnapshot(),
    modelVisibleEvidencePacket: makeCompleteVisiblePacket(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(completePacketValidation.ok, false);
  assert.ok(completePacketValidation.errors.some(
    (error) => error.includes("Evidence Snapshot completeness is sufficient"),
  ));

  const riskMutations = [
    (packet) => { packet.completeness.decisionPacketTruncated = true; },
    (packet) => { packet.omissionSummary.omittedSubstanceCount = 1; },
    (packet) => { packet.truncationSummary.excerptedSubstanceCount = 1; },
    (packet) => { packet.evidenceItems[0].bodyExcerpted = true; },
    (packet) => { packet.completeness.sourceCoverage = "UNKNOWN"; },
    (packet) => { packet.completeness.decisiveMechanismCoverageComplete = false; },
  ];
  for (const mutate of riskMutations) {
    const packet = makeCompleteVisiblePacket();
    mutate(packet);
    const validation = validateModelRulingResult(makeRetrievalGap(), {
      evidenceSnapshot: makeCompleteSnapshot(),
      modelVisibleEvidencePacket: packet,
      expectedQuestionIds: ["q1"],
    });
    assert.equal(validation.ok, true, validation.errors?.join("\n"));
  }
});

test("UNKNOWN cannot claim activation, cost, or selection is missing when stated in the question", () => {
  const cases = [
    {
      code: "MISSING_ACTIVATION_STATE",
      explanation: "问题未说明该效果是否已经发动。",
    },
    {
      code: "MISSING_COST_STATE",
      explanation: "问题未说明发动代价是否已经支付。",
    },
    {
      code: "MISSING_SELECTION_STATE",
      explanation: "问题未说明是否已经选择效果对象。",
    },
  ];
  for (const item of cases) {
    const snapshot = makeCompleteSnapshot();
    snapshot.question = "该效果已经发动，已经支付了发动代价，并且已经选择了效果对象。现在如何处理？";
    const validation = validateModelRulingResult(makeUnknownResult(item), {
      evidenceSnapshot: snapshot,
      expectedQuestionIds: ["q1"],
    });
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some(
      (error) => error.includes("already present in the question"),
    ));
  }
});

test("an interrogative '是否已经发动' does not masquerade as a supplied activation state", () => {
  const snapshot = makeCompleteSnapshot();
  snapshot.question = "该效果是否已经发动？";
  const validation = validateModelRulingResult(makeUnknownResult({
    code: "MISSING_ACTIVATION_STATE",
    explanation: "问题未说明该效果是否已经发动。",
  }), {
    evidenceSnapshot: snapshot,
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
});

test("retrieval insufficiency remains distinct from model refusal and must identify the exact gap", () => {
  const result = makeUnknownResult({
    code: "MISSING_CARD_EFFECT_SECTION",
    explanation: "检索结果缺少该卡②效果的完整卡片文本，无法确认其发动条件。",
  });
  const snapshot = makeCompleteSnapshot();
  snapshot.evidence.completeness.decisiveMechanismCoverageComplete = false;
  snapshot.evidence.retrievalWarnings.push("card_text_section_missing");
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: snapshot,
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
});

test("CONDITIONAL verdicts require concrete checkable branches instead of placeholders", () => {
  const vague = makeResult();
  vague.verdicts[0] = {
    questionId: "q1",
    value: "CONDITIONAL",
    conclusion: "视情况而定。",
    conditions: ["根据实际情况"],
  };
  const rejected = validateModelRulingResult(vague, {
    evidenceSnapshot: makeCompleteSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((error) => error.includes("concrete, checkable branch conditions")));

  const branched = makeResult();
  branched.verdicts[0] = {
    questionId: "q1",
    value: "CONDITIONAL",
    conclusion: "若该怪兽为攻击表示则可以；若为守备表示则不可以。",
    conditions: [
      "该怪兽在处理时为表侧攻击表示。",
      "该怪兽在处理时为守备表示。",
    ],
  };
  const accepted = validateModelRulingResult(branched, {
    evidenceSnapshot: makeCompleteSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(accepted.ok, true, accepted.errors?.join("\n"));
});

test("CONDITIONAL verdicts accept decisive TRUE or FALSE branch claims but not indeterminate claims", () => {
  for (const status of ["TRUE", "FALSE"]) {
    const result = makeResult();
    result.verdicts[0] = {
      questionId: "q1",
      value: "CONDITIONAL",
      conclusion: "若该怪兽为攻击表示则可以；若为守备表示则不可以。",
      conditions: [
        "该怪兽在处理时为表侧攻击表示。",
        "该怪兽在处理时为守备表示。",
      ],
    };
    result.claims[0].proposition = status === "TRUE"
      ? "在攻击表示分支中，该效果可以处理。"
      : "在守备表示分支中，该效果可以处理。";
    result.claims[0].status = status;

    const validation = validateModelRulingResult(result, {
      evidenceSnapshot: makeCompleteSnapshot(),
      expectedQuestionIds: ["q1"],
    });
    assert.equal(validation.ok, true, `${status}: ${validation.errors?.join("\n")}`);
  }

  for (const status of ["UNKNOWN", "CONDITIONAL"]) {
    const result = makeResult();
    result.verdicts[0] = {
      questionId: "q1",
      value: "CONDITIONAL",
      conclusion: "若该怪兽为攻击表示则可以；若为守备表示则不可以。",
      conditions: [
        "该怪兽在处理时为表侧攻击表示。",
        "该怪兽在处理时为守备表示。",
      ],
    };
    result.claims[0].status = status;

    const validation = validateModelRulingResult(result, {
      evidenceSnapshot: makeCompleteSnapshot(),
      expectedQuestionIds: ["q1"],
    });
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.includes(
      "CONDITIONAL verdict q1 must have at least one decisive TRUE or FALSE branch claim with model-visible evidence",
    ));
  }
});

test("timeline rejects duplicate order and mutually-exclusive operation classifications", () => {
  const result = makeResult();
  result.timeline = [
    {
      order: 1,
      action: "把同一操作同时作为发动代价与效果处理",
      result: "错误分类",
      evidenceIds: ["faq-1"],
    },
    {
      order: 1,
      action: "规则处理",
      result: "重复顺序",
      evidenceIds: ["faq-1"],
    },
  ];
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: makeSnapshot(),
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("mutually exclusive")));
  assert.ok(validation.errors.some((error) => error.includes("order must be unique")));
});

test("all fixed counter-checks are required exactly once", () => {
  const result = makeResult();
  result.counterChecks.pop();
  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: makeSnapshot(),
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("counterChecks is missing required type")));
});

test("parser accepts JSON only and never repairs Markdown or loose output", () => {
  const result = makeResult();
  assert.equal(parseAndValidateModelRulingResult(JSON.stringify(result), {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
  }).ok, true);
  const markdown = `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``;
  const validation = parseAndValidateModelRulingResult(markdown, {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.errors, ["model output is not valid JSON"]);
});

test("a FALSE answer accepts a TRUE claim whose own proposition states the blocker", () => {
  const result = makeResult();
  result.verdicts[0].value = "FALSE";
  result.verdicts[0].conclusion = "不能发动。";
  result.conciseAnswer = "不能发动，因为当前场面不存在可返回手牌的合法卡。";
  result.claims[0].proposition = "当前场面不存在可返回手牌的合法卡，因此该效果不能发动。";
  result.claims[0].status = "TRUE";
  const snapshot = makeSnapshot();
  snapshot.selectedEvidence[0].text = "没有可返回手牌的合法卡时不能发动该效果。";

  const validation = validateModelRulingResult(result, {
    evidenceSnapshot: snapshot,
    expectedQuestionIds: ["q1"],
  });
  assert.equal(validation.ok, true, validation.errors?.join("\n"));

  const mirroredPolarity = structuredClone(result);
  mirroredPolarity.claims[0].status = "FALSE";
  const rejected = validateModelRulingResult(mirroredPolarity, {
    evidenceSnapshot: snapshot,
    expectedQuestionIds: ["q1"],
  });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.includes(
    "FALSE verdict q1 must have at least one decisive TRUE claim with model-visible evidence",
  ));
});

test("single compound questions accept explicit sub-verdict ids with parent-scoped claims", () => {
  const result = makeResult();
  result.verdicts = [{
    questionId: "q1a",
    value: "TRUE",
    conclusion: "第一项可以。",
    conditions: [],
  }, {
    questionId: "q1-example2",
    value: "FALSE",
    conclusion: "第二项不可以。",
    conditions: [],
  }];
  result.conciseAnswer = "第一项可以，第二项不可以。";
  result.claims.push({
    questionId: "q1",
    claimId: "claim-2",
    proposition: "第二项不满足处理条件，因此不可以处理。",
    status: "TRUE",
    decisive: true,
    evidenceIds: ["faq-1"],
    inferenceType: "DIRECT_OFFICIAL",
  });
  result.evidenceUsage[0].supportedClaimIds.push("claim-2");

  const validation = parseAndValidateModelRulingResult(JSON.stringify(result), {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
    normalizeStructuralBindings: true,
  });

  assert.equal(validation.ok, true, validation.errors?.join("\n"));
  assert.deepEqual(
    validation.normalized.verdicts.map((verdict) => verdict.questionId),
    ["q1a", "q1-example2"],
  );
});

test("structural normalization disambiguates duplicate verdict ids and rebuilds usage bindings", () => {
  const result = makeResult();
  result.verdicts.push({
    questionId: "q1",
    value: "FALSE",
    conclusion: "第二项不可以。",
    conditions: [],
  });
  result.conciseAnswer = "第一项可以，第二项不可以。";
  result.claims.push({
    questionId: "q1",
    claimId: "claim-2",
    proposition: "第二项不满足处理条件，因此不可以处理。",
    status: "TRUE",
    decisive: true,
    evidenceIds: ["faq-1"],
    inferenceType: "DIRECT_OFFICIAL",
  });
  result.evidenceUsage.push({
    evidenceId: "faq-1",
    relation: "DIRECTLY_ENTAILS",
    supportedClaimIds: ["claim-2"],
  });

  const strict = parseAndValidateModelRulingResult(JSON.stringify(result), {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
  });
  assert.equal(strict.ok, false);

  const normalized = parseAndValidateModelRulingResult(JSON.stringify(result), {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
    normalizeStructuralBindings: true,
  });
  assert.equal(normalized.ok, true, normalized.errors?.join("\n"));
  assert.deepEqual(
    normalized.normalized.verdicts.map((verdict) => verdict.questionId),
    ["q1-part-1", "q1-part-2"],
  );
  assert.deepEqual(
    normalized.normalized.evidenceUsage[0].supportedClaimIds.sort(),
    ["claim-1", "claim-2"],
  );
  assert.ok(normalized.structuralCorrections.some(
    (item) => item.kind === "duplicate_evidence_usage_merged",
  ));
});

test("structural normalization never accepts an unrelated question id", () => {
  const result = makeResult();
  result.verdicts[0].questionId = "q2";
  const validation = parseAndValidateModelRulingResult(JSON.stringify(result), {
    evidenceSnapshot: makeSnapshot(),
    expectedQuestionIds: ["q1"],
    normalizeStructuralBindings: true,
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("missing verdict for questionId: q1"));
  assert.ok(validation.errors.includes("unexpected verdict questionId: q2"));
});

function makeResult() {
  return {
    schemaVersion: "1.0",
    verdicts: [
      {
        questionId: "q1",
        value: "TRUE",
        conclusion: "可以发动。",
        conditions: [],
      },
    ],
    conciseAnswer: "可以发动，并按资料所述处理。",
    claims: [
      {
        questionId: "q1",
        claimId: "claim-1",
        proposition: "该效果满足发动条件。",
        status: "TRUE",
        decisive: true,
        evidenceIds: ["faq-1"],
        inferenceType: "DIRECT_OFFICIAL",
      },
    ],
    timeline: [
      {
        order: 1,
        action: "效果处理",
        result: "完成处理。",
        evidenceIds: ["faq-1"],
      },
    ],
    assumptions: [],
    evidenceUsage: [
      {
        evidenceId: "faq-1",
        relation: "DIRECTLY_ENTAILS",
        supportedClaimIds: ["claim-1"],
      },
    ],
    counterChecks: MODEL_RULING_COUNTER_CHECK_TYPES.map((type) => ({
      type,
      passed: true,
      note: "",
    })),
    unresolved: [],
    confidence: {
      level: "HIGH",
      reasons: ["存在直接官方资料。"],
    },
  };
}

function makeSnapshot() {
  return {
    snapshotId: "snapshot-1",
    selectedEvidence: [
      {
        id: "faq-1",
        sourceType: "card_faq",
        text: "可以发动，并进行效果处理。",
        current: true,
        isDirect: true,
      },
    ],
  };
}

function makeVisiblePacket() {
  return {
    evidenceItems: [{
      evidenceId: "faq-1",
      category: "card_faq",
      authority: "official",
      direct: true,
      current: true,
      body: "可以发动，并进行效果处理。",
    }],
  };
}

function makeCompleteVisiblePacket() {
  return {
    ...makeVisiblePacket(),
    omissionSummary: {
      omittedSubstanceCount: 0,
    },
    truncationSummary: {
      excerptedSubstanceCount: 0,
    },
    completeness: {
      decisionPacketTruncated: false,
      sourceCoverage: "COMPLETE",
      decisiveMechanismCoverageComplete: true,
    },
  };
}

function makeCompleteSnapshot() {
  return {
    snapshotId: "snapshot-complete",
    evidence: {
      selectedEvidence: [
        {
          id: "faq-1",
          sourceType: "card_faq",
          text: "根据怪兽在处理时的表示形式适用对应分支。",
          current: true,
          isDirect: true,
        },
      ],
      conflicts: [],
      retrievalWarnings: [],
      completeness: {
        unresolvedMentionCount: 0,
        ambiguousMentionCount: 0,
        conflictCount: 0,
        retrievalTruncationWarnings: [],
        completeWithinRetrieverCandidateSet: true,
        decisiveMechanismCoverageComplete: true,
      },
    },
  };
}

function makeUnknownResult({ code, explanation }) {
  const result = makeResult();
  result.verdicts[0] = {
    questionId: "q1",
    value: "UNKNOWN",
    conclusion: "缺少决定性场景事实，当前不能确定。",
    conditions: [],
  };
  result.claims[0] = {
    claimId: "claim-1",
    proposition: "现有规则资料不能替代问题中缺失的场景事实。",
    status: "UNKNOWN",
    decisive: true,
    evidenceIds: ["faq-1"],
    inferenceType: "CARD_TEXT",
  };
  result.evidenceUsage[0] = {
    evidenceId: "faq-1",
    relation: "PARTIAL_SUPPORT",
    supportedClaimIds: ["claim-1"],
  };
  result.unresolved = [{ questionId: "q1", code, decisive: true, explanation }];
  result.confidence = {
    level: "LOW",
    reasons: ["存在明确的决定性缺口。"],
  };
  return result;
}
