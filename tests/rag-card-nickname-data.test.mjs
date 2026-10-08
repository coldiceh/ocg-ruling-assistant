import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildCardNicknameData, deriveCardNicknameBridges, nicknameRevision, validateCardNicknameData } from "../scripts/lib/ragCardNicknameData.mjs";

const root = new URL("../", import.meta.url);
const json = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
const [cardsPayload, published, manifest, nicknameRecords, bridgePayload, curated] = await Promise.all([
  json("data/cards.json"), json("data/card-nicknames.v1.json"), json("data/card-nickname-sources/sources.v1.json"),
  json("data/card-nickname-sources/ocgbot-dcc1a184.nickname.json"), json("data/card-nickname-sources/identity-bridges.v1.json"),
  json("data/card-nickname-sources/curated.v1.json"),
]);
const cards = cardsPayload.records;
const source = { id: "test", url: "https://example.com/dictionary", revision: "pinned-test", license: "MIT", licenseFile: "LICENSE" };
const fixtureCards = [
  { id: "1", name: "甲卡", jaName: "甲", aliases: ["甲別名"] },
  { id: "2", name: "乙卡", jaName: "乙", aliases: [] },
];
const row = (name, nick_name = "小蓝", nk_type = 0) => ({ name, nick_name, nk_type });
const build = (overrides = {}) => buildCardNicknameData({ cards: fixtureCards, nicknameRecords: [], sources: [source], nicknameSourceId: "test", ...overrides });
const aliases = (alias) => [...new Set(published.entries.filter((entry) => entry.alias === alias).map((entry) => entry.cardId))].sort();

test("the released dictionary rebuilds byte-for-byte from pinned inputs", () => {
  const rebuilt = buildCardNicknameData({ cards, nicknameRecords, bridges: bridgePayload.entries,
    curatedEntries: curated.entries, sources: manifest.sources, nicknameSourceId: manifest.nicknameSourceId });
  assert.deepEqual(rebuilt.data, published);
  assert.equal(validateCardNicknameData(published, cards), true);
  assert.equal(rebuilt.report.counts.sourceRows, 598);
  assert.equal(rebuilt.report.counts.importedRows, 520);
  assert.equal(rebuilt.report.counts.replacementRows, 48);
  assert.equal(rebuilt.report.counts.unresolvedRows, 30);
  assert.equal(rebuilt.report.counts.withheldResolvedRows, 0);
  assert.equal(published.entries.length, 524);
});

test("pinned source hash and license notices are present", async () => {
  const input = await readFile(new URL("data/card-nickname-sources/ocgbot-dcc1a184.nickname.json", root));
  assert.equal(createHash("sha256").update(input).digest("hex"), manifest.sources.find((item) => item.id === manifest.nicknameSourceId).sha256);
  for (const item of published.sources) {
    const notice = await readFile(new URL(item.licenseFile, root), "utf8");
    if (item.license === "MIT") {
      assert.match(notice, /MIT License/u);
      assert.match(notice, /Copyright/u);
      assert.match(notice, /Permission is hereby granted/u);
    } else {
      assert.equal(item.license, "LicenseRef-Factual-References");
      assert.match(notice, /not a third-party license grant/u);
    }
  }
});

test("known ambiguous nicknames retain complete card sets", () => {
  assert.deepEqual(aliases("小蓝"), ["12106", "14759"]);
  assert.equal(aliases("小米").length, 3);
  assert.equal(aliases("小黑").length, 2);
  assert.equal(aliases("红管人").length, 2);
  assert.equal(aliases("蓝管人").length, 2);
  const groups = new Map();
  for (const item of nicknameRecords.filter((entry) => entry.nk_type === 0)) {
    const rows = groups.get(item.nick_name) || [];
    rows.push(item);
    groups.set(item.nick_name, rows);
  }
  for (const [alias, rows] of groups) {
    if (rows.length < 2) continue;
    assert.equal(aliases(alias).length, new Set(rows.map((item) => item.name)).size, alias);
  }
});

test("curated Phoenix and Turtle G references use verified existing CIDs", () => {
  for (const alias of ["凤凰人", "毁灭凤凰人", "命运英雄 毁灭凤凰人"]) assert.deepEqual(aliases(alias), ["16524"]);
  assert.deepEqual(aliases("龟G"), ["23548"]);
  assert.equal(published.entries.some((entry) => /effectText|prompt|instruction/u.test(Object.keys(entry).join(" "))), false);
});

test("name binding is exact and literal, with no fuzzy, punctuation or regex expansion", () => {
  const result = build({ nicknameRecords: [row("別名", "短名"), row("甲 卡", "空格"), row("甲卡.*", "模式"), row("甲別名", "a.*b")] });
  assert.deepEqual(result.data.entries, [{ alias: "a.*b", cardId: "1", sourceId: "test" }]);
  assert.equal(result.report.counts.unresolvedRows, 3);
});

test("substitution rules are never treated as exact aliases or executable patterns", () => {
  const result = build({ nicknameRecords: [row("甲卡", "任意替换", 1), row("甲卡", "(?<bad>.*)", 1)] });
  assert.deepEqual(result.data.entries, []);
  assert.equal(result.report.counts.replacementRows, 2);
});

