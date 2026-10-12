import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {join} from 'node:path';
import {ruleSystemDataDir, normalizeRuleSystem} from './rulingRuleSystem.mjs';

const cache = new Map();

// A small independently versioned vocabulary, not a modification of card text
// or ruling evidence. Load failure is explicit so a broken deployment cannot
// silently disable the reviewed identity mappings.
export function loadCardNicknameData(ruleSystem = 'OCG', env = {}) {
  const path = normalizeRuleSystem(ruleSystem) === 'TCG'
    ? join(ruleSystemDataDir(ruleSystem, env), 'card-nicknames.v1.json')
    : new URL('../data/card-nicknames.v1.json', import.meta.url);
  const key = String(path);
  if (cache.has(key)) return cache.get(key).data;
  const bytes = readFileSync(path);
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
  const info = Object.freeze({ revision: data.revision, entries: data.entries.length,
    aliases: new Set(data.entries.map(entry => entry.alias)).size,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  cache.set(key, {data, info});
  return data;
}

export function getCardNicknameDataInfo(ruleSystem = 'OCG', env = {}) {
  const data = loadCardNicknameData(ruleSystem, env);
  return [...cache.values()].find(entry => entry.data === data).info;
}
