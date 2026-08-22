import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PUBLIC_RAG_LINEAGE_MODE,
  PUBLIC_RAG_LINEAGE_STATUSES,
  buildBucketIndex,
  buildSerializedPromptEvidenceIndex,
  classifyPublicRagEvidenceLineage,
  inspectSerializedPromptEvidence,
  loadFrozenPublicRagReplayCases,
  normalizePublicRagReplayCases,
  runPublicRagEvidenceLineageAudit,
} from "../scripts/lib/retrieval-evidence-lineage.mjs";
import { runRetrievalEvidenceLineageCli } from "../scripts/retrieval-evidence-lineage.mjs";

const FIXTURE_SPECS = Object.freeze([
  Object.freeze({
    id: "source-missing",
    question: "fixture query for absent source data",
    evidenceId: "fixture-evidence-source-missing",
    expectedStatus: PUBLIC_RAG_LINEAGE_STATUSES.DATA_SOURCE_MISSING,
  }),
  Object.freeze({
    id: "not-recalled",
    question: "fixture query for an unreturned record",
    evidenceId: "fixture-evidence-not-recalled",
    expectedStatus: PUBLIC_RAG_LINEAGE_STATUSES.NOT_RECALLED,
  }),
  Object.freeze({
    id: "retrieval-limited",
    question: "fixture query for a record beyond the normal limit",
    evidenceId: "fixture-evidence-retrieval-limited",
    expectedStatus: PUBLIC_RAG_LINEAGE_STATUSES.RETRIEVAL_LIMITED,
  }),
  Object.freeze({
    id: "prompt-omitted",
    question: "fixture query for a prompt reference omission",
    evidenceId: "fixture-evidence-prompt-omitted",
    expectedStatus: PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_REFERENCE_OMITTED,
  }),
  Object.freeze({
    id: "compaction-omitted",
    question: "fixture query for a prompt compaction omission",
    evidenceId: "fixture-evidence-compaction-omitted",
    expectedStatus: PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_COMPACTION_OMITTED,
  }),
  Object.freeze({
    id: "model-visible-full",
    question: "fixture query for a fully visible record",
    evidenceId: "fixture-evidence-model-visible-full",
    expectedStatus: PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_FULL,
  }),
]);

test("public RAG replay normalization keeps only frozen inputs and deduplicates ids", () => {
  const [normalized] = normalizePublicRagReplayCases([{
    id: " normalized-case ",
    question: " 只重放检索输入 ",
    expectedCardIds: ["card-1", "card-1", "", "card-2"],
    expectedEvidenceIds: ["evidence-1", "evidence-1", "evidence-2"],
    modelCardNameCandidates: [{ name: "冻结卡名" }],
    modelRuleSearchQueries: [{ query: "冻结规则查询" }],
    modelRuleCandidateAssessments: [{ id: "candidate-1", relevant: true }],
    frozenResolvedCards: [{ id: "card-1", name: "冻结身份" }],
    frozenUnresolvedMentions: [{ input: "未解析名称" }],
    frozenAmbiguousMentions: [{ input: "歧义名称" }],
    expectedVerdict: "must never become a retrieval input",
    referenceAnswer: "must never become a retrieval input either",
  }]);

  assert.equal(normalized.id, "normalized-case");
  assert.equal(normalized.question, "只重放检索输入");
  assert.deepEqual(normalized.expectedCardIds, ["card-1", "card-2"]);
  assert.deepEqual(normalized.expectedEvidenceIds, ["evidence-1", "evidence-2"]);
  assert.deepEqual(normalized.modelCardNameCandidates, [{ name: "冻结卡名" }]);
  assert.deepEqual(normalized.modelRuleSearchQueries, [{ query: "冻结规则查询" }]);
  assert.deepEqual(normalized.modelRuleCandidateAssessments, [{ id: "candidate-1", relevant: true }]);
  assert.deepEqual(normalized.frozenResolvedCards, [{ id: "card-1", name: "冻结身份" }]);
  assert.equal(Object.hasOwn(normalized, "expectedVerdict"), false);
  assert.equal(Object.hasOwn(normalized, "referenceAnswer"), false);

  assert.throws(
    () => normalizePublicRagReplayCases([
      { id: "duplicate", question: "one", expectedEvidenceIds: ["evidence-1"] },
      { id: "duplicate", question: "two", expectedEvidenceIds: ["evidence-2"] },
    ]),
    /duplicate public RAG replay case/u,
  );
  assert.throws(
    () => normalizePublicRagReplayCases([
      { id: "empty-evidence", question: "question", expectedEvidenceIds: ["", "  "] },
    ]),
    /expectedEvidenceIds must be non-empty/u,
  );
});

