import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evidenceBucketsToList,
  loadRagData,
  retrieveRagEvidence,
} from "../backend/ragEvidenceRetriever.mjs";
import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import {
  buildAdminEvidenceDecisionPacket,
  createAdminEvidenceArchive,
} from "../backend/adminEvidenceArchive.mjs";

const evaluationCorpus = JSON.parse(await readFile(
  new URL("../data/test/admin-model-lab-evaluations.json", import.meta.url),
  "utf8",
));

test("high-value local evidence is ranked ahead of weak same-card matches without fixed production ids", async (t) => {
  const data = await loadRagData();
  const diagnostics = [];

  for (const evaluationCase of evaluationCorpus.cases) {
    const cardResolution = extractRagCards(evaluationCase.question, {
      cards: data.cards,
      maxCards: data.cards.length,
    });
    const evidence = await retrieveRagEvidence({
      userQuery: evaluationCase.question,
      cardResolution,
      cards: data.cards,
      records: data.records,
      qaRecords: data.qaRecords,
      enableLiveOfficialQa: false,
      maxPerBucket: 32,
      env: {
        RAG_LIVE_OFFICIAL_QA: "false",
        RAG_MAX_OFFICIAL_QA: "32",
        RAG_MAX_RELATED_EVIDENCE: "64",
        RAG_MAX_RULEBOOK_CANDIDATES: "64",
      },
      fetchImpl: async () => {
        throw new Error("offline priority test must not call the network");
      },
    });
    const officialCandidates = [
      ...(evidence.officialQaDirectCandidates || []),
      ...(evidence.officialQaRelated || []),
    ];
    const faqCandidates = evidence.faqRelated || [];
    const allCandidates = evidenceBucketsToList(evidence);
    const archive = createAdminEvidenceArchive({
      evidenceBuckets: evidence,
      retrievalWarnings: evidence.retrievalWarnings || [],
    });
    const packet = buildAdminEvidenceDecisionPacket({ archive });
    const expectedEvidenceMaxRank = Number.isInteger(evaluationCase.expectedEvidenceMaxRank)
      ? evaluationCase.expectedEvidenceMaxRank
      : 5;

    for (const expectedId of evaluationCase.expectedEvidenceIds || []) {
      const bucket = expectedId.startsWith("card-faq-") ? faqCandidates : officialCandidates;
      const highValueRank = bucket.findIndex((item) => item.id === expectedId);
      const allRank = allCandidates.findIndex((item) => item.id === expectedId);
      const candidate = bucket[highValueRank];
      const archiveOccurrences = archive.occurrences.filter(
        (occurrence) => occurrence.evidenceId === expectedId,
      );
      const includedManifestEntry = packet.includedManifest.find(
        (entry) => entry.evidenceIds.includes(expectedId),
      );
      const omittedManifestEntry = packet.omittedManifest.find(
        (entry) => entry.evidenceIds.includes(expectedId),
      );
      const packetItem = includedManifestEntry
        ? packet.modelPacket.evidenceItems.find(
            (item) => item.packetItemId === includedManifestEntry.packetItemId,
          )
        : null;
      assert.notEqual(
        highValueRank,
        -1,
        `${evaluationCase.id}: ${expectedId} must survive into a high-value QA/FAQ bucket`,
      );
      assert.ok(
        highValueRank < expectedEvidenceMaxRank,
        `${evaluationCase.id}: ${expectedId} must rank within the declared high-value candidate window ${expectedEvidenceMaxRank} (rank ${highValueRank})`,
      );
      assert.notEqual(allRank, -1, `${evaluationCase.id}: ${expectedId} must survive flattened evidence`);
      assert.ok(
        includedManifestEntry,
        `${evaluationCase.id}: ${expectedId} must reach the bounded final-model packet`,
      );
      if (expectedId !== "ygoresources-qa-24189") {
        assert.notEqual(
          candidate?.isDirect,
          true,
          `${evaluationCase.id}: partial supporting evidence must not be promoted to direct official`,
        );
      }
      diagnostics.push({
        caseId: evaluationCase.id,
        evidenceId: expectedId,
        highValueRank,
        allRank,
        type: candidate?.type,
        matchLevel: candidate?.matchLevel,
        score: candidate?.score,
        matchedBy: candidate?.matchedBy,
        archiveOccurrences: archiveOccurrences.map((occurrence) => ({
          evidenceId: occurrence.evidenceId,
          category: occurrence.category,
          authority: occurrence.authority,
          direct: occurrence.direct,
          relevanceScore: occurrence.relevanceScore,
          collection: occurrence.collection,
          collectionRank: occurrence.index,
          substanceHash: occurrence.substanceHash,
        })),
        includedEvidenceIds: includedManifestEntry?.evidenceIds || [],
        packetRepresentativeEvidenceId: packetItem?.evidenceId || "",
        omittedReason: omittedManifestEntry?.reason || "",
      });
    }
  }

  t.diagnostic(JSON.stringify(diagnostics));
});
