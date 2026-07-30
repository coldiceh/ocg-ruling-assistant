import { performance } from "node:perf_hooks";

export const ADMIN_STAGE_SPEED_LABELS = Object.freeze({
  FAST: "FAST",
  NORMAL: "NORMAL",
  SLOW: "SLOW",
});

export const ADMIN_STAGE_STATUSES = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  SKIPPED: "SKIPPED",
  CANCELLED: "CANCELLED",
});

export const ADMIN_TRACKER_STATUSES = Object.freeze({
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
});

/**
 * The lab owns five stable top-level timing buckets. Individual workers may
 * add arbitrary substages beneath them without changing persisted shape.
 */
export const ADMIN_RUN_STAGE_CATALOG = Object.freeze([
  Object.freeze({ id: "understand", label: "理解问题" }),
  Object.freeze({ id: "extract_card_names", label: "提取卡名" }),
  Object.freeze({ id: "retrieve_card_texts", label: "检索卡文" }),
  Object.freeze({ id: "retrieve_rulings_evidence", label: "检索裁定/证据" }),
  Object.freeze({ id: "generate_ruling", label: "生成裁定" }),
]);

const DEFAULT_SPEED_THRESHOLDS = Object.freeze({
  fastBelowMs: 10_000,
  slowAtOrAboveMs: 30_000,
});

export function classifyAdminStageSpeed(durationMs, thresholds = DEFAULT_SPEED_THRESHOLDS) {
  const duration = finiteNonNegative(durationMs, "durationMs");
  const normalized = normalizeSpeedThresholds(thresholds);
  if (duration < normalized.fastBelowMs) return ADMIN_STAGE_SPEED_LABELS.FAST;
  if (duration >= normalized.slowAtOrAboveMs) return ADMIN_STAGE_SPEED_LABELS.SLOW;
  return ADMIN_STAGE_SPEED_LABELS.NORMAL;
}

