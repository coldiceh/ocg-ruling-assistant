import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_EVIDENCE_CATEGORIES,
  DEFAULT_ADMIN_DECISION_PACKET_LIMITS,
  buildAdminEvidenceDecisionPacket,
  createAdminEvidenceArchive,
  createAdminEvidenceSelectionContext,
  verifyAdminEvidenceArchive,
} from "../backend/adminEvidenceArchive.mjs";

test("archives flat, official-match, and nested wrappers without false conflicts or repeated bodies", () => {
  const flat = flatQa();
  const officialMatch = {
    questionCardIdCoverage: 1,
    matchedBy: ["card_id", "scene"],
    score: 120,
    isDirect: true,
    text: QA_FULL_TEXT,
    fullText: QA_FULL_TEXT,
    answer: QA_ANSWER,
    question: QA_QUESTION,
    type: "official_qa",
    id: "qa-22803",
  };
  const nested = {
    id: "qa-22803",
    type: "related",
    sourceType: "official_qa",
    retrievalContext: {
      query: "岩石族 特殊召唤",
      scoreBreakdown: { mechanism: 12 },
    },
    rawRecord: {
      text: QA_FULL_TEXT,
      answer: QA_ANSWER,
      question: QA_QUESTION,
    },
  };

  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaDirectCandidates: [flat, officialMatch],
      officialQaRelated: [nested],
    },
  });

  assert.equal(archive.occurrences.length, 3);
  assert.equal(archive.documents.length, 1);
  assert.equal(archive.substances.length, 1);
  assert.equal(archive.evidenceIndex.length, 1);
  assert.equal(archive.evidenceIndex[0].occurrenceIds.length, 3);
  assert.equal(archive.conflicts.length, 0);
  assert.equal(archive.statistics.duplicateBodyOccurrenceCount, 2);
  assert.equal(archive.statistics.sameIdEquivalentOccurrenceCount, 2);
  assert.equal(archive.completeness.allProvidedCandidateOccurrencesArchived, true);
  assert.equal(archive.completeness.evidenceSufficiency, "NOT_ASSESSED");
  assert.equal(Object.isFrozen(archive), true);
  assert.equal(verifyAdminEvidenceArchive(archive).ok, true);
});

test("object field order is canonical, while changed ruling substance creates a reference-only conflict", () => {
  const first = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaDirectCandidates: [flatQa()],
    },
  });
  const reordered = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaDirectCandidates: [{
        isDirect: true,
        text: QA_FULL_TEXT,
        answer: QA_ANSWER,
        fullText: QA_FULL_TEXT,
        question: QA_QUESTION,
        type: "official_qa",
        id: "qa-22803",
      }],
    },
  });
  assert.equal(first.archiveId, reordered.archiveId);

  const changedAnswer = "この場合、その効果は発動できます。";
  const conflictArchive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaDirectCandidates: [
        flatQa(),
        {
          id: "qa-22803",
          type: "official_qa",
          question: QA_QUESTION,
          officialText: changedAnswer,
          fullText: `${QA_QUESTION}\n${changedAnswer}`,
          isDirect: true,
        },
      ],
    },
  });

  assert.equal(conflictArchive.conflicts.length, 1);
  const conflict = conflictArchive.conflicts[0];
  assert.equal(conflict.type, "evidence_id_substance_conflict");
  assert.equal(conflict.evidenceId, "qa-22803");
  assert.equal(conflict.substanceHashes.length, 2);
  assert.equal(conflict.bodyHashes.length, 2);
  assert.equal(conflict.differenceSummary[0].field, "ruling");
  assert.equal("records" in conflict, false);
  assert.equal("text" in conflict, false);
  const serializedConflict = JSON.stringify(conflict);
  assert.equal(serializedConflict.includes(QA_ANSWER), false);
  assert.equal(serializedConflict.includes(changedAnswer), false);
});

test("optional undefined object fields are omitted while other non-JSON values remain rejected", () => {
  const withUndefined = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaRelated: [{
        ...flatQa(),
        link: undefined,
        retrievalContext: {
          query: "岩石族 特殊召唤",
          optionalLabel: undefined,
        },
      }],
    },
  });
  const withoutUndefined = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaRelated: [{
        ...flatQa(),
        retrievalContext: {
          query: "岩石族 特殊召唤",
        },
      }],
    },
  });

  assert.equal(withUndefined.archiveId, withoutUndefined.archiveId);
  assert.equal(withUndefined.contentSha256, withoutUndefined.contentSha256);
  assert.equal(verifyAdminEvidenceArchive(withUndefined).ok, true);

  assert.throws(
    () => createAdminEvidenceArchive({
      evidenceBuckets: {
        officialQaRelated: [{ ...flatQa(), invalidArray: [undefined] }],
      },
    }),
    /non-JSON value at \$\[0\]\.invalidArray\[0\]/u,
  );
  assert.throws(
    () => createAdminEvidenceArchive({
      evidenceBuckets: {
        officialQaRelated: [{ ...flatQa(), invalidFunction: () => true }],
      },
    }),
    /non-JSON value at \$\[0\]\.invalidFunction/u,
  );
});

test("same-id full QA, summary, context snippet, and wrapper remain compatible", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaDirectCandidates: [flatQa()],
      officialQaRelated: [
        {
          id: "qa-22803",
          type: "official_qa",
          question: "岩石族怪獣が存在する場合、効果を発動できますか。",
          answer: "その効果は発動できません。",
        },
        {
          id: "qa-22803",
          type: "official_qa",
          fullText: `Question:\n${QA_QUESTION}\n\nRuling:\n${QA_ANSWER}`,
        },
      ],
      rawRelatedEvidence: [
        {
          id: "qa-22803",
          type: "context_snippet",
          text: QA_ANSWER,
        },
      ],
    },
  });

  assert.equal(archive.occurrences.length, 4);
  assert.equal(archive.substances.length, 4);
  assert.equal(archive.conflicts.length, 0);
  assert.equal(archive.statistics.conflictCount, 0);
  assert.equal(verifyAdminEvidenceArchive(archive).ok, true);
  const packet = buildAdminEvidenceDecisionPacket({ archive });
  const visibleVariants = packet.modelPacket.evidenceItems.filter(
    (item) => item.evidenceId === "qa-22803",
  );
  assert.equal(visibleVariants.length, 1);
  assert.match(visibleVariants[0].body, /^Question:/u);
  assert.match(visibleVariants[0].body, /\n\nRuling:/u);
});

test("compatible aliases cannot transitively collapse two incompatible rulings", () => {
  const sharedRuling = "Shared rule.";
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaRelated: [
        { id: "qa-x", type: "context_snippet", text: sharedRuling },
        { id: "qa-y", type: "context_snippet", text: sharedRuling },
        {
          id: "qa-x",
          type: "official_qa",
          question: "Question X",
          answer: `${sharedRuling} Conclusion X: may activate.`,
        },
        {
          id: "qa-y",
          type: "official_qa",
          question: "Question Y",
          answer: `${sharedRuling} Conclusion Y: cannot activate.`,
        },
      ],
    },
  });

  assert.equal(archive.occurrences.length, 4);
  assert.equal(archive.conflicts.length, 0);
  const packet = buildAdminEvidenceDecisionPacket({ archive });
  assert.equal(
    packet.modelPacket.evidenceItems.some((item) => item.body.includes("Conclusion X: may activate.")),
    true,
  );
  assert.equal(
    packet.modelPacket.evidenceItems.some((item) => item.body.includes("Conclusion Y: cannot activate.")),
    true,
  );
  assert.ok(packet.modelPacket.evidenceItems.length >= 2);
});

