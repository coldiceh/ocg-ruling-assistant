import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadRagData, retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { callRulebookGroundingModel, selectPriorityConstraintEvidence } from "../backend/ragModelClient.mjs";
import { analyzeDeterministicOperationLegality, validateOperationLegalityModelOutput } from "../backend/operationLegalityAnalyzer.mjs";
import { retrieveRulebookPassages } from "../backend/rulebookPassageRetriever.mjs";
import { buildDocTargets } from "../scripts/sync-ocg-rule.mjs";

test("rule_sync_keeps_all_content_pages_including_card_resistance", () => {
  const docs = buildDocTargets({
    docnames: ["index", "c03/卡片的抗性", "c03/装备", "search"],
    titles: ["OCG Rule", "卡片的抗性", "装备", "Search"],
  });

  assert.deepEqual(docs.map((item) => item.docname), ["c03/卡片的抗性", "c03/装备"]);
});

test("rag_data_prefers_the_fresh_rulebook_corpus_over_embedded_snapshots", async () => {
  const data = await loadRagData();
  const ruleRecords = data.records.filter((record) => ["rule-doc", "rule-test"].includes(record.recordType) && record.id.startsWith("ocg-rule:"));
  const uniqueSourceIds = new Set(ruleRecords.map((record) => record.stableId || record.id));

  assert.equal(ruleRecords.length, 39);
  assert.equal(uniqueSourceIds.size, ruleRecords.length);
  assert.ok(ruleRecords.every((record) => !/@[a-f0-9]{8,}$/iu.test(record.id)));
});
test("actual_rulebook_late_paragraph_is_retrieved_as_a_passage", async () => {
  const payload = JSON.parse(await readFile(new URL("../data/ocg-rule-corpus.json", import.meta.url), "utf8"));
  const passages = retrieveRulebookPassages({
    records: payload.records || [],
    userQuery: "正在发动的通常陷阱能否被返回手卡？",
    ruleSearchQueries: [
      { query: "发动中的通常魔法 通常陷阱 回到手卡 场上的魔法陷阱", confidence: "high" },
      { query: "魔法 陷阱 连锁途中 回到手卡 卡组", confidence: "high" },
    ],
    maxPassages: 20,
  });

  const relevant = passages.find((item) => /这种魔法·陷阱卡在连锁途中不能从场上回到手卡·卡组/u.test(item.text));
  assert.ok(relevant, "expected the rulebook passage about activated Spell/Trap Cards returning to hand");
  assert.match(relevant.id, /^ocg-rule:c02\/卡片·效果的发动#p/u);
  assert.equal(relevant.type, "rulebook");
  assert.ok(relevant.sourceUrl);
});

test("actual_simultaneous_replacement_rule_is_retrieved_from_card_resistance", async () => {
  const payload = JSON.parse(await readFile(new URL("../data/ocg-rule-corpus.json", import.meta.url), "utf8"));
  const passages = retrieveRulebookPassages({
    records: payload.records || [],
    userQuery: "双方怪兽同时被破坏，双方都有代替破坏效果，如何决定顺序？",
    ruleSearchQueries: [
      { query: "同一时点 多个不入连锁效果 适用顺序 回合玩家 非回合玩家", confidence: "high" },
      { query: "同时适用 多个代替破坏效果 回合玩家先适用 重新判断", confidence: "high" },
    ],
    maxPassages: 16,
  });

  const relevant = passages.find((item) => item.id.startsWith("ocg-rule:c03/卡片的抗性#")
    && /同1时点双方都要适用代替破坏的效果时，回合玩家的先适用/u.test(item.text));
  assert.ok(relevant, "expected the simultaneous replacement ordering rule from the card resistance page");
  assert.match(relevant.text, /之后非回合玩家持有这类效果的卡已经不在场上存在的场合，不适用/u);
  assert.ok(relevant.sourceUrl);
});

test("deterministic rule queries keep the first eight ranking slots ahead of model supplements", async () => {
  const evidence = await retrieveRagEvidence({
    userQuery: [
      "连锁处理中对象离场并除外，效果无效并破坏。",
      "发动时丢弃手牌支付cost，双方同一时点适用代替破坏。",
      "不受其他卡效果影响的对象是魔法陷阱，场上没有其他卡且要回到手卡。",
      "然后复制获得有「测试卡」卡名记述的怪兽效果，后续如何处理？",
    ].join(""),
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records: [],
    qaRecords: [],
    ruleSearchQueries: Array.from({ length: 16 }, (_, index) => ({
      query: `模型补充噪声查询 ${index + 1}`,
      reason: "deepseek_preparation",
    })),
    env: {
      RAG_MAX_RULE_SEARCH_QUERIES: "16",
    },
  });

  assert.equal(evidence.ruleSearchQueries.length, 16);
  assert.ok(
    evidence.ruleSearchQueries.slice(0, 8).every((item) => item.source !== "rule_search_query"),
    "the first eight ranking queries must all come from deterministic local derivation",
  );
  assert.ok(
    evidence.ruleSearchQueries.slice(0, 8).every((item) => item.reason !== "deepseek_preparation"),
    "model supplements must not displace the deterministic ranking window",
  );
});

test("model rule queries are retained only as an append-only retrieval supplement", async () => {
  const evidence = await retrieveRagEvidence({
    userQuery: "这个效果可以发动吗？",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records: [],
    qaRecords: [],
    ruleSearchQueries: [
      { query: "模型补充查询 甲", reason: "deepseek_preparation" },
      { query: "模型补充查询 乙", reason: "deepseek_preparation" },
    ],
    env: {
      RAG_MAX_RULE_SEARCH_QUERIES: "16",
    },
  });

  const firstSupplementIndex = evidence.ruleSearchQueries.findIndex(
    (item) => item.reason === "deepseek_preparation",
  );
  assert.ok(firstSupplementIndex > 0, "the deterministic query must precede model supplements");
  assert.deepEqual(
    evidence.ruleSearchQueries.slice(firstSupplementIndex).map((item) => item.query),
    ["模型补充查询 甲", "模型补充查询 乙"],
  );
  assert.ok(
    evidence.ruleSearchQueries.slice(0, firstSupplementIndex)
      .every((item) => item.reason !== "deepseek_preparation"),
  );
});

test("model supplemental queries cannot reorder the deterministic evidence prefix", async () => {
  const request = {
    userQuery: "发动时丢弃手牌，之后特殊召唤如何处理？",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: [],
    records: [{
      id: "deterministic-evidence",
      recordType: "related",
      title: "发动与处理",
      text: "发动时丢弃手牌，之后特殊召唤如何处理？应依次确认发动手续、支付代价与效果处理。",
    }, {
      id: "supplement-only-evidence",
      recordType: "related",
      title: "补充查询专用资料",
      text: "恶意噪声精确短语 恶意噪声精确短语 恶意噪声精确短语",
    }],
    qaRecords: [],
    env: {
      RAG_MAX_RELATED_EVIDENCE: "1",
      RAG_MAX_RULE_SEARCH_QUERIES: "16",
    },
  };
  const deterministic = await retrieveRagEvidence(request);
  const supplemented = await retrieveRagEvidence({
    ...request,
    ruleSearchQueries: [{
      query: "恶意噪声精确短语",
      reason: "deepseek_preparation",
    }],
  });

  assert.equal(deterministic.rawRelatedEvidence[0].id, "deterministic-evidence");
  assert.equal(supplemented.rawRelatedEvidence[0].id, "deterministic-evidence");
});

test("actual_return_constraints_are_prioritized_for_operation_grounding", async () => {
  const data = await loadRagData();
  const resolvedCards = ["13631", "22130"]
    .map((id) => data.cards.find((card) => card.id === id))
    .filter(Boolean);
  const question = "对方场上有「绚岚之达维」，我方以达维为对象发动「无限泡影」，这个时候场上没有其他魔陷，对方能不能发动「天雷之双风神」的效果？";
  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution: {
      resolvedCards,
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
  });
  let prompt = "";
  const grounding = await callRulebookGroundingModel({
    userQuery: question,
    cardTexts: evidence.cardTexts,
    ruleEvidence: evidence.rulebookCandidates,
    qaEvidence: [...evidence.officialQaDirectCandidates, ...evidence.officialQaRelated, ...evidence.faqRelated],
    modelInvoker: async (request) => {
      prompt = request.prompt;
      return JSON.stringify({ constraintReviews: [], operationChecks: [], overallConclusion: "证据待核对。" });
    },
  });

  const priorities = grounding.operationLegality.priorityConstraintEvidence;
  assert.ok(priorities.some((item) => /这种魔法·陷阱卡在连锁途中不能从场上回到手卡·卡组/u.test(item.text)), "expected the activated Spell/Trap return restriction");
  assert.ok(priorities.some((item) => /除自身以外没有能适用的卡时不能发动/u.test(item.text)), "expected the no-applicable-card activation restriction");
  assert.ok(priorities.length <= 5);
  assert.match(prompt, /priorityConstraintCandidates/u);
  assert.match(prompt, /只说明诱发条件或可连锁时点的一般卡片 FAQ/u);
});

