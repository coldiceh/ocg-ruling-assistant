import { createHash } from "node:crypto";

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const cleanText = (value) => typeof value === "string" && value.length > 0
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const cardIdText = (value) => typeof value === "string" && /^[1-9]\d*$/u.test(value);
const keyFor = (entry) => JSON.stringify([entry.alias, entry.cardId, entry.sourceId]);
const hash = (value) => createHash("sha256").update(value).digest("hex");

function assert(condition, message) {
  if (!condition) throw new Error(`Card nickname data: ${message}`);
}

function indexCards(cards) {
  assert(Array.isArray(cards), "cards must be an array");
  const byId = new Map();
  const byName = new Map();
  for (const card of cards) {
    // The corpus also contains negative IDs for Skill cards; these are not OCG CIDs.
    if (typeof card?.id === "string" && /^-\d+$/u.test(card.id)) continue;
    assert(cardIdText(card?.id), "invalid card CID");
    assert(!byId.has(card.id), `duplicate card CID ${card.id}`);
    byId.set(card.id, card);
    for (const name of [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]) {
      if (!cleanText(name)) continue;
      const ids = byName.get(name) || new Set();
      ids.add(card.id);
      byName.set(name, ids);
    }
  }
  return { byId, byName };
}

export function deriveCardNicknameBridges({ cards, nicknameRecords, baigeRecords, sourceId }) {
  const { byId } = indexCards(cards);
  const targetNames = new Set(nicknameRecords.filter((row) => row.nk_type === 0).map((row) => row.name));
  const found = new Map();
  for (const record of baigeRecords) {
    const cardId = String(record.cid);
    const card = byId.get(cardId);
    // A shared translated name alone is not identity proof.
    if (!card || !cleanText(record.jp_name) || card.jaName !== record.jp_name) continue;
    for (const field of ["cn_name", "sc_name", "md_name", "nwbbs_n", "cnocg_n"]) {
      const name = record[field];
      if (!cleanText(name) || !targetNames.has(name)) continue;
      const entry = { name, cardId, jaName: record.jp_name, sourceId };
      found.set(JSON.stringify([name, cardId]), entry);
    }
  }
  return [...found.values()].sort((a, b) => compare(a.name, b.name) || compare(a.cardId, b.cardId));
}

export function nicknameRevision({ sources, entries }) {
  return `sha256:${hash(JSON.stringify({ schemaVersion: 1, sources, entries }))}`;
}

