// Descriptions such as "the <archetype> field spell" name no card, so name
// search cannot supply the intended record. The extraction model reports the
// archetype's official English name and a card kind from a fixed list; this
// module only matches those two values against stored catalog fields. It never
// chooses a card: matches become proposals for the existing confirmation step,
// which reads the full card texts and may select one or none.

export const DESCRIBED_CARD_KINDS = Object.freeze({
  field_spell: { cardType: "spell", property: "field" },
  continuous_spell: { cardType: "spell", property: "continuous" },
  equip_spell: { cardType: "spell", property: "equip" },
  quick_play_spell: { cardType: "spell", property: "quickplay" },
  ritual_spell: { cardType: "spell", property: "ritual" },
  normal_spell: { cardType: "spell", property: "" },
  continuous_trap: { cardType: "trap", property: "continuous" },
  counter_trap: { cardType: "trap", property: "counter" },
  normal_trap: { cardType: "trap", property: "" },
  fusion_monster: { cardType: "monster", monsterProperty: "Fusion" },
  synchro_monster: { cardType: "monster", monsterProperty: "Synchro" },
  xyz_monster: { cardType: "monster", monsterProperty: "Xyz" },
  link_monster: { cardType: "monster", monsterProperty: "Link" },
  ritual_monster: { cardType: "monster", monsterProperty: "Ritual" },
  pendulum_monster: { cardType: "monster", monsterProperty: "Pendulum" },
  monster: { cardType: "monster" },
});

export const DESCRIBED_CARD_CANDIDATE_LIMIT = 6;

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export function normalizeDescribedCards(value) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(value) ? value : []) {
    const originalText = text(item?.originalText, 80);
    const archetypeEnName = text(item?.archetypeEnName, 60);
    const cardKind = text(item?.cardKind, 40).toLowerCase();
    if (!originalText || !archetypeEnName || !Object.hasOwn(DESCRIBED_CARD_KINDS, cardKind)) continue;
    const key = `${originalText}\u0000${archetypeEnName.toLowerCase()}\u0000${cardKind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ originalText, archetypeEnName, cardKind });
  }
  return result;
}

function kindMatches(card, kind) {
  const cardType = String(card.cardType || card.type || "").toLowerCase();
  if (cardType !== kind.cardType) return false;
  if (kind.property !== undefined && String(card.property || "").toLowerCase() !== kind.property) return false;
  if (kind.monsterProperty) {
    const properties = [...(card.monsterProperties || []), ...(card.properties || [])].map(String);
    if (!properties.includes(kind.monsterProperty)) return false;
  }
  return true;
}

function archetypePattern(archetypeEnName) {
  const words = archetypeEnName.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  if (!words.length) return null;
  // Whole words in order, separated by any non-alphanumeric run.
  return new RegExp(`(^|[^a-z0-9])${words.join("[^a-z0-9]+")}($|[^a-z0-9])`, "u");
}

// Returns stable catalog ids, or [] when nothing or more than the limit
// matches; a broad description is left for the player to clarify.
export function findDescribedCardCandidates(cards = [], item = {}, { limit = DESCRIBED_CARD_CANDIDATE_LIMIT } = {}) {
  const kind = DESCRIBED_CARD_KINDS[item.cardKind];
  const pattern = kind ? archetypePattern(String(item.archetypeEnName || "")) : null;
  if (!pattern) return [];
  const ids = [];
  for (const card of cards || []) {
    const enName = String(card.enName || "").toLowerCase();
    if (!enName || !pattern.test(enName) || !kindMatches(card, kind)) continue;
    const id = String(card.cid || card.id || card.cardId || "");
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length > limit) return [];
  }
  return ids;
}
