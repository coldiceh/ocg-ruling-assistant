import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";
import { buildSummonLegalityContext } from "../backend/summonLegalityContext.mjs";

const permissionText = "要以场上的此卡作为素材同步召唤的情况下，可将手牌的1只协调也作为同步素材。";

function card({ id, name, level, attribute, properties, effectText }) {
  return {
    id,
    cardId: id,
    name,
    cnName: name,
    level,
    attribute,
    race: properties[0] || "",
    properties,
    monsterProperties: properties,
    effectText,
    aliases: [name],
  };
}

function fictionalCards({ secondPermission = true, secondHandTuner = true, secondHandLevel = 3, formula } = {}) {
  return [
    card({
      id: "field-1",
      name: "光音甲",
      level: 1,
      attribute: "light",
      properties: ["Cyberse", "Tuner", "Effect"],
      effectText: permissionText,
    }),
    card({
      id: "field-2",
      name: "光音乙",
      level: 3,
      attribute: "light",
      properties: ["Fairy", "Tuner", "Effect"],
      effectText: secondPermission ? permissionText : "此卡作为同步素材送去墓地。",
    }),
    card({
      id: "hand-1",
      name: "手牌协调甲",
      level: 3,
      attribute: "fire",
      properties: ["Zombie", "Tuner", "Effect"],
      effectText: "普通测试文本。",
    }),
    card({
      id: "hand-2",
      name: "手牌素材乙",
      level: secondHandLevel,
      attribute: "earth",
      properties: ["Zombie", ...(secondHandTuner ? ["Tuner"] : []), "Effect"],
      effectText: "普通测试文本。",
    }),
    card({
      id: "target",
      name: "测试同步终端",
      level: 10,
      attribute: "light",
      properties: ["Fairy", "Synchro", "Effect"],
      effectText: `${formula || "1只以上协调＋1只光属性怪兽"}\n①：同步召唤的此卡可以发动。`,
    }),
  ];
}

function question(extra = "本回合没有任何自肃") {
  return `我的场上有光音甲和光音乙，手牌中有手牌协调甲和手牌素材乙，${extra}，此时使用上述四张卡同调召唤额外卡组中的测试同步终端是否合法？`;
}

function check(context, code) {
  return context.checks.find((item) => item.code === code);
}

test("builds a complete non-authoritative synchro checklist and accumulates independent hand-material permissions", () => {
  const context = buildSummonLegalityContext({
    userQuery: question(),
    resolvedCards: fictionalCards(),
  });

  assert.equal(context.status, "complete");
  assert.equal(context.authority, "normalizer_candidate_only");
  assert.equal(context.target.summonKind, "synchro");
  assert.equal(context.target.level, 10);
  assert.equal(context.alternateZonePermissions.length, 2);
  assert.equal(context.activeAlternateZonePermissions.length, 2);
  assert.deepEqual(
    context.materials.map((item) => [item.cardName, item.zone, item.level, item.tuner]),
    [
      ["光音甲", "monster_zone", 1, true],
      ["光音乙", "monster_zone", 3, true],
      ["手牌协调甲", "hand", 3, true],
      ["手牌素材乙", "hand", 3, true],
    ],
  );
  assert.deepEqual(
    check(context, "hand_material_permission_capacity"),
    {
      code: "hand_material_permission_capacity",
      status: "satisfied",
      required: 2,
      available: 2,
      activePermissionIds: [
        "field-1:synchro-hand-tuner:1",
        "field-2:synchro-hand-tuner:1",
      ],
      discoveredPermissionIds: [
        "field-1:synchro-hand-tuner:1",
        "field-2:synchro-hand-tuner:1",
      ],
    },
  );
  assert.equal(check(context, "synchro_level_sum").status, "satisfied");
  assert.equal(check(context, "material_formula_assignment").status, "satisfied");
  assert.equal(check(context, "active_summon_restrictions").status, "satisfied");
});

test("fails hand-material capacity when only one participating field material grants permission", () => {
  const context = buildSummonLegalityContext({
    userQuery: question(),
    resolvedCards: fictionalCards({ secondPermission: false }),
  });

  assert.equal(check(context, "hand_material_permission_capacity").status, "failed");
  assert.equal(check(context, "hand_material_permission_capacity").required, 2);
  assert.equal(check(context, "hand_material_permission_capacity").available, 1);
});

