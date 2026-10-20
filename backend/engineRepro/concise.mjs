// User-facing short engine-reproduction section (the full step-by-step replay stays in
// `rendered`). Mechanical only: it restates structured fields of the reproduction record
// (question-level status and reason codes, the plan's assumptions, probe results, the planned
// starting board, where a failed replay stopped, the board when a replay without check points
// ended) plus, when the official-Q&A judge (officialQaJudge.mjs) said so, the titles of
// the official Q&A it found to correspond exactly. It never reads the question text, never
// compares the engine result with the main answer and never judges whether either is right.
// The engine is named (ygopro, MyCard core) so readers know which program produced the result.
import { STATUS, branchOutcome } from "./aggregate.mjs";
import { FILLER_CARDS } from "./plannerPrompt.mjs";

export const CONCISE_HEADER = "【ygopro 引擎复现（实验性）】";
export const CONCISE_LEAD_WITH_BOARD = "ygopro（MyCard 版核心）在下面的局面里：";
export const CONCISE_LEAD_WITHOUT_BOARD = "ygopro（MyCard 版核心）的运行结果：";
export const CONCISE_DISCLAIMER = "ygopro 只显示它运行的结果，卡片脚本可能有 bug，不代表官方裁定。";

// The official-Q&A line. Shown only for official Q&A the judge called EXACT (officialQaJudge.mjs);
// with no such Q&A (none given to the answer, only partial or no correspondence, or the judge
// failed) there is no line. The line names at most two titles.
const OFFICIAL_QA_TITLE_MAX_CHARS = 120;
export function officialQaExactLine(matches = []) {
  const titles = [...new Set((Array.isArray(matches) ? matches : [])
    .map((match) => shortTitle(match?.title)).filter(Boolean))];
  if (!titles.length) return "";
  const shown = titles.slice(0, 2).map((title) => `【${title}】`).join("");
  const more = titles.length > 2 ? `等 ${titles.length} 条` : "";
  const which = titles.length > 1 ? "这些" : "该";
  return `判断模型认为官方 Q&A${shown}${more}与本题条件一致，以${which}官方 Q&A 为准；ygopro 的结果只作参考。`;
}

function shortTitle(value) {
  // 【】 delimit the title in the line, so brackets inside a title are written as ［］.
  const text = String(value || "").replace(/\s+/gu, " ").replace(/【/gu, "［").replace(/】/gu, "］").trim();
  const chars = Array.from(text);
  return chars.length > OFFICIAL_QA_TITLE_MAX_CHARS ? `${chars.slice(0, OFFICIAL_QA_TITLE_MAX_CHARS).join("")}…` : text;
}

// The reproduction's own admission limits (limits.mjs), by the error code they throw. When one of
// them refused the run, the section is this single line instead of a status and a reason.
export const ADMISSION_LIMIT_LINES = Object.freeze({
  engine_repro_daily_budget_exceeded: `${CONCISE_HEADER}今日额度已用完，本题没有完成 ygopro 复现。`,
  engine_repro_rate_limited: `${CONCISE_HEADER}每分钟次数已达上限，本题没有运行 ygopro 复现。`,
});

// Reason codes (planner, engine, pre-planner and batch scope) in plain words.
export const REASON_PLAIN = Object.freeze({
  identity: "题目里的卡名没有解析出来",
  unrepresentable: "引擎搭不出题目描述的局面",
  action_mismatch: "计划里有一步在引擎里做不到，没能走到题目要看的时点",
  engine_error: "引擎运行出错",
  budget_exceeded: "超出引擎运行限制",
  invalid_input: "没能生成引擎可以执行的计划",
  pure_rule: "这是纯规则问题，不针对具体卡的具体局面",
  archetype_level: "这题问的是一整个字段的卡，引擎只能运行具体的卡",
  tournament_policy: "这题问的是比赛规程或裁判处理，引擎不涉及",
  ruleset_version: "这题涉及其他规则版本（TCG、历史卡文或禁限表），引擎只按当前 OCG 规则运行",
  no_card_mentioned: "题目没有点名具体的卡",
  scope: "本题没有通过范围检查",
});

// Four shown states; the batch-only "未进入" (scope check) reads as not applicable.
const SHOWN_STATUS = Object.freeze({
  [STATUS.OK]: STATUS.OK, [STATUS.PARTIAL]: STATUS.PARTIAL, [STATUS.FAIL]: STATUS.FAIL,
  [STATUS.NA]: STATUS.NA, [STATUS.SKIPPED]: STATUS.NA,
});

