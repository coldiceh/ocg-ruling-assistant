import { evaluateSpecialWinConditions, extractSpecialWinConditions } from "./specialWinConditions.mjs";

export function createResolutionGameState({ lp = {}, phase = "UNKNOWN", cards = [], chainPosition = null } = {}) {
  return {
    lp: {
      self: numberOrNull(lp.self),
      opponent: numberOrNull(lp.opponent),
    },
    phase,
    currentChainPosition: chainPosition,
    lastResolvedChainLink: null,
    duelEnded: false,
    terminalVerdict: null,
    cards: (cards || []).map((card) => ({
      cardId: String(card.cardId || card.id || ""),
      name: card.name || "unknown",
      controller: card.controller || "unknown",
      faceUp: booleanOrNull(card.faceUp),
      onField: booleanOrNull(card.onField),
      materialCount: numberOrNull(card.materialCount),
      zone: card.zone || "unknown",
    })),
  };
}

export function runAfterResolutionCheckpoint({ gameState, cards = [], specialWinConditions, specialLoseConditions = [] } = {}) {
  const state = clone(gameState || createResolutionGameState());
  const conditions = specialWinConditions || extractSpecialWinConditions(cards);
  const duelEndConditions = evaluateLpTerminalState(state);
  const specialWins = evaluateSpecialWinConditions({ gameState: state, conditions });
  const specialLosses = evaluateDeclaredLoseConditions(state, specialLoseConditions);
  const existingTerminal = state.duelEnded && state.terminalVerdict ? state.terminalVerdict : null;
  const terminalVerdict = existingTerminal || duelEndConditions.terminalVerdict || specialWins.terminalVerdict || specialLosses.terminalVerdict || null;
  if (terminalVerdict) {
    state.duelEnded = true;
    state.terminalVerdict = terminalVerdict;
  }
  return {
    id: `checkpoint_after_${state.lastResolvedChainLink || "state_update"}`,
    timing: "after_resolution_checkpoint",
    chainLink: state.lastResolvedChainLink,
    duelEnded: state.duelEnded,
    terminalVerdict,
    checks: {
      duelEndConditions,
      specialWinConditions: specialWins.evaluations,
      specialLoseConditions: specialLosses.evaluations,
      terminalState: { wasAlreadyTerminal: Boolean(existingTerminal), duelEnded: state.duelEnded },
    },
    gameState: state,
  };
}

export function resolveChainWithCheckpoints({ initialGameState, chainLinks = [], cards = [], specialWinConditions, specialLoseConditions = [] } = {}) {
  let state = clone(initialGameState || createResolutionGameState());
  const ordered = [...chainLinks].sort((left, right) => chainOrder(right) - chainOrder(left));
  const linkResults = [];
  const checkpoints = [];
  const resolutionSteps = [];
  const stateSnapshots = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const link = ordered[index];
    if (state.duelEnded) {
      const stopped = { ...link, status: "not_processed", reason: "duel_already_ended" };
      linkResults.push(stopped);
      resolutionSteps.push({ chainLink: link.id, status: stopped.status, reason: stopped.reason, action: `决斗已经结束，${link.id}不再处理。`, stateChange: {} });
      continue;
    }

    const applied = applyChainLink(state, link);
    state = applied.gameState;
    linkResults.push({ ...link, status: "resolved", reason: "resolved_normally", stateChange: applied.stateChange });
    resolutionSteps.push({ chainLink: link.id, status: "resolved", action: applied.action, stateChange: applied.stateChange });
    stateSnapshots.push({ after: link.id, stage: "effect_resolution", gameState: clone(state) });

    const checkpoint = runAfterResolutionCheckpoint({ gameState: state, cards, specialWinConditions, specialLoseConditions });
    state = checkpoint.gameState;
    checkpoints.push(checkpoint);
    resolutionSteps.push({ chainLink: "checkpoint", status: "completed", action: `${link.id}处理后进行处理后检查。`, stateChange: { duelEnded: checkpoint.duelEnded } });
    stateSnapshots.push({ after: link.id, stage: "after_resolution_checkpoint", gameState: clone(state) });
    if (checkpoint.terminalVerdict?.type === "special_win") {
      resolutionSteps.push({
        chainLink: "terminal",
        status: "completed",
        action: `${checkpoint.terminalVerdict.cardName}的特殊胜利条件满足；该条件不开连锁，条件满足时立即胜利，决斗结束。`,
        stateChange: { duelEnded: true, terminalVerdict: checkpoint.terminalVerdict },
      });
    }
  }

  return {
    chainLinks: linkResults,
    checkpoints,
    resolutionSteps,
    stateSnapshots,
    finalGameState: state,
    terminalVerdict: state.terminalVerdict,
  };
}

function applyChainLink(gameState, link) {
  const state = clone(gameState);
  state.currentChainPosition = link.id;
  state.lastResolvedChainLink = link.id;
  const effect = link.effect || {};
  if (effect.type === "damage") {
    const player = effect.player === "self" ? "self" : "opponent";
    const before = state.lp[player];
    const after = Number.isFinite(before) ? Math.max(0, before - Number(effect.amount || 0)) : null;
    state.lp[player] = after;
    return {
      gameState: state,
      stateChange: { lp: { player, before, after, amount: Number(effect.amount || 0) } },
      action: `${link.id}${link.sourceCardName ? `【${link.sourceCardName}】` : ""}先处理，给与${player === "opponent" ? "对方" : "我方"}${Number(effect.amount || 0)}伤害，${player === "opponent" ? "对方" : "我方"} LP 从 ${before} 变成 ${after}。`,
    };
  }
  if (effect.type === "destroy") {
    const target = state.cards.find((card) => String(card.cardId) === String(effect.targetCardId));
    if (target) { target.onField = false; target.faceUp = false; target.zone = "graveyard"; }
    return { gameState: state, stateChange: { destroyedCardId: effect.targetCardId || null }, action: `${link.id}处理破坏效果。` };
  }
  return { gameState: state, stateChange: {}, action: `${link.id}处理完成。` };
}

function evaluateLpTerminalState(state) {
  const selfZero = Number.isFinite(state.lp?.self) && state.lp.self <= 0;
  const opponentZero = Number.isFinite(state.lp?.opponent) && state.lp.opponent <= 0;
  let terminalVerdict = null;
  if (selfZero || opponentZero) terminalVerdict = {
    type: selfZero && opponentZero ? "draw" : "lp_loss",
    winner: selfZero === opponentZero ? null : selfZero ? "opponent" : "self",
    startsChain: false,
    terminal: true,
    reason: "life_points_reached_zero",
    evidenceIds: [],
  };
  return { checked: true, selfZero, opponentZero, terminalVerdict };
}

function evaluateDeclaredLoseConditions(state, conditions) {
  const evaluations = (conditions || []).map((condition) => {
    const met = typeof condition.evaluate === "function" ? Boolean(condition.evaluate(state)) : false;
    return { id: condition.id || "special_lose", status: met ? "met" : "not_met" };
  });
  const matched = evaluations.find((item) => item.status === "met");
  return {
    evaluations,
    terminalVerdict: matched ? { type: "special_loss", terminal: true, startsChain: false, reason: matched.id, evidenceIds: [] } : null,
  };
}

function chainOrder(link) { return Number(link.order ?? String(link.id || "").match(/\d+/u)?.[0] ?? 0); }
function numberOrNull(value) { return Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null; }
function booleanOrNull(value) { return typeof value === "boolean" ? value : null; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
