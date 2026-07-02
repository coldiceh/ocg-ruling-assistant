export function buildConditionalBranchAnswer({ question, contextPack = {}, officialMatches = {}, damageStepAnalysis = null, triggerTimingAnalysis = null, reason = "" } = {}) {
  const text = String(question || "");
  const branches = [];
  const requiredFacts = [];

  if (damageStepAnalysis?.isDamageStep && damageStepAnalysis.subphase === "unknown_damage_step_timing") {
    branches.push(
      { condition: "如果是伤害计算前", result: "攻守数值变化类、发动无效类等允许类别可继续检查其具体发动条件。" },
      { condition: "如果是普通快速效果", result: "通常还需要卡片文本明确允许，或需要直接官方依据。" },
    );
    requiredFacts.push("伤害步骤中的具体子阶段：开始时、伤害计算前、伤害计算时、伤害计算后或结束时");
  }

  if (triggerTimingAnalysis?.status === "insufficient_info") {
    branches.push(
      { condition: "如果诱发事件是处理中的最后事件", result: "可选的“当……时”诱发可以继续检查其他发动条件。" },
      { condition: "如果诱发事件后又发生了不同事件", result: "可选的“当……时”诱发可能错过时点。" },
    );
    requiredFacts.push("诱发事件之后是否还有其他事件发生，以及这些事件是否同时发生");
  }

  if (/对象|対象|target/iu.test(text) && /处理时|离场|不在场|不受影响|resolution/iu.test(text)) {
    branches.push(
      { condition: "如果处理时对象仍然合法", result: "按效果文本继续处理。" },
      { condition: "如果对象已经离场或不再满足对象条件", result: "该对象相关处理不适用；其他独立处理仍按文本判断。" },
    );
    requiredFacts.push("处理时对象所在区域及是否仍满足对象条件");
  }

  if (/卡的发动|效果发动|カードの発動|効果の発動|card activation|effect activation/iu.test(text)) {
    branches.push(
      { condition: "如果只是进行陷阱卡本身的卡的发动", result: "只需满足该卡可以被发动的手续。" },
      { condition: "如果要在卡的发动时同时发动其中一个编号效果", result: "还必须满足该编号效果自己的发动条件和时点。" },
    );
    requiredFacts.push("要确认的是卡的发动，还是在卡的发动时同时使用某个编号效果");
  }

  if (/C\s*1|C\s*2|连锁顺序|チェーン/iu.test(text) && !/C\s*1.*C\s*2|C\s*2.*C\s*1/iu.test(text)) {
    branches.push(
      { condition: "如果 A 是较早的连锁块、B 后连锁", result: "先处理 B，再处理 A。" },
      { condition: "如果顺序相反", result: "处理顺序和处理中状态也相反。" },
    );
    requiredFacts.push("各效果对应的连锁编号");
  }

  const near = officialMatches.near?.[0];
  if (!branches.length && near) {
    branches.push({
      condition: "如果当前问题与该官方相似案例的卡片状态、时点和处理结构一致",
      result: "可以按该官方案例作条件推导，但不能当作本题原题裁定。",
    });
    requiredFacts.push("确认当前场景与相似官方案例之间是否存在区域、控制者、时点或效果编号差异");
  }

  const hasEvidence = Boolean(officialMatches.all?.length || contextPack.officialQaCandidates?.length || contextPack.faqCandidates?.length || contextPack.ruleSnippets?.length);
  const hasEntity = Boolean(contextPack.resolvedCards?.length || contextPack.unresolvedCards?.length || contextPack.relevantCardSections?.length);
  if (!branches.length && (hasEvidence || hasEntity)) {
    branches.push({
      condition: "如果相关卡名、效果编号和询问时点与已检索资料一致",
      result: "可以继续按该资料检查；当前尚不足以形成唯一结论。",
    });
    requiredFacts.push("相关卡的正式卡名、效果编号及要判断的具体时点");
  }
  if (!branches.length) return null;

  return {
    answerType: "needs_clarification",
    answerRoute: "conditional_branch_answer",
    answerSource: near ? "official_qa_near_case" : "structured_conditions",
    confirmationLevel: "conditional",
    verdict: "insufficient_for_single_verdict",
    shortAnswer: `当前不能给唯一结论，但可以分情况：${branches.map((item) => `${item.condition}，${item.result}`).join("；")}。还需要补充：${[...new Set(requiredFacts)].join("；")}`,
    judgeReasoning: [{
      text: reason || "现有信息能建立条件分支，但不足以安全选择唯一分支。",
      basis: near ? ["official_qa"] : ["rule_snippet"],
      refs: near ? [near.id] : [],
    }],
    conditionalBranches: branches,
    requiredFacts: [...new Set(requiredFacts)],
    assumptions: [],
    possibleCounterCases: [],
    confidence: "low",
  };
}