const SIDE = ["我方", "对方"];   // P0 is the asker (planner contract)
const PHASE_ZH = Object.freeze({
  draw: "抽卡阶段", standby: "准备阶段", main1: "主要阶段1", battle_start: "战斗阶段开始", battle_step: "战斗步骤",
  damage: "伤害步骤", damage_calc: "伤害计算", battle: "战斗阶段", main2: "主要阶段2", end: "结束阶段",
});
// Battle timings reported by the engine (decision / window `timing.at`, ocg-sim-core harness "at"):
// during the battle and damage steps the decision's phase stays at the last announced phase.
const BATTLE_TIMING_ZH = Object.freeze({
  attack_declaration: "攻击宣言时", damage_step_start: "伤害步骤开始时", before_damage_calc: "伤害计算前",
  damage_calc: "伤害计算时", after_damage_calc: "伤害计算后", damage_step_end: "伤害步骤结束时",
});
const KIND_ZH = Object.freeze({
  idle: "主要阶段的行动选择", battle: "战斗阶段的行动选择", chain: "连锁/发动窗口",
  effect_yn: "是否发动效果的询问", yesno: "是/否的选择",
});
const CMD_ZH = Object.freeze({
  summon: "通常召唤", spsummon: "特殊召唤", mset: "盖放", sset: "盖放", repos: "改变表示形式",
});
// Every decision kind, for the step a failed replay stopped at (ocg-sim-core render_zh KIND, shortened).
const DECISION_ZH = Object.freeze({
  idle: "行动选择", battle: "战斗阶段的行动选择", chain: "连锁/发动窗口", effect_yn: "是否发动效果的询问",
  yesno: "是/否的选择", select_option: "选择选项", select_card: "选择卡", select_tribute: "选择解放的卡",
  select_unselect: "选择卡", select_sum: "选择卡", select_place: "选择区域", select_disfield: "选择区域",
  select_position: "选择表示形式", select_counter: "选择指示物", sort_card: "排列卡的顺序", announce_race: "宣言种族",
  announce_attrib: "宣言属性", announce_card: "宣言卡名", announce_number: "宣言数字", rps: "猜拳",
});
const PHASE_CMD_ZH = Object.freeze({ to_bp: "进入战斗阶段", to_m2: "进入主要阶段2", to_ep: "进入结束阶段", shuffle: "洗切手卡" });
// Why a card left the field (engine move reasons) and where it went; a card that just finished
// resolving (reason "rule" only) is not listed.
const MOVE_REASON_ZH = Object.freeze({
  destroy: "破坏", battle: "战斗", release: "解放", cost: "代价", material: "素材", discard: "丢弃", return: "回到",
});
const DESTINATION_ZH = Object.freeze({
  grave: "送去墓地", removed: "除外", hand: "回到手卡", deck: "回到卡组", extra: "回到额外卡组", overlay: "成为超量素材",
});
const ON_FIELD = new Set(["mzone", "szone", "fzone", "pzone"]);
const MONSTER_POSITION = Object.freeze({
  faceup_attack: "表侧攻击", faceup_defense: "表侧守备", facedown_defense: "里侧守备", facedown_attack: "里侧攻击",
});
const FILLER_CODES = new Set(FILLER_CARDS.map((card) => card.code));

/**
 * Pure view model of one reproduction record for the short section. Only what the short section
 * shows is kept; everything comes from structured fields (no rendered text is parsed).
 */
export function engineReproDigest(record = {}) {
  const names = cardNameIndex(record);
  const namedCodes = new Set((record.cards || []).map((card) => Number(card?.code)).filter(Number.isSafeInteger));
  const errorCode = typeof record.error?.code === "string" ? record.error.code : "";
  return {
    status: record.summary?.status || null,
    reasonCodes: (record.summary?.reasonCodes || []).filter((code) => typeof code === "string" && code),
    admissionLimit: Object.hasOwn(ADMISSION_LIMIT_LINES, errorCode) ? errorCode : null,
    assumptions: cleanTexts(record.plan?.assumptions),
    subQuestions: (record.subQuestions || []).map((sq) => ({
      quotedSpan: shortSpan(sq?.quoted_span),
      unrepresentable: Boolean(sq?.unrepresentable),
      branches: (sq?.unrepresentable ? [] : sq?.branches || []).map((branch) => branchDigest(branch, names, namedCodes)),
    })),
  };
}

/** Whether a section with this digest can carry the official-Q&A line (已复现 / 部分复现 only). */
export function officialQaLineApplies(digest) {
  const status = SHOWN_STATUS[digest?.status];
  return status === STATUS.OK || status === STATUS.PARTIAL;
}

/**
 * The short section text. `officialQaMatches` are the official Q&A the judge called EXACT
 * ([{ title }]); they add the official-Q&A line to a completed reproduction (已复现 / 部分复现).
 * Lines are separated by blank lines so every Markdown renderer keeps them apart.
 */
