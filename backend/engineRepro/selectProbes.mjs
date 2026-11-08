// Selection check points of the engine-reproduction plan (2026-11-08).
//
// A question such as "can it pick X", "does it check the materials' Level" or "is the range limited" is
// answered by the list of cards the engine offers at one card selection. The plan marks that selection on
// a branch with `select_probes` (plannerPrompt.mjs): the selection answered by setup step `after + 1`
// (same counting as the engine's probes), the player who selects, and the contrast candidates the planner
// put on the board on both sides of the question's condition ({card, from, controller?, side}).
//
// The engine's own probes only know idle / battle / chain / effect_yn / yesno and its actions schema allows
// no other fields (ocg-sim-core schema/actions.schema.json), so select_probes never reach the engine.
// The engine already returns every decision it asked (`result.decisions[]`, ocg-sim-core harness.py), a
// card selection with all the cards it offers (`options`: card, name, controller, from, seq), its phase,
// battle timing, turn player, chain state and the selection hint. This file reads that record.
//
// Everything here is mechanical: identity (card code, controller, zone) and the engine's own records.
// What the engine does not report is a card that could not be chosen: ygopro-core only lists the cards a
// selection allows. A declared candidate missing from the list is "not selectable" only when it was in the
// declared zone at that moment, which is derived from the planned board (`scenario`) and the engine's move /
// draw log up to the selection (`log_pos`); otherwise the result says why it cannot tell. The engine-side
// contract that would report every card of the zone with a selectable flag is in docs/ocg-engine-integration.md
// ("选择时点候选列表接口规格"). Nothing reads the question, judges a side or checks that both sides are present.

export const CARD_SELECTION_KINDS = Object.freeze(["select_card", "select_unselect", "select_sum", "select_tribute"]);
export const SELECT_PROBE_ZONES = Object.freeze(["hand", "deck", "grave", "removed", "extra", "mzone", "szone", "fzone", "pzone", "overlay"]);
export const SELECT_PROBE_SIDES = Object.freeze(["meets", "fails"]);
export const MAX_SELECT_PROBES = 3;
export const MAX_SELECT_CANDIDATES = 8;
// ygopro HINT_SELECTMSG (ocg-sim-core messages.py): the hint the core sends right before a selection.
const HINT_SELECTMSG = 3;
// Zones whose membership the engine's move / draw log tells exactly (MSG_MOVE locations, MSG_DRAW).
const TRACKED_ZONES = new Set(["hand", "deck", "grave", "removed", "extra", "mzone", "szone"]);

const isPlayer = (value) => value === 0 || value === 1;
// MSG_DRAW sets 0x80000000 on a card drawn face-up; the passcode is the low 31 bits.
const passcode = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number % 0x80000000 : null;
};

/** The plan's select_probes in the record's shape ({after, player, candidates}), or null. */
export function normalizeSelectProbes(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const probes = value.slice(0, MAX_SELECT_PROBES).map((probe) => {
    if (!probe || typeof probe !== "object" || !Number.isSafeInteger(probe.after) || !isPlayer(probe.player)) return null;
    const candidates = (Array.isArray(probe.candidates) ? probe.candidates : []).slice(0, MAX_SELECT_CANDIDATES)
      .map((item) => ({ card: passcode(item?.card), from: SELECT_PROBE_ZONES.includes(item?.from) ? item.from : null,
        ...(isPlayer(item?.controller) ? { controller: item.controller } : {}),
        side: SELECT_PROBE_SIDES.includes(item?.side) ? item.side : null }))
      .filter((item) => item.card && item.from && item.side);
    return { after: probe.after, player: probe.player, candidates };
  }).filter(Boolean);
  return probes.length ? probes : null;
}

/**
 * Shape problems of a branch's select_probes (plan check, reproduce.mjs checkPlan), in the plan checker's
 * words. `setup` is the branch's actions.setup, `allowed` the plan's allowed card codes (a Set).
 * Shape and identity only: both sides being present is not checked here (the planner prompt asks for it).
 */
