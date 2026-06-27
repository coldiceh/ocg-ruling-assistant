import assert from "node:assert/strict";
import test from "node:test";
import { splitCardTextSections } from "../backend/cardTextSections.mjs";

test("pendulum and monster effects remain separate", () => {
  const result = splitCardTextSections({
    cardType: "Pendulum Effect Monster",
    isPendulum: true,
    pendulumEffectText: "①：另一边有卡的场合可以发动。破坏那张卡。",
    monsterEffectText: "①：这张卡召唤成功的场合可以发动。抽1张。",
  });
  assert.equal(result.isPendulum, true);
  assert.equal(result.sections.pendulumEffects.length, 1);
  assert.equal(result.sections.monsterEffects.length, 1);
  assert.deepEqual(result.missingSections, []);
});

test("missing pendulum text is explicit instead of treated as no effect", () => {
  const result = splitCardTextSections({ cardType: "Pendulum Monster", isPendulum: true, monsterEffectText: "①：抽1张。" });
  assert.ok(result.missingSections.includes("pendulumEffects"));
});

test("ordinary English effect text does not match a single letter P as pendulum text", () => {
  const result = splitCardTextSections({ cardType: "monster", effectText: "If this card is Special Summoned: Draw 1 card." });
  assert.equal(result.isPendulum, false);
  assert.equal(result.sections.pendulumEffects.length, 0);
});
