import assert from "node:assert/strict";
import test from "node:test";
import { buildCardProfile, selectRelevantCardSections } from "../backend/cardProfile.mjs";

test("card profile includes names, complete sections, and effect index", () => {
  const profile = buildCardProfile({
    id: "100",
    name: "测试灵摆怪兽",
    jaName: "テストPモンスター",
    enName: "Test Pendulum Monster",
    aliases: ["测试P怪兽"],
    cardType: "pendulum monster",
    isPendulum: true,
    pendulumEffectText: "①：灵摆区域的这张卡存在期间，自己的怪兽攻击力上升300。",
    monsterEffectText: "①：这张卡召唤成功的场合可以发动。抽1张。",
  });
  assert.equal(profile.cardId, "100");
  assert.equal(profile.isPendulum, true);
  assert.ok(profile.names.aliases.includes("测试P怪兽"));
  assert.ok(profile.effectIndex.some((item) => item.section === "pendulumEffects"));
  const relevant = selectRelevantCardSections(profile, [{ id: "pendulum_effect_scope", requiredCardSections: ["pendulumEffects"] }], "灵摆效果", 10);
  assert.equal(relevant[0].section, "pendulumEffects");
});