export function checkSelectProbes(value, setup, allowed = new Set()) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SELECT_PROBES) return [`select_probes 应为最多 ${MAX_SELECT_PROBES} 项的数组`];
  const steps = Array.isArray(setup) ? setup : [];
  const problems = [];
  value.forEach((probe, i) => {
    const at = `select_probes[${i}]`;
    if (!probe || typeof probe !== "object") { problems.push(`${at} 应为对象`); return; }
    if (!isPlayer(probe.player)) problems.push(`${at}.player 只能是 0 或 1`);
    if (!Number.isSafeInteger(probe.after) || probe.after < 0 || probe.after >= steps.length) {
      problems.push(`${at}.after 应为 0 到 ${Math.max(0, steps.length - 1)} 的整数：回答这次选卡的那一步（setup 第 after+1 步）必须写在 setup 里`);
    } else {
      const step = steps[probe.after];
      if (!CARD_SELECTION_KINDS.includes(step?.decision)) {
        problems.push(`${at}.after=${probe.after}：setup 第 ${probe.after + 1} 步是 ${step?.decision || "（缺失）"}，不是选卡步骤（${CARD_SELECTION_KINDS.join(" / ")}）`);
      } else if (isPlayer(probe.player) && step.player !== probe.player) {
        problems.push(`${at}.player=${probe.player} 与 setup 第 ${probe.after + 1} 步的玩家 ${step.player} 不一致`);
      }
    }
    if (!Array.isArray(probe.candidates) || !probe.candidates.length || probe.candidates.length > MAX_SELECT_CANDIDATES) {
      problems.push(`${at}.candidates 应为 1–${MAX_SELECT_CANDIDATES} 项的数组`);
      return;
    }
    probe.candidates.forEach((item, j) => {
      const where = `${at}.candidates[${j}]`;
      const code = Number(item?.card);
      if (!Number.isSafeInteger(code) || !allowed.has(code)) problems.push(`${where} 的卡号 ${item?.card} 不在允许的卡号列表中`);
      if (!SELECT_PROBE_ZONES.includes(item?.from)) problems.push(`${where}.from 取值无效（${SELECT_PROBE_ZONES.join(", ")}）`);
      if (item?.controller !== undefined && !isPlayer(item.controller)) problems.push(`${where}.controller 只能是 0 或 1`);
      if (!SELECT_PROBE_SIDES.includes(item?.side)) problems.push(`${where}.side 只能是 "meets" 或 "fails"`);
    });
  });
  return [...new Set(problems)];
}

/** Card codes whose card data the results name: every offered card and every declared candidate. */
export function selectProbeCodes(branches = []) {
  const codes = new Set();
  for (const branch of branches) {
    for (const probe of branch?.selectProbes || []) {
      for (const item of probe.candidates || []) codes.add(item.card);
      const record = selectionRecord(branch?.engine, probe.after);
      for (const option of cardOptions(record?.decision)) codes.add(option.card);
    }
  }
  return [...codes].filter(Boolean).sort((a, b) => a - b);
}

/**
 * The results of a branch's select_probes, in plan order. `facts` maps card code -> the engine's card data
 * (op "cards"); `factsUnavailable` says that lookup failed. Each result:
 *   { after, player, status, decision, selectable: [card], candidates: [candidate], factsUnavailable? }
 * status: "observed" (the selection is in the engine's record, its offered cards listed), "not_reached"
 * (the replay never answered that step), "not_card_selection" (that step answered something else),
 * "no_options" (an engine record without the offered cards).
 * candidate.result: "selectable" | "not_selectable" (in the declared zone at that moment, not offered) |
 * "left_zone" (it had left the declared zone before the selection) | "not_placed" (the board never put it
 * there) | "presence_unknown" (the engine's log is missing or the zone is not tracked).
 */
export function evaluateSelectProbes(branch, { facts = new Map(), factsUnavailable = false } = {}) {
  const probes = Array.isArray(branch?.selectProbes) ? branch.selectProbes : [];
  const engine = branch?.engine || null;
  return probes.map((probe) => {
    const base = { after: probe.after, player: probe.player, ...(factsUnavailable ? { factsUnavailable: true } : {}) };
    const record = selectionRecord(engine, probe.after);
    const plain = (status) => ({ ...base, status, decision: record ? decisionView(record) : null, selectable: [],
      candidates: probe.candidates.map((item) => candidateView(item, probe, facts, "presence_unknown")) });
    if (!record) return plain("not_reached");
    if (!CARD_SELECTION_KINDS.includes(record.decision?.kind)) return plain("not_card_selection");
    if (!Array.isArray(record.decision.options)) return plain("no_options");
    const offered = cardOptions(record.decision);
    const selectable = offered.map((option) => ({ card: option.card, name: cardName(option.card, facts, option.name),
      controller: option.controller, from: option.from, facts: compactFacts(facts.get(option.card)) }));
    const candidates = probe.candidates.map((item) => {
      const controller = isPlayer(item.controller) ? item.controller : probe.player;
      const listed = offered.find((option) => option.card === item.card && option.controller === controller && sameZone(option.from, item.from));
      if (listed) return candidateView(item, probe, facts, "selectable", listed.name);
      const sameCard = offered.find((option) => option.card === item.card);
      return candidateView(item, probe, facts, presenceAt(engine, branch?.scenario, { ...item, controller }, record.log_pos), sameCard?.name);
    });
    return { ...base, status: "observed", decision: decisionView(record), selectable, candidates };
  });
}

// The first decision the replay answered with setup step `after` (0-based; a selection made one card per
// prompt has several records for that step, the first lists every card).
function selectionRecord(engine, after) {
  const records = Array.isArray(engine?.decisions) ? engine.decisions : [];
  return records.find((entry) => entry?.by === "setup" && entry.step === after && entry.decision && typeof entry.decision === "object") || null;
}