export function engineReproConciseText(digest, { officialQaMatches = [] } = {}) {
  if (!digest || typeof digest !== "object") return "";
  const status = SHOWN_STATUS[digest.status] || STATUS.FAIL;
  if (status === STATUS.FAIL && ADMISSION_LIMIT_LINES[digest.admissionLimit]) return ADMISSION_LIMIT_LINES[digest.admissionLimit];
  const head = `${CONCISE_HEADER}${status}`;
  if (status === STATUS.NA) return [head, `原因：${reasonText(digest.reasonCodes)}。`].join("\n\n");
  if (status === STATUS.FAIL) {
    // Where each failed branch stopped, when the engine reported the step, or what its check points saw when
    // the setup finished but a check point was not reached (the plain reason alone otherwise).
    const failedBranches = (Array.isArray(digest.subQuestions) ? digest.subQuestions : [])
      .flatMap((sq, index, all) => (sq.branches || []).map((branch, _i, branches) => ({ branch,
        label: [all.length > 1 ? `子问题 ${index + 1}${sq.quotedSpan ? `「${sq.quotedSpan}」` : ""}` : "",
          branches.length > 1 ? branchLabel(branch) : ""].filter(Boolean).join("，") })))
      .map(({ branch, label }) => ({ label, observe: branch.observe, text: branch.probeNotReached && branch.probes?.length
        ? branch.probes.map(probeSentence).join("；") : failureText(branch.failure) }))
      .filter(({ text }) => text)
      .map(({ label, observe, text }) => ({ label, text: observe ? `${trimEndPunctuation(observe)}——${text}` : text }));
    const stops = [...new Map(failedBranches.map((item) => [`${item.label}|${item.text}`, item])).values()].slice(0, 3);
    return [head, `原因：${reasonText(digest.reasonCodes)}。`,
      ...stops.map(({ label, text }) => withLabel(label, text))].join("\n\n");
  }

  const subQuestions = Array.isArray(digest.subQuestions) ? digest.subQuestions : [];
  const results = [];
  const boards = [];
  const assumptions = cleanTexts(digest.assumptions);
  subQuestions.forEach((sq, index) => {
    const sqLabel = subQuestions.length > 1 ? `子问题 ${index + 1}${sq.quotedSpan ? `「${sq.quotedSpan}」` : ""}` : "";
    if (sq.unrepresentable) {
      results.push(withLabel(sqLabel, `${REASON_PLAIN.unrepresentable}`));
      return;
    }
    const branches = sq.branches || [];
    for (const branch of branches) {
      if (branches.length === 1 && branch.assumption) assumptions.push(branch.assumption);
      const label = [sqLabel, branches.length > 1 ? branchLabel(branch) : ""].filter(Boolean).join("，");
      const observed = branch.ok || branch.probeNotReached;
      let sentence;
      if (!observed) sentence = `未复现，${failureText(branch.failure) || reasonText([branch.reason])}`;
      // No check point (a question about what the processing does): what the board shows when the replay ends.
      else if (!branch.probes?.length) sentence = endStateText(branch.end) || "引擎按计划走完了操作，结果见完整回放";
      else sentence = branch.probes.map(probeSentence).join("；");
      if (branch.observe) sentence = `${trimEndPunctuation(branch.observe)}——${sentence}`;
      results.push(withLabel(label, sentence));
      if (observed) {
        const text = boardText(branch.board);
        if (text) boards.push({ label, text });
      }
    }
  });

  const lines = [head];
  const lead = boards.length ? CONCISE_LEAD_WITH_BOARD : CONCISE_LEAD_WITHOUT_BOARD;
  if (results.length === 1) lines.push(`${lead}${results[0]}`);
  else if (results.length) lines.push(lead, ...results);
  const distinctBoards = [...new Map(boards.map((board) => [board.text, board])).values()];
  if (distinctBoards.length === 1) lines.push(`局面：${distinctBoards[0].text}。`);
  else for (const board of distinctBoards) lines.push(`局面（${board.label}）：${board.text}。`);
  const shownAssumptions = [...new Set(assumptions.map(trimEndPunctuation).filter(Boolean))];
  if (shownAssumptions.length) {
    lines.push(`假设：${shownAssumptions.slice(0, 3).join("；")}${shownAssumptions.length > 3 ? "等" : ""}。`);
  }
  const officialQaLine = officialQaLineApplies(digest) ? officialQaExactLine(officialQaMatches) : "";
  if (officialQaLine) lines.push(officialQaLine);
  lines.push(CONCISE_DISCLAIMER);
  return lines.join("\n\n");
}

function branchDigest(branch, names, namedCodes) {
  const engine = branch?.engine || null;
  const outcome = branchOutcome(branch || {});
  const turnPlayers = new Map((Array.isArray(engine?.decisions) ? engine.decisions : [])
    .map((entry) => [entry?.decision?.index, entry?.decision?.turn_player]));
  const probes = (engine?.probes || []).map((probe) => probeDigest(probe, names, turnPlayers));
  return {
    assumption: typeof branch?.assumption === "string" && branch.assumption.trim() ? branch.assumption.trim() : null,
    // what the planner said this branch looks at (plan observe, at most 30 characters), shown before the result
    observe: clipText(branch?.observe, OBSERVE_MAX_CHARS),
    ok: outcome.ok,
    reason: outcome.reason,
    probeNotReached: engine?.failure?.reason === "probe_not_reached",
    probes,
    failure: outcome.ok ? null : failureDigest(engine, names, branch?.actions?.setup),
    end: outcome.ok && !probes.length ? endStateDigest(engine, branch?.scenario, names, branch?.resultCards) : null,
    board: boardDigest(branch?.scenario, names, namedCodes),
  };
}

function branchLabel(branch) {
  return branch?.assumption ? `假设「${trimEndPunctuation(branch.assumption)}」` : "无额外假设";
}

