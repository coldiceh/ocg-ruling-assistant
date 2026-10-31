// User-facing short engine-reproduction section; the full step-by-step replay stays in `rendered`
// (collapsed on the website). Layout since 2026-10-30, top to bottom:
//   header → 结论 (one or two sentences a model wrote for this question from the observations below,
//   conclusion.mjs) → 依据的引擎观察值 (the observations that sentence used, listed verbatim) → 局面 →
//   假设 → why a part was not reproduced → official-Q&A line → disclaimer.
// Without a conclusion sentence (switch off, the call failed, nothing was observed, an older record)
// every observation is listed instead. 未复现 shows the reasons only; 不适用 one plain reason.
//
// Everything in this file is mechanical. It restates structured fields of the reproduction record:
// probe results, the full state of the cards at the moment the engine stopped (every field the engine
// can report; a field it did not report is written 未取得, never dropped), life points, cards that left
// the field, where a failed replay stopped, the planner's own words for a part it could not build and
// plan-check problems. It never reads the question text, never decides which observation answers the
// question, never compares the engine result with the main answer and never judges whether either is
// right. The wording uses players' terms (phases and timings), not replay / log vocabulary.
// The engine is named (ygopro, MyCard core) so readers know which program produced the result.
import { STATUS, branchOutcome, probeResult, reproductionFailure } from "./aggregate.mjs";
import { ATTRIBUTE_BITS, FILLER_CARDS, RACE_BITS } from "./plannerPrompt.mjs";

export const CONCISE_HEADER = "【ygopro 引擎复现（实验性）】";
export const CONCISE_RESULTS_LEAD = "ygopro（MyCard 版核心）的运行结果：";
export const CONCISE_CONCLUSION_LEAD = "结论：";
export const CONCISE_EVIDENCE_LEAD = "依据的引擎观察值：";
export const CONCISE_DISCLAIMER = "ygopro 只显示它运行的结果，卡片脚本可能有 bug，不代表官方裁定。";
// A state field the engine did not report.
export const NOT_OBTAINED = "未取得";

const FALLBACK_SHOWN = 8;     // observations listed when there is no conclusion sentence
const REASONS_SHOWN = 4;
const FIELD_CARDS_MAX = 12;   // cards listed for a result question without result cards
const LEFT_CARDS_MAX = 6;

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

// Reason codes (planner, engine, pre-planner and batch scope) in plain words. Used only when the record
// carries nothing more specific (the specific reasons are built in notReproducedReasons below).
export const REASON_PLAIN = Object.freeze({
  identity: "题目里的卡名没有解析出来",
  unrepresentable: "引擎搭不出题目描述的局面",
  action_mismatch: "计划里有一步在引擎里做不到，没能走到题目要看的时点",
  engine_error: "引擎运行出错",
  budget_exceeded: "超出引擎运行限制",
  invalid_input: "计划没有通过检查（这条记录没有保存具体原因）",
  pure_rule: "这是纯规则问题，不针对具体卡的具体局面",
  archetype_level: "这题问的是一整个字段的卡，引擎只能运行具体的卡",
  tournament_policy: "这题问的是比赛规程或裁判处理，引擎不涉及",
  ruleset_version: "这题涉及其他规则版本（TCG、历史卡文或禁限表），引擎只按当前 OCG 规则运行",
  no_card_mentioned: "题目没有点名具体的卡",
  scope: "本题没有通过范围检查",
});

// A run-time failure of the whole reproduction (session.mjs records error.code / error.name).
const ERROR_PLAIN = Object.freeze({
  engine_busy: "引擎服务正忙，这次没有运行",
  engine_unavailable: "引擎服务出错或暂时连不上",
  engine_repro_model_error: "规划模型调用失败",
  engine_repro_not_configured: "复现功能的配置不完整",
  engine_repro_store_not_configured: "复现功能的计数存储没有配置",
});
const ERROR_NAME_PLAIN = Object.freeze({ TimeoutError: "等待引擎或规划模型超时", AbortError: "等待引擎或规划模型超时" });

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
const CMD_ZH = Object.freeze({
  summon: "通常召唤", spsummon: "特殊召唤", mset: "盖放", sset: "盖放", repos: "改变表示形式",
});
// Every decision kind in players' words (the step a failed replay stopped at, the choice it reached).
const DECISION_ZH = Object.freeze({
  idle: "行动", battle: "战斗阶段的行动", chain: "发动或连锁的机会", effect_yn: "是否发动效果的询问",
  yesno: "是/否的选择", select_option: "选择选项", select_card: "选择卡", select_tribute: "选择解放的卡",
  select_unselect: "选择卡", select_sum: "选择卡", select_place: "选择区域", select_disfield: "选择区域",
  select_position: "选择表示形式", select_counter: "选择指示物", sort_card: "排列卡的顺序", announce_race: "宣言种族",
  announce_attrib: "宣言属性", announce_card: "宣言卡名", announce_number: "宣言数字", rps: "猜拳",
});
const PHASE_CMD_ZH = Object.freeze({ to_bp: "进入战斗阶段", to_m2: "进入主要阶段2", to_ep: "进入结束阶段", shuffle: "洗切手卡" });
// Why a card moved (engine move reasons) and where it went.
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
const LOCATION_ZH = Object.freeze({ hand: "在手卡", grave: "在墓地", removed: "被除外", extra: "在额外卡组", deck: "在卡组" });
const FILLER_CODES = new Set(FILLER_CARDS.map((card) => card.code));

// Card state values as ygopro-core reports them (QUERY_TYPE / QUERY_LINK bits; attribute and race bits
// are the planner's declaration tables). The engine-side contract: docs/ocg-engine-integration.md,
// "引擎状态接口规格".
const TYPE_BITS = Object.freeze([["怪兽", 0x1], ["魔法", 0x2], ["陷阱", 0x4], ["通常", 0x10], ["效果", 0x20], ["融合", 0x40],
  ["仪式", 0x80], ["陷阱怪兽", 0x100], ["灵魂", 0x200], ["同盟", 0x400], ["二重", 0x800], ["调整", 0x1000], ["同调", 0x2000],
  ["衍生物", 0x4000], ["速攻", 0x10000], ["永续", 0x20000], ["装备", 0x40000], ["场地", 0x80000], ["反击", 0x100000],
  ["反转", 0x200000], ["卡通", 0x400000], ["超量", 0x800000], ["灵摆", 0x1000000], ["连接", 0x4000000]]);
