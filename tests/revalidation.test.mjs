import assert from "node:assert/strict";
import test from "node:test";
import { revalidateAnswers } from "../scripts/revalidate-answers.mjs";

test("revalidate unchanged when no direct evidence is found", async () => {
  const report = await revalidateAnswers({
    history: { records: [historyItem()] },
    cards: cardsFixture(),
    records: [],
  });
  assert.equal(report.reports[0].lastRevalidationResult, "unchanged");
  assert.equal(report.reports[0].newStatus, "unknown");
});

test("revalidate upgrades to confirmed when official Q&A fixture passes final gate", async () => {
  const report = await revalidateAnswers({
    history: { records: [historyItem()] },
    cards: cardsFixture(),
    records: [directAlbazDbQa()],
  });
  assert.equal(report.reports[0].lastRevalidationResult, "upgraded_to_confirmed");
  assert.equal(report.reports[0].newStatus, "confirmed");
  assert.equal(report.reports[0].changedReason, "official_database_direct_evidence_found");
  assert.deepEqual(report.reports[0].newEvidenceIds, ["official-qa-albaz-quem-direct"]);
});

test("revalidate live timeout does not hang", async () => {
  const startedAt = Date.now();
  const report = await revalidateAnswers({
    history: { records: [historyItem()] },
    cards: cardsFixture(),
    records: [],
    useLive: true,
    timeoutMs: 5,
    fetcher: () => new Promise((resolve) => setTimeout(resolve, 50)),
  });
  assert.equal(report.reports[0].lastRevalidationResult, "live_source_timeout");
  assert.ok(Date.now() - startedAt < 200);
});

test("AI explanation text is ignored during revalidation", async () => {
  const item = {
    ...historyItem(),
    explanationText: "模型声称可以 confirmed。",
    modelVerdict: "can",
  };
  const report = await revalidateAnswers({
    history: { records: [item] },
    cards: cardsFixture(),
    records: [],
  });
  assert.equal(report.reports[0].lastRevalidationResult, "unchanged");
  assert.equal(report.reports[0].newStatus, "unknown");
});

test("final gate still controls confirmed during revalidation", async () => {
  const report = await revalidateAnswers({
    history: { records: [historyItem()] },
    cards: cardsFixture(),
    records: [questionOnlyQa()],
  });
  assert.notEqual(report.reports[0].newStatus, "confirmed");
  assert.notEqual(report.reports[0].lastRevalidationResult, "upgraded_to_confirmed");
});

function historyItem() {
  return {
    id: "history-albaz-001",
    originalText: "アルバスの落胤①効果を発動できるか。",
    formalQuery: formalQueryFixture(),
    watchCardIds: [22090, 16493],
    watchTerms: ["アルバスの落胤", "導きの聖女エクレシア", "聖痕喰らいし竜", "融合素材", "コスト", "処理は何も行われません"],
    finalStatus: "unknown",
    finalVerdict: "unknown",
    unknownReasons: ["provisional_official_response"],
    provisionalAnswer: {
      status: "provisional_official_response",
      sourceType: "official_response_screenshot",
      verdict: {
        activation: "can_activate",
        cost: "can_pay_cost",
        resolution: "does_not_perform_fusion_material_processing",
      },
    },
    usedEvidenceIds: [],
    createdAt: "2026-06-26T00:00:00.000Z",
    lastEvaluatedAt: "2026-06-26T00:00:00.000Z",
  };
}

function formalQueryFixture() {
  return {
    originalText: "アルバスの落胤①効果を発動できるか。",
    cards: [
      { name: "アルバスの落胤", role: "question_card" },
      { name: "導きの聖女エクレシア", role: "cost_card" },
    ],
    scenario: {
      rawContext: "自分のEXデッキに氷剣竜ミラジェイドが存在し、手札に導きの聖女エクレシアとアルバスの落胤があり、相手フィールドに表側表示の聖痕喰らいし竜のみ存在する。",
      events: [],
      chainState: "unknown",
    },
    subQuestions: [{
      id: "q1",
      type: "activation_condition",
      card: "アルバスの落胤",
      askedResult: "can_activate_pay_cost_and_skip_fusion_material_processing",
      sourceText: "アルバスの落胤①効果を発動できるか。",
    }],
  };
}

function cardsFixture() {
  return [
    {
      id: "22090",
      name: "アルバスの落胤",
      jaName: "アルバスの落胤",
      aliases: ["アルバスの落胤"],
    },
    {
      id: "16493",
      name: "導きの聖女エクレシア",
      jaName: "導きの聖女エクレシア",
      aliases: ["導きの聖女エクレシア"],
    },
    {
      id: "999103",
      name: "聖痕喰らいし竜",
      jaName: "聖痕喰らいし竜",
      aliases: ["聖痕喰らいし竜"],
    },
  ];
}

function directAlbazDbQa() {
  return {
    id: "official-qa-albaz-quem-direct",
    recordType: "qa",
    sourceType: "official_qa",
    title: "アルバスの落胤①の効果処理",
    question: "自分のEXデッキに氷剣竜ミラジェイドが存在し、手札に導きの聖女エクレシアとアルバスの落胤があり、相手フィールドに表側表示の聖痕喰らいし竜のみ存在する場合、導きの聖女エクレシアをコストとして墓地へ送り、アルバスの落胤①の効果を発動できますか。",
    conclusion: "その場合、「アルバスの落胤」①の効果を発動できます。手札の「導きの聖女エクレシア」をコストとして墓地へ送り、EXデッキとフィールドのカードを確認したうえで、融合素材の処理は何も行われません。",
    cards: ["アルバスの落胤", "導きの聖女エクレシア"],
    cardIds: ["22090", "16493"],
    keywords: ["activation_condition", "cost", "fusion_material", "resolution_handling"],
  };
}

function questionOnlyQa() {
  return {
    ...directAlbazDbQa(),
    id: "official-qa-question-only",
    conclusion: "「アルバスの落胤」①の効果を発動できますか？",
  };
}
