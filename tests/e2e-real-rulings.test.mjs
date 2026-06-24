import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  answerQuestion,
  loadSnapshot,
  mergeModelAnswer,
  syncOnDemandData,
} from "../backend/engine.mjs";

const realQuestion = `被青眼暴君龙战破的卡通怪兽在伤判结束阶段发动盖放墓地陷阱卡效果的时候：
能用 完美世界-卡通世界 的效果除外该卡通怪兽吗？
卡通怪兽还会被战破送墓吗？
如果 青眼暴君龙 被战破的时候，这个效果是在墓地发动还是在场上发动？
这个时候 青眼暴君龙 是否已经送墓了吗？`;

test("minimal explicit graveyard state selects the graveyard activation branch", async () => {
  const answer = await answerQuestion(
    { question: "青眼暴君龙被战斗破坏并送去墓地后，这个效果是在墓地发动还是在场上发动？" },
    { useModel: false, onDemandSync: false }
  );
  const trace = buildLayeredTrace(answer, "q1");
  console.log(`CONDITION_BRANCH_TRACE graveyard ${JSON.stringify(trace)}`);
  assert.equal(answer.formalQuery.subQuestions[0].card, "青眼暴君龙");
  assert.equal(answer.formalQuery.subQuestions[0].type, "activation_location");
  assert.equal(trace.gameState.entities[0].wasDestroyedByBattle, true);
  assert.equal(trace.gameState.entities[0].wasSentToGraveyard, true);
  assert.equal(trace.gameState.entities[0].currentZone, "graveyard");
  assert.ok(trace.eventTimeline.events.some((item) => item.type === "sent_to_graveyard" && item.status === "completed"));
  assert.equal(trace.deriveStateAtTiming.zoneStatus, "in_graveyard");
  assert.equal(trace.branchSelectorResult.status, "selected");
  assert.equal(trace.branchSelectorResult.verdict, "activates_in_graveyard");
  assert.deepEqual(trace.missingConditions, []);
  assert.equal(answer.subAnswers[0].verdict, "activates_in_graveyard");
  assert.ok(trace.evidenceTrace.directEvidence.length > 0);
  assert.notEqual(trace.evidenceTrace.extractedVerdict, "unknown");
  assert.equal(answer.subAnswers[0].status, "confirmed");
});

test("minimal explicit banished state selects the banished activation branch", async () => {
  const answer = await answerQuestion(
    { question: "青眼暴君龙被战斗破坏并被除外后，这个效果在哪里发动？" },
    { useModel: false, onDemandSync: false }
  );
  const trace = buildLayeredTrace(answer, "q1");
  console.log(`CONDITION_BRANCH_TRACE banished ${JSON.stringify(trace)}`);
  assert.equal(answer.formalQuery.subQuestions[0].card, "青眼暴君龙");
  assert.equal(answer.formalQuery.subQuestions[0].type, "activation_location");
  assert.equal(trace.gameState.entities[0].wasBanished, true);
  assert.equal(trace.gameState.entities[0].currentZone, "banished");
  assert.ok(trace.eventTimeline.events.some((item) => item.type === "temporarily_banished" && item.status === "completed"));
  assert.equal(trace.deriveStateAtTiming.zoneStatus, "banished");
  assert.equal(trace.branchSelectorResult.status, "selected");
  assert.equal(trace.branchSelectorResult.verdict, "activates_while_banished");
  assert.deepEqual(trace.missingConditions, []);
  assert.equal(answer.subAnswers[0].verdict, "activates_while_banished");
  assert.ok(trace.evidenceTrace.directEvidence.length > 0);
  assert.notEqual(trace.evidenceTrace.extractedVerdict, "unknown");
  assert.equal(answer.subAnswers[0].status, "confirmed");
});

test("minimal unspecified post-destruction state remains unknown", async () => {
  const answer = await answerQuestion(
    { question: "青眼暴君龙被战斗破坏的时候，这个效果是在墓地发动还是在场上发动？" },
    { useModel: false, onDemandSync: false }
  );
  const trace = buildLayeredTrace(answer, "q1");
  console.log(`CONDITION_BRANCH_TRACE pending ${JSON.stringify(trace)}`);
  assert.ok(trace.eventTimeline.events.some((item) => item.type === "battle_destroyed"));
  assert.ok(trace.eventTimeline.events.some((item) => item.type === "pending_send_to_graveyard"));
  assert.equal(trace.eventTimeline.events.some((item) => item.type === "sent_to_graveyard" && item.status === "completed"), false);
  assert.ok(["missing_state", "ambiguous"].includes(trace.branchSelectorResult.status));
  assert.equal(answer.subAnswers[0].status, "unknown");
});

