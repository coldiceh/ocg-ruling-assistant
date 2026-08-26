import assert from "node:assert/strict";
import test from "node:test";

import { clearBaigeSearchCache } from "../backend/baigeCardProvider.mjs";
import { extractRagCards, normalizeCardKey } from "../backend/ragCardExtractor.mjs";
import { loadRagData, retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { analyzeEffectStateTransition, attachUserQueryToCardTexts } from "../backend/effectStateReasoner.mjs";
import { buildRagRulingPromptBundle } from "../backend/ragRulingPrompt.mjs";

const shortQuestion = "对方场上有一个b2b，导致我方场上的4+4变成了6+6。这个情况下假如我方额外只有8星同调而没有12星同调的话，可以发动异界共鸣吗";
const fullQuestion = "对方场上有一个《杀手级调整曲 B2B》，导致我方场上的2只四星怪兽变成了2只六星怪兽，这个情况下假如我方额外只有一只可以同调召唤的8星同调怪兽而没有12星同调怪兽的话，可以发动【异界共鸣-同调融合】吗";

test("unique short aliases and translated partial names resolve to the same cards as full names", async () => {
  const data = await loadRagData();
  const shortResolution = extractRagCards(shortQuestion, { cards: data.cards, maxCards: 8 });
  const fullResolution = extractRagCards(fullQuestion, { cards: data.cards, maxCards: 8 });
  const expectedIds = new Set(["19046", "22551"]);

  assert.deepEqual(new Set(shortResolution.resolvedCards.map((card) => String(card.id))), expectedIds);
  assert.deepEqual(new Set(fullResolution.resolvedCards.map((card) => String(card.id))), expectedIds);
  assert.deepEqual(shortResolution.unresolvedMentions, []);
  assert.deepEqual(fullResolution.unresolvedMentions, []);
});

test("unique alternate localized spellings resolve the reported Yubel interaction without a model", async () => {
  const data = await loadRagData();
  const resolution = extractRagCards(
    "我方场上有「于贝尔精灵」和「献祭魔界莲」，对方场上有「于贝尔」。",
    { cards: data.cards, maxCards: 8 },
  );

  assert.deepEqual(
    new Set(resolution.resolvedCards.map((card) => String(card.id))),
    new Set(["19456", "19458", "7409"]),
    JSON.stringify({
      resolvedCards: resolution.resolvedCards.map((card) => ({ id: card.id, input: card.input, name: card.name, confidence: card.confidence })),
      unresolvedMentions: resolution.unresolvedMentions,
      ambiguousMentions: resolution.ambiguousMentions,
    }),
  );
  assert.deepEqual(resolution.unresolvedMentions, []);
  assert.deepEqual(resolution.ambiguousMentions, []);
});

test("passive alias scanning does not extract short card names from inside longer quoted names", async () => {
  const data = await loadRagData();
  const resolution = extractRagCards(
    "「道化の一座 ホワイトフェイス」の②の効果を発動した場合、「ラーの翼神竜－球体形」をアドバンス召喚できますか？",
    { cards: data.cards, maxCards: 8 },
  );
  const queryIds = resolution.resolvedCards
    .filter((card) => card.resolutionSource !== "card_text_reference")
    .map((card) => String(card.id));

  assert.deepEqual(new Set(queryIds), new Set(["22524", "11927"]));
  assert.ok(!resolution.resolvedCards.some((card) => String(card.id) === "4030"));
});

test("an internal short card-name fragment cannot become an exact identity", () => {
  const localCards = [{
    id: "internal-short-fragment",
    name: "连锁除外",
    cnName: "连锁除外",
    aliases: ["连锁除外"],
  }, {
    id: "canonical-short-name",
    name: "雷击",
    cnName: "雷击",
    aliases: ["雷击"],
  }];
  const operationResults = ["low", "medium", "high"].map((confidence) => extractRagCards(
    "这个效果会进行“除外”处理。",
    {
      cards: localCards,
      modelCardNameCandidates: [{ name: "连锁除外", originalText: "除外", confidence }],
    },
  ));
  const canonical = extractRagCards("发动“雷击”。", {
    cards: localCards,
    modelCardNameCandidates: [{ name: "雷击", originalText: "雷击", confidence: "high" }],
  });

  for (const operation of operationResults) {
    assert.equal(operation.resolvedCards.some((card) => card.id === "internal-short-fragment"), false);
    assert.ok(operation.unresolvedMentions.some((mention) => mention.input === "除外"));
  }
  assert.equal(canonical.resolvedCards[0]?.id, "canonical-short-name");
});

test("all exact mention sources share longest non-overlapping query spans", () => {
  const cards = [{
    id: "span-long",
    name: "匿名破坏龙G",
    aliases: ["匿名破坏龙G"],
  }, {
    id: "span-short",
    name: "匿名破坏龙",
    aliases: ["匿名破坏龙"],
  }, {
    id: "span-other",
    name: "匿名场地",
    aliases: ["匿名场地"],
  }];

  const covered = extractRagCards(
    "发动「匿名破坏龙G」的效果。",
    {
      cards,
      maxCards: 8,
      // Deliberately put the covered short candidate first: model seed order
      // must not bypass the same span disambiguation used by alias scanning.
      modelCardNameCandidates: ["匿名破坏龙", "匿名破坏龙G"],
    },
  );
  assert.deepEqual(
    new Set(covered.resolvedCards.map((card) => String(card.id))),
    new Set(["span-long"]),
  );

  const unquotedCovered = extractRagCards(
    "匿名破坏龙G的效果适用中。",
    {
      cards,
      maxCards: 8,
      modelCardNameCandidates: ["匿名破坏龙", "匿名破坏龙G"],
    },
  );
  assert.deepEqual(
    new Set(unquotedCovered.resolvedCards.map((card) => String(card.id))),
    new Set(["span-long"]),
  );

  const independent = extractRagCards(
    "「匿名破坏龙G」处理后，匿名破坏龙发动「匿名场地」的效果。",
    {
      cards,
      maxCards: 8,
      modelCardNameCandidates: ["匿名破坏龙", "匿名破坏龙G", "匿名场地"],
    },
  );
  assert.deepEqual(
    new Set(independent.resolvedCards.map((card) => String(card.id))),
    new Set(["span-long", "span-short", "span-other"]),
  );
});

test("an exact full normalized model surface survives similar cards and suppresses overlapping short aliases", () => {
  const cards = [{
    id: "model-full",
    name: "匿名星辉・力量",
    aliases: ["匿名星辉・力量"],
  }, {
    id: "overlapping-short",
    name: "力量",
    aliases: ["力量"],
  }, {
    id: "near-neighbour",
    name: "匿名星辉力场",
    aliases: ["匿名星辉力场"],
  }];
  const resolution = extractRagCards("发动「匿名星辉力量」的效果。", {
    cards,
    maxCards: 8,
    modelCardNameCandidates: [{
      name: "匿名星辉・力量",
      // The preparation model normalized the separator instead of copying the
      // user's spelling. The identity is still grounded only because the
      // corresponding normalized span exists in the question.
      originalText: "匿名星辉・力量",
      confidence: "high",
    }, {
      name: "力量",
      originalText: "力量",
      confidence: "medium",
    }],
  });

  assert.deepEqual(resolution.resolvedCards.map((card) => card.id), ["model-full"]);
  assert.equal(resolution.resolvedCards.some((card) => card.id === "overlapping-short"), false);
  assert.equal(resolution.resolvedCards.some((card) => card.id === "near-neighbour"), false);

  const ungrounded = extractRagCards("这里只出现别的表述。", {
    cards,
    maxCards: 8,
    modelCardNameCandidates: [{
      name: "匿名星辉・力量",
      originalText: "匿名星辉・力量",
      confidence: "high",
    }],
  });
  assert.equal(ungrounded.resolvedCards.some((card) => card.id === "model-full"), false);

  const externalSeed = extractRagCards("发动「星辉」的效果。", {
    cards: [],
    maxCards: 8,
    modelCardNameCandidates: [{
      name: "匿名星辉・力量",
      originalText: "星辉",
      confidence: "high",
    }],
  }).unresolvedMentions.find((mention) => mention.input === "星辉");
  assert.ok(externalSeed?.searchTexts.includes("匿名星辉・力量"));
});

test("ambiguous fuzzy model surfaces remain unresolved even when later context favours one neighbour", () => {
  const cards = [{
    id: "context-card",
    name: "匿名关联场地",
    aliases: ["匿名关联场地"],
  }, {
    id: "fuzzy-a",
    name: "匿名测试神龙",
    aliases: ["匿名测试神龙"],
    effectText: "只在匿名关联场地存在时适用。",
  }, {
    id: "fuzzy-b",
    name: "匿名测试魔龙",
    aliases: ["匿名测试魔龙"],
    effectText: "与场地无关。",
  }];
  const surface = "匿名测试巨龙";
  const resolution = extractRagCards(
    `「匿名关联场地」存在时，「${surface}」能否发动？`,
    {
      cards,
      maxCards: 8,
      modelCardNameCandidates: [{ name: surface, originalText: surface, confidence: "high" }],
    },
  );

  assert.equal(resolution.resolvedCards.some((card) => /^fuzzy-/u.test(card.id)), false);
  assert.ok(resolution.unresolvedMentions.some((mention) => mention.input === surface));
});

test("a unique nearest edit wins over farther candidates while tied nearest edits remain unresolved", () => {
  const surface = "匿名长名测试龙甲";
  const cards = [{
    id: "nearest-one-edit",
    name: "匿名长名测试龙乙",
    aliases: ["匿名长名测试龙乙"],
  }, {
    id: "farther-two-edit",
    name: "匿名长名校试龙乙",
    aliases: ["匿名长名校试龙乙"],
  }];
  const resolution = extractRagCards(`「${surface}」可以发动吗？`, {
    cards,
    maxCards: 8,
    modelCardNameCandidates: [{ name: surface, originalText: surface, confidence: "high" }],
  });

  assert.deepEqual(resolution.resolvedCards.map((card) => card.id), ["nearest-one-edit"]);
  assert.equal(resolution.unresolvedMentions.some((mention) => mention.input === surface), false);

  const tiedSurface = "匿名长名测试龙丙";
  const tied = extractRagCards(`「${tiedSurface}」可以发动吗？`, {
    cards: [{
      id: "tie-a",
      name: "匿名长名测试龙甲",
      aliases: ["匿名长名测试龙甲"],
    }, {
      id: "tie-b",
      name: "匿名长名测试龙乙",
      aliases: ["匿名长名测试龙乙"],
    }],
    maxCards: 8,
    modelCardNameCandidates: [{ name: tiedSurface, originalText: tiedSurface, confidence: "high" }],
  });
  assert.equal(tied.resolvedCards.some((card) => /^tie-/u.test(card.id)), false);
  assert.ok(tied.unresolvedMentions.some((mention) => mention.input === tiedSurface));
});

test("fuzzy neighbours do not veto a stronger exact contextual short-name resolution", () => {
  const shortName = "小水龙";
  const cards = [{
    id: "series-context",
    name: "匿名系・关联场地",
    aliases: ["匿名系・关联场地"],
    effectText: "匿名系怪兽适用的场地。",
  }, {
    id: "contextual-short-target",
    name: "匿名系・小水龙",
    aliases: ["匿名系・小水龙"],
    effectText: "这张卡可以特殊召唤。",
  }, {
    id: "unrelated-near-a",
    name: "小火龙",
    aliases: ["小火龙"],
  }, {
    id: "unrelated-near-b",
    name: "小风龙",
    aliases: ["小风龙"],
  }];
  const resolution = extractRagCards(
    `「匿名系・关联场地」存在时，「${shortName}」可以特殊召唤吗？`,
    {
      cards,
      maxCards: 8,
      modelCardNameCandidates: [{ name: shortName, originalText: shortName, confidence: "high" }],
    },
  );

  assert.ok(resolution.resolvedCards.some((card) => card.id === "contextual-short-target"));
  assert.equal(resolution.resolvedCards.some((card) => /^unrelated-near-/u.test(card.id)), false);
  assert.equal(resolution.unresolvedMentions.some((mention) => mention.input === shortName), false);
});

test("a model expansion cannot resolve identity or promote a lexically retrieved FAQ from CID alone", async () => {
  const userSurface = "匿名外查简称";
  const canonicalName = "匿名规范外查龙";
  const localCard = {
    id: "981234",
    cid: 981234,
    name: canonicalName,
    aliases: [canonicalName],
    effectText: "这张卡可以发动。",
    sourceUrl: "https://db.ygoresources.com/data/card/981234",
  };
  const question = `「${userSurface}」可以发动吗？`;
  const cardResolution = extractRagCards(question, {
    cards: [localCard],
    maxCards: 8,
    modelCardNameCandidates: [{ name: canonicalName, originalText: userSurface, confidence: "high" }],
  });
  assert.ok(cardResolution.unresolvedMentions.some((mention) => (
    mention.input === userSurface && mention.searchTexts.includes(canonicalName)
  )));

  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution,
    cards: [localCard],
    records: [],
    qaRecords: [{
      id: "card-faq-anonymous-external-1",
      recordType: "card-faq",
      cardIds: [localCard.id],
      cards: [canonicalName],
      title: "匿名外查 FAQ",
      text: "这张卡的发动条件说明。",
    }],
    fetchImpl: async (url) => {
      const decoded = decodeURIComponent(String(url)).replace(/\+/gu, " ");
      if (!decoded.includes(canonicalName)) {
        return { ok: true, status: 200, json: async () => ({ result: [], next: 0 }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: [{
            cid: Number(localCard.id),
            id: 87654321,
            cn_name: canonicalName,
            text: { desc: "这张卡可以发动。" },
          }],
          next: 0,
        }),
      };
    },
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_LOCAL_FUZZY_MIN_CONFIDENCE: "1.01",
    },
  });

  assert.deepEqual(evidence.retrievedCards, []);
  assert.equal(evidence.cardTexts.length, 0);
  const relatedFaq = evidence.faqRelated.find(
    (item) => item.id === "card-faq-anonymous-external-1",
  );
  assert.ok(relatedFaq);
  assert.equal(relatedFaq.isDirect, false);
  assert.ok(!evidence.officialQaDirectCandidates.some((item) => item.id === relatedFaq.id));
  assert.ok(evidence.cardResolution.unresolvedMentions.some((mention) => mention.input === userSurface));
  assert.ok(evidence.retrievalWarnings.some((warning) => (
    warning.startsWith("baige_model_expansion_stable_identity_unverified:")
  )));

  const bundle = buildRagRulingPromptBundle({
    userQuery: question,
    cardResolution: evidence.cardResolution,
    evidence,
  });
  const promptFaq = bundle.modelEvidence.faqRelated.find((item) => item.id === relatedFaq.id);
  assert.ok(promptFaq);
  assert.equal(promptFaq.isDirect, false);
  assert.equal(promptFaq.retrievalContext.relatedOnly, true);
});

