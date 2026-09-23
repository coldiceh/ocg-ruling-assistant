import assert from "node:assert/strict";
import test from "node:test";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import { displayedPayload } from "./helpers/readable-prompt.mjs";

test("answer language changes instructions without changing selected evidence or card text", () => {
  const input = {
    userQuery: "测试发动时点。",
    cardResolution: { resolvedCards: [{ id: "fixture-card", name: "测试卡", effectText: "原始卡文。" }] },
    evidence: { cardTexts: [{ id: "fixture-text", type: "card_text", text: "原始卡文。" }] },
  };
  const zh = buildRagRulingPromptBundle({ ...input, answerLocale: "zh-CN" });
  for (const [answerLocale, instruction] of [["en", /用英文先直接回答/u], ["ja", /用日文先直接回答/u]]) {
    const localized = buildRagRulingPromptBundle({ ...input, answerLocale });
    assert.match(localized.prompt, instruction);
    assert.deepEqual(displayedPayload(localized), displayedPayload(zh));
    assert.deepEqual(localized.allowedEvidenceIds, zh.allowedEvidenceIds);
  }
});