test("unrelated_restrictive_examples_are_not_promoted_to_mandatory_constraints", () => {
  const priorities = selectPriorityConstraintEvidence({
    userQuery: "我方召唤「阿尔白斯之落胤」，丢弃「教导的圣女 艾克莉西娅」作为cost，能否与对方的「吞食圣痕之龙」融合召唤「冰剑龙 幻冰龙」？",
    cardTexts: [{
      title: "阿尔白斯之落胤",
      cardType: "怪兽",
      text: "这张卡召唤成功的场合，丢弃1张手卡才能发动。用包含这张卡的自己・对方场上的怪兽作为融合素材。",
    }],
    items: [{
      id: "rulebook-unrelated-trigger-location",
      type: "rulebook",
      title: "诱发效果的发动位置",
      text: "卡片不在满足诱发条件的位置时不能发动。\n\n发动魔法・陷阱卡时，必须先确认连锁时点。",
    }],
  });

  assert.deepEqual(priorities, []);
});

test("priority_constraint_keeps_only_the_matched_restrictive_paragraph", () => {
  const [priority] = selectPriorityConstraintEvidence({
    userQuery: "对方发动通常陷阱，场上没有其他魔法陷阱。我能否发动效果将场上的魔法陷阱全部返回手卡？",
    cardTexts: [{
      title: "返回效果",
      cardType: "怪兽",
      text: "对手发动魔法・陷阱卡时可以发动。将场上的魔法・陷阱卡全部返回手牌。",
    }],
    items: [{
      id: "rulebook-active-card-return-restriction",
      type: "rulebook",
      title: "发动中的卡片",
      text: "正在发动或连锁处理中的非永续魔法・陷阱卡不能从场上返回手牌。\n\n与本题无关的怪兽不能特殊召唤。",
    }],
  });

  assert.equal(priority.priorityConstraintSignature, "active_spell_trap_return");
  assert.match(priority.text, /不能从场上返回手牌/u);
  assert.doesNotMatch(priority.text, /特殊召唤/u);
});

