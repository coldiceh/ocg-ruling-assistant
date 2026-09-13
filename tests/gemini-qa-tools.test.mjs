import assert from "node:assert/strict";
import test from "node:test";

import { createQaSnapshot, createQaTools } from "../backend/geminiQaTools.mjs";

function record(id, { cardIds = [], text = `body ${id}`, extra = {} } = {}) {
  return {
    recordType: "qa",
    id,
    cardIds,
    text,
    sourceAuthority: "official_database",
    official: true,
    ...extra,
  };
}

function collect(tools, queries) {
  const items = [];
  let cursor;
  do {
    const page = tools.search({ queries, cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

test("request card links interleave with the complete indexed queue and preserve canonical records", () => {
  const records = [
    record("qa-z", { cardIds: ["17"], text: "alpha z" }),
    record("qa-a", { cardIds: ["17", "29"], text: "alpha a", extra: { raw: { whole: [1, 2, 3] } } }),
    record("qa-b", { cardIds: ["29"], text: "alpha b" }),
    record("qa-c", { text: "alpha c" }),
    record("qa-d", { text: "alpha d" }),
  ];
  const snapshot = createQaSnapshot({ records, qaRevision: "qa-r1" });
  const index = snapshot.buildLexicalIndex();
  const tools = snapshot.createQaTools({ cardIds: ["29", "17"], pageSize: 2 });
  const items = collect(tools, ["alpha"]);

  assert.ok(Buffer.isBuffer(index));
  assert.equal(items.length, records.length);
  assert.equal(new Set(items.map((item) => item.handle)).size, records.length);
  assert.equal(items[0].record.id, "qa-a");
  assert.deepEqual(tools.readSelected([items[0].handle])[0].record.raw.whole, [1, 2, 3]);
  assert.equal(items[0].sourceAuthority, "official_database");
  assert.equal(items[0].official, true);
});

test("installed index preserves ordering and cursors bind request card ids and revision", () => {
  const records = [
    record("qa-a", { cardIds: ["17"], text: "alpha alpha a" }),
    record("qa-b", { text: "alpha b" }),
    record("qa-c", { text: "beta c" }),
  ];
  const built = createQaSnapshot({ records, qaRevision: "qa-r1" });
  const bytes = built.buildLexicalIndex();
  const installed = createQaSnapshot({ records, qaRevision: "qa-r1", lexicalIndexBytes: bytes });
  assert.deepEqual(
    collect(installed.createQaTools(), ["alpha", "beta"]).map((item) => item.handle),
    collect(built.createQaTools(), ["alpha", "beta"]).map((item) => item.handle),
  );

  const first = installed.createQaTools({ cardIds: ["17"], pageSize: 1 }).search({ queries: ["alpha"] });
  assert.throws(
    () => installed.createQaTools({ cardIds: ["29"], pageSize: 1 })
      .search({ queries: ["alpha"], cursor: first.nextCursor }),
    /cursor_snapshot_mismatch/u,
  );
  assert.throws(
    () => createQaTools({ records, qaRevision: "qa-r2", lexicalIndexBytes: bytes }),
    /lexical_index_binding_invalid/u,
  );
});
