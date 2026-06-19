import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDataHealth } from "../backend/dataHealth.mjs";
import { answerQuestion, auditCardResolutionNames } from "../backend/engine.mjs";

const card = { id: "card-a", name: "测试卡A", aliases: ["测试卡A", "卡A"] };
const qa = { id: "qa-a", recordType: "qa", title: "测试问答", conclusion: "可以。" };
const faq = { id: "faq-a", recordType: "card-faq", title: "测试 FAQ", conclusion: "可以。" };
const alias = { alias: "测试卡A", normalizedAlias: "测试卡a", cardId: "card-a", cardName: "测试卡A" };
const qaIndexEntry = { id: "qa-a", recordType: "qa" };

test("cards=0 and qa=0 reports data_source_missing", () => {
  const health = buildDataHealth();
  assert.equal(health.status, "data_source_missing");
  assert.equal(health.usable, false);
});

test("an alias match without a card id reports alias_without_card_id", () => {
  const [resolution] = auditCardResolutionNames(["测试卡A"], [{ name: "测试卡A", aliases: ["测试卡A"] }]);
  assert.equal(resolution.status, "alias_without_card_id");

  const health = buildDataHealth({
    cards: [card],
    rulings: [qa, faq],
    aliases: [{ alias: "坏别名", cardId: "" }],
    qaIndex: [qaIndexEntry],
  });
  assert.equal(health.status, "alias_without_card_id");
});

test("qaCount>0 with an empty QA index reports qa_index_empty", () => {
  const health = buildDataHealth({ cards: [card], rulings: [qa, faq], aliases: [alias], qaIndex: [] });
  assert.equal(health.status, "qa_index_empty");
  assert.equal(health.usable, false);
});

test("complete data reports ok", () => {
  const health = buildDataHealth({ cards: [card], rulings: [qa, faq], aliases: [alias], qaIndex: [qaIndexEntry] });
  assert.equal(health.status, "ok");
  assert.equal(health.readinessLevel, "dev_ok");
  assert.equal(health.usable, true);
});

test("missing data short-circuits before parser and final answer", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "data-health-tests-"));
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("network must not be called");
  };

  try {
    await writeJson(join(dataDir, "cards.json"), { records: [] });
    await writeJson(join(dataDir, "rulings.json"), { records: [] });
    await writeJson(join(dataDir, "card-alias-index.json"), { records: [] });
    await writeJson(join(dataDir, "qa-index.json"), { records: [] });
    const answer = await answerQuestion({ question: "测试卡A能发动吗？" }, { dataDir });

    assert.deepEqual(answer.status, "data_source_missing");
    assert.equal(answer.message, "数据源未初始化，请先运行 node scripts/sync-data.mjs");
    assert.equal("subAnswers" in answer, false);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
