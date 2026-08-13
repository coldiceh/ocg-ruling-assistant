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
