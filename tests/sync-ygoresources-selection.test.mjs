import assert from "node:assert/strict";
import test from "node:test";

import {
  parseManifestPayload,
  rankCardQaIds,
  selectQaIdsForSync,
} from "../scripts/sync-ygoresources.mjs";

test("manifest parser reads real nested paths and response-header revision", () => {
  const parsed = parseManifestPayload({
    data: {
      qa: { 22803: 1, 13330: 1 },
      card: { 23486: 1 },
    },
  }, { revision: "32081" });

  assert.equal(parsed.revision, "32081");
  assert.deepEqual(parsed.changedQaIds, ["13330", "22803"]);
  assert.ok(parsed.changedPaths.includes("/data/card/23486"));
});

test("changed and recent QA IDs cannot be displaced by the all-card cap", () => {
  const selected = selectQaIdsForSync({
    changedQaIds: [22803],
    recentQaIds: [13330],
    cardQaIds: [1, 2, 3, 4, 5],
    limit: 2,
  });

  assert.deepEqual(selected.ids, ["22803", "13330"]);
  assert.equal(selected.changedSelectedCount, 1);
  assert.equal(selected.recentSelectedCount, 1);
  assert.equal(selected.truncatedCount, 5);
});

test("card QA ranking prioritizes interactions referenced by multiple cards", () => {
  const ranked = rankCardQaIds([
    { payload: { qaIndex: [5, 22803, 7] } },
    { payload: { qaIndex: [8, 22803, 9] } },
    { payload: { qaIndex: [10, 13330] } },
    { payload: { qaIndex: [13330, 11] } },
  ]);

  assert.deepEqual(ranked.slice(0, 2), ["22803", "13330"]);
});