test("an unknown longer seed cannot suppress a nested exact known card name", () => {
  const cards = [{
    id: "known-card",
    name: "匿名真实长卡名",
    aliases: ["匿名真实长卡名"],
  }];
  const unknownLongMention = "匿名真实长卡名的效果";
  const resolution = extractRagCards(
    `发动「${unknownLongMention}」时如何处理？`,
    {
      cards,
      maxCards: 8,
      modelCardNameCandidates: [unknownLongMention],
    },
  );

  assert.deepEqual(
    new Set(resolution.resolvedCards.map((card) => String(card.id))),
    new Set(["known-card"]),
  );
  assert.ok(
    resolution.unresolvedMentions.some((mention) => mention.input === unknownLongMention),
    JSON.stringify(resolution),
  );
});

test("the copied-name ruling keeps the judged card definition FAQ and suppresses an overlapping short card name", async () => {
  const data = await loadRagData();
  const question = "覇王眷竜スターヴ・ヴェノム复制破壊竜ガンドラG后，是否算「光の黄金櫃」卡名记述、能否发动仲間の絆？";
  const cardResolution = extractRagCards(question, { cards: data.cards, maxCards: 6 });
  const queryIds = new Set(cardResolution.resolvedCards
    .filter((card) => card.resolutionSource !== "card_text_reference")
    .map((card) => String(card.id)));

  assert.ok(queryIds.has("19842"), JSON.stringify(cardResolution.resolvedCards));
  assert.ok(!queryIds.has("6076"), JSON.stringify(cardResolution.resolvedCards));

  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution,
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
    fetchImpl: async () => {
      throw new Error("network fallback should not run");
    },
  });
  assert.ok(evidence.faqRelated.some((item) => item.id === "card-faq-19894-1"));
  assert.ok(!evidence.faqRelated.some(
    (item) => item.retrievalSignals?.operationSubjectDefinitionFaq,
  ));
});

