import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCardImageCandidates,
  createLocalCardDataProvider,
} from "../backend/cardDataProvider.mjs";

test("local card data keeps opaque ids distinct while image URLs require numeric ids", () => {
  const cards = [
    { id: "trap-1", name: "陷阱源", effectText: "陷阱源正文。" },
    { id: "responder-1", name: "响应者", effectText: "响应者正文。" },
  ];
  const records = [
    { id: "faq-trap", recordType: "card-faq", cardIds: ["trap-1"], text: "陷阱源 FAQ。" },
    { id: "faq-responder", recordType: "card-faq", cardIds: ["responder-1"], text: "响应者 FAQ。" },
  ];
  const provider = createLocalCardDataProvider({ cards, records });

  assert.equal(provider.getCardProfile("trap-1")?.name, "陷阱源");
  assert.equal(provider.getCardProfile("responder-1")?.name, "响应者");
  assert.equal(provider.getCardText("trap-1"), "陷阱源正文。");
  assert.deepEqual(provider.getCardFaq("trap-1").map((item) => item.id), ["faq-trap"]);
  assert.deepEqual(provider.getCardFaq("responder-1").map((item) => item.id), ["faq-responder"]);
  assert.deepEqual(buildCardImageCandidates("trap-1"), []);
  assert.ok(buildCardImageCandidates("00012345").every((url) => url.includes("12345")));
});
