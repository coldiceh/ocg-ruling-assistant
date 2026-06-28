import { createHash } from "node:crypto";

const allowedStatuses = new Set(["current", "superseded", "removed", "parse_failed", "conflict"]);

export function evidenceTextHash(record = {}) {
  return createHash("sha256").update(canonicalEvidenceText(record)).digest("hex");
}

export function stableEvidenceId(record = {}) {
  return String(record.stableId || record.id || record.evidenceId || "").trim();
}

export function normalizeEvidenceRecord(record = {}, options = {}) {
  const stableId = stableEvidenceId(record);
  const textHash = record.textHash || evidenceTextHash(record);
  const now = options.now || new Date().toISOString();
  const status = allowedStatuses.has(record.status) ? record.status : "current";
  return {
    evidenceId: String(record.evidenceId || `${stableId}@${textHash.slice(0, 12)}`),
    stableId,
    recordType: normalizeRecordType(record.recordType),
    sourceId: String(record.sourceId || inferSourceId(record)),
    sourceTier: String(record.sourceTier || inferSourceTier(record)),
    status,
    cardIds: unique(record.cardIds || (record.cardId ? [record.cardId] : [])),
    cardNames: unique(record.cardNames || record.cards || []),
    question: String(record.question || ""),
    answer: String(record.answer || record.conclusion || ""),
    text: String(record.text || [record.question, record.conclusion || record.answer].filter(Boolean).join("\n")),
    keywords: unique(record.keywords || []),
    ruleTags: unique(record.ruleTags || []),
    sourceUrl: String(record.sourceUrl || record.sources?.[0]?.detail || ""),
    sourceRevision: String(record.sourceRevision || options.sourceRevision || ""),
    textHash,
    firstSeenAt: record.firstSeenAt || now,
    lastSeenAt: record.lastSeenAt || now,
    fetchedAt: record.fetchedAt || options.fetchedAt || now,
  };
}

export function diffRulingSnapshot({ previousEvidence = [], currentEvidence = [], sourceRevision = "", now = new Date().toISOString(), syncSucceeded = true } = {}) {
  const previous = previousEvidence.map((item) => normalizeEvidenceRecord(item, { now }));
  if (!syncSucceeded) {
    return {
      records: previous,
      report: emptyReport({ generatedAt: now, sourceRevision, sourceFreshness: "stale" }),
    };
  }

  const previousCurrent = new Map(previous.filter((item) => item.status === "current").map((item) => [item.stableId, item]));
  const history = previous.filter((item) => item.status !== "current").map((item) => ({ ...item }));
  const incomingByStable = new Map();
  for (const raw of currentEvidence) {
    const item = normalizeEvidenceRecord(raw, { now, sourceRevision, fetchedAt: now });
    if (!item.stableId) continue;
    const values = incomingByStable.get(item.stableId) || [];
    values.push(item);
    incomingByStable.set(item.stableId, values);
  }

  const records = [...history];
  let newItems = 0;
  let changedItems = 0;
  let removedItems = 0;
  let unchangedItems = 0;
  let conflictCount = 0;

  for (const [stableId, incoming] of incomingByStable) {
    const hashes = new Set(incoming.map((item) => item.textHash));
    if (hashes.size > 1) {
      conflictCount += 1;
      records.push(...incoming.map((item) => ({ ...item, status: "conflict" })));
      const old = previousCurrent.get(stableId);
      if (old) records.push({ ...old, status: "superseded", lastSeenAt: now });
      continue;
    }
    const next = incoming[0];
    const old = previousCurrent.get(stableId);
    if (!old) {
      newItems += 1;
      records.push(next);
    } else if (old.textHash === next.textHash) {
      unchangedItems += 1;
      records.push({ ...old, ...next, evidenceId: old.evidenceId, firstSeenAt: old.firstSeenAt, status: "current", lastSeenAt: now });
    } else {
      changedItems += 1;
      records.push({ ...old, status: "superseded", lastSeenAt: now });
      records.push(next);
    }
    previousCurrent.delete(stableId);
  }

  for (const old of previousCurrent.values()) {
    removedItems += 1;
    records.push({ ...old, status: "removed", lastSeenAt: now });
  }

  return {
    records: dedupeVersions(records),
    report: {
      generatedAt: now,
      sourceRevision,
      sourceFreshness: conflictCount ? "conflict" : "fresh",
      newItems,
      changedItems,
      removedItems,
      unchangedItems,
      conflictCount,
      totalVersions: records.length,
      currentItems: records.filter((item) => item.status === "current").length,
    },
  };
}

export function canonicalEvidenceText(record = {}) {
  return [record.recordType, record.question, record.answer || record.conclusion, record.text]
    .map((value) => String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeRecordType(value) {
  const type = String(value || "");
  if (["qa", "card-faq", "card-text", "rule-doc"].includes(type)) return type;
  return type === "official-database" ? "qa" : "rule-doc";
}

function inferSourceId(record) {
  return record.recordType === "rule-doc" ? "ocg-rule" : "ygoresources";
}

function inferSourceTier(record) {
  if (record.recordType === "qa" || record.recordType === "card-faq") return "S0_OFFICIAL_DB_MIRROR";
  if (record.recordType === "card-text") return "S1_CARD_TEXT";
  if (record.recordType === "rule-doc") return "S2_RULE_DOC";
  return "S4_MODEL";
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

function dedupeVersions(records) {
  const map = new Map();
  for (const item of records) map.set(item.evidenceId, item);
  return [...map.values()].sort((a, b) => a.stableId.localeCompare(b.stableId) || a.firstSeenAt.localeCompare(b.firstSeenAt));
}

function emptyReport(overrides) {
  return { newItems: 0, changedItems: 0, removedItems: 0, unchangedItems: 0, conflictCount: 0, totalVersions: 0, currentItems: 0, ...overrides };
}