test("QA containment compatibility still reports a genuinely changed answer", () => {
  const changedAnswer = "この場合、その効果は発動できます。";
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaDirectCandidates: [
        flatQa(),
        {
          id: "qa-22803",
          type: "official_qa",
          fullText: `Question:\n${QA_QUESTION}\n\nRuling:\n${changedAnswer}`,
        },
      ],
    },
  });

  assert.equal(archive.conflicts.length, 1);
  assert.equal(
    archive.conflicts[0].differenceSummary.some(
      (difference) => difference.field === "ruling",
    ),
    true,
  );
});

test("combined QA text with an intervening wrapper title is structurally equivalent", () => {
  const wrapperTitle = "同じ質問を省略表示した検索見出し…";
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaDirectCandidates: [
        flatQa(),
        {
          id: "qa-22803",
          type: "official_qa",
          text: `${QA_QUESTION} ${wrapperTitle} ${QA_ANSWER}`,
        },
      ],
    },
  });

  assert.equal(archive.substances.length, 2);
  assert.equal(archive.conflicts.length, 0);
  assert.equal(archive.statistics.conflictCount, 0);
  assert.equal(verifyAdminEvidenceArchive(archive).ok, true);
});

test("combined QA structural comparison still reports a changed answer", () => {
  const changedAnswer = "この場合、その効果は発動できます。";
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaDirectCandidates: [
        flatQa(),
        {
          id: "qa-22803",
          type: "official_qa",
          text: `${QA_QUESTION} 検索見出し… ${changedAnswer}`,
        },
      ],
    },
  });

  assert.equal(archive.conflicts.length, 1);
  assert.equal(archive.conflicts[0].evidenceId, "qa-22803");
});

test("deduplicates a rulebook record repeated through rawRelatedEvidence wrappers", () => {
  const ruleText = "同一时点双方适用代替破坏时，先适用回合玩家的效果。";
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      rulebookCandidates: [{
        id: "ocg-rule-replacement-order",
        type: "rulebook",
        text: ruleText,
        score: 90,
      }],
      rawRelatedEvidence: [{
        id: "ocg-rule-replacement-order",
        type: "related",
        sourceType: "rulebook",
        fullText: ruleText,
        text: ruleText,
        score: 72,
        retrievalContext: {
          matchedQuery: "同时 代替破坏 回合玩家",
        },
      }],
    },
  });

  assert.equal(archive.occurrences.length, 2);
  assert.equal(archive.documents.length, 1);
  assert.equal(archive.substances.length, 1);
  assert.equal(archive.conflicts.length, 0);
  assert.equal(
    archive.occurrences.every(
      (occurrence) => occurrence.category === ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE,
    ),
    true,
  );
});

test("rawRelatedEvidence uses QA substance instead of its mechanism collection hint", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      rawRelatedEvidence: [{
        id: "qa-related-from-raw",
        type: "related",
        sourceType: "official_qa",
        question: "関連する公式Q&Aの質問。",
        answer: "関連する公式Q&Aの回答。",
        score: 88,
      }],
    },
  });

  assert.equal(archive.occurrences.length, 1);
  assert.equal(
    archive.occurrences[0].category,
    ADMIN_EVIDENCE_CATEGORIES.RELATED_QA,
  );
});

test("decision packet exposes one citation id while sidecars retain every equivalent id", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaDirectCandidates: [
        {
          id: "ygoresources-qa-24189",
          type: "official_qa",
          isDirect: true,
          question: "同じ質問。",
          answer: "同じ回答。",
        },
      ],
      rawRelatedEvidence: [
        {
          id: "a-local-alias",
          type: "related",
          question: "同じ質問。",
          answer: "同じ回答。",
        },
      ],
    },
  });
  const packet = buildAdminEvidenceDecisionPacket({ archive });
  const item = packet.modelPacket.evidenceItems[0];

  assert.equal(archive.substances.length, 1);
  assert.equal(item.evidenceId, "ygoresources-qa-24189");
  assert.equal(item.direct, true);
  assert.equal(item.authority, "official");
  assert.equal(Object.hasOwn(item, "evidenceIds"), false);
  assert.equal(Object.hasOwn(item, "equivalentEvidenceIdCount"), false);
  assert.deepEqual(
    packet.includedManifest[0].evidenceIds,
    ["a-local-alias", "ygoresources-qa-24189"],
  );
  assert.equal(
    packet.includedManifest[0].occurrenceIds.length,
    2,
  );
  assert.equal(
    packet.modelPacket.evidenceSummary.equivalentEvidenceIdCount,
    2,
  );
  assert.equal(
    packet.modelPacket.evidenceSummary.visibleEvidenceIdCount,
    1,
  );
  assert.equal(
    packet.omittedManifest.length,
    0,
  );
  assert.equal(
    packet.statistics.includedManifestBytes > 0,
    true,
  );
});

test("current direct official QA candidates precede every weaker evidence category", () => {
  const directCandidates = Array.from({ length: 4 }, (_, index) => ({
    id: `direct-${index + 1}`,
    type: "official_qa",
    isDirect: true,
    question: `直接问题 ${index + 1}`,
    answer: `直接答案 ${index + 1}`,
  }));
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaDirectCandidates: directCandidates,
      cardTexts: [{
        id: "card-text-weaker",
        type: "card_text",
        effectText: "卡片文本。",
      }],
      officialQaRelated: [{
        id: "related-weaker",
        type: "official_qa",
        question: "相关问题。",
        answer: "相关答案。",
      }],
      rulebookCandidates: [{
        id: "rule-weaker",
        type: "rulebook",
        text: "机制资料。",
      }],
      rawRelatedEvidence: [{
        id: "other-weaker",
        type: "article",
        text: "其他资料。",
      }],
    },
  });
  const packet = buildAdminEvidenceDecisionPacket({
    archive,
    limits: {
      maxItems: 4,
      maxTotalBodyChars: 10_000,
      maxTotalBodyBytes: 20_000,
    },
  });

  assert.deepEqual(
    packet.modelPacket.evidenceItems.map((item) => item.evidenceId),
    ["direct-1", "direct-2", "direct-3", "direct-4"],
  );
  assert.equal(
    packet.modelPacket.evidenceItems.every(
      (item) => item.category === ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA,
    ),
    true,
  );
  assert.equal(packet.modelPacket.omissionSummary.directOfficialSubstanceCount, 0);
});

test("direct official QA bypasses the ordinary per-item body cap but fails closed at total limits", () => {
  const longAnswer = `直接裁定正文：${"界".repeat(3_000)}。`;
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaDirectCandidates: [{
        id: "long-direct-official",
        type: "official_qa",
        isDirect: true,
        question: "长直接裁定是否保持完整？",
        answer: longAnswer,
      }],
    },
  });
  const complete = buildAdminEvidenceDecisionPacket({ archive });
  const completeItem = complete.modelPacket.evidenceItems[0];

  assert.equal(
    completeItem.body.length > DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxBodyCharsPerItem,
    true,
  );
  assert.equal(completeItem.bodyExcerpted, false);
  assert.equal(complete.truncationManifest.length, 0);

  const bounded = buildAdminEvidenceDecisionPacket({
    archive,
    limits: {
      maxTotalBodyChars: 1_000,
      maxTotalBodyBytes: 4_000,
    },
  });
  assert.equal(bounded.modelPacket.evidenceItems[0].bodyExcerpted, true);
  assert.equal(bounded.truncationManifest.length, 1);
  assert.match(
    bounded.truncationManifest[0].reason,
    /^total_body_(?:character|byte)_budget$/u,
  );
});