test("actual_xyz_encore_faq_is_retrieved_for_unaffected_rhongomyniad", async () => {
  const data = await loadRagData();
  const resolvedCards = ["10820", "11296"]
    .map((id) => data.cards.find((card) => card.id === id))
    .filter(Boolean);
  const evidence = await retrieveRagEvidence({
    userQuery: "持有三个X素材的「NO.86 英豪冠军 击灭枪王」能否成为「超量叠光延迟」的对象？",
    cardResolution: {
      resolvedCards,
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
  });

  const faq = evidence.faqRelated.find((item) => item.id === "card-faq-10820-1");
  assert.ok(faq, "expected Xyz Encore FAQ 1 to be retrieved");
  assert.match(faq.text, /X素材.*全て取り除/u);
  assert.match(faq.sourceUrl, /www\.db\.yugioh-card\.com\/yugiohdb\/faq_search\.action/u);

  const exactRuleIndex = evidence.rulebookCandidates.findIndex((item) => (
    /No\.86 英豪冠军 击灭枪王/u.test(item.text)
    && /超量叠光延迟/u.test(item.text)
    && /后续效果/u.test(item.text)
  ));
  assert.ok(exactRuleIndex >= 0, "expected the exact No.86 and Xyz Encore rule example");
  assert.ok(exactRuleIndex < 3, `expected exact scenario evidence near the top, got rank ${exactRuleIndex + 1}`);
});


test("rulebook_passage_keeps_the_matched_paragraph_when_context_is_too_long", () => {
  const marker = "命中规则：卡的发动被无效后，不再视为场上的卡。";
  const passages = retrieveRulebookPassages({
    records: [{
      id: "ocg-rule:test-focus",
      recordType: "rule-doc",
      title: "测试规则",
      text: [
        "无关前文".repeat(160),
        marker,
        "无关后文".repeat(160),
      ].join("\n\n"),
      sourceUrl: "https://example.test/rule",
    }],
    userQuery: "卡的发动被无效后是否仍视为场上的卡？",
    ruleSearchQueries: [{ query: "卡的发动 无效 场上的卡", confidence: "high" }],
    maxPassages: 3,
    maxPassageChars: 180,
  });

  assert.ok(passages.length > 0);
  assert.match(passages[0].text, /命中规则：卡的发动被无效后，不再视为场上的卡/u);
  assert.ok(passages[0].text.length <= 180);
});

test("inline_card_references_link_the_stardust_official_qa", async () => {
  const data = await loadRagData();
  const resolvedCards = ["4678", "16386", "7734"]
    .map((id) => data.cards.find((card) => card.id === id))
    .filter(Boolean);
  const evidence = await retrieveRagEvidence({
    userQuery: "我方C1发动「神鹰羽毛扫」，对手C2连锁「鲜花之女男爵」的无效并破坏效果，我方是否可以C3发动「星尘龙」？",
    cardResolution: {
      resolvedCards,
      unresolvedMentions: [],
      ambiguousMentions: [],
      userProvidedCardTexts: [],
    },
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
  });

  const qa = evidence.officialQaRelated.find((item) => item.id === "ygoresources-qa-11290");
  assert.ok(qa, "expected the official Stardust activation-negation analogy to be retrieved");
  assert.ok(qa.cardIds.includes("7734"), "expected <<7734>> to be indexed as a referenced card");
  assert.match(
    qa.text,
    /(?:not treated as being on the field|フィールドで破壊された扱いにはなりません|不视为在场上破坏)/iu,
  );
});

test("grounding_candidate_budget_preserves_faq_rulebook_and_card_text", async () => {
  const noisyRelated = Array.from({ length: 12 }, (_, index) => ({
    id: `related-${index + 1}`,
    type: "related",
    recordType: "qa",
    title: `相似问答 ${index + 1}`,
    text: `只与卡名相关但没有覆盖关键处理的问答 ${index + 1}`,
  }));
  const faq = {
    id: "card-faq-critical",
    type: "faq",
    recordType: "card-faq",
    title: "关键卡片 FAQ",
    text: "关键 FAQ 原文：这个处理仍然进行。",
  };
  const rule = {
    id: "rulebook-critical",
    type: "rulebook",
    recordType: "rulebook",
    title: "关键规则",
    text: "关键规则原文：逐项处理效果。",
  };
  const cardText = {
    id: "card-text-critical",
    type: "card_text",
    title: "关键卡片文本",
    text: "关键卡文原文：然后，挑选一张手牌舍弃。",
  };
  let prompt = "";

  await callRulebookGroundingModel({
    userQuery: "这个效果如何处理？",
    qaEvidence: [...noisyRelated, faq],
    ruleEvidence: [rule],
    cardTexts: [cardText],
    env: { RAG_MAX_QA_GROUNDING_CANDIDATES: "4" },
    modelInvoker: async (request) => {
      prompt = request.prompt;
      return JSON.stringify({ operationChecks: [], overallConclusion: "证据不足。" });
    },
  });

  assert.match(prompt, /card-faq-critical/u);
  assert.match(prompt, /rulebook-critical/u);
  assert.match(prompt, /card-text-critical/u);
  assert.match(prompt, /关键 FAQ 原文/u);
  assert.match(prompt, /关键规则原文/u);
  assert.match(prompt, /关键卡文原文/u);
});
test("localized_constraint_review_enums_produce_a_grounded_blocker", () => {
  const rule = {
    id: "rulebook-localized-constraint",
    type: "rulebook",
    title: "发动中的魔法陷阱返回限制",
    text: "正在发动或连锁处理中的非永续魔法・陷阱卡不能从场上返回手牌。",
  };
  const result = validateOperationLegalityModelOutput({
    constraintReviews: [{
      evidenceId: rule.id,
      operationId: "return-active-trap",
      action: "将正在发动的陷阱返回手牌",
      relevance: "适用",
      consequence: "阻止",
      application: "题目明确该陷阱正在当前连锁发动，因此满足这条返回限制。",
    }],
    operationChecks: [],
    overallConclusion: "不能发动。",
  }, [rule], { requiredConstraintEvidence: [rule] });

  assert.equal(result.hasBlockingCheck, true);
  assert.equal(result.hasUnresolvedConstraints, false);
  assert.match(result.shortAnswer, /返回限制/u);
  assert.ok(result.warnings.some((item) => item.includes("constraint_quote_recovered")));
});

test("grounded_operation_check_completes_its_priority_constraint_review", () => {
  const rule = {
    id: "rulebook-activation-restriction",
    type: "rulebook",
    title: "区域不同时限制不适用",
    text: "只有那张卡仍在场上时，这项限制才适用；已经在墓地的卡不受这项限制。",
  };
  const result = validateOperationLegalityModelOutput({
    constraintReviews: [],
    operationChecks: [{
      operationId: "check-updated-zone",
      step: 1,
      action: "按支付 cost 后的位置核对限制",
      status: "legal",
      conclusion: "该卡已经作为 cost 送去墓地，因此场上限制不适用。",
      citations: [{
        id: rule.id,
        quote: "只有那张卡仍在场上时，这项限制才适用",
        application: "题目中的卡已经作为 cost 送去墓地，不再满足规则要求的场上条件。",
      }],
    }],
    overallConclusion: "可以继续处理。",
  }, [rule], { requiredConstraintEvidence: [rule] });

  assert.equal(result.hasGroundedChecks, true);
  assert.equal(result.hasUnresolvedConstraints, false);
  assert.ok(result.warnings.includes("operation_constraint_review_inferred_from_grounded_check:" + rule.id));
});

test("generic_legal_check_cannot_bypass_restrictive_rule_without_non_applicability_comparison", () => {
  const rule = {
    id: "rulebook-active-card-return-restriction",
    type: "rulebook",
    title: "发动中卡片的返回限制",
    text: "正在发动的通常陷阱不能返回手牌；没有其他可返回卡片时，该返回效果不能发动。",
  };
  const result = validateOperationLegalityModelOutput({
    constraintReviews: [],
    operationChecks: [{
      operationId: "check-general-trigger",
      step: 1,
      action: "检查一般连锁时点",
      status: "legal",
      conclusion: "对手发动陷阱，因此满足一般连锁时点。",
      citations: [{
        id: rule.id,
        quote: "正在发动的通常陷阱不能返回手牌",
        application: "虽然该陷阱不能返回手牌，但一般连锁时点仍然满足。",
      }],
    }],
    overallConclusion: "可以发动。",
  }, [rule], { requiredConstraintEvidence: [rule] });

  assert.equal(result.hasGroundedChecks, true);
  assert.equal(result.hasBlockingCheck, true);
  assert.equal(result.hasUnresolvedConstraints, false);
  assert.match(result.shortAnswer, /不能发动/u);
  assert.ok(result.warnings.includes("operation_blocker_derived_from_combined_constraint_evidence"));
});

test("card-text mechanics retrieve and enforce the Double Wind mandatory return restrictions", async () => {
  const data = await loadRagData();
  const question = "双方后场只有刚发动的「无限泡影」；对方场上有风属性怪兽，我方能否发动「天雷之双风神 息那」①效果？";
  const resolvedCards = data.cards
    .filter((card) => ["无限泡影", "天雷之双风神 息那"].includes(card.name))
    .map((card) => ({ ...card, input: card.name, confidence: 1 }));
  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution: { resolvedCards, unresolvedMentions: [], ambiguousMentions: [], userProvidedCardTexts: [] },
    cards: data.cards,
    records: data.records,
    qaRecords: data.qaRecords,
  });
  assert.ok(evidence.ruleSearchQueries.some((item) => /连锁途中.*回到手卡/u.test(item.query)));
  assert.ok(evidence.ruleSearchQueries.some((item) => /除自身以外没有能适用/u.test(item.query)));
  assert.ok(evidence.rulebookCandidates.some((item) => /这种魔法[・·]陷阱卡在连锁途中不能/u.test(item.text)));
  assert.ok(evidence.rulebookCandidates.some((item) => /除自身以外没有能适用的卡时不能发动/u.test(item.text)));

  const grounding = await callRulebookGroundingModel({
    userQuery: question,
    cardTexts: evidence.cardTexts,
    ruleEvidence: evidence.rulebookCandidates,
    qaEvidence: [],
    modelInvoker: async () => JSON.stringify({ operationChecks: [], constraintReviews: [] }),
  });
  assert.equal(grounding.operationLegality.hasBlockingCheck, true);
  assert.match(grounding.operationLegality.shortAnswer, /不能发动/u);
});

