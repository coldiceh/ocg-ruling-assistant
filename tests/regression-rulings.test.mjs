import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  answerEachSubQuestion,
  answerQuestion,
  retrieveEvidenceByFormalQuery,
} from "../backend/engine.mjs";
import { normalizeFormalRulingQuery, validateFormalRulingQuery } from "../backend/formalQuery.mjs";

const cards = [
  {
    id: "test-a",
    name: "测试卡A",
    cnName: "测试卡A",
    aliases: ["测试卡A", "卡A"],
    effectText: "①：满足某条件的场合才能发动。处理时可以将1张卡除外。",
    sourceUrl: "fixture://test-a",
  },
];

const activationRuling = {
  id: "qa-a-activation",
  recordType: "card-faq",
  title: "测试卡A FAQ：发动条件",
  question: "什么场合可以发动「测试卡A」①效果？",
  cards: ["测试卡A"],
  keywords: ["发动条件", "①"],
  conclusion: "满足指定条件的场合才能发动。",
  sources: [{ label: "fixture", detail: "activation" }],
};

const banishRuling = {
  id: "qa-a-banish",
  recordType: "card-faq",
  title: "测试卡A FAQ：处理时能否除外",
  question: "「测试卡A」①效果处理时可以将对象除外吗？",
  cards: ["测试卡A"],
  keywords: ["处理", "除外", "①"],
  conclusion: "效果处理时将对象除外。",
  sources: [{ label: "fixture", detail: "banish" }],
};

test("activation question rejects a same-card banish-handling Q&A", () => {
  const query = formalize("测试卡A的①效果能否发动？", "activation_condition");
  const snapshot = { records: [activationRuling, banishRuling] };
  const evidence = retrieveEvidenceByFormalQuery(query, cards, snapshot);
  const bucket = evidence.bySubQuestion[0];

  assert.deepEqual(bucket.rulingEvidence.map((item) => item.evidenceId), ["qa-a-activation"]);
  assert.ok(bucket.rejectedEvidence.some((item) => item.evidenceId === "qa-a-banish" && item.rejectedReason === "question_type_mismatch"));
});

test("return-to-deck question cannot be confirmed by activation evidence", () => {
  const query = formalize("测试卡A①效果处理时会不会回卡组？", "return_to_deck");
  const snapshot = { records: [activationRuling] };
  const evidence = retrieveEvidenceByFormalQuery(query, cards, snapshot);
  const answers = answerEachSubQuestion(query, evidence, snapshot, validateFormalRulingQuery(query));

  assert.equal(evidence.bySubQuestion[0].rulingEvidence.length, 0);
  assert.equal(answers[0].status, "unknown");
  assert.ok(evidence.rejectedEvidence.some((item) => item.evidenceId === "qa-a-activation"));
});

test("card text alone never produces confirmed", () => {
  const query = formalize("测试卡A①效果处理时能不能除外？", "location_change");
  const snapshot = { records: [] };
  const evidence = retrieveEvidenceByFormalQuery(query, cards, snapshot);
  const answers = answerEachSubQuestion(query, evidence, snapshot, validateFormalRulingQuery(query));

  assert.equal(evidence.cardTextEvidence.length, 1);
  assert.equal(evidence.rulingEvidence.length, 0);
  assert.ok(["unknown", "inferred"].includes(answers[0].status));
  assert.notEqual(answers[0].status, "confirmed");
});

test("similar same-type Q&A produces inferred, while invalid direct IDs downgrade to unknown", () => {
  const query = formalize("测试卡A①效果处理时会不会回卡组？", "return_to_deck");
  const similar = {
    id: "qa-b-return",
    recordType: "qa",
    title: "测试卡B的回卡组处理",
    question: "测试卡B的效果处理时会回到卡组吗？",
    cards: ["测试卡B"],
    conclusion: "该卡回到卡组。",
  };
  const snapshot = { records: [similar] };
  const evidence = retrieveEvidenceByFormalQuery(query, cards, snapshot);
  const inferred = answerEachSubQuestion(query, evidence, snapshot, validateFormalRulingQuery(query));
  assert.equal(inferred[0].status, "inferred");

  evidence.bySubQuestion[0].rulingEvidence = [{ ...similar, evidenceId: "missing-id", evidenceTypes: ["return_to_deck"] }];
  const downgraded = answerEachSubQuestion(query, evidence, snapshot, validateFormalRulingQuery(query));
  assert.equal(downgraded[0].status, "unknown");
});

test("missing critical formal fields produces parse_failed", () => {
  const query = normalizeFormalRulingQuery({
    originalText: "这张卡能否发动？",
    cards: [],
    scenario: {},
    subQuestions: [{ id: "q1", type: "activation_condition", card: "unknown", requiredSlots: ["card", "type"] }],
  });
  const evidence = retrieveEvidenceByFormalQuery(query, [], { records: [] });
  const answers = answerEachSubQuestion(query, evidence, { records: [] }, validateFormalRulingQuery(query));
  assert.equal(answers[0].status, "parse_failed");
});

test("public answer uses qualitative confidence without percentages", async () => {
  const dataDir = await makeDataDir();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
    text: async () => "",
    headers: { get: () => "application/json" },
  });

  try {
    const answer = await answerQuestion(
      { question: "测试卡A的①效果能否发动？" },
      { dataDir, useModel: false, env: { CARD_RESOLUTION_LANGUAGES: "fixture" } }
    );
    assert.equal(answer.subAnswers[0].status, "confirmed");
    assert.equal("value" in answer.confidence, false);
    assert.doesNotMatch(JSON.stringify(answer.confidence), /\d+%/u);

    const appSource = await readFile(join(process.cwd(), "src", "app.js"), "utf8");
    assert.doesNotMatch(appSource, /confidence\.(?:value|label)[^\n]*%/u);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});

function formalize(originalText, type) {
  return normalizeFormalRulingQuery({
    originalText,
    cards: [{ name: "测试卡A", role: "question_card", effectNo: "①", controller: "unknown", zone: "unknown" }],
    scenario: { turnPlayer: "unknown", phase: "unknown", chainState: "unknown", events: [] },
    subQuestions: [
      {
        id: "q1",
        type,
        card: "测试卡A",
        effectNo: "①",
        askedResult: originalText,
        timing: "unknown",
        requiredSlots: ["card", "type"],
      },
    ],
  });
}

async function makeDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "formal-ruling-tests-"));
  await writeJson(join(dir, "cards.json"), { records: cards });
  await writeJson(join(dir, "rulings.json"), { records: [activationRuling, banishRuling] });
  await writeJson(join(dir, "snapshot-meta.json"), { generatedAt: new Date().toISOString(), freshnessDays: 30, sources: [] });
  await writeJson(join(dir, "ocg-rule-corpus.json"), { records: [] });
  await writeJson(join(dir, "ocg-rule-tests.json"), { records: [] });
  return dir;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
