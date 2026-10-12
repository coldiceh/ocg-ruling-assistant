import {loadPreparedRagCardRuntimeBundle} from './ragRuntimeBundle.mjs';
import {ruleSystemDataDir} from './rulingRuleSystem.mjs';
import {loadCardNicknameData} from './ragCardNicknameData.mjs';

const snapshots = new Map();
const key = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en');

// CID is the official database identity. It is never an image/engine passcode.
// Name matching offers catalog identities only; it makes no ruling judgment.
export async function searchTcgCards(query, {env = {}, limit = 8, signal} = {}) {
  signal?.throwIfAborted();
  const dir = ruleSystemDataDir('TCG', env);
  let pending = snapshots.get(dir);
  const cacheHit = Boolean(pending);
  if (!pending) {
    pending = loadPreparedRagCardRuntimeBundle({dataDir:dir}).then(bundle => {
      if (!bundle.ok) throw new Error(`tcg_card_runtime_unavailable:${bundle.reason}`);
      if (bundle.data.cards.some(card => card.ruleSystem !== 'TCG')) throw new Error('tcg_card_snapshot_invalid');
      return bundle.data.cards;
    });
    snapshots.set(dir, pending);
    pending.catch(() => { if (snapshots.get(dir) === pending) snapshots.delete(dir); });
  }
  const cards = await pending;
  signal?.throwIfAborted();
  const normalized = key(query);
  const vocabulary = loadCardNicknameData('TCG', env);
  const aliases = new Set(vocabulary.entries.filter(entry => key(entry.alias) === normalized).map(entry => entry.cardId));
  const exact = cards.filter(card => key(card.enName || card.name) === normalized
    || String(card.cid) === String(query).trim() || aliases.has(String(card.id)));
  const candidates = exact.length ? exact : cards.filter(card => normalized && key(card.enName || card.name).includes(normalized));
  return {provider:'konami-tcg', ruleSystem:'TCG', query:String(query || ''), cacheHit, warnings:[],
    results:candidates.slice(0, limit).map((card, index) => ({...card, provider:'konami-tcg',
      confidence:exact.length ? 1 : 0, confidenceSource:exact.length ? 'catalog_exact_identity' : 'catalog_name_candidate',
      providerRank:index + 1, providerResultCount:candidates.length}))};
}