test("real ruling question stays structurally safe through the complete local pipeline", async () => {
  const answer = await answerQuestion(
    { question: realQuestion },
    { useModel: false, onDemandSync: false }
  );
  const questions = answer.formalQuery.subQuestions;
  const traces = answer.parserDebug.evidenceTrace;

  assert.equal(questions.length, 4);
  assert.deepEqual(questions.map((item) => [item.id, item.type, item.card]), [
    ["q1", "temporary_banish", "完美世界-卡通世界"],
    ["q2", "send_to_gy", "referenced_toon_monster"],
    ["q3", "activation_location", "青眼暴君龙"],
    ["q4", "location_change", "青眼暴君龙"],
  ]);

  for (const trace of traces) {
    if (trace.finalStatus === "confirmed") {
      assert.ok(trace.directEvidence.length > 0, `${trace.questionId} confirmed without direct evidence`);
      assert.notEqual(trace.extractedVerdict, "unknown", `${trace.questionId} confirmed with unknown verdict`);
      const subAnswer = answer.subAnswers.find((item) => item.questionId === trace.questionId);
      assert.ok(subAnswer.evidenceIds.length > 0, `${trace.questionId} confirmed without evidence IDs`);
    }
    if (trace.extractedVerdict === "unknown") assert.notEqual(trace.finalStatus, "confirmed");
  }

  const q1 = traces.find((item) => item.questionId === "q1");
  const q2 = traces.find((item) => item.questionId === "q2");
  const q3 = traces.find((item) => item.questionId === "q3");
  const q4 = traces.find((item) => item.questionId === "q4");
  assert.equal(q1.directEvidence.length, 0);
  assert.ok(q1.similarEvidence.length > 0 || q1.rejectedEvidence.length > 0);
  assert.equal(q1.extractedVerdict, "unknown");
  assert.notEqual(q1.finalStatus, "confirmed");
  assert.ok(q3.directEvidence.some((item) => item.id === "card-faq-16842-3"));
  assert.ok(answer.parserDebug.eventTimeline.events.some((item) => item.type === "battle_destroyed" && item.card === "青眼暴君龙"));
  assert.equal(q3.conditionBranches.length, 3);
  assert.equal(q3.branchSelector.status, "missing_state");
  assert.ok(q3.branchSelector.missingConditions.includes("sent_to_graveyard"));
  assert.ok(q3.branchSelector.missingConditions.includes("banished"));
  assert.equal(q3.extractedVerdict, "unknown");
  assert.notEqual(q3.finalStatus, "confirmed");
  assert.match(q3.reason, /missing_state|ambiguous/u);
  assert.equal(q3.deriveStateAtTiming.zoneStatus, "pending_send_to_graveyard");
  assert.match(q3.reason, /已识别战斗破坏，但未确认该时点是否已经完成送墓、是否被除外、或是否仍在场上/u);

  assert.ok(answer.parserDebug.dependencyGraph.edges.some((edge) => edge.fromQuestionId === "q1"
    && edge.toQuestionId === "q2"
    && edge.relation === "depends_on_verdict"));
  assert.ok(answer.parserDebug.dependencyGraph.edges.some((edge) => edge.fromQuestionId === "q3"
    && edge.toQuestionId === "q4"
    && edge.relation === "same_event_chain"));
  assert.notEqual(q2.finalStatus, "confirmed");
  assert.ok(q2.unresolvedDependencies.includes("q1"));
  assert.match(q2.reason, /依赖 q1 的结果，而 q1 当前无法确认/u);
  assert.equal(q4.derivedState.zoneStatus, "pending_send_to_graveyard");
  assert.notEqual(q4.finalStatus, "confirmed");
  for (const state of answer.parserDebug.transitionRules.derivedStates) {
    if (["heuristic", "manual_rule"].includes(state.ruleSource?.sourceType)) assert.notEqual(state.status, "confirmed");
  }

  const programAnswer = answer.subAnswers.find((item) => item.questionId === "q3");
  const merged = mergeModelAnswer(
    { status: "confirmed", verdict: "activates_in_graveyard", evidenceIds: ["fake"], explanationText: "模型解释" },
    programAnswer
  );
  assert.equal(merged.status, programAnswer.status);
  assert.equal(merged.verdict, programAnswer.verdict);
  assert.deepEqual(merged.evidenceIds, programAnswer.evidenceIds);
});