export function createAdminStageTracker({
  runId,
  stageCatalog = ADMIN_RUN_STAGE_CATALOG,
  monotonicNow = () => performance.now(),
  wallNow = () => new Date(),
  speedThresholds = DEFAULT_SPEED_THRESHOLDS,
} = {}) {
  const normalizedRunId = requiredString(runId, "runId");
  const catalog = normalizeStageCatalog(stageCatalog);
  const thresholds = normalizeSpeedThresholds(speedThresholds);
  let lastTick = readMonotonic(monotonicNow);
  const originTick = lastTick;
  const createdAt = readWallTime(wallNow);
  let trackerStatus = ADMIN_TRACKER_STATUSES.RUNNING;
  let endedAt = null;
  let endOffsetMs = null;
  let cancellation = null;
  const stages = new Map(catalog.map((definition) => [
    definition.id,
    {
      ...definition,
      status: ADMIN_STAGE_STATUSES.PENDING,
      startedAt: null,
      endedAt: null,
      startOffsetMs: null,
      endOffsetMs: null,
      durationMs: null,
      speedLabel: null,
      skipReason: null,
      substages: new Map(),
    },
  ]));

  function tick() {
    const value = readMonotonic(monotonicNow);
    if (value < lastTick) throw new RangeError("monotonic clock regressed");
    lastTick = value;
    return value;
  }

  function requireRunningTracker() {
    if (trackerStatus !== ADMIN_TRACKER_STATUSES.RUNNING) {
      throw new Error(`stage tracker is ${trackerStatus.toLowerCase()}`);
    }
  }

  function requireStage(stageId) {
    const stage = stages.get(requiredString(stageId, "stageId"));
    if (!stage) throw new RangeError(`unknown admin stage: ${stageId}`);
    return stage;
  }

  function startStage(stageId) {
    requireRunningTracker();
    const stage = requireStage(stageId);
    if (stage.status !== ADMIN_STAGE_STATUSES.PENDING) {
      throw new Error(`stage ${stage.id} cannot start from ${stage.status}`);
    }
    const nowTick = tick();
    stage.status = ADMIN_STAGE_STATUSES.RUNNING;
    stage.startedAt = readWallTime(wallNow);
    stage.startOffsetMs = nowTick - originTick;
    return freezeClone(spanSnapshot(stage, nowTick, originTick, thresholds));
  }

  function finishStage(stageId) {
    requireRunningTracker();
    const stage = requireStage(stageId);
    if (stage.status !== ADMIN_STAGE_STATUSES.RUNNING) {
      throw new Error(`stage ${stage.id} cannot finish from ${stage.status}`);
    }
    if ([...stage.substages.values()].some((substage) => substage.status === ADMIN_STAGE_STATUSES.RUNNING)) {
      throw new Error(`stage ${stage.id} has active substages`);
    }
    const nowTick = tick();
    finishSpan(stage, nowTick, readWallTime(wallNow), ADMIN_STAGE_STATUSES.COMPLETED, originTick, thresholds);
    return freezeClone(spanSnapshot(stage, nowTick, originTick, thresholds));
  }

  function skipStage(stageId, { reason = "" } = {}) {
    requireRunningTracker();
    const stage = requireStage(stageId);
    if (stage.status !== ADMIN_STAGE_STATUSES.PENDING) {
      throw new Error(`stage ${stage.id} cannot be skipped from ${stage.status}`);
    }
    stage.status = ADMIN_STAGE_STATUSES.SKIPPED;
    stage.skipReason = String(reason || "");
    return freezeClone(spanSnapshot(stage, lastTick, originTick, thresholds));
  }

  function startSubstage(stageId, substageId, { label = "" } = {}) {
    requireRunningTracker();
    const stage = requireStage(stageId);
    if (stage.status !== ADMIN_STAGE_STATUSES.RUNNING) {
      throw new Error(`substage requires running parent stage ${stage.id}`);
    }
    const id = requiredString(substageId, "substageId");
    if (stage.substages.has(id)) throw new Error(`duplicate substage ${stage.id}/${id}`);
    const nowTick = tick();
    const substage = {
      id,
      label: String(label || id),
      status: ADMIN_STAGE_STATUSES.RUNNING,
      startedAt: readWallTime(wallNow),
      endedAt: null,
      startOffsetMs: nowTick - originTick,
      endOffsetMs: null,
      durationMs: null,
      speedLabel: null,
    };
    stage.substages.set(id, substage);
    return freezeClone(spanSnapshot(substage, nowTick, originTick, thresholds));
  }

  function finishSubstage(stageId, substageId) {
    requireRunningTracker();
    const stage = requireStage(stageId);
    const id = requiredString(substageId, "substageId");
    const substage = stage.substages.get(id);
    if (!substage) throw new RangeError(`unknown substage ${stage.id}/${id}`);
    if (substage.status !== ADMIN_STAGE_STATUSES.RUNNING) {
      throw new Error(`substage ${stage.id}/${id} cannot finish from ${substage.status}`);
    }
    const nowTick = tick();
    finishSpan(substage, nowTick, readWallTime(wallNow), ADMIN_STAGE_STATUSES.COMPLETED, originTick, thresholds);
    return freezeClone(spanSnapshot(substage, nowTick, originTick, thresholds));
  }

  function complete() {
    requireRunningTracker();
    const unfinished = [...stages.values()].filter((stage) => (
      ![ADMIN_STAGE_STATUSES.COMPLETED, ADMIN_STAGE_STATUSES.SKIPPED].includes(stage.status)
    ));
    if (unfinished.length) {
      throw new Error(`cannot complete tracker with unfinished stages: ${unfinished.map((stage) => stage.id).join(",")}`);
    }
    const nowTick = tick();
    trackerStatus = ADMIN_TRACKER_STATUSES.COMPLETED;
    endOffsetMs = nowTick - originTick;
    endedAt = readWallTime(wallNow);
    return snapshotAt(nowTick);
  }

  function cancel({ reason = "", requestedBy = "" } = {}) {
    if (trackerStatus === ADMIN_TRACKER_STATUSES.CANCELLED) return snapshotAt(lastTick);
    requireRunningTracker();
    const nowTick = tick();
    const wallTime = readWallTime(wallNow);
    for (const stage of stages.values()) {
      for (const substage of stage.substages.values()) {
        if (substage.status === ADMIN_STAGE_STATUSES.RUNNING) {
          finishSpan(substage, nowTick, wallTime, ADMIN_STAGE_STATUSES.CANCELLED, originTick, thresholds);
        }
      }
      if (stage.status === ADMIN_STAGE_STATUSES.RUNNING) {
        finishSpan(stage, nowTick, wallTime, ADMIN_STAGE_STATUSES.CANCELLED, originTick, thresholds);
      }
    }
    trackerStatus = ADMIN_TRACKER_STATUSES.CANCELLED;
    endOffsetMs = nowTick - originTick;
    endedAt = wallTime;
    cancellation = {
      reason: String(reason || ""),
      requestedBy: String(requestedBy || ""),
      cancelledAt: wallTime,
    };
    return snapshotAt(nowTick);
  }

  function snapshot() {
    const nowTick = trackerStatus === ADMIN_TRACKER_STATUSES.RUNNING ? tick() : originTick + endOffsetMs;
    return snapshotAt(nowTick);
  }

  function snapshotAt(nowTick) {
    const stageSnapshots = catalog.map(({ id }) => {
      const stage = stages.get(id);
      return {
        ...spanSnapshot(stage, nowTick, originTick, thresholds),
        skipReason: stage.skipReason,
        substages: [...stage.substages.values()].map((substage) => (
          spanSnapshot(substage, nowTick, originTick, thresholds)
        )),
      };
    });
    return freezeClone({
      schemaVersion: 1,
      runId: normalizedRunId,
      status: trackerStatus,
      createdAt,
      endedAt,
      totalElapsedMs: endOffsetMs ?? nowTick - originTick,
      speedThresholds: thresholds,
      cancellation,
      stages: stageSnapshots,
    });
  }

  return Object.freeze({
    runId: normalizedRunId,
    startStage,
    finishStage,
    skipStage,
    startSubstage,
    finishSubstage,
    complete,
    cancel,
    snapshot,
  });
}