test("ordinary FAQ ranking and overlapping-name suppression remain identity based", async () => {
  const cards = [{
    id: "900001",
    name: "匿名复制体",
    aliases: ["匿名复制体"],
    effectText: "这张卡获得对象怪兽原本的卡名和效果。",
  }, {
    id: "900002",
    name: "匿名破坏龙G",
    aliases: ["匿名破坏龙G"],
    effectText: "此卡的文本记载有“匿名场地”。",
  }, {
    id: "900003",
    name: "匿名破坏龙",
    aliases: ["匿名破坏龙"],
    effectText: "与本题无关的短名称卡。",
  }, {
    id: "900004",
    name: "匿名场地",
    aliases: ["匿名场地"],
    effectText: "场地效果。",
  }, {
    id: "900005",
    name: "匿名羁绊",
    aliases: ["匿名羁绊"],
    effectText: "自己场上有匿名场地及记载该卡名的怪兽时可以发动。",
  }];
  const question = "匿名复制体复制匿名破坏龙G后，是否算“匿名场地”卡名记述，能否发动匿名羁绊？";
  const cardResolution = extractRagCards(question, { cards, maxCards: 8 });
  const queryIds = new Set(cardResolution.resolvedCards.map((card) => String(card.id)));
  assert.ok(queryIds.has("900002"));
  assert.ok(!queryIds.has("900003"));

  const records = [{
    id: "card-faq-activation-card-1",
    recordType: "card-faq",
    title: "匿名羁绊 FAQ 1",
    cards: ["匿名羁绊"],
    cardIds: ["900005"],
    text: "“记载有匿名场地卡名的怪兽”是指，卡片文本中作为特定卡名记载了匿名场地的怪兽。",
  }, ...["900001", "900002", "900004"].map((cardId, index) => ({
    id: `card-faq-distractor-${index + 1}`,
    recordType: "card-faq",
    title: `相似定义 FAQ ${index + 1}`,
    cards: [cards.find((card) => card.id === cardId).name],
    cardIds: [cardId],
    text: "相似规则是指其他操作的卡片文本定义，与被判断发动的卡不同。",
  }))];
  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution,
    cards,
    records,
    qaRecords: [],
    env: {
      RAG_LIVE_OFFICIAL_QA: "false",
      RAG_MAX_RELATED_EVIDENCE: "1",
    },
    fetchImpl: async () => {
      throw new Error("network fallback should not run");
    },
  });

  assert.deepEqual(evidence.faqRelated.map((item) => item.id), ["card-faq-activation-card-1"]);
  assert.ok(!evidence.faqRelated[0].retrievalSignals?.operationSubjectDefinitionFaq);

  const independent = extractRagCards(
    "匿名破坏龙G处理后，另一张匿名破坏龙发动效果。",
    { cards, maxCards: 8 },
  );
  assert.deepEqual(
    new Set(independent.resolvedCards
      .filter((card) => card.resolutionSource !== "card_text_reference")
      .map((card) => String(card.id))),
    new Set(["900002", "900003"]),
  );
});

