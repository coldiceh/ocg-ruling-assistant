import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

test("one FAQ source body is hashed once while producing multiple excerpts", async () => {
  const source = "【第一段】\n第一段正文。\n\n【第二段】\n第二段正文。";
  const originalCreateHash = crypto.createHash;
  let sourceHashUpdates = 0;
  crypto.createHash = function trackedCreateHash(...args) {
    const hash = originalCreateHash.apply(this, args);
    const originalUpdate = hash.update;
    hash.update = function trackedUpdate(value, ...updateArgs) {
      if (String(value) === source) sourceHashUpdates += 1;
      return originalUpdate.call(this, value, ...updateArgs);
    };
    return hash;
  };

  try {
    const { createFocusedQaView } = await import("../backend/geminiFocusedQaView.mjs");
    const view = createFocusedQaView({
      qaRevision: "fixture-revision",
      items: [{
        handle: "fixture-parent-handle",
        record: {
          id: "fixture-faq",
          recordType: "card-faq",
          title: "fixture",
          cards: [],
          cardIds: [],
          status: "published",
          conclusion: source,
        },
      }],
    });
    assert.ok(view.items.length > 1, "fixture must exercise multiple excerpts");
    assert.equal(sourceHashUpdates, 1);
  } finally {
    crypto.createHash = originalCreateHash;
  }
});

