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
    "evidenceDecisionPacket.decisionFocus.mandatoryConstraintReview 是确定性预处理器按题面操作与限制性规则自动生成的必查清单，不是最终裁定。给出发动或处理合法的确定结论前，必须逐项阅读清单所指 evidenceId：分别检查诱发条件与每个必做处理，并只统计在发动时确实能接受该操作的合法候选。若清单项不适用，必须说明题设与该规则条件的具体不匹配；不得只因卡片 FAQ 说明了可连锁时点就跳过必做处理的发动合法性。",
    "legacyLuaSemanticPacket 是旧 Lua 脚本自动提取的非权威语义旁路，只能提示可能需要检查的条件、操作和底层 API 依赖；它不是官方资料，不能加入 evidenceIds，candidateVerdict 不能直接支持结论，verdict=UNKNOWN 也绝不表示不能发动或不能处理。",
    "使用 Lua 候选前必须先读取候选自身的 sourceBinding，并在 resources 存在时按 resourceId 交叉核对来源；预计算 sourceDocumentId 中的 cid-<卡片CID>/passcode-<脚本密码> 只允许绑定 Evidence Snapshot 内 resolvedCards.cid 相同的已解析卡片，禁止跨卡套用。activationLegalityChecks 的 requiredMinimum 是发动前最低候选数，不满足时不能改写成发动后空处理。",
    "selectorSummary 是 Lua 筛选器自动生成的有界布尔摘要；FILTER_ARGUMENT_n 依次绑定 filterArgumentExpressions[n-1]。必须先按题设的响应效果种类代入分支，再依据 controllerLocation、opponentLocation、filterExpression 和 predicateApi 逐项计算候选，不能把另一分支的怪兽或魔陷混入数量。",
    "不得调用网络搜索，不得引用快照外资料。",
    `{"schemaVersion":2,"evidenceSnapshot":{"id":"snapshot-full-golden","sha256":"${"f".repeat(64)}"},"questions":[{"questionId":"q1","text":"匿名问题"}],"providedFacts":["匿名事实"],"cardResolution":{"resolvedCards":[]},"unresolved":{},"retrievalWarnings":[],"completeness":{},"evidenceDecisionPacket":{"evidenceItems":[]},"legacyLuaSemanticPacket":null}`,
  ].join("\n");

  assert.equal(buildFinalRulingInput(snapshot), expected);
  assert.equal(buildFinalRulingInput(snapshot, { evidenceVariant: "full" }), expected);
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