test("equivalent short and full questions retrieve the same governing FAQ after stable identity verification", async () => {
  clearBaigeSearchCache();
  const data = await loadRagData();
  const results = [];
  const expectedFaqIds = new Set([
    "card-faq-19046-0.5",
    "card-faq-19046-1",
    "card-faq-22551-1",
    "card-faq-22551-2",
    "card-faq-22551-3",
  ]);

  for (const question of [shortQuestion, fullQuestion]) {
    let fetchCalls = 0;
    const cardResolution = extractRagCards(question, { cards: data.cards, maxCards: 8 });
    const evidence = await retrieveRagEvidence({
      userQuery: question,
      cardResolution,
      cards: data.cards,
      records: data.records,
      qaRecords: data.qaRecords,
      env: { RAG_LIVE_OFFICIAL_QA: "false" },
      fetchImpl: async (url) => {
        fetchCalls += 1;
        const query = new URL(String(url)).searchParams.get("search");
        const providerSearchSurfaces = new Set([
          "异界共鸣-同调融合",
          "异界共鸣－同步结合",
          "異界共鳴－シンクロ・フュージョン",
          "Harmonic Synchro Fusion",
        ].map(normalizeCardKey));
        if (!providerSearchSurfaces.has(normalizeCardKey(query))) {
          return { ok: true, status: 200, json: async () => ({ result: [], next: 0 }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: [{
              cid: 19046,
              id: 19046001,
              cn_name: "异界共鸣－同步结合",
              jp_name: "異界共鳴－シンクロ・フュージョン",
              en_name: "Harmonic Synchro Fusion",
              text: { desc: "外部身份镜像卡文。" },
            }],
            next: 0,
          }),
        };
      },
    });
    const promptBundle = buildRagRulingPromptBundle({
      userQuery: question,
      cardResolution: evidence.cardResolution,
      evidence,
    });
    results.push({
      ids: evidence.retrievedCards.map((card) => String(card.id)).sort(),
      faqIds: evidence.faqRelated.map((item) => String(item.id)),
      promptFaqIds: promptBundle.modelEvidence.faqRelated.map((item) => String(item.id)),
      allowedEvidenceIds: new Set(promptBundle.allowedEvidenceIds),
      fetchCalls,
    });
  }

  for (const result of results) {
    assert.deepEqual(result.ids, ["19046", "22551"]);
    assert.deepEqual(new Set(result.faqIds), expectedFaqIds);
    assert.deepEqual(new Set(result.promptFaqIds), expectedFaqIds);
    assert.ok([...expectedFaqIds].every((id) => result.allowedEvidenceIds.has(id)));
    assert.ok(!result.faqIds.some((id) => id.startsWith("card-faq-10340-")));
  }
  assert.equal(results[0].fetchCalls, 0);
  assert.ok(results[1].fetchCalls > 0);
  assert.deepEqual(new Set(results[0].faqIds), new Set(results[1].faqIds));
});