test("removed catalog and equivalent-id limits no longer affect packet content hashes", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaRelated: [{
        id: "stable-related",
        type: "official_qa",
        question: "稳定问题。",
        answer: "稳定答案。",
      }],
    },
  });
  const baseline = buildAdminEvidenceDecisionPacket({ archive });
  const withRemovedLimits = buildAdminEvidenceDecisionPacket({
    archive,
    limits: {
      maxEquivalentEvidenceIdsPerItem: 1,
      maxOmissionCatalogItems: 1,
      maxOmissionEvidenceIdsPerItem: 1,
    },
  });

  assert.deepEqual(withRemovedLimits, baseline);
  assert.equal(baseline.schemaVersion, 2);
  assert.equal(baseline.modelPacket.schemaVersion, 2);
  assert.equal(
    Object.hasOwn(baseline.modelPacket.limits, "maxEquivalentEvidenceIdsPerItem"),
    false,
  );
  assert.equal(
    Object.hasOwn(baseline.modelPacket.limits, "maxOmissionCatalogItems"),
    false,
  );
});

test("default decision packet budgets target the bounded final-model window", () => {
  assert.deepEqual(
    {
      maxPacketBytes: DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxPacketBytes,
      maxItems: DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxItems,
      maxTotalBodyChars: DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxTotalBodyChars,
      maxTotalBodyBytes: DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxTotalBodyBytes,
      maxBodyCharsPerItem: DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxBodyCharsPerItem,
      maxBodyBytesPerItem: DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxBodyBytesPerItem,
    },
    {
      maxPacketBytes: 28 * 1024,
      maxItems: 16,
      maxTotalBodyChars: 16_000,
      maxTotalBodyBytes: 20 * 1024,
      maxBodyCharsPerItem: 2_500,
      maxBodyBytesPerItem: 4 * 1024,
    },
  );
});

test("decision packet uses deterministic generic priority and keeps a complete omission sidecar", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaDirectCandidates: [{
        id: "qa-direct",
        type: "official_qa",
        question: "直接问题",
        answer: "直接答案",
        fullText: "直接问题\n直接答案",
        isDirect: true,
      }],
      cardTexts: [{
        id: "card-text-1",
        type: "card_text",
        effectText: "已解析的卡片文本。",
      }],
      rulebookCandidates: [{
        id: "rule-1",
        type: "rulebook",
        text: "机制规则正文。",
      }],
      officialQaRelated: [{
        id: "qa-related",
        type: "related",
        sourceType: "official_qa",
        question: "相关问题",
        answer: "相关答案",
      }],
      rawRelatedEvidence: [{
        id: "other-1",
        type: "article",
        text: "低优先级资料。",
      }],
    },
    metadata: {
      cheapModelSelectedIds: ["other-1"],
      cheapModelRejectedIds: ["qa-direct", "card-text-1", "rule-1", "qa-related"],
    },
  });
  const packet = buildAdminEvidenceDecisionPacket({
    archive,
    limits: {
      maxItems: 4,
      maxTotalBodyChars: 10_000,
      maxBodyCharsPerItem: 2_000,
    },
  });

  assert.deepEqual(
    packet.modelPacket.evidenceItems.map((item) => item.category),
    [
      ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA,
      ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT,
      ADMIN_EVIDENCE_CATEGORIES.RELATED_QA,
      ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE,
    ],
  );
  assert.deepEqual(
    packet.modelPacket.evidenceItems.map((item) => item.evidenceId),
    ["qa-direct", "card-text-1", "qa-related", "rule-1"],
  );
  assert.equal(packet.omittedManifest.length, 1);
  assert.equal(packet.omittedManifest[0].evidenceIds[0], "other-1");
  assert.equal(packet.omittedManifest[0].reason, "item_limit");
  assert.equal(
    packet.modelPacket.omissionSummary.manifestSha256.length,
    64,
  );
  assert.equal(Object.hasOwn(packet.modelPacket.omissionSummary, "catalog"), false);
  assert.equal(packet.modelPacket.omissionSummary.omittedSubstanceCount, 1);
  assert.equal(packet.modelPacket.omissionSummary.categories.other, 1);
  assert.equal(packet.modelPacket.omissionSummary.authorities.other, 1);
  assert.equal(
    packet.modelPacket.policy.preparationModelCanDeleteCandidates,
    false,
  );
  assert.equal(packet.modelPacket.completeness.evidenceSufficiency, "NOT_ASSESSED");
});

test("decision packet weights related rulings while preserving authoritative mechanism rules", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      rulebookCandidates: [
        {
          id: "rule-official-current",
          type: "rulebook",
          sourceType: "official_rulebook",
          text: "公式かつ現行の機制ルール。",
          official: true,
          status: "current",
          score: 10,
        },
        {
          id: "rule-high-score",
          type: "rulebook",
          text: "高スコアだが非公式の機制ルール。",
          score: 999,
        },
        {
          id: "rule-third",
          type: "rulebook",
          text: "第三の機制ルール。",
          score: 5,
        },
      ],
      officialQaRelated: [{
        id: "qa-related-kept",
        type: "official_qa",
        sourceType: "official_qa",
        question: "関連FAQの質問。",
        answer: "関連FAQの回答。",
        score: 1,
      }],
    },
  });
  const first = buildAdminEvidenceDecisionPacket({
    archive,
    limits: {
      maxItems: 3,
      maxTotalBodyChars: 10_000,
      maxBodyCharsPerItem: 2_000,
    },
  });
  const second = buildAdminEvidenceDecisionPacket({
    archive,
    limits: {
      maxItems: 3,
      maxTotalBodyChars: 10_000,
      maxBodyCharsPerItem: 2_000,
    },
  });

  assert.deepEqual(
    first.modelPacket.evidenceItems.map((item) => item.evidenceId),
    ["qa-related-kept", "rule-official-current", "rule-high-score"],
  );
  assert.deepEqual(
    first.modelPacket.policy.withinCategoryPriority,
    [
      "criticalMechanismCoverage",
      "pendingSpellTrapMovementRestriction",
      "mechanismOperationRelevance",
      "officialRelatedQuestionIdentitySetCoverage",
      "officialRelatedQuestionIdentityCoverage",
      "officialRelatedIdentityQuestionTypeCoverage",
      "direct",
      "official",
      "current",
      "sourceCollectionPriority",
      "bestCollectionRank",
      "relevanceScore",
      "evidenceId",
      "substanceHash",
    ],
  );
  assert.equal(
    first.modelPacket.evidenceItems.some(
      (item) => item.category === ADMIN_EVIDENCE_CATEGORIES.RELATED_QA,
    ),
    true,
  );
  assert.deepEqual(first, second);
  assert.equal(first.omittedManifest.length, 1);
  assert.equal(first.omittedManifest[0].bodyHash.length, 64);
  assert.equal(first.modelPacket.omissionSummary.manifestSha256.length, 64);
  assert.equal(first.modelPacket.completeness.evidenceSufficiency, "NOT_ASSESSED");
});

test("question operations keep the matching mechanism rule inside a bounded packet", () => {
  const unrelatedRules = Array.from({ length: 20 }, (_, index) => ({
    id: `unrelated-mechanism-${index + 1}`,
    type: "rulebook",
    sourceType: "official_rulebook",
    official: true,
    status: "current",
    text: `无关机制${index + 1}：伤害计算采用攻击力与守备力。`,
  }));
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      rulebookCandidates: [
        ...unrelatedRules,
        {
          id: "matching-return-mechanism",
          type: "rulebook",
          sourceType: "official_rulebook",
          official: true,
          status: "current",
          text: "正在发动且处理后通常送去墓地的通常魔法或通常陷阱，不能在连锁处理中返回手牌。",
        },
      ],
    },
    metadata: {
      selectionContext: createAdminEvidenceSelectionContext({
        question: "对方刚发动通常陷阱，场上没有其他魔法陷阱时，能否连锁发动把场上的魔法陷阱全部返回手牌的效果？",
      }),
    },
  });
  const packet = buildAdminEvidenceDecisionPacket({
    archive,
    limits: {
      maxItems: 1,
      maxTotalBodyChars: 2_000,
      maxBodyCharsPerItem: 2_000,
    },
  });

  assert.deepEqual(
    packet.modelPacket.evidenceItems.map((item) => item.evidenceId),
    ["matching-return-mechanism"],
  );
  assert.deepEqual(packet.modelPacket.decisionFocus.mandatoryConstraintReview, []);
  assert.equal(packet.modelPacket.decisionFocus.asksActivationLegality, true);
  assert.equal(packet.modelPacket.decisionFocus.reviewProtocol.length, 4);
  assert.ok(packet.includedManifest[0].operationRelevanceScore > 0);
  assert.equal(packet.omittedManifest.length, unrelatedRules.length);
  assert.equal(
    packet.omittedManifest.every((item) => (
      item.reason === "item_limit" && item.operationRelevanceScore === 0
    )),
    true,
  );
});

