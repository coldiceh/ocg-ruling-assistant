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
  assert.match(prompt, /已经作为 C1\/C2 组成连锁/u);
  assert.match(prompt, /把“该次发动已经合法成立”视为题面事实/u);
  assert.match(prompt, /不得假设未记载的候选消失/u);
  assert.match(prompt, /当前子问题要求判断某次发动是否合法/u);
  assert.match(prompt, /不得用本段重新审查既有发动/u);
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

test("final ruling prompt keeps replacement results bound to the original operation subject", async () => {
  const prompt = await readFile(promptUrl, "utf8");

  assert.match(prompt, /原操作的指代对象/u);
  assert.match(prompt, /替代操作实际影响的卡/u);
  assert.match(prompt, /并不自动代表原指代对象的步骤成功/u);
  assert.match(prompt, /某个替代效果不能适用/u);
  assert.match(prompt, /最终没有发生破坏/u);
});