test("both original B2B phrasings produce the same non-authoritative legacy simulation", async () => {
  const data = await loadRagData();
  for (const question of [shortQuestion, fullQuestion]) {
    const cardResolution = extractRagCards(question, { cards: data.cards, maxCards: 8 });
    const evidence = await retrieveRagEvidence({
      userQuery: question,
      cardResolution,
      cards: data.cards,
      records: data.records,
      qaRecords: data.qaRecords,
      env: { RAG_LIVE_OFFICIAL_QA: "false" },
    });
    const transition = analyzeEffectStateTransition({
      userQuery: question,
      resolvedCards: cardResolution.resolvedCards,
      cardTexts: attachUserQueryToCardTexts(evidence.cardTexts, question),
    });

    assert.equal(transition.status, "unknown", JSON.stringify(transition.debug));
    assert.equal(transition.complete, false);
    assert.equal(transition.authoritative, false);
    assert.equal(transition.originalStatus, "resolved");
    assert.equal(transition.authorityReason, "untrusted_semantic_inputs");
    assert.ok(transition.authorityReasons.length > 0);
    assert.equal(transition.sourceDefinitionId, "19046");
    assert.match(transition.shortAnswer, /^条件式推演（不能作为完整裁定）/u);
    assert.match(transition.shortAnswer, /4\+4（合计8）/u);
    assert.match(transition.shortAnswer, /没有12星同步怪兽不影响/u);
  }
});

