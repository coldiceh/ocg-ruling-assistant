export function extractSpecialWinConditions(cards = []) {
  return (cards || []).flatMap((card) => {
    const text = normalizeText(card?.effectText || card?.text || "");
    if (!/获得决斗胜利|デュエルに勝利|win the duel/iu.test(text)) return [];
    const threshold = parseOpponentLpThreshold(text);
    return [{
      id: `special_win:${String(card.id || card.cardId || card.name || "unknown")}`,
      type: "special_win_condition",
      cardId: String(card.id || card.cardId || ""),
      cardName: displayName(card),
      condition: {
        phase: /结束阶段|エンドフェイズ|end phase/iu.test(text) ? "END_PHASE" : "ANY",
        controller: "self",
        requiresFaceUp: true,
        requiresOnField: true,
        materialCount: /没有.{0,8}(?:超量|xyz).{0,4}素材|素材がない|no xyz material/iu.test(text) ? 0 : null,
        opponentLpAtMost: threshold,
      },
      timing: "after_resolution_checkpoint",
      startsChain: false,
      terminal: true,
      sourceType: "card_text",
      evidenceIds: card?.id || card?.cardId ? [String(card.id || card.cardId)] : [],
    }];
  });
}

export function evaluateSpecialWinConditions({ gameState = {}, conditions = [] } = {}) {
  const evaluations = (conditions || []).map((condition) => evaluateCondition(gameState, condition));
  const matched = evaluations.find((item) => item.status === "met") || null;
  return {
    matched,
    evaluations,
    terminalVerdict: matched ? {
      type: "special_win",
      winner: matched.condition.condition.controller,
      cardId: matched.condition.cardId,
      cardName: matched.condition.cardName,
      startsChain: false,
      terminal: true,
      reason: "special_win_condition_met_at_after_resolution_checkpoint",
      evidenceIds: matched.condition.evidenceIds,
    } : null,
  };
}

function evaluateCondition(gameState, condition) {
  const cardState = (gameState.cards || []).find((item) => sameId(item.cardId, condition.cardId)
    || normalizeText(item.name) === normalizeText(condition.cardName));
  const missingConditions = [];
  const failedConditions = [];
  const expected = condition.condition || {};

  checkKnown(gameState.phase, expected.phase, "phase", missingConditions, failedConditions, expected.phase === "ANY");
  if (!cardState) {
    missingConditions.push("card_state");
  } else {
    checkBoolean(cardState.onField, expected.requiresOnField, "on_field", missingConditions, failedConditions);
    checkBoolean(cardState.faceUp, expected.requiresFaceUp, "face_up", missingConditions, failedConditions);
    if (expected.materialCount !== null && expected.materialCount !== undefined) {
      checkKnown(cardState.materialCount, expected.materialCount, "material_count", missingConditions, failedConditions);
    }
  }
  if (expected.opponentLpAtMost !== null && expected.opponentLpAtMost !== undefined) {
    const lp = gameState.lp?.opponent;
    if (!Number.isFinite(lp)) missingConditions.push("opponent_lp");
    else if (lp > expected.opponentLpAtMost) failedConditions.push("opponent_lp_threshold");
  }
  return {
    condition,
    cardState: cardState || null,
    status: failedConditions.length ? "not_met" : missingConditions.length ? "missing_state" : "met",
    missingConditions,
    failedConditions,
  };
}

function parseOpponentLpThreshold(text) {
  const patterns = [
    /(?:对手|對手|相手).{0,12}(?:LP|基本分)\D{0,8}(\d{3,5})\s*以下/iu,
    /opponent.{0,20}(?:LP|life points?)\D{0,12}(\d{3,5})\s*or less/iu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function checkBoolean(actual, required, label, missing, failed) {
  if (!required) return;
  if (actual === null || actual === undefined) missing.push(label);
  else if (actual !== true) failed.push(label);
}

function checkKnown(actual, expected, label, missing, failed, skip = false) {
  if (skip) return;
  if (actual === null || actual === undefined || actual === "UNKNOWN") missing.push(label);
  else if (actual !== expected) failed.push(label);
}

function sameId(left, right) { return left && right && String(left) === String(right); }
function displayName(card) { return card?.cnName || card?.name || card?.jaName || card?.enName || "相关卡"; }
function normalizeText(value) { return String(value || "").normalize("NFKC").trim(); }
