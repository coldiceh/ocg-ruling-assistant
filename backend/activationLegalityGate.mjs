import { findMatchingRestrictions } from "./activeRestrictions.mjs";

export const ACTIVATION_BLOCKER_CODES = Object.freeze([
  "activation.card_identity_uncertain",
  "activation.effect_number_uncertain",
  "activation.no_legal_target",
  "activation.no_legal_effect_application",
  "activation.forbidden_by_active_restriction",
  "activation.invalid_phase_or_timing",
  "activation.currently_resolving_card_cannot_be_returned_if_rule_applies",
  "activation.illegal_chain_link",
]);

/**
 * Pure activation legality gate. It consumes structured facts only; natural
 * language parsing and card lookup belong before this function.
 */
export function validateActivation(candidateEffect = {}, gameState = {}) {
  const blockers = [];
  const assumptions = [...new Set(candidateEffect.assumptions || [])];

  if (candidateEffect.cardIdentityStatus === "uncertain" || candidateEffect.cardIdentityConfirmed === false) {
    blockers.push(makeBlocker(
      "activation.card_identity_uncertain",
      "发动效果的卡片身份尚未唯一确认。",
      candidateEffect.sourceCard
    ));
  }
  if (candidateEffect.effectNumberRequired && !isKnown(candidateEffect.effectNumber)) {
    blockers.push(makeBlocker(
      "activation.effect_number_uncertain",
      "题目未能唯一确定要发动的是哪个效果编号。",
      candidateEffect.sourceCard
    ));
  }
  if (candidateEffect.requiresTarget && !hasLegalCandidate(candidateEffect.legalTargets, candidateEffect.targetIsLegal)) {
    blockers.push(makeBlocker(
      "activation.no_legal_target",
      "发动时不存在合法对象。",
      candidateEffect.sourceCard
    ));
  }
  if (candidateEffect.requiresLegalEffectApplication
    && !hasLegalCandidate(candidateEffect.legalApplications, candidateEffect.hasLegalEffectApplication)) {
    blockers.push(makeBlocker(
      "activation.no_legal_effect_application",
      "发动时不存在能够合法适用的必要效果处理。",
      candidateEffect.sourceCard
    ));
  }

  const restrictions = findMatchingRestrictions(candidateEffect, gameState)
    .filter((restriction) => restriction.restrictionType === "cannot_activate");
  for (const restriction of restrictions) {
    blockers.push(makeBlocker(
      "activation.forbidden_by_active_restriction",
      restriction.explanation || "当前存在限制，禁止该类效果发动。",
      restriction.sourceCard,
      { restriction }
    ));
  }

  if (!timingIsLegal(candidateEffect, gameState)) {
    blockers.push(makeBlocker(
      "activation.invalid_phase_or_timing",
      "当前阶段或时点不允许发动该效果。",
      candidateEffect.sourceCard
    ));
  }
  if (candidateEffect.attemptsToReturnCurrentlyResolvingCard === true) {
    blockers.push(makeBlocker(
      "activation.currently_resolving_card_cannot_be_returned_if_rule_applies",
      "发动后正在连锁中处理的通常魔法/陷阱不能作为返回手牌或卡组的处理对象。",
      candidateEffect.returnTarget || candidateEffect.sourceCard
    ));
  }
  if (candidateEffect.chainLinkLegal === false || candidateEffect.previousChainLinkLegal === false) {
    blockers.push(makeBlocker(
      "activation.illegal_chain_link",
      candidateEffect.chainLegalityReason || "该连锁点不满足合法发动条件。",
      candidateEffect.sourceCard
    ));
  }

  return {
    canActivate: blockers.length === 0,
    blockers: dedupeBlockers(blockers),
    assumptions,
  };
}

export function makeActivationBlocker(code, explanation, source = null, details = {}) {
  if (!ACTIVATION_BLOCKER_CODES.includes(code)) throw new TypeError(`unknown activation blocker: ${code}`);
  return makeBlocker(code, explanation, source, details);
}

function timingIsLegal(effect, state) {
  if (effect.timingLegal === false) return false;
  const allowedPhases = effect.allowedPhases || [];
  if (!allowedPhases.length) return true;
  const current = effect.phase || state.phase || state.timing?.phase || "unknown";
  if (!isKnown(current)) return true;
  return allowedPhases.some((phase) => normalize(phase) === normalize(current));
}

function hasLegalCandidate(candidates, explicit) {
  if (explicit === true) return true;
  if (explicit === false) return false;
  if (Array.isArray(candidates)) return candidates.some((item) => item?.legal !== false);
  return false;
}

function makeBlocker(code, explanation, source, details = {}) {
  return {
    code,
    source: sourceName(source),
    explanation,
    ...details,
  };
}

function sourceName(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.cnName || value.name || value.jaName || value.enName || value.id || null;
}

function dedupeBlockers(items) {
  const map = new Map();
  for (const item of items) map.set(`${item.code}:${item.source || ""}`, item);
  return [...map.values()];
}

function isKnown(value) {
  return value !== undefined && value !== null && value !== "" && value !== "unknown";
}

function normalize(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}