const LINK_MARKER_BITS = Object.freeze([["左下", 0x1], ["下", 0x2], ["右下", 0x4], ["左", 0x8], ["右", 0x20], ["左上", 0x40],
  ["上", 0x80], ["右上", 0x100]]);

/**
 * Pure view model of one reproduction record for the short section, built from structured fields only
 * (no rendered text is parsed). `observations` are the engine's results, numbered o1, o2, … in record
 * order (the conclusion call cites them by these ids); `notReproduced` are the reasons a part was not
 * reproduced; `conclusion` is the conclusion sentence with the observations it used, when there is one.
 */
export function engineReproDigest(record = {}) {
  const names = cardNameIndex(record);
  const namedCodes = new Set((record.cards || []).map((card) => Number(card?.code)).filter(Number.isSafeInteger));
  const errorCode = typeof record.error?.code === "string" ? record.error.code : "";
  const allSubQuestions = Array.isArray(record.subQuestions) ? record.subQuestions : [];
  const subQuestions = allSubQuestions.map((sq, index) => {
    const quotedSpan = shortSpan(sq?.quoted_span);
    const label = allSubQuestions.length > 1 ? `子问题 ${index + 1}${quotedSpan ? `「${quotedSpan}」` : ""}` : "";
    const branches = sq?.unrepresentable ? [] : Array.isArray(sq?.branches) ? sq.branches : [];
    return {
      label,
      quotedSpan,
      unrepresentable: Boolean(sq?.unrepresentable),
      // the planner's own sentence for a part it could not build, shown as written
      unrepresentableReason: typeof sq?.unrepresentable === "string" && sq.unrepresentable !== "null"
        ? clipText(sq.unrepresentable, UNREPRESENTABLE_MAX_CHARS) : null,
      branches: branches.map((branch) => branchDigest(branch, names, namedCodes,
        [label, branches.length > 1 ? branchLabel(branch) : ""].filter(Boolean).join("，"))),
    };
  });
  return {
    status: record.summary?.status || null,
    reasonCodes: (record.summary?.reasonCodes || []).filter((code) => typeof code === "string" && code),
    admissionLimit: Object.hasOwn(ADMISSION_LIMIT_LINES, errorCode) ? errorCode : null,
    assumptions: cleanTexts(record.plan?.assumptions),
    subQuestions,
    observations: collectObservations(subQuestions),
    notReproduced: notReproducedReasons(record, subQuestions, errorCode),
    conclusion: conclusionDigest(record.conclusion),
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
 * Paragraphs are separated by blank lines; a list block is a lead line followed by "- " items.
 */
export function engineReproConciseText(digest, { officialQaMatches = [] } = {}) {
  if (!digest || typeof digest !== "object") return "";
  const status = SHOWN_STATUS[digest.status] || STATUS.FAIL;
  if (status === STATUS.FAIL && ADMISSION_LIMIT_LINES[digest.admissionLimit]) return ADMISSION_LIMIT_LINES[digest.admissionLimit];
  const head = `${CONCISE_HEADER}${status}`;
  if (status === STATUS.NA) return [head, `原因：${reasonText(digest.reasonCodes)}。`].join("\n\n");
  const reasons = Array.isArray(digest.notReproduced) ? digest.notReproduced : [];
  if (status === STATUS.FAIL) {
    return [head, reasons.length ? reasonsBlock("原因：", reasons) : `原因：${reasonText(digest.reasonCodes)}。`].join("\n\n");
  }

  const lines = [head];
  const conclusion = digest.conclusion && typeof digest.conclusion.text === "string" && digest.conclusion.text.trim()
    ? digest.conclusion : null;
  const observations = Array.isArray(digest.observations) ? digest.observations : [];
  if (conclusion) {
    lines.push(`${CONCISE_CONCLUSION_LEAD}${sentence(conclusion.text)}`);
    const evidence = cleanTexts(conclusion.evidence);
    if (evidence.length) lines.push([CONCISE_EVIDENCE_LEAD, ...evidence.map((text) => `- ${text}`)].join("\n"));
  } else if (observations.length) {
    lines.push([CONCISE_RESULTS_LEAD, ...fallbackItems(observations)].join("\n"));
  }
  const boards = digestBoards(digest);
  if (boards.length === 1) lines.push(`局面：${boards[0].text}。`);
  else for (const board of boards) lines.push(`局面（${board.label}）：${board.text}。`);
  const assumptions = digestAssumptions(digest);
  if (assumptions.length) lines.push(`假设：${assumptions.slice(0, 3).join("；")}${assumptions.length > 3 ? "等" : ""}。`);
  // a branch whose check points were all unreached is already among the observations
  const unreproduced = reasons.filter((item) => !item.observedBranch);
  if (unreproduced.length) lines.push(reasonsBlock("没能复现的部分：", unreproduced));
  const officialQaLine = officialQaLineApplies(digest) ? officialQaExactLine(officialQaMatches) : "";
  if (officialQaLine) lines.push(officialQaLine);
  lines.push(CONCISE_DISCLAIMER);
  return lines.join("\n\n");
}

/** The planned starting boards of the branches that produced observations, one per distinct board. */
export function digestBoards(digest) {
  const boards = [];
  for (const sq of Array.isArray(digest?.subQuestions) ? digest.subQuestions : []) {
    for (const branch of Array.isArray(sq?.branches) ? sq.branches : []) {
      if (!(branch.ok || branch.probeNotReached || branch.probeObserved)) continue;
      const text = boardText(branch.board);
      if (text) boards.push({ label: branch.label, text });
    }
  }
  return [...new Map(boards.map((board) => [board.text, board])).values()];
}

/** The plan's assumptions plus each single-branch sub-question's own assumption, without duplicates. */
export function digestAssumptions(digest) {
  const assumptions = cleanTexts(digest?.assumptions);
  for (const sq of Array.isArray(digest?.subQuestions) ? digest.subQuestions : []) {
    const branches = Array.isArray(sq?.branches) ? sq.branches : [];
    if (branches.length === 1 && branches[0].assumption) assumptions.push(branches[0].assumption);
  }
  return [...new Set(assumptions.map(trimEndPunctuation).filter(Boolean))];
}

// The fallback list: the first observation of a branch carries the plan's own words for what that branch
// looks at ("observe——…"), as the short section always did.
function fallbackItems(observations) {
  const shown = observations.slice(0, FALLBACK_SHOWN).map((item) => {
    if (!(item.first && item.observe)) return `- ${item.text}`;
    return `- ${item.label ? `${item.label}：` : ""}${trimEndPunctuation(item.observe)}——${item.body}`;
  });
  if (observations.length > FALLBACK_SHOWN) shown.push(`- 另有 ${observations.length - FALLBACK_SHOWN} 条没有列出`);
  return shown;
}

function reasonsBlock(lead, items) {
  const distinct = [...new Map(items.map((item) => [`${item.label}|${item.text}`, item])).values()];
  const line = (item) => `${item.label ? `${item.label}：` : ""}${trimEndPunctuation(item.text)}`;
  if (distinct.length === 1) return `${lead}${line(distinct[0])}。`;
  const shown = distinct.slice(0, REASONS_SHOWN).map((item) => `- ${line(item)}`);
  if (distinct.length > REASONS_SHOWN) shown.push(`- 另有 ${distinct.length - REASONS_SHOWN} 处没有列出`);
  return [lead, ...shown].join("\n");
}

function sentence(text) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  return /[。！？.!?]$/u.test(value) ? value : `${value}。`;
}

function conclusionDigest(conclusion) {
  if (conclusion?.status !== "done" || typeof conclusion.text !== "string" || !conclusion.text.trim()) return null;
  return { text: conclusion.text.trim(),
    evidence: (Array.isArray(conclusion.used) ? conclusion.used : []).map((item) => item?.text).filter((text) => typeof text === "string" && text) };
}

function branchDigest(branch, names, namedCodes, label) {
  const engine = branch?.engine || null;
  const outcome = branchOutcome(branch || {});
  const failure = reproductionFailure(branch);
  const turnPlayers = new Map((Array.isArray(engine?.decisions) ? engine.decisions : [])
    .map((entry) => [entry?.decision?.index, entry?.decision?.turn_player]));
  const probes = (engine?.probes || []).map((probe) => probeDigest(probe, names, turnPlayers));
  return {
    label,
    assumption: typeof branch?.assumption === "string" && branch.assumption.trim() ? branch.assumption.trim() : null,
    // what the planner said this branch looks at (plan observe, at most 30 characters)
    observe: clipText(branch?.observe, OBSERVE_MAX_CHARS),
    ok: outcome.ok,
    reason: outcome.reason,
    probeObserved: outcome.observed === true && !outcome.ok,
    probeNotReached: ["probe_not_reached", "probe_interval_incomplete"].includes(failure?.reason),
    probes,
    failure: outcome.ok ? null : failureDigest({ ...engine, failure }, names, branch?.actions?.setup),
    end: outcome.ok && !probes.length ? endStateDigest(engine, branch?.scenario, names, branch?.resultCards) : null,
    board: boardDigest(branch?.scenario, names, namedCodes),
    // the cards the plan said answer the question (plan result_cards), by name
    resultCards: (Array.isArray(branch?.resultCards) ? branch.resultCards : [])
      .map(({ card, controller }) => ({ card, controller, name: names.get(Number(card)) || "卡" })),
    planProblems: cleanTexts(branch?.planProblems).map((text) => clipText(text, PROBLEM_MAX_CHARS)),
    engineErrors: engine?.status === "invalid_input" ? problemTexts(engine.errors) : [],
  };
}

function branchLabel(branch) {
  return branch?.assumption ? `假设「${trimEndPunctuation(branch.assumption)}」` : "无额外假设";
}

// ---------------------------------------------------------------------------------------------------
// Observations: what the engine reported, one numbered item each, in record order.
// ---------------------------------------------------------------------------------------------------

function collectObservations(subQuestions) {
  const items = [];
  subQuestions.forEach((sq, sqIndex) => {
    (sq.branches || []).forEach((branch, branchIndex) => {
      // a branch whose check points were not all reached still reports what each of them saw
      if (!(branch.ok || branch.probeNotReached || branch.probeObserved)) return;
      // an "empty" item says the engine reported nothing to look at; it is listed but is not a result
      const list = branch.probes.length ? branch.probes.map((probe) => ({ body: probeSentence(probe) }))
        : branch.end ? endObservationItems(branch.end)
          : [{ body: "引擎做完了计划里的操作，没有返回之后的局面", empty: true }];
      list.forEach((item, index) => items.push({ ...item, label: branch.label, branch: `${sqIndex}/${branchIndex}`,
        first: index === 0, observe: branch.observe || null }));
    });
  });
  return items.map((item, index) => ({ id: `o${index + 1}`, text: item.label ? `${item.label}：${item.body}` : item.body, ...item }));
}

// One item per reported card (its full state), then life points that changed and the cards that left the
// field. Every card item says when: the moment the engine stopped (the next choice the plan had no step for).
function endObservationItems(end) {
  const when = end.stop?.time ? `到${end.stop.time}时，` : "操作做完后，";
  if (Array.isArray(end.focus)) return end.focus.map((state) => ({ body: `${when}${cardStateText(state)}` }));
  const items = (end.field || []).map((state) => ({ body: `${when}${cardStateText(state)}` }));
  if (end.fieldOmitted) items.push({ body: `${when}场上另有 ${end.fieldOmitted} 张卡没有列出` });
  if (!items.length) {
    items.push(end.fieldReported ? { body: `${when}双方场上都没有卡` } : { body: `${when}引擎没有返回场上的卡`, empty: true });
  }
  const lp = (end.lp || []).map(({ side, from, to }) => `${SIDE[side]} ${from}→${to}`);
  if (lp.length) items.push({ body: `${when}基本分 ${lp.join("，")}` });
  for (const card of (end.left || []).slice(0, LEFT_CARDS_MAX)) {
    items.push({ body: `离开过场上的卡：「${card.name}」（${[card.reasons.join("、"), card.to].filter(Boolean).join("，")}）` });
  }
  return items;
}

// The engine's end state for a branch without check points. The moment is the decision the replay
// stopped at (the harness records it with by "end"). With the plan's result_cards only those cards are
// reported (wherever they are); without them every card on both fields, life points that changed and the
// cards that left the field for a reason other than finishing their own resolution.
function endStateDigest(engine, scenario, names, resultCards = null) {
  const players = engine?.state?.players;
  if (!players || typeof players !== "object") return null;
  const stateOf = (player) => players[player] || players[String(player)] || {};
  const log = Array.isArray(engine.log) ? engine.log : [];
  const field = fieldEntries(stateOf, names);
  const context = { names, field, log };
  const entries = Array.isArray(engine.decisions) ? engine.decisions : [];
  const last = entries.length && entries.at(-1)?.by === "end" ? entries.at(-1).decision : null;
  const stop = last ? { kind: last.kind, player: last.player, phase: last.phase, turnPlayer: last.turn_player,
    at: last.timing?.at || null, chain: windowChainText(last) || null } : null;
  if (stop) stop.time = momentText(stop);
  if (Array.isArray(resultCards) && resultCards.length) {
    const focus = resultCards.map(({ card, controller }) => {
      const found = findCard(stateOf, field, card, controller);
      if (!found) return { side: controller, name: names.get(card) || "卡", code: card, location: null };
      return normalizeCardState(found.entry, { ...context, side: found.side, location: found.location, host: found.host });
    });
    return { stop, focus };
  }
  const shown = field.slice(0, FIELD_CARDS_MAX).map((item) => normalizeCardState(item.entry,
    { ...context, side: item.player, location: item.location }));
  const lp = [0, 1].map((side) => {
    const from = Number(scenario?.players?.[side]?.lp);
    const to = Number(stateOf(side).lp);
    return Number.isFinite(from) && Number.isFinite(to) && from !== to ? { side, from, to } : null;
  }).filter(Boolean);
  const left = log.filter((event) => event?.type === "move"
    && ON_FIELD.has(event.from?.location) && !ON_FIELD.has(event.to?.location)
    && Array.isArray(event.reason) && event.reason.some((reason) => reason !== "rule"))
    .map((event) => ({ name: names.get(Number(event.card)) || (typeof event.name === "string" ? event.name : "卡"),
      reasons: event.reason.map((reason) => MOVE_REASON_ZH[reason]).filter(Boolean), to: DESTINATION_ZH[event.to?.location] || null }));
  // an engine that lists no zone at all reported nothing about the field (not "both fields are empty")
  const fieldReported = [0, 1].some((side) => ["mzone", "szone", "fzone", "pzone"].some((zone) => Object.hasOwn(stateOf(side), zone)));
  return { stop, field: shown, fieldOmitted: Math.max(0, field.length - shown.length), fieldReported, lp, left };
}

// "我方战斗阶段" / "我方主要阶段1（连锁 1 处理中）" / "对方回合的伤害计算后": the turn player's phase or battle
// timing at the moment the engine stopped, with the chain state when the engine reports it.
function momentText(stop) {
  const side = SIDE[stop.turnPlayer] || "";
  let base = null;
  if (BATTLE_TIMING_ZH[stop.at]) base = `${side}回合的${BATTLE_TIMING_ZH[stop.at]}`;
  else if (stop.kind === "battle") base = `${side}战斗阶段`;
  else if (PHASE_ZH[stop.phase]) base = `${side}${PHASE_ZH[stop.phase]}`;
  if (!base) return null;
  return stop.chain ? `${base}（${stop.chain}）` : base;
}

// Every card on both fields, in zone order. A card the engine lists in its spell/trap zone at sequence 5
// is in the field zone (ygopro keeps the field zone there).
function fieldEntries(stateOf, names) {
  const out = [];
  for (const player of [0, 1]) {
    for (const zone of ["mzone", "szone", "fzone", "pzone"]) {
      const value = stateOf(player)[zone];
      const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
      for (const entry of list) {
        if (!entry || typeof entry !== "object") continue;
        const seq = Number.isSafeInteger(entry.seq) ? entry.seq : null;
        out.push({ player, zone, location: zone === "szone" && seq === 5 ? "fzone" : zone, seq, entry,
          name: names.get(Number(entry.card)) || (typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "卡") });
      }
    }
  }
  return out;
}

function findCard(stateOf, field, code, controller) {
  const sides = controller === 0 || controller === 1 ? [controller] : [0, 1];
  for (const side of sides) {
    const onField = field.find((item) => item.player === side && Number(item.entry.card) === code);
    if (onField) return { side, location: onField.location, entry: onField.entry };
    for (const location of ["hand", "grave", "removed", "extra", "deck"]) {
      const list = Array.isArray(stateOf(side)[location]) ? stateOf(side)[location] : [];
      const entry = list.find((item) => item && typeof item === "object" && Number(item.card) === code);
      if (entry) return { side, location, entry };
    }
    for (const holder of field.filter((item) => item.player === side && item.location === "mzone")) {
      const material = (Array.isArray(holder.entry.overlay) ? holder.entry.overlay : [])
        .find((item) => Number(item && typeof item === "object" ? item.card : item) === code);
      if (material !== undefined) {
        return { side, location: "overlay", host: holder.name, entry: material && typeof material === "object" ? material : { card: code } };
      }
    }
  }
  return null;
}

/**
 * One card entry of the engine's state -> the full state structure used by the short section and the
 * conclusion call. Which fields a card has follows its current type when the engine reports it
 * (QUERY_TYPE), otherwise its zone (monster zone: monster fields; spell/trap, field and pendulum zones:
 * spell/trap fields). A field the engine did not report is listed in `missing` (shown as 未取得); a field
 * it reported as empty is listed in `none` ("没有…"); a field it reported as null does not apply.
 * `values` holds the reported values, `parts` their wording.
 *
 * context: { side, location, names: Map code->name, field: fieldEntries(...), log: engine move log, host }
 */
export function normalizeCardState(entry, { side = null, location = null, names = new Map(), field = null, log = [], host = null } = {}) {
  const card = entry && typeof entry === "object" ? entry : {};
  const has = (key) => Object.hasOwn(card, key);
  const code = Number(card.card);
  const state = { side, code: Number.isSafeInteger(code) ? code : null,
    name: names.get(code) || (typeof card.name === "string" && card.name.trim() ? card.name.trim() : "卡"),
    location, seq: Number.isSafeInteger(card.seq) ? card.seq : null, values: {}, parts: [], none: [], missing: [] };
  if (host) state.host = host;
  if (location === "overlay") return state;
  const { values, parts, none, missing } = state;
  const onField = ON_FIELD.has(location);
  const type = has("type") ? typeInfo(card.type) : null;

  if (onField) {
    if (has("position")) {
      values.position = card.position;
      const text = positionText(card.position, location);
      if (text) parts.push(text);
    } else missing.push("表示形式");
  } else if (has("position") && (location === "removed" || location === "extra")) {
    values.position = card.position;
    state.facing = String(card.position).startsWith("facedown") ? "里侧" : "表侧";
  }
  if (type) {
    values.type = type.names;
    if (type.names.length) parts.push(`种类 ${type.names.join("/")}`);
  } else missing.push("种类");

  const statKeys = ["attribute", "race", "level", "rank", "link", "attack", "defense", "base_attack", "base_defense"];
  const monsterHere = type ? type.monster && !["szone", "fzone", "pzone"].includes(location) : location === "mzone";
  const offFieldUnknown = !type && !onField;
  if (monsterHere || (offFieldUnknown && statKeys.some(has))) monsterStats(card, has, type, state);
  else if (offFieldUnknown) missing.push("属性、种族、等级、攻守等状态");

  if (has("lscale") || has("rscale")) {
    const left = reportedNumber(card.lscale);
    const right = reportedNumber(card.rscale);
    if (left !== null || right !== null) {
      values.scales = { left, right };
      if (left === right) parts.push(`灵摆刻度 ${left}`);
      else if (left === null) parts.push(`灵摆刻度 右 ${right}`);
      else if (right === null) parts.push(`灵摆刻度 左 ${left}`);
      else parts.push(`灵摆刻度 左 ${left} 右 ${right}`);
    }
  } else if (location === "pzone") missing.push("灵摆刻度");

  if (onField) {
    if (has("disabled")) {
      if (typeof card.disabled === "boolean") {
        values.disabled = card.disabled;
        parts.push(card.disabled ? "效果被无效" : "效果没有被无效");
      }
    } else missing.push("效果是否被无效");
    listField(has, counterEntries(card.counters), "counters", "指示物", (counter) => counterText(counter), state);
    if (location === "mzone" && (!type || type.xyz)) {
      listField(has, card.overlay, "overlay", "超量素材",
        (item) => `「${names.get(Number(item && typeof item === "object" ? item.card : item)) || (item?.name ? String(item.name) : "卡")}」`, state);
    }
    if (location === "mzone") {
      // the equip cards on this monster: the spell/trap-zone cards whose equip target is it
      // (known when the engine reports equip targets, or when no card is outside the monster zones)
      const equipKnown = Array.isArray(field) && (field.every((item) => item.zone === "mzone")
        || field.some((item) => item.zone !== "mzone" && Object.hasOwn(item.entry, "equip_target")));
      if (equipKnown) {
        const equips = field.filter((item) => samePlace(item.entry.equip_target, { player: side, zone: "mzone", seq: state.seq }))
          .map((item) => `${item.player !== side ? `${SIDE[item.player] || ""}的` : ""}「${item.name}」`);
        values.equippedBy = equips;
        if (equips.length) parts.push(`装备卡 ${equips.join("、")}`);
        else none.push("装备卡");
      } else missing.push("装备卡");
    } else if (location === "szone" && (!type || type.equip)) {
      if (has("equip_target")) {
        if (card.equip_target && typeof card.equip_target === "object") {
          values.equipTarget = placeName(card.equip_target, { names, field, side });
          parts.push(`装备给${values.equipTarget}`);
        }
      } else missing.push("装备对象");
    }
    if (has("targets")) {
      const targets = (Array.isArray(card.targets) ? card.targets : []).map((place) => placeName(place, { names, field, side }));
      values.targets = targets;
      if (targets.length) parts.push(`以${targets.join("、")}为持续对象`);
      else none.push("持续对象");
    } else missing.push("持续对象");
    if (has("owner")) {
      values.owner = card.owner;
      if ((card.owner === 0 || card.owner === 1) && card.owner !== side) parts.push(`持有者 ${SIDE[card.owner]}`);
    } else missing.push("持有者");
  } else {
    const moved = lastMove(log, state.code, location);
    if (moved) state.moved = moved;
  }
  return state;
}

function monsterStats(card, has, type, state) {
  const { values, parts, missing } = state;
  for (const [key, label, table] of [["attribute", "属性", ATTRIBUTE_BITS], ["race", "种族", RACE_BITS]]) {
    if (!has(key)) { missing.push(label); continue; }
    if (card[key] === null) continue;
    values[key] = bitNames(card[key], table);
    parts.push(`${label} ${values[key].length ? values[key].join("、") : "无"}`);
  }
  const isLink = type ? type.link : has("link") && Number(card.link) > 0;
  const isXyz = type ? type.xyz : has("rank") && Number(card.rank) > 0;
  const numberStat = (key, label, missingLabel = label) => {
    if (!has(key)) { missing.push(missingLabel); return; }
    const value = reportedNumber(card[key]);
    if (value !== null) { values[key] = value; parts.push(`${label} ${value}`); }
  };
  if (isLink) {
    numberStat("link", "连接数");
    if (has("link_marker")) {
      if (card.link_marker !== null) {
        values.linkMarkers = bitNames(card.link_marker, LINK_MARKER_BITS);
        parts.push(`连接标记 ${values.linkMarkers.join("、") || "无"}`);
      }
    } else missing.push("连接标记");
  } else if (isXyz) {
    numberStat("rank", "阶级");
  } else numberStat("level", "等级", type ? "等级" : "等级/阶级/连接数");
  statPair(card, has, ["attack", "base_attack"], ["attack", "baseAttack"], "攻击力", state);
  if (!isLink) statPair(card, has, ["defense", "base_defense"], ["defense", "baseDefense"], "守备力", state);
}

// An explicit null is inapplicable, not the numeric value zero.
function reportedNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Current value with the original one ("攻击力 1900（原本 2500）"); a reported null does not apply; "?" for
// the engine's negative placeholder.
function statPair(card, has, [key, baseKey], [valueKey, baseValueKey], label, { values, parts, missing }) {
  const shown = (field) => (has(field) && Number.isFinite(card[field]) ? (card[field] < 0 ? "?" : String(card[field])) : null);
  const current = shown(key);
  const base = shown(baseKey);
  if (current !== null) values[valueKey] = card[key];
  if (base !== null) values[baseValueKey] = card[baseKey];
  if (current !== null) parts.push(`${label} ${current}${base !== null ? `（原本 ${base}）` : ""}`);
  else if (base !== null) parts.push(`原本${label} ${base}`);
  if (!has(key)) missing.push(label);
  if (!has(baseKey)) missing.push(`原本${label}`);
}

function listField(has, value, key, label, render, { values, parts, none, missing }) {
  if (!has(key)) { missing.push(label); return; }
  const items = (Array.isArray(value) ? value : []).map(render).filter(Boolean);
  values[key] = items;
  if (items.length) parts.push(`${label} ${items.join("、")}`);
  else none.push(label);
}

function counterText(counter) {
  if (!counter || typeof counter !== "object") return null;
  const count = Number(counter.count);
  const type = Number(counter.type);
  const name = typeof counter.name === "string" && counter.name.trim() ? counter.name.trim()
    : Number.isSafeInteger(type) ? `种类 0x${type.toString(16)} 的指示物` : "指示物";
  return Number.isFinite(count) ? `${name} ${count} 个` : name;
}

// Older engine snapshots stored counters as { "0x1": 2 }; preserve those observations
// while the complete-state engine uses [{ type, count, name }].
function counterEntries(value) {
  if (Array.isArray(value) || !value || typeof value !== "object") return value;
  return Object.entries(value).map(([type, count]) => ({ type: Number(type), count }));
}

function samePlace(place, { player, zone, seq }) {
  return Boolean(place && typeof place === "object" && place.player === player && place.location === zone
    && Number.isSafeInteger(seq) && place.seq === seq);
}

// A card the engine names by place ({player, location, seq, card?}): its name on that field, else its
// passcode's name; the other player's card says whose it is.
function placeName(place, { names, field, side }) {
  const found = (Array.isArray(field) ? field : []).find((item) => item.player === place?.player && item.zone === place?.location && item.seq === place?.seq);
  const name = found?.name || names.get(Number(place?.card)) || (typeof place?.name === "string" && place.name ? place.name : "卡");
  return `${(place?.player === 0 || place?.player === 1) && place.player !== side ? `${SIDE[place.player]}的` : ""}「${name}」`;
}

// How a card off the field got where it is, from the engine's own move log ("破坏、战斗，从场上送去墓地").
function lastMove(log, code, location) {
  if (!Number.isSafeInteger(code) || !location) return null;
  const event = [...log].reverse().find((item) => item?.type === "move" && Number(item.card) === code && item.to?.location === location);
  if (!event) return null;
  const reasons = (Array.isArray(event.reason) ? event.reason : []).map((reason) => MOVE_REASON_ZH[reason]).filter(Boolean);
  const destination = DESTINATION_ZH[location] || "";
  const where = ON_FIELD.has(event.from?.location) && destination ? `从场上${destination}` : destination;
  return [reasons.join("、"), where].filter(Boolean).join("，") || null;
}

function typeInfo(value) {
  const names = bitNames(value, TYPE_BITS);
  if (Number.isSafeInteger(value)) {
    const bit = (mask) => (value & mask) !== 0;
    return { names, monster: bit(0x1), xyz: bit(0x800000), link: bit(0x4000000), equip: bit(0x40000) };
  }
  if (!names.length) return null;
  return { names, monster: names.includes("怪兽"), xyz: names.includes("超量"), link: names.includes("连接"), equip: names.includes("装备") };
}

// Bit flags as names (a table of [name, bit]); an engine that already sends names (array or string) is kept.
function bitNames(value, table) {
  if (Number.isSafeInteger(value)) return table.filter(([, bit]) => (value & bit) !== 0).map(([name]) => name);
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function positionText(position, location) {
  if (location === "mzone") return MONSTER_POSITION[position] ? `${MONSTER_POSITION[position]}表示` : null;
  if (String(position).startsWith("facedown")) return "盖放";
  return String(position).startsWith("faceup") ? "表侧表示" : null;
}

/**
 * One card state in words: "对方场上的「X」：表侧攻击表示，属性 暗，攻击力 1900（原本 2500），效果没有被无效，没有指示物；
 * 种类、持有者未取得". Off the field: "我方的「X」在墓地（破坏、战斗，从场上送去墓地）：…".
 */
export function cardStateText(state) {
  if (!state) return "";
  const who = SIDE[state.side] || "";
  if (!state.location) return `${who}的「${state.name}」不在场上，也不在手卡、墓地、除外区、卡组和额外卡组里`;
  const parts = Array.isArray(state.parts) ? state.parts : [];
  const none = Array.isArray(state.none) ? state.none : [];
  const missing = Array.isArray(state.missing) ? state.missing : [];
  const shown = [parts.join("，"), none.length ? `没有${none.join("、")}` : ""].filter(Boolean).join("，");
  const detail = [shown, missing.length ? `${missing.join("、")}${NOT_OBTAINED}` : ""].filter(Boolean).join("；");
  const tail = detail ? `：${detail}` : "";
  if (state.location === "overlay") return `${who}场上「${state.host || "卡"}」的超量素材「${state.name}」${tail}`;
  if (ON_FIELD.has(state.location)) {
    const where = state.location === "fzone" ? "场地区" : state.location === "pzone" ? "灵摆区" : "场上";
    return `${who}${where}的「${state.name}」${tail}`;
  }
  const note = [state.facing, state.moved].filter(Boolean).join("，");
  return `${who}的「${state.name}」${LOCATION_ZH[state.location] || "不在场上"}${note ? `（${note}）` : ""}${tail}`;
}

// ---------------------------------------------------------------------------------------------------
// Why a part was not reproduced: the most specific record of each failed part.
// ---------------------------------------------------------------------------------------------------

function notReproducedReasons(record, subQuestions, errorCode) {
  // the whole run stopped: that is the only reason (its branches never ran)
  if (record.error) {
    if (Object.hasOwn(ADMISSION_LIMIT_LINES, errorCode)) return [];
    return [{ label: "", text: errorText(record.error, record.summary?.reasonCodes?.[0]) }];
  }
  if (record.preStatus) return record.preStatus.reason === "identity" ? [{ label: "", text: identityText(record.preStatus) }] : [];
  // no usable plan at all (the planner's rounds failed): that is the reason, whatever the invalid plan held
  if (record.planFailure || (!record.plan && (record.planFailures?.length || record.repairProblems?.length))) {
    return [{ label: "", text: planFailureText(record) }];
  }
  const items = [];
  const add = (label, text, extra = {}) => { if (text) items.push({ label, text: trimEndPunctuation(text), ...extra }); };
  for (const sq of subQuestions) {
    if (sq.unrepresentable) {
      add(sq.label, sq.unrepresentableReason ? `搭不出题目说的局面——${trimEndPunctuation(sq.unrepresentableReason)}` : REASON_PLAIN.unrepresentable);
      continue;
    }
    if (!sq.branches.length) add(sq.label, "计划没有给这一问写可以运行的局面，也没有写为什么搭不出");
    for (const branch of sq.branches) {
      if (branch.ok) continue;
      if (branch.probeNotReached && branch.probes.length) {
        add(branch.label, branch.probes.map(probeSentence).join("；"), { observedBranch: true });
        continue;
      }
      add(branch.label, branchFailureText(branch));
    }
  }
  return items;
}

function branchFailureText(branch) {
  if (branch.planProblems?.length) return `计划没通过检查：${branch.planProblems.slice(0, 2).join("；")}${branch.planProblems.length > 2 ? "等" : ""}`;
  if (branch.engineErrors?.length) return `引擎没有接受这个计划：${branch.engineErrors.slice(0, 2).join("；")}${branch.engineErrors.length > 2 ? "等" : ""}`;
  return failureText(branch.failure) || REASON_PLAIN[branch.reason] || REASON_PLAIN.engine_error;
}

// Each planner round's own outcome when no plan came out of it (reproduce.mjs planFailures).
function planFailureText(record) {
  const rounds = (Array.isArray(record.planFailures) ? record.planFailures : []).map((failure) => {
    const when = failure?.call === "repair" ? "修复时" : "第一次";
    if (failure?.kind === "truncated") return `${when}输出太长被截断`;
    if (failure?.kind === "not_json") return `${when}输出的不是完整的计划`;
    const problems = cleanTexts(failure?.problems).map((text) => clipText(text, PROBLEM_MAX_CHARS));
    return `${when}的计划没通过检查${problems.length ? `（${problems.slice(0, 2).join("；")}${problems.length > 2 ? "等" : ""}）` : ""}`;
  });
  if (!rounds.length) {
    const problems = cleanTexts(record.repairProblems).map((text) => clipText(text, PROBLEM_MAX_CHARS));
    if (problems.length) rounds.push(problems.slice(0, 2).join("；"));
  }
  return rounds.length ? `规划模型没有给出能交给引擎的计划：${rounds.join("；")}` : REASON_PLAIN.invalid_input;
}

function identityText(preStatus) {
  const parts = [...cleanTexts(preStatus.unresolved).map((input) => `「${input}」没能确定是哪张卡`),
    ...cleanTexts(preStatus.unmapped).map((name) => `「${name}」在 ygopro 的卡库里找不到`)];
  if (!parts.length) return REASON_PLAIN.identity;
  return `没法确认题目里的卡：${parts.slice(0, 3).join("；")}${parts.length > 3 ? "等" : ""}`;
}

function errorText(error, reasonCode) {
  return ERROR_PLAIN[error?.code] || ERROR_NAME_PLAIN[error?.name] || REASON_PLAIN[reasonCode] || REASON_PLAIN.engine_error;
}

function problemTexts(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).filter(Boolean)
    .map((text) => clipText(text, PROBLEM_MAX_CHARS)).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------
// A failed replay: where it stopped.
// ---------------------------------------------------------------------------------------------------

// Where a failed replay stopped (engine failure: the 0-based step, the step itself and the decision the
// engine was at), plus what the replay passed in between for a step that waits for a window (a chain or
// effect_yn step is matched against every window of its player and kind; the ones that do not match are
// passed): how many such windows came after the last executed step and whether one listed the step's card.
function failureDigest(engine, names, setup = []) {
  const failure = engine?.failure;
  if (!failure || typeof failure !== "object" || failure.reason === "probe_not_reached") return null;
  if (failure.reason === "required_decision_pending") {
    const d = failure.decision || {};
    return { reason: failure.reason, at: { player: d.player, kind: d.kind,
      card: names.get(Number(d.card?.card)) || d.card?.name || null } };
  }
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
      phase: decision.phase || null,
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

// The choice a failed replay reached instead, in players' words: "我方的主要阶段1", "问我方是否发动效果".
function reachedText(at) {
  const who = SIDE[at.player] || "";
  if (at.kind === "idle") return `${who}的${PHASE_ZH[at.phase] || "回合"}`;
  if (at.kind === "battle") return `${who}的战斗阶段`;
  if (at.kind === "chain") return `${who}发动或连锁的机会`;
  if (at.kind === "effect_yn") return `问${who}是否发动效果`;
  return `${who}${DECISION_ZH[at.kind] || "的选择"}`;
}

// "按计划操作到第 10 步（对方发动「强制脱出装置」）时卡住了：之后对方有过发动或连锁的机会，但里面都没有这张卡".
// null without the step.
function failureText(failure) {
  if (failure?.reason === "required_decision_pending") {
    const at = failure.at;
    const what = at?.card && ["select_position", "select_place"].includes(at.kind)
      ? `为「${at.card}」${DECISION_ZH[at.kind]}` : DECISION_ZH[at?.kind] || "做选择";
    return `计划中的操作已经用完，但${SIDE[at?.player] || "玩家"}仍需${what}，相关处理尚未完成`;
  }
  if (!failure?.step) return null;
  const head = `按计划操作到第 ${failure.stepNumber} 步（${failure.step}）时卡住了`;
  const at = failure.at;
  const choices = at?.options?.length ? `（可选：${listText(at.options)}）` : "";
  let detail;
  if (failure.reason === "not_unique") detail = "引擎里有不止一个选项都符合这一步，没法确定是哪一个";
  else if (failure.reason === "setup_not_consumed") detail = "对局在这一步之前就结束了";
  else if (failure.reason === "engine_rejected_response") detail = "引擎不接受这个选择（例如选的卡不符合条件或张数不对）";
  else if (failure.waitsForWindow) {
    const side = SIDE[failure.stepPlayer] || "";
    const asked = failure.stepKind === "effect_yn";
    if (failure.passedListedCard) detail = "这张卡在之后的发动机会里出现过，但这一步写的时机、区域或效果没有对上";
    else if (failure.hasCard && failure.passedWindows) {
      detail = asked ? `之后${side}被问到是否发动效果时，问的都不是这张卡` : `之后${side}有过发动或连锁的机会，但里面都没有这张卡`;
    } else detail = asked ? `之后${side}再也没有被问到是否发动效果` : `之后${side}再也没有发动或连锁的机会`;
    if (at && !at.sameAsStep) detail += `，接着就到了${reachedText(at)}`;
  } else if (at?.sameAsStep) detail = `引擎给出的选项里没有这一项${choices}`;
  else if (at) {
    const what = at.card && (at.kind === "select_position" || at.kind === "select_place")
      ? `为「${at.card}」${DECISION_ZH[at.kind]}` : DECISION_ZH[at.kind] || "做别的选择";
    detail = `引擎此时要求${SIDE[at.player] || ""}${what}${choices}，与计划中的这一步不匹配`;
  } else detail = REASON_PLAIN.action_mismatch;
  return `${head}：${detail}`;
}

// ---------------------------------------------------------------------------------------------------
// Check points (probes).
// ---------------------------------------------------------------------------------------------------

// The times of the windows that offered the target (of every window when none did), each with the chain
// state at that window when it differs between windows at the same time.
function probeDigest(probe, names, turnPlayers) {
  const windows = Array.isArray(probe?.windows) ? probe.windows : [];
  const time = (window) => timeLabel(window?.phase, turnPlayers.get(window?.decision), probe?.player, window?.timing?.at);
  const items = windows.map((window) => ({ window, chain: windowChainText(window) }));
  const hits = items.filter(({ window }) => window?.contains_target);
  return {
    player: probe?.player,
    result: probeResult(probe),
    card: names.get(Number(probe?.target?.card)) || null,
    cmd: typeof probe?.target?.cmd === "string" ? probe.target.cmd : null,
    decisionKind: probe?.decision_kind || null,
    cardLevelOnly: probe?.card_level_only === true,
    interval: probe?.interval?.end === "chain_end" ? { end: "chain_end", completed: probe.interval.completed === true } : null,
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

// The chain state of a probe window (or the decision the engine stopped at), from the engine's own fields
// (ocg-sim-core adapter, 2026-10-18; the engine's Chinese replay writes the same words): chain_links (links
// not yet resolved), in_activation / in_resolution, after_chain_end (empty chain right after a chain
// resolved at the same turn, phase and battle timing, no action choice since). null when the engine did
// not report it.
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

function probeSentence(probe) {
  const who = SIDE[probe.player] || "";
  const name = probe.card || "目标卡";
  const at = probe.when?.length ? `在${listText(probe.when)}` : "";
  const activation = !probe.cmd || probe.cmd === "activate" || probe.cmd === "chain";
  const action = activation ? `发动${name}` : probe.cmd === "attack" ? `以${name}攻击` : `${CMD_ZH[probe.cmd] || ""}${name}`;
  const cardOnly = probe.cardLevelOnly ? "（只能确认到卡，不能确认是哪个效果）" : "";
  const yesNo = probe.decisionKind === "effect_yn" || probe.decisionKind === "yesno";
  const pending = probe.interval && !probe.interval.completed ? "（询问已出现，但这段连锁尚未处理完）" : "";
  switch (probe.result) {
    case "present":
      if (yesNo && probe.prompts?.length) return `${who}${at}被询问${listText(probe.prompts.map((text) => `「${text}」`))}${pending}`;
      if (probe.decisionKind === "yesno") return `${who}${at}出现了与「${name}」有关的是/否询问${pending}`;
      return `${who}${at}可以选择「${action}」${cardOnly}${pending}`;
    case "present_auto": return `「${name}」作为必发效果由引擎自动发动${cardOnly}`;
    case "absent":
      if (yesNo && probe.interval?.completed) return `从观察开始到本次连锁处理完，${who}没有出现所检查的「${name}」询问`;
      if (yesNo) return `${who}${at}没有出现与「${name}」有关的询问`;
      return activation ? `${who}${at}没有出现「${name}」的发动机会` : `${who}${at}没有出现「${action}」的选项`;
    case "not_reached": {
      // No decision of that kind for that player in the interval (the core asks nothing when nothing can be
      // activated), so this check point decides nothing.
      const missing = probe.decisionKind === "effect_yn" ? `${who}一次也没有被询问是否发动效果`
        : probe.decisionKind === "yesno" ? `${who}没有遇到是/否的选择`
          : probe.decisionKind === "chain" ? `${who}一次也没有得到发动或连锁的机会`
            : probe.decisionKind === "idle" ? `没有轮到${who}在主要阶段行动`
              : probe.decisionKind === "battle" ? `没有轮到${who}在战斗阶段行动` : `没有轮到${who}做选择`;
      const open = probe.decisionKind === "yesno" ? `会不会被问到与「${name}」有关的问题`
        : activation || probe.decisionKind === "effect_yn" ? `「${name}」能否发动` : `能否「${action}」`;
      return `要看的这段过程里${missing}，所以看不出${open}`;
    }
    default: return "引擎提前停下了，没有看完要看的这段过程";
  }
}

// ---------------------------------------------------------------------------------------------------
// Card names and the planned board.
// ---------------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------------
// Small text helpers.
// ---------------------------------------------------------------------------------------------------

function reasonText(codes = []) {
  const texts = [...new Set((codes || []).filter(Boolean).map((code) => REASON_PLAIN[code] || "引擎没能完成复现"))];
  return texts.length ? texts.join("；") : "引擎没能完成复现";
}

function listText(items) {
  return `${items.slice(0, 3).join("、")}${items.length > 3 ? "等" : ""}`;
}

function cleanTexts(values) {
  return (Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
}

const OBSERVE_MAX_CHARS = 30;
const UNREPRESENTABLE_MAX_CHARS = 120;
const PROBLEM_MAX_CHARS = 160;
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
