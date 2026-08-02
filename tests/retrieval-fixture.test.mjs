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
      askedResult: "can_banish_referenced_monster",
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
  assert.ok(trace.searchQueries.includes("Perfect Toon World temporarily banish return"));
  assert.ok(trace.searchQueries.includes("完全なる世界 トゥーン・ワールド 一時的に除外 戻る"));
  assert.equal(trace.searchQueries.includes("Toon World banish toon monster"), false);
  assert.equal(trace.searchQueries.includes("トゥーン ワールド 除外 トゥーン"), false);
});

test("referenced monster retrieval uses the described entity but remains unknown without a canonical card", () => {
  const qa = {
    id: "qa-anonymous-referenced-monster",
    recordType: "qa",
    title: "匿名怪兽临时除外处理",
    question: "另一个效果处理时，可以将该机械族怪兽暂时除外到那个效果处理后吗？",
    conclusion: "可以将该机械族怪兽暂时除外，并在那个效果处理后返回。",
    cards: [],
    keywords: ["临时除外", "机械族怪兽", "返回"],
    sources: [{ label: "fixture QA", detail: "anonymous-referenced-monster" }],
  };
  const query = normalizeFormalRulingQuery({
    originalText: "另一个效果处理时，能否把该机械族怪兽暂时除外？",
    cards: [],
    scenario: { rawContext: "", turnPlayer: "unknown", phase: "unknown", chainState: "unknown", events: [] },
    subQuestions: [{
      id: "q1",
      type: "temporary_banish",
      card: "referenced_machine_monster",
      askedResult: "can_banish_referenced_monster",
      sourceText: "另一个效果处理时，能否把该机械族怪兽暂时除外？",
    }],
  });

  const evidence = retrieveEvidenceByFormalQuery(query, [], { records: [qa] });
  const bucket = evidence.bySubQuestion[0];
  const trace = bucket.retrievalTrace;

  assert.ok(trace.searchQueries.includes("机械族怪兽 效果处理 除外"));
  assert.equal(trace.searchQueries.some((item) => /卡通|トゥーン|toon/iu.test(item)), false);
  assert.deepEqual(trace.rawCandidateEvidence, []);
  assert.deepEqual(trace.classifiedEvidence.direct, []);
  assert.equal(trace.evidenceCoverageReason, "card_resolution_failed");
});