test("a partly unresolved alias group is entirely withheld", () => {
  const result = build({ nicknameRecords: [row("甲卡"), row("尚未核实的乙卡")] });
  assert.deepEqual(result.data.entries, []);
  assert.equal(result.report.counts.unresolvedRows, 1);
  assert.equal(result.report.counts.withheldResolvedRows, 1);
  assert.throws(() => build({ nicknameRecords: [row("甲卡"), row("未核实")],
    curatedEntries: [{ alias: "小蓝", cardId: "1", jaName: "甲", sourceId: "test" }] }), /unresolved source candidates/u);
});

test("an invalid target row cannot turn a known multi-target alias into a single candidate", () => {
  const result = build({ nicknameRecords: [row("甲卡"), row("")] });
  assert.deepEqual(result.data.entries, []);
  assert.equal(result.report.counts.invalidRows, 1);
  assert.equal(result.report.counts.withheldResolvedRows, 1);
});

test("target-name ambiguity rejects the whole nickname instead of choosing first", () => {
  const result = build({ cards: fixtureCards.map((item) => ({ ...item, aliases: ["同名"] })),
    nicknameRecords: [row("同名"), row("甲卡")] });
  assert.deepEqual(result.data.entries, []);
  assert.equal(result.report.counts.ambiguousTargetRows, 1);
  assert.equal(result.report.counts.withheldResolvedRows, 1);
});

test("known multi-card aliases survive duplicate rows and deterministic ordering", () => {
  const input = [row("乙卡"), row("甲卡"), row("甲卡")];
  const first = build({ nicknameRecords: input });
  const second = build({ nicknameRecords: [...input].reverse() });
  assert.deepEqual(first.data, second.data);
  assert.deepEqual(first.data.entries.map((entry) => entry.cardId), ["1", "2"]);
});

test("Baige bridges require matching CID and exact Japanese name", () => {
  const bridges = deriveCardNicknameBridges({ cards: fixtureCards, nicknameRecords: [row("旧甲"), row("旧乙"), row("模式甲", "模式", 1)], sourceId: "test",
    baigeRecords: [
      { cid: 1, jp_name: "甲", cn_name: "旧甲", nwbbs_n: "旧甲" },
      { cid: 2, jp_name: "乙不一致", cn_name: "旧乙" },
      { cid: 3, jp_name: "甲", cn_name: "旧甲" },
      { cid: 1, jp_name: "甲", cn_name: "模式甲" },
    ] });
  assert.deepEqual(bridges, [{ name: "旧甲", cardId: "1", jaName: "甲", sourceId: "test" }]);
  const result = build({ nicknameRecords: [row("旧甲")], bridges });
  assert.equal(result.data.entries[0].cardId, "1");
});

test("stale, unknown or conflicting identity bridges cannot silently bind", () => {
  const bridge = { name: "旧甲", cardId: "1", jaName: "甲", sourceId: "test" };
  assert.throws(() => build({ bridges: [{ ...bridge, jaName: "错误身份" }] }), /Japanese name mismatch/u);
  assert.throws(() => build({ bridges: [{ ...bridge, cardId: "999" }] }), /Japanese name mismatch/u);
  assert.throws(() => build({ bridges: [{ ...bridge, sourceId: "missing" }] }), /unknown identity bridge source/u);
  const result = build({ nicknameRecords: [row("甲卡")], bridges: [{ ...bridge, name: "甲卡", cardId: "2", jaName: "乙" }] });
  assert.deepEqual(result.data.entries, []);
  assert.equal(result.report.counts.ambiguousTargetRows, 1);
});

test("validation rejects unknown IDs, missing licenses, undeclared sources and altered data", () => {
  const good = build({ nicknameRecords: [row("甲卡")] }).data;
  const changed = structuredClone(good);
  changed.entries[0].cardId = "999";
  assert.throws(() => validateCardNicknameData(changed, fixtureCards), /unknown card CID/u);
  const missingLicense = structuredClone(good);
  delete missingLicense.sources[0].license;
  assert.throws(() => validateCardNicknameData(missingLicense, fixtureCards), /missing source license/u);
  const missingSource = structuredClone(good);
  missingSource.entries[0].sourceId = "unknown";
  assert.throws(() => validateCardNicknameData(missingSource, fixtureCards), /unknown source ID/u);
  const altered = structuredClone(good);
  altered.entries[0].alias = "被改动";
  assert.throws(() => validateCardNicknameData(altered, fixtureCards), /revision does not match/u);
  const duplicated = structuredClone(good);
  duplicated.entries.push({ ...duplicated.entries[0] });
  duplicated.revision = nicknameRevision(duplicated);
  assert.throws(() => validateCardNicknameData(duplicated, fixtureCards), /duplicate alias mapping/u);
});

test("non-OCG negative Skill IDs do not enter the nickname dictionary", () => {
  const result = build({ cards: [...fixtureCards, { id: "-75", name: "Skill", jaName: "技" }], nicknameRecords: [row("Skill")] });
  assert.deepEqual(result.data.entries, []);
  assert.equal(result.report.counts.unresolvedRows, 1);
});