// Where a failed replay stopped (engine failure: the 0-based step, the step itself and the decision the
// engine was at), plus what the replay passed in between for a step that waits for a window (a chain or
// effect_yn step is matched against every window of its player and kind; the ones that do not match are
// passed): how many such windows came after the last executed step and whether one listed the step's card.
function failureDigest(engine, names, setup = []) {
  const failure = engine?.failure;
  if (!failure || typeof failure !== "object" || failure.reason === "probe_not_reached") return null;
  if (failure.reason === "engine_rejected_response") {
    // The core answered MSG_RETRY to the response of the last executed step (harness RetryError); the
    // failure names that decision record but not the step, which the branch's own setup has.
    const last = failure.last_decision && typeof failure.last_decision === "object" ? failure.last_decision : null;
    const spec = Number.isSafeInteger(last?.step) && Array.isArray(setup) ? setup[last.step] : null;
    if (!spec || typeof spec !== "object") return null;
    return { reason: failure.reason, stepNumber: last.step + 1, step: stepText(spec, names), at: null };
  }
  const spec = failure.step_spec && typeof failure.step_spec === "object" ? failure.step_spec : null;
  if (!Number.isSafeInteger(failure.step) || !spec) return null;
  const decision = failure.decision && typeof failure.decision === "object" ? failure.decision : null;
  const entries = Array.isArray(engine.decisions) ? engine.decisions : [];
  const lastStepIndex = Math.max(-1, ...entries.filter((entry) => entry?.by === "setup")
    .map((entry) => (Number.isSafeInteger(entry?.decision?.index) ? entry.decision.index : -1)));
  const waitsForWindow = spec.decision === "chain" || spec.decision === "effect_yn";
  const stepCard = Number(spec.choose?.card);
  const passed = waitsForWindow ? entries.filter((entry) => entry?.by === "pass" && entry?.decision?.index > lastStepIndex
    && entry.decision.player === spec.player && (entry.decision.kind === "chain" || entry.decision.kind === "effect_yn")) : [];
  const listsCard = (d) => Number(d?.card?.card) === stepCard
    || (Array.isArray(d?.options) ? d.options : []).some((option) => Number(option?.card) === stepCard);
  const options = Array.isArray(decision?.options) ? decision.options : [];
  return {
    reason: typeof failure.reason === "string" ? failure.reason : null,
    stepNumber: failure.step + 1,
    step: stepText(spec, names),
    waitsForWindow,
    stepPlayer: spec.player,
    stepKind: spec.decision,
    hasCard: Number.isSafeInteger(stepCard),
    passedWindows: passed.length,
    passedListedCard: Number.isSafeInteger(stepCard) && passed.some((entry) => listsCard(entry.decision)),
    at: decision ? {
      player: decision.player,
      kind: decision.kind,
      card: names.get(Number(decision.card?.card)) || (typeof decision.card?.name === "string" ? decision.card.name : null),
      options: [...new Set(options.map((option) => optionLabel(option, names)).filter(Boolean))],
      sameAsStep: decision.player === spec.player && decision.kind === spec.decision,
    } : null,
  };
}

// The step in words: "对方发动「强制脱出装置」", "我方选择表示形式（表侧守备）".
function stepText(spec, names) {
  const who = SIDE[spec.player] || "";
  const choose = spec.choose && typeof spec.choose === "object" ? spec.choose : {};
  const name = (code) => `「${names.get(Number(code)) || "卡"}」`;
  switch (spec.decision) {
    case "idle": case "battle": case "chain":
      if (PHASE_CMD_ZH[choose.cmd]) return `${who}${PHASE_CMD_ZH[choose.cmd]}`;
      if (!choose.card) return `${who}的${DECISION_ZH[spec.decision]}`;
      if (choose.cmd === "attack") return `${who}以${name(choose.card)}攻击`;
      if (choose.cmd === "repos") return `${who}改变${name(choose.card)}的表示形式`;
      if (CMD_ZH[choose.cmd]) return `${who}${CMD_ZH[choose.cmd]}${name(choose.card)}`;
      return `${who}发动${name(choose.card)}`;
    case "effect_yn": case "yesno":
      return `${who}在${DECISION_ZH[spec.decision]}里选“${choose.answer === false ? "否" : "是"}”`;
    case "select_card": case "select_tribute": case "select_unselect": case "select_sum": {
      const picked = (Array.isArray(choose.cards) ? choose.cards : []).map((card) => name(card?.card));
      if (picked.length) return `${who}选择${listText(picked)}`;
      return choose.finish ? `${who}结束选择` : `${who}${DECISION_ZH[spec.decision]}`;
    }
    case "select_position":
      return `${who}选择表示形式${MONSTER_POSITION[choose.position] ? `（${MONSTER_POSITION[choose.position]}）` : ""}`;
    case "announce_card": return `${who}宣言卡名${choose.value ? name(choose.value) : ""}`;
    case "announce_number": return `${who}宣言数字${Number.isSafeInteger(choose.value) ? ` ${choose.value}` : ""}`;
    default: return `${who}${DECISION_ZH[spec.decision] || "的选择"}`;
  }
}

// One option of the decision a replay stopped at, without zone numbers.
function optionLabel(option, names) {
  if (!option || typeof option !== "object") return null;
  if (PHASE_CMD_ZH[option.cmd]) return PHASE_CMD_ZH[option.cmd];
  if (option.cmd === "yes") return "是";
  if (option.cmd === "no") return "否";
  if (option.cmd === "position") return MONSTER_POSITION[option.position] || null;
  if (option.cmd === "place") {
    const place = option.place || {};
    return place.zone ? `${SIDE[place.player] || ""}${place.zone === "mzone" ? "怪兽区域" : "魔法与陷阱区域"}` : null;
  }
  if (option.cmd === "option") return typeof option.desc_text === "string" && option.desc_text ? option.desc_text : "选项";
  const card = names.get(Number(option.card)) || (typeof option.name === "string" ? option.name : null);
  if (!card) return null;
  if (option.cmd === "attack") return `以${card}攻击`;
  if (option.cmd === "repos") return `改变${card}的表示形式`;
  if (CMD_ZH[option.cmd]) return `${CMD_ZH[option.cmd]}${card}`;
  if (option.cmd === "activate" || option.cmd === "chain") return `发动${card}`;
  return card;
}