export function validateCardNicknameData(data, cards) {
  assert(data?.schemaVersion === 1, "unsupported schema version");
  assert(Array.isArray(data.sources) && data.sources.length > 0, "missing sources");
  assert(Array.isArray(data.entries), "missing entries");
  const { byId } = indexCards(cards);
  const sourceIds = new Set();
  for (const source of data.sources) {
    assert(cleanText(source.id) && !sourceIds.has(source.id), "invalid or duplicate source ID");
    sourceIds.add(source.id);
    assert(cleanText(source.url) && /^https:\/\//u.test(source.url), `invalid source URL ${source.id}`);
    assert(cleanText(source.revision), `missing source revision ${source.id}`);
    assert(cleanText(source.license), `missing source license ${source.id}`);
    assert(source.license === "MIT" || source.license === "LicenseRef-Factual-References", `unreviewed source license ${source.id}`);
    assert(cleanText(source.licenseFile), `missing license notice ${source.id}`);
  }
  const seen = new Set();
  for (const entry of data.entries) {
    assert(Object.keys(entry).sort().join(",") === "alias,cardId,sourceId", "unexpected entry fields");
    assert(cleanText(entry.alias), "invalid literal alias");
    assert(cardIdText(entry.cardId) && byId.has(entry.cardId), `unknown card CID ${entry.cardId}`);
    assert(sourceIds.has(entry.sourceId), `unknown source ID ${entry.sourceId}`);
    const key = keyFor(entry);
    assert(!seen.has(key), `duplicate alias mapping ${entry.alias}`);
    seen.add(key);
  }
  assert(data.revision === nicknameRevision(data), "revision does not match content");
  return true;
}

export function buildCardNicknameData({ cards, nicknameRecords, bridges = [], curatedEntries = [], sources, nicknameSourceId }) {
  assert(Array.isArray(nicknameRecords), "nickname records must be an array");
  const { byId, byName } = indexCards(cards);
  const sourceIds = new Set(sources.map((source) => source.id));
  assert(sourceIds.has(nicknameSourceId), "nickname source is not declared");
  for (const bridge of bridges) {
    assert(cleanText(bridge.name) && cardIdText(bridge.cardId), "invalid identity bridge");
    assert(sourceIds.has(bridge.sourceId), "unknown identity bridge source");
    const card = byId.get(bridge.cardId);
    assert(card && cleanText(bridge.jaName) && card.jaName === bridge.jaName, `identity bridge Japanese name mismatch ${bridge.cardId}`);
    const ids = byName.get(bridge.name) || new Set();
    ids.add(bridge.cardId);
    byName.set(bridge.name, ids);
  }

  const groups = new Map();
  const invalidAliases = new Set();
  const rejected = [];
  const counts = { sourceRows: nicknameRecords.length, replacementRows: 0, invalidRows: 0,
    unresolvedRows: 0, ambiguousTargetRows: 0, withheldResolvedRows: 0, importedRows: 0, curatedRows: 0 };
  for (const [index, row] of nicknameRecords.entries()) {
    if (row?.nk_type !== 0) {
      counts.replacementRows += 1;
      rejected.push({ index, reason: "not-a-single-card-alias", ...row });
      continue;
    }
    if (!cleanText(row.name) || !cleanText(row.nick_name)) {
      counts.invalidRows += 1;
      if (cleanText(row.nick_name)) invalidAliases.add(row.nick_name);
      rejected.push({ index, reason: "invalid-name-or-alias", ...row });
      continue;
    }
    const group = groups.get(row.nick_name) || [];
    group.push({ index, row, ids: [...(byName.get(row.name) || [])] });
    groups.set(row.nick_name, group);
  }

  const entriesByKey = new Map();
  const incompleteAliases = new Set(invalidAliases);
  for (const [alias, group] of groups) {
    const incomplete = invalidAliases.has(alias) || group.some(({ ids }) => ids.length !== 1);
    if (incomplete) incompleteAliases.add(alias);
    for (const { row, index, ids } of group) {
      if (ids.length === 0) {
        counts.unresolvedRows += 1;
        rejected.push({ index, reason: "target-name-not-found", ...row });
      } else if (ids.length > 1) {
        counts.ambiguousTargetRows += 1;
        rejected.push({ index, reason: "target-name-matches-multiple-cids", candidateCardIds: ids, ...row });
      } else if (incomplete) {
        counts.withheldResolvedRows += 1;
        rejected.push({ index, reason: "incomplete-alias-candidate-set", ...row });
      } else {
        const entry = { alias, cardId: ids[0], sourceId: nicknameSourceId };
        entriesByKey.set(keyFor(entry), entry);
        counts.importedRows += 1;
      }
    }
  }

  for (const row of curatedEntries) {
    assert(cleanText(row.alias) && cardIdText(row.cardId), "invalid curated alias");
    assert(sourceIds.has(row.sourceId), "unknown curated alias source");
    assert(!incompleteAliases.has(row.alias), `curated alias has unresolved source candidates: ${row.alias}`);
    const card = byId.get(row.cardId);
    assert(card && cleanText(row.jaName) && card.jaName === row.jaName, `curated identity Japanese name mismatch ${row.cardId}`);
    const entry = { alias: row.alias, cardId: row.cardId, sourceId: row.sourceId };
    entriesByKey.set(keyFor(entry), entry);
    counts.curatedRows += 1;
  }

  const entries = [...entriesByKey.values()].sort((a, b) => compare(a.alias, b.alias)
    || compare(a.cardId, b.cardId) || compare(a.sourceId, b.sourceId));
  const sortedSources = [...sources].sort((a, b) => compare(a.id, b.id));
  const data = { schemaVersion: 1, revision: nicknameRevision({ sources: sortedSources, entries }), sources: sortedSources, entries };
  validateCardNicknameData(data, cards);
  return { data, report: { counts, entryCount: entries.length, distinctAliasCount: new Set(entries.map((entry) => entry.alias)).size,
    distinctCardCount: new Set(entries.map((entry) => entry.cardId)).size, rejected } };
}
