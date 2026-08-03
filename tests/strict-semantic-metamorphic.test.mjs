import assert from "node:assert/strict";
import test from "node:test";

import { analyzeEffectStateTransition } from "../backend/effectStateReasoner.mjs";
import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import { loadRagData } from "../backend/ragEvidenceRetriever.mjs";

const data = await loadRagData();

const cases = [{
  id: "summon-procedure-reordered-wording",
  question: "本回合我方曾发动过魔法卡的效果。场上表侧的「混沌黑魔术师」是8星、暗属性、魔法师族；手牌有「深渊的相剑龙」。现在把前者除外，能否依照「毁灭的黑魔术师」记载的手续从额外卡组特殊召唤它？成功后双方各有哪些诱发效果可以发动，连锁顺序是什么？",
  expected: [/^可以将/u, /C1/u, /C2/u],
}, {
  id: "albaz-resolution-explicitly-separated",
  question: "额外卡组仅有「冰剑龙 幻冰龙」。我方手牌为「阿不思的落胤」「教导的圣女 艾克莉西亚」，对方场上仅有表侧「吞食圣痕之龙」，双方墓地为空。召唤阿不思后，先问：能否丢弃圣女支付①的COST并发动？若能发动，再问：支付代价后的效果处理结果是什么？",
  expected: [/^可以发动/u, /不进行融合召唤/u],
}, {
  id: "evenly-activation-zone-paraphrase",
  question: "战斗阶段结束时，我方场上没有任何卡，于是从手牌发动「颉颃胜负」。对方场上有通常召唤的「天下独步的大义贼」。虽然陷阱原先在手牌，这次卡的发动在规则上发生于哪个区域；大义贼①能否直接连锁？",
  expected: [/不能连锁发动/u, /魔法与陷阱区域/u],
}, {
  id: "rewrite-attribution-paraphrase",
  question: "结束阶段「尤贝尔」③发动，随后「纳祭魔鬼莲」②连锁，把③的处理替换成破坏场上一只尤贝尔怪兽。若处理时选中并破坏发动③的那只「尤贝尔」，这次破坏是否仍属于它原来的③？它的④能否发动？我方场上另有「尤贝尔之精灵」。",
  expected: [/^不算被/u, /可以发动④/u],
}, {
  id: "lingering-duration-paraphrase",
  question: "「月光银狗」①特殊召唤出的怪兽先被对方取得控制权，后来又回到我方场上。与该怪兽在我方场上存在相绑定的额外卡组特殊召唤限制，是暂时中断后恢复，还是在控制权第一次转移时就永久结束？",
  expected: [/立即不再适用/u, /不会恢复适用/u],
}, {
  id: "ordered-resolution-checkpoints-paraphrase",
  question: "我方表侧「闪刀姬＝零露」对着对方表侧「千查万别」发动②。请按处理顺序说明：两只战士族怪兽是否先同时特殊召唤，再选择是否破坏；若破坏千查与若破坏别的卡，两只怪兽最后各自怎样？",
  expected: [/^可以发动/u, /先把.*同时特殊召唤/u, /两只怪兽都正常留在场上/u, /选择1只送去墓地/u],
}, {
  id: "printed-reference-paraphrase",
  question: "「霸王眷龙 凶饿猛毒」复制「破坏龙 钢多拉G」的原本卡名和效果后，能否因此认定自己的卡面效果文本框记载了「光之黄金柜」，从而满足要求‘有该卡名记述’的条件？",
  expected: [/^不能仅凭复制/u, /卡面原本的效果文本/u],
}, {
  id: "use-versus-application-paraphrase",
  question: "「破械式鬼シュマ」①的发动被连锁的「灰流丽」无效。请分别判断：本回合能否再发动一次①；原处理中的破坏与特殊召唤会不会做；‘本回合只能特殊召唤恶魔族’是否还约束我方？",
  expected: [/不能再次发动/u, /限制.*不适用/u],
}];

for (const fixture of cases) {
  test(`metamorphic semantic executor: ${fixture.id}`, async () => {
    const cardResolution = extractRagCards(fixture.question, {
      cards: data.cards,
      maxCards: 8,
    });
    const result = analyzeEffectStateTransition({
      userQuery: fixture.question,
      resolvedCards: cardResolution.resolvedCards,
    });
    for (const pattern of fixture.expected) assert.match(result.shortAnswer, pattern, JSON.stringify({
      id: fixture.id,
      shortAnswer: result.shortAnswer,
      unresolvedMentions: cardResolution.unresolvedMentions,
      result,
    }));
    assert.equal(result.status, "resolved", JSON.stringify({
      id: fixture.id,
      shortAnswer: result.shortAnswer,
      unresolvedMentions: cardResolution.unresolvedMentions,
      result,
    }));
    assert.equal(result.complete, true);
    assert.equal(result.authoritative, true);
  });
}