// "卡在第 10 步（对方发动「强制脱出装置」）：之后对方的连锁/发动窗口里都没有出现这张卡". null without the step.
function failureText(failure) {
  if (!failure?.step) return null;
  const head = `卡在第 ${failure.stepNumber} 步（${failure.step}）`;
  const at = failure.at;
  const choices = at?.options?.length ? `（可选：${listText(at.options)}）` : "";
  let detail;
  if (failure.reason === "not_unique") detail = "引擎里有不止一个选项都符合这一步，没法确定是哪一个";
  else if (failure.reason === "setup_not_consumed") detail = "对局在这一步之前就结束了";
  else if (failure.reason === "engine_rejected_response") detail = "引擎不接受这个选择（例如选的卡不符合条件或张数不对）";
  else if (failure.waitsForWindow) {
    const side = SIDE[failure.stepPlayer] || "";
    const kind = DECISION_ZH[failure.stepKind] || "窗口";
    if (failure.passedListedCard) detail = "这张卡在之后的发动机会里出现过，但这一步没有对上它（写的决策类型、区域或效果不同）";
    else if (failure.hasCard && failure.passedWindows) detail = `之后${side}的${kind}里都没有出现这张卡`;
    else detail = `之后没有出现${side}的${kind}`;
    if (at && !at.sameAsStep) detail += `，回放走到了${SIDE[at.player] || ""}的${DECISION_ZH[at.kind] || "选择"}`;
  } else if (at?.sameAsStep) detail = `引擎给出的选项里没有这一项${choices}`;
  else if (at) {
    const what = at.card && (at.kind === "select_position" || at.kind === "select_place")
      ? `为「${at.card}」${DECISION_ZH[at.kind]}` : DECISION_ZH[at.kind] || "做别的选择";
    detail = `引擎这时要${SIDE[at.player] || ""}先${what}${choices}，计划里没有写这一步`;
  } else detail = REASON_PLAIN.action_mismatch;
  return `${head}：${detail}`;
}

// The board when a replay without check points ends. The moment is the decision the replay stopped at
// (the harness records it with by "end": the next choice the plan had no step for). With the plan's
// result_cards (the cards that answer the question) only those are reported: where each one is, its
// position, ATK / DEF on the field and whether its effects are negated (engine state `disabled`, ocg-sim-core
// 2026-10-20; older engines leave it out and nothing is said). Without them: the monsters on both fields
// (negated ones marked), life points that changed, and the cards that left the field during the replay for
// a reason other than finishing their own resolution.
function endStateDigest(engine, scenario, names, resultCards = null) {
  const players = engine?.state?.players;
  if (!players || typeof players !== "object") return null;
  const stateOf = (player) => players[player] || players[String(player)] || {};
  const cardView = (card, location) => ({
    name: names.get(Number(card.card)) || (typeof card.name === "string" ? card.name : "卡"),
    location, position: card.position,
    attack: Number.isFinite(card.attack) ? card.attack : null, defense: Number.isFinite(card.defense) ? card.defense : null,
    disabled: typeof card.disabled === "boolean" ? card.disabled : null,
  });
  const entries = (Array.isArray(engine.decisions) ? engine.decisions : []);
  const last = entries.length && entries.at(-1)?.by === "end" ? entries.at(-1).decision : null;
  const stop = last ? { kind: last.kind, player: last.player, phase: last.phase, turnPlayer: last.turn_player,
    at: last.timing?.at || null } : null;
  if (Array.isArray(resultCards) && resultCards.length) {
    const focus = resultCards.map(({ card, controller }) => {
      const sides = controller === 0 || controller === 1 ? [controller] : [0, 1];
      for (const side of sides) {
        for (const location of ["mzone", "szone", "hand", "grave", "removed", "extra", "deck"]) {
          const found = (Array.isArray(stateOf(side)[location]) ? stateOf(side)[location] : [])
            .find((item) => item && Number(item.card) === card);
          if (found) return { side, ...cardView(found, location) };
        }
      }
      return { side: controller, name: names.get(card) || "卡", location: null };
    });
    return { stop, focus };
  }
  const sides = [0, 1].map((player) => {
    const state = stateOf(player);
    const monsters = (Array.isArray(state.mzone) ? state.mzone : []).filter((m) => m && typeof m === "object")
      .map((m) => cardView(m, "mzone"));
    const startLp = Number(scenario?.players?.[player]?.lp);
    const lp = Number(state.lp);
    return { monsters, lpFrom: Number.isFinite(startLp) && Number.isFinite(lp) && lp !== startLp ? startLp : null, lp };
  });
  const left = (Array.isArray(engine.log) ? engine.log : []).filter((event) => event?.type === "move"
    && ON_FIELD.has(event.from?.location) && !ON_FIELD.has(event.to?.location)
    && Array.isArray(event.reason) && event.reason.some((reason) => reason !== "rule"))
    .map((event) => ({ name: names.get(Number(event.card)) || (typeof event.name === "string" ? event.name : "卡"),
      reasons: event.reason.map((reason) => MOVE_REASON_ZH[reason]).filter(Boolean), to: DESTINATION_ZH[event.to?.location] || null }));
  return { stop, sides, left };
}

const LOCATION_ZH = Object.freeze({ hand: "在手卡", grave: "在墓地", removed: "被除外", extra: "在额外卡组", deck: "在卡组" });

