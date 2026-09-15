import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bindOcgRuleStructure,
  parseOcgRuleHtml,
} from "../scripts/lib/ocg-rule-structure.mjs";
import {
  assertCompleteOcgRuleFetch,
  loadFixedRuleSources,
  mergeOwnedOcgRuleRecords,
} from "../scripts/sync-ocg-rule.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("HTML extraction keeps canonical UTF-16 offsets, compound atoms, table layout and explicit links", () => {
  const html = `<!doctype html><article>
    <h2 id="first">😀 見出し</h2>
    <p>第一段 <a href="#first">戻る</a> <a href="#item">項目</a></p>
    <ul><li>甲</li><li><span id="item">乙</span></li></ul>
    <table><tr><th rowspan="2">種別</th><td>A</td></tr><tr><td colspan="2">B</td></tr></table>
    <dl><dt>Q</dt><dd>A</dd></dl>
  </article>`;
  const parsed = parseOcgRuleHtml(html);
  const structure = bindOcgRuleStructure(parsed, parsed.text, {
    sourceId: "ocg-rule:test",
    sourceUrl: "https://example.test/test.html",
  });

  assert.equal(structure.schemaVersion, 2);
  assert.equal(structure.canonicalSha256, createHash("sha256").update(parsed.text).digest("hex"));
  assert.ok(parsed.text.startsWith("😀 見出し"));
  assert.equal(structure.sections[1].sectionKey, "ocg-rule:test#first");
  assert.equal(parsed.text.slice(structure.sections[1].start, structure.sections[1].start + "😀 見出し".length), "😀 見出し");

  const selectable = structure.blocks.filter((block) => block.kind !== "heading");
  assert.deepEqual(selectable.map((block) => block.kind), ["paragraph", "list", "table", "qa"]);
  assert.equal(selectable[0].start, parsed.text.indexOf("第一段"));
  assert.equal(selectable[1].start, parsed.text.indexOf("甲"));
  assert.equal(selectable[2].start, parsed.text.indexOf("種別"));
  assert.equal(selectable[3].start, parsed.text.indexOf("Q"));
  for (const block of structure.blocks) {
    assert.ok(Number.isInteger(block.start) && Number.isInteger(block.end));
    assert.ok(block.start >= 0 && block.end <= parsed.text.length && block.start < block.end);
    assert.ok(parsed.text.slice(block.start, block.end).trim());
  }

  const table = structure.blocks.find((block) => block.kind === "table");
  assert.equal(table.tableLayout.rowCount, 2);
  assert.equal(table.tableLayout.columnCount, 3);
  assert.deepEqual(table.tableLayout.cells.map(({ row, column, rowSpan, columnSpan }) => ({ row, column, rowSpan, columnSpan })), [
    { row: 0, column: 0, rowSpan: 2, columnSpan: 1 },
    { row: 0, column: 1, rowSpan: 1, columnSpan: 1 },
    { row: 1, column: 1, rowSpan: 1, columnSpan: 2 },
  ]);
  for (const cell of table.tableLayout.cells) assert.ok(parsed.text.slice(cell.start, cell.end).trim());

  assert.equal(structure.explicitLinks.length, 2);
  assert.equal(structure.explicitLinks[0].sourceHref, "#first");
  assert.equal(structure.explicitLinks[0].targetSourceId, "ocg-rule:test");
  assert.equal(structure.explicitLinks[0].targetSectionKey, "ocg-rule:test#first");
  assert.match(structure.explicitLinks[0].fromBlockKey, /::paragraph-1$/u);
  assert.match(structure.explicitLinks[1].targetBlockKey, /::list-1$/u);
});

test("an explicit canonical deletion rebases later UTF-16 structure without guessing equivalence", () => {
  const parsed = parseOcgRuleHtml("<article><h2>前😀</h2><p>保留</p><p>削除</p><h2>後</h2><p>本文</p></article>");
  const removed = "削除\n";
  const start = parsed.text.indexOf(removed);
  const canonical = `${parsed.text.slice(0, start)}${parsed.text.slice(start + removed.length)}`;
  const structure = bindOcgRuleStructure(parsed, canonical, {
    sourceId: "ocg-rule:edit",
    removedRange: { start, end: start + removed.length },
  });
  const later = structure.sections.find((section) => section.title === "後");
  assert.equal(canonical.slice(later.start, later.start + 1), "後");
  assert.equal(structure.canonicalSha256, createHash("sha256").update(canonical).digest("hex"));
});

test("fixed source manifest rebuilds the two approved records byte-for-byte and remains authoritative", async () => {
  const directory = join(rootDir, "data", "fixed-rule-sources");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const records = await loadFixedRuleSources(directory);
  const currentCorpus = JSON.parse(await readFile(join(rootDir, "data", "ocg-rule-corpus.json"), "utf8"));
  const approvedRecords = currentCorpus.records.filter((record) => manifest.sources.some((source) => source.sourceId === record.id));
  assert.deepEqual(records.map((record) => record.id), manifest.sources.map((source) => source.sourceId));
  assert.deepEqual(records, approvedRecords);
  assert.deepEqual(records.map((record) => record.sourceAuthority), ["official_reference", "official_reference"]);
  assert.deepEqual(records.map((record) => record.official), [true, true]);
  for (const source of manifest.sources) {
    const sourceText = await readFile(join(directory, source.file), "utf8");
    assert.equal(createHash("sha256").update(sourceText.replace(/\r\n/g, "\n")).digest("hex"), source.sha256);
  }

  const refreshed = [{ id: "ocg-rule:fresh", text: "fresh" }];
  const stale = [{ id: "konami:stale", text: "must not survive without a manifest entry" }];
  assert.deepEqual(mergeOwnedOcgRuleRecords(refreshed, records), [...refreshed, ...records]);
  assert.ok(!mergeOwnedOcgRuleRecords(refreshed, records).some((record) => record.id === stale[0].id));
});

test("incomplete enumeration or any page failure is rejected before publication", () => {
  const docs = [{ docname: "a" }, { docname: "b" }];
  assert.throws(() => assertCompleteOcgRuleFetch({ enumeratedDocs: [], maxPages: 10 }), /enumeration incomplete/u);
  assert.throws(() => assertCompleteOcgRuleFetch({ enumeratedDocs: docs, maxPages: 1 }), /exceed/u);
  assert.throws(() => assertCompleteOcgRuleFetch({
    enumeratedDocs: docs,
    maxPages: 10,
    pageResults: [{ record: { id: "ocg-rule:a" } }, { error: "503" }],
  }), /page fetch incomplete/u);
  assert.doesNotThrow(() => assertCompleteOcgRuleFetch({
    enumeratedDocs: docs,
    maxPages: 10,
    pageResults: [{ record: { id: "ocg-rule:a" } }, { record: { id: "ocg-rule:b" } }],
  }));
});
