import assert from "node:assert/strict";
import test from "node:test";
import { buildEventTimelineFromFormalQuery, deriveStateAtTiming } from "../backend/eventTimeline.mjs";
import { buildGameStateFromFormalQuery } from "../backend/gameState.mjs";

test("A. battle destruction creates a pending graveyard transition", () => {
  const { gameState, timeline } = build("青眼暴君龙被战破的时候", "青眼暴君龙");
  assert.ok(timeline.events.some((item) => item.type === "battle_destroyed" && item.status === "completed"));
  assert.ok(timeline.events.some((item) => item.type === "pending_send_to_graveyard" && item.status === "pending"));
  assert.equal(timeline.events.some((item) => item.type === "sent_to_graveyard" && item.status === "completed"), false);
  assert.equal(deriveStateAtTiming(gameState, timeline, "青眼暴君龙").zoneStatus, "pending_send_to_graveyard");
});

test("B. an explicit completed send derives the graveyard state", () => {
  const { gameState, timeline } = build("青眼暴君龙被战破并送去墓地后", "青眼暴君龙");
  assert.ok(timeline.events.some((item) => item.type === "battle_destroyed" && item.status === "completed"));
  assert.ok(timeline.events.some((item) => item.type === "sent_to_graveyard" && item.status === "completed"));
  assert.equal(timeline.events.some((item) => item.type === "pending_send_to_graveyard"), false);
  assert.equal(deriveStateAtTiming(gameState, timeline, "青眼暴君龙").zoneStatus, "in_graveyard");
});

test("C. not destroyed and remaining in the monster zone derives on-field state", () => {
  const { gameState, timeline } = build("青眼暴君龙没有被战斗破坏，仍在怪兽区", "青眼暴君龙");
  const derived = deriveStateAtTiming(gameState, timeline, "青眼暴君龙");
  assert.equal(timeline.events.some((item) => item.type === "battle_destroyed" && item.status === "completed"), false);
  assert.equal(derived.battleDestroyedStatus, "not_destroyed");
  assert.equal(derived.zoneStatus, "on_field");
});

test("D. battle destruction followed by banishment derives banished state", () => {
  const { gameState, timeline } = build("青眼暴君龙被战破并被除外", "青眼暴君龙");
  assert.ok(timeline.events.some((item) => item.type === "battle_destroyed"));
  assert.ok(timeline.events.some((item) => item.type === "temporarily_banished" && item.status === "completed"));
  assert.equal(deriveStateAtTiming(gameState, timeline, "青眼暴君龙").zoneStatus, "banished");
});

test("E. damage-step-end activation keeps the destroyed monster in a pending transition", () => {
  const { gameState, timeline } = build("卡通怪兽被战破，在伤害步骤结束阶段发动效果的时候", "referenced_toon_monster", ["卡通怪兽"]);
  const derived = deriveStateAtTiming(gameState, timeline, "referenced_toon_monster");
  assert.ok(timeline.events.some((item) => item.type === "battle_destroyed"));
  assert.ok(timeline.events.some((item) => item.type === "damage_step_end"));
  assert.ok(timeline.events.some((item) => item.type === "effect_activation"));
  assert.equal(timeline.timing.currentWindow, "damage_step_end");
  assert.equal(derived.zoneStatus, "pending_send_to_graveyard");
  assert.notEqual(derived.zoneStatus, "in_graveyard");
});

test("F. a banish question creates a questioned event, not a completed transition", () => {
  const query = formalQuery(
    "能用完美世界-卡通世界的效果除外该卡通怪兽吗？",
    "完美世界-卡通世界",
    ["完美世界-卡通世界", "referenced_toon_monster"]
  );
  query.cards[1].aliases = ["卡通怪兽", "该卡通怪兽"];
  const gameState = buildGameStateFromFormalQuery(query);
  const timeline = buildEventTimelineFromFormalQuery(query, gameState);
  const event = timeline.events.find((item) => item.type === "temporarily_banished" && item.card === "referenced_toon_monster");
  assert.ok(event);
  assert.equal(event.status, "questioned");
  assert.equal(timeline.events.some((item) => item.type === "temporarily_banished" && item.status === "completed"), false);
  assert.equal(deriveStateAtTiming(gameState, timeline, "完美世界-卡通世界").zoneStatus, "unknown");
});

for (const phrase of [
  "青眼暴君龙送墓后，这个效果在哪里发动？",
  "青眼暴君龙送去墓地后，这个效果在哪里发动？",
  "青眼暴君龙送入墓地后，这个效果在哪里发动？",
  "青眼暴君龙被战斗破坏并送去墓地，这个效果在哪里发动？",
  "青眼暴君龙被战破并送墓，这个效果在哪里发动？",
  "青眼暴君龙送去墓地的场合，这个效果在哪里发动？",
]) {
  test(`completed graveyard phrase: ${phrase}`, () => {
    const { gameState, timeline } = build(phrase, "青眼暴君龙");
    const entity = gameState.entities[0];
    assert.equal(entity.wasSentToGraveyard, true);
    assert.equal(entity.currentZone, "graveyard");
    assert.ok(timeline.events.some((item) => item.type === "sent_to_graveyard" && item.status === "completed"));
    assert.equal(deriveStateAtTiming(gameState, timeline, "青眼暴君龙").zoneStatus, "in_graveyard");
  });
}

for (const phrase of [
  "青眼暴君龙被除外后，这个效果在哪里发动？",
  "青眼暴君龙被战斗破坏并被除外后，这个效果在哪里发动？",
  "青眼暴君龙战斗破坏并除外后，这个效果在哪里发动？",
  "青眼暴君龙在除外状态发动这个效果。",
  "青眼暴君龙被除外的场合，这个效果在哪里发动？",
  "青眼暴君龙被战斗破坏并被表侧除外后，这个效果在哪里发动？",
]) {
  test(`completed banished phrase: ${phrase}`, () => {
    const { gameState, timeline } = build(phrase, "青眼暴君龙");
    const entity = gameState.entities[0];
    assert.equal(entity.wasBanished, true);
    assert.equal(entity.currentZone, "banished");
    assert.ok(timeline.events.some((item) => item.type === "temporarily_banished" && item.status === "completed"));
    assert.equal(deriveStateAtTiming(gameState, timeline, "青眼暴君龙").zoneStatus, "banished");
  });
}

function build(text, card, aliases = []) {
  const query = formalQuery(text, card, [card]);
  query.cards[0].aliases = aliases;
  const gameState = buildGameStateFromFormalQuery(query);
  const timeline = buildEventTimelineFromFormalQuery(query, gameState);
  return { query, gameState, timeline };
}

function formalQuery(text, questionCard, cards) {
  return {
    originalText: text,
    cards: cards.map((name) => ({ name, role: name === questionCard ? "question_card" : "related_card", zone: "unknown" })),
    scenario: { rawContext: text, phase: "unknown", chainState: "unknown", events: [] },
    subQuestions: [{
      id: "q1",
      type: "unknown",
      card: questionCard,
      askedResult: "unknown",
      sourceText: text,
    }],
  };
}
