import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProvisionalAnswerFromOfficialResponse,
  isConfirmableOfficialResponse,
  normalizeOfficialResponses,
} from "../backend/officialResponses.mjs";
import { revalidateOfficialResponses } from "../scripts/revalidate-official-responses.mjs";

test("official response text cannot prove its own provenance", () => {
  const records = normalizeOfficialResponses([{
    ...traceableOfficialResponse(),
    id: "self-attested-official-text",
    sourceUrl: "",
    sourceNote: "",
    responseId: "",
    updatedAt: "",
    collectedAt: "",
  }]);
  assert.equal(records[0].traceable, false);
  assert.equal(records[0].maxStatus, "unknown");
  assert.equal(records[0].displayStatus, "unknown");
  assert.equal(isConfirmableOfficialResponse(records[0]), false);
});

test("traceable provenance without an explicit confirmed review stays unknown", () => {
  const records = normalizeOfficialResponses([{
    ...traceableOfficialResponse(),
    id: "unreviewed-traceable-response",
    maxStatus: "",
  }]);
  assert.equal(records[0].traceable, true);
  assert.equal(records[0].maxStatus, "unknown");
  assert.equal(records[0].displayStatus, "unknown");
  assert.equal(isConfirmableOfficialResponse(records[0]), false);
});

test("a screenshot record with no ruling text never receives a fabricated default answer", () => {
  const [record] = normalizeOfficialResponses([{
    id: "screenshot-without-ruling-text",
    sourceType: "official_response_screenshot",
    title: "匿名截图记录",
    screenshotPath: "/fixtures/anonymous.png",
  }]);
  const provisional = buildProvisionalAnswerFromOfficialResponse(record);
  assert.equal(provisional.verdict, "unknown");
  assert.match(provisional.explanation, /不能据此判定/u);
  assert.doesNotMatch(provisional.explanation, /可以发动|支付\s*cost|处理不进行/iu);
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
