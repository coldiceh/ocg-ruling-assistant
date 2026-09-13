import assert from "node:assert/strict";
import test from "node:test";

import { packGeminiSelection } from "../backend/geminiRuleQaPacking.mjs";
import { extractPromptAllowedEvidenceIds } from "../backend/ragRulingPrompt.mjs";

const PROMPT_MARKER = "本次用户问题、卡片原文与检索资料如下：\n";
const RULE_SOURCE_FIELDS = [
  "recordType",
  "title",
  "sourceUrl",
  "source",
  "sourceAuthority",
  "official",
  "parentSourceId",
];

function parsePromptPayload(prompt) {
  const markerIndex = prompt.lastIndexOf(PROMPT_MARKER);
  assert.ok(markerIndex >= 0, "pack output must retain its serialized evidence envelope");
  return JSON.parse(prompt.slice(markerIndex + PROMPT_MARKER.length));
}

function makeFixture() {
  const sharedSource = {
    recordType: "rule-doc",
    title: "规则书重复来源",
    sourceUrl: "https://rules.example.test/shared-source",
    source: "ocg-rule",
    sourceAuthority: "community_reference",
    official: false,
    parentSourceId: "rule-document-shared",
  };
  const selectedRules = Array.from({ length: 8 }, (_unused, index) => ({
    ...sharedSource,
    id: `R1.${index + 1}`,
    text: `SHARED_RULE_${index} ${"规则正文段落。".repeat(90)}`,
    ruleUnitIndex: index,
  }));
  selectedRules.push({
    ...sharedSource,
    id: "R1.9",
    sourceUrl: "https://rules.example.test/different-url",
    text: `DIFFERENT_URL_RULE ${"规则正文段落。".repeat(90)}`,
    ruleUnitIndex: 8,
  });
  selectedRules.push({
    ...sharedSource,
    id: "R1.10",
    sourceAuthority: "official_database",
    text: `DIFFERENT_AUTHORITY_RULE ${"规则正文段落。".repeat(90)}`,
    ruleUnitIndex: 9,
  });

  const qaRecord = {
    id: "qa-server-record",
    recordType: "qa",
    title: "服务端 QA 标题",
    sourceName: "YGOResources",
    sourceUrl: "https://qa.example.test/full-record",
    sourceAuthority: "official_database",
    sourceTier: "S0_OFFICIAL_DB",
    official: true,
    question: "完整 QA 问题",
    answer: "完整 QA 回答",
  };
  const cardTexts = [{
    id: "card-text-stable",
    type: "card_text",
    recordType: "card-text",
    title: "卡文标题",
    sourceAuthority: "card_text_mirror",
    text: "卡文内容",
  }];
  const userProvidedCardTexts = [{
    id: "user-text-stable",
    type: "user_provided_text",
    recordType: "user-provided-card-text",
    title: "用户卡文标题",
    sourceAuthority: "user_provided_text",
    text: "用户提供的卡文",
  }];
  return {
    selectedRules,
    qaRecord,
    cardTexts,
    userProvidedCardTexts,
  };
}

function decodeRuleItems(payload) {
  assert.ok(payload.ruleSources && typeof payload.ruleSources === "object");
  return payload.evidence.rawRelatedEvidence
    .filter((item) => item.recordType === "rule-doc" || Object.hasOwn(item, "sourceRef"))
    .map((segment) => {
      assert.deepEqual(Object.keys(segment).sort(), ["id", "ruleUnitIndex", "sourceRef", "text"].sort());
      const source = payload.ruleSources[segment.sourceRef];
      assert.ok(source, `missing source map entry for ${segment.sourceRef}`);
      return { ...source, id: segment.id, text: segment.text, ruleUnitIndex: segment.ruleUnitIndex };
    });
}

