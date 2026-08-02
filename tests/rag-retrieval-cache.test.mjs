import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { searchOfficialQaEvidence } from "../backend/officialQaMatcher.mjs";
import {
  evidenceBucketsToList,
  loadRagData,
  normalizeInjectedData,
  retrieveRagEvidence,
} from "../backend/ragEvidenceRetriever.mjs";

test("concurrent cold loads share one normalized data object", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-single-flight-"));
  try {
    await Promise.all([
      writeJson(join(dataDir, "cards.json"), { records: [{ id: "1", name: "并发测试卡" }] }),
      writeJson(join(dataDir, "rulings.json"), { records: [] }),
      writeJson(join(dataDir, "qa-index.json"), { records: [] }),
      writeJson(join(dataDir, "evidence-index.json"), { records: [] }),
      writeJson(join(dataDir, "ocg-rule-corpus.json"), { records: [] }),
      writeJson(join(dataDir, "official-responses.json"), { records: [] }),
    ]);

    const [first, second, third] = await Promise.all([
      loadRagData(dataDir),
      loadRagData(dataDir),
      loadRagData(dataDir),
    ]);
    assert.strictEqual(second, first);
    assert.strictEqual(third, first);
    assert.strictEqual(second.cards, first.cards);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("normalized RAG data is canonical for the same source arrays and its normalized output", () => {
  const cards = [{ id: 1, name: "测试卡", effectText: "①：可以发动。" }];
  const records = [{ id: "rule-1", title: "测试规则", text: "测试规则正文。" }];
  const qaRecords = [{ id: "qa-1", recordType: "qa", question: "可以发动吗？", answer: "可以。" }];

  const first = normalizeInjectedData({ cards, records, qaRecords });
  const second = normalizeInjectedData({ cards, records, qaRecords });
  const alreadyNormalized = normalizeInjectedData(first);

  assert.strictEqual(second, first);
  assert.strictEqual(alreadyNormalized, first);
  assert.strictEqual(alreadyNormalized.records, first.records);
});

test("evidence bucket flattening is cached by evidence object identity", () => {
  const evidence = {
    cardTexts: [{ id: "card-text-1", text: "卡文" }],
    officialQaRelated: [{ id: "qa-1", text: "问答" }],
  };
  assert.strictEqual(evidenceBucketsToList(evidence), evidenceBucketsToList(evidence));
});

test("official Q&A record features are reused across searches", () => {
  let textReads = 0;
  const record = {
    id: "qa-cache-1",
    recordType: "qa",
    question: "这张测试卡可以发动吗？",
    answer: "可以发动。",
    cardIds: ["1"],
    cards: ["测试卡"],
    get text() {
      textReads += 1;
      return "这张测试卡可以发动吗？\n可以发动。";
    },
  };

  const input = { question: "这张测试卡可以发动吗？", records: [record], resolvedCards: [{ id: "1", name: "测试卡" }] };
  assert.equal(searchOfficialQaEvidence(input).exact.length, 1);
  const readsAfterFirstSearch = textReads;
  assert.equal(searchOfficialQaEvidence(input).exact.length, 1);
  assert.equal(textReads, readsAfterFirstSearch);
});

test("local card id and text do not require a Baige request only to fill sourceUrl", async () => {
  let fetchCalls = 0;
  const card = { id: "12345678", cardId: "12345678", name: "本地完整测试卡", effectText: "①：这张卡可以发动。" };
  const evidence = await retrieveRagEvidence({
    userQuery: "本地完整测试卡的①效果可以发动吗？",
    cardResolution: { resolvedCards: [card], unresolvedMentions: [], userProvidedCardTexts: [] },
    cards: [card],
    records: [],
    qaRecords: [],
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("network should not be used");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(evidence.debug.baigeSearchCount, 0);
  assert.match(evidence.cardTexts[0].text, /可以发动/u);
});

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}
