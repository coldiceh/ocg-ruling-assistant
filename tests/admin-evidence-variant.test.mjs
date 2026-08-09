import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminEvidenceDecisionPacket,
  createAdminEvidenceArchive,
} from "../backend/adminEvidenceArchive.mjs";
import {
  ADMIN_EVIDENCE_VARIANTS,
  normalizeAdminEvidenceVariant,
} from "../backend/adminEvidenceVariant.mjs";
import {
  buildFinalRulingInput,
  buildFinalRulingModelEvidencePacket,
} from "../backend/adminModelLabService.mjs";
import { createLegacyLuaUnknownPacket } from "../backend/legacyLuaSemanticPacket.mjs";

test("full evidence variant preserves the pre-ablation final input byte for byte", () => {
  const snapshot = {
    snapshotId: "snapshot-full-golden",
    contentSha256: "f".repeat(64),
    question: "匿名问题",
    evidence: {
      questions: [{ questionId: "q1", text: "匿名问题" }],
      providedFacts: ["匿名事实"],
      cardResolution: { resolvedCards: [] },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceDecisionPacket: { modelPacket: { evidenceItems: [] } },
    },
  };
  const expected = [
    "以下是从完整、冻结且通过内容哈希校验的 Evidence Snapshot 生成的有界决策资料包。",
    "完整候选与冲突保存在审计归档；这里只给出确定性选出的正文、有界冲突摘要及遗漏/截断计数。",
    "资料准备模型只提供候选卡名与补充检索词，不是裁定；确定性查询始终优先，但模型补充词仍可能扩展候选集合，所以必须独立核对每条可见证据。",
    "只能引用 evidenceDecisionPacket.evidenceItems 中实际展示正文的 evidenceId；omissionSummary 只有计数与审计哈希，不是证据。",
    "legacyLuaSemanticPacket 是旧 Lua 脚本自动提取的非权威语义旁路，只能提示可能需要检查的条件、操作和底层 API 依赖；它不是官方资料，不能加入 evidenceIds，candidateVerdict 不能直接支持结论，verdict=UNKNOWN 也绝不表示不能发动或不能处理。",
    "不得调用网络搜索，不得引用快照外资料。",
    `{"schemaVersion":2,"evidenceSnapshot":{"id":"snapshot-full-golden","sha256":"${"f".repeat(64)}"},"questions":[{"questionId":"q1","text":"匿名问题"}],"providedFacts":["匿名事实"],"cardResolution":{"resolvedCards":[]},"unresolved":{},"retrievalWarnings":[],"completeness":{},"evidenceDecisionPacket":{"evidenceItems":[]},"legacyLuaSemanticPacket":null}`,
  ].join("\n");

  assert.equal(buildFinalRulingInput(snapshot), expected);
  assert.equal(buildFinalRulingInput(snapshot, { evidenceVariant: "full" }), expected);
});

test("activation candidate preamble follows the decision focus instead of every question", () => {
  const snapshotFor = (decisionFocus) => ({
    snapshotId: "snapshot-preamble-gate",
    contentSha256: "e".repeat(64),
    question: "C2处理后对象离场，已经组成连锁的C1如何继续处理？",
    evidence: {
      questions: [{
        questionId: "q1",
        text: "C2处理后对象离场，已经组成连锁的C1如何继续处理？",
      }],
      providedFacts: [],
      cardResolution: { resolvedCards: [] },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceDecisionPacket: {
        modelPacket: {
          schemaVersion: 2,
          decisionFocus,
          evidenceItems: [],
        },
      },
    },
  });
  const preambleOf = (input) => input.split("\n").slice(0, -1).join("\n");

  const resolutionPreamble = preambleOf(buildFinalRulingInput(snapshotFor({
    asksActivationLegality: false,
    mandatoryConstraintReview: [],
    reviewProtocol: [],
  })));
  assert.doesNotMatch(resolutionPreamble, /mandatoryConstraintReview/u);
  assert.doesNotMatch(resolutionPreamble, /activationLegalityChecks/u);
  assert.doesNotMatch(resolutionPreamble, /selectorSummary/u);

  const activationPreamble = preambleOf(buildFinalRulingInput(snapshotFor({
    asksActivationLegality: true,
    mandatoryConstraintReview: [],
    reviewProtocol: ["activation-review"],
  })));
  assert.match(activationPreamble, /mandatoryConstraintReview/u);
  assert.match(activationPreamble, /activationLegalityChecks/u);
  assert.match(activationPreamble, /selectorSummary/u);

  const mandatoryPreamble = preambleOf(buildFinalRulingInput(snapshotFor({
    asksActivationLegality: false,
    mandatoryConstraintReview: [{ evidenceId: "rule-1" }],
    reviewProtocol: ["activation-review"],
  }), { evidenceVariant: "without_lua" }));
  assert.match(mandatoryPreamble, /mandatoryConstraintReview/u);
  assert.doesNotMatch(mandatoryPreamble, /activationLegalityChecks/u);
});

