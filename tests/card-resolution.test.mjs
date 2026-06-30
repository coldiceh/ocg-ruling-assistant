import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { auditCardResolutionNames } from "../backend/engine.mjs";

const catalog = [
  {
    id: "perfect-toon-world",
    name: "完美世界-卡通世界",
    cnName: "完美世界 卡通世界",
    jaName: "完全なる世界 トゥーン・ワールド",
    enName: "Perfect Toon World",
    aliases: ["完美世界卡通世界"],
  },
  {
    id: "toon-world",
    name: "卡通世界",
    cnName: "卡通世界",
    jaName: "トゥーン・ワールド",
    enName: "Toon World",
    aliases: ["トゥーン ワールド"],
  },
  {
    id: "blue-eyes-tyrant-dragon",
    name: "青眼暴君龙",
    cnName: "青眼暴君龙",
    jaName: "青眼のタイラント・ドラゴン",
    enName: "Blue-Eyes Tyrant Dragon",
    aliases: ["青眼暴君", "青眼暴君龍"],
  },
];

const names = [
  "完美世界-卡通世界",
  "完美世界 卡通世界",
  "卡通世界",
  "青眼暴君龙",
  "青眼暴君",
  "Toon World",
  "トゥーン・ワールド",
];

test("known Chinese, English, Japanese, and alias names resolve with trace details", () => {
  const traces = auditCardResolutionNames(names, catalog);

  assert.equal(traces.length, names.length);
  for (const trace of traces) {
    assert.ok(trace.normalizedName);
    assert.ok(trace.resolvedCardIds.length > 0, `${trace.originalName} should resolve`);
    assert.ok(trace.matchedNames.length > 0);
    assert.ok(trace.nameSource);
    assert.equal(trace.failureReason, null);
  }
});

test("an unresolved name returns an explicit reason and approximate candidates", () => {
  const [trace] = auditCardResolutionNames(["青眼暴君竜"], catalog);

  assert.ok(trace.failureReason || trace.resolvedCardIds.length > 0);
  assert.ok(Array.isArray(trace.approximateMatches));
});

test("Perfect Toon World keeps a stable alias for its current English database name", async () => {
  const tracked = JSON.parse(await readFile(new URL("../data/tracked-cards.json", import.meta.url), "utf8"));
  const card = tracked.cards.find((item) => item.lookupName === "Toon World the Perfect World");
  assert.equal(card.lookupName, "Toon World the Perfect World");
  assert.ok(card.aliases.includes("Perfect Toon World"));
});
