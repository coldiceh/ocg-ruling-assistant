const canonicalSnapshots = new WeakSet();
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
  return data;
}

export function isCanonicalNormalizedRagData(data) {
  return Boolean(data && typeof data === "object" && canonicalSnapshots.has(data));
}

export function isCanonicalNormalizedRagArray(value, role) {
  const registry = canonicalArraysByRole[role];
  return Boolean(registry && Array.isArray(value) && registry.has(value));
}
