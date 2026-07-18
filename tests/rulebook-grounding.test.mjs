import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadRagData, retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { callRulebookGroundingModel, selectPriorityConstraintEvidence } from "../backend/ragModelClient.mjs";
import { validateOperationLegalityModelOutput } from "../backend/operationLegalityAnalyzer.mjs";
import { retrieveRulebookPassages } from "../backend/rulebookPassageRetriever.mjs";

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

  const priorityIds = grounding.operationLegality.priorityConstraintEvidence.map((item) => item.id);
  assert.ok(priorityIds.some((id) => id.includes("卡片·效果的发动#p263-267")), "expected the activated Spell/Trap return restriction");
  assert.ok(priorityIds.some((id) => id.includes("卡片·效果的发动#p285-289")), "expected the no-applicable-card activation restriction");
  assert.ok(priorityIds.length <= 3);
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
  assert.match(qa.text, /not treated as being on the field/iu);
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
  assert.equal(result.hasUnresolvedConstraints, true);
  assert.ok(result.warnings.some((item) => item.startsWith("operation_constraint_review_missing:")));
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