// The cards a selection offers: options naming a card that are not already chosen (select_unselect lists
// the chosen ones too, as selected: true).
function cardOptions(decision) {
  return (Array.isArray(decision?.options) ? decision.options : [])
    .filter((option) => option && typeof option === "object" && passcode(option.card) && option.selected !== true)
    .map((option) => ({ card: passcode(option.card), name: typeof option.name === "string" ? option.name : null,
      controller: isPlayer(option.controller) ? option.controller : null, from: typeof option.from === "string" ? option.from : null }));
}

// The engine names a card in the field zone or a pendulum zone by its spell/trap-zone location.
function sameZone(offeredFrom, declaredFrom) {
  if (offeredFrom === declaredFrom) return true;
  return offeredFrom === "szone" && (declaredFrom === "fzone" || declaredFrom === "pzone");
}

// The decision fields the short section words the moment with (same names as the engine's probe windows).
function decisionView(record) {
  const d = record.decision;
  const hint = d.hint && typeof d.hint === "object" && d.hint.hint_type === HINT_SELECTMSG && d.hint.player === d.player
    && typeof d.hint.text === "string" && d.hint.text.trim() ? d.hint.text.trim() : null;
  const view = { index: Number.isSafeInteger(d.index) ? d.index : null, kind: d.kind, player: d.player, phase: d.phase || null,
    turn_player: isPlayer(d.turn_player) ? d.turn_player : null, at: d.timing?.at || null, hint };
  for (const key of ["chain_links", "min", "max"]) if (Number.isSafeInteger(d[key]) && d[key] >= 0) view[key] = d[key];
  for (const key of ["in_activation", "in_resolution", "after_chain_end"]) if (typeof d[key] === "boolean") view[key] = d[key];
  return view;
}

function candidateView(item, probe, facts, result, offeredName = null) {
  return { card: item.card, name: cardName(item.card, facts, offeredName), from: item.from,
    controller: isPlayer(item.controller) ? item.controller : probe.player, side: item.side, result,
    facts: compactFacts(facts.get(item.card)) };
}

function cardName(code, facts, fallback) {
  const known = facts.get(code);
  if (known?.exists !== false && typeof known?.name === "string" && known.name.trim()) return known.name.trim();
  return typeof fallback === "string" && fallback.trim() ? fallback.trim() : null;
}

// The card's printed data from the engine's card database (op "cards"): kind, Level / Rank / Link Rating,
// Attribute, Type, ATK / DEF. Not the in-duel values (the engine does not report those at a selection).
function compactFacts(card) {
  if (!card || card.exists === false) return null;
  const out = {};
  if (Array.isArray(card.types)) out.types = card.types.filter((item) => typeof item === "string" && item);
  for (const key of ["level", "rank", "link_rating", "atk", "def"]) if (Number.isFinite(card[key])) out[key] = card[key];
  for (const key of ["attribute", "race"]) if (typeof card[key] === "string" && card[key]) out[key] = card[key];
  return Object.keys(out).length ? out : null;
}

// Whether the candidate was still in its declared zone when the selection was asked: the copies the planned
// board put there, minus those the engine's log moved out (MSG_MOVE / MSG_DRAW) before that decision, plus
// those it moved in.
function presenceAt(engine, scenario, { card, from, controller }, logPos) {
  const placed = placedCount(scenario, controller, from, card);
  if (!placed) return "not_placed";
  if (!TRACKED_ZONES.has(from) || !Array.isArray(engine?.log) || !Number.isSafeInteger(logPos)) return "presence_unknown";
  let count = placed;
  for (const event of engine.log.slice(0, logPos)) {
    if (event?.type === "move" && passcode(event.card) === card) {
      if (event.from?.player === controller && event.from?.location === from) count -= 1;
      if (event.to?.player === controller && event.to?.location === from) count += 1;
    } else if (event?.type === "draw" && event.player === controller && (from === "deck" || from === "hand")) {
      const drawn = (Array.isArray(event.cards) ? event.cards : []).filter((item) => passcode(item?.card ?? item) === card).length;
      count += from === "deck" ? -drawn : drawn;
    }
  }
  return count > 0 ? "not_selectable" : "left_zone";
}

// Copies of a card the planned board (ocg-repro-scenario/v1) puts in one zone of one player.
function placedCount(scenario, controller, zone, card) {
  const player = Array.isArray(scenario?.players) ? scenario.players[controller] : null;
  if (!player || typeof player !== "object") return 0;
  const codes = (list, pick = (item) => item) => (Array.isArray(list) ? list : []).filter((item) => passcode(pick(item)) === card).length;
  switch (zone) {
    case "hand": case "deck": case "grave": return codes(player[zone]);
    case "extra": return codes(player.extra) + codes(player.extra_faceup);
    case "removed": return codes(player.removed, (item) => item?.code);
    case "mzone": case "szone": return codes(player[zone], (item) => item?.code);
    case "fzone": return passcode(player.fzone?.code) === card ? 1 : 0;
    case "pzone": return codes((Array.isArray(player.pzone) ? player.pzone : []).filter(Boolean), (item) => item?.code);
    case "overlay": return (Array.isArray(player.mzone) ? player.mzone : []).reduce((sum, monster) => sum + codes(monster?.overlay), 0);
    default: return 0;
  }
}
