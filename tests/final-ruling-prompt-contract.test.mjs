import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const promptUrl = new URL("../prompts/openai-ruling-v1.md", import.meta.url);

test("final ruling prompt explains generic Lua activation-legality checks", async () => {
  const prompt = await readFile(promptUrl, "utf8");

  assert.match(prompt, /legacyLuaSemanticPacket/u);
  assert.match(prompt, /activationLegalityChecks/u);
  assert.match(prompt, /predicateApi/u);
  assert.match(prompt, /requiredMinimum/u);
  assert.match(prompt, /枚举范围内的全部候选/u);
  assert.match(prompt, /卡存在于某区域不等于它能够被移动到指定区域/u);
  assert.match(prompt, /效果不能发动/u);
  assert.match(prompt, /不得把这个失败改写成“可以发动，之后对应处理为空”/u);
  assert.match(prompt, /处理时重算/u);
  assert.match(prompt, /不能单独充当官方裁定或最终真值/u);
});

test("final ruling prompt treats model-packet coverage flags as risks without forcing a verdict", async () => {
  const prompt = await readFile(promptUrl, "utf8");

  assert.match(prompt, /decisionPacketTruncated=true/u);
  assert.match(prompt, /decisiveMechanismCoverageComplete=false/u);
  assert.match(prompt, /不得把资料包称为完整/u);
  assert.match(prompt, /不得套用“资料完整所以必须作出确定裁定”的反拒答前提/u);
  assert.match(prompt, /覆盖风险本身不自动等于 `UNKNOWN`/u);
  assert.match(prompt, /当前可见卡文、规则或 Q&A 已独立支持决定性 Claim/u);
});