test("pack keeps full selected rules in model evidence while prompt deduplicates rule sources", () => {
  const fixture = makeFixture();
  const qaBefore = structuredClone(fixture.qaRecord);
  const { packing, evidence } = packGeminiSelection({
    selection: {
      selectedRules: fixture.selectedRules,
      selectedQa: [{ handle: "qa-handle-stable", record: fixture.qaRecord }],
    },
    userQuery: "规则来源压缩测试问题",
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    retrievedEvidence: {
      cardTexts: fixture.cardTexts,
      userProvidedCardTexts: fixture.userProvidedCardTexts,
    },
    maxPromptChars: 1000,
  });
  const payload = parsePromptPayload(packing.prompt);
  const originalRules = packing.modelEvidence.rawRelatedEvidence.filter((item) => item.recordType === "rule-doc");
  const promptRules = payload.evidence.rawRelatedEvidence.filter((item) => Object.hasOwn(item, "sourceRef"));
  assert.ok(promptRules.length >= 10, "fixture must exercise the rule source packing path");
  assert.ok(promptRules.every((item) => !Object.hasOwn(item, "parentSourceId")));
  assert.deepEqual(decodeRuleItems(payload), originalRules);
  assert.deepEqual(evidence.rawRelatedEvidence, packing.modelEvidence.rawRelatedEvidence);
  assert.deepEqual(fixture.qaRecord, qaBefore, "packing must not mutate the server QA record");

  const sourceRefs = promptRules.map((item) => item.sourceRef);
  assert.equal(new Set(sourceRefs.slice(0, 8)).size, 1, "identical source fields should share one source reference");
  assert.notEqual(sourceRefs[0], sourceRefs[8], "different source URLs must not merge");
  assert.notEqual(sourceRefs[0], sourceRefs[9], "different authorities must not merge");

  const promptQa = payload.evidence.rawRelatedEvidence.filter((item) => item.id === "qa-handle-stable");
  const modelQa = packing.modelEvidence.rawRelatedEvidence.filter((item) => item.id === "qa-handle-stable");
  assert.deepEqual(promptQa, modelQa);
  assert.equal(promptQa[0].title, "服务端 QA 标题");
  assert.equal(promptQa[0].sourceUrl, "https://qa.example.test/full-record");
  assert.deepEqual(payload.evidence.cardTexts, packing.modelEvidence.cardTexts);
  assert.deepEqual(payload.evidence.userProvidedCardTexts, packing.modelEvidence.userProvidedCardTexts);

  assert.deepEqual(packing.allowedEvidenceIds, [
    "card-text-stable",
    "user-text-stable",
    ...fixture.selectedRules.map((item) => item.id),
    "qa-handle-stable",
  ]);
  assert.deepEqual(extractPromptAllowedEvidenceIds(packing.prompt), packing.allowedEvidenceIds);
  assert.equal(packing.promptChars, packing.prompt.length);
  assert.equal(packing.capacityExceeded, packing.prompt.length > 1000);
  assert.match(packing.prompt, /ruleSources/u);
  assert.match(packing.prompt, /sourceRef/u);
  assert.ok((packing.prompt.match(/ruleSources/gu) || []).length >= 2, "prompt must explain the source map");
  assert.ok((packing.prompt.match(/sourceRef/gu) || []).length > promptRules.length, "prompt must explain reading/citing sourceRef");
});

test("rule source identity includes every required source field", () => {
  const fixture = makeFixture();
  const { packing } = packGeminiSelection({
    selection: { selectedRules: fixture.selectedRules, selectedQa: [] },
    userQuery: "来源字段保真测试",
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    maxPromptChars: 1000,
  });
  const payload = parsePromptPayload(packing.prompt);
  const promptRules = payload.evidence.rawRelatedEvidence.filter((item) => Object.hasOwn(item, "sourceRef"));
  assert.ok(promptRules.length > 0);
  const sourceEntries = [...new Set(promptRules.map((item) => payload.ruleSources[item.sourceRef]))];
  assert.equal(sourceEntries.length, 3);
  for (const source of sourceEntries) {
    assert.deepEqual(Object.keys(source).sort(), RULE_SOURCE_FIELDS.sort());
  }
});
