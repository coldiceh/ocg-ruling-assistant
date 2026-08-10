import assert from "node:assert/strict";
import test from "node:test";
import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";

const alpha = {
  id: "100",
  name: "甲卡",
  jaName: "アルファ・カード",
  enName: "Alpha Card",
  aliases: ["甲卡", "アルファ・カード", "Alpha Card"],
  effectText: "这张卡可以发动。",
};

const beta = {
  id: "200",
  name: "乙卡",
  jaName: "ベータ・カード",
  enName: "Beta Card",
  aliases: ["乙卡", "ベータ・カード", "Beta Card"],
  effectText: "特殊召唤卡片文本中有指定卡名记述的怪兽。",
};

const records = [
  {
    id: "a-definition",
    recordType: "card-faq",
    title: "甲卡定义",
    cards: ["甲卡"],
    cardIds: ["100"],
    text: "“有指定卡名记述的怪兽”是指卡片文本中记载该卡名的怪兽。",
  },
  {
    id: "b-unrelated-definition",
    recordType: "card-faq",
    title: "乙卡的无关定义",
    cards: ["乙卡"],
    cardIds: ["200"],
    text: "“原本攻击力”是指卡片上印刷的数值。",
  },
  {
    id: "b-unrelated-activation-definition",
    recordType: "card-faq",
    title: "乙卡的发动用语定义",
    cards: ["乙卡"],
    cardIds: ["200"],
    text: "“可以发动的效果”是指已经满足发动条件的效果。",
  },
  {
    id: "b-relevant-definition-1",
    recordType: "card-faq",
    title: "乙卡卡名记述定义",
    cards: ["乙卡"],
    cardIds: ["200"],
    text: "“有指定卡名记述的怪兽”是指该怪兽自身的卡片文本中记载该卡名。",
  },
  {
    id: "b-relevant-definition-2",
    recordType: "card-faq",
    title: "乙卡特殊召唤定义",
    cards: ["乙卡"],
    cardIds: ["200"],
    text: "“特殊召唤”是指不属于通常召唤的召唤。",
  },
  {
    id: "b-relevant-definition-3",
    recordType: "card-faq",
    title: "乙卡特殊召唤定义 2",
    cards: ["乙卡"],
    cardIds: ["200"],
    text: "Special Summon means a summon performed outside a Normal Summon.",
  },
];

async function retrieve(question, {
  cards = [alpha, beta],
  resolvedCards = cards,
  faqRecords = records,
  retrievalEnv = {},
} = {}) {
  return retrieveRagEvidence({
    userQuery: question,
    cardResolution: { resolvedCards, unresolvedMentions: [], ambiguousMentions: [] },
    cards,
    records: faqRecords,
    qaRecords: [],
    maxPerBucket: 10,
    env: { RAG_LIVE_OFFICIAL_QA: "false", ...retrievalEnv },
    fetchImpl: async () => {
      throw new Error("complete injected card identities must not require network access");
    },
  });
}

test("card extraction keeps only the longest exact card-name hit at one source span", () => {
  const shortCard = { id: "overlap-short", name: "Test Dragon", aliases: ["Test Dragon"] };
  const longCard = { id: "overlap-long", name: "Test Dragon Prime", aliases: ["Test Dragon Prime"] };
  const resolution = extractRagCards("Can Test Dragon Prime be activated?", {
    cards: [shortCard, longCard],
    modelCardNameCandidates: [
      { name: "Test Dragon", originalText: "Test Dragon" },
      { name: "Test Dragon Prime", originalText: "Test Dragon Prime" },
    ],
  });

  assert.deepEqual(resolution.resolvedCards.map((card) => card.id), ["overlap-long"]);
  assert.equal(resolution.unresolvedMentions.some((item) => item.input === "Test Dragon"), false);
  assert.equal(resolution.ambiguousMentions.some((item) => item.input === "Test Dragon"), false);
});

test("longest-hit filtering preserves a shorter card name mentioned at its own span", () => {
  const shortCard = { id: "overlap-short", name: "测试龙", aliases: ["测试龙"] };
  const longCard = { id: "overlap-long", name: "原型测试龙", aliases: ["原型测试龙"] };
  const resolution = extractRagCards("「原型测试龙」在场；可以发动「测试龙」吗？", {
    cards: [shortCard, longCard],
  });

  assert.deepEqual(
    new Set(resolution.resolvedCards.map((card) => card.id)),
    new Set(["overlap-short", "overlap-long"]),
  );
});

