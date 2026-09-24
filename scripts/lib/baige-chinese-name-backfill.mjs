import { readFile } from "node:fs/promises";

const SOURCE_NAME = "baige";
const SOURCE_URL = "https://ygocdb.com/api/v0/cards.zip";

const NAME_FIELDS = [
  ["sc_name", ["sc_name"]],
  ["text.sc_name", ["text", "sc_name"]],
  ["cn_name", ["cn_name"]],
  ["text.cn_name", ["text", "cn_name"]],
  ["text.name", ["text", "name"]],
  ["md_name", ["md_name"]],
  ["text.md_name", ["text", "md_name"]],
  ["nwbbs_n", ["nwbbs_n"]],
  ["text.nwbbs_n", ["text", "nwbbs_n"]],
  ["cnocg_n", ["cnocg_n"]],
  ["text.cnocg_n", ["text", "cnocg_n"]],
];

export async function loadBaigeChineseNameSource(path) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  return baigeSourceRecords(payload);
}

export function baigeSourceRecords(payload) {
  if (Array.isArray(payload)) return payload.filter(isObject);
  if (!isObject(payload)) return [];
  if (Array.isArray(payload.records)) return payload.records.filter(isObject);
  if (Array.isArray(payload.data)) return payload.data.filter(isObject);
  return Object.values(payload).filter(isObject);
}

export function projectBaigeChineseNames(record = {}) {
  if (!isObject(record)) return null;
  const cid = stableId(record.cid);
  if (!cid) return null;

  const nameSources = [];
  for (const [sourceField, path] of NAME_FIELDS) {
    const name = nonEmptyString(readPath(record, path));
    if (!name) continue;
    nameSources.push({
      name,
      source: SOURCE_NAME,
      sourceField,
      sourceUrl: SOURCE_URL,
      sourceRecordId: cid,
    });
  }

  return {
    cid,
    names: unique(nameSources.map((entry) => entry.name)),
    nameSources: uniqueBy(nameSources, (entry) => `${entry.sourceField}\u0000${entry.name}`),
  };
}

export function mergeMissingChineseNamesFromBaige(cards = [], sourceRecords = []) {
  const sourceByCid = new Map();
  let usableSourceRecordCount = 0;

  for (const sourceRecord of sourceRecords || []) {
    const projected = projectBaigeChineseNames(sourceRecord);
    if (!projected?.names.length) continue;
    usableSourceRecordCount += 1;
    const existing = sourceByCid.get(projected.cid) || { names: [], nameSources: [] };
    existing.names = unique([...existing.names, ...projected.names]);
    existing.nameSources = uniqueBy(
      [...existing.nameSources, ...projected.nameSources],
      (entry) => `${entry.sourceField}\u0000${entry.name}`,
    );
    sourceByCid.set(projected.cid, existing);
  }

  let eligibleCardCount = 0;
  let matchedCardCount = 0;
  let backfilledCardCount = 0;
  let addedAliasCount = 0;

  const records = (cards || []).map((card) => {
    if (!isObject(card)) return card;
    eligibleCardCount += 1;
    const id = stableId(card.id);
    const source = id ? sourceByCid.get(id) : null;
    if (!source?.names.length) return card;
    matchedCardCount += 1;

    const previousAliases = Array.isArray(card.aliases) ? card.aliases : [];
    const aliases = unique([...previousAliases, ...source.names]);
    const existingSources = Array.isArray(card.chineseNameSources) ? card.chineseNameSources : [];
    const chineseNameSources = uniqueBy(
      [...existingSources, ...source.nameSources],
      (entry) => `${entry?.source || ""}\u0000${entry?.sourceField || ""}\u0000${entry?.name || ""}`,
    );

    addedAliasCount += aliases.length - unique(previousAliases).length;
    const existingChineseName = nonEmptyString(card.cnName);
    if (!existingChineseName) backfilledCardCount += 1;
    return {
      ...card,
      cnName: existingChineseName || source.names[0],
      aliases,
      chineseNameSources,
    };
  });

  return {
    records,
    stats: {
      sourceRecordCount: (sourceRecords || []).length,
      usableSourceRecordCount,
      eligibleCardCount,
      matchedCardCount,
      backfilledCardCount,
      addedAliasCount,
    },
  };
}

export function preserveBackfilledChineseNames(cards = [], previousCards = []) {
  const previousById = new Map(previousCards.map(card => [stableId(card?.id), card]));
  return cards.map(card => {
    if (!isObject(card)) return card;
    const previous = previousById.get(stableId(card.id));
    if (!nonEmptyString(previous?.cnName) || !Array.isArray(previous.chineseNameSources)
        || !previous.chineseNameSources.length) return card;
    return { ...card, cnName: nonEmptyString(card.cnName) || previous.cnName,
      aliases: unique([...(Array.isArray(card.aliases) ? card.aliases : []), previous.cnName,
        ...previous.chineseNameSources.map(entry => nonEmptyString(entry?.name)).filter(Boolean)]),
      chineseNameSources: previous.chineseNameSources,
    };
  });
}

function readPath(value, path) {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function stableId(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  return /^\d+$/u.test(text) ? text : "";
}

function nonEmptyString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueBy(values, getKey) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = getKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
