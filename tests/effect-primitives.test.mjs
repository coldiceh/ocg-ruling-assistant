import assert from "node:assert/strict";
import test from "node:test";
import { resolvePrimitiveSequence } from "../backend/effectResolutionEngine.mjs";
import { createEffectPrimitive } from "../backend/effectPrimitives.mjs";

test("target lost skips only the target primitive and the non-target primitive continues", () => {
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("discard_from_hand", { id: "discard", player: "self", amount: 1 }),
    createEffectPrimitive("place_target_as_continuous_trap", { id: "place", targetId: "target", targetExpectedZone: "monster_zone" }),
  ], {
    cards: [{ cardId: "target", name: "对象", zone: "graveyard" }],
    hands: { self: [{ cardId: "hand-1", name: "手卡" }] },
    graveyards: { self: [] },
    resolutionContext: { targets: [{ cardId: "target", expectedZone: "monster_zone" }] },
  });
  assert.equal(result.resolutionStatus, "partially_resolved");
  assert.equal(result.steps[0].status, "applied");
  assert.equal(result.steps[1].status, "skipped");
  assert.equal(result.gameState.hands.self.length, 0);
  assert.ok(result.ruleTrace.some((item) => item.event === "non_target_part_continued"));
  assert.ok(result.ruleTrace.some((item) => item.event === "target_lost_at_resolution"));
  assert.ok(result.ruleTrace.some((item) => item.event === "target_part_skipped"));
});

test("target lost causes a THEN-connected primitive to be skipped", () => {
  const result = resolvePrimitiveSequence([
    { id: "destroy", primitive: createEffectPrimitive("destroy_target", { targetId: "target", targetExpectedZone: "monster_zone" }) },
    { id: "draw", connector: "THEN", primitive: createEffectPrimitive("draw_cards", { player: "self", amount: 1 }) },
  ], {
    cards: [{ cardId: "target", zone: "graveyard" }],
    decks: { self: [{ cardId: "deck-1" }] },
    hands: { self: [] },
    resolutionContext: { targets: [{ cardId: "target", expectedZone: "monster_zone" }] },
  });
  assert.equal(result.resolutionStatus, "failed");
  assert.equal(result.steps[0].status, "skipped");
  assert.equal(result.steps[1].status, "skipped");
  assert.match(result.steps[1].reason, /requires_previous_success/u);
  assert.equal(result.gameState.hands.self.length, 0);
});

test("source moved allows source-independent processing but skips source-dependent processing", () => {
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("discard_from_hand", { id: "independent", player: "self", amount: 1 }),
    createEffectPrimitive("special_summon_source", { id: "summon", sourceCardId: "source", sourceExpectedZone: "graveyard" }),
  ], {
    cards: [{ cardId: "source", name: "来源", zone: "banished" }],
    hands: { self: [{ cardId: "hand-1" }] },
    graveyards: { self: [] },
    resolutionContext: { source: { cardId: "source", expectedZone: "graveyard" } },
  });
  assert.equal(result.resolutionStatus, "partially_resolved");
  assert.equal(result.steps[0].status, "applied");
  assert.equal(result.steps[1].status, "skipped");
  assert.ok(result.ruleTrace.some((item) => item.event === "source_independent_part_continued"));
  assert.ok(result.ruleTrace.some((item) => item.event === "source_dependent_part_skipped"));
});

test("source-dependent summon fails when the source left its expected zone", () => {
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("special_summon_source", { sourceCardId: "source", sourceExpectedZone: "graveyard" }),
  ], {
    cards: [{ cardId: "source", zone: "banished" }],
    resolutionContext: { source: { cardId: "source", expectedZone: "graveyard" } },
  });
  assert.equal(result.resolutionStatus, "failed");
  assert.ok(result.ruleTrace.some((item) => item.event === "source_unavailable_at_resolution"));
});

test("unknown primitive state returns insufficient instead of guessing", () => {
  const result = resolvePrimitiveSequence([
    createEffectPrimitive("draw_cards", { player: "self", amount: 1 }),
  ], {});
  assert.equal(result.resolutionStatus, "insufficient");
  assert.equal(result.steps[0].reason, "deck_or_hand_contents_unknown");
});
