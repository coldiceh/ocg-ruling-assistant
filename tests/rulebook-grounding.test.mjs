import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { retrieveRulebookPassages } from "../backend/rulebookPassageRetriever.mjs";

test("actual_rulebook_late_paragraph_is_retrieved_as_a_passage", async () => {
  const payload = JSON.parse(await readFile(new URL("../data/ocg-rule-corpus.json", import.meta.url), "utf8"));
  const passages = retrieveRulebookPassages({
    records: payload.records || [],
    userQuery: "正在发动的通常陷阱能否被返回手卡？",
    ruleSearchQueries: [
      { query: "发动中的通常魔法 通常陷阱 回到手卡 场上的魔法陷阱", confidence: "high" },
      { query: "魔法 陷阱 连锁途中 回到手卡 卡组", confidence: "high" },
    ],
    maxPassages: 20,
  });

  const relevant = passages.find((item) => /这种魔法·陷阱卡在连锁途中不能从场上回到手卡·卡组/u.test(item.text));
  assert.ok(relevant, "expected the rulebook passage about activated Spell/Trap Cards returning to hand");
  assert.match(relevant.id, /^ocg-rule:c02\/卡片·效果的发动#p/u);
  assert.equal(relevant.type, "rulebook");
  assert.ok(relevant.sourceUrl);
});
