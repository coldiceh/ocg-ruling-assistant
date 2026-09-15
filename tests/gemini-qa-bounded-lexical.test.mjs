import assert from "node:assert/strict";
import test from "node:test";

import { mapBoundedQaLexicalLanes } from "../backend/geminiBoundedEvidenceProvider.mjs";
import { mapRankedUnits } from "../backend/evidenceReadingScheduler.mjs";
import { createQaSnapshot } from "../backend/geminiQaTools.mjs";

function record(id, { recordType = "qa", cardIds = [], text = "shared alpha" } = {}) {
  return { recordType, id, cardIds, text, official: true };
}

function fixtureRecords() {
  const records = [];
  for (let index = 0; index < 44; index += 1) {
    records.push(record(`qa-${String(index).padStart(2, "0")}`, {
      cardIds: index < 5 ? ["card-a"] : [],
      text: index % 3 ? "shared alpha" : "shared alpha alpha",
    }));
  }
  for (let index = 0; index < 38; index += 1) {
    records.push(record(`faq-${String(index).padStart(2, "0")}`, {
      recordType: "card-faq",
      cardIds: index < 4 ? ["card-a"] : [],
      text: index % 2 ? "shared alpha" : "shared alpha alpha",
    }));
  }
  return records;
}

function unitMapping(items) {
  const sourceKind = new Map();
  const byHandle = new Map();
  for (const item of items) {
    const kind = item.record.recordType === "card-faq" ? "faq" : "qa";
    const count = kind === "faq" && item.record.id === "faq-00" ? 3 : 1;
    const keys = Array.from({ length: count }, (_, ordinal) => `${kind}:${item.record.id}:${ordinal}`);
    keys.forEach(key => sourceKind.set(key, kind));
    byHandle.set(item.handle, keys);
  }
  return { byHandle, sourceKind };
}

test("bounded QA lexical stream exactly preserves the legacy global merge order", () => {
  const records = fixtureRecords();
  let canonical;
  for (const input of [records, [...records].reverse()]) {
    const snapshot = createQaSnapshot({ records: input, qaRevision: "bounded-lexical-r1" });
    const tools = snapshot.createQaTools({ cardIds: ["card-a"] });
    const legacy = tools.searchAll({ queries: ["shared alpha"] });
    const stream = tools.searchBounded({ queries: ["shared alpha"] });

    assert.equal(typeof stream?.[Symbol.iterator], "function");
    const iterator = stream[Symbol.iterator]();
    const first = iterator.next();
    assert.equal(first.done, false);
    const bounded = [first.value, ...iterator];
    assert.deepEqual(bounded.map(item => item.handle), legacy.map(item => item.handle));
    assert.deepEqual(bounded.map(item => item.record.recordType),
      legacy.map(item => item.record.recordType));
    const handles = bounded.map(item => item.handle);
    if (canonical) assert.deepEqual(handles, canonical);
    else canonical = handles;
  }
});

test("bounded mapped lanes equal legacy top 32 with duplicate rounds and multi-unit FAQ parents", () => {
  const records = fixtureRecords();
  const snapshot = createQaSnapshot({ records, qaRevision: "bounded-lexical-r2" });
  const tools = snapshot.createQaTools({ cardIds: ["card-a"] });
  const queries = ["shared alpha"];
  const legacyRows = tools.searchAll({ queries });
  const { byHandle, sourceKind } = unitMapping(legacyRows);
  const expected = Object.fromEntries(["qa", "faq"].map(kind => [kind,
    mapRankedUnits(legacyRows,
      item => byHandle.get(item.handle).filter(key => sourceKind.get(key) === kind))]));

  const actual = mapBoundedQaLexicalLanes({
    qaTools: tools,
    queries,
    mapResult: item => byHandle.get(item.handle),
    sourceKindForUnit: key => sourceKind.get(key),
  });

  assert.deepEqual(actual.qa, expected.qa);
  assert.deepEqual(actual.faq, expected.faq);
  assert.equal(actual.qa.length, 32);
  assert.equal(actual.faq.length, 32);
  assert.equal(expected.faq.some(hit => hit.mappingOrdinal > 0), false);
  assert.deepEqual(tools.searchAll({ queries }).map(item => item.handle),
    legacyRows.map(item => item.handle));
});

test("bounded mapped lanes exhaust before using later mapping ordinals when a lane has fewer parents", () => {
  const records = [
    ...Array.from({ length: 34 }, (_, index) => record(`qa-${index}`)),
    ...Array.from({ length: 16 }, (_, index) => record(`faq-${index}`, { recordType: "card-faq" })),
  ];
  const snapshot = createQaSnapshot({ records, qaRevision: "bounded-lexical-r3" });
  const tools = snapshot.createQaTools({ cardIds: ["card-a"] });
  const legacyRows = tools.searchAll({ queries: ["shared alpha"] });
  const sourceKind = new Map(), byHandle = new Map();
  for (const item of legacyRows) {
    const kind = item.record.recordType === "card-faq" ? "faq" : "qa";
    const keys = Array.from({ length: kind === "faq" ? 3 : 1 }, (_, ordinal) => `${kind}:${item.record.id}:${ordinal}`);
    keys.forEach(key => sourceKind.set(key, kind));
    byHandle.set(item.handle, keys);
  }
  const expectedFaq = mapRankedUnits(legacyRows,
    item => byHandle.get(item.handle).filter(key => sourceKind.get(key) === "faq"));
  const actual = mapBoundedQaLexicalLanes({ qaTools: tools, queries: ["shared alpha"],
    mapResult: item => byHandle.get(item.handle), sourceKindForUnit: key => sourceKind.get(key) });

  assert.deepEqual(actual.faq, expectedFaq);
  assert.equal(actual.faq.length, 32);
  assert.ok(actual.faq.some(hit => hit.mappingOrdinal > 0));
});