for (const [language, question] of [
  ["Chinese", "甲卡的效果已经发动。对方能否发动乙卡？乙卡要求特殊召唤有指定卡名记述的怪兽。"],
  ["Japanese", "アルファ・カードの効果は既に発動しました。ベータ・カードの効果を発動できますか？カード名が記されたモンスターを特殊召喚する効果です。"],
  ["English", "Alpha Card was already activated. Can Beta Card be activated? It Special Summons a monster whose card name is mentioned in its printed card text."],
]) {
  test(`${language}: the interrogated B card, not previously activated A, owns the promoted definition FAQ`, async () => {
    const evidence = await retrieve(question);
    assert.equal(evidence.faqRelated[0].id, "b-relevant-definition-1");
    assert.equal(evidence.faqRelated[0].retrievalSignals.operationSubjectDefinitionFaq, true);
    assert.ok(evidence.faqRelated[0].retrievalSignals.operationSubjectDefinitionOverlap.length > 0);
    assert.notEqual(
      evidence.faqRelated.find((item) => item.id === "a-definition")?.retrievalSignals?.operationSubjectDefinitionFaq,
      true,
    );
    assert.notEqual(
      evidence.faqRelated.find((item) => item.id === "b-unrelated-definition")?.retrievalSignals?.operationSubjectDefinitionFaq,
      true,
    );
    assert.ok(evidence.faqRelated.filter((item) => item.retrievalSignals?.operationSubjectDefinitionFaq).length <= 2);
  });
}

test("stable identity falls back to an exact canonical alias when a FAQ has no card id", async () => {
  const faqWithoutId = {
    id: "beta-japanese-alias-definition",
    recordType: "card-faq",
    title: "ベータ・カード FAQ",
    cards: ["ベータ・カード"],
    text: "“カード名が記されたモンスター”とは、カードテキストにその名前が記載されたモンスターです。",
  };
  const evidence = await retrieve(
    "ベータ・カードの発動は可能ですか？カード名が記されたモンスターを特殊召喚します。",
    { faqRecords: [faqWithoutId] },
  );
  assert.equal(evidence.faqRelated[0].id, faqWithoutId.id);
  assert.equal(evidence.faqRelated[0].retrievalSignals.operationSubjectDefinitionFaq, true);
});

test("common post-card Chinese and English used/applied question forms identify the operation subject", async () => {
  for (const question of [
    "乙卡可以发动吗？它会特殊召唤有指定卡名记述的怪兽。",
    "乙卡是否可以连锁发动？它会特殊召唤有指定卡名记述的怪兽。",
    "ベータ・カードを発動できますか？カード名が記されたモンスターを特殊召喚します。",
    "ベータ・カードはチェーンして発動できますか？カード名が記されたモンスターを特殊召喚します。",
    "Can Beta Card be used when its printed card text mentions a card name and it would Special Summon that monster?",
    "Can Beta Card be applied when its printed card text mentions a card name and it would Special Summon that monster?",
    "Can Beta Card's effect be used when its printed card text mentions a card name?",
    "Is it possible to activate Beta Card when its printed card text mentions a card name?",
  ]) {
    const evidence = await retrieve(question);
    assert.equal(evidence.faqRelated[0].id, "b-relevant-definition-1", question);
    assert.equal(evidence.faqRelated[0].retrievalSignals.operationSubjectDefinitionFaq, true, question);
  }
});

test("a shared operation verb cannot promote an otherwise unrelated same-card definition", async () => {
  const evidence = await retrieve(
    "乙卡是否可以发动？乙卡会特殊召唤有指定卡名记述的怪兽。",
  );
  assert.notEqual(
    evidence.faqRelated.find((item) => item.id === "b-unrelated-activation-definition")
      ?.retrievalSignals?.operationSubjectDefinitionFaq,
    true,
  );
});

test("a generic mechanism found only in another effect on the same card cannot promote its FAQ", async () => {
  const multiEffectBeta = {
    ...beta,
    effectText: "①：破坏场上1张卡。②：特殊召唤卡片文本中有指定卡名记述的怪兽。",
  };
  const destroyDefinition = {
    id: "b-unrelated-destroy-definition",
    recordType: "card-faq",
    title: "乙卡的破坏定义",
    cards: ["乙卡"],
    cardIds: ["200"],
    text: "“被破坏”是指卡片因破坏处理而离场。",
  };
  const evidence = await retrieve(
    "乙卡是否可以发动？它会特殊召唤有指定卡名记述的怪兽。",
    {
      cards: [alpha, multiEffectBeta],
      resolvedCards: [alpha, multiEffectBeta],
      faqRecords: [destroyDefinition, ...records],
    },
  );

  assert.equal(
    evidence.faqRelated.find((item) => item.id === destroyDefinition.id)
      ?.retrievalSignals?.operationSubjectDefinitionFaq,
    undefined,
  );
  assert.equal(evidence.faqRelated[0].id, "b-relevant-definition-1");
});

test("common inserted pronouns resolve the operation subject in Chinese, Japanese, and English", async () => {
  for (const question of [
    "关于乙卡，在这个场合它的效果能发动吗？它会特殊召唤有指定卡名记述的怪兽。",
    "ベータ・カードについて、この場合その効果を発動できますか？カード名が記されたモンスターを特殊召喚します。",
    "Regarding Beta Card, in this situation, can its effect be activated? It Special Summons a monster whose card name is mentioned in its printed card text.",
  ]) {
    const evidence = await retrieve(question);
    assert.equal(evidence.faqRelated[0].id, "b-relevant-definition-1", question);
    assert.equal(evidence.faqRelated[0].retrievalSignals.operationSubjectDefinitionFaq, true, question);
  }
});

