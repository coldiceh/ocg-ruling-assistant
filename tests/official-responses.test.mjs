import assert from "node:assert/strict";
import test from "node:test";
import { answerEachSubQuestion, mergeModelAnswer, retrieveEvidenceByFormalQuery } from "../backend/engine.mjs";
import { normalizeOfficialResponses } from "../backend/officialResponses.mjs";
import { revalidateOfficialResponses } from "../scripts/revalidate-official-responses.mjs";

const cards = [
  {
    id: "999001",
    name: "吞食圣痕之龙",
    cnName: "吞食圣痕之龙",
    jaName: "深淵竜アルバ・レナトゥス",
    enName: "Bystial Alba Los",
    aliases: ["吞食圣痕之龙", "吞喰圣痕之龙", "深淵竜アルバ・レナトゥス"],
  },
  {
    id: "999002",
    name: "白之圣女 艾克莉西娅",
    cnName: "白之圣女 艾克莉西娅",
    jaName: "白の聖女エクレシア",
    enName: "Incredible Ecclesia, the Virtuous",
    aliases: ["白之圣女 艾克莉西娅", "白之圣女 艾克利西亚", "白の聖女エクレシア"],
  },
];

const formalQuery = {
  originalText: "吞食圣痕之龙③没有适用时，白之圣女艾克莉西娅能作为cost发动并继续作为融合素材处理吗？",
  cards: [
    { name: "吞食圣痕之龙", role: "question_card" },
    { name: "白之圣女 艾克莉西娅", role: "cost_card" },
  ],
  scenario: {
    rawContext: "吞食圣痕之龙③效果未适用。",
    events: [],
    chainState: "unknown",
  },
  subQuestions: [{
    id: "q1",
    type: "activation_condition",
    card: "吞食圣痕之龙",
    askedResult: "can_activate_pay_cost_and_skip_fusion_material_processing",
    sourceText: "吞食圣痕之龙③没有适用时，白之圣女艾克莉西娅能作为cost发动并继续作为融合素材处理吗？",
  }],
};

test("traceable official_response can confirm only through direct evidence and explicit askedResult", () => {
  const answer = runOfficialResponseCase(traceableOfficialResponse())[0];
  assert.equal(answer.status, "confirmed");
  assert.deepEqual(answer.evidenceIds, ["official-response-alba-ecclesia"]);
  assert.equal(answer.verdict.activation, "can_activate");
  assert.equal(answer.verdict.cost, "can_pay_cost");
  assert.equal(answer.verdict.resolution, "does_not_perform_fusion_material_processing");
});

test("official_response_unverified cannot confirm", () => {
  const answer = runOfficialResponseCase({
    ...traceableOfficialResponse(),
    id: "unverified-player-retelling",
    sourceType: "official_response_unverified",
    sourceNote: "",
    officialText: "",
    explanation: "玩家转述：可以发动。",
    maxStatus: "unknown",
  })[0];
  assert.equal(answer.status, "unknown");
  assert.equal(answer.verdict, "unknown");
  assert.equal(answer.evidenceIds.length, 0);
});

test("pending_adjustment cannot confirm", () => {
  const answer = runOfficialResponseCase({
    ...traceableOfficialResponse(),
    id: "pending-adjustment-alba-ecclesia",
    sourceType: "pending_adjustment",
    verdict: "unknown",
    explanation: "调整中。",
    maxStatus: "unknown",
  })[0];
  assert.equal(answer.status, "unknown");
  assert.equal(answer.verdict, "unknown");
});

test("player retelling does not enter official directEvidence", () => {
  const records = normalizeOfficialResponses([{
    ...traceableOfficialResponse(),
    id: "player-retelling-only",
    sourceType: "official_response_unverified",
    sourceNote: "",
    officialText: "",
    explanation: "玩家整理：可以发动。",
    maxStatus: "unknown",
  }]);
  const evidence = retrieveEvidenceByFormalQuery(formalQuery, cards, { records });
  assert.equal(evidence.bySubQuestion[0].rulingEvidence.length, 0);
});

test("official_response cannot bypass final gate with an invalid evidence id", () => {
  const [record] = normalizeOfficialResponses([traceableOfficialResponse()]);
  const evidence = {
    bySubQuestion: [{
      subQuestionId: "q1",
      rulingEvidence: [{ ...record, evidenceId: "missing-official-response-id" }],
      similarRulingEvidence: [],
      cardTextEvidence: [],
      rejectedEvidence: [],
    }],
  };
  const [answer] = answerEachSubQuestion(formalQuery, evidence, { records: [record] });
  assert.equal(answer.status, "unknown");
  assert.equal(answer.verdict, "unknown");
  assert.ok(answer.warnings.includes("invalid_direct_evidence"));
});