test("replacement card text and player roles retrieve the turn-player-first rule without answer keywords", async () => {
  const data = await loadRagData();
  const replacementCard = {
    id: "synthetic-replacement-card",
    name: "测试代破兽",
    cnName: "测试代破兽",
    aliases: ["测试代破兽"],
    cardType: "monster",
    effectText: "这张卡被战斗破坏的场合，可以作为代替把自己场上其他1只怪兽破坏。",
  };
  const question = "轮到我，我方「测试代破兽」攻击对方「测试代破兽」，两只在这次战斗都要被破坏；我方另有1只怪兽，两边各自的效果怎么处理？";
  const evidence = await retrieveRagEvidence({
    userQuery: question,
    cardResolution: { resolvedCards: [{ ...replacementCard, input: replacementCard.name }], unresolvedMentions: [], ambiguousMentions: [], userProvidedCardTexts: [] },
    cards: [...data.cards, replacementCard],
    records: data.records,
    qaRecords: data.qaRecords,
  });
  assert.ok(evidence.ruleSearchQueries.some((item) => /回合玩家.*先适用.*非回合玩家/u.test(item.query)));
  assert.ok(evidence.rulebookCandidates.some((item) => /同1时点双方都要适用代替破坏/u.test(item.text)));

  const grounding = await callRulebookGroundingModel({
    userQuery: question,
    cardTexts: evidence.cardTexts,
    ruleEvidence: evidence.rulebookCandidates,
    qaEvidence: [],
    modelInvoker: async () => JSON.stringify({ operationChecks: [], constraintReviews: [] }),
  });
  const check = grounding.operationLegality.checks.find((item) => item.operationId === "simultaneous-destruction-replacement-order");
  assert.ok(check);
  assert.equal(check.status, "conditional");
  assert.match(check.conclusion, /先适用回合玩家.*重新检查非回合玩家/u);
  assert.equal(grounding.operationLegality.hasUnresolvedConstraints, false);
});