test("a shared short fragment is not resolved when it identifies multiple cards", () => {
  const cards = [
    { id: "a", name: "测试卡 A1B", aliases: ["Alpha A1B"] },
    { id: "b", name: "另一测试卡 A1B", aliases: ["Beta A1B"] },
  ];
  const resolution = extractRagCards("对方场上有一个A1B，这个效果如何处理？", { cards });

  assert.deepEqual(resolution.resolvedCards, []);
});

test("resolved cards preserve normalized structured fields for downstream state reasoning", () => {
  const cards = [{
    id: "fictional-1",
    name: "架空语义龙",
    aliases: ["Fictional Semantic Dragon"],
    type: "monster",
    cardType: "monster",
    race: "Dragon",
    attribute: "light",
    attack: 2500,
    defense: 2000,
    level: 8,
    propertyIds: ["21", "4"],
    properties: ["Dragon", "Effect"],
    monsterPropertyIds: ["21", "4"],
    monsterProperties: ["Dragon", "Effect"],
  }];
  const resolution = extractRagCards("发动「架空语义龙」的效果。", { cards });
  const [resolved] = resolution.resolvedCards;

  assert.equal(resolved.type, "monster");
  assert.equal(resolved.race, "Dragon");
  assert.equal(resolved.attribute, "light");
  assert.equal(resolved.attack, 2500);
  assert.equal(resolved.defense, 2000);
  assert.equal(resolved.level, 8);
  assert.deepEqual(resolved.monsterProperties, ["Dragon", "Effect"]);
});