test("complex official verdict preserves activation, cost, and resolution", () => {
  const answer = runOfficialResponseCase(traceableOfficialResponse())[0];
  assert.equal(typeof answer.verdict, "object");
  assert.equal(answer.verdict.activation, "can_activate");
  assert.equal(answer.verdict.cost, "can_pay_cost");
  assert.equal(answer.verdict.resolution, "does_not_perform_fusion_material_processing");
  assert.notEqual(answer.verdict, "can");
});

test("AI explanation cannot override official structured verdict", () => {
  const programAnswer = runOfficialResponseCase(traceableOfficialResponse())[0];
  const merged = mergeModelAnswer(
    {
      status: "confirmed",
      verdict: "cannot",
      evidenceIds: ["fake"],
      explanationText: "模型解释",
    },
    programAnswer
  );
  assert.deepEqual(merged.verdict, programAnswer.verdict);
  assert.deepEqual(merged.evidenceIds, programAnswer.evidenceIds);
  assert.ok(merged.warnings.includes("model_status_or_verdict_ignored"));
});

test("official_response_screenshot hit generates provisionalAnswer but cannot confirm", () => {
  const records = normalizeOfficialResponses([screenshotOfficialResponse()]);
  const evidence = retrieveEvidenceByFormalQuery(albazFormalQuery, albazCards, { records });
  assert.equal(evidence.bySubQuestion[0].rulingEvidence.length, 0);
  assert.equal(evidence.bySubQuestion[0].provisionalEvidence.length, 1);

  const [answer] = answerEachSubQuestion(albazFormalQuery, evidence, { records });
  assert.equal(answer.status, "unknown");
  assert.equal(answer.verdict, "unknown");
  assert.equal(answer.provisionalAnswer.status, "provisional_official_response");
  assert.equal(answer.provisionalAnswer.sourceType, "official_response_screenshot");
  assert.equal(answer.provisionalAnswer.verdict.activation, "can_activate");
  assert.equal(answer.provisionalAnswer.verdict.cost, "can_pay_cost");
  assert.equal(answer.provisionalAnswer.verdict.resolution, "does_not_perform_fusion_material_processing");
  assert.equal(answer.provisionalAnswer.watchOfficialDb, true);
});

test("official_qa direct evidence takes priority over provisional screenshot", () => {
  const records = [
    ...normalizeOfficialResponses([screenshotOfficialResponse()]),
    directAlbazDbQa(),
  ];
  const evidence = retrieveEvidenceByFormalQuery(albazFormalQuery, albazCards, { records });
  const [answer] = answerEachSubQuestion(albazFormalQuery, evidence, { records });
  assert.equal(answer.status, "confirmed");
  assert.notEqual(answer.verdict, "unknown");
  assert.deepEqual(answer.evidenceIds, ["official-qa-albaz-quem-direct"]);
  assert.equal(answer.provisionalAnswer, undefined);
});

test("revalidate official response reports not_found when no direct DB evidence exists", async () => {
  const report = await revalidateOfficialResponses({
    officialResponses: [screenshotOfficialResponse()],
    records: [],
  });
  assert.equal(report.checkedCount, 1);
  assert.equal(report.reports[0].lastResult, "not_found");
  assert.equal(report.reports[0].newStatus, "unknown");
});

test("revalidate official response reports found_direct_qa for direct DB fixture", async () => {
  const report = await revalidateOfficialResponses({
    officialResponses: [screenshotOfficialResponse()],
    records: [directAlbazDbQa()],
  });
  assert.equal(report.reports[0].lastResult, "found_direct_qa");
  assert.equal(report.reports[0].newStatus, "confirmed");
  assert.equal(report.reports[0].newEvidenceId, "official-qa-albaz-quem-direct");
});

test("revalidate live timeout does not hang", async () => {
  const startedAt = Date.now();
  const report = await revalidateOfficialResponses({
    officialResponses: [screenshotOfficialResponse()],
    records: [],
    useLive: true,
    timeoutMs: 5,
    fetcher: () => new Promise((resolve) => setTimeout(resolve, 50)),
  });
  assert.equal(report.reports[0].lastResult, "live_source_timeout");
  assert.ok(Date.now() - startedAt < 200);
});

test("AI explanation cannot turn provisional answer into confirmed", () => {
  const records = normalizeOfficialResponses([screenshotOfficialResponse()]);
  const evidence = retrieveEvidenceByFormalQuery(albazFormalQuery, albazCards, { records });
  const [programAnswer] = answerEachSubQuestion(albazFormalQuery, evidence, { records });
  const merged = mergeModelAnswer({
    status: "confirmed",
    verdict: "can",
    evidenceIds: ["fake"],
    provisionalAnswer: {
      status: "confirmed",
      verdict: "can",
    },
    explanationText: "模型尝试把截图转成 confirmed。",
  }, programAnswer);
  assert.equal(merged.status, "unknown");
  assert.equal(merged.verdict, "unknown");
  assert.equal(merged.provisionalAnswer.status, "provisional_official_response");
  assert.ok(merged.warnings.includes("model_status_or_verdict_ignored"));
});