test("deterministic local analysis blocks mandatory return when the only candidate is the resolving trap", () => {
  const activeCardRule = {
    id: "neutral-rule-active-card",
    type: "rulebook",
    title: "发动中卡片的位置限制",
    text: "正在发动或连锁处理中的非永续魔法・陷阱卡不能从场上返回手牌。",
  };
  const noCandidateRule = {
    id: "neutral-rule-no-candidate",
    type: "rulebook",
    title: "必做处理的发动条件",
    text: "除自身以外没有能适用的卡时不能发动。",
  };
  const result = analyzeDeterministicOperationLegality({
    userQuery: "双方魔法陷阱区域只有刚刚发动的「测试通常陷阱」。我方能否使用「测试回手者」的效果？",
    cardTexts: [{
      id: "neutral-returner",
      type: "card_text",
      title: "测试回手者",
      cardType: "monster",
      text: "对手发动魔法・陷阱卡时可以发动。从手牌将此卡特殊召唤。然后，将场上的魔法・陷阱卡全部放回手牌。",
    }, {
      id: "neutral-trap",
      type: "card_text",
      title: "测试通常陷阱",
      cardType: "trap",
      text: "以场上1只怪兽为对象发动。那只怪兽的效果无效。",
    }],
    ruleEvidence: [activeCardRule, noCandidateRule],
  });

  assert.equal(result.deterministic, true);
  assert.equal(result.complete, true);
  assert.equal(result.hasBlockingCheck, true);
  assert.match(result.shortAnswer, /不能发动/u);
  assert.doesNotMatch(result.shortAnswer, /天雷|无限泡影/u);
});

test("deterministic local analysis blocks a reveal procedure while the actor's hand is already public", () => {
  const result = analyzeDeterministicOperationLegality({
    userQuery: "我方「测试公开领域」的效果适用中，我方有手牌。我方能发动「测试展示陷阱」吗？",
    cardTexts: [{
      id: "neutral-public-hand",
      type: "card_text",
      title: "测试公开领域",
      cardType: "spell",
      text: "双方玩家根据自身场上的怪兽对自身适用以下效果。光：自己的手牌全部持续公开。",
    }, {
      id: "neutral-reveal-trap",
      type: "card_text",
      title: "测试展示陷阱",
      cardType: "trap",
      text: "把自己的全部手牌给对方观看，支付1000基本分可以发动。选对方手牌1张除外。",
    }],
    ruleEvidence: [{
      id: "neutral-rule-public-hand",
      type: "faq",
      title: "持续公开与展示手续",
      text: "自己的手牌已经因其他卡的效果持续公开的情况下，不能发动需要把自己的手牌给对方观看的效果。",
    }],
  });

  const check = result.checks.find((item) => item.operationId === "public-hand-reveal-activation-procedure");
  assert.ok(check);
  assert.equal(check.status, "illegal");
  assert.equal(result.deterministic, true);
  assert.equal(result.complete, true);
  assert.equal(result.hasBlockingCheck, true);
  assert.match(result.shortAnswer, /^不能发动/u);
  assert.doesNotMatch(result.shortAnswer, /红莲|看透/u);
});

test("public opponent hand does not block the actor from revealing their own hand", () => {
  const result = analyzeDeterministicOperationLegality({
    userQuery: "我方控制「测试透视镜」且效果适用中，我方有手牌。我方能发动「测试展示陷阱」吗？",
    cardTexts: [{
      id: "neutral-opponent-hand",
      type: "card_text",
      title: "测试透视镜",
      cardType: "trap",
      text: "只要这张卡存在于魔法与陷阱区域，对方必须持续公开手牌。",
    }, {
      id: "neutral-reveal-trap",
      type: "card_text",
      title: "测试展示陷阱",
      cardType: "trap",
      text: "把自己的全部手牌给对方观看，支付1000基本分可以发动。选对方手牌1张除外。",
    }],
    ruleEvidence: [{
      id: "neutral-rule-public-hand",
      type: "faq",
      title: "持续公开与展示手续",
      text: "自己的手牌已经因其他卡的效果持续公开的情况下，不能发动需要把自己的手牌给对方观看的效果。",
    }],
  });

  assert.equal(result.hasBlockingCheck, false);
  assert.equal(
    result.checks.some((item) => item.operationId === "public-hand-reveal-activation-procedure"),
    false,
  );
});