test("a 16-item packet keeps the self-contained pending spell/trap movement restriction", () => {
  const archive = createAdminEvidenceArchive({
    cardTextCandidates: {
      resolved: Array.from({ length: 12 }, (_, index) => ({
        id: `anonymous-card-text-${index + 1}`,
        name: `匿名卡${index + 1}`,
        text: index === 0
          ? "这个效果发动后，将场上的魔法・陷阱卡全部返回手牌。"
          : `匿名卡${index + 1}的卡片文本。`,
      })),
    },
    evidenceBuckets: {
      officialQaRelated: Array.from({ length: 8 }, (_, index) => ({
        id: `similar-ruling-${index + 1}`,
        type: "official_qa",
        question: `相似但不决定发动合法性的提问${index + 1}。`,
        answer: `相似但不决定发动合法性的回答${index + 1}。`,
      })),
      rulebookCandidates: [
        {
          id: "overlapping-exception-passage",
          type: "rulebook",
          score: 999,
          text: "特别地，发动后会变成装备卡并持续在场上的魔法・陷阱卡，在连锁途中可以回到手牌・卡组。发动后会再次盖放自身或变成其他种类的魔法・陷阱卡，在连锁途中不能回到手牌・卡组。",
        },
        ...Array.from({ length: 20 }, (_, index) => ({
          id: `unrelated-rule-${index + 1}`,
          type: "rulebook",
          score: 500 - index,
          text: `无关机制${index + 1}：怪兽的攻击力变化按照各自效果处理。`,
        })),
        {
          id: "self-contained-pending-movement-restriction",
          type: "rulebook",
          score: 1,
          text: "发动后不能留在场上的魔法・陷阱卡，会在其发动的连锁处理完毕时送去墓地。这种魔法・陷阱卡在连锁途中不能从场上回到手牌・卡组。",
        },
        {
          id: "zero-legal-candidate-activation-rule",
          type: "rulebook",
          score: 0.5,
          text: "这类魔法・陷阱卡的效果基本上不会对自身适用，除自身以外没有能适用的卡时不能发动。",
        },
      ],
    },
    collections: [
      {
        name: "one-context-item",
        categoryHint: ADMIN_EVIDENCE_CATEGORIES.CONTEXT,
        items: [{ id: "context-item", text: "检索上下文。" }],
      },
      {
        name: "one-other-item",
        categoryHint: ADMIN_EVIDENCE_CATEGORIES.OTHER,
        items: [{ id: "other-item", text: "其他辅助资料。" }],
      },
    ],
    metadata: {
      selectionContext: createAdminEvidenceSelectionContext({
        question: "某个将场上的魔法・陷阱卡全部返回手牌的效果，能否直接连锁一张正在发动的通常陷阱？场上没有其他魔法・陷阱卡。",
      }),
    },
  });
  const packet = buildAdminEvidenceDecisionPacket({ archive });
  const includedIds = packet.modelPacket.evidenceItems.map((item) => item.evidenceId);

  assert.equal(includedIds.length, 16);
  assert.ok(includedIds.includes("self-contained-pending-movement-restriction"));
  assert.ok(includedIds.includes("zero-legal-candidate-activation-rule"));
  assert.equal(includedIds.includes("overlapping-exception-passage"), false);
  assert.equal(
    packet.includedManifest.find((item) => (
      item.evidenceIds.includes("self-contained-pending-movement-restriction")
    ))?.pendingSpellTrapMovementRestrictionScore,
    1,
  );
  assert.equal(
    packet.omittedManifest.find((item) => (
      item.evidenceIds.includes("overlapping-exception-passage")
    ))?.pendingSpellTrapMovementRestrictionScore,
    0,
  );
  const requiredReview = packet.modelPacket.decisionFocus.mandatoryConstraintReview;
  assert.ok(requiredReview.some((item) => (
    item.evidenceId === "self-contained-pending-movement-restriction"
    && item.constraintKinds.includes("pending_activated_spell_trap_movement_restriction")
  )));
  assert.ok(requiredReview.some((item) => (
    item.evidenceId === "zero-legal-candidate-activation-rule"
    && item.constraintKinds.includes("zero_legal_candidate_activation")
  )));
  assert.deepEqual(
    packet.modelPacket.decisionFocus.mechanismCoverage.required,
    ["zero_legal_candidate_activation"],
  );
  assert.deepEqual(
    packet.modelPacket.decisionFocus.mechanismCoverage.missing,
    [],
  );
  assert.equal(
    requiredReview.some((item) => item.evidenceId === "overlapping-exception-passage"),
    false,
  );
});

test("bounded official-related slots preserve question identity and identity-type diversity", () => {
  const makeEvidence = ({ id, identity, questionType, score, nested = false }) => ({
    id,
    type: "official_qa",
    sourceType: "official_qa",
    official: true,
    question: `匿名问题 ${id}`,
    answer: `匿名回答 ${id}`,
    score,
    ...(nested ? {
      retrievalSignals: {
        questionType,
        matchedQuestionCardIds: [identity],
        questionCardIdCoverage: 1,
        questionCardIdCount: 1,
        typeCompatible: true,
        playerRoleCompatibility: "compatible",
        scenarioPremiseCompatibility: "compatible",
      },
    } : {
      questionType,
      matchedQuestionCardIds: [identity],
      questionCardIdCoverage: 1,
      questionCardIdCount: 1,
      typeCompatible: true,
      playerRoleCompatibility: "compatible",
      scenarioPremiseCompatibility: "compatible",
    }),
  });
  const run = ({ ids, names }) => {
    const evidence = [
      ...Array.from({ length: 8 }, (_, index) => makeEvidence({
        id: names[index],
        identity: ids[0],
        questionType: "shape_alpha",
        score: 100 - index,
      })),
      makeEvidence({
        id: names[8],
        identity: ids[1],
        questionType: "shape_alpha",
        score: 2,
        nested: true,
      }),
      makeEvidence({
        id: names[9],
        identity: ids[0],
        questionType: "shape_beta",
        score: 1,
      }),
    ];
    const archive = createAdminEvidenceArchive({
      evidenceBuckets: { officialQaRelated: evidence },
    });
    const packet = buildAdminEvidenceDecisionPacket({
      archive,
      limits: {
        maxItems: 3,
        maxTotalBodyChars: 10_000,
        maxTotalBodyBytes: 20_000,
        maxBodyCharsPerItem: 2_000,
      },
    });
    return packet.modelPacket.evidenceItems.map((item) => ({
      identity: item.questionSideProfiles[0]?.matchedQuestionCardIds[0],
      questionType: item.questionSideProfiles[0]?.questionType,
    }));
  };
  const firstIds = ["identity-a", "identity-b"];
  const first = run({
    ids: firstIds,
    names: Array.from({ length: 10 }, (_, index) => `evidence-${index + 1}`),
  });
  assert.equal(first.length, 3);
  assert.ok(first.some((item) => item.identity === firstIds[1]));
  assert.ok(first.some((item) => (
    item.identity === firstIds[0] && item.questionType === "shape_beta"
  )));

  const renamedIds = ["renamed-a", "renamed-b"];
  const renamed = run({
    ids: renamedIds,
    names: Array.from({ length: 10 }, (_, index) => `renamed-${index + 1}`),
  });
  assert.deepEqual(
    renamed.map((item) => ({
      identity: item.identity === renamedIds[0] ? "first" : "second",
      questionType: item.questionType,
    })),
    first.map((item) => ({
      identity: item.identity === firstIds[0] ? "first" : "second",
      questionType: item.questionType,
    })),
  );
});

