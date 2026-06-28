const dayMs = 24 * 60 * 60 * 1000;

export function evaluateEvidenceFreshness({ snapshotMeta = {}, evidenceList = [], now = new Date() } = {}) {
  const warnings = [];
  const mustMention = [];
  const conflictIds = (evidenceList || []).filter((item) => item.status === "conflict" || item.evidenceStatus === "conflict").map((item) => item.id || item.evidenceId);
  if (conflictIds.length) {
    return { freshness: "conflict", safetyPenalty: 2, warnings: ["命中的当前资料存在冲突，不能确认。"], mustMention: ["当前资料存在冲突。"], conflictEvidenceIds: conflictIds };
  }

  const explicit = snapshotMeta.sourceFreshness;
  const lastSuccess = parseDate(snapshotMeta.lastSuccessfulSyncAt || snapshotMeta.generatedAt);
  if ((snapshotMeta.syncFailureCount > 0 || explicit === "unknown") && !lastSuccess) {
    return { freshness: "unknown", safetyPenalty: 2, warnings: ["无法确认数据源最近一次成功同步时间。"], mustMention: ["当前数据新鲜度未知。"], conflictEvidenceIds: [] };
  }
  if (!lastSuccess) {
    return { freshness: "unknown", safetyPenalty: 2, warnings: ["数据快照缺少成功同步时间。"], mustMention: ["当前数据新鲜度未知。"], conflictEvidenceIds: [] };
  }

  const ageDays = Math.max(0, (new Date(now).getTime() - lastSuccess.getTime()) / dayMs);
  let freshness = "fresh";
  let safetyPenalty = 0;
  if (explicit === "stale" || ageDays > 2) {
    freshness = "stale";
    safetyPenalty = 1;
    warnings.push("数据库快照不是刚刚同步的最新状态。对变更频繁的裁定请再次核对官方数据库。");
    mustMention.push("资料同步时间可能落后于当前官方数据库。 ");
  }
  if (ageDays > 7) safetyPenalty = Math.max(safetyPenalty, 1);
  if (explicit === "unknown") { freshness = "unknown"; safetyPenalty = Math.max(safetyPenalty, 2); }
  return { freshness, safetyPenalty, warnings, mustMention, ageDays, conflictEvidenceIds: [] };
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}
