import assert from "node:assert/strict";
import test from "node:test";
import { splitEffectTextBlocks } from "../backend/cardEffectBlocks.mjs";

test("numbered effect text is split into independent semantic blocks", () => {
  const blocks = splitEffectTextBlocks([
    "此卡名的①②效果1回合仅可各使用1次。",
    "①：将场上的1只怪兽放回手牌。",
    "②：场上的1只守备力最低的怪兽攻击力下降500。",
  ].join("\n"));

  assert.deepEqual(blocks.map((block) => block.marker), ["", "①", "②"]);
  assert.equal(blocks[0].kind, "preamble");
  assert.match(blocks[0].text, /1回合仅可各使用1次/u);
  assert.match(blocks[1].text, /放回手牌/u);
  assert.doesNotMatch(blocks[1].text, /守备力最低/u);
  assert.match(blocks[2].text, /守备力最低/u);
  assert.doesNotMatch(blocks[2].text, /放回手牌/u);
});

test("arabic line-numbered effects are split while bullet options remain attached", () => {
  const blocks = splitEffectTextBlocks([
    "共同发动限制。",
    "1. 可以发动。抽1张卡。",
    "2）从以下选择1个。",
    "●地：攻击力上升500。",
  ].join("\n"));

  assert.deepEqual(blocks.map((block) => block.marker), ["", "1", "2"]);
  assert.match(blocks[2].text, /●地/u);
  assert.doesNotMatch(blocks[1].text, /●地/u);
});

test("unmarked effect text remains one block", () => {
  assert.deepEqual(
    splitEffectTextBlocks("场上的表侧表示怪兽变为守备表示。"),
    [{
      id: "effect-unmarked",
      marker: "",
      text: "场上的表侧表示怪兽变为守备表示。",
    }],
  );
});