test("a public self hand does not block the opponent's separate reveal activation", () => {
  const result = analyzeDeterministicOperationLegality({
    userQuery: "我方「测试公开领域」的效果适用中。对方能发动「测试展示陷阱」吗？",
    cardTexts: [{
      id: "neutral-public-hand",
      type: "card_text",
      title: "测试公开领域",
      text: "只要这张卡存在，自己的手牌全部持续公开。",
    }, {
      id: "neutral-reveal-trap",
      type: "card_text",
      title: "测试展示陷阱",
      text: "把自己的全部手牌给对方观看可以发动。选对方手牌1张除外。",
    }],
    ruleEvidence: [{
      id: "neutral-rule-public-hand",
      type: "faq",
      title: "测试展示陷阱 FAQ",
      cardIds: ["neutral-reveal-trap"],
      text: "自己的手牌已经因其他卡的效果持续公开时，不能发动。",
    }],
  });

  assert.equal(result.scenario.revealActivationOperations[0]?.actor, "opponent");
  assert.equal(result.scenario.selfHandContinuouslyPublic, true);
  assert.equal(result.scenario.opponentHandContinuouslyPublic, false);
  assert.equal(result.hasBlockingCheck, false);
});

test("a reveal FAQ explicitly belonging to another card cannot create a deterministic blocker", () => {
  const result = analyzeDeterministicOperationLegality({
    userQuery: "我方「测试公开领域」的效果适用中。我方能发动「测试展示陷阱」吗？",
    cardTexts: [{
      id: "neutral-public-hand",
      type: "card_text",
      title: "测试公开领域",
      text: "只要这张卡存在，自己的手牌全部持续公开。",
    }, {
      id: "neutral-reveal-trap",
      type: "card_text",
      title: "测试展示陷阱",
      text: "把自己的全部手牌给对方观看可以发动。选对方手牌1张除外。",
    }],
    ruleEvidence: [{
      id: "unrelated-card-faq",
      type: "faq",
      title: "其他卡 FAQ",
      cardIds: ["different-card"],
      text: "自己的手牌已经因其他卡的效果持续公开时，不能发动。",
    }],
  });

  assert.equal(result.scenario.publicHandRevealProcedureBlocked, true);
  assert.equal(result.hasBlockingCheck, false);
  assert.equal(
    result.checks.some((item) => item.operationId === "public-hand-reveal-activation-procedure"),
    false,
  );
});

test("deterministic local analysis completes turn-player-first replacement after the other carrier is destroyed", () => {
  const rule = {
    id: "neutral-rule-replacement-order",
    type: "rulebook",
    title: "同一时点双方的代替破坏",
    text: "同1时点双方都要适用代替破坏的效果时，回合玩家的先适用，之后非回合玩家持有这类效果的卡已经不在场上存在的场合，不适用。",
  };
  const replacementText = "这张卡被战斗破坏的场合，可以作为代替把场上其他1只表侧表示怪兽破坏。";
  const result = analyzeDeterministicOperationLegality({
    userQuery: "我方回合，双方的「测试代破兽」在这次战斗中都要被破坏。我方先适用代替效果，作为自身破坏的代替将对方的「测试代破兽」破坏。对方还能适用其效果吗？",
    cardTexts: [{
      id: "neutral-replacement-carrier",
      type: "card_text",
      title: "测试代破兽",
      cardType: "monster",
      text: replacementText,
    }],
    ruleEvidence: [rule],
  });

  const check = result.checks.find((item) => item.operationId === "simultaneous-destruction-replacement-order");
  assert.ok(check);
  assert.equal(check.status, "legal");
  assert.deepEqual(check.missingFacts, []);
  assert.equal(result.deterministic, true);
  assert.equal(result.complete, true);
  assert.match(result.shortAnswer, /非回合玩家.*不再适用/u);
  assert.doesNotMatch(result.shortAnswer, /破械/u);
});

test("deterministic local analysis applies the turn player's replacement first and stops dependent summon", () => {
  const rule = {
    id: "neutral-rule-replacement-order-follow-up",
    type: "rulebook",
    title: "同一时点双方的代替破坏",
    text: "同1时点双方都要适用代替破坏的效果时，回合玩家的先适用，之后非回合玩家持有这类效果的卡已经不在场上存在的场合，不适用。",
  };
  const result = analyzeDeterministicOperationLegality({
    userQuery: "对方从手牌发动「测试召唤者」的效果，以对方场上的「第一载体」为对象破坏。对方选择适用第一载体的代替效果，作为自身破坏的代替将我方的「第二载体」破坏。此时我方第二载体可以适用降低1000攻击力作为被破坏的代替吗？测试召唤者还会特殊召唤吗？",
    cardTexts: [{
      id: "neutral-destroy-summoner",
      type: "card_text",
      title: "测试召唤者",
      cardType: "monster",
      text: "自己主要阶段，以自己场上1只怪兽为对象可以从手牌发动。将那只怪兽破坏，那之后，从手牌将此卡特殊召唤。",
    }, {
      id: "neutral-first-carrier",
      type: "card_text",
      title: "第一载体",
      cardType: "monster",
      text: "场上的这张卡要被效果破坏的场合，可以作为代替把场上其他1张表侧表示卡破坏。",
    }, {
      id: "neutral-second-carrier",
      type: "card_text",
      title: "第二载体",
      cardType: "monster",
      text: "这张卡要被效果破坏的场合，可以作为代替使这张卡的攻击力下降1000。",
    }],
    ruleEvidence: [rule],
  });

  const check = result.checks.find((item) => item.operationId === "simultaneous-destruction-replacement-order");
  assert.ok(check);
  assert.equal(check.status, "legal");
  assert.equal(result.deterministic, true);
  assert.equal(result.complete, true);
  assert.equal(result.hasBlockingCheck, false);
  assert.match(result.shortAnswer, /降攻代替不再适用/u);
  assert.match(result.shortAnswer, /原本选择的破坏对象没有被破坏/u);
  assert.match(result.shortAnswer, /后续特殊召唤不处理/u);
  assert.doesNotMatch(result.shortAnswer, /完美电子|破械/u);
});

