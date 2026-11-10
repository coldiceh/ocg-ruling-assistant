import assert from "node:assert/strict";
import test from "node:test";
import { buildCidPasscodeMap } from "../scripts/lib/cid-passcode-map.mjs";
import { engineReproConciseText, engineReproDigest } from "../backend/engineRepro/concise.mjs";
import { runEngineReproduction } from "../backend/engineRepro/reproduce.mjs";

// Synthetic cards. OFFICIAL has data in the engine's pool but no script; PRE is the pre-release code of the
// same card (the engine's twin). NEW_* are released cards MyCard has only under a pre-release code.
const OFFICIAL = 9100001, PRE = 100900001, OTHER = 9100002, ART = 9100003, NEW_OFFICIAL = 9100010, NEW_PRE = 100900010;
const monster = (type = 0x21) => ({ type, atk: 1800, def: 1600, level: 4, race: 0x1, attribute: 0x1 });
const SPELL = Object.freeze({ type: 0x2, atk: 0, def: 0, level: 0, race: 0, attribute: 0 });
const pool = new Map([
  [OFFICIAL, { name: "测试骑士", alias: 0, data: monster() }],
  [PRE, { name: "测试骑士", alias: 0, data: monster() }],
  [OTHER, { name: "测试魔法", alias: 0, data: SPELL }],
  [ART, { name: "测试魔法", alias: OTHER, data: SPELL }],
  [NEW_PRE, { name: "测试新卡", alias: 0, data: monster() }],
]);
const ygo = (cid, id, cnName, extra = {}) => ({ cid, id, cn_name: cnName, data: monster(), ...extra });

test("map: sources agree or one has the card; the pool decides a disagreement; passcode 0 stays unmapped", () => {
  const out = buildCidPasscodeMap({
    cids: ["1", "2", "3", "4", "5", "-7"],
    ygocdb: { a: ygo(1, OFFICIAL, "测试骑士"), b: ygo(2, OTHER, "测试魔法"), c: ygo(3, 0, "奖品卡"), d: ygo(4, OTHER, "测试魔法") },
    yamlYugi: [{ konami_id: 1, password: OFFICIAL }, { konami_id: 4, password: 77777777 }, { konami_id: 5, password: 88888888 }],
    engineCards: pool });
  assert.deepEqual(out.map, { 1: OFFICIAL, 2: OTHER, 4: OTHER });
  assert.deepEqual(out.unmapped, { no_source: [], conflict: [], not_in_cdb: [[3, 0], [5, 88888888]] });
  assert.equal(out.counts.ruling_assistant_cids, 5, "a negative id (a Speed Duel skill) is not a card");
  assert.deepEqual([out.counts.both, out.counts.ygocdb_only, out.counts.yaml_yugi_only], [2, 1, 0]);
});

test("map: a passcode missing from the pool falls back to an exact ygocdb name with the same card data", () => {
  const out = buildCidPasscodeMap({
    cids: [10, 11, 12, 13],
    ygocdb: {
      a: ygo(10, NEW_OFFICIAL, "测试新卡"),
      b: ygo(11, 9100011, "别的译名", { nwbbs_n: "测试新卡" }),
      c: ygo(12, 9100012, "测试新卡", { data: { ...monster(), atk: 2000 } }),   // same name, different card data
      d: ygo(13, 9100013, "测试魔法", { data: SPELL }),   // the alternative artwork ART is not a second hit
    },
    yamlYugi: [], engineCards: pool });
  assert.deepEqual(out.map, { 10: NEW_PRE, 11: NEW_PRE, 13: OTHER });
  assert.deepEqual(out.by_name, [[10, NEW_OFFICIAL, NEW_PRE, "cn_name"], [11, 9100011, NEW_PRE, "nwbbs_n"],
    [13, 9100013, OTHER, "cn_name"]]);
  assert.deepEqual(out.unmapped.not_in_cdb, [[12, 9100012]]);
});

const naPlan = { applicability: "not_applicable", reason_code: "pure_rule", quoted_span: "q", sub_questions: [] };
const identity = { resolved: [{ cid: "500", mentionedAs: ["测试骑士"] }], unresolved: [], groupMentions: [] };
const cardsById = new Map([["500", { id: "500", name: "テスト騎士", effectText: "卡文" }]]);

test("an official card with no script runs as its pre-release twin, and the record says so", async () => {
  const calls = [];
  const engine = async (op, body) => {
    calls.push({ op, body });
    if (op === "cards" && body.with_text) return { cards: [] };
    if (op === "cards") return { cards: body.codes.map((code) => (code === OFFICIAL
      ? { code, exists: true, name: "测试骑士", types: ["怪兽"], script: null, twin: PRE }
      : { code, exists: true, name: "测试骑士", types: ["怪兽"], script: "prerelease" })) };
    if (op === "related") return { related: [] };
    throw new Error(`unexpected engine op ${op}`);
  };
  let input = "";
  const record = await runEngineReproduction({ question: "q", identity, cardsById, cidMap: { 500: OFFICIAL }, engine,
    modelCall: async (opts) => { input = opts.input; return { status: "completed", outputText: JSON.stringify(naPlan), usage: {} }; } });
  assert.deepEqual(calls.filter((c) => c.op === "cards" && !c.body.with_text).map((c) => c.body.codes), [[OFFICIAL], [PRE]]);
  assert.deepEqual(calls.filter((c) => c.op === "related").map((c) => c.body.codes), [[OFFICIAL], [PRE]]);
  assert.deepEqual(record.cards, [{ code: PRE, cid: "500", engineName: "测试骑士", mentionedAs: ["测试骑士"],
    script: "prerelease", twinOf: OFFICIAL }]);
  assert.ok(input.includes(`"code":${PRE}`) && !input.includes(String(OFFICIAL)), "the planner sees the code that runs");
  assert.match(record.rendered, new RegExp(`先行卡脚本：「测试骑士」\\(${PRE}\\) 用的是萌卡超先行脚本（正式卡号 ${OFFICIAL} 萌卡还没有脚本）`, "u"));
  assert.deepEqual(engineReproDigest(record).prereleaseCards, ["测试骑士"]);
});

test("a mapped passcode the engine's pool does not have is an identity failure, before any planning", async () => {
  let planned = false;
  const engine = async (op, body) => {
    if (op === "cards" && body.with_text) return { cards: [] };
    if (op === "cards") return { cards: body.codes.map((code) => ({ code, exists: false })) };
    if (op === "related") return { related: [] };
    throw new Error(`unexpected engine op ${op}`);
  };
  const record = await runEngineReproduction({ question: "q", identity, cardsById, cidMap: { 500: PRE }, engine,
    modelCall: async () => { planned = true; return { status: "completed", outputText: "{}", usage: {} }; } });
  assert.equal(planned, false);
  assert.equal(record.summary.status, "未复现");
  assert.equal(record.preStatus.detail, `无法确认身份：CID 500（テスト騎士）的卡号 ${PRE} 不在引擎卡库`);
  assert.match(engineReproConciseText(engineReproDigest(record)), /「テスト騎士」在 ygopro 的卡库里找不到/u);
});
