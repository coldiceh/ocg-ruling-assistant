import assert from "node:assert/strict";
import test from "node:test";

import { buildEffectApplicabilityContext } from "../backend/effectApplicabilityContext.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";

function card(id, name, cardType, effectText) {
  return { id, name, cardType, effectText };
}

test("orders trap-as-equip applicability before a granted spell immunity", () => {
  const query = "我方连接召唤的『棱镜守卫』被『静默缚带』装备，对手发动『清场术』，它是否会被破坏？";
  const cards = [
    card("recipient", "棱镜守卫", "monster", "只要这张连接召唤的卡存在于怪兽区域，不受陷阱卡的效果影响。"),
    card("grant", "静默缚带", "trap", "以场上1只怪兽为对象可以发动。这张卡当作装备卡使用给那只怪兽装备。装备怪兽不受魔法卡的效果影响。"),
    card("incoming", "清场术", "spell", "对方场上的怪兽全部破坏。"),
  ];
  const context = buildEffectApplicabilityContext({ userQuery: query, resolvedCards: cards });

  assert.equal(context.status, "complete");
  assert.equal(context.canDecideFinalRuling, false);
  assert.equal(context.outcome, "not_evaluated");
  const [relationship] = context.relationships;
  assert.equal(relationship.sourceEffect.printedCardType, "trap");
  assert.equal(relationship.sourceEffect.currentRole, "trap_as_equip");
  assert.equal(relationship.recipient.cardId, "recipient");
  assert.deepEqual(
    relationship.recipient.sourceEffectBlockerCandidates.map((item) => item.overlapType),
    ["trap"],
  );
  assert.equal(relationship.grantedProperty.effectSourceTypes.includes("spell"), true);
  assert.equal(relationship.incomingEffect.printedCardType, "spell");
  assert.deepEqual(
    relationship.incomingEffect.grantedPropertyBlockCandidates.map((item) => item.overlapType),
    ["spell"],
  );

  const order = relationship.dependencyGraph.evaluationOrder;
  assert.ok(order.indexOf(relationship.dependencyGraph.nodes[1].id) < order.indexOf(relationship.dependencyGraph.nodes[2].id));
  assert.equal(
    relationship.dependencyGraph.forbiddenEdges.some((edge) => edge.reason === "granted_property_cannot_bootstrap_source_applicability"),
    true,
  );
});

test("keeps a continuous Spell source identity separate from its recipient", () => {
  const context = buildEffectApplicabilityContext({
    userQuery: "『恒光领域』适用中，我方『折射幼龙』在场，对手发动『噪声巫师』的效果，幼龙会受影响吗？",
    resolvedCards: [
      card("field", "恒光领域", "spell", "只要这张卡在魔法与陷阱区域存在，自己场上的怪兽不受对方怪兽效果影响。"),
      card("recipient", "折射幼龙", "monster", "此卡不受魔法卡的效果影响。"),
      card("incoming", "噪声巫师", "monster", "可以发动。对方场上1只怪兽的效果无效。"),
    ],
  });

  const [relationship] = context.relationships;
  assert.equal(relationship.sourceEffect.currentRole, "spell_continuous");
  assert.equal(relationship.recipient.cardId, "recipient");
  assert.equal(relationship.recipient.sourceEffectBlockerCandidates[0].overlapType, "spell");
  assert.deepEqual(relationship.grantedProperty.effectSourceTypes, ["monster"]);
  assert.equal(relationship.grantedProperty.effectSourceController, "opponent_of_recipient_controller");
  assert.equal(relationship.incomingEffect.cardId, "incoming");
});