test("a pronoun after two cards in the same sentence fails closed", async () => {
  const evidence = await retrieve(
    "甲卡和乙卡在这个场合，它的效果能发动吗？卡片文本中有指定卡名记述。",
  );
  assert.equal(
    evidence.faqRelated.some((item) => item.retrievalSignals?.operationSubjectDefinitionFaq),
    false,
  );
});

test("declarative can-activate clauses do not compete with the actual question", async () => {
  for (const question of [
    "此时可以发动甲卡。乙卡可以发动吗？乙卡的卡片文本中有指定卡名记述。",
    "During the Main Phase, you can activate Alpha Card. Can Beta Card be activated when its printed card text mentions a card name?",
    "During the Main Phase, you can activate Alpha Card. Can I activate Beta Card? Its printed card text mentions a card name.",
  ]) {
    const evidence = await retrieve(question);
    assert.equal(evidence.faqRelated[0].id, "b-relevant-definition-1", question);
    assert.notEqual(
      evidence.faqRelated.find((item) => item.id === "a-definition")?.retrievalSignals?.operationSubjectDefinitionFaq,
      true,
      question,
    );
  }
});

test("subject definition FAQ is promoted before the evidence limit is applied", async () => {
  const lexicalDistractor = {
    id: "b-lexical-distractor",
    recordType: "card-faq",
    title: "乙卡能否发动以及特殊召唤",
    cards: ["乙卡"],
    cardIds: ["200"],
    text: "乙卡可以发动。处理时从牌组特殊召唤怪兽。",
  };
  const evidence = await retrieve(
    "乙卡是否可以发动？它要特殊召唤有指定卡名记述的怪兽。",
    {
      faqRecords: [lexicalDistractor, ...records],
      retrievalEnv: { RAG_MAX_RELATED_EVIDENCE: "1" },
    },
  );

  assert.deepEqual(evidence.faqRelated.map((item) => item.id), ["b-relevant-definition-1"]);
  assert.equal(evidence.faqRelated[0].retrievalSignals.operationSubjectDefinitionFaq, true);
});

test("a shorter overlapping English alias cannot steal the longer exact operation subject", async () => {
  const dragon = {
    id: "300",
    name: "Dragon",
    aliases: ["Dragon"],
    effectText: "Special Summon a monster whose card name is mentioned in its printed card text.",
  };
  const dragonPrime = {
    id: "400",
    name: "Dragon Prime",
    aliases: ["Dragon Prime"],
    effectText: dragon.effectText,
  };
  const faqRecords = [dragon, dragonPrime].map((card) => ({
    id: `definition-${card.id}`,
    recordType: "card-faq",
    title: `${card.name} definition`,
    cards: [card.name],
    cardIds: [card.id],
    text: "A card name mentioned in the printed card text means a name physically written in that text box.",
  }));
  const evidence = await retrieve(
    "Can Dragon Prime be activated to Special Summon a monster whose card name is mentioned in its printed card text?",
    { cards: [dragon, dragonPrime], resolvedCards: [dragon, dragonPrime], faqRecords },
  );
  assert.equal(evidence.faqRelated[0].id, "definition-400");
  assert.equal(evidence.faqRelated[0].retrievalSignals.operationSubjectDefinitionFaq, true);
  assert.notEqual(evidence.faqRelated[1].retrievalSignals?.operationSubjectDefinitionFaq, true);
});

test("ambiguous aliases and two equally interrogated cards fail closed", async () => {
  const gamma = { ...alpha, id: "500", name: "Gamma Card", enName: "Gamma Card", aliases: ["Gamma Card", "Twin"] };
  const delta = { ...beta, id: "600", name: "Delta Card", enName: "Delta Card", aliases: ["Delta Card", "Twin"] };
  const ambiguousRecords = [gamma, delta].map((card) => ({
    id: `ambiguous-${card.id}`,
    recordType: "card-faq",
    title: `${card.name} definition`,
    cards: [card.name],
    cardIds: [card.id],
    text: "A card name mentioned in the printed card text means a physically written name.",
  }));

  const ambiguousAlias = await retrieve("Can Twin be activated? Its printed card text mentions a card name.", {
    cards: [gamma, delta],
    resolvedCards: [gamma, delta],
    faqRecords: ambiguousRecords,
  });
  assert.equal(ambiguousAlias.faqRelated.some((item) => item.retrievalSignals?.operationSubjectDefinitionFaq), false);

  const twoQuestions = await retrieve("Can Gamma Card be activated, and can Delta Card be activated? Their printed card text mentions a card name.", {
    cards: [gamma, delta],
    resolvedCards: [gamma, delta],
    faqRecords: ambiguousRecords,
  });
  assert.equal(twoQuestions.faqRelated.some((item) => item.retrievalSignals?.operationSubjectDefinitionFaq), false);
});