test("frozen replay loader restores retrieval inputs without carrying historical answers", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "public-rag-lineage-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const generationsDir = join(tempRoot, "generations");
  const datasetPath = join(tempRoot, "dataset.json");
  await mkdir(generationsDir, { recursive: true });

  const historicalAnswer = "HISTORICAL_ANSWER_MUST_NOT_SURVIVE";
  await writeFile(datasetPath, JSON.stringify({
    cases: [{
      id: "frozen-case",
      question: "冻结问题",
      referenceAnswer: historicalAnswer,
    }],
  }), "utf8");
  await writeFile(join(generationsDir, "frozen-case.json"), JSON.stringify({
    candidateResponseText: JSON.stringify({
      shortAnswer: historicalAnswer,
      resolvedCards: [{ id: "card-10", name: "冻结卡", resolutionSource: "baige" }],
      debug: {
        modelCardNameCandidates: [{ name: "冻结卡" }],
        modelRuleSearchQueries: [{ query: "冻结查询" }],
        modelRuleCandidateAssessments: [{ id: "qa-20", relevant: true }],
        unresolvedMentions: [{ input: "未知卡" }],
        ambiguousMentions: [{ input: "同名卡" }],
      },
    }),
  }), "utf8");

  const [loaded] = await loadFrozenPublicRagReplayCases({
    datasetPath,
    generationsDir,
    expectations: [{
      id: "frozen-case",
      expectedCardIds: ["card-10"],
      expectedEvidenceIds: ["qa-20"],
      expectedVerdict: historicalAnswer,
    }],
  });

  assert.equal(loaded.question, "冻结问题");
  assert.deepEqual(loaded.expectedCardIds, ["card-10"]);
  assert.deepEqual(loaded.expectedEvidenceIds, ["qa-20"]);
  assert.deepEqual(loaded.modelCardNameCandidates, [{ name: "冻结卡" }]);
  assert.deepEqual(loaded.modelRuleSearchQueries, [{ query: "冻结查询" }]);
  assert.deepEqual(loaded.modelRuleCandidateAssessments, [{ id: "qa-20", relevant: true }]);
  assert.deepEqual(loaded.frozenResolvedCards, [{
    id: "card-10",
    name: "冻结卡",
    resolutionSource: "baige",
  }]);
  assert.deepEqual(loaded.frozenUnresolvedMentions, [{ input: "未知卡" }]);
  assert.deepEqual(loaded.frozenAmbiguousMentions, [{ input: "同名卡" }]);
  assert.equal(JSON.stringify(loaded).includes(historicalAnswer), false);
  assert.equal(Object.hasOwn(loaded, "shortAnswer"), false);
  assert.equal(Object.hasOwn(loaded, "referenceAnswer"), false);
});

test("lineage classifier identifies every retrieval and prompt visibility boundary", () => {
  const evidenceId = "evidence-under-test";
  const fullItem = { id: evidenceId, text: "complete official evidence body" };
  const sourceIndex = buildBucketIndex({ officialQaRelated: [fullItem] });
  const baselineIndex = buildBucketIndex({ officialQaRelated: [fullItem] });
  const expandedIndex = buildBucketIndex({ officialQaRelated: [fullItem] });
  const promptIndex = buildBucketIndex({ officialQaRelated: [fullItem] });
  const allowedIds = new Set([evidenceId]);
  const scenarios = [
    {
      label: "data source missing",
      options: { sourceIndex: new Map() },
      expected: PUBLIC_RAG_LINEAGE_STATUSES.DATA_SOURCE_MISSING,
    },
    {
      label: "not recalled",
      options: { sourceIndex },
      expected: PUBLIC_RAG_LINEAGE_STATUSES.NOT_RECALLED,
    },
    {
      label: "retrieval limited",
      options: { sourceIndex, expandedIndex },
      expected: PUBLIC_RAG_LINEAGE_STATUSES.RETRIEVAL_LIMITED,
    },
    {
      label: "prompt reference omitted",
      options: { sourceIndex, baselineIndex },
      expected: PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_REFERENCE_OMITTED,
    },
    {
      label: "prompt compaction omitted",
      options: { sourceIndex, baselineIndex, promptIndex },
      expected: PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_COMPACTION_OMITTED,
    },
    {
      label: "model visible full",
      options: { sourceIndex, baselineIndex, promptIndex, allowedIds },
      expected: PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_FULL,
    },
  ];

  for (const scenario of scenarios) {
    const result = classifyPublicRagEvidenceLineage({
      evidenceId,
      ...scenario.options,
    });
    assert.equal(result.firstFailureOrVisibility, scenario.expected, scenario.label);
  }

  const excerpted = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex,
    baselineIndex,
    promptIndex: buildBucketIndex({
      officialQaRelated: [{ id: evidenceId, text: "complete official" }],
    }),
    allowedIds,
  });
  assert.equal(
    excerpted.firstFailureOrVisibility,
    PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_EXCERPTED,
  );

  const expandedCandidateOnly = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex,
    expandedCandidateStages: { expandedOfficialQaCandidates: [evidenceId] },
  });
  assert.equal(
    expandedCandidateOnly.firstFailureOrVisibility,
    PUBLIC_RAG_LINEAGE_STATUSES.RETRIEVAL_LIMITED,
  );
  assert.deepEqual(expandedCandidateOnly.expandedCandidateStageHits, ["expandedOfficialQaCandidates"]);
});

