import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCompleteOcgRuleFetch,
  buildDocTargets,
  hashOcgRuleRecords,
  loadRulePage,
  validateOcgRuleSnapshot,
} from "../scripts/sync-ocg-rule.mjs";

function records(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `ocg-rule:test-${index}`,
    recordType: "rule-doc",
    title: `Rule ${index}`,
    docname: `test-${index}`,
    sourceUrl: `https://example.test/${index}`,
    keywords: ["规则"],
    text: `Rule text ${index}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
}

test("OCG Rule snapshot guard rejects abnormal shrink before write", () => {
  assert.throws(() => validateOcgRuleSnapshot({
    targets: records(39),
    records: records(10),
    failures: Array.from({ length: 29 }, () => ({ error: "fetch_failed" })),
    previousRecords: records(39),
  }), /snapshot_shrank_abnormally|success_ratio_below_minimum/u);
});

test("OCG Rule snapshot guard accepts a healthy partial refresh", () => {
  const result = validateOcgRuleSnapshot({
    targets: records(39),
    records: records(38),
    failures: [{ error: "one_page_failed" }],
    previousRecords: records(39),
  });
  assert.equal(result.status, "complete");
  assert.equal(result.recordCount, 38);
  assert.ok(result.successRatio > 0.9);
});

test("OCG Rule snapshot guard rejects duplicate ids", () => {
  const current = records(12);
  current[11] = { ...current[11], id: current[0].id };
  assert.throws(() => validateOcgRuleSnapshot({ targets: records(12), records: current }), /duplicate_or_missing_record_ids/u);
});

test("OCG Rule content hash ignores order and timestamps but changes with text", () => {
  const source = records(12);
  const reordered = [...source].reverse().map((item) => ({ ...item, updatedAt: "2027-01-01T00:00:00.000Z" }));
  assert.equal(hashOcgRuleRecords(source), hashOcgRuleRecords(reordered));
  assert.notEqual(hashOcgRuleRecords(source), hashOcgRuleRecords(source.map((item, index) => index ? item : { ...item, text: "changed" })));
});

test("OCG Rule content hash uses locale-independent code-unit ordering", () => {
  const source = [
    { id: "ocg-rule:中文", recordType: "rule-doc", title: "中", docname: "中", sourceUrl: "https://example.test/c", keywords: [], text: "C" },
    { id: "ocg-rule:ASCII", recordType: "rule-doc", title: "A", docname: "a", sourceUrl: "https://example.test/a", keywords: [], text: "A" },
  ];

  assert.equal(hashOcgRuleRecords(source), hashOcgRuleRecords([...source].reverse()));
  assert.equal(hashOcgRuleRecords(source).length, 64);
});

test("OCG Rule enumeration excludes the confirmed links infrastructure page", () => {
  const targets = buildDocTargets({
    docnames: ["index", "links", "c01/short-rule"],
    titles: ["Index", "Links", "Short rule"],
  });

  assert.deepEqual(targets.map((target) => target.docname), ["c01/short-rule"]);
});

test("OCG Rule page loading accepts a non-empty short canonical body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<article><p>短正文</p></article>", { status: 200 });
  try {
    const doc = {
      docname: "c01/short-rule",
      title: "Short rule",
      sourceUrl: "https://example.test/c01/short-rule.html",
    };
    const result = await loadRulePage(doc);
    assert.equal(result.error, undefined);
    assert.equal(result.record?.text, "短正文");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OCG Rule page loading rejects an actually empty canonical body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<article>   </article>", { status: 200 });
  try {
    const doc = {
      docname: "c01/empty-rule",
      title: "Empty rule",
      sourceUrl: "https://example.test/c01/empty-rule.html",
    };
    const result = await loadRulePage(doc);
    assert.equal(result.record, undefined);
    assert.equal(result.error, "page_text_empty");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OCG Rule incomplete fetch error identifies the failed URL and cause", () => {
  const doc = {
    docname: "c01/broken-rule",
    sourceUrl: "https://example.test/c01/broken-rule.html",
  };
  assert.throws(() => assertCompleteOcgRuleFetch({
    enumeratedDocs: [doc],
    maxPages: 10,
    pageResults: [{ doc, error: "503 Service Unavailable" }],
  }), /https:\/\/example\.test\/c01\/broken-rule\.html: 503 Service Unavailable/u);
});