function runOfficialResponseCase(record) {
  const records = normalizeOfficialResponses([record]);
  const evidence = retrieveEvidenceByFormalQuery(formalQuery, cards, { records });
  return answerEachSubQuestion(formalQuery, evidence, { records });
}

function traceableOfficialResponse() {
  return {
    id: "official-response-alba-ecclesia",
    title: "吞食圣痕之龙与白之圣女艾克莉西娅事务局回答",
    sourceType: "official_response",
    sourceNote: "事务局回答记录：fixture",
    officialText: "可以发动并支付cost。处理时由于吞食圣痕之龙③效果未适用，不进行融合素材处理。",
    cards: ["吞食圣痕之龙", "白之圣女 艾克莉西娅"],
    cardIds: [999001, 999002],
    questionTypes: ["activation_condition", "cost", "resolution_handling"],
    scenario: "吞食圣痕之龙③没有适用时，白之圣女艾克莉西娅作为cost发动。",
    verdict: {
      activation: "can_activate",
      cost: "can_pay_cost",
      resolution: "does_not_perform_fusion_material_processing",
      reason: "吞食圣痕之龙③效果未适用，因此虽然可以发动并支付cost，但后续不能将其作为融合素材处理。",
    },
    explanation: "可以发动并支付cost，但后续不能将其作为融合素材处理。",
    maxStatus: "confirmed",
    updatedAt: "2026-06-25",
    tags: ["official_response", "fusion_material", "cost"],
  };
}

const albazCards = [
  {
    id: "999101",
    name: "アルバスの落胤",
    jaName: "アルバスの落胤",
    cnName: "阿不思的落胤",
    aliases: ["アルバスの落胤", "阿不思的落胤"],
  },
  {
    id: "999102",
    name: "導きの聖女エクレシア",
    jaName: "導きの聖女エクレシア",
    cnName: "引导的圣女 艾克莉西娅",
    aliases: ["導きの聖女エクレシア", "引导的圣女 艾克莉西娅"],
  },
  {
    id: "999103",
    name: "聖痕喰らいし竜",
    jaName: "聖痕喰らいし竜",
    cnName: "吞食圣痕之龙",
    aliases: ["聖痕喰らいし竜", "吞食圣痕之龙"],
  },
];

const albazFormalQuery = {
  originalText: "アルバスの落胤①効果を発動できるか。",
  cards: [
    { name: "アルバスの落胤", role: "question_card" },
    { name: "導きの聖女エクレシア", role: "cost_card" },
    { name: "聖痕喰らいし竜", role: "related_card" },
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

function screenshotOfficialResponse() {
  return {
    id: "official-response-screenshot-albaz-quem-stigmata-001",
    title: "アルバスの落胤 cost に導きの聖女エクレシアを送った場合の処理",
    sourceType: "official_response_screenshot",
    sourceNote: "User-provided screenshot titled 遊戯王カードゲーム事務局からのご連絡. Not found as direct official DB Q&A at time of entry.",
    officialText: "「アルバスの落胤」の効果を発動できますが、処理は何も行われません。",
    cards: ["アルバスの落胤", "導きの聖女エクレシア", "聖痕喰らいし竜", "氷剣竜ミラジェイド"],
    questionTypes: ["activation_condition", "cost", "fusion_material", "resolution_handling"],
    scenario: "自分のEXデッキに氷剣竜ミラジェイドが存在し、手札に導きの聖女エクレシアとアルバスの落胤があり、相手フィールドに表側表示の聖痕喰らいし竜のみ存在する。アルバスの落胤を召喚した時、導きの聖女エクレシアをコストとして墓地へ送り、アルバスの落胤①効果を発動できるか。",
    verdict: {
      activation: "can_activate",
      cost: "can_pay_cost",
      resolution: "does_not_perform_fusion_material_processing",
    },
    explanation: "根据事务局回答截图，最可能处理为：可以发动并支付 cost，但处理不进行。该回答目前未在官方数据库中找到直接 Q&A，因此不作为 confirmed。",
    maxStatus: "unconfirmed",
    displayStatus: "provisional_official_response",
    updatedAt: "2026-06-25",
    tags: ["official-response-screenshot", "not-in-official-db", "fusion-material", "cost"],
    watchOfficialDb: {
      enabled: true,
      cardIds: [22090, 16493],
      sourceUrls: ["https://www.db.yugioh-card.com/yugiohdb/faq_search.action?ope=4&cid=22090&request_locale=ja"],
      queryTerms: ["白の聖女エクレシア", "導きの聖女エクレシア", "アルバスの落胤", "融合素材", "コスト", "処理は何も行われません", "発動できます"],
      expectedAskedResult: ["can_activate", "can_pay_cost", "does_not_perform_fusion_material_processing"],
      lastResult: "not_found",
    },
  };
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
    cardIds: ["999101", "999102", "22090", "16493"],
    keywords: ["activation_condition", "cost", "fusion_material", "resolution_handling"],
    sources: [{ label: "官方 Q&A", detail: "fixture" }],
  };
}
