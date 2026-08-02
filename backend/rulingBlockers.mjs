export const RULING_BLOCKER_IDS = Object.freeze([
  "activation.no_legal_target",
  "activation.no_legal_effect_application",
  "activation.currently_resolving_card_cannot_be_returned_if_rule_applies",
  "activation.illegal_chain_link",
  "immediate_special_win_condition_ends_duel",
]);

/**
 * Legacy compatibility surface.
 *
 * Earlier revisions accepted caller-authored objects carrying
 * `proofStatus: "verified"` and converted their boolean fields into a final
 * ruling.  A string supplied by the caller is not an independently verified
 * proof, so this compatibility function now always fails closed.  Production
 * authority is provided by the exact official-Q&A binder or the formal proof
 * verifier, not by this legacy adapter.
 */
export function evaluateRulingBlockers() {
  return {
    hasBlocker: false,
    blockers: [],
    primaryVerdict: null,
    reason: "",
    hypotheticalBranch: null,
    resolutionSteps: [],
    finalJudgeSummary: [],
    proofStatus: "formal_proof_required",
  };
}

export function buildBlockerAnswer() {
  return null;
}
