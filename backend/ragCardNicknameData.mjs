import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

let cachedData;
let cachedInfo;

// A small independently versioned vocabulary, not a modification of card text
// or ruling evidence. Load failure is explicit so a broken deployment cannot
// silently disable the reviewed identity mappings.
export function loadCardNicknameData() {
  if (cachedData) return cachedData;
  const bytes = readFileSync(new URL('../data/card-nicknames.v1.json', import.meta.url));
  const data = JSON.parse(bytes.toString('utf8'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.entries) || !Array.isArray(data.sources)
      || typeof data.revision !== 'string' || !data.revision) {
    throw new Error('Invalid card nickname vocabulary');
  }
  const sources = new Set(data.sources.map(source => source.id));
  if (sources.size !== data.sources.length || data.sources.some(source => !source.id || !/^https:\/\//u.test(source.url || ''))
      || data.entries.some(entry => typeof entry.alias !== 'string' || !entry.alias.trim()
        || !/^[1-9]\d*$/u.test(entry.cardId) || !sources.has(entry.sourceId))) {
    throw new Error('Invalid card nickname source binding');
  }
  const revision = 'sha256:' + createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, sources: data.sources, entries: data.entries })).digest('hex');
  if (revision !== data.revision) throw new Error('Card nickname vocabulary revision mismatch');
  cachedData = data;
  cachedInfo = Object.freeze({ revision: data.revision, entries: data.entries.length,
    aliases: new Set(data.entries.map(entry => entry.alias)).size,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  return cachedData;
}

export function getCardNicknameDataInfo() {
  loadCardNicknameData();
  return cachedInfo;
}
