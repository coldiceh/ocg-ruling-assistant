import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { answerQuestion } from "../backend/engine.mjs";

const cards = [
  {
    id: "01234567",
    passcode: "01234567",
    name: "时空转生",
    cnName: "时空转生",
    jaName: "タキオン・トランスミグレイション",
    enName: "Tachyon Transmigration",
    aliases: ["时空转生", "快子时空转生", "Tachyon Transmigration"],
    effectText:
      "自己场上有「银河眼」怪兽存在的场合，连锁2以后才能发动。这个发动无效，用这个效果把发动无效的卡在场上存在的场合，那些全部回到卡组。",
    sourceUrl: "fixture://tachyon-transmigration",
  },
  {
    id: "07293697",
    passcode: "07293697",
    name: "完美世界 卡通世界",
    cnName: "完美世界 卡通世界",
    jaName: "完全なる世界 トゥーン・ワールド",
    enName: "Perfect Toon World",
    aliases: ["完美世界 卡通世界", "完美世界卡通世界", "Perfect Toon World", "完全なる世界 トゥーン・ワールド"],
    cardType: "场地魔法",
    effectText:
      "③：其他卡发动的效果适用之际，可以把自己场上1只卡通怪兽直到那个效果处理后除外（这个回合，这个卡名的这个效果不能把原本卡名相同的怪兽除外）。",
    sourceUrl: "fixture://perfect-toon-world",
  },
  {
    id: "08491308",
    passcode: "08491308",
    name: "闪刀姬-飒天",
    cnName: "闪刀姬-飒天",
    jaName: "閃刀姫－ハヤテ",
    enName: "Sky Striker Ace - Hayate",
    aliases: ["闪刀姬-飒天", "风刀", "閃刀姫－ハヤテ", "Sky Striker Ace - Hayate"],
    effectText: "②：这张卡进行战斗的伤害计算后才能发动。从卡组把1张「闪刀」卡送去墓地。",
    sourceUrl: "fixture://hayate",
  },
];

const rulings = [
  {
    id: "tachyon-activation-only",
    recordType: "card-faq",
    title: "时空转生 FAQ：发动条件",
    cards: ["时空转生", "Tachyon Transmigration"],
    keywords: ["发动", "连锁"],
    conclusion: "自己场上有「银河眼」怪兽存在的场合，连锁2以后才能发动。",
    sources: [{ label: "fixture", detail: "activation-only" }],
  },
  {
    id: "weak-magic-jammer-analogy",
    recordType: "qa",
    title: "Magic Jammer unrelated analogy",
    question: "A Spell Card that has its activation negated by Magic Jammer is not treated as being destroyed on the field.",
    cards: ["Magic Jammer"],
    keywords: ["破坏", "无效"],
    conclusion:
      "A Spell Card that has its activation negated by Magic Jammer is not treated as being destroyed on the field. Therefore similar monsters are not destroyed by their own effects.",
    sources: [{ label: "fixture", detail: "weak-analogy" }],
  },
];

const tests = [
  {
    name: "处理问题不能用发动条件资料回答",
    question: "时空转生把有场地的卡通怪康了，处理时是回卡组还是场地躲了呢？",
    assert(answer) {
      assert.equal(answer.verdictTitle, "命中的资料没有回答处理问题");
      assert.doesNotMatch(`${answer.verdictTitle}${answer.verdict}`, /可以发动/);
      assert.match(answer.needsConfirmation.join("\n"), /场地卡/);
      assert.match(answer.needsConfirmation.join("\n"), /卡通怪兽/);
    },
  },
  {
    name: "临时除外可以让被处理怪兽不回卡组",
    question: "时空转生把有完美世界 卡通世界保护的卡通怪兽发动无效了，处理时是回卡组还是场地躲了呢？",
    assert(answer) {
      assert.equal(answer.verdictTitle, "可以适用临时除外效果，怪兽不回卡组");
      assert.equal(answer.rulingBasis, "效果文本 + 规则推理");
      assert.match(answer.verdict, /不能被洗回卡组/);
      assert.match(answer.steps.join("\n"), /处理完后/);
    },
  },
  {
    name: "弱相似问答不能覆盖临时除外结构推理",
    question:
      "「闪刀姬-飒天」伤害计算后发动②效果，从卡组把1张「闪刀」卡送去墓地。这个效果适用之际，可以适用「完美世界 卡通世界」③，把战斗破坏确定的卡通怪兽除外吗？",
    assert(answer) {
      assert.equal(answer.verdictTitle, "可以适用临时除外效果，怪兽不按原预定破坏处理");
      assert.equal(answer.rulingBasis, "效果文本 + 规则推理");
      assert.doesNotMatch(`${answer.verdict}${answer.rulingBasis}`, /Magic Jammer/);
      assert.match(answer.verdict, /不能按原预定破坏处理|不按原预定破坏处理/);
    },
  },
  {
    name: "从卡组送墓不能误判成回卡组",
    question: "「闪刀姬-飒天」②效果适用之际，可以适用「完美世界 卡通世界」③除外卡通怪兽吗？",
    assert(answer) {
      assert.equal(answer.verdictTitle, "可以适用临时除外效果");
      assert.doesNotMatch(`${answer.verdictTitle}${answer.verdict}`, /不回卡组|洗回卡组/);
    },
  },
];

const originalFetch = globalThis.fetch;

try {
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    statusText: "Not Found",
    json: async () => ({}),
    text: async () => "",
    headers: { get: () => "application/json" },
  });

  const dataDir = await makeDataDir();
  try {
    for (const test of tests) {
      const answer = await answerQuestion(
        { question: test.question },
        {
          dataDir,
          env: {
            MODEL_CARD_RESOLUTION: "false",
            CARD_RESOLUTION_BAIGE: "false",
            CARD_RESOLUTION_LANGUAGES: "fixture",
          },
          useModel: false,
        }
      );
      test.assert(answer);
      console.log(`ok - ${test.name}`);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
} finally {
  globalThis.fetch = originalFetch;
}

async function makeDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "ocg-ruling-tests-"));
  await writeJson(join(dir, "cards.json"), { schemaVersion: 1, records: cards });
  await writeJson(join(dir, "rulings.json"), { schemaVersion: 1, records: rulings });
  await writeJson(join(dir, "snapshot-meta.json"), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    freshnessDays: 30,
    sources: [],
  });
  await writeJson(join(dir, "ocg-rule-corpus.json"), { schemaVersion: 1, records: [] });
  await writeJson(join(dir, "ocg-rule-tests.json"), { schemaVersion: 1, records: [] });
  return dir;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