test("serialized prompt visibility distinguishes prepared evidence from a shortened model body", () => {
  const evidenceId = "serialized-evidence";
  const fullItem = {
    id: evidenceId,
    question: "complete question",
    detailedScene: "complete detailed scene",
    answer: "complete official answer with decisive tail",
  };
  const visibleItem = {
    ...fullItem,
    answer: "complete official answer",
  };
  const baselineIndex = buildBucketIndex({ officialQaRelated: [fullItem] });
  const preparedPromptIndex = buildBucketIndex({ officialQaRelated: [fullItem] });
  const prompt = [
    "instructions",
    JSON.stringify({
      evidence: [{ bucket: "officialQaRelated", ...visibleItem }],
      allowedEvidenceIds: [evidenceId],
    }),
  ].join("\n");
  const promptIndex = buildSerializedPromptEvidenceIndex(prompt);
  const result = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex: baselineIndex,
    baselineIndex,
    preparedPromptIndex,
    promptIndex,
    allowedIds: new Set([evidenceId]),
  });

  assert.equal(result.preparedPromptLocations.length, 1);
  assert.equal(result.promptLocations.length, 1);
  assert.equal(
    result.firstFailureOrVisibility,
    PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_EXCERPTED,
  );
});

test("serialized prompt inspector covers ordinary buckets, compact arrays, official direct, and parse errors", () => {
  const bucketItem = evidenceRecord("bucket-evidence");
  const bucketPayload = {
    evidence: evidenceBundle([bucketItem]),
    allowedEvidenceIds: [bucketItem.id],
  };
  const prettyPrompt = [
    "instructions",
    "本次用户问题、卡片原文与检索资料如下：",
    JSON.stringify(bucketPayload, null, 2),
  ].join("\n");
  const buckets = inspectSerializedPromptEvidence(prettyPrompt);
  assert.equal(buckets.parseStatus, "parsed");
  assert.equal(buckets.promptKind, "ordinary_buckets");
  assert.equal(buckets.evidenceIndex.has(bucketItem.id), true);
  assert.deepEqual([...buckets.allowedEvidenceIds], [bucketItem.id]);
  assert.equal(buckets.allowedIdsPresent, true);

  const arrayItem = evidenceRecord("array-evidence");
  const compact = inspectSerializedPromptEvidence([
    "compact instructions",
    JSON.stringify({
      evidence: [{ bucket: "officialQaRelated", ...arrayItem }],
      allowedEvidenceIds: [arrayItem.id],
    }),
  ].join("\n"));
  assert.equal(compact.parseStatus, "parsed");
  assert.equal(compact.promptKind, "ordinary_array");
  assert.equal(compact.evidenceIndex.has(arrayItem.id), true);
  assert.deepEqual([...compact.allowedEvidenceIds], [arrayItem.id]);

  const directItem = evidenceRecord("direct-evidence");
  const direct = inspectSerializedPromptEvidence([
    "direct instructions",
    JSON.stringify({ officialQaDirectCandidate: directItem }),
  ].join("\n"));
  assert.equal(direct.parseStatus, "parsed");
  assert.equal(direct.promptKind, "official_direct");
  assert.equal(direct.evidenceIndex.has(directItem.id), true);
  assert.deepEqual([...direct.allowedEvidenceIds], [directItem.id]);
  assert.deepEqual([...direct.evidenceIndex.keys()], [...direct.allowedEvidenceIds]);
  assert.equal(direct.allowedIdsPresent, true);

  const damagedMarkerEnvelope = inspectSerializedPromptEvidence([
    "instructions",
    "本次用户问题、卡片原文与检索资料如下：",
    "{not-json",
    JSON.stringify({ evidence: {}, allowedEvidenceIds: [] }),
  ].join("\n"));
  assert.equal(damagedMarkerEnvelope.parseStatus, "parse_error");

  const missingEvidence = inspectSerializedPromptEvidence(
    JSON.stringify({ allowedEvidenceIds: [] }),
  );
  assert.equal(missingEvidence.parseStatus, "parse_error");

  const missingAllowedIds = inspectSerializedPromptEvidence(
    JSON.stringify({ evidence: {} }),
  );
  assert.equal(missingAllowedIds.parseStatus, "parse_error");

  const ambiguousDirectId = inspectSerializedPromptEvidence(JSON.stringify({
    officialQaDirectCandidate: { id: "direct-a", evidenceId: "direct-b" },
  }));
  assert.equal(ambiguousDirectId.parseStatus, "parse_error");
  const missingDirectId = inspectSerializedPromptEvidence(JSON.stringify({
    officialQaDirectCandidate: { answer: "complete answer without identity" },
  }));
  assert.equal(missingDirectId.parseStatus, "parse_error");

  const invalid = inspectSerializedPromptEvidence("instructions\n{not-json");
  assert.equal(invalid.parseStatus, "parse_error");
  assert.equal(invalid.evidenceIndex.size, 0);
  assert.equal(invalid.allowedEvidenceIds.size, 0);
});

