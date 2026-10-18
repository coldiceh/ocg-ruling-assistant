// User-facing short engine-reproduction section (the full step-by-step replay stays in
// `rendered`). Mechanical only: it restates structured fields of the reproduction record
// (question-level status and reason codes, the plan's assumptions, probe results, the planned
// starting board) plus, when the official-Q&A judge (officialQaJudge.mjs) said so, the titles of
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
  action_mismatch: "引擎实际的操作流程和计划不一致，没能走到要看的时点",
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
const KIND_ZH = Object.freeze({
  idle: "主要阶段的行动选择", battle: "战斗阶段的行动选择", chain: "连锁/发动窗口",
  effect_yn: "是否发动效果的询问", yesno: "是/否的选择",
});
const CMD_ZH = Object.freeze({
  summon: "通常召唤", spsummon: "特殊召唤", mset: "盖放", sset: "盖放", repos: "改变表示形式",
});
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
      unrepresentable: Boolean(sq?.unrepresentable),
      branches: (sq?.unrepresentable ? [] : sq?.branches || []).map((branch) => branchDigest(branch, names, namedCodes)),
    })),
  };
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
  if (status === STATUS.FAIL || status === STATUS.NA) {
    return [head, `原因：${reasonText(digest.reasonCodes)}。`].join("\n\n");
  }

  const subQuestions = Array.isArray(digest.subQuestions) ? digest.subQuestions : [];
  const results = [];
  const boards = [];
  const assumptions = cleanTexts(digest.assumptions);
  subQuestions.forEach((sq, index) => {
    const sqLabel = subQuestions.length > 1 ? `子问题 ${index + 1}` : "";
    if (sq.unrepresentable) {
      results.push(withLabel(sqLabel, `${REASON_PLAIN.unrepresentable}`));
      return;
    }
    const branches = sq.branches || [];
    for (const branch of branches) {
      const branchLabel = branches.length > 1
        ? (branch.assumption ? `假设「${trimEndPunctuation(branch.assumption)}」` : "无额外假设") : "";
      if (branches.length === 1 && branch.assumption) assumptions.push(branch.assumption);
      const label = [sqLabel, branchLabel].filter(Boolean).join("，");
      const observed = branch.ok || branch.probeNotReached;
      let sentence;
      if (!observed) sentence = `未复现：${reasonText([branch.reason])}`;
      else if (!branch.probes?.length) sentence = "引擎按计划走完了操作，这一问没有设置检查点（过程见完整回放）";
      else sentence = branch.probes.map(probeSentence).join("；");
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
  const officialQaLine = officialQaExactLine(officialQaMatches);
  if (officialQaLine) lines.push(officialQaLine);
  lines.push(CONCISE_DISCLAIMER);
  return lines.join("\n\n");
}

function branchDigest(branch, names, namedCodes) {
  const engine = branch?.engine || null;
  const outcome = branchOutcome(branch || {});
  const turnPlayers = new Map((engine?.decisions || [])
    .map((entry) => [entry?.decision?.index, entry?.decision?.turn_player]));
  return {
    assumption: typeof branch?.assumption === "string" && branch.assumption.trim() ? branch.assumption.trim() : null,
    ok: outcome.ok,
    reason: outcome.reason,
    probeNotReached: engine?.failure?.reason === "probe_not_reached",
    probes: (engine?.probes || []).map((probe) => probeDigest(probe, names, turnPlayers)),
    board: boardDigest(branch?.scenario, names, namedCodes),
  };
}

function probeDigest(probe, names, turnPlayers) {
  const windows = Array.isArray(probe?.windows) ? probe.windows : [];
  const when = (window) => timeLabel(window?.phase, turnPlayers.get(window?.decision), probe?.player);
  const hit = windows.find((window) => window?.contains_target);
  return {
    player: probe?.player,
    result: probe?.result || null,
    card: names.get(Number(probe?.target?.card)) || null,
    cmd: typeof probe?.target?.cmd === "string" ? probe.target.cmd : null,
    decisionKind: probe?.decision_kind || null,
    cardLevelOnly: probe?.card_level_only === true,
    when: [...new Set((hit ? [when(hit)] : windows.map(when)).filter(Boolean))],
  };
}

// "主要阶段1" in the acting player's own turn, "我方主要阶段1" / "对方主要阶段1" otherwise.
function timeLabel(phase, turnPlayer, actor) {
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
    const zone = (title, entries, { countOthers = true } = {}) => {
      const cards = [];
      for (const entry of entries) {
        const code = Number(entry?.code);
        if (!Number.isSafeInteger(code)) continue;
        if (namedCodes.has(code)) cards.push({ name: names.get(code) || "题目中的卡", label: entry.label || null });
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
    for (const card of player.szone || []) field.push({ code: card?.code, label: card?.position === "facedown" ? "盖放" : "表侧" });
    if (player.fzone) field.push({ code: player.fzone.code, label: player.fzone.position === "facedown" ? "场地区，盖放" : "场地区，表侧" });
    for (const card of player.pzone || []) if (card) field.push({ code: card.code, label: "灵摆区" });
    zone("场上", field);
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
  switch (probe.result) {
    case "present": return `${who}${at}可以选择「${action}」${cardOnly}`;
    case "present_auto": return `「${name}」作为必发效果由引擎自动发动${cardOnly}`;
    case "absent": return activation ? `${who}${at}没有出现「${name}」的发动机会` : `${who}${at}没有出现「${action}」的选项`;
    case "not_reached": return `没有到达要看的时点（${who}的${KIND_ZH[probe.decisionKind] || "选择"}）`;
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

function trimEndPunctuation(value) {
  return String(value || "").trim().replace(/[。．.；;，,、]+$/u, "");
}