test("real FAQ selects the field branch when the monster remains in its zone", async () => {
  const answer = await answerQuestion(
    { question: `青眼暴君龙没有被战斗破坏，仍在怪兽区。\n${realQuestion}` },
    { useModel: false, onDemandSync: false }
  );
  const q3 = answer.parserDebug.evidenceTrace.find((item) => item.questionId === "q3");
  assert.equal(q3.branchSelector.status, "selected");
  assert.equal(q3.deriveStateAtTiming.zoneStatus, "on_field");
  assert.equal(q3.extractedVerdict, "activates_on_field");
  assert.equal(q3.finalVerdict, "activates_on_field");
});

test("real FAQ selects the graveyard branch after battle destruction sends the monster there", async () => {
  const answer = await answerQuestion(
    { question: `青眼暴君龙被战斗破坏并送去墓地。\n${realQuestion}` },
    { useModel: false, onDemandSync: false }
  );
  const q3 = answer.parserDebug.evidenceTrace.find((item) => item.questionId === "q3");
  assert.equal(q3.branchSelector.status, "selected");
  assert.equal(q3.deriveStateAtTiming.zoneStatus, "in_graveyard");
  assert.equal(q3.extractedVerdict, "activates_in_graveyard");
  assert.equal(q3.finalVerdict, "activates_in_graveyard");
});

test("real FAQ selects the banished branch after battle destruction banishes the monster", async () => {
  const answer = await answerQuestion(
    { question: `青眼暴君龙被战破并被除外。\n${realQuestion}` },
    { useModel: false, onDemandSync: false }
  );
  const q3 = answer.parserDebug.evidenceTrace.find((item) => item.questionId === "q3");
  assert.equal(q3.branchSelector.status, "selected");
  assert.equal(q3.deriveStateAtTiming.zoneStatus, "banished");
  assert.equal(q3.extractedVerdict, "activates_while_banished");
  assert.equal(q3.finalVerdict, "activates_while_banished");
});

