const blockedStatuses = new Set(["superseded", "removed", "parse_failed", "conflict"]);
const nonOfficialTiers = new Set(["S3_EXPERT", "S4_MODEL"]);

export function filterCurrentEvidence(evidenceList = [], { evidenceIndex = [], sourceFreshness = "fresh", detectConflicts = true } = {}) {
  const indexCurrent = newestCurrentByStableId(evidenceIndex);
  const currentEvidence = [];
  const blockedEvidence = [];
  for (const raw of evidenceList || []) {
    const stableId = String(raw.stableId || raw.id || "");
    const indexed = indexCurrent.get(stableId);
    const status = indexed?.status || raw.evidenceStatus || normalizeLegacyStatus(raw.status);
    const enriched = {
      ...raw,
      stableId,
      evidenceId: indexed?.evidenceId || raw.evidenceId || stableId,
      evidenceStatus: status,
      sourceTier: indexed?.sourceTier || raw.sourceTier || inferTier(raw),
      sourceRevision: indexed?.sourceRevision || raw.sourceRevision || "",
      textHash: indexed?.textHash || raw.textHash || "",
    };
    if (status !== "current" || blockedStatuses.has(status)) blockedEvidence.push(enriched);
    else currentEvidence.push(enriched);
  }

  const conflicts = detectConflicts ? detectCurrentVerdictConflicts(currentEvidence) : [];
  const conflictIds = new Set(conflicts.flatMap((item) => item.evidenceIds));
  const usableEvidence = currentEvidence.filter((item) => !conflictIds.has(String(item.id || item.evidenceId)));
  const directEligibleEvidence = usableEvidence.filter((item) => !nonOfficialTiers.has(item.sourceTier));
  return { currentEvidence: usableEvidence, directEligibleEvidence, blockedEvidence, conflicts, sourceFreshness };
}

export function canEvidenceSupportOfficial(record, sourceFreshness = "fresh") {
  return record?.evidenceStatus === "current"
    && !nonOfficialTiers.has(record?.sourceTier)
    && sourceFreshness === "fresh";
}

export function detectCurrentVerdictConflicts(records = []) {
  const groups = new Map();
  for (const item of records) {
    const polarity = detectPolarity(item);
    if (!polarity) continue;
    const key = questionKey(item);
    const values = groups.get(key) || [];
    values.push({ item, polarity });
    groups.set(key, values);
  }
  const result = [];
  for (const [question, values] of groups) {
    if (new Set(values.map((value) => value.polarity)).size < 2) continue;
    result.push({ question, evidenceIds: values.map(({ item }) => String(item.id || item.evidenceId)), verdicts: [...new Set(values.map((value) => value.polarity))] });
  }
  return result;
}

function newestCurrentByStableId(index) {
  const map = new Map();
  for (const item of index || []) {
    if (item.status !== "current") continue;
    const old = map.get(item.stableId);
    if (!old || String(item.lastSeenAt || item.fetchedAt || "") > String(old.lastSeenAt || old.fetchedAt || "")) map.set(item.stableId, item);
  }
  return map;
}

function normalizeLegacyStatus(status) {
  if (blockedStatuses.has(status)) return status;
  return "current";
}

function inferTier(item) {
  if (["qa", "card-faq", "official-database"].includes(item.recordType)) return "S0_OFFICIAL_DB_MIRROR";
  if (item.recordType === "card-text") return "S1_CARD_TEXT";
  if (item.recordType === "rule-doc") return "S2_RULE_DOC";
  return "S3_EXPERT";
}

function detectPolarity(item) {
  const text = `${item.verdict || ""} ${item.answer || ""} ${item.conclusion || ""} ${item.text || ""}`;
  if (/不能|不可以|できません|cannot|does not/iu.test(text)) return "negative";
  if (/可以|できます|can be|yes/iu.test(text)) return "positive";
  return "";
}

function questionKey(item) {
  return `${(item.cardIds || []).map(String).sort().join(",")}:${String(item.question || item.title || "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim()}`;
}