// "回放停在我方战斗阶段的行动选择时" / "回放结束时" (the duel ended, or an older record without the end decision).
function stopText(stop) {
  if (!stop) return "回放结束时";
  const who = SIDE[stop.player] || "";
  if (stop.kind === "idle") return `回放停在${who}${PHASE_ZH[stop.phase] || ""}的行动选择时`;
  if (stop.kind === "battle") return `回放停在${who}战斗阶段的行动选择时`;
  const when = timeLabel(stop.phase, stop.turnPlayer, stop.player, stop.at);
  return `回放停在${who}的${DECISION_ZH[stop.kind] || "选择"}时${when ? `（${when}）` : ""}`;
}

function monsterText(m, { sayEnabled = false } = {}) {
  const parts = [];
  if (m.position === "facedown_defense" || m.position === "facedown_attack") parts.push("里侧表示");
  else if (m.position === "faceup_defense") parts.push(`守备表示，守备力 ${m.defense}`);
  else if (m.attack !== null) parts.push(`攻击力 ${m.attack}`);
  if (m.disabled === true) parts.push("效果被无效");
  else if (sayEnabled && m.disabled === false) parts.push("效果没有被无效");
  return parts.length ? `${m.name}（${parts.join("，")}）` : m.name;
}

function endStateText(end) {
  if (!end) return null;
  if (Array.isArray(end.focus)) {
    const shown = end.focus.map((card) => {
      const who = SIDE[card.side] || "";
      if (!card.location) return `${who}「${card.name}」不在场上，也不在手卡、墓地、除外区、卡组和额外卡组里`;
      if (card.location === "mzone") {
        const view = monsterText({ ...card, name: "" }, { sayEnabled: true }).replace(/^（|）$/gu, "");
        return `${who}场上的「${card.name}」${view ? `：${view}` : ""}`;
      }
      if (card.location === "szone") {
        const state = card.position === "facedown" ? "盖放" : "表侧表示";
        const negated = card.disabled === true ? "，效果被无效" : card.disabled === false ? "，效果没有被无效" : "";
        return `${who}场上的「${card.name}」：${state}${negated}`;
      }
      return `${who}的「${card.name}」${LOCATION_ZH[card.location] || "不在场上"}`;
    });
    return `${stopText(end.stop)}，${shown.join("；")}`;
  }
  const parts = [];
  for (const [player, side] of (end.sides || []).entries()) {
    const shown = (side.monsters || []).slice(0, 5).map((m) => monsterText(m));
    if (shown.length) parts.push(`${SIDE[player]}场上 ${shown.join("、")}${side.monsters.length > 5 ? "等" : ""}`);
  }
  const lp = (end.sides || []).map((side, player) => (side.lpFrom === null ? null : `${SIDE[player]} ${side.lpFrom}→${side.lp}`)).filter(Boolean);
  if (lp.length) parts.push(`基本分 ${lp.join("，")}`);
  const left = (end.left || []).slice(0, 4).map((card) => `${card.name}（${[card.reasons.join("、"), card.to].filter(Boolean).join("，")}）`);
  if (left.length) parts.push(`离场的卡 ${left.join("、")}${end.left.length > 4 ? "等" : ""}`);
  return parts.length ? `${stopText(end.stop)}，${parts.join("；")}` : null;
}

// The times of the windows that offered the target (of every window when none did), each with the chain
// state at that window when it differs between windows at the same time.
function probeDigest(probe, names, turnPlayers) {
  const windows = Array.isArray(probe?.windows) ? probe.windows : [];
  const time = (window) => timeLabel(window?.phase, turnPlayers.get(window?.decision), probe?.player, window?.timing?.at);
  const items = windows.map((window) => ({ window, chain: windowChainText(window) }));
  const hits = items.filter(({ window }) => window?.contains_target);
  return {
    player: probe?.player,
    result: probe?.result || null,
    card: names.get(Number(probe?.target?.card)) || null,
    cmd: typeof probe?.target?.cmd === "string" ? probe.target.cmd : null,
    decisionKind: probe?.decision_kind || null,
    cardLevelOnly: probe?.card_level_only === true,
    when: whenLabels(hits.length ? hits : items, time),
    prompts: [...new Set(hits.map(({ window }) => promptText(window)).filter(Boolean))],
  };
}

// What a yes/no prompt (effect_yn / yesno window) asked, from the engine's description string (the
// card name goes into [%ls]). null for the core's generic activation offer (desc 0 / 221), which the
// sentence calls an activation, and for windows of other kinds. A yes/no prompt that names the card is
// not necessarily an activation (a destruction replacement, a card's own string asked of the opponent),
// so it is quoted instead.
const GENERIC_PROMPTS = new Set([0, 221]);
function promptText(window) {
  if (window?.kind !== "effect_yn" && window?.kind !== "yesno") return null;
  const desc = Number(window.desc) || 0;
  if (window.kind === "effect_yn" && GENERIC_PROMPTS.has(desc)) return null;
  const text = typeof window.desc_text === "string" ? window.desc_text.trim() : "";
  if (!text) return null;
  const name = typeof window.card?.name === "string" ? window.card.name : "";
  return text.replaceAll("[%ls]", name).replaceAll("%ls", name);
}