test("bounded official-related slots preserve a joint identity scene over separate single-identity noise", () => {
  const makeEvidence = ({ id, identities, score }) => ({
    id,
    type: "official_qa",
    sourceType: "official_qa",
    official: true,
    question: `Anonymous interaction question ${id}`,
    answer: `Anonymous interaction answer ${id}`,
    score,
    questionType: "interaction_shape",
    matchedQuestionCardIds: identities,
    questionCardIdCoverage: identities.length / 3,
    questionCardIdCount: identities.length,
    typeCompatible: true,
    playerRoleCompatibility: "compatible",
    scenarioPremiseCompatibility: "compatible",
  });
  const run = ({ identities, prefix, reverse = false }) => {
    const singles = identities.slice(0, 2).flatMap((identity, identityIndex) => (
      Array.from({ length: 8 }, (_, index) => makeEvidence({
        id: `${prefix}-single-${identityIndex}-${index}`,
        identities: [identity],
        score: 100 - identityIndex * 10 - index,
      }))
    ));
    const jointId = `${prefix}-joint`;
    const joint = makeEvidence({
      id: jointId,
      identities: identities.slice(0, 2),
      score: 1,
    });
    const source = reverse ? [joint, ...singles].reverse() : [joint, ...singles];
    const packet = buildAdminEvidenceDecisionPacket({
      archive: createAdminEvidenceArchive({
        evidenceBuckets: { officialQaRelated: source },
      }),
      limits: {
        maxItems: 2,
        maxTotalBodyChars: 8_000,
        maxTotalBodyBytes: 20_000,
      },
    });
    return {
      jointId,
      included: packet.modelPacket.evidenceItems,
    };
  };

  for (const result of [
    run({ identities: ["identity-a", "identity-b", "identity-c"], prefix: "first" }),
    run({
      identities: ["renamed-a", "renamed-b", "renamed-c"],
      prefix: "renamed",
      reverse: true,
    }),
  ]) {
    const retained = result.included.find((item) => item.evidenceId === result.jointId);
    assert.ok(retained, "the joint identity scene must reach the bounded model packet");
    assert.equal(retained.direct, false);
    assert.equal(retained.authority, "official");
    assert.equal(retained.questionSideProfiles[0].matchedQuestionCardIds.length, 2);
  }
});

test("official related question diversity is source agnostic across related buckets", () => {
  const profile = (id, questionType) => ({
    questionType,
    matchedQuestionCardIds: [id],
    typeCompatible: true,
    playerRoleCompatibility: "compatible",
    scenarioPremiseCompatibility: "compatible",
  });
  const item = (id, identity, questionType, score) => ({
    id,
    type: "official_qa",
    sourceType: "official_qa",
    official: true,
    question: `Question ${id}`,
    answer: `Answer ${id}`,
    score,
    ...profile(identity, questionType),
  });
  const buckets = ["officialQaRelated", "faqRelated", "rawRelatedEvidence"];
  const signatures = buckets.map((bucket) => {
    const archive = createAdminEvidenceArchive({
      evidenceBuckets: {
        [bucket]: [
          item("common-a", "identity-a", "shape-a", 100),
          item("common-b", "identity-a", "shape-a", 99),
          item("rare-identity", "identity-b", "shape-a", 2),
          item("rare-type", "identity-a", "shape-b", 1),
        ],
      },
    });
    return buildAdminEvidenceDecisionPacket({
      archive,
      limits: { maxItems: 3, maxTotalBodyChars: 8_000, maxTotalBodyBytes: 20_000 },
    }).modelPacket.evidenceItems.map((evidence) => ({
      identity: evidence.questionSideProfiles[0]?.matchedQuestionCardIds[0],
      type: evidence.questionSideProfiles[0]?.questionType,
    }));
  });
  assert.deepEqual(signatures[1], signatures[0]);
  assert.deepEqual(signatures[2], signatures[0]);
  assert.ok(signatures[0].some((entry) => entry.identity === "identity-b"));
  assert.ok(signatures[0].some((entry) => entry.type === "shape-b"));
});

test("compatible profiles own diversity slots while mismatch never receives a reserve", () => {
  const evidence = [
    {
      id: "mismatch-first",
      type: "official_qa",
      official: true,
      question: "Mismatch question",
      answer: "Mismatch answer",
      score: 100,
      questionType: "rare-shape",
      matchedQuestionCardIds: ["rare-identity"],
      typeCompatible: false,
      playerRoleCompatibility: "mismatch",
      scenarioPremiseCompatibility: "compatible",
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `compatible-${index}`,
      type: "official_qa",
      official: true,
      question: `Compatible question ${index}`,
      answer: `Compatible answer ${index}`,
      score: 10 - index,
      questionType: "common-shape",
      matchedQuestionCardIds: ["common-identity"],
      typeCompatible: true,
      playerRoleCompatibility: "compatible",
      scenarioPremiseCompatibility: "compatible",
    })),
    {
      id: "compatible-rare",
      type: "official_qa",
      official: true,
      question: "Compatible rare question",
      answer: "Compatible rare answer",
      score: 1,
      questionType: "rare-shape",
      matchedQuestionCardIds: ["rare-identity"],
      typeCompatible: true,
      playerRoleCompatibility: "compatible",
      scenarioPremiseCompatibility: "compatible",
    },
  ];
  const packet = buildAdminEvidenceDecisionPacket({
    archive: createAdminEvidenceArchive({ evidenceBuckets: { officialQaRelated: evidence } }),
    limits: { maxItems: 2, maxTotalBodyChars: 8_000, maxTotalBodyBytes: 20_000 },
  });
  const included = packet.modelPacket.evidenceItems.map((item) => item.evidenceId);
  assert.ok(included.includes("compatible-rare"));
  assert.equal(included.includes("mismatch-first"), false);
});

test("top-level and retrieval-signal profiles remain independent instead of being merged", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaRelated: [{
        id: "conflicting-profiles",
        type: "official_qa",
        official: true,
        question: "Question",
        answer: "Answer",
        questionType: "top-shape",
        matchedQuestionCardIds: ["top-identity"],
        typeCompatible: false,
        playerRoleCompatibility: "mismatch",
        retrievalSignals: {
          questionType: "nested-shape",
          matchedQuestionCardIds: ["nested-identity"],
          typeCompatible: true,
          playerRoleCompatibility: "compatible",
          scenarioPremiseCompatibility: "compatible",
        },
      }],
    },
  });
  const profiles = archive.occurrences[0].questionSideProfiles;
  assert.equal(profiles.length, 2);
  assert.ok(profiles.some((profile) => (
    profile.profileSource === "top_level"
    && profile.questionType === "top-shape"
    && profile.matchedQuestionCardIds[0] === "top-identity"
    && profile.typeCompatible === false
  )));
  assert.ok(profiles.some((profile) => (
    profile.profileSource === "retrieval_signals"
    && profile.questionType === "nested-shape"
    && profile.matchedQuestionCardIds[0] === "nested-identity"
    && profile.typeCompatible === true
  )));
  assert.equal(profiles.some((profile) => (
    profile.questionType === "top-shape"
    && profile.matchedQuestionCardIds.includes("nested-identity")
  )), false);
});

