import assert from "node:assert/strict";
import test from "node:test";

import { pickBestApiCard } from "../api/card.js";

test("card detail lookup requires the requested stable id when one is supplied", () => {
  const cards = [
    { id: "00000002", name: "匿名卡乙", confidence: 0.99 },
    { id: "00000001", name: "匿名卡甲", confidence: 0.8 },
  ];

  assert.equal(pickBestApiCard(cards, { id: "00000001", query: "匿名卡乙" })?.id, "00000001");
  assert.equal(pickBestApiCard(cards.slice(0, 1), { id: "00000001", query: "匿名卡乙" }), null);
});

test("card detail lookup does not promote a fuzzy or ambiguous name candidate", () => {
  const fuzzy = [{ id: "00000001", name: "匿名卡甲改", confidence: 0.99 }];
  assert.equal(pickBestApiCard(fuzzy, { id: "", query: "匿名卡甲" }), null);

  const ambiguous = [
    { id: "00000001", name: "匿名卡甲", confidence: 0.99 },
    { id: "00000002", cnName: "匿名卡甲", name: "匿名卡甲别名", confidence: 0.98 },
  ];
  assert.equal(pickBestApiCard(ambiguous, { id: "", query: "匿名卡甲" }), null);

  const exact = [{ id: "00000001", name: "匿名卡甲", confidence: 0.5 }];
  assert.equal(pickBestApiCard(exact, { id: "", query: "匿名卡甲" })?.id, "00000001");
});
