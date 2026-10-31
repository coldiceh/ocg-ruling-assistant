import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const promptUrl = new URL("../prompts/openai-ruling-v1.md", import.meta.url);

test("final ruling prompt keeps the independent Lua addon non-authoritative", async () => {
  const prompt = await readFile(promptUrl, "utf8");

  assert.match(prompt, /legacyLuaPromptHints/u);
  assert.match(prompt, /独立实验模块/u);
  assert.match(prompt, /非权威核对提醒/u);
  assert.match(prompt, /不能单独证明任何条件成立或不成立/u);
  assert.match(prompt, /不能作为 Evidence ID 或裁定依据/u);
  assert.doesNotMatch(
    prompt,
    /legacyLuaSemanticPacket|activationLegalityChecks|predicateApi|requiredMinimum|candidateVerdict/u,
  );
});

test("final ruling prompt treats model-packet coverage flags as risks without forcing a verdict", async () => {
  const prompt = await readFile(promptUrl, "utf8");

  assert.match(prompt, /decisionPacketTruncated=true/u);
  assert.match(prompt, /decisiveMechanismCoverageComplete=false/u);
  assert.match(prompt, /不得把资料包称为完整/u);
  assert.match(prompt, /不得套用“资料完整所以必须作出确定裁定”的反拒答前提/u);
  assert.match(prompt, /覆盖风险本身不自动等于 `UNKNOWN`/u);
  assert.match(prompt, /已经作为 C1\/C2 组成连锁/u);
  assert.match(prompt, /把“该次发动已经合法成立”视为题面事实/u);
  assert.match(prompt, /不得假设未记载的候选消失/u);
  assert.match(prompt, /当前子问题要求判断某次发动是否合法/u);
  assert.match(prompt, /题面明确已经组成连锁且只问后续处理时，不得重新审查该次发动/u);
  assert.match(prompt, /当前可见卡文、规则或 Q&A 已独立支持决定性 Claim/u);
});

test("final ruling prompt separates question verdict polarity from proposition truth", async () => {
  const prompt = await readFile(promptUrl, "utf8");

  assert.match(prompt, /`verdicts\[\]\.value` 回答用户按原句提出的问题/u);
  assert.match(prompt, /`claims\[\]\.status` 判断的是 `proposition` 这句话本身是否为真/u);
  assert.match(prompt, /命题“该效果不能发动”若事实正确，`status` 必须是 `TRUE`/u);
  assert.match(prompt, /不能因为 verdict 为 `FALSE` 就把这个命题标成 `FALSE`/u);
  assert.match(prompt, /同 `questionId`、`decisive: true`、`status: "TRUE"`/u);
  assert.match(prompt, /`CONDITIONAL` verdict 必须由明确分支中的决定性命题支撑/u);
  assert.match(prompt, /只能是 `TRUE` 或 `FALSE`，不能用 `UNKNOWN` 或 `CONDITIONAL`/u);
});