// Times in order of first appearance. Windows at one time that differ in chain state are listed under it:
// "伤害计算前（连锁 1 处理前、连锁处理完毕后）"; an empty chain with nothing to tell reads "没有连锁时";
// an unknown state (older engine results) adds nothing.
function whenLabels(items, time) {
  const groups = new Map();
  for (const { window, chain } of items) {
    const label = time(window);
    if (!label) continue;
    if (!groups.has(label)) groups.set(label, []);
    const chains = groups.get(label);
    if (chain !== null && !chains.includes(chain)) chains.push(chain);
  }
  return [...groups].map(([label, chains]) => (chains.some(Boolean)
    ? `${label}（${chains.map((chain) => chain || "没有连锁时").join("、")}）` : label));
}

// The chain state of a probe window, from the engine's own fields (ocg-sim-core adapter, 2026-10-18;
// the engine's Chinese replay writes the same words): chain_links (links not yet resolved),
// in_activation / in_resolution, after_chain_end (empty chain right after a chain resolved at the same
// turn, phase and battle timing, no action choice since). null when the engine did not report it.
function windowChainText(window) {
  const links = window?.chain_links;
  if (!Number.isSafeInteger(links) || links < 0) return null;
  if (window.in_activation === true) return `连锁 ${links} 发动中`;
  if (window.in_resolution === true) return `连锁 ${links + 1} 处理中`;
  if (links > 0) return `连锁 ${links} 处理前`;
  return window.after_chain_end === true ? "连锁处理完毕后" : "";
}

// "主要阶段1" in the acting player's own turn, "我方主要阶段1" / "对方主要阶段1" otherwise.
// A battle timing, when the engine reports one, replaces the phase: "伤害计算前" in the acting
// player's own turn, "对方回合的伤害计算前" otherwise.
function timeLabel(phase, turnPlayer, actor, at = null) {
  const timingText = BATTLE_TIMING_ZH[at];
  if (timingText) return turnPlayer === actor || !SIDE[turnPlayer] ? timingText : `${SIDE[turnPlayer]}回合的${timingText}`;
  const phaseText = PHASE_ZH[phase];
  if (!phaseText) return null;
  return `${turnPlayer === actor ? "" : SIDE[turnPlayer] || ""}${phaseText}`;
}

// Card names by passcode: the question's cards (engine names), then names the engine itself
// reported in this run, then the fixed filler list, then planner-declared extra cards.
function cardNameIndex(record) {
  const names = new Map();
  const add = (code, name) => {
    const key = Number(code);
    if (Number.isSafeInteger(key) && typeof name === "string" && name.trim() && !names.has(key)) names.set(key, name.trim());
  };
  for (const card of record.cards || []) add(card?.code, card?.engineName);
  for (const sq of record.subQuestions || []) {
    for (const branch of sq?.branches || []) {
      const engine = branch?.engine;
      if (!engine) continue;
      for (const entry of engine.decisions || []) {
        for (const option of entry?.decision?.options || []) add(option?.card, option?.name);
        add(entry?.decision?.card?.card, entry?.decision?.card?.name);
      }
      for (const probe of engine.probes || []) {
        for (const window of probe?.windows || []) {
          for (const option of window?.options || []) add(option?.card, option?.name);
          add(window?.card?.card, window?.card?.name);
        }
      }
      for (const event of engine.log || []) add(event?.card, event?.name);
    }
  }
  for (const card of FILLER_CARDS) add(card.code, card.name);
  for (const card of record.plan?.extra_cards || []) add(card?.code, card?.name);
  return names;
}

// The planned starting board, restricted to the question's own cards (named in the question and
// resolved by the main answer). Other cards are only counted; the deck (filled with filler cards
// by default), life points, zone numbers and the first player are not shown.
function boardDigest(scenario, names, namedCodes) {
  let filler = false;
  let auxiliary = false;
  const sides = [];
  const players = Array.isArray(scenario?.players) ? scenario.players.slice(0, 2) : [];
  players.forEach((player, index) => {
    if (!player || typeof player !== "object") return;
    const zones = [];
    // Cards on the field are all listed (the attacker, the monster attacked, an equipped monster are part of
    // the situation even when the question did not name them); elsewhere only the question's own cards are.
    const zone = (title, entries, { countOthers = true, all = false } = {}) => {
      const cards = [];
      for (const entry of entries) {
        const code = Number(entry?.code);
        if (!Number.isSafeInteger(code)) continue;
        if (namedCodes.has(code) || (all && names.has(code))) cards.push({ name: names.get(code) || "题目中的卡", label: entry.label || null });
        else if (countOthers) {
          if (FILLER_CODES.has(code)) filler = true;
          else auxiliary = true;
        }
      }
      if (cards.length) zones.push({ zone: title, cards });
    };
    const field = [];
    for (const monster of player.mzone || []) {
      field.push({ code: monster?.code, label: MONSTER_POSITION[monster?.position] || null });
      for (const material of monster?.overlay || []) field.push({ code: material, label: "超量素材" });
    }
    for (const card of player.szone || []) {
      // an equip card names the monster it is equipped to (scenario equip_to: player, zone, seq)
      const target = card?.equip_to && card.equip_to.zone === "mzone"
        ? (players[card.equip_to.player]?.mzone || []).find((m) => m?.seq === card.equip_to.seq) : null;
      const equipped = target && names.has(Number(target.code)) ? `装备给${names.get(Number(target.code))}` : null;
      field.push({ code: card?.code, label: equipped || (card?.position === "facedown" ? "盖放" : "表侧") });
    }
    if (player.fzone) field.push({ code: player.fzone.code, label: player.fzone.position === "facedown" ? "场地区，盖放" : "场地区，表侧" });
    for (const card of player.pzone || []) if (card) field.push({ code: card.code, label: "灵摆区" });
    zone("场上", field, { all: true });
    zone("手卡", (player.hand || []).map((code) => ({ code })));
    zone("墓地", (player.grave || []).map((code) => ({ code })));
    zone("除外", (player.removed || []).map((card) => ({ code: card?.code, label: card?.position === "facedown" ? "里侧" : null })));
    zone("额外卡组", [...(player.extra || []).map((code) => ({ code })),
      ...(player.extra_faceup || []).map((code) => ({ code, label: "表侧" }))]);
    zone("卡组", (player.deck || []).map((code) => ({ code })), { countOthers: false });
    if (zones.length) sides.push({ side: index, zones });
  });
  return { sides, others: { filler, auxiliary } };
}