test("heavy question profiles stay compact and preserve four bodies inside 28 KiB", () => {
  const longIds = Array.from({ length: 20 }, (_, index) => (
    `identity-${index}-${"x".repeat(180)}`
  ));
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaRelated: Array.from({ length: 4 }, (_, index) => ({
        id: `heavy-${index}`,
        type: "official_qa",
        official: true,
        question: `Heavy question ${index}`,
        answer: `Body ${index} ${"正文".repeat(300)}`,
        questionType: `shape-${index}`,
        matchedQuestionCardIds: longIds,
        typeCompatible: true,
        playerRoleCompatibility: "compatible",
        scenarioPremiseCompatibility: "compatible",
        retrievalSignals: {
          questionType: `nested-shape-${index}`,
          matchedQuestionCardIds: longIds.slice().reverse(),
          typeCompatible: true,
          playerRoleCompatibility: "compatible",
          scenarioPremiseCompatibility: "compatible",
        },
      })),
    },
  });
  const packet = buildAdminEvidenceDecisionPacket({
    archive,
    limits: {
      maxPacketBytes: 28 * 1024,
      maxItems: 4,
      maxTotalBodyChars: 16_000,
      maxTotalBodyBytes: 20 * 1024,
    },
  });
  assert.equal(packet.modelPacket.evidenceItems.length, 4);
  assert.equal(packet.modelPacket.evidenceItems.every((item) => item.body.length > 0), true);
  assert.equal(packet.modelPacket.evidenceItems.every(
    (item) => item.questionSideProfiles.length <= 2
      && item.questionSideProfiles.every((profile) => (
        profile.matchedQuestionCardIds.length <= 4
        && Object.hasOwn(profile, "profileAudit") === false
      )),
  ), true);
  assert.ok(packet.modelPacket.evidenceSummary
    .questionSideProfileCompleteness.modelOmittedIdCount > 0);
  assert.ok(packet.modelPacket.evidenceSummary
    .questionSideProfileCompleteness.modelOmittedProfileCount >= 0);
  assert.equal(packet.modelPacket.completeness.packetStructurallyExcerpted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(packet.modelPacket), "utf8") <= 28 * 1024);
});

test("mandatory constraints retain activation candidate review for a resolution question", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      rulebookCandidates: [{
        id: "pending-movement-restriction",
        type: "rulebook",
        text: "发动后不能留在场上的魔法・陷阱卡，会在其发动的连锁处理完毕时送去墓地。这种魔法・陷阱卡在连锁途中不能从场上回到手牌・卡组。",
      }],
    },
    metadata: {
      selectionContext: createAdminEvidenceSelectionContext({
        question: "C1的通常陷阱已经发动。另一个效果将场上的魔法・陷阱全部返回手牌，结算时哪些卡回手？",
      }),
    },
  });
  const packet = buildAdminEvidenceDecisionPacket({ archive });

  assert.equal(packet.modelPacket.decisionFocus.asksActivationLegality, false);
  assert.ok(
    packet.modelPacket.decisionFocus.mandatoryConstraintReview.length > 0,
  );
  assert.equal(packet.modelPacket.decisionFocus.reviewProtocol.length, 4);
});

test("printed operations can prioritize matching mechanisms without a decisive question phrase", () => {
  const archive = createAdminEvidenceArchive({
    cardTextCandidates: {
      resolved: [{
        id: "anonymous-card-text",
        text: "这个效果发动后，将场上的1张卡除外。",
      }],
    },
    evidenceBuckets: {
      rulebookCandidates: [
        {
          id: "unrelated-destruction-rule",
          type: "rulebook",
          text: "被战斗破坏的怪兽在伤害步骤结束时送去墓地。",
        },
        {
          id: "matching-banish-rule",
          type: "rulebook",
          text: "里侧表示除外的卡不能确认卡片信息。",
        },
      ],
    },
    metadata: {
      selectionContext: createAdminEvidenceSelectionContext({
        question: "这个效果可以发动吗？",
      }),
    },
  });
  const packet = buildAdminEvidenceDecisionPacket({
    archive,
    limits: {
      maxItems: 2,
      maxTotalBodyChars: 2_000,
      maxBodyCharsPerItem: 2_000,
    },
  });

  assert.deepEqual(
    packet.modelPacket.evidenceItems.map((item) => item.evidenceId),
    ["anonymous-card-text", "matching-banish-rule"],
  );
  assert.equal(
    packet.omittedManifest.some((item) => (
      item.evidenceIds.includes("unrelated-destruction-rule")
      && item.reason === "item_limit"
    )),
    true,
  );
});

test("selection context is deterministically bounded before it enters archive metadata", () => {
  const context = createAdminEvidenceSelectionContext({
    question: "问".repeat(100_000),
    questions: Array.from({ length: 40 }, (_, index) => ({
      questionId: `q${index + 1}`,
      text: `子问题${index + 1}`,
    })),
  });

  assert.equal(context.truncated, true);
  assert.equal(context.texts.length, 1);
  assert.equal(context.charCount <= 24_000, true);
  assert.equal(context.byteCount <= 32 * 1024, true);
  assert.deepEqual(context, createAdminEvidenceSelectionContext({
    question: "问".repeat(100_000),
    questions: Array.from({ length: 40 }, (_, index) => ({
      questionId: `q${index + 1}`,
      text: `子问题${index + 1}`,
    })),
  }));
});

test("provided facts cannot turn a resolution question into activation legality intent", () => {
  const context = createAdminEvidenceSelectionContext({
    question: "C2处理后对象离场，已经组成连锁的C1如何继续处理？",
    providedFacts: ["另一个效果的发动条件要求场上存在合法候选。"],
  });

  assert.equal(context.asksActivationLegality, false);
  assert.equal(createAdminEvidenceSelectionContext({
    question: "C1的发动条件已经满足并且已经组成连锁，C2处理后对象离场，C1如何继续处理？",
  }).asksActivationLegality, false);
  assert.equal(createAdminEvidenceSelectionContext({
    question: "这不是问能否发动，也无需判断能否发动，只问已经组成连锁后如何处理。",
  }).asksActivationLegality, false);
  assert.equal(createAdminEvidenceSelectionContext({
    question: "这个效果可发动吗？",
  }).asksActivationLegality, true);
  assert.equal(createAdminEvidenceSelectionContext({
    question: "この効果は発動できる？",
  }).asksActivationLegality, true);
});

test("many resolved card texts cannot starve related rulings and mechanism evidence", () => {
  const archive = createAdminEvidenceArchive({
    cardTextCandidates: {
      resolved: Array.from({ length: 33 }, (_, index) => ({
        id: `card-text-${index + 1}`,
        name: `匿名卡${index + 1}`,
        text: `匿名卡${index + 1}的卡片文本。`,
      })),
    },
    evidenceBuckets: {
      faqRelated: [{
        id: "qa-related-required",
        title: "相关官方问答",
        answer: "这是与处理步骤直接相关的官方问答。",
        official: true,
      }],
      rulebookCandidates: [{
        id: "rule-required",
        title: "必要机制规则",
        text: "这是完成处理顺序判断所需的机制规则。",
        official: true,
      }],
    },
  });

  const packet = buildAdminEvidenceDecisionPacket({ archive });
  const categories = packet.modelPacket.evidenceItems.map((item) => item.category);
  assert.equal(packet.modelPacket.evidenceItems.length, 16);
  assert.ok(categories.includes(ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT));
  assert.ok(categories.includes(ADMIN_EVIDENCE_CATEGORIES.RELATED_QA));
  assert.ok(categories.includes(ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE));
});

