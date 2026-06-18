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
  {
    id: "22520001",
    passcode: "22520001",
    name: "杀手级调整曲·啭啭削波手",
    cnName: "杀手级调整曲·啭啭削波手",
    jaName: "キラーチューン・クリッパー",
    enName: "Killer Tune Clipper",
    aliases: ["杀手级调整曲·啭啭削波手", "削波手", "啭啭削波手"],
    effectText: "①：以额外卡组表侧表示的1只怪兽为对象才能发动。那只怪兽直到结束阶段表侧表示除外，结束阶段回到额外卡组。",
    sourceUrl: "fixture://killer-tune-clipper",
  },
  {
    id: "22520002",
    passcode: "22520002",
    name: "狱神影兽-涅瓦红化兽",
    cnName: "狱神影兽-涅瓦红化兽",
    jaName: "獄神影獣－涅瓦紅化獸",
    enName: "Nervedo the Shadebeast Power Patron",
    aliases: ["狱神影兽-涅瓦红化兽", "影兽", "涅瓦红化兽", "Nervedo"],
    effectText: "②：这张卡表侧加入额外卡组的场合才能发动。处理该效果。",
    sourceUrl: "fixture://nervedo",
  },
  {
    id: "71143015",
    passcode: "",
    name: "青眼暴君龙",
    cnName: "青眼暴君龙",
    jaName: "青眼のタイラント・ドラゴン",
    enName: "Blue-Eyes Tyrant Dragon",
    aliases: ["青眼暴君龙", "青眼暴君龍", "暴君龙", "Blue-Eyes Tyrant Dragon"],
    effectText:
      "1回合1次，这张卡进行战斗的伤害步骤结束时，以自己墓地1张陷阱卡为对象才能发动。那张卡在自己的魔法与陷阱区域盖放。这个效果盖放的卡在盖放的回合也能发动。",
    sourceUrl: "fixture://blue-eyes-tyrant-dragon",
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
  {
    id: "clipper-can-banish-nervedo",
    recordType: "card-faq",
    title: "削波手 FAQ：能否除外影兽",
    question: "可以用「杀手级调整曲·啭啭削波手」①效果将额外卡组表侧表示的「狱神影兽-涅瓦红化兽」直到结束阶段表侧表示除外吗？",
    cards: ["杀手级调整曲·啭啭削波手", "狱神影兽-涅瓦红化兽"],
    keywords: ["除外", "额外卡组", "结束阶段"],
    conclusion: "可以适用相关效果，将满足条件的卡除外。",
    sources: [{ label: "fixture", detail: "can-banish" }],
  },
  {
    id: "perfect-toon-world-can-banish-battle-destroyed",
    recordType: "card-faq",
    title: "完美世界 FAQ：可以除外战斗破坏预定卡通怪兽",
    question: "其他卡发动的效果适用之际，可以把战斗破坏确定的卡通怪兽用「完美世界 卡通世界」③除外吗？",
    cards: ["完美世界 卡通世界"],
    keywords: ["除外", "战斗破坏", "卡通怪兽"],
    conclusion: "可以适用相关效果，将满足条件的卡除外。",
    sources: [{ label: "fixture", detail: "perfect-toon-world-banish" }],
  },
];

const mindForcePreviewText = `新卡效果：
LoupGarou罗伽
UT01
聖なる心のバリア-マインドフォースー
通常陷阱
对方场上有表侧表示卡5张以上存在的场合，这张卡的发动和效果不会被无效化，这张卡在盖放的回合也能发动。
①：以下任意时才能发动。对方场上的全部表侧表示卡效果无效并破坏。这张卡的发动后，直到下个回合结束时自己怪兽不能直接攻击。
●对方场上的攻击力最高的怪兽的攻击宣言时
●要让场上的卡破坏的怪兽的效果由对方发动时
●自己回合对方把手卡·场上的怪兽的效果发动时`;