test("focused_state_transition_review_separates_cost_from_effect_processing", async () => {
  const activator = {
    id: "card-text-activator",
    type: "card_text",
    title: "发动效果",
    text: "这张卡召唤成功的场合，舍弃1张手牌可以发动。将双方场上的怪兽作为融合素材进行融合召唤。",
  };
  const immunity = {
    id: "card-text-immunity",
    type: "card_text",
    title: "条件抗性",
    text: "只要场上或墓地存在指定怪兽，这张卡不受自身以外的效果影响。",
  };
  const costRule = {
    id: "rulebook-cost-state-transition",
    type: "rulebook",
    title: "支付 cost 后的状态",
    text: "效果发动时先支付cost。支付完成造成的位置变化立即成立，再按当前场面处理连锁。",
  };
  const tasks = [];
  const result = await callRulebookGroundingModel({
    userQuery: "召唤成功后舍弃指定怪兽作为cost发动效果；该怪兽进入墓地后使对方怪兽获得效果抗性，之后如何处理？",
    cardTexts: [activator, immunity],
    ruleEvidence: [costRule],
    modelInvoker: async ({ task }) => {
      tasks.push(task);
      if (task === "rulebook_grounding") {
        return JSON.stringify({
          constraintReviews: [],
          operationChecks: [{
            operationId: "activation-only",
            step: 1,
            action: "发动并支付cost",
            status: "legal",
            conclusion: "可以发动并支付cost。",
            citations: [{
              id: activator.id,
              quote: "舍弃1张手牌可以发动。",
              application: "题目有可舍弃的手牌。",
            }],
          }],
          overallConclusion: "可以发动。",
        });
      }
      assert.equal(task, "rulebook_state_transition_repair");
      return JSON.stringify({
        constraintReviews: [],
        operationChecks: [
          {
            operationId: "activate-and-pay-cost",
            step: 1,
            action: "发动并舍弃手牌",
            status: "legal",
            conclusion: "可以发动，舍弃手牌作为cost。",
            citations: [{ id: activator.id, quote: "舍弃1张手牌可以发动。", application: "发动时支付cost。" }],
          },
          {
            operationId: "recalculate-after-cost",
            step: 2,
            action: "按cost支付后的场面重新适用抗性",
            status: "legal",
            conclusion: "手牌进入墓地后，条件抗性在效果处理前开始适用。",
            citations: [
              { id: costRule.id, quote: "支付完成造成的位置变化立即成立", application: "舍弃后区域立即更新。" },
              { id: immunity.id, quote: "只要场上或墓地存在指定怪兽", application: "cost支付后已满足墓地条件。" },
            ],
          },
          {
            operationId: "resolve-with-immunity",
            step: 3,
            action: "处理融合效果",
            status: "conditional",
            conclusion: "可以发动，但抗性使该怪兽不受效果影响，因此不进行后续融合处理。",
            citations: [{ id: immunity.id, quote: "这张卡不受自身以外的效果影响。", application: "处理时抗性已经适用。" }],
          },
        ],
        overallConclusion: "可以发动并支付cost；处理时因新适用的抗性而不进行融合召唤。",
      });
    },
  });

  assert.deepEqual(tasks, ["rulebook_grounding", "rulebook_state_transition_repair"]);
  assert.equal(result.operationLegality.checks.length, 4);
  assert.match(result.operationLegality.shortAnswer, /^可以发动并支付cost/u);
  assert.match(result.operationLegality.shortAnswer, /不进行融合召唤/u);
  assert.ok(result.warnings.includes("rulebook_grounding_focused_repair_applied"));
});
test("focused_constraint_repair_resolves_a_missed_restrictive_rule", async () => {
  const rule = {
    id: "rulebook-focused-return-constraint",
    type: "rulebook",
    recordType: "rulebook",
    title: "连锁处理中魔法陷阱的返回限制",
    text: "正在发动或连锁处理中的非永续魔法・陷阱卡不能从场上返回手牌。场上没有其他可返回的魔法・陷阱卡时，要求返回卡片的效果不能发动。",
    sourceUrl: "https://example.test/return-rule",
  };
  const triggerText = {
    id: "card-text-returner",
    type: "card_text",
    title: "返回效果卡片文本",
    text: "对手发动魔法・陷阱卡时可以发动。将场上的魔法・陷阱卡全部返回手牌。",
  };
  const calls = [];
  const result = await callRulebookGroundingModel({
    userQuery: "对方连锁发动通常陷阱，场上没有其他魔法陷阱。我能否发动效果把那张正在连锁处理的陷阱返回手牌？",
    ruleEvidence: [rule],
    qaEvidence: [],
    cardTexts: [triggerText],
    modelInvoker: async ({ task, prompt, maxTokens }) => {
      calls.push({ task, prompt, maxTokens });
      if (task === "rulebook_grounding") {
        return JSON.stringify({
          constraintReviews: [],
          operationChecks: [{
            operationId: "check-trigger-window",
            step: 1,
            action: "检查一般发动时点",
            status: "legal",
            conclusion: "对手发动陷阱时满足一般发动时点。",
            citations: [{
              id: triggerText.id,
              quote: "对手发动魔法・陷阱卡时可以发动。",
              application: "题目明确对手正在发动通常陷阱，因此一般发动时点满足。",
            }],
          }],
          overallConclusion: "尚未核对。",
        });
      }
      return JSON.stringify({
        constraintReviews: [{
          evidenceId: rule.id,
          operationId: "return-active-trap",
          action: "将正在发动的通常陷阱返回手牌",
          relevance: "applies",
          consequence: "blocks",
          conclusion: "正在处理的通常陷阱不能作为必做返回处理的适用卡，因此该效果不能发动。",
          quote: "正在发动或连锁处理中的非永续魔法・陷阱卡不能从场上返回手牌。",
          application: "题目明确唯一候选是正在当前连锁处理中发动的通常陷阱，规则直接阻止返回。",
        }],
        operationChecks: [],
        overallConclusion: "不能发动。",
      });
    },
  });

  assert.deepEqual(calls.map((item) => item.task), ["rulebook_grounding", "rulebook_constraint_repair"]);
  const repairCall = calls.find((item) => item.task === "rulebook_constraint_repair");
  assert.ok(repairCall.maxTokens >= 1600);
  assert.match(repairCall.prompt, /operationChecks 固定输出空数组/u);
  assert.equal(result.operationLegality.hasBlockingCheck, true);
  assert.equal(result.operationLegality.hasUnresolvedConstraints, false);
  assert.ok(result.operationLegality.checks.some((item) => item.operationId === "check-trigger-window"));
  assert.ok(result.warnings.includes("rulebook_grounding_focused_repair_applied"));
  assert.match(result.operationLegality.shortAnswer, /不能发动/u);
});
test("focused_constraint_review_survives_primary_grounding_failure", async () => {
  const rule = {
    id: "rulebook-focused-timeout-fallback",
    type: "rulebook",
    recordType: "rulebook",
    title: "发动中的魔法陷阱返回限制",
    text: "正在发动或连锁处理中的非永续魔法・陷阱卡不能从场上返回手牌。场上没有其他可返回的魔法・陷阱卡时，要求返回卡片的效果不能发动。",
    sourceUrl: "https://example.test/return-rule",
  };
  const calls = [];
  const result = await callRulebookGroundingModel({
    userQuery: "对方发动通常陷阱，场上没有其他魔法陷阱。我能否连锁发动把场上魔法陷阱全部返回手牌的效果？",
    ruleEvidence: [rule],
    cardTexts: [{
      id: "card-text-return-effect",
      type: "card_text",
      title: "返回效果",
      text: "对手发动魔法・陷阱卡时可以发动。将场上的魔法・陷阱卡全部返回手牌。",
    }],
    modelInvoker: async ({ task }) => {
      calls.push(task);
      if (task === "rulebook_grounding") {
        throw new Error("rulebook_grounding_model_timeout");
      }
      return JSON.stringify({
        constraintReviews: [{
          evidenceId: rule.id,
          operationId: "return-active-trap",
          action: "将正在发动的通常陷阱返回手牌",
          relevance: "applies",
          consequence: "blocks",
          conclusion: "唯一候选不能返回，因此该效果不能发动。",
          quote: "正在发动或连锁处理中的非永续魔法・陷阱卡不能从场上返回手牌。",
          application: "题目明确场上没有其他魔法陷阱，唯一候选是正在当前连锁发动的通常陷阱。",
        }],
        operationChecks: [],
        overallConclusion: "不能发动。",
      });
    },
  });

  assert.deepEqual(calls, ["rulebook_grounding", "rulebook_constraint_repair"]);
  assert.equal(result.operationLegality.hasBlockingCheck, true);
  assert.equal(result.operationLegality.hasUnresolvedConstraints, false);
  assert.ok(result.warnings.includes("rulebook_grounding_focused_fallback_applied"));
  assert.ok(result.warnings.includes("rulebook_grounding_primary_failed:rulebook_grounding_model_timeout"));
  assert.match(result.operationLegality.shortAnswer, /不能发动/u);
});
test("focused_constraint_review_survives_primary_provider_timeout", async () => {
  const rule = {
    id: "rulebook-provider-timeout-fallback",
    type: "rulebook",
    recordType: "rulebook",
    title: "发动中的魔法陷阱返回限制",
    text: "正在发动或连锁处理中的非永续魔法・陷阱卡不能从场上返回手牌。场上没有其他可返回的魔法・陷阱卡时，要求返回卡片的效果不能发动。",
  };
  const prompts = [];
  const focusedOutput = JSON.stringify({
    constraintReviews: [{
      evidenceId: rule.id,
      operationId: "return-active-trap",
      action: "将正在发动的通常陷阱返回手牌",
      relevance: "applies",
      consequence: "blocks",
      conclusion: "唯一候选不能返回，因此该效果不能发动。",
      quote: "正在发动或连锁处理中的非永续魔法・陷阱卡不能从场上返回手牌。",
      application: "题目明确唯一候选是正在当前连锁发动的通常陷阱。",
    }],
    operationChecks: [],
    overallConclusion: "不能发动。",
  });
  const result = await callRulebookGroundingModel({
    userQuery: "对方发动通常陷阱，场上没有其他魔法陷阱。我能否连锁发动把场上魔法陷阱全部返回手牌的效果？",
    ruleEvidence: [rule],
    cardTexts: [{
      id: "card-text-provider-return-effect",
      type: "card_text",
      title: "返回效果",
      text: "对手发动魔法・陷阱卡时可以发动。将场上的魔法・陷阱卡全部返回手牌。",
    }],
    env: {
      RAG_MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      RAG_RULEBOOK_MODEL_TIMEOUT_MS: "5",
      RAG_RULEBOOK_REPAIR_TIMEOUT_MS: "100",
      RAG_DAILY_BUDGET_CNY: "100",
    },
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages[0].content;
      prompts.push(prompt);
      if (!prompt.includes("本次聚焦输入")) return new Promise(() => {});
      return new Response(JSON.stringify({
        choices: [{ message: { content: focusedOutput }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(prompts.length, 2);
  assert.equal(result.operationLegality.hasBlockingCheck, true);
  assert.equal(result.operationLegality.hasUnresolvedConstraints, false);
  assert.ok(result.warnings.includes("rulebook_grounding_focused_fallback_applied"));
  assert.ok(result.warnings.includes("rulebook_grounding_primary_failed:rulebook_grounding_model_timeout"));
});