test("simultaneous trigger order and reverse chain resolution survive more than 16 noisy candidates", () => {
  const archive = createAdminEvidenceArchive({
    cardTextCandidates: {
      resolved: Array.from({ length: 20 }, (_, index) => ({
        id: `timing-card-${index + 1}`,
        text: `匿名怪兽${index + 1}的无关卡片文本。`,
      })),
    },
    evidenceBuckets: {
      officialQaRelated: [
        ...Array.from({ length: 24 }, (_, index) => ({
          id: `timing-noise-qa-${index + 1}`,
          type: "official_qa",
          official: true,
          status: "current",
          question: `无关官方问答${index + 1}。`,
          answer: "攻击力变化按照该效果处理。",
        })),
        {
          id: "simultaneous-trigger-order-qa",
          type: "official_qa",
          official: true,
          status: "current",
          question: "同じタイミングで発動する/できる効果が複数存在する場合、どのような順番でチェーンを組んで発動しますか？",
          answer: "優先度1の必ず発動する効果、優先度2の公開されている状態の任意効果の順にチェーンを組み、同じ優先度ではターンプレイヤーが先にチェーンを組みます。",
        },
      ],
      faqRelated: [{
        id: "event-immediate-trigger-faq",
        type: "card-faq",
        official: true,
        status: "current",
        text: "S召唤成功直后才能发动。因连锁2以后的效果进行S召唤，且召唤后还有其他处理时不能发动。",
      }],
      rulebookCandidates: [
        ...Array.from({ length: 24 }, (_, index) => ({
          id: `timing-noise-rule-${index + 1}`,
          type: "rulebook",
          official: true,
          status: "current",
          text: `无关规则${index + 1}：伤害计算采用攻击力与守备力。`,
        })),
        {
          id: "chain-resolution-reverse-rule",
          type: "rulebook",
          official: true,
          status: "current",
          text: "连锁处理时，从最后发动的效果开始逆序结算：先处理连锁2，再处理连锁1。",
        },
      ],
    },
    metadata: {
      selectionContext: createAdminEvidenceSelectionContext({
        question: "原连锁C1发动效果，C2把怪兽反转。处理后，反转时的必发诱发效果与C1同调召唤怪兽的选发诱发效果在同一时点如何另开连锁？该怪兽是否没有错过同调召唤时的时点？",
      }),
    },
  });

  const packet = buildAdminEvidenceDecisionPacket({ archive });
  const includedIds = packet.modelPacket.evidenceItems.map(
    (item) => item.evidenceId,
  );
  assert.equal(includedIds.length, 16);
  assert.ok(includedIds.includes("simultaneous-trigger-order-qa"));
  assert.ok(includedIds.includes("chain-resolution-reverse-rule"));
  assert.ok(includedIds.includes("event-immediate-trigger-faq"));
  assert.deepEqual(
    packet.modelPacket.decisionFocus.mechanismCoverage,
    {
      scope: "packet_presence_only_not_evidence_entailment",
      required: [
        "simultaneous_trigger_order",
        "chain_resolution_reverse",
        "event_immediate_trigger_window",
      ],
      covered: [
        "simultaneous_trigger_order",
        "chain_resolution_reverse",
        "event_immediate_trigger_window",
      ],
      missing: [],
      evidenceByMechanism: [
        {
          mechanism: "simultaneous_trigger_order",
          evidenceIds: ["simultaneous-trigger-order-qa"],
        },
        {
          mechanism: "chain_resolution_reverse",
          evidenceIds: ["chain-resolution-reverse-rule"],
        },
        {
          mechanism: "event_immediate_trigger_window",
          evidenceIds: ["event-immediate-trigger-faq"],
        },
      ],
    },
  );
  assert.ok(packet.includedManifest.every((item) => (
    item.criticalMechanismRelevanceScore >= 0
  )));
});

test("ordinary opposing effects in C1 and C2 do not become simultaneous trigger ordering", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      rulebookCandidates: [{
        id: "reverse-chain-rule",
        type: "rulebook",
        text: "连锁处理时先处理连锁2，再处理连锁1，从最后发动的效果开始逆序结算。",
      }, {
        id: "unrelated-trigger-order-rule",
        type: "rulebook",
        text: "同一时点存在多个诱发效果时，必发效果与选发效果按优先顺序组成连锁。",
      }],
    },
    metadata: {
      selectionContext: createAdminEvidenceSelectionContext({
        question: "双方主要阶段，对方以怪兽为对象发动效果，我方连锁该怪兽效果。C2处理后对象离场，C1是否继续处理？",
      }),
    },
  });

  const decisionFocus = buildAdminEvidenceDecisionPacket({ archive })
    .modelPacket.decisionFocus;
  assert.deepEqual(
    decisionFocus.mechanismCoverage.required,
    ["chain_resolution_reverse"],
  );
  assert.deepEqual(
    decisionFocus.mechanismCoverage.covered,
    ["chain_resolution_reverse"],
  );
  assert.equal(decisionFocus.asksActivationLegality, false);
  assert.deepEqual(decisionFocus.mandatoryConstraintReview, []);
  assert.deepEqual(decisionFocus.reviewProtocol, []);
});

test("decision packet omission summary stays compact while its sidecar remains complete", () => {
  const archive = createAdminEvidenceArchive({
    collections: [{
      name: "many-related",
      categoryHint: ADMIN_EVIDENCE_CATEGORIES.RELATED_QA,
      items: Array.from({ length: 6 }, (_, index) => ({
        id: `qa-${index + 1}`,
        type: "qa",
        official: true,
        question: `Question ${index + 1}`,
        answer: `Answer ${index + 1}`,
      })),
    }],
  });
  const packet = buildAdminEvidenceDecisionPacket({
    archive,
    limits: {
      maxItems: 1,
      maxTotalBodyChars: 1_000,
      maxBodyCharsPerItem: 1_000,
      maxOmissionCatalogItems: 2,
      maxOmissionEvidenceIdsPerItem: 1,
    },
  });

  assert.equal(packet.omittedManifest.length, 5);
  assert.equal(Object.hasOwn(packet.modelPacket.omissionSummary, "catalog"), false);
  assert.equal(packet.modelPacket.omissionSummary.omittedSubstanceCount, 5);
  assert.equal(
    packet.modelPacket.omissionSummary.categories[
      ADMIN_EVIDENCE_CATEGORIES.RELATED_QA
    ],
    5,
  );
  assert.equal(packet.modelPacket.omissionSummary.authorities.official, 5);
  assert.equal(packet.statistics.omittedCatalogBytes, 0);
  assert.equal(packet.modelPacket.omissionSummary.manifestSha256.length, 64);
});

test("body budget is bounded and truncation never becomes an evidence-sufficiency claim", () => {
  const longRule = `规则开头。${"甲".repeat(600)}规则结尾。`;
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      rulebookCandidates: [{
        id: "long-rule",
        type: "rulebook",
        text: longRule,
      }],
      rawRelatedEvidence: [{
        id: "second-rule",
        type: "rulebook",
        text: "第二条规则。",
      }],
    },
    retrievalWarnings: [],
  });
  const packet = buildAdminEvidenceDecisionPacket({
    archive,
    limits: {
      maxItems: 2,
      maxTotalBodyChars: 180,
      maxBodyCharsPerItem: 160,
    },
  });

  assert.equal(archive.completeness.retrievalTruncationObserved, false);
  assert.equal(archive.completeness.sourceCoverage, "UNKNOWN");
  assert.equal(archive.completeness.evidenceSufficiency, "NOT_ASSESSED");
  assert.equal(packet.statistics.usedBodyChars <= 180, true);
  assert.equal(packet.modelPacket.completeness.decisionPacketTruncated, true);
  assert.equal(packet.modelPacket.completeness.evidenceSufficiency, "NOT_ASSESSED");
  assert.equal(packet.truncationManifest.length >= 1, true);
  assert.equal(packet.truncationManifest[0].omittedBodySha256.length, 64);
});