test("classifier reports parse and serialized allow-list failures separately", () => {
  const item = evidenceRecord("boundary-evidence");
  const index = buildBucketIndex({ officialQaRelated: [item] });
  const base = {
    evidenceId: item.id,
    sourceIndex: index,
    baselineIndex: index,
    preparedPromptIndex: index,
    promptIndex: index,
    allowedIds: new Set([item.id]),
  };
  assert.equal(classifyPublicRagEvidenceLineage({
    ...base,
    promptParseStatus: "parse_error",
  }).firstFailureOrVisibility, PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_PARSE_ERROR);
  assert.equal(classifyPublicRagEvidenceLineage({
    ...base,
    promptAllowedIdsConsistent: false,
  }).firstFailureOrVisibility, PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_ALLOWED_IDS_MISMATCH);
});

test("same-id completeness compares answers and actual normalized content across both prompt transitions", () => {
  const evidenceId = "same-id-evidence";
  const bloatedQuestionVersion = {
    id: evidenceId,
    question: "very long repeated question ".repeat(20),
    answer: "short answer",
  };
  const completeAnswerVersion = {
    id: evidenceId,
    question: "canonical question",
    answer: "complete official answer including decisive tail",
  };
  const sourceIndex = buildBucketIndex({ officialQaRelated: [
    bloatedQuestionVersion,
    completeAnswerVersion,
  ] });
  const completeIndex = buildBucketIndex({ officialQaRelated: [completeAnswerVersion] });
  const full = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex,
    baselineIndex: sourceIndex,
    preparedPromptIndex: completeIndex,
    promptIndex: completeIndex,
    allowedIds: new Set([evidenceId]),
    promptWarnings: [`official_related_text_truncated:${evidenceId}`],
  });
  assert.equal(full.firstFailureOrVisibility, PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_FULL);
  assert.deepEqual(full.excerptStages, []);

  const alteredSameLength = {
    ...completeAnswerVersion,
    answer: "X".repeat(completeAnswerVersion.answer.length),
  };
  const altered = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex,
    baselineIndex: sourceIndex,
    preparedPromptIndex: completeIndex,
    promptIndex: buildBucketIndex({ officialQaRelated: [alteredSameLength] }),
    allowedIds: new Set([evidenceId]),
  });
  assert.equal(altered.firstFailureOrVisibility, PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_EXCERPTED);
  assert.deepEqual(altered.excerptStages, ["prepared_to_serialized"]);

  const shortenedPrepared = buildBucketIndex({ officialQaRelated: [{
    ...completeAnswerVersion,
    answer: "complete official answer",
  }] });
  const preparedLoss = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex,
    baselineIndex: completeIndex,
    preparedPromptIndex: shortenedPrepared,
    promptIndex: shortenedPrepared,
    allowedIds: new Set([evidenceId]),
  });
  assert.equal(preparedLoss.firstFailureOrVisibility, PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_EXCERPTED);
  assert.deepEqual(preparedLoss.excerptStages, ["baseline_to_prepared"]);
});

test("mixed answer and fullText bodies retain both surfaces across both prompt transitions", () => {
  const evidenceId = "mixed-body-evidence";
  const full = {
    id: evidenceId,
    question: "canonical question",
    answer: "short official answer",
    fullText: "short official answer\nDECISIVE FULLTEXT TAIL",
  };
  const lostTail = {
    id: evidenceId,
    question: full.question,
    answer: full.answer,
  };
  const sourceIndex = buildBucketIndex({ officialQaRelated: [full] });
  const lostTailIndex = buildBucketIndex({ officialQaRelated: [lostTail] });
  const result = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex,
    baselineIndex: sourceIndex,
    preparedPromptIndex: lostTailIndex,
    promptIndex: lostTailIndex,
    allowedIds: new Set([evidenceId]),
  });

  assert.equal(result.firstFailureOrVisibility, PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_EXCERPTED);
  assert.deepEqual(result.excerptStages, ["baseline_to_prepared"]);
  assert.equal(result.bodyDifferences.length, 1);
  assert.equal(result.bodyDifferences[0].field, "fallbackText");
  assert.match(result.bodyDifferences[0].beforeExcerpt, /DECISIVE FULLTEXT TAIL/u);

  const duplicatedStructuredBody = {
    id: evidenceId,
    question: "Q",
    answer: "A",
    fullText: "Q\nA",
  };
  const structuredOnly = {
    id: evidenceId,
    question: "Q",
    answer: "A",
  };
  const duplicatedIndex = buildBucketIndex({ officialQaRelated: [duplicatedStructuredBody] });
  const structuredOnlyIndex = buildBucketIndex({ officialQaRelated: [structuredOnly] });
  const mechanicallyCovered = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex: duplicatedIndex,
    baselineIndex: duplicatedIndex,
    preparedPromptIndex: structuredOnlyIndex,
    promptIndex: structuredOnlyIndex,
    allowedIds: new Set([evidenceId]),
  });
  assert.equal(
    mechanicallyCovered.firstFailureOrVisibility,
    PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_FULL,
  );
  assert.deepEqual(mechanicallyCovered.bodyDifferences, []);

  const contradictory = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex: buildBucketIndex({ officialQaRelated: [{ id: evidenceId, answer: "可以" }] }),
    baselineIndex: buildBucketIndex({ officialQaRelated: [{ id: evidenceId, answer: "可以" }] }),
    preparedPromptIndex: buildBucketIndex({ officialQaRelated: [{ id: evidenceId, answer: "不可以" }] }),
    promptIndex: buildBucketIndex({ officialQaRelated: [{ id: evidenceId, answer: "不可以" }] }),
    allowedIds: new Set([evidenceId]),
  });
  assert.equal(
    contradictory.firstFailureOrVisibility,
    PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_EXCERPTED,
  );
  assert.deepEqual(contradictory.excerptStages, ["baseline_to_prepared"]);
});