test("checks hand-material selector, level sum, and a printed non-tuner slot independently", () => {
  const selectorFailure = buildSummonLegalityContext({
    userQuery: question(),
    resolvedCards: fictionalCards({ secondHandTuner: false }),
  });
  assert.equal(check(selectorFailure, "hand_material_selectors").status, "failed");

  const levelFailure = buildSummonLegalityContext({
    userQuery: question(),
    resolvedCards: fictionalCards({ secondHandLevel: 4 }),
  });
  assert.equal(check(levelFailure, "synchro_level_sum").status, "failed");
  assert.equal(check(levelFailure, "synchro_level_sum").actual, 11);

  const nonTunerFormula = buildSummonLegalityContext({
    userQuery: question(),
    resolvedCards: fictionalCards({ formula: "1只协调＋1只以上协调以外的怪兽" }),
  });
  assert.equal(check(nonTunerFormula, "material_formula_assignment").status, "failed");
});

test("does not invent an inactive restriction when the query has not asserted restriction state", () => {
  const context = buildSummonLegalityContext({
    userQuery: question("没有说明本回合是否适用了其他限制"),
    resolvedCards: fictionalCards(),
  });

  assert.equal(context.status, "partial");
  assert.equal(context.restrictionAssessment.status, "not_asserted");
  assert.equal(check(context, "active_summon_restrictions").status, "unknown");
  assert.ok(context.missingFacts.includes("active_summon_restrictions_not_asserted"));
});

test("is question-scoped and does not run for a non-synchro material question", () => {
  const context = buildSummonLegalityContext({
    userQuery: "可以用这些怪兽进行融合召唤吗？",
    resolvedCards: fictionalCards(),
  });
  assert.equal(context, null);
});

test("real five-card acceptance retains formula, two grants, levels, properties, and explicit no-restriction state", () => {
  const allCards = JSON.parse(readFileSync(new URL("../data/cards.json", import.meta.url), "utf8")).records;
  const names = new Set([
    "杀手旋律・萝塔丽",
    "杀手旋律・绮悠",
    "灰流丽",
    "屋敷童子",
    "玛那桃圆乡・普莱姆哈忒",
  ]);
  const context = buildSummonLegalityContext({
    userQuery: "我的场上有杀手旋律・萝塔丽和杀手旋律・绮悠，手牌中有屋敷童子和灰流丽，本回合未进入任何自肃，此时使用上述四张卡牌同调召唤额外卡组中的玛那桃圆乡・普莱姆哈忒的操作是否合法？",
    resolvedCards: allCards.filter((item) => names.has(item.name)),
  });

  assert.equal(context.status, "complete");
  assert.equal(context.target.level, 10);
  assert.equal(context.target.printedRequirement.sourceText, "１只以上协调＋１只光属性怪兽");
  assert.equal(context.materials.reduce((sum, item) => sum + item.level, 0), 10);
  assert.equal(context.materials.every((item) => item.tuner === true), true);
  assert.equal(context.alternateZonePermissions.length, 2);
  assert.equal(check(context, "hand_material_permission_capacity").status, "satisfied");
  assert.equal(check(context, "material_formula_assignment").status, "satisfied");
});

test("public prompts retain the question and card texts without the summon-legality checklist", () => {
  const cards = fictionalCards();
  const context = buildSummonLegalityContext({ userQuery: question(), resolvedCards: cards });
  const bundle = buildRagRulingPromptBundle({
    userQuery: question(),
    cardResolution: { resolvedCards: cards },
    evidence: {
      summonLegalityContext: context,
      cardTexts: cards.map((item) => ({
        id: `card-text-${item.id}`,
        type: "card_text",
        title: `${item.name} 的卡片文本`,
        cards: [item.name],
        text: item.effectText,
      })),
    },
    env: { RAG_RECOVERY_PROMPT_CHARS: "12000" },
  });

  assert.equal(bundle.recoveryPrompt, "");
  for (const prompt of [bundle.prompt]) {
    assert.match(prompt, /使用上述四张卡同调召唤/u);
    assert.match(prompt, /测试同步终端/u);
    assert.match(prompt, /card-text-target/u);
    assert.match(prompt, /1只以上协调＋1只光属性怪兽/u);
    assert.doesNotMatch(prompt, /summonLegalityContext/u);
    assert.doesNotMatch(prompt, /normalizer_candidate_only/u);
    assert.doesNotMatch(prompt, /hand_material_permission_capacity/u);
    assert.doesNotMatch(prompt, /material_formula_assignment/u);
  }
});