test("quoted card roles exclude dynamic names, archetype labels, and quoted effect clauses", async () => {
  const data = await loadRagData();
  const cases = [
    {
      question: "「妖精の王子様」として扱われている「閃刀姫」リンクモンスターが相手の効果でフィールドから離れた場合、または戦闘で破壊された場合、「閃刀姫－レイ」の②の効果は発動できますか？",
      expectedId: "13670",
      excludedMentions: ["妖精の王子様", "閃刀姫"],
      modelCandidates: ["妖精の王子様", "閃刀姫", "閃刀姫－レイ"],
    },
    {
      question: "表側表示の「方界」と名のついたモンスターがデッキに戻った場合、墓地の「方界合神」の効果を発動できますか？",
      expectedId: "12528",
      excludedMentions: ["方界"],
      modelCandidates: ["方界", "方界合神"],
    },
    {
      question: "手札の「灰流うらら」の効果の発動にチェーンして『その発動を無効にし、そのカードを持ち主のデッキに戻す』効果を発動した場合、処理はどうなりますか？",
      expectedId: "12950",
      excludedMentions: ["その発動を無効にし、そのカードを持ち主のデッキに戻す"],
    },
  ];

  for (const item of cases) {
    const resolution = extractRagCards(item.question, {
      cards: data.cards,
      maxCards: 8,
      modelCardNameCandidates: item.modelCandidates || [],
    });
    assert.ok(resolution.resolvedCards.some((card) => String(card.id) === item.expectedId));
    const unresolvedInputs = resolution.unresolvedMentions.map((mention) => mention.input);
    const ambiguousInputs = resolution.ambiguousMentions.map((mention) => mention.input);
    for (const excludedMention of item.excludedMentions) {
      assert.ok(!unresolvedInputs.includes(excludedMention));
      assert.ok(!ambiguousInputs.includes(excludedMention));
    }
  }
});

test("quoted metalinguistic terms are not treated as unresolved card names", () => {
  const resolution = extractRagCards(
    "本题的“可以”按至少存在1个合法分支理解。是否可以发动「测试卡甲」？",
    { cards: [] },
  );
  assert.ok(!resolution.unresolvedMentions.some((mention) => mention.input === "可以"));
  assert.ok(resolution.unresolvedMentions.some((mention) => mention.input === "测试卡甲"));
});

test("exact card dependencies named by a resolved card's own text are expanded one hop", async () => {
  const data = await loadRagData();
  const cases = [
    {
      question: "「滅びの爆裂疾風弾」を先攻1ターン目に発動する事はできますか？",
      expectedIds: new Set(["5979", "4007"]),
    },
    {
      question: "リンク先にモンスターが特殊召喚された際に発動した「サイバース・ウィッチ」のモンスター効果の処理時に、自分のデッキに手札に加えられるカードのいずれかが存在しなくなっている場合、処理はどうなりますか？",
      expectedIds: new Set(["13751", "13767"]),
    },
  ];

  for (const item of cases) {
    const resolution = extractRagCards(item.question, { cards: data.cards, maxCards: 8 });
    assert.deepEqual(new Set(resolution.resolvedCards.map((card) => String(card.id))), item.expectedIds);
    const referencedCards = resolution.resolvedCards.filter((card) => (
      !item.question.normalize("NFKC").includes(String(card.input || "").normalize("NFKC"))
    ));
    assert.ok(referencedCards.length >= 1);
    assert.ok(referencedCards.every((card) => card.resolutionSource === "card_text_reference"));
    assert.deepEqual(resolution.unresolvedMentions, []);
    assert.deepEqual(resolution.ambiguousMentions, []);
  }
});