test("same-id version selection keeps the richest corresponding baseline instead of hiding loss", () => {
  const evidenceId = "versioned-same-id";
  const oldVersion = {
    id: evidenceId,
    recordType: "qa",
    sourceUrl: "https://example.test/qa/versioned",
    question: "same official question",
    answer: "obsolete answer that is deliberately much longer than the current answer",
  };
  const currentVersion = {
    ...oldVersion,
    answer: "current answer",
  };
  const baselineIndex = buildBucketIndex({ officialQaRelated: [oldVersion, currentVersion] });
  const currentIndex = buildBucketIndex({ officialQaRelated: [currentVersion] });
  const result = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex: baselineIndex,
    baselineIndex,
    preparedPromptIndex: currentIndex,
    promptIndex: currentIndex,
    allowedIds: new Set([evidenceId]),
  });

  assert.equal(result.firstFailureOrVisibility, PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_EXCERPTED);
  assert.deepEqual(result.excerptStages, ["baseline_to_prepared"]);
  assert.equal(result.selectedVersionChain.baseline.answerChars, oldVersion.answer.length);
  assert.equal(result.selectedVersionChain.prepared.answerChars, currentVersion.answer.length);
  assert.equal(result.selectedVersionChain.serialized.answerChars, currentVersion.answer.length);
  assert.equal(result.bodyDifferences[0].field, "answer");

  const metadataSparseComplete = {
    id: evidenceId,
    question: oldVersion.question,
    answer: "complete baseline body whose metadata is intentionally sparse",
  };
  const metadataRichShort = {
    ...currentVersion,
    answer: "short",
  };
  const metadataBiasedBaseline = buildBucketIndex({
    officialQaRelated: [metadataSparseComplete, metadataRichShort],
  });
  const metadataRichShortIndex = buildBucketIndex({ officialQaRelated: [metadataRichShort] });
  const metadataBiased = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex: metadataBiasedBaseline,
    baselineIndex: metadataBiasedBaseline,
    preparedPromptIndex: metadataRichShortIndex,
    promptIndex: metadataRichShortIndex,
    allowedIds: new Set([evidenceId]),
  });
  assert.equal(
    metadataBiased.firstFailureOrVisibility,
    PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_EXCERPTED,
  );
  assert.deepEqual(metadataBiased.excerptStages, ["baseline_to_prepared"]);
  assert.equal(
    metadataBiased.selectedVersionChain.baseline.answerChars,
    metadataSparseComplete.answer.length,
  );
});

test("serialized truncation warnings require an exact full evidence id and only corroborate body loss", () => {
  const evidenceId = "qa:123";
  const full = { id: evidenceId, answer: "complete official answer with decisive tail" };
  const excerpt = { id: evidenceId, answer: "complete official…tail" };
  const fullIndex = buildBucketIndex({ officialQaRelated: [full] });
  const excerptIndex = buildBucketIndex({ officialQaRelated: [excerpt] });
  const suffixCollision = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex: fullIndex,
    baselineIndex: fullIndex,
    preparedPromptIndex: fullIndex,
    promptIndex: excerptIndex,
    allowedIds: new Set([evidenceId]),
    promptWarnings: ["official_related_text_truncated:prefix:qa:123"],
  });
  assert.deepEqual(suffixCollision.excerptStages, ["prepared_to_serialized"]);
  assert.deepEqual(suffixCollision.serializedWarningTypes, []);

  const exact = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex: fullIndex,
    baselineIndex: fullIndex,
    preparedPromptIndex: fullIndex,
    promptIndex: excerptIndex,
    allowedIds: new Set([evidenceId]),
    promptWarnings: ["official_related_text_truncated:qa:123"],
  });
  assert.deepEqual(exact.excerptStages, [
    "prepared_to_serialized",
    "serialized_warning_confirmed",
  ]);
  assert.deepEqual(exact.serializedWarningTypes, ["official_related_text_truncated"]);

  const fullWithNaturalEllipsis = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex: excerptIndex,
    baselineIndex: excerptIndex,
    preparedPromptIndex: excerptIndex,
    promptIndex: excerptIndex,
    allowedIds: new Set([evidenceId]),
    promptWarnings: ["official_related_text_truncated:qa:123"],
  });
  assert.equal(fullWithNaturalEllipsis.firstFailureOrVisibility, PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_FULL);
  assert.deepEqual(fullWithNaturalEllipsis.serializedWarningTypes, []);

  const droppedWithWarning = classifyPublicRagEvidenceLineage({
    evidenceId,
    sourceIndex: fullIndex,
    baselineIndex: fullIndex,
    preparedPromptIndex: fullIndex,
    promptIndex: new Map(),
    allowedIds: new Set(),
    promptWarnings: ["official_related_text_truncated:qa:123"],
  });
  assert.equal(
    droppedWithWarning.firstFailureOrVisibility,
    PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_COMPACTION_OMITTED,
  );
  assert.equal(Object.hasOwn(droppedWithWarning, "serializedWarningTypes"), false);
});

