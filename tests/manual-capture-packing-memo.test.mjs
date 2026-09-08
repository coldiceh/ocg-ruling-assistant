import assert from "node:assert/strict";
import test from "node:test";

import { createManualCaptureRankedQueueEvidenceSelectionProvider } from "../scripts/lib/manual-capture-evidence-selection.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";

test("ranked queue serializes an identical rejected input only once and retries after selection changes", async () => {
  const records = [
    { id: "memo-a", recordType: "qa", official: true, question: "synthetic question a", text: "a".repeat(22000) },
    { id: "memo-b", recordType: "qa", official: true, question: "synthetic question b", text: "b".repeat(22000) },
    { id: "memo-c", recordType: "qa", official: true, question: "synthetic question c", text: "c".repeat(100) },
  ];
  const cardResolution = { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] };
  const retrievedEvidence = {
    cardTexts: [], userProvidedCardTexts: [], officialQaDirectCandidates: [],
    officialQaRelated: [], provisionalOfficialResponses: [], faqRelated: [],
    rawRelatedEvidence: [], ruleSearchQueries: [], retrievalWarnings: [],
  };
  const attempts = new Map();
  const proposals = [];
  const provider = createManualCaptureRankedQueueEvidenceSelectionProvider({
    resolveFrozenShortlist: async (input) => ({
      questionSha256: input.questionSha256,
      dataRevision: input.dataRevision,
      candidatePoolSha256: input.candidatePoolSha256,
      orderedCandidateBindings: input.candidates.map((candidate) => candidate.binding),
    }),
    generateInformationNeeds: async () => ({ informationNeeds: ["synthetic need one", "synthetic need two", "synthetic need three"] }),
    rankNeedCandidates: async ({ candidates }) => ({ results: candidates.map((candidate, index) => ({
      binding: candidate.binding, rank: index + 1, score: candidates.length - index,
    })) }),
  });
  const selected = await provider({
    caseId: "synthetic-packing", userQuery: "synthetic ruling question", dataRevision: "synthetic-revision",
    sourceData: { qaRecords: records }, cardResolution, retrievedEvidence,
    packEvidence: (evidence) => {
      const key = JSON.stringify(evidence);
      attempts.set(key, (attempts.get(key) || 0) + 1);
      proposals.push(evidence.officialQaRelated.map((item) => item.id));
      return buildRagRulingPromptBundle({
        userQuery: "synthetic ruling question", cardResolution, evidence, env: { RAG_MAX_PROMPT_CHARS: "36000" },
      });
    },
  });
  assert.deepEqual(selected.officialQaRelated.map((item) => item.id), ["memo-a", "memo-c"]);
  assert.equal(Math.max(...attempts.values()), 1, "identical serializer inputs must reuse their prior rejection");
  assert.deepEqual(proposals.filter((ids) => ids.includes("memo-b")), [
    ["memo-a", "memo-b"], ["memo-a", "memo-c", "memo-b"],
  ], "a changed selected prefix requires a fresh actual serialization");
  const packed = buildRagRulingPromptBundle({ userQuery: "synthetic ruling question", cardResolution, evidence: selected });
  assert.ok(packed.promptChars <= 36000);
  assert.equal(packed.promptTruncated, false);
  assert.equal(packed.warnings.includes("rag_prompt_compacted_to_max_chars"), false);
  assert.deepEqual(packed.allowedEvidenceIds, ["memo-a", "memo-c"]);
});
