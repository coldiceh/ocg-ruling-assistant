import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeAdminEvidenceDryRunCases } from "../scripts/lib/admin-evidence-snapshot-dry-run.mjs";
import { validateAssertionFixture } from "../scripts/lib/offline-experiment-scorer.mjs";

const casesUrl = new URL("./fixtures/model-effort-ten-case-cases.json", import.meta.url);
const goldensUrl = new URL("./fixtures/model-effort-ten-case-goldens.json", import.meta.url);

test("the public model-effort corpus contains ten matched, non-leaking cases", async () => {
  const [caseText, goldenText] = await Promise.all([
    readFile(casesUrl, "utf8"),
    readFile(goldensUrl, "utf8"),
  ]);
  const caseFixture = normalizeAdminEvidenceDryRunCases(JSON.parse(caseText));
  const goldenFixture = JSON.parse(goldenText);
  const goldens = validateAssertionFixture(goldenFixture);

  assert.equal(caseFixture.cases.length, 10);
  assert.equal(goldens.size, 10);
  assert.deepEqual(
    [...goldens.keys()].sort(),
    caseFixture.cases.map((item) => item.id).sort(),
  );
  assert.doesNotMatch(caseText, /GOLD_ONLY_CANARY|expectedAnswer|officialSources/u);

  for (const item of goldenFixture.goldens) {
    assert.match(item.leakCanary, /^GOLD_ONLY_CANARY_\d{2}_DO_NOT_SEND$/u);
    assert.ok(String(item.expectedAnswer || "").length >= 20, item.id);
  }
  for (const item of goldenFixture.goldens.slice(4)) {
    assert.ok(Array.isArray(item.officialSources) && item.officialSources.length > 0, item.id);
    for (const source of item.officialSources) {
      assert.match(source, /^https:\/\/www\.db\.yugioh-card\.com\/yugiohdb\//u, item.id);
    }
  }
});