const tests = [
  {
    name: "处理问题不能用发动条件资料回答",
    question: "时空转生把有场地的卡通怪康了，处理时是回卡组还是场地躲了呢？",
    assert(answer) {
      assert.notEqual(answer.subAnswers[0].status, "confirmed");
      assert.doesNotMatch(`${answer.verdictTitle}${answer.verdict}`, /可以发动/);
      assert.equal("value" in answer.confidence, false);
      assert.ok(answer.rejectedEvidence.some((item) => item.evidenceId === "tachyon-activation-only"));
    },
  },
  {
    name: "临时除外文本不能让回卡组问题直接 confirmed",
    question: "时空转生把有完美世界 卡通世界保护的卡通怪兽发动无效了，处理时是回卡组还是场地躲了呢？",
    assert(answer) {
      assert.ok(["unknown", "inferred"].includes(answer.subAnswers[0].status));
      assert.notEqual(answer.subAnswers[0].status, "confirmed");
    },
  },
  {
    name: "弱相似问答最多只能产生 inferred",
    question:
      "「闪刀姬-飒天」伤害计算后发动②效果，从卡组把1张「闪刀」卡送去墓地。这个效果适用之际，可以适用「完美世界 卡通世界」③，把战斗破坏确定的卡通怪兽除外吗？",
    assert(answer) {
      assert.ok(["confirmed", "inferred"].includes(answer.subAnswers[0].status));
      assert.doesNotMatch(answer.subAnswers[0].source, /weak-magic-jammer-analogy/);
    },
  },
  {
    name: "从卡组送墓不能误判成回卡组",
    question: "「闪刀姬-飒天」②效果适用之际，可以适用「完美世界 卡通世界」③除外卡通怪兽吗？",
    assert(answer) {
      assert.ok(["confirmed", "inferred"].includes(answer.subAnswers[0].status));
      assert.doesNotMatch(answer.subAnswers[0].verdict, /不回卡组|洗回卡组/);
    },
  },
  {
    name: "未发售卡片文本不能直接产生 confirmed",
    question: `${mindForcePreviewText}

这张卡发动时对方有5张表侧表示卡，处理过程中变成4张了，发动和效果还会不会被无效？`,
    assert(answer) {
      assert.notEqual(answer.subAnswers[0].status, "confirmed");
      assert.ok(answer.evidence.cardTextEvidence.length > 0);
    },
  },
  {
    name: "未知问题类型在未发售文本场景中保守降级",
    question: `${mindForcePreviewText}

这张卡的发动和效果不会被无效化，那还能被黑玛丽或者暗黑界龙神王这种改写效果类处理改写吗？`,
    assert(answer) {
      assert.ok(["unknown", "parse_failed"].includes(answer.subAnswers[0].status));
      assert.notEqual(answer.subAnswers[0].status, "confirmed");
    },
  },
  {
    name: "发动问题不能只凭未发售文本确认",
    question: `${mindForcePreviewText}

对方用怪兽效果把我方魔法陷阱的发动无效并破坏，这算不算对方发动了要让场上的卡破坏的怪兽效果，能发动这张卡吗？`,
    assert(answer) {
      assert.notEqual(answer.subAnswers[0].status, "confirmed");
      assert.ok(answer.evidence.cardTextEvidence.length > 0);
    },
  },
  {
    name: "不能把能否除外的 FAQ 当成另一个效果能否发动的答案",
    question:
      "用「杀手级调整曲·啭啭削波手」的①效果将额外卡组表侧表示的「狱神影兽-涅瓦红化兽」直到EP表侧除外，EP回到额外卡组的场合，影兽能否发动自己的②效果？",
    assert(answer) {
      assert.notEqual(answer.subAnswers[0].status, "confirmed");
      assert.ok(answer.rejectedEvidence.some((item) => item.evidenceId === "clipper-can-banish-nervedo"));
    },
  },
  {
    name: "多个伤害步骤问题必须独立拆分和判级",
    question:
      "被青眼暴君龙战破的卡通怪兽，在伤害步骤结束阶段发动盖放墓地陷阱卡效果的时候：能用完美世界 卡通世界的效果除外该卡通怪兽吗？卡通怪兽还会被战破送墓吗？如果青眼暴君龙被战破的时候，这个效果是在墓地发动还是在场上发动？这个时候青眼暴君龙是已经送墓了吗？",
    assert(answer) {
      assert.ok(answer.subAnswers.length >= 4);
      assert.ok(answer.subAnswers.some((item) => item.status !== "confirmed"));
      assert.ok(answer.cards.some((card) => card.name === "青眼暴君龙"));
      assert.ok(answer.cards.some((card) => card.name === "完美世界 卡通世界"));
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