test("public lineage audit compares expected ids only after retrieval and prompt construction", async () => {
  const cases = FIXTURE_SPECS.map((item) => ({
    id: item.id,
    question: item.question,
    expectedEvidenceIds: [item.evidenceId],
  }));
  const specByQuestion = new Map(FIXTURE_SPECS.map((item) => [item.question, item]));
  const sourceRecords = FIXTURE_SPECS
    .filter((item) => item.id !== "source-missing")
    .map((item) => evidenceRecord(item.evidenceId));
  const retrievalArgumentExpectedKeys = [];
  const promptArgumentExpectedKeys = [];

  const report = await runPublicRagEvidenceLineageAudit({
    cases,
    dataDir: "unused-fixture-data-dir",
    expandedLimit: 32,
    env: {
      RAG_MAX_OFFICIAL_QA: "1",
      RAG_MAX_RELATED_EVIDENCE: "1",
      RAG_MAX_RULEBOOK_CANDIDATES: "1",
    },
    loadData: async () => ({
      cards: [],
      records: sourceRecords,
      qaRecords: [],
    }),
    extractCards: () => ({
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
    }),
    retrieveEvidence: async (options) => {
      retrievalArgumentExpectedKeys.push(...findExpectedKeyPaths(options));
      await options.ruleSearchQueryProvider({});
      const spec = specByQuestion.get(options.userQuery);
      assert.ok(spec, `unexpected retrieval query: ${options.userQuery}`);
      const expanded = Number(options.env?.RAG_MAX_OFFICIAL_QA) > 1;
      const visible = (
        (!expanded && ["prompt-omitted", "compaction-omitted", "model-visible-full"].includes(spec.id))
        || (expanded && spec.id === "retrieval-limited")
      );
      return evidenceBundle(visible ? [evidenceRecord(spec.evidenceId)] : []);
    },
    buildPrompt: (options) => {
      promptArgumentExpectedKeys.push(...findExpectedKeyPaths(options));
      const spec = specByQuestion.get(options.userQuery);
      assert.ok(spec, `unexpected prompt query: ${options.userQuery}`);
      const preparedVisible = ["compaction-omitted", "model-visible-full"].includes(spec.id);
      const serializedVisible = spec.id === "model-visible-full";
      const modelEvidence = evidenceBundle(
        preparedVisible ? [evidenceRecord(spec.evidenceId)] : [],
      );
      const allowedEvidenceIds = serializedVisible ? [spec.evidenceId] : [];
      return {
        modelEvidence,
        allowedEvidenceIds,
        prompt: JSON.stringify({
          evidence: evidenceBundle(serializedVisible ? [evidenceRecord(spec.evidenceId)] : []),
          allowedEvidenceIds,
        }),
        warnings: [],
        promptChars: serializedVisible ? 120 : 40,
        promptTruncated: false,
      };
    },
  });

  assert.equal(report.mode, PUBLIC_RAG_LINEAGE_MODE);
  assert.equal(report.integrityOk, true);
  assert.equal(report.caseCount, 6);
  assert.equal(report.expectedEvidenceCount, 6);
  assert.deepEqual(report.telemetry, {
    modelTransportHooksSupplied: 0,
    frozenRulePlanProviderCalls: 9,
    blockedNetworkAttempts: 0,
    baselineRetrievals: 6,
    expandedDiagnosticRetrievals: 3,
    noBlockedNetworkAttemptsObserved: true,
  });
  assert.deepEqual(retrievalArgumentExpectedKeys, []);
  assert.deepEqual(promptArgumentExpectedKeys, []);
  assert.equal(report.cases.every((item) => item.promptEvidenceAllowedIdsConsistent), true);
  assert.deepEqual(report.statusCounts, {
    [PUBLIC_RAG_LINEAGE_STATUSES.DATA_SOURCE_MISSING]: 1,
    [PUBLIC_RAG_LINEAGE_STATUSES.NOT_RECALLED]: 1,
    [PUBLIC_RAG_LINEAGE_STATUSES.RETRIEVAL_LIMITED]: 1,
    [PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_REFERENCE_OMITTED]: 1,
    [PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_COMPACTION_OMITTED]: 1,
    [PUBLIC_RAG_LINEAGE_STATUSES.MODEL_VISIBLE_FULL]: 1,
  });
  assert.deepEqual(
    Object.fromEntries(report.cases.map((item) => [
      item.id,
      item.evidence[0].firstFailureOrVisibility,
    ])),
    Object.fromEntries(FIXTURE_SPECS.map((item) => [item.id, item.expectedStatus])),
  );
});

