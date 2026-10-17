import { PLANNER_INSTRUCTIONS, buildPlannerInput, buildRepairInput } from "./plannerPrompt.mjs";
import { estimateTokens } from "./modelCalls.mjs";

// This is a soft context target, separate from the hard monetary reservation.
// Never shorten the question, its resolved cards, or a repair's failure details.
export function preparePlannerContext({ question, cards, relatedCards = [], toolCards = [],
  includeOfficialQa = false, maxInput = 16000, repair = null }) {
  const limit = Number.isSafeInteger(maxInput) && maxInput > 0 ? maxInput : 16000;
  let related = relatedCards, tools = toolCards;
  const build = () => {
    const plannerInput = buildPlannerInput({ question, cards, relatedCards: related, toolCards: tools, includeOfficialQa });
    return repair ? buildRepairInput({ ...repair, plannerInput }) : plannerInput;
  };
  const count = (input) => estimateTokens(`${PLANNER_INSTRUCTIONS}\n${input}`);
  let input = build();
  const initialTokensEstimate = count(input);
  const removed = [];
  if (count(input) > limit && related.length) {
    removed.push({ kind: "related_cards", refs: related.map((entry) => ({ ref: entry.ref, kind: entry.kind,
      cards: entry.cards.map((card) => ({ code: card.code, name: card.name })) })) });
    related = [];
    input = build();
  }
  if (count(input) > limit && tools.length) {
    removed.push({ kind: "tool_cards", cards: tools.map((card) => ({ code: card.code, name: card.name })) });
    tools = [];
    input = build();
  }
  const inputTokensEstimate = count(input);
  return { input, context: { stage: repair ? "repair" : "plan", maxInputTokens: limit,
    initialTokensEstimate, inputTokensEstimate, trimmed: removed.length > 0, removed,
    overLimitAfterTrim: inputTokensEstimate > limit } };
}
