const canonicalSnapshots = new WeakSet();
const canonicalSnapshotsByArrays = new WeakMap();
const canonicalArraysByRole = Object.freeze({
  cards: new WeakSet(),
  records: new WeakSet(),
  qaRecords: new WeakSet(),
});

/**
 * Register arrays whose values and ordering already follow the production RAG
 * normalizer contract. This is an in-memory provenance marker, not a structural
 * heuristic: callers must have either just normalized the values themselves or
 * validated the complete serialized bundle before registering it.
 */
export function registerCanonicalNormalizedRagData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("canonical normalized RAG data must be an object");
  }
  for (const role of Object.keys(canonicalArraysByRole)) {
    if (!Array.isArray(data[role])) {
      throw new TypeError(`canonical normalized RAG data.${role} must be an array`);
    }
  }
  canonicalSnapshots.add(data);
  for (const [role, registry] of Object.entries(canonicalArraysByRole)) {
    registry.add(data[role]);
  }
  let byCards = canonicalSnapshotsByArrays.get(data.records);
  if (!byCards) {
    byCards = new WeakMap();
    canonicalSnapshotsByArrays.set(data.records, byCards);
  }
  let byQaRecords = byCards.get(data.cards);
  if (!byQaRecords) {
    byQaRecords = new WeakMap();
    byCards.set(data.cards, byQaRecords);
  }
  byQaRecords.set(data.qaRecords, data);
  return data;
}

export function isCanonicalNormalizedRagData(data) {
  return Boolean(data && typeof data === "object" && canonicalSnapshots.has(data));
}

export function isCanonicalNormalizedRagArray(value, role) {
  const registry = canonicalArraysByRole[role];
  return Boolean(registry && Array.isArray(value) && registry.has(value));
}

export function getRegisteredCanonicalNormalizedRagData({ cards, records, qaRecords } = {}) {
  if (!Array.isArray(cards) || !Array.isArray(records) || !Array.isArray(qaRecords)) return null;
  return canonicalSnapshotsByArrays.get(records)?.get(cards)?.get(qaRecords) || null;
}
