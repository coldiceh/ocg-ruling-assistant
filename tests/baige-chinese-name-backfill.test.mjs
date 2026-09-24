import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  baigeSourceRecords,
  loadBaigeChineseNameSource,
  mergeMissingChineseNamesFromBaige,
  projectBaigeChineseNames,
  preserveBackfilledChineseNames,
} from "../scripts/lib/baige-chinese-name-backfill.mjs";
import { projectCardLite } from "../scripts/sync-ygoresources.mjs";
import { extractRagCards } from "../backend/ragCardExtractor.mjs";

test("existing official Chinese names retain CID-bound community aliases for exact identity lookup", () => {
  const cards = [
    { id: "22692", name: "黑之魔导的帘布", cnName: "黑之魔导的帘布", aliases: ["黑之魔导的帘布", "黒魔導のカーテン"] },
    { id: "4830", name: "黒魔術のカーテン", cnName: "黑魔术的幕帘", aliases: ["黒魔術のカーテン", "黑魔术的幕帘"] },
  ];
  const source = [{ cid: 22692, sc_name: "黑之魔导的帘布", cn_name: "黑魔导的幕帘" }];
  const merged = mergeMissingChineseNamesFromBaige(cards, source).records;
  const result = extractRagCards("「黑魔导的幕帘」能否发动？", {
    cards: merged, mentionSetSource: "typed_model",
    modelCardNameCandidates: [{ name: "黑魔导的幕帘", originalText: "黑魔导的幕帘" }],
  });
  assert.deepEqual(result.resolvedCards.map(card => card.id), ["22692"]);
  assert.equal(result.resolvedCards[0].requiresExternalIdentityVerification, undefined);
  assert.equal(merged[0].cnName, cards[0].cnName);
  assert.equal(merged[0].name, cards[0].name);
  assert.equal(merged[0].chineseNameSources.find(entry => entry.name === "黑魔导的幕帘").sourceRecordId, "22692");
  assert.deepEqual(cards[0].aliases, ["黑之魔导的帘布", "黒魔導のカーテン"]);
});

test("a later sync preserves sourced aliases when upstream supplies its own Chinese name", () => {
  const sources = [{ name: "社区译名", source: "baige", sourceRecordId: "13000" }];
  const fresh = [{ id: "13000", name: "官方主名", cnName: "官方中文名", aliases: ["官方中文名"], effectText: "新卡文" }];
  const previous = [{ id: "13000", cnName: "旧中文名", chineseNameSources: sources }];
  const result = preserveBackfilledChineseNames(fresh, previous);
  assert.equal(result[0].cnName, "官方中文名");
  assert.deepEqual(result[0].aliases, ["官方中文名", "旧中文名", "社区译名"]);
  assert.equal(result[0].effectText, "新卡文");
});

test("projects only explicit Baige Chinese name fields with their provenance", () => {
  const projected = projectBaigeChineseNames({
    cid: 12001,
    sc_name: "官方简中名",
    cn_name: "YGOPro 译名",
    md_name: "MD 名称",
    nwbbs_n: "社区名称",
    text: {
      name: "嵌套中文名",
      sc_name: "官方简中名",
      desc: "must not be imported",
    },
  });

  assert.equal(projected.cid, "12001");
  assert.deepEqual(projected.names, ["官方简中名", "YGOPro 译名", "嵌套中文名", "MD 名称", "社区名称"]);
  assert.deepEqual(
    projected.nameSources.map(({ source, sourceField }) => ({ source, sourceField })),
    [
      { source: "baige", sourceField: "sc_name" },
      { source: "baige", sourceField: "text.sc_name" },
      { source: "baige", sourceField: "cn_name" },
      { source: "baige", sourceField: "text.name" },
      { source: "baige", sourceField: "md_name" },
      { source: "baige", sourceField: "nwbbs_n" },
    ],
  );
  assert.equal(projected.names.includes("must not be imported"), false);
});