test("on-demand sync persists card, FAQ/Q&A, and rebuilt indexes with cache", async () => {
  const dataDir = await makeHealthyDataDir();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async (url) => {
    fetchCount += 1;
    const target = String(url);
    if (target.includes("/data/idx/card/name/en")) return jsonResponse({ "Test New Card": "99999" });
    if (target.endsWith("/data/card/99999")) {
      return jsonResponse({
        cardData: {
          en: { name: "Test New Card", effectText: "Test effect." },
          ja: { name: "テスト新カード", effectText: "テスト効果。" },
        },
        faqData: {
          entries: {
            1: [{ en: "During resolution, you can banish the target until that effect resolves." }],
          },
          meta: { en: { date: "2026-01-01" } },
        },
        qaIndex: [{ id: "77777" }],
      });
    }
    if (target.endsWith("/data/qa/77777")) {
      return jsonResponse({
        question: { en: "Can Test New Card banish the target during resolution?" },
        answer: { en: "Yes, it can banish that target until the effect resolves." },
      });
    }
    throw new Error(`unexpected URL: ${target}`);
  };

  try {
    const snapshot = await loadSnapshot(dataDir);
    const detectedCards = [{ name: "Test New Card", matched: "Test New Card", aliases: ["Test New Card"] }];
    const first = await syncOnDemandData({
      detectedCards,
      snapshot,
      dataDir,
      env: { CARD_RESOLUTION_LANGUAGES: "en", LIVE_QA_PER_CARD: "5", LIVE_QA_TOTAL: "5" },
    });
    const countAfterFirst = fetchCount;

    assert.equal(first.status, "synced");
    assert.equal(first.persisted, true);
    assert.ok(first.syncedCardIds.includes("99999"));
    assert.ok(first.syncedEvidenceIds.some((id) => id === "card-faq-99999-1"));
    assert.ok(first.syncedEvidenceIds.some((id) => id === "ygoresources-qa-77777"));

    const cardsPayload = JSON.parse(await readFile(join(dataDir, "cards.json"), "utf8"));
    const rulingsPayload = JSON.parse(await readFile(join(dataDir, "rulings.json"), "utf8"));
    const aliasesPayload = JSON.parse(await readFile(join(dataDir, "card-alias-index.json"), "utf8"));
    const qaIndexPayload = JSON.parse(await readFile(join(dataDir, "qa-index.json"), "utf8"));
    assert.ok(cardsPayload.records.some((item) => String(item.id) === "99999"));
    assert.ok(rulingsPayload.records.some((item) => item.id === "card-faq-99999-1"));
    assert.ok(aliasesPayload.records.some((item) => item.cardId === "99999"));
    assert.ok(qaIndexPayload.records.some((item) => item.id === "ygoresources-qa-77777"));

    const second = await syncOnDemandData({ detectedCards, snapshot, dataDir, env: { CARD_RESOLUTION_LANGUAGES: "en" } });
    assert.equal(second.cacheHit, true);
    assert.equal(fetchCount, countAfterFirst);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("on-demand sync exposes live_source_unavailable", async () => {
  const dataDir = await makeHealthyDataDir();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline fixture"); };
  try {
    const snapshot = await loadSnapshot(dataDir);
    const result = await syncOnDemandData({
      detectedCards: [{ name: "Offline Card", matched: "Offline Card", aliases: ["Offline Card"] }],
      snapshot,
      dataDir,
      env: { CARD_RESOLUTION_LANGUAGES: "offline-fixture" },
    });
    assert.equal(result.status, "live_source_unavailable");
    assert.ok(result.warnings.includes("live_source_unavailable"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function makeHealthyDataDir() {
  const dataDir = await mkdtemp(join(tmpdir(), "on-demand-sync-"));
  const card = { id: "card-a", name: "测试卡A", aliases: ["测试卡A"] };
  const qa = { id: "qa-a", recordType: "qa", title: "基础问答", question: "测试？", conclusion: "可以。", cards: ["测试卡A"] };
  const faq = { id: "faq-a", recordType: "card-faq", title: "基础 FAQ", conclusion: "可以。", cards: ["测试卡A"] };
  await Promise.all([
    writeJson(join(dataDir, "cards.json"), { records: [card] }),
    writeJson(join(dataDir, "cards-lite.json"), { records: [card] }),
    writeJson(join(dataDir, "rulings.json"), { records: [qa, faq] }),
    writeJson(join(dataDir, "card-alias-index.json"), { records: [{ alias: "测试卡A", cardId: "card-a", cardName: "测试卡A" }] }),
    writeJson(join(dataDir, "qa-index.json"), { records: [{ id: "qa-a", recordType: "qa" }, { id: "faq-a", recordType: "card-faq" }] }),
    writeJson(join(dataDir, "snapshot-meta.json"), { generatedAt: new Date().toISOString(), sources: [] }),
    writeJson(join(dataDir, "ocg-rule-corpus.json"), { records: [] }),
    writeJson(join(dataDir, "ocg-rule-tests.json"), { records: [] }),
  ]);
  return dataDir;
}

function jsonResponse(payload) {
  return { ok: true, status: 200, statusText: "OK", json: async () => payload };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildLayeredTrace(answer, questionId) {
  const evidenceTrace = answer.parserDebug.evidenceTrace.find((item) => item.questionId === questionId);
  const subQuestion = answer.formalQuery.subQuestions.find((item) => item.id === questionId);
  const entity = answer.parserDebug.gameState.entities.find((item) => item.name === subQuestion.card) || null;
  return {
    formalQuery: answer.formalQuery,
    gameState: { entities: answer.parserDebug.gameState.entities },
    eventTimeline: {
      events: answer.parserDebug.eventTimeline.events,
      pendingTransitions: answer.parserDebug.eventTimeline.pendingTransitions,
    },
    deriveStateAtTiming: evidenceTrace.deriveStateAtTiming,
    conditionBranches: evidenceTrace.conditionBranches,
    branchSelectorInput: { subQuestion, entity, derivedStateAtTiming: evidenceTrace.deriveStateAtTiming },
    branchSelectorResult: evidenceTrace.branchSelector,
    missingConditions: evidenceTrace.branchSelector?.missingConditions || [],
    evidenceTrace: {
      directEvidence: evidenceTrace.directEvidence,
      extractedVerdict: evidenceTrace.extractedVerdict,
      finalStatus: evidenceTrace.finalStatus,
      finalVerdict: evidenceTrace.finalVerdict,
      reason: evidenceTrace.reason,
    },
  };
}
