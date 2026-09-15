import assert from "node:assert/strict";
import test from "node:test";
import { buildRuleSourceStructure, mapDenseLocatorsToReadingUnits,
  sourceSha256 } from "../backend/evidenceSourceStructure.mjs";

test("keeps composite atoms whole, joins headings to first body, and preserves structural contexts", () => {
  const text = "Root\n\nintro\n\nChild\n\nlead\n\nA\nB\n\nafter";
  const rootEnd = text.length;
  const childStart = text.indexOf("Child");
  const listStart = text.indexOf("A\nB");
  const record = { id: "rule:test", recordType: "rule-doc", title: "Root", text,
    structure: { schemaVersion: 2, canonicalSha256: sourceSha256(text),
      sections: [
        { sectionKey: "root", parentKey: null, title: "Root", start: 0, end: rootEnd },
        { sectionKey: "child", parentKey: "root", title: "Child", start: childStart, end: rootEnd },
      ],
      blocks: [
        { blockKey: "h1", sectionKey: "root", kind: "heading", start: 0, end: 4 },
        { blockKey: "p1", sectionKey: "root", kind: "paragraph", start: 6, end: 11 },
        { blockKey: "h2", sectionKey: "child", kind: "heading", start: childStart, end: childStart + 5 },
        { blockKey: "p2", sectionKey: "child", kind: "paragraph", start: text.indexOf("lead"), end: text.indexOf("lead") + 4 },
        { blockKey: "list", sectionKey: "child", kind: "list", start: listStart, end: listStart + 3 },
        { blockKey: "inside", sectionKey: "child", kind: "paragraph", start: listStart, end: listStart + 1 },
        { blockKey: "p3", sectionKey: "child", kind: "paragraph", start: text.indexOf("after"), end: rootEnd },
      ], explicitLinks: [] } };
  const built = buildRuleSourceStructure(record, { targetChars: 7 });
  assert.equal(built.atoms.filter(atom => atom.blockKey === "inside").length, 0);
  assert.equal(built.atoms.filter(atom => atom.blockKey === "list").length, 1);
  const childUnits = built.readingUnits.filter(unit => unit.sectionKey === "child");
  assert.ok(childUnits[0].text.startsWith("Child"));
  assert.ok(childUnits.slice(1).every(unit => unit.contextRefs.includes(childUnits[0].unitKey)));
  const rootUnit = built.readingUnits.find(unit => unit.sectionKey === "root");
  assert.ok(childUnits.every(unit => unit.contextRefs.includes(rootUnit.unitKey)));
});

test("dense source mapping uses strict UTF-16 interval intersection and keeps every one-to-many target", () => {
  const hash = "a".repeat(64);
  const units = [
    { unitKey: "u1", sourceId: "s", sourceCanonicalSha256: hash, sectionKey: "x", start: 0, end: 5 },
    { unitKey: "u2", sourceId: "s", sourceCanonicalSha256: hash, sectionKey: "x", start: 5, end: 10 },
    { unitKey: "other-source", sourceId: "t", sourceCanonicalSha256: hash, start: 0, end: 10 },
    { unitKey: "other-revision", sourceId: "s", sourceCanonicalSha256: "b".repeat(64), start: 0, end: 10 },
  ];
  const locators = [
    { denseUnitId: "both", sourceId: "s", sourceCanonicalSha256: hash, start: 4, end: 6 },
    { denseUnitId: "touch", sourceId: "s", sourceCanonicalSha256: hash, start: 10, end: 12 },
    { denseUnitId: "zero", sourceId: "s", sourceCanonicalSha256: hash, sectionKey: "x", start: 5, end: 5 },
    { denseUnitId: "moved", sourceId: "s", sourceCanonicalSha256: hash, start: 6, end: 7 },
  ];
  const result = mapDenseLocatorsToReadingUnits(locators, units);
  assert.deepEqual(result.map(item => [...item.readingUnitKeys]), [["u1", "u2"], [], [], ["u2"]]);
});