test("final ruling prompt requests only checks relevant to the current question", async () => {
  const prompt = await readFile(promptUrl, "utf8");

  assert.match(prompt, /只检查与本题实际相关的规则、卡文条件和证据/u);
  assert.match(prompt, /不得因为固定题型清单而给题面添加额外问题或预设结论/u);
  assert.match(prompt, /没有相关核对时输出空数组/u);
  assert.match(prompt, /不要为了满足固定清单而添加与题面无关的规则类别/u);
  assert.doesNotMatch(prompt, /## 固定反向检查|`counterChecks` 必须且每种只出现一次/u);
});

// Deterministic production-packer inputs. The golden digests were computed on
// main 483b000 (before the evidence-status protocol existed).
const goldenCard = { id: "10000", name: "固定测试卡", cnName: "固定测试卡", jaName: "固定テストカード", enName: "Fixed Test Card",
  typeLine: "效果怪兽", effectText: "①：这张卡召唤成功的场合发动。抽1张。", aliases: [] };
const goldenInput = {
  userQuery: "固定测试卡召唤成功时，效果如何处理？",
  cardResolution: { resolvedCards: [goldenCard], unresolvedMentions: [], ambiguousMentions: [] },
  cardTexts: [{ id: "card-10000", type: "card_text", title: "固定测试卡", text: goldenCard.effectText }],
  selection: {
    selectedRules: [{ id: "rule-doc:atom:1", atomKey: "rule-doc:atom:1", recordType: "rule-doc", title: "固定规则来源",
      sourceUrl: "https://example.invalid/rule", source: "fixture", sourceAuthority: "official_reference", official: true,
      text: "连锁上的效果按逆序处理。", parentSourceId: "rule-doc", sourceId: "rule-doc", sourceStart: 0, sourceEnd: 12,
      sourceSectionKey: "s1", kind: "paragraph", ruleUnitIndex: 0,
      sourceSection: { sectionKey: "s1", title: "连锁", titlePath: ["连锁"] } }],
    selectedQa: [{ handle: "a".repeat(64), record: { id: "ygoresources-qa-1", recordType: "qa", title: "固定 Q&A",
      question: "固定问题", answer: "固定回答", official: true, cardIds: ["10000"] } }],
  },
  related: [{ id: "related-1", recordType: "rule-doc", title: "固定相关资料", text: "相关原文。" }],
};
const GOLDEN_483B000_SHA256 = Object.freeze({
  "bounded:zh-CN": "f45562fdbf242a86dd714163cf4d75689f18e5759fd3f2553008c576d55f9cfd",
  "ordinary:zh-CN": "c07874b6213951cf30aa740b9d662e1c1e69318a46d33b8230489bc15cfb3874",
  "bounded:en": "9ab1cefebc3c434b27adf8cb5e59de9cac97c1e41d9fe9f4e9b10492314d92d8",
  "ordinary:en": "e0d13b35775ccfdeabc9d6e2224b00949f810ad432130978a0cd57e0b4e2965e",
  "bounded:ja": "010c901acd6df8e00c6cfa0d450cc9622817cc201c33815d26f70408b97ebd57",
  "ordinary:ja": "42ff9a49a8fd069f6b679ab4124473ca517b7f0ddde6a1d45138b0a473ebaf84",
});

async function goldenPrompts({ evidenceStatusLine = false, env = {} } = {}) {
  const { packGeminiSelection } = await import("../backend/geminiRuleQaPacking.mjs");
  const { buildRagRulingPromptBundle } = await import("../backend/ragRulingPrompt.mjs");
  const prompts = {};
  for (const answerLocale of ["zh-CN", "en", "ja"]) {
    prompts[`bounded:${answerLocale}`] = packGeminiSelection({ selection: goldenInput.selection,
      userQuery: goldenInput.userQuery, answerLocale, cardResolution: goldenInput.cardResolution,
      retrievedEvidence: { cardTexts: goldenInput.cardTexts }, evidenceStatusLine }).packing.prompt;
    prompts[`ordinary:${answerLocale}`] = buildRagRulingPromptBundle({ userQuery: goldenInput.userQuery, answerLocale,
      cardResolution: goldenInput.cardResolution,
      evidence: { cardTexts: goldenInput.cardTexts, rawRelatedEvidence: goldenInput.related }, env }).prompt;
  }
  return prompts;
}

test("with the supplement switch off, final prompts stay byte-identical to main 483b000", async () => {
  const { createHash } = await import("node:crypto");
  for (const env of [{}, { EVIDENCE_SUPPLEMENT_ENABLED: "false" }]) {
    const prompts = await goldenPrompts({ env });
    for (const [key, prompt] of Object.entries(prompts)) {
      assert.equal(createHash("sha256").update(prompt).digest("hex"), GOLDEN_483B000_SHA256[key], key);
      assert.doesNotMatch(prompt, /证据状态/u, key);
    }
  }
});

test("with the supplement switch on, every final prompt asks for one evidence-status line", async () => {
  const { EVIDENCE_STATUS_INSTRUCTION, extractEvidenceStatusLine } = await import("../backend/evidenceStatusProtocol.mjs");
  assert.doesNotMatch(EVIDENCE_STATUS_INSTRUCTION, /中文/u, "localization must not rewrite the protocol labels");
  assert.match(EVIDENCE_STATUS_INSTRUCTION, /最后单独一行/u);
  assert.match(EVIDENCE_STATUS_INSTRUCTION, /“证据状态：充分”/u);
  assert.match(EVIDENCE_STATUS_INSTRUCTION, /“证据状态：不足｜缺少：”/u);
  const prompts = await goldenPrompts({ evidenceStatusLine: true, env: { EVIDENCE_SUPPLEMENT_ENABLED: "true" } });
  for (const [key, prompt] of Object.entries(prompts)) {
    const instructions = prompt.slice(0, prompt.indexOf("本次用户问题、卡片原文与检索资料如下："));
    assert.ok(instructions.trimEnd().endsWith(EVIDENCE_STATUS_INSTRUCTION), key);
  }
  // Both documented shapes are machine-readable as written in the instruction.
  assert.equal(extractEvidenceStatusLine("结论\n证据状态：充分").evidenceStatus, "sufficient");
  assert.equal(extractEvidenceStatusLine("结论\n证据状态：不足｜缺少：某条规则").evidenceGap, "某条规则");
});
