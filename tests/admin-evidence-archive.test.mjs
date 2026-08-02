import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_EVIDENCE_CATEGORIES,
  buildAdminEvidenceDecisionPacket,
  createAdminEvidenceArchive,
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

test("decision packet exposes every evidence id merged into equivalent substance", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      officialQaRelated: [
        {
          id: "a-local-alias",
          type: "official_qa",
          question: "同じ質問。",
          answer: "同じ回答。",
        },
        {
          id: "ygoresources-qa-24189",
          type: "official_qa",
          question: "同じ質問。",
          answer: "同じ回答。",
        },
      ],
    },
  });
  const packet = buildAdminEvidenceDecisionPacket({ archive });
  const item = packet.modelPacket.evidenceItems[0];

  assert.equal(archive.substances.length, 1);
  assert.equal(item.evidenceId, "a-local-alias");
  assert.deepEqual(
    item.evidenceIds,
    ["a-local-alias", "ygoresources-qa-24189"],
  );
  assert.equal(item.equivalentEvidenceIdCount, 2);
  assert.equal(
    new Set(packet.modelPacket.evidenceItems.flatMap(
      (evidenceItem) => evidenceItem.evidenceIds,
    )).has("ygoresources-qa-24189"),
    true,
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
  assert.equal(packet.modelPacket.omissionSummary.catalogComplete, true);
  assert.equal(packet.modelPacket.omissionSummary.catalogedSubstanceCount, 1);
  assert.equal(packet.modelPacket.omissionSummary.uncatalogedSubstanceCount, 0);
  assert.deepEqual(
    packet.modelPacket.omissionSummary.catalog[0].evidenceIds,
    ["other-1"],
  );
  assert.equal(
    packet.modelPacket.omissionSummary.catalog[0].category,
    ADMIN_EVIDENCE_CATEGORIES.OTHER,
  );
  assert.equal(
    packet.modelPacket.omissionSummary.catalog[0].authority,
    "other",
  );
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
  assert.equal(packet.modelPacket.evidenceItems.length, 32);
  assert.ok(categories.includes(ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT));
  assert.ok(categories.includes(ADMIN_EVIDENCE_CATEGORIES.RELATED_QA));
  assert.ok(categories.includes(ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE));
});

test("decision packet omission catalog is informative and independently bounded", () => {
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
  assert.equal(packet.modelPacket.omissionSummary.catalog.length, 2);
  assert.equal(packet.modelPacket.omissionSummary.catalogedSubstanceCount, 2);
  assert.equal(packet.modelPacket.omissionSummary.uncatalogedSubstanceCount, 3);
  assert.equal(packet.modelPacket.omissionSummary.catalogComplete, false);
  assert.equal(
    packet.modelPacket.omissionSummary.categories[
      ADMIN_EVIDENCE_CATEGORIES.RELATED_QA
    ],
    5,
  );
  assert.equal(packet.modelPacket.omissionSummary.authorities.official, 5);
  assert.ok(packet.statistics.omittedCatalogBytes > 0);
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
  assert.equal(item.equivalentEvidenceIdCount, equivalentCount);
  assert.equal(item.evidenceIds.length, 5);
  assert.equal(item.evidenceIdsExcerpted, true);
  assert.equal(item.evidenceIdsAliasedCount, 5);
  assert.equal(item.equivalentEvidenceIdsSha256.length, 64);
  assert.equal(
    item.evidenceIds.every((evidenceId) => /^sha256:[a-f0-9]{64}$/u.test(evidenceId)),
    true,
  );
  assert.equal(item.bodyExcerpted, true);
  assert.equal(item.originalBodyByteCount > item.originalBodyCharCount, true);
  assert.equal(first.includedManifest[0].evidenceIds.length, equivalentCount);
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