test("runner exposes prompt integrity failures and distinguishes blocked fetch attempts", async () => {
  const specs = [
    { id: "allow-mismatch", question: "allow mismatch question", evidenceId: "qa-integrity-1" },
    { id: "parse-error", question: "parse error question", evidenceId: "qa-integrity-2" },
    { id: "phantom-allowed", question: "phantom allowed question", evidenceId: "qa-integrity-3" },
    { id: "visible-unallowed", question: "visible unallowed question", evidenceId: "qa-integrity-4" },
    { id: "damaged-marker", question: "damaged marker question", evidenceId: "qa-integrity-5" },
    { id: "missing-evidence", question: "missing evidence question", evidenceId: "qa-integrity-6" },
    { id: "missing-allowed", question: "missing allowed question", evidenceId: "qa-integrity-7" },
  ];
  const byQuestion = new Map(specs.map((item) => [item.question, item]));
  const records = specs.map((item) => evidenceRecord(item.evidenceId));
  const report = await runPublicRagEvidenceLineageAudit({
    cases: specs.map((item) => ({
      id: item.id,
      question: item.question,
      expectedEvidenceIds: [item.evidenceId],
    })),
    loadData: async () => ({ cards: [], records, qaRecords: [] }),
    extractCards: () => ({
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
    }),
    retrieveEvidence: async (options) => {
      await options.ruleSearchQueryProvider({});
      const spec = byQuestion.get(options.userQuery);
      if (spec.id === "parse-error") await options.fetchImpl("https://blocked.invalid/");
      return evidenceBundle([evidenceRecord(spec.evidenceId)]);
    },
    buildPrompt: ({ userQuery }) => {
      const spec = byQuestion.get(userQuery);
      const item = evidenceRecord(spec.evidenceId);
      const modelEvidence = evidenceBundle([item]);
      if (spec.id === "parse-error") {
        return {
          modelEvidence,
          allowedEvidenceIds: [item.id],
          prompt: "instructions\n{not-json",
          warnings: [],
        };
      }
      if (spec.id === "phantom-allowed") {
        const allowedEvidenceIds = [item.id, "phantom-evidence-id"];
        return {
          modelEvidence,
          allowedEvidenceIds,
          prompt: JSON.stringify({
            evidence: evidenceBundle([item]),
            allowedEvidenceIds,
          }),
          warnings: [],
        };
      }
      if (spec.id === "visible-unallowed") {
        return {
          modelEvidence,
          allowedEvidenceIds: [],
          prompt: JSON.stringify({
            evidence: evidenceBundle([item]),
            allowedEvidenceIds: [],
          }),
          warnings: [],
        };
      }
      if (spec.id === "damaged-marker") {
        return {
          modelEvidence,
          allowedEvidenceIds: [item.id],
          prompt: [
            "instructions",
            "本次用户问题、卡片原文与检索资料如下：",
            "{not-json",
            JSON.stringify({
              evidence: evidenceBundle([item]),
              allowedEvidenceIds: [item.id],
            }),
          ].join("\n"),
          warnings: [],
        };
      }
      if (spec.id === "missing-evidence") {
        return {
          modelEvidence,
          allowedEvidenceIds: [item.id],
          prompt: JSON.stringify({ allowedEvidenceIds: [item.id] }),
          warnings: [],
        };
      }
      if (spec.id === "missing-allowed") {
        return {
          modelEvidence,
          allowedEvidenceIds: [item.id],
          prompt: JSON.stringify({ evidence: evidenceBundle([item]) }),
          warnings: [],
        };
      }
      return {
        modelEvidence,
        allowedEvidenceIds: ["different-bundle-id"],
        prompt: JSON.stringify({
          evidence: evidenceBundle([item]),
          allowedEvidenceIds: [item.id],
        }),
        warnings: [],
      };
    },
  });

  assert.equal(report.integrityOk, false);
  assert.equal(report.telemetry.modelTransportHooksSupplied, 0);
  assert.equal(report.telemetry.frozenRulePlanProviderCalls, 7);
  assert.equal(report.telemetry.blockedNetworkAttempts, 1);
  assert.equal(report.telemetry.noBlockedNetworkAttemptsObserved, false);
  const casesById = new Map(report.cases.map((item) => [item.id, item]));
  assert.equal(casesById.get("allow-mismatch").integrityOk, false);
  assert.equal(casesById.get("allow-mismatch").promptAllowedIdsConsistent, false);
  assert.equal(casesById.get("allow-mismatch").promptEvidenceAllowedIdsConsistent, true);
  assert.equal(
    casesById.get("allow-mismatch").evidence[0].firstFailureOrVisibility,
    PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_ALLOWED_IDS_MISMATCH,
  );
  assert.equal(casesById.get("parse-error").integrityOk, false);
  assert.equal(casesById.get("parse-error").promptParseStatus, "parse_error");
  assert.equal(casesById.get("parse-error").promptEvidenceAllowedIdsConsistent, false);
  assert.equal(
    casesById.get("parse-error").evidence[0].firstFailureOrVisibility,
    PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_PARSE_ERROR,
  );
  for (const id of ["phantom-allowed", "visible-unallowed"]) {
    assert.equal(casesById.get(id).integrityOk, false);
    assert.equal(casesById.get(id).promptEvidenceAllowedIdsConsistent, false);
    assert.equal(casesById.get(id).promptAllowedIdsConsistent, false);
    assert.equal(
      casesById.get(id).evidence[0].firstFailureOrVisibility,
      PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_ALLOWED_IDS_MISMATCH,
    );
  }
  for (const id of ["damaged-marker", "missing-evidence", "missing-allowed"]) {
    assert.equal(casesById.get(id).integrityOk, false);
    assert.equal(casesById.get(id).promptParseStatus, "parse_error");
    assert.equal(casesById.get(id).promptEvidenceAllowedIdsConsistent, false);
    assert.equal(
      casesById.get(id).evidence[0].firstFailureOrVisibility,
      PUBLIC_RAG_LINEAGE_STATUSES.PROMPT_PARSE_ERROR,
    );
  }

  const exitCodes = [];
  await runRetrievalEvidenceLineageCli([
    "--dataset", "dataset.json",
    "--generations", "generations",
    "--expectations", "expectations.json",
    "--compact",
  ], {
    readFileImpl: async () => "[]",
    loadCases: async () => [],
    runAudit: async () => report,
    stdout: { write: () => {} },
    setExitCode: (value) => { exitCodes.push(value); },
  });
  assert.deepEqual(exitCodes, [1]);
});