function boardText(board) {
  if (!board?.sides?.length) return "";
  const text = board.sides.map(({ side, zones }) => `${SIDE[side]}${zones
    .map(({ zone, cards }) => `${zone} ${cardRunsText(cards)}`).join("，")}`).join("；");
  const { filler, auxiliary } = board.others || {};
  const others = filler && auxiliary ? "（另有填充卡和其他辅助卡）"
    : filler ? "（另有填充卡）" : auxiliary ? "（另有其他辅助卡）" : "";
  return `${text}${others}`;
}

// Consecutive cards with the same position share one label: "A、B（表侧攻击）".
function cardRunsText(cards) {
  const runs = [];
  for (const card of cards) {
    const last = runs.at(-1);
    if (last && last.label === card.label) last.names.push(card.name);
    else runs.push({ label: card.label, names: [card.name] });
  }
  return runs.map((run) => `${run.names.join("、")}${run.label ? `（${run.label}）` : ""}`).join("、");
}

function probeSentence(probe) {
  const who = SIDE[probe.player] || "";
  const name = probe.card || "目标卡";
  const at = probe.when?.length ? `在${listText(probe.when)}` : "";
  const activation = !probe.cmd || probe.cmd === "activate" || probe.cmd === "chain";
  const action = activation ? `发动${name}` : probe.cmd === "attack" ? `以${name}攻击` : `${CMD_ZH[probe.cmd] || ""}${name}`;
  const cardOnly = probe.cardLevelOnly ? "（只能确认到卡，不能确认是哪个效果）" : "";
  const yesNo = probe.decisionKind === "effect_yn" || probe.decisionKind === "yesno";
  switch (probe.result) {
    case "present":
      if (yesNo && probe.prompts?.length) return `${who}${at}被询问${listText(probe.prompts.map((text) => `「${text}」`))}`;
      if (probe.decisionKind === "yesno") return `${who}${at}出现了与「${name}」有关的是/否询问`;
      return `${who}${at}可以选择「${action}」${cardOnly}`;
    case "present_auto": return `「${name}」作为必发效果由引擎自动发动${cardOnly}`;
    case "absent":
      if (yesNo) return `${who}${at}没有出现与「${name}」有关的询问`;
      return activation ? `${who}${at}没有出现「${name}」的发动机会` : `${who}${at}没有出现「${action}」的选项`;
    case "not_reached": {
      // No decision of that kind for that player in the interval (the core asks nothing when nothing can be
      // activated), so this check point decides nothing.
      const missing = probe.decisionKind === "effect_yn" ? `${who}一次也没有被询问是否发动效果`
        : probe.decisionKind === "yesno" ? `${who}没有遇到是/否的选择` : `没有出现${who}的${KIND_ZH[probe.decisionKind] || "选择"}`;
      const open = probe.decisionKind === "yesno" ? `会不会被问到与「${name}」有关的问题`
        : activation || probe.decisionKind === "effect_yn" ? `「${name}」能否发动` : `能否「${action}」`;
      return `要看的这段过程里${missing}，所以看不出${open}`;
    }
    default: return `回放提前中止，没有看完${who}的${KIND_ZH[probe.decisionKind] || "选择"}`;
  }
}

function reasonText(codes = []) {
  const texts = [...new Set((codes || []).filter(Boolean).map((code) => REASON_PLAIN[code] || "引擎没能完成复现"))];
  return texts.length ? texts.join("；") : "引擎没能完成复现";
}

function withLabel(label, sentence) {
  return `${label ? `${label}：` : ""}${sentence}。`;
}

function listText(items) {
  return `${items.slice(0, 3).join("、")}${items.length > 3 ? "等" : ""}`;
}

function cleanTexts(values) {
  return (Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
}

const OBSERVE_MAX_CHARS = 30;
function clipText(value, max) {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

// The sub-question's own words from the question (planner quoted_span), cut to 20 characters.
const SPAN_MAX_CHARS = 20;
function shortSpan(value) {
  const text = String(value || "").replace(/\s+/gu, " ").replace(/[「」]/gu, "").trim();
  if (!text || text === "…") return "";
  const chars = Array.from(text);
  return chars.length > SPAN_MAX_CHARS ? `${chars.slice(0, SPAN_MAX_CHARS).join("")}…` : text;
}

function trimEndPunctuation(value) {
  return String(value || "").trim().replace(/[。．.；;，,、]+$/u, "");
}