function finishSpan(span, nowTick, wallTime, status, originTick, thresholds) {
  span.status = status;
  span.endedAt = wallTime;
  span.endOffsetMs = nowTick - originTick;
  span.durationMs = elapsedSinceOffset(nowTick, originTick, span.startOffsetMs);
  span.speedLabel = classifyAdminStageSpeed(span.durationMs, thresholds);
}

function spanSnapshot(span, nowTick, originTick, thresholds) {
  const activeDuration = span.status === ADMIN_STAGE_STATUSES.RUNNING
    ? elapsedSinceOffset(nowTick, originTick, span.startOffsetMs)
    : span.durationMs;
  return {
    id: span.id,
    label: span.label,
    status: span.status,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    startOffsetMs: span.startOffsetMs,
    endOffsetMs: span.endOffsetMs,
    durationMs: activeDuration,
    speedLabel: activeDuration === null ? null : classifyAdminStageSpeed(activeDuration, thresholds),
  };
}

function elapsedSinceOffset(nowTick, originTick, startOffsetMs) {
  // Subtracting the origin first avoids reconstructing an absolute start tick.
  // At large or fractional monotonic values, `origin + (start - origin)` may
  // round slightly above `start`, producing an impossible tiny negative span.
  const elapsed = (nowTick - originTick) - startOffsetMs;
  if (!Number.isFinite(elapsed)) {
    throw new RangeError("durationMs must be a finite non-negative number");
  }
  return Math.max(0, elapsed);
}

function normalizeStageCatalog(stageCatalog) {
  if (!Array.isArray(stageCatalog) || stageCatalog.length !== 5) {
    throw new TypeError("admin stage catalog must contain exactly five top-level stages");
  }
  const ids = new Set();
  return Object.freeze(stageCatalog.map((stage, index) => {
    const id = requiredString(typeof stage === "string" ? stage : stage?.id, `stageCatalog[${index}].id`);
    if (ids.has(id)) throw new TypeError(`duplicate admin stage id: ${id}`);
    ids.add(id);
    return Object.freeze({
      id,
      label: String(typeof stage === "string" ? stage : stage?.label || id),
    });
  }));
}

function normalizeSpeedThresholds(value = {}) {
  const fastBelowMs = finiteNonNegative(
    value.fastBelowMs ?? DEFAULT_SPEED_THRESHOLDS.fastBelowMs,
    "fastBelowMs",
  );
  const slowAtOrAboveMs = finiteNonNegative(
    value.slowAtOrAboveMs ?? DEFAULT_SPEED_THRESHOLDS.slowAtOrAboveMs,
    "slowAtOrAboveMs",
  );
  if (fastBelowMs > slowAtOrAboveMs) {
    throw new RangeError("fastBelowMs cannot exceed slowAtOrAboveMs");
  }
  return Object.freeze({ fastBelowMs, slowAtOrAboveMs });
}

function readMonotonic(clock) {
  const value = Number(clock());
  if (!Number.isFinite(value)) throw new TypeError("monotonic clock must return a finite number");
  return value;
}

function readWallTime(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("wall clock returned an invalid time");
  return date.toISOString();
}

function requiredString(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

function finiteNonNegative(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new RangeError(`${name} must be a finite non-negative number`);
  return number;
}

function freezeClone(value) {
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
