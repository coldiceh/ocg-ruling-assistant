// CID -> passcode map for the engine reproduction (data/engine-repro/cid-passcode-map.json).
//
// Sources: ygocdb (Baige, keyed by cid -> id) and yaml-yugi (konami_id -> password). Both agree, or only
// one has the card: that passcode; they disagree: the one of the two in the engine's pool, else unmapped
// (conflict). A passcode of 0 means the source knows the card but it has none (prize and promotional
// cards): unmapped (not_in_cdb, passcode 0).
//
// Checked against the engine's card pool: a passcode in the pool is mapped as is. The engine itself
// reports a twin for an official card MyCard has no script for yet, and the reproduction runs the twin.
// A passcode not in the pool (MyCard has the card only under its pre-release code, or only under the
// official code after converting it) is matched by the card's exact ygocdb name (NAME_FIELDS, in order)
// against the pool's cards other than alternative artworks: one official card, else one pre-release
// card, else unmapped (not_in_cdb). A name match also needs the same card type and, for a monster, the
// same ATK, DEF, level, type (race) and attribute in ygocdb's data and the pool.

export const PRERELEASE_MIN_CODE = 100_000_000;
const ARTWORK_OFFSET = 20;   // ygopro-core CARD_ARTWORK_VERSIONS_OFFSET
// ygocdb's Chinese name, then the NW forum translation (MyCard's pre-release cards use it before release)
export const NAME_FIELDS = Object.freeze(["cn_name", "nwbbs_n"]);

function positive(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function sameStats(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (!(a.type & 0x1)) return true;
  return a.atk === b.atk && a.def === b.def && (a.level & 0xff) === (b.level & 0xff) && a.race === b.race
    && a.attribute === b.attribute;
}

/**
 * @param cids         CIDs of the ruling assistant's cards (strings or numbers; non-positive ones are skipped)
 * @param ygocdb       ygocdb cards.json object: { key: { cid, id, cn_name, ... } }
 * @param yamlYugi     yaml-yugi cards.json array: [{ konami_id, password, ... }]
 * @param engineCards  Map code -> { name, alias, data: { type, atk, def, level, race, attribute } } of the engine's pool
 */
export function buildCidPasscodeMap({ cids, ygocdb, yamlYugi, engineCards }) {
  const byCid = new Map();
  for (const card of Object.values(ygocdb || {})) {
    if (positive(card?.cid) && !byCid.has(String(card.cid))) byCid.set(String(card.cid), card);
  }
  const byKonami = new Map();
  for (const card of yamlYugi || []) {
    if (positive(card?.konami_id) && !byKonami.has(String(card.konami_id))) byKonami.set(String(card.konami_id), card);
  }
  const byName = new Map();
  for (const [code, card] of engineCards) {
    // alternative artworks share the name; a card "always treated as" another one has its own
    const alternative = card.alias && card.alias < code + ARTWORK_OFFSET && code < card.alias + ARTWORK_OFFSET;
    if (alternative || typeof card.name !== "string" || !card.name) continue;
    const list = byName.get(card.name) || [];
    list.push(code);
    byName.set(card.name, list);
  }
  const counts = { ruling_assistant_cids: 0, mapped: 0, both: 0, ygocdb_only: 0, yaml_yugi_only: 0, no_source: 0,
    conflict: 0, not_in_cdb: 0, by_name: 0 };
  const unmapped = { no_source: [], conflict: [], not_in_cdb: [] };
  const byNameMapped = [];
  const map = {};
  const sorted = [...new Set([...cids].map(Number).filter((cid) => Number.isSafeInteger(cid) && cid > 0))].sort((a, b) => a - b);
  for (const cid of sorted) {
    counts.ruling_assistant_cids += 1;
    const y = byCid.get(String(cid));
    const k = byKonami.get(String(cid));
    if (!y && !k) {
      unmapped.no_source.push(cid);
      continue;
    }
    const py = y ? positive(y.id) : 0;
    const pk = k ? positive(k.password) : 0;
    let passcode = py || pk;
    if (py && pk && py !== pk) {
      // e.g. yaml-yugi gives an artwork passcode the pool does not have: the one passcode in the pool
      const inPool = [py, pk].filter((code) => engineCards.has(code));
      if (inPool.length !== 1) {
        unmapped.conflict.push([cid, py, pk]);
        continue;
      }
      passcode = inPool[0];
    }
    const source = py && pk ? "both" : py ? "ygocdb_only" : "yaml_yugi_only";
    let code = passcode && engineCards.has(passcode) ? passcode : 0;
    if (passcode && !code) {
      for (const field of NAME_FIELDS) {
        const hits = typeof y?.[field] === "string" ? byName.get(y[field]) || [] : [];
        const official = hits.filter((c) => c < PRERELEASE_MIN_CODE);
        const prerelease = hits.filter((c) => c >= PRERELEASE_MIN_CODE);
        code = official.length === 1 ? official[0] : !official.length && prerelease.length === 1 ? prerelease[0] : 0;
        if (code && !sameStats(y.data, engineCards.get(code).data)) code = 0;
        if (code) {
          byNameMapped.push([cid, passcode, code, field]);
          counts.by_name += 1;
          break;
        }
      }
    }
    if (!code) {
      unmapped.not_in_cdb.push([cid, passcode]);
      continue;
    }
    map[String(cid)] = code;
    counts.mapped += 1;
    counts[source] += 1;
  }
  counts.no_source = unmapped.no_source.length;
  counts.conflict = unmapped.conflict.length;
  counts.not_in_cdb = unmapped.not_in_cdb.length;
  return { counts, unmapped, by_name: byNameMapped, map };
}