test("backfills only an empty cnName and merges aliases with the exact same stable cid", () => {
  const original = {
    id: "12002",
    name: "既有主名称",
    cnName: "",
    jaName: "既有日文名",
    enName: "Existing English Name",
    aliases: ["既有日文名", "Existing English Name"],
    effectText: "existing effect text",
    authority: "existing authority",
    nested: { preserved: true },
  };
  const existingChinese = { ...original, id: "12003", cnName: "既有中文名" };
  const wrongId = { ...original, id: "12004" };
  const result = mergeMissingChineseNamesFromBaige(
    [original, existingChinese, wrongId],
    [
      { cid: "12002", sc_name: "补全名称", cn_name: "补充别名", text: { desc: "ignored" } },
      { cid: "99999", sc_name: "错 ID 名称" },
      { cid: "12003", sc_name: "不得覆盖" },
    ],
  );

  const backfilled = result.records[0];
  assert.equal(backfilled.cnName, "补全名称");
  assert.deepEqual(backfilled.aliases, ["既有日文名", "Existing English Name", "补全名称", "补充别名"]);
  assert.deepEqual(
    backfilled.chineseNameSources.map(({ sourceField }) => sourceField),
    ["sc_name", "cn_name"],
  );

  const preserved = { ...backfilled };
  delete preserved.cnName;
  delete preserved.aliases;
  delete preserved.chineseNameSources;
  const expected = { ...original };
  delete expected.cnName;
  delete expected.aliases;
  assert.deepEqual(preserved, expected);
  assert.equal(result.records[1].cnName, existingChinese.cnName);
  assert.equal(result.records[1].name, existingChinese.name);
  assert.deepEqual(result.records[1].aliases, [...existingChinese.aliases, "不得覆盖"]);
  assert.strictEqual(result.records[2], wrongId);
  assert.deepEqual(result.stats, {
    sourceRecordCount: 3,
    usableSourceRecordCount: 3,
    eligibleCardCount: 3,
    matchedCardCount: 2,
    backfilledCardCount: 1,
    addedAliasCount: 3,
  });
});

test("preserves an alias collision across different stable IDs", () => {
  const result = mergeMissingChineseNamesFromBaige(
    [
      { id: "12005", name: "first", aliases: [] },
      { id: "12006", name: "second", aliases: [] },
    ],
    [
      { cid: "12005", sc_name: "同名别名" },
      { cid: "12006", sc_name: "同名别名" },
    ],
  );

  assert.equal(result.records[0].aliases.includes("同名别名"), true);
  assert.equal(result.records[1].aliases.includes("同名别名"), true);
});

test("loads array, records-array, data-array and cid-keyed Baige source shapes", async (context) => {
  assert.equal(baigeSourceRecords([{ cid: "1" }]).length, 1);
  assert.equal(baigeSourceRecords({ records: [{ cid: "2" }] }).length, 1);
  assert.equal(baigeSourceRecords({ data: [{ cid: "3" }] }).length, 1);
  assert.equal(baigeSourceRecords({ "4": { cid: "4" } }).length, 1);

  const directory = await mkdtemp(path.join(os.tmpdir(), "baige-name-source-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "cards.json");
  await writeFile(sourcePath, JSON.stringify({ "5": { cid: "5", sc_name: "名称" } }));
  const loaded = await loadBaigeChineseNameSource(sourcePath);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].cid, "5");
});

test("the sync card-lite projector carries the same names and provenance", () => {
  const card = {
    id: "12007",
    name: "primary",
    cnName: "中文名",
    aliases: ["中文名"],
    chineseNameSources: [{ name: "中文名", source: "baige", sourceField: "sc_name" }],
    effectText: "must remain outside the lite projection",
  };
  const lite = projectCardLite(card);
  assert.equal(lite.cnName, card.cnName);
  assert.strictEqual(lite.aliases, card.aliases);
  assert.strictEqual(lite.chineseNameSources, card.chineseNameSources);
  assert.equal(Object.hasOwn(lite, "effectText"), false);
});

test("a later upstream sync preserves bound name enrichment without a new source download", () => {
  const sources = [{name:"已补中文名",source:"baige",sourceRecordId:"12008"}];
  const previous = [{id:"12008",cnName:"已补中文名",aliases:["旧主名称","已补中文名"],chineseNameSources:sources}];
  const fresh = [{id:"12008",name:"当前主名称",cnName:"",aliases:["当前主名称"],effectText:"updated official text"},
    {id:"12009",cnName:"",aliases:[]}, {id:"12008",cnName:"新上游中文名",aliases:[]}];
  const output = preserveBackfilledChineseNames(fresh,previous);
  assert.equal(output[0].cnName,"已补中文名");
  assert.equal(output[0].effectText,"updated official text");
  assert.equal(output[0].name,"当前主名称");
  assert.deepEqual(output[0].chineseNameSources,sources);
  assert.deepEqual(output[0].aliases,["当前主名称","已补中文名"]);
  assert.strictEqual(output[1],fresh[1]);
  assert.equal(output[2].cnName, fresh[2].cnName);
  assert.deepEqual(output[2].aliases, ["已补中文名"]);
  assert.deepEqual(output[2].chineseNameSources, sources);
});