test("unquoted active-effect carrier syntax extracts arbitrary names but rejects ordinary game phrases", () => {
  const reported = extractRagCards("我方看透心灵之眼适用中，对方发动怪兽效果。", { cards: [] });
  const fictional = extractRagCards("对方寂静回声的效果生效中，但场上没有其他卡。", { cards: [] });
  const ordinary = extractRagCards("我方效果适用中，场上怪兽的攻击力不变。", { cards: [] });

  assert.ok(reported.unresolvedMentions.some((mention) => mention.input === "看透心灵之眼"));
  assert.ok(fictional.unresolvedMentions.some((mention) => mention.input === "寂静回声"));
  assert.ok(!ordinary.unresolvedMentions.some((mention) => ["效果", "怪兽效果", "场上怪兽"].includes(mention.input)));
});

test("negative scene-state phrases are not treated as unquoted card names", () => {
  const questions = [
    "对方发动通常陷阱，发动前场上没有其他魔法·陷阱卡。",
    "效果处理时墓地不存在其他怪兽。",
    "连锁中我方场上没有别的卡片存在。",
  ];

  for (const question of questions) {
    const resolution = extractRagCards(question, { cards: [] });
    assert.deepEqual(resolution.unresolvedMentions, [], question);
  }
});

test("gameplay prose wrapped around already resolved aliases is not reported as another card", () => {
  const cards = [
    { id: "quem", name: "引导之圣女 奎姆", aliases: ["引导之圣女 奎姆", "导圣"] },
    { id: "lubellion", name: "神炎龙 卢绯里昂", aliases: ["神炎龙 卢绯里昂", "神炎龙"] },
    { id: "albaz", name: "阿不思的落胤", aliases: ["阿不思的落胤", "阿不思"] },
  ];
  const question = "在墓地没有引导之圣女能苏生的怪兽时，神炎龙C1支付cost丢下阿不思；导圣能不能C2发动，把神炎龙cost送下去的阿不思苏生？";
  const resolution = extractRagCards(question, { cards, maxCards: 8 });

  assert.deepEqual(new Set(resolution.resolvedCards.map((card) => card.id)), new Set(["quem", "lubellion", "albaz"]));
  assert.equal(resolution.unresolvedMentions.length, 0);
});

test("canonical names outrank a conflicting supplemental alias for real and fictional card surfaces", () => {
  const real = extractRagCards("神炎龙能发动吗？", {
    cards: [
      { id: "15994", name: "烙印龙 阿尔比昂", aliases: ["神炎龙"] },
      { id: "17070", name: "神炎龙 卢绯里昂", aliases: [] },
    ],
  });
  const fictional = extractRagCards("星刻龙能发动吗？", {
    cards: [
      { id: "wrong", name: "旧候选卡", aliases: ["星刻龙"] },
      { id: "right", name: "星刻龙 新式", aliases: [] },
    ],
  });

  assert.deepEqual(real.resolvedCards.map((card) => card.id), ["17070"]);
  assert.deepEqual(fictional.resolvedCards.map((card) => card.id), ["right"]);
});

test("multiple canonical prefix owners fail closed instead of trusting a conflicting alias", () => {
  const resolution = extractRagCards("星刻龙能发动吗？", {
    cards: [
      { id: "wrong", name: "旧候选卡", aliases: ["星刻龙"] },
      { id: "right-a", name: "星刻龙 甲", aliases: [] },
      { id: "right-b", name: "星刻龙 乙", aliases: [] },
    ],
  });

  assert.equal(resolution.resolvedCards.some((card) => card.id === "wrong"), false);
  assert.ok(resolution.ambiguousMentions.some((mention) => (
    mention.input === "星刻龙" && mention.candidateCards.length === 2
  )));
});

test("the reported Quem and Lubellion colloquial question resolves only the three real card identities", async () => {
  const data = await loadRagData();
  const question = "在墓地没有引导之圣女能苏生的怪兽的情况下，神炎龙C1 cost丢下去阿不思，此时导圣能不能C2发动效果，把神炎龙cost送下去的阿不思苏生？";
  const resolution = extractRagCards(question, { cards: data.cards, maxCards: 8 });

  assert.deepEqual(
    new Set(resolution.resolvedCards.map((card) => String(card.id))),
    new Set(["18474", "17070", "15245"]),
  );
  assert.deepEqual(resolution.unresolvedMentions, []);
  assert.deepEqual(resolution.ambiguousMentions, []);
});
