import { buildQaIndex } from "../../backend/dataIndex.mjs";
import { stableJson } from "./evidence-preprocess-cache.mjs";
const persisted = value => JSON.parse(JSON.stringify(value));
const content = value => { const { updatedAt, ...rest } = persisted(value); return stableJson(rest); };

/** Only callers owning a fetch-time updatedAt may use this; source-authored dates stay untouched. */
export function preserveFetchTimestamp(current, previous) {
  if (previous && previous.id === current.id && previous.recordType === current.recordType
      && typeof previous.updatedAt === "string" && content(current) === content(previous)) return previous;
  return current;
}

/** Retain previously captured full QA while the rolling detail fetch visits other IDs.
 * The complete schema-owned index projection must match byte-for-byte after JSON serialization.
 * Fresh full records always win; missing/removed index IDs never return from history.
 */
export function stableQaSelection(indexRecords, rulingRecords, previousRecords = [], cards = []) {
  const old = new Map(previousRecords.map(r => [r.id, r]));
  const eligible = previousRecords.filter(r => r.recordType === "qa" && /^ygoresources-qa-\d+$/u.test(r.id));
  const projections = new Map(buildQaIndex(eligible, cards).map(r => [r.id, persisted(r)]));
  const byId = new Map();
  for (const record of indexRecords) {
    if (!["qa", "card-faq"].includes(String(record?.recordType || ""))) continue;
    const id = String(record?.id || "").trim();
    if (!id || byId.has(id)) throw new Error("gemini_rule_qa_qa_index_identity_invalid");
    const prior = old.get(id), projection = projections.get(id);
    byId.set(id, projection && stableJson(projection) === stableJson(persisted(record)) ? prior : record);
  }
  const seen = new Set();
  for (const record of rulingRecords) {
    if (!["qa", "card-faq"].includes(String(record?.recordType || ""))) continue;
    const id = String(record?.id || "").trim();
    if (!id) throw new Error("gemini_rule_qa_rulings_identity_invalid");
    if (seen.has(id)) continue;
    seen.add(id);
    byId.set(id, record.recordType === "qa" && /^ygoresources-qa-\d+$/u.test(id)
      ? preserveFetchTimestamp(record, old.get(id)) : record);
  }
  return [...byId.values()];
}
