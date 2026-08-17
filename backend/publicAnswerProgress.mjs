export const PUBLIC_ANSWER_PROGRESS_STAGES = Object.freeze([
  Object.freeze({ id: "understand", label: "理解问题" }),
  Object.freeze({ id: "extract_card_names", label: "提取卡名" }),
  Object.freeze({ id: "retrieve_card_texts", label: "检索卡片文本" }),
  Object.freeze({ id: "retrieve_rulings", label: "检索规则资料" }),
  Object.freeze({ id: "generate_ruling", label: "核对资料并生成裁定" }),
]);

const STAGE_INDEX = new Map(PUBLIC_ANSWER_PROGRESS_STAGES.map((stage, index) => [stage.id, index]));

export function createPublicAnswerProgress({
  emit = () => {},
  now = defaultMonotonicNow,
} = {}) {
  const startedAt = now();
  const stageDurationsMs = {};
  let activeStageId = "";
  let activeStageStartedAtMs = 0;
  let lastStageIndex = -1;
  let finished = false;

  function elapsedMs() {
    return Math.max(0, Math.floor(now() - startedAt));
  }

  function safeEmit(type, payload) {
    try {
      emit(type, payload);
    } catch {
      // Progress reporting is observational and must never change an answer.
    }
  }

  function endActiveStage(serverElapsedMs, status = "completed") {
    if (!activeStageId) return;
    const durationMs = Math.max(0, serverElapsedMs - activeStageStartedAtMs);
    stageDurationsMs[activeStageId] = durationMs;
    safeEmit("stage_end", {
      stageId: activeStageId,
      serverElapsedMs,
      durationMs,
      status,
    });
  }

  function transition(stageId) {
    if (finished || !STAGE_INDEX.has(stageId)) return false;
    const nextIndex = STAGE_INDEX.get(stageId);
    if (nextIndex < lastStageIndex || activeStageId === stageId) return false;
    const serverElapsedMs = elapsedMs();
    endActiveStage(serverElapsedMs);
    activeStageId = stageId;
    activeStageStartedAtMs = serverElapsedMs;
    lastStageIndex = nextIndex;
    safeEmit("stage_start", { stageId, serverElapsedMs });
    return true;
  }

  function tick() {
    if (finished || !activeStageId) return null;
    const serverElapsedMs = elapsedMs();
    const payload = {
      stageId: activeStageId,
      serverElapsedMs,
      activeStageElapsedMs: Math.max(0, serverElapsedMs - activeStageStartedAtMs),
    };
    safeEmit("tick", payload);
    return payload;
  }

  function finish(status) {
    if (finished) return snapshot();
    const totalMs = elapsedMs();
    endActiveStage(totalMs, status);
    finished = true;
    activeStageId = "";
    return snapshot(totalMs, status);
  }

  function snapshot(totalMs = elapsedMs(), status = finished ? "completed" : "running") {
    return {
      status,
      totalMs,
      stageDurationsMs: { ...stageDurationsMs },
    };
  }

  return {
    start: () => transition(PUBLIC_ANSWER_PROGRESS_STAGES[0].id),
    transition,
    tick,
    complete: () => finish("completed"),
    fail: () => finish("failed"),
    snapshot,
    get activeStageId() {
      return activeStageId;
    },
  };
}

export function wantsPublicAnswerProgress(request, channel) {
  if (channel !== "web") return false;
  const accept = readHeader(request?.headers, "accept").toLowerCase();
  if (!accept.includes("text/event-stream")) return false;
  try {
    const url = new URL(String(request?.url || "/api/answer"), "http://localhost");
    return url.searchParams.get("progress") === "1";
  } catch {
    return false;
  }
}

export function beginPublicAnswerEventStream(response) {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders?.();
}

export function sendPublicAnswerEvent(response, type, payload = {}) {
  if (response?.writableEnded || response?.destroyed) return false;
  response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  response.flush?.();
  return true;
}

function readHeader(headers, name) {
  if (typeof headers?.get === "function") return String(headers.get(name) || "");
  const value = headers?.[name] ?? headers?.[name.toLowerCase()] ?? headers?.[name.toUpperCase()];
  return String(Array.isArray(value) ? value[0] : value || "");
}

function defaultMonotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}
