// Question-level status for the engine-reproduction section, and its Chinese rendering.
// Mechanical only: the planner supplies applicability / reason codes; this file only combines
// per-branch engine results and never inspects the question text.

export const STATUS = Object.freeze({
  NA: "不适用", OK: "已复现", PARTIAL: "部分复现", FAIL: "未复现", SKIPPED: "未进入",
});

export const REASON_ZH = Object.freeze({
  pure_rule: "纯规则问题", archetype_level: "字段级问题", tournament_policy: "比赛规程/裁判事务",
  ruleset_version: "其他规则版本（TCG/历史/旧卡文/禁限）", no_card_mentioned: "题面没有点名具体的卡",
  unrepresentable: "前置状态无法搭出", identity: "卡片身份无法确认", engine_error: "引擎/脚本报错",
  action_mismatch: "操作与引擎决策不匹配", budget_exceeded: "超出预算或资源上限", invalid_input: "计划格式无效",
  scope: "范围检查未通过",
});

const FLAG_ZH = Object.freeze({
  with_assumptions: "含补充假设", branched: "分支", random_dependent: "依赖随机结果", what_not_why: "问“为什么”",
  archetype_unverified: "字段名未核实", repair_skipped: "修复因时限跳过（主回答已进入生成）",
});

// One branch result -> {ok, reason}
function branchOutcome(branch) {
  const r = branch.engine;
  if (!r) return { ok: false, reason: branch.planReason || "invalid_input" };
  if (r.status === "replayed") return { ok: true, reason: null };
  if (r.status === "invalid_input") return { ok: false, reason: "invalid_input" };
  return { ok: false, reason: r.reason_code || "engine_error" };
}

export function aggregateQuestion(record) {
  // pre-planner outcomes
  if (record.preStatus) return { status: record.preStatus.status, reasonCodes: [record.preStatus.reason], flags: [] };
  const plan = record.plan;
  const skipped = record.repairSkipped ? ["repair_skipped"] : [];
  if (!plan) return { status: STATUS.FAIL, reasonCodes: [record.planFailure || "invalid_input"], flags: skipped };
  const flags = new Set(skipped);
  if (plan.what_not_why === true) flags.add("what_not_why");
  if (plan.applicability === "not_applicable") {
    if (plan.reason_code === "archetype_level" && record.archetypeVerified === false) flags.add("archetype_unverified");
    return { status: STATUS.NA, reasonCodes: [plan.reason_code], flags: [...flags] };
  }
  if ((plan.assumptions || []).length) flags.add("with_assumptions");
  const reasons = new Set();
  let okCount = 0;
  let total = 0;
  for (const sq of record.subQuestions || []) {
    total += 1;
    if (sq.unrepresentable) { reasons.add("unrepresentable"); sq.outcome = { ok: false, reason: "unrepresentable" }; continue; }
    const outcomes = (sq.branches || []).map(branchOutcome);
    if ((sq.branches || []).length > 1) flags.add("branched");
    if ((sq.branches || []).some((b) => b.assumption)) flags.add("with_assumptions");
    if ((sq.branches || []).some((b) => (b.engine?.log || []).some((e) => e.type === "toss_coin" || e.type === "toss_dice"))) {
      flags.add("random_dependent");
    }
    const allOk = outcomes.length > 0 && outcomes.every((o) => o.ok);
    for (const o of outcomes) if (!o.ok) reasons.add(o.reason);
    if (!outcomes.length) reasons.add("invalid_input");
    sq.outcome = { ok: allOk, partial: !allOk && outcomes.some((o) => o.ok) };
    if (allOk) okCount += 1;
  }
  const anyPartial = (record.subQuestions || []).some((sq) => sq.outcome?.partial);
  let status;
  if (total > 0 && okCount === total) status = STATUS.OK;
  else if (okCount > 0 || anyPartial) status = STATUS.PARTIAL;
  else status = STATUS.FAIL;
  return { status, reasonCodes: status === STATUS.OK ? [] : [...reasons], flags: [...flags] };
}

export function renderQuestion(record, summary) {
  const lines = ["【引擎复现（实验性，未经评测）】"];
  const reasons = summary.reasonCodes.filter(Boolean).map((c) => `${REASON_ZH[c] || c}（${c}）`).join("；");
  const flags = summary.flags.map((f) => FLAG_ZH[f] || f).join("、");
  lines.push(`状态：${summary.status}${reasons ? ` —— ${reasons}` : ""}${flags ? `　标记：${flags}` : ""}`);
  const plan = record.plan;
  if (record.preStatus?.detail) lines.push(record.preStatus.detail);
  if (plan?.quoted_span) lines.push(`题面依据：「${plan.quoted_span}」`);
  if (summary.status === STATUS.NA) {
    const name = plan?.reason_code === "archetype_level" && record.archetypeVerified ? `（字段：${plan.archetype_name}）` : "";
    lines.push(`本题不适用引擎复现：${REASON_ZH[summary.reasonCodes[0]] || summary.reasonCodes[0]}${name}。`);
  }
  if (summary.flags.includes("what_not_why")) lines.push("注：引擎只显示发生了什么，不解释原因。");
  if (plan?.assumptions?.length) {
    lines.push("假设：");
    for (const a of plan.assumptions) lines.push(`  - ${a}`);
  }
  for (const sq of record.subQuestions || []) {
    lines.push("", `—— 子问题 ${sq.id}：「${sq.quoted_span || ""}」`);
    if (sq.unrepresentable) { lines.push(`未复现：前置状态无法搭出 —— ${sq.unrepresentable}`); continue; }
    for (const b of sq.branches || []) {
      lines.push(`· 分支 ${b.id}${b.assumption ? `（假设：${b.assumption}）` : ""}${b.repaired ? "（修复后）" : ""}`);
      if (b.observe) lines.push(`  看点：${b.observe}`);
      if (b.engine?.rendered_zh) {
        lines.push(...b.engine.rendered_zh.split("\n").filter((l) => !l.startsWith("实验性功能，未经评测。")).map((l) => `  ${l}`));
      }
      else if (b.engine?.errors) lines.push(`  ${b.engine.reason_code || b.engine.status}：${JSON.stringify(b.engine.errors).slice(0, 600)}`);
      else if (b.planProblems) lines.push(`  计划无效：${b.planProblems.join("；").slice(0, 600)}`);
    }
  }
  lines.push("", "实验性功能，未经评测。引擎局面可能与题意有偏差，卡片脚本也可能有 bug；引擎只显示发生了什么，不代表官方裁定。");
  return lines.join("\n");
}