test("historical packets lose unconditional activation review only for resolution questions", () => {
  const historicalPacket = {
    schemaVersion: 2,
    decisionFocus: {
      mandatoryConstraintReview: [],
      reviewProtocol: ["legacy-unconditional-activation-review"],
    },
    evidenceItems: [],
  };
  const snapshotFor = (question) => ({
    snapshotId: "snapshot-historical-review",
    contentSha256: "d".repeat(64),
    question,
    evidence: {
      questions: [{ questionId: "q1", text: question }],
      providedFacts: [],
      cardResolution: { resolvedCards: [] },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceDecisionPacket: { modelPacket: structuredClone(historicalPacket) },
    },
  });

  const resolutionPacket = buildFinalRulingModelEvidencePacket(snapshotFor(
    "C2处理后对象离场，已经组成连锁的C1如何继续处理？",
  ));
  assert.equal(resolutionPacket.decisionFocus.asksActivationLegality, false);
  assert.deepEqual(resolutionPacket.decisionFocus.reviewProtocol, []);

  const activationPacket = buildFinalRulingModelEvidencePacket(snapshotFor(
    "对方能否连锁发动这个效果？",
  ));
  assert.equal(activationPacket.decisionFocus.asksActivationLegality, true);
  assert.deepEqual(
    activationPacket.decisionFocus.reviewProtocol,
    ["legacy-unconditional-activation-review"],
  );
  assert.deepEqual(
    historicalPacket.decisionFocus.reviewProtocol,
    ["legacy-unconditional-activation-review"],
    "model projection must not mutate the archived packet",
  );
});

test("generic evidence projections expose exactly full, no-Lua, and card-text-only views", () => {
  const archive = createAdminEvidenceArchive({
    evidenceBuckets: {
      cardTexts: [{
        id: "arbitrary-card-text",
        type: "card_text",
        text: "CARD_TEXT_ONLY_CANARY：任意卡的完整效果文本。",
      }],
      officialQaDirectCandidates: [{
        id: "arbitrary-direct-qa",
        type: "official_qa",
        question: "QA_ONLY_QUESTION_CANARY",
        answer: "QA_ONLY_ANSWER_CANARY",
        isDirect: true,
      }],
      rulebookCandidates: [{
        id: "arbitrary-rule",
        type: "rulebook",
        text: "RULE_ONLY_CANARY",
      }],
    },
  });
  const decisionPacket = buildAdminEvidenceDecisionPacket({ archive });
  const legacyLuaSemanticPacket = createLegacyLuaUnknownPacket({
    code: "ARBITRARY_LUA_UNAVAILABLE",
    message: "LUA_ONLY_CANARY",
  });
  const snapshot = {
    snapshotId: "snapshot-generic-ablation",
    contentSha256: "a".repeat(64),
    question: "SCENARIO_ONLY_CANARY",
    evidence: {
      questions: [{ questionId: "q1", text: "QUESTION_ONLY_CANARY" }],
      providedFacts: ["PROVIDED_FACT_ONLY_CANARY"],
      cardResolution: {
        resolvedCards: [{
          id: "arbitrary-card",
          passcode: "31415926",
          name: "任意测试卡",
        }],
      },
      unresolved: {},
      retrievalWarnings: [],
      completeness: {},
      evidenceArchive: archive,
      evidenceDecisionPacket: decisionPacket,
      legacyLuaSemanticPacket,
      goldens: [{ answer: "GOLD_ONLY_ANSWER_MUST_NOT_LEAK" }],
      expectedAnswer: "GOLD_ONLY_EXPECTED_MUST_NOT_LEAK",
    },
  };

  const full = buildFinalRulingInput(snapshot, { evidenceVariant: "full" });
  const withoutLua = buildFinalRulingInput(snapshot, { evidenceVariant: "without_lua" });
  const cardTextOnly = buildFinalRulingInput(snapshot, { evidenceVariant: "card_text_only" });

  assert.match(full, /QA_ONLY_ANSWER_CANARY/u);
  assert.match(full, /RULE_ONLY_CANARY/u);
  assert.match(full, /ARBITRARY_LUA_UNAVAILABLE/u);
  assert.match(withoutLua, /QA_ONLY_ANSWER_CANARY/u);
  assert.match(withoutLua, /RULE_ONLY_CANARY/u);
  assert.doesNotMatch(withoutLua, /ARBITRARY_LUA_UNAVAILABLE/u);
  assert.match(cardTextOnly, /QUESTION_ONLY_CANARY/u);
  assert.match(cardTextOnly, /PROVIDED_FACT_ONLY_CANARY/u);
  assert.match(cardTextOnly, /CARD_TEXT_ONLY_CANARY/u);
  assert.doesNotMatch(cardTextOnly, /QA_ONLY_(?:QUESTION|ANSWER)_CANARY/u);
  assert.doesNotMatch(cardTextOnly, /RULE_ONLY_CANARY/u);
  assert.doesNotMatch(cardTextOnly, /ARBITRARY_LUA_UNAVAILABLE/u);
  for (const input of [full, withoutLua, cardTextOnly]) {
    assert.doesNotMatch(input, /GOLD_ONLY_(?:ANSWER|EXPECTED)_MUST_NOT_LEAK/u);
  }

  const cardPayload = JSON.parse(cardTextOnly.split("\n").at(-1));
  assert.deepEqual(
    cardPayload.evidenceDecisionPacket,
    buildFinalRulingModelEvidencePacket(snapshot, {
      evidenceVariant: "card_text_only",
    }),
    "the final input and validator must consume the identical projection",
  );
  assert.deepEqual(
    buildFinalRulingModelEvidencePacket(snapshot, { evidenceVariant: "without_lua" }),
    buildFinalRulingModelEvidencePacket(snapshot, { evidenceVariant: "full" }),
    "without_lua removes only the independent Lua packet",
  );
  assert.deepEqual(
    cardPayload.evidenceDecisionPacket.evidenceItems.map((item) => item.category),
    ["parsed_card_text"],
  );
  assert.equal(cardPayload.evidenceDecisionPacket.evidenceItems[0].bodyExcerpted, false);
});

test("evidence variants are a strict generic enum", () => {
  assert.deepEqual(ADMIN_EVIDENCE_VARIANTS, ["full", "card_text_only", "without_lua"]);
  assert.equal(normalizeAdminEvidenceVariant(undefined), "full");
  assert.throws(
    () => normalizeAdminEvidenceVariant("case-specific-override"),
    (error) => error?.code === "admin_evidence_variant_invalid",
  );
});