test("UTF-8 packet bytes, thousands of equivalent ids, and long visible ids are strictly bounded", () => {
  const equivalentCount = 2_000;
  const longIdPrefix = `超长资料标识-${"标".repeat(220)}-`;
  const longChineseAnswer = `裁定正文：${"界".repeat(6_000)}。`;
  const archive = createAdminEvidenceArchive({
    collections: [{
      name: "equivalent-official-qa",
      categoryHint: ADMIN_EVIDENCE_CATEGORIES.RELATED_QA,
      items: Array.from({ length: equivalentCount }, (_, index) => ({
        id: `${longIdPrefix}${String(index).padStart(4, "0")}`,
        type: "official_qa",
        official: true,
        question: "这些记录表达同一条裁定吗？",
        answer: longChineseAnswer,
      })),
    }],
  });
  const limits = {
    maxPacketBytes: 12 * 1024,
    maxItems: 4,
    maxTotalBodyChars: 30_000,
    maxTotalBodyBytes: 90_000,
    maxBodyCharsPerItem: 30_000,
    maxBodyBytesPerItem: 90_000,
    maxEquivalentEvidenceIdsPerItem: 5,
    maxEvidenceIdBytes: 96,
  };
  const first = buildAdminEvidenceDecisionPacket({ archive, limits });
  const second = buildAdminEvidenceDecisionPacket({ archive, limits });
  const item = first.modelPacket.evidenceItems[0];
  const packetBytes = Buffer.byteLength(
    JSON.stringify(first.modelPacket),
    "utf8",
  );

  assert.deepEqual(first, second);
  assert.equal(packetBytes <= limits.maxPacketBytes, true);
  assert.equal(first.statistics.modelPacketBytes, packetBytes);
  assert.equal(
    /^sha256:[a-f0-9]{64}$/u.test(item.evidenceId),
    true,
  );
  assert.equal(item.evidenceIdAliased, true);
  assert.equal(Object.hasOwn(item, "substanceHash"), false);
  assert.equal(Object.hasOwn(item, "bodyHash"), false);
  assert.equal(Object.hasOwn(item, "sourceCollections"), false);
  assert.equal(Object.hasOwn(item, "bestCollectionRank"), false);
  assert.equal(item.bodyExcerpted, true);
  assert.equal(first.includedManifest[0].evidenceIds.length, equivalentCount);
  assert.equal(first.includedManifest[0].substanceHash.length, 64);
  assert.equal(first.includedManifest[0].bodyHash.length, 64);
  assert.equal(first.truncationManifest[0].originalBodyByteCount > 0, true);
  assert.equal(first.modelPacket.completeness.packetStructurallyExcerpted, true);
});

test("large conflict collections are hashed, excerpted per item, and kept complete in the sidecar", () => {
  const conflictCount = 24;
  const variantsPerConflict = 7;
  const items = [];
  for (let conflictIndex = 0; conflictIndex < conflictCount; conflictIndex += 1) {
    const evidenceId = `冲突资料-${conflictIndex}-${"异".repeat(260)}`;
    for (let variantIndex = 0; variantIndex < variantsPerConflict; variantIndex += 1) {
      items.push({
        id: evidenceId,
        type: "official_qa",
        official: true,
        question: `冲突问题 ${conflictIndex}`,
        answer: `互不相同的答案 ${conflictIndex}-${variantIndex}-${"答".repeat(80)}`,
      });
    }
  }
  const archive = createAdminEvidenceArchive({
    collections: [{
      name: "many-conflicting-official-qa",
      categoryHint: ADMIN_EVIDENCE_CATEGORIES.RELATED_QA,
      items,
    }],
  });
  const limits = {
    maxPacketBytes: 18 * 1024,
    maxItems: 2,
    maxTotalBodyChars: 10_000,
    maxTotalBodyBytes: 20_000,
    maxBodyCharsPerItem: 2_000,
    maxBodyBytesPerItem: 4_000,
    maxEvidenceIdBytes: 96,
    maxConflictCatalogItems: 3,
    maxConflictItemBytes: 1_200,
    maxConflictReferencesPerItem: 3,
  };
  const packet = buildAdminEvidenceDecisionPacket({ archive, limits });
  const modelPacketBytes = Buffer.byteLength(
    JSON.stringify(packet.modelPacket),
    "utf8",
  );

  assert.equal(archive.conflicts.length, conflictCount);
  assert.equal(packet.conflictManifest.length, conflictCount);
  assert.equal(packet.modelPacket.conflicts.length <= 3, true);
  assert.equal(
    packet.modelPacket.conflicts.every(
      (conflict) => Buffer.byteLength(JSON.stringify(conflict), "utf8") <= 1_200,
    ),
    true,
  );
  assert.equal(
    packet.modelPacket.conflicts.every((conflict) => conflict.evidenceIdAliased),
    true,
  );
  assert.equal(packet.modelPacket.conflictSummary.totalConflictCount, conflictCount);
  assert.equal(packet.modelPacket.conflictSummary.catalogComplete, false);
  assert.equal(packet.modelPacket.conflictSummary.manifestSha256.length, 64);
  assert.equal(modelPacketBytes <= limits.maxPacketBytes, true);
  assert.equal(packet.statistics.modelPacketBytes, modelPacketBytes);
});

test("the minimum supported packet budget still returns a valid bounded envelope", () => {
  const archive = createAdminEvidenceArchive();
  const packet = buildAdminEvidenceDecisionPacket({
    archive,
    limits: { maxPacketBytes: 4 * 1024 },
  });

  assert.equal(
    Buffer.byteLength(JSON.stringify(packet.modelPacket), "utf8") <= 4 * 1024,
    true,
  );
  assert.equal(packet.modelPacket.evidenceItems.length, 0);
  assert.equal(packet.modelPacket.conflicts.length, 0);
});

test("all array-valued future buckets are archived instead of silently filtered", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      futureEvidenceBucket: [{
        id: "future-1",
        text: "未来检索器新增的资料。",
      }],
      remainingUnresolvedMentions: [{
        input: "未识别简称",
        reason: "not_found",
      }],
    },
  });

  assert.equal(archive.occurrences.length, 2);
  assert.deepEqual(
    archive.collections.map((collection) => collection.name),
    [
      "evidenceBuckets.futureEvidenceBucket",
      "evidenceBuckets.remainingUnresolvedMentions",
    ],
  );
  assert.equal(
    archive.occurrences.some((occurrence) => occurrence.evidenceId === "future-1"),
    true,
  );
  assert.equal(
    archive.completeness.preparationModelCandidateFilteringApplied,
    false,
  );
});

test("archive integrity verification detects body mutation in a serialized clone", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      rawRelatedEvidence: [{
        id: "rule-1",
        type: "rulebook",
        text: "规则正文。",
      }],
    },
  });
  const clone = JSON.parse(JSON.stringify(archive));
  clone.documents[0].text = "被篡改的正文。";
  const verification = verifyAdminEvidenceArchive(clone);
  assert.equal(verification.ok, false);
  assert.equal(
    verification.errors.some((error) => error.includes("document body hash mismatch")),
    true,
  );
});

const QA_QUESTION = "岩石族怪獣が存在する場合、効果を発動できますか。";
const QA_ANSWER = "この場合、その効果は発動できません。";
const QA_FULL_TEXT = `${QA_QUESTION}\n${QA_ANSWER}`;

function flatQa() {
  return {
    id: "qa-22803",
    type: "official_qa",
    question: QA_QUESTION,
    answer: QA_ANSWER,
    fullText: QA_FULL_TEXT,
    text: QA_FULL_TEXT,
    isDirect: true,
  };
}