test("handles a Monster source and a Trap incoming effect without inventing a baseline immunity", () => {
  const context = buildEffectApplicabilityContext({
    userQuery: "我方『琉璃导师』和『琉璃学徒』在场，对手发动『落穴测试』，学徒是否受影响？",
    resolvedCards: [
      card("source", "琉璃导师", "monster", "只要此卡存在于怪兽区域，自己场上的其他怪兽不受陷阱卡的效果影响。"),
      card("recipient", "琉璃学徒", "monster", "这张卡可以通常召唤。"),
      card("incoming", "落穴测试", "trap", "对方场上1只怪兽破坏。"),
    ],
  });

  const [relationship] = context.relationships;
  assert.equal(relationship.sourceEffect.printedCardType, "monster");
  assert.equal(relationship.sourceEffect.currentRole, "monster_effect_source");
  assert.deepEqual(relationship.recipient.existingProtections, []);
  assert.deepEqual(relationship.recipient.sourceEffectBlockerCandidates, []);
  assert.equal(relationship.incomingEffect.printedCardType, "trap");
  assert.equal(relationship.incomingEffect.grantedPropertyBlockCandidates.length, 1);
});

test("never uses a newly granted protection to bootstrap its equip source", () => {
  const context = buildEffectApplicabilityContext({
    userQuery: "『回声锁链』装备给『石英兽』，对手发动『终止陷阱』，石英兽受影响吗？",
    resolvedCards: [
      card("source", "回声锁链", "trap", "这张卡当作装备卡使用。装备怪兽不受陷阱卡效果影响。"),
      card("recipient", "石英兽", "monster", "通常怪兽。"),
      card("incoming", "终止陷阱", "trap", "对方场上1只怪兽的效果无效。"),
    ],
  });

  const [relationship] = context.relationships;
  assert.deepEqual(relationship.recipient.sourceEffectBlockerCandidates, []);
  assert.equal(relationship.incomingEffect.grantedPropertyBlockCandidates.length, 1);
  assert.equal(relationship.dependencyGraph.acyclic, true);
  assert.deepEqual(
    relationship.dependencyGraph.edges.map((edge) => edge.relation),
    ["may_gate", "required_precondition", "may_gate"],
  );
});

test("does not trigger for an unrelated player or field-count constraint", () => {
  const context = buildEffectApplicabilityContext({
    userQuery: "『边界律令』适用时，双方还能各召唤几只怪兽？",
    resolvedCards: [
      card("limit", "边界律令", "trap", "只要此卡存在于魔法与陷阱区域，双方场上各只可有1只同种族怪兽表侧表示存在。"),
    ],
  });
  assert.equal(context, null);
});

test("full, compact and recovery prompts retain raw card text without dependency-context rules", () => {
  const userQuery = "『静默缚带』装备给『棱镜守卫』，对手发动『清场术』，守卫会被破坏吗？";
  const resolvedCards = [
    card("recipient", "棱镜守卫", "monster", "此卡不受陷阱卡效果影响。"),
    card("grant", "静默缚带", "trap", "装备怪兽不受魔法卡效果影响。"),
    card("incoming", "清场术", "spell", "对方场上的怪兽全部破坏。"),
  ];
  const effectApplicabilityContext = buildEffectApplicabilityContext({ userQuery, resolvedCards });
  for (const maxPromptChars of [60000, 4800]) {
    const bundle = buildRagRulingPromptBundle({
      userQuery,
      cardResolution: { resolvedCards, unresolvedMentions: [], ambiguousMentions: [] },
      evidence: { effectApplicabilityContext },
      env: { RAG_MAX_PROMPT_CHARS: String(maxPromptChars), RAG_RECOVERY_PROMPT_CHARS: "4800" },
    });
    for (const prompt of [bundle.prompt, bundle.recoveryPrompt]) {
      assert.match(prompt, /静默缚带/u);
      assert.match(prompt, /棱镜守卫/u);
      assert.match(prompt, /装备怪兽不受魔法卡效果影响/u);
      assert.match(prompt, /对方场上的怪兽全部破坏/u);
      assert.doesNotMatch(prompt, /effectApplicabilityContext/u);
      assert.doesNotMatch(prompt, /granted_property_cannot_bootstrap_source_applicability/u);
      assert.doesNotMatch(prompt, /normalizer_candidate_only/u);
      assert.doesNotMatch(prompt, /dependencyGraph/u);
    }
  }
});
