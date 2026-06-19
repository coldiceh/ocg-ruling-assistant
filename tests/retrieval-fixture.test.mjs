import assert from "node:assert/strict";
import test from "node:test";
import { retrieveEvidenceByFormalQuery } from "../backend/engine.mjs";
import { normalizeFormalRulingQuery } from "../backend/formalQuery.mjs";

test("the real retrieval pipeline recalls and accepts a matching temporary-banish fixture", () => {
  const card = {
    id: "perfect-toon-world",
    name: "完美世界-卡通世界",
    cnName: "完美世界-卡通世界",
    jaName: "完全なる世界 トゥーン・ワールド",
    enName: "Perfect Toon World",
    aliases: ["完美世界 卡通世界", "Toon World", "トゥーン・ワールド"],
  };
  const qa = {
    id: "qa-perfect-toon-world-retrieval-fixture",
    recordType: "card-faq",
    title: "完美世界-卡通世界的效果处理",
    question: "能用「完美世界-卡通世界」的效果，在效果处理时除外该卡通怪兽吗？",
    conclusion: "可以。在效果处理时，可以将该卡通怪兽暂时除外。",
    cards: ["完美世界-卡通世界"],
    cardIds: ["perfect-toon-world"],
    keywords: ["效果处理时除外", "卡通怪兽", "暂时除外", "可以"],
    sources: [{ label: "fixture QA", detail: "qa-perfect-toon-world-retrieval-fixture" }],
  };
  const query = normalizeFormalRulingQuery({
    originalText: "能用完美世界-卡通世界的效果除外该卡通怪兽吗？",
    cards: [{ name: card.name, role: "question_card", controller: "unknown", zone: "unknown" }],
    scenario: { rawContext: "", turnPlayer: "unknown", phase: "unknown", chainState: "unknown", events: [] },
    subQuestions: [{
      id: "q1",
      type: "temporary_banish",
      card: card.name,
      askedResult: "can_banish_that_toon_monster",
      sourceText: "能用完美世界-卡通世界的效果除外该卡通怪兽吗？",
    }],
  });

  const evidence = retrieveEvidenceByFormalQuery(query, [card], { records: [qa] });
  const bucket = evidence.bySubQuestion[0];
  const trace = bucket.retrievalTrace;

  assert.ok(trace.rawCandidateEvidence.some((item) => item.id === qa.id));
  assert.deepEqual(trace.classifiedEvidence.direct, [qa.id]);
  assert.deepEqual(bucket.rulingEvidence.map((item) => item.evidenceId), [qa.id]);
  assert.equal(trace.evidenceCoverageReason, "direct_evidence_found");
  assert.ok(trace.searchQueries.includes("完美世界-卡通世界 除外 卡通怪兽"));
  assert.ok(trace.searchQueries.includes("完美世界 卡通世界 效果处理 除外"));
  assert.ok(trace.searchQueries.includes("Toon World banish toon monster"));
  assert.ok(trace.searchQueries.includes("トゥーン ワールド 除外 トゥーン"));
});