test("CLI emits the report and sets a failing exit code when prompt integrity fails", async () => {
  let output = "";
  const exitCodes = [];
  const report = { mode: PUBLIC_RAG_LINEAGE_MODE, integrityOk: false, cases: [] };
  const returned = await runRetrievalEvidenceLineageCli([
    "--dataset", "dataset.json",
    "--generations", "generations",
    "--expectations", "expectations.json",
    "--compact",
  ], {
    readFileImpl: async () => "[]",
    loadCases: async () => [],
    runAudit: async () => report,
    stdout: { write: (value) => { output += value; } },
    setExitCode: (value) => { exitCodes.push(value); },
  });

  assert.equal(returned, report);
  assert.deepEqual(exitCodes, [1]);
  assert.deepEqual(JSON.parse(output), report);
});

test("lineage runner directly wires no model transport and contains no fixture-specific branches", async () => {
  const sources = await Promise.all([
    readFile(new URL("../scripts/lib/retrieval-evidence-lineage.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/retrieval-evidence-lineage.mjs", import.meta.url), "utf8"),
  ]);
  const productionText = sources.join("\n");
  const importSpecifiers = [
    ...productionText.matchAll(/from\s+["']([^"']+)["']/gu),
    ...productionText.matchAll(/import\s*\(\s*["']([^"']+)["']/gu),
  ].map((match) => match[1]);

  for (const specifier of importSpecifiers) {
    assert.doesNotMatch(specifier, /deepseek|openai|relay|provider/iu);
  }
  assert.doesNotMatch(productionText, /ZERO_MODEL_ZERO_NETWORK/u);
  for (const fixture of FIXTURE_SPECS) {
    assert.equal(productionText.includes(fixture.id), false, `must not special-case ${fixture.id}`);
    assert.equal(
      productionText.includes(fixture.evidenceId),
      false,
      `must not special-case ${fixture.evidenceId}`,
    );
  }
});

function evidenceRecord(id) {
  return {
    id,
    question: `official question for ${id}`,
    answer: `complete official evidence body for ${id}`,
    text: `complete official evidence body for ${id}`,
  };
}

function evidenceBundle(officialQaRelated) {
  return {
    cardTexts: [],
    userProvidedCardTexts: [],
    officialQaDirectCandidates: [],
    officialQaRelated,
    provisionalOfficialResponses: [],
    faqRelated: [],
    rawRelatedEvidence: [],
    rulebookCandidates: [],
    retrievalWarnings: [],
    debug: { candidateStages: {} },
  };
}

function findExpectedKeyPaths(value, prefix = "", seen = new WeakSet()) {
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (/^expected/iu.test(key)) paths.push(path);
    paths.push(...findExpectedKeyPaths(child, path, seen));
  }
  return paths;
}
