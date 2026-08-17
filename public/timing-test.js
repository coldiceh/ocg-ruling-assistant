export const TIMING_TEST_API_PATH = "/api/answer";
export const DEFAULT_MODEL_PROFILE = "relay-gpt-5.6-sol-low";
export const TIMING_STAGES = Object.freeze([
  Object.freeze({ id: "understand", label: "理解问题" }),
  Object.freeze({ id: "extract_card_names", label: "提取卡名" }),
  Object.freeze({ id: "retrieve_card_texts", label: "检索卡片文本" }),
  Object.freeze({ id: "retrieve_rulings", label: "检索规则资料" }),
  Object.freeze({ id: "generate_ruling", label: "核对资料并生成裁定" }),
]);

const KNOWN_EVENT_TYPES = new Set([
  "stage_start",
  "stage_end",
  "tick",
  "answer",
  "error",
  "end",
]);

export function buildTimingRequestBody(question, modelProfile = DEFAULT_MODEL_PROFILE) {
  return {
    mode: "rag",
    question: String(question || "").trim(),
    rulingModelProfile: String(modelProfile || DEFAULT_MODEL_PROFILE).trim(),
    rulingVersion: "latest",
  };
}

export function buildTimingProgressUrl(locationLike = globalThis.location) {
  const url = new URL(TIMING_TEST_API_PATH, locationLike?.origin || "http://localhost");
  url.searchParams.set("progress", "1");
  return url.toString();
}

export function parseTimingSseBlock(block) {
  const lines = String(block || "").split(/\r?\n/u);
  let type = "message";
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") type = value;
    if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length || !KNOWN_EVENT_TYPES.has(type)) {
    throw timingProtocolError("timing_sse_event_invalid");
  }
  let data;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    throw timingProtocolError("timing_sse_json_invalid");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw timingProtocolError("timing_sse_payload_invalid");
  }
  return { type, data };
}

export function createTimingProtocolState() {
  return {
    stages: TIMING_STAGES.map((stage) => ({
      ...stage,
      status: "waiting",
      startedAtMs: null,
      activeElapsedMs: null,
      durationMs: null,
    })),
    activeStageId: "",
    lastStageIndex: -1,
    lastServerElapsedMs: null,
    backendTotalMs: null,
    answer: null,
    remoteError: null,
    ended: false,
  };
}

export function applyTimingProtocolEvent(state, event) {
  if (!state || state.ended) throw timingProtocolError("timing_sse_event_after_end");
  const type = String(event?.type || "");
  const data = event?.data;
  if (!KNOWN_EVENT_TYPES.has(type) || !data || typeof data !== "object" || Array.isArray(data)) {
    throw timingProtocolError("timing_sse_event_invalid");
  }
  if ((state.answer || state.remoteError) && type !== "end") {
    throw timingProtocolError("timing_sse_event_after_result");
  }

  const serverElapsedMs = finiteDuration(data.serverElapsedMs);
  recordServerElapsed(state, serverElapsedMs);

  if (type === "answer") {
    if (state.answer || state.remoteError) throw timingProtocolError("timing_sse_answer_duplicate");
    if (state.activeStageId) throw timingProtocolError("timing_sse_answer_during_stage");
    if (!data.answer || typeof data.answer !== "object" || Array.isArray(data.answer)) {
      throw timingProtocolError("timing_sse_answer_invalid");
    }
    state.answer = data.answer;
    const answerTotalMs = finiteDuration(data.progress?.totalMs);
    recordServerElapsed(state, answerTotalMs);
    return state;
  }

  if (type === "error") {
    if (state.answer || state.remoteError) throw timingProtocolError("timing_sse_error_duplicate");
    state.remoteError = {
      code: String(data.code || data.error || "timing_remote_error"),
      message: String(data.message || data.error || "后端返回错误"),
    };
    markActiveStageFailed(state, String(data.stageId || state.activeStageId));
    return state;
  }

  if (type === "end") {
    if (!state.answer && !state.remoteError) throw timingProtocolError("timing_sse_end_before_result");
    if (state.activeStageId) throw timingProtocolError("timing_sse_end_during_stage");
    const totalMs = finiteDuration(data.totalMs) ?? serverElapsedMs;
    recordServerElapsed(state, totalMs);
    state.ended = true;
    state.activeStageId = "";
    for (const stage of state.stages) {
      if (stage.status === "waiting") stage.status = "skipped";
    }
    return state;
  }

  const stageId = String(data.stageId || "");
  const stageIndex = state.stages.findIndex((stage) => stage.id === stageId);
  if (stageIndex < 0) throw timingProtocolError("timing_sse_stage_unknown");
  const stage = state.stages[stageIndex];

  if (type === "stage_start") {
    if (stageIndex < state.lastStageIndex || stage.status !== "waiting" || state.activeStageId) {
      throw timingProtocolError("timing_sse_stage_order_invalid");
    }
    stage.status = "running";
    stage.startedAtMs = serverElapsedMs;
    stage.activeElapsedMs = 0;
    state.activeStageId = stageId;
    state.lastStageIndex = stageIndex;
    return state;
  }

  if (state.activeStageId !== stageId || stage.status !== "running") {
    throw timingProtocolError("timing_sse_stage_not_active");
  }

  if (type === "tick") {
    const activeElapsedMs = finiteDuration(data.activeStageElapsedMs);
    if (activeElapsedMs === null) throw timingProtocolError("timing_sse_tick_invalid");
    if (stage.activeElapsedMs !== null && activeElapsedMs < stage.activeElapsedMs) {
      throw timingProtocolError("timing_sse_stage_elapsed_regressed");
    }
    stage.activeElapsedMs = activeElapsedMs;
    return state;
  }

  if (type === "stage_end") {
    const durationMs = finiteDuration(data.durationMs)
      ?? finiteDuration(data.activeStageElapsedMs);
    if (durationMs === null) throw timingProtocolError("timing_sse_stage_duration_invalid");
    if (stage.activeElapsedMs !== null && durationMs < stage.activeElapsedMs) {
      throw timingProtocolError("timing_sse_stage_elapsed_regressed");
    }
    stage.status = data.status === "failed" ? "failed" : "done";
    stage.durationMs = durationMs;
    stage.activeElapsedMs = null;
    state.activeStageId = "";
    return state;
  }

  throw timingProtocolError("timing_sse_event_invalid");
}

export function finalizeTimingProtocolState(state) {
  if (!state?.ended) throw timingProtocolError("timing_sse_end_missing");
  if (state.remoteError) {
    const error = timingProtocolError(state.remoteError.code);
    error.message = state.remoteError.message;
    throw error;
  }
  if (!state.answer) throw timingProtocolError("timing_sse_answer_missing");
  return state.answer;
}

function finiteDuration(value) {
  if (value === null || value === undefined || value === "") return null;
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function recordServerElapsed(state, elapsedMs) {
  if (elapsedMs === null) return;
  if (state.lastServerElapsedMs !== null && elapsedMs < state.lastServerElapsedMs) {
    throw timingProtocolError("timing_sse_server_elapsed_regressed");
  }
  state.lastServerElapsedMs = elapsedMs;
  state.backendTotalMs = elapsedMs;
}

function markActiveStageFailed(state, stageId) {
  const stage = state.stages.find((item) => item.id === stageId);
  if (!stage || stage.status !== "running") return;
  stage.status = "failed";
  stage.activeElapsedMs = state.backendTotalMs !== null && stage.startedAtMs !== null
    ? Math.max(0, state.backendTotalMs - stage.startedAtMs)
    : stage.activeElapsedMs;
  state.activeStageId = "";
}

function timingProtocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function formatDuration(value) {
  const milliseconds = finiteDuration(value);
  if (milliseconds === null) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} 秒`;
}

function initializeTimingTestPage() {
  const ui = {
    questionInput: document.querySelector("#questionInput"),
    startButton: document.querySelector("#startButton"),
    cancelButton: document.querySelector("#cancelButton"),
    requestStatus: document.querySelector("#requestStatus"),
    modelProfileText: document.querySelector("#modelProfileText"),
    errorText: document.querySelector("#errorText"),
    browserTotalText: document.querySelector("#browserTotalText"),
    backendTotalText: document.querySelector("#backendTotalText"),
    timingDifferenceText: document.querySelector("#timingDifferenceText"),
    firstEventText: document.querySelector("#firstEventText"),
    stageTableBody: document.querySelector("#stageTableBody"),
    answerPanel: document.querySelector("#answerPanel"),
    routeText: document.querySelector("#routeText"),
    shortAnswerText: document.querySelector("#shortAnswerText"),
    rawEventLog: document.querySelector("#rawEventLog"),
  };

  let modelProfile = DEFAULT_MODEL_PROFILE;
  let activeController = null;
  let activeRequestId = 0;
  let browserStartedAt = null;
  let browserFinishedAt = null;
  let firstEventAtMs = null;
  let browserTimer = 0;
  let protocolState = createTimingProtocolState();
  let rawEvents = [];

  renderStages();
  loadModelProfile();

  ui.startButton.addEventListener("click", startRequest);
  ui.cancelButton.addEventListener("click", cancelActiveRequest);

  async function loadModelProfile() {
    try {
      const response = await fetch(TIMING_TEST_API_PATH, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`model info ${response.status}`);
      const info = await response.json();
      const candidate = String(info?.defaultRulingModelProfile || "").trim();
      if (candidate) modelProfile = candidate;
    } catch {
      // The diagnostic page can still use the public default profile ID.
    }
    ui.modelProfileText.textContent = modelProfile;
  }

  async function startRequest() {
    const question = String(ui.questionInput.value || "").trim();
    if (!question) {
      showError("请先输入要测试的问题。");
      ui.questionInput.focus();
      return;
    }

    cancelActiveRequest({ silent: true });
    const requestId = ++activeRequestId;
    const controller = new AbortController();
    activeController = controller;
    protocolState = createTimingProtocolState();
    rawEvents = [];
    browserStartedAt = performance.now();
    browserFinishedAt = null;
    firstEventAtMs = null;
    resetViewForRequest();
    setRequestStatus("请求中", "running");
    browserTimer = window.setInterval(renderSummary, 100);

    try {
      const response = await fetch(buildTimingProgressUrl(window.location), {
        method: "POST",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(buildTimingRequestBody(question, modelProfile)),
      });
      if (requestId !== activeRequestId) return;
      if (!response.ok) throw timingProtocolError(`timing_http_${response.status}`);
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("text/event-stream")) {
        throw timingProtocolError("timing_sse_content_type_invalid");
      }
      await consumeTimingStream(response, requestId);
      if (requestId !== activeRequestId) return;
      const answer = finalizeTimingProtocolState(protocolState);
      renderAnswer(answer);
      setRequestStatus("已完成", "success");
    } catch (error) {
      if (requestId !== activeRequestId) return;
      if (error?.name === "AbortError") {
        setRequestStatus("已取消", "error");
        showError("当前请求已取消；页面没有自动重试。");
      } else {
        setRequestStatus("失败", "error");
        showError(`请求失败：${String(error?.message || error)}`);
      }
    } finally {
      if (requestId === activeRequestId) {
        browserFinishedAt = performance.now();
        if (browserTimer) window.clearInterval(browserTimer);
        browserTimer = 0;
        activeController = null;
        setControlsRunning(false);
        renderSummary();
        renderStages();
      }
    }
  }

  async function consumeTimingStream(response, requestId) {
    if (!response.body || typeof response.body.getReader !== "function") {
      throw timingProtocolError("timing_sse_stream_unavailable");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let protocolCompleted = false;
    try {
      while (!protocolState.ended) {
        const { done, value } = await reader.read();
        if (requestId !== activeRequestId) return;
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/u);
        buffer = blocks.pop() || "";
        if (done && buffer.trim()) {
          blocks.push(buffer);
          buffer = "";
        }
        for (const block of blocks) {
          if (!block.trim()) continue;
          const event = parseTimingSseBlock(block);
          recordEvent(event);
          applyTimingProtocolEvent(protocolState, event);
          renderStages();
          renderSummary();
        }
        if (done) break;
      }
      if (!protocolState.ended) throw timingProtocolError("timing_sse_end_missing");
      protocolCompleted = true;
    } finally {
      if (!protocolCompleted) {
        try {
          await reader.cancel();
        } catch {
          // Keep the original transport or protocol error.
        }
      }
      try {
        reader.releaseLock();
      } catch {
        // The stream may already have released its lock after aborting.
      }
    }
  }

  function cancelActiveRequest({ silent = false } = {}) {
    if (!activeController) return;
    const controller = activeController;
    activeController = null;
    controller.abort();
    if (!silent) setRequestStatus("正在取消", "error");
  }

  function recordEvent(event) {
    const receivedAtMs = browserStartedAt === null ? 0 : performance.now() - browserStartedAt;
    if (firstEventAtMs === null) firstEventAtMs = receivedAtMs;
    rawEvents.push({ receivedAtMs, ...event });
    ui.rawEventLog.textContent = rawEvents
      .map((item) => `[+${formatDuration(item.receivedAtMs)}] ${item.type}\n${JSON.stringify(item.data, null, 2)}`)
      .join("\n\n");
  }

  function resetViewForRequest() {
    hideError();
    setControlsRunning(true);
    ui.answerPanel.hidden = true;
    ui.routeText.textContent = "—";
    ui.shortAnswerText.textContent = "";
    ui.rawEventLog.textContent = "等待后端事件……";
    renderStages();
    renderSummary();
  }

  function renderStages() {
    ui.stageTableBody.replaceChildren();
    for (const stage of protocolState.stages) {
      const row = document.createElement("tr");
      const labelCell = document.createElement("td");
      const statusCell = document.createElement("td");
      const startedCell = document.createElement("td");
      const durationCell = document.createElement("td");
      const badge = document.createElement("span");
      labelCell.textContent = stage.label;
      badge.className = `stage-status is-${stage.status}`;
      badge.textContent = stageStatusLabel(stage.status);
      statusCell.appendChild(badge);
      startedCell.textContent = stage.startedAtMs === null ? "—" : formatDuration(stage.startedAtMs);
      durationCell.textContent = formatDuration(stage.durationMs ?? stage.activeElapsedMs);
      row.append(labelCell, statusCell, startedCell, durationCell);
      ui.stageTableBody.appendChild(row);
    }
  }

  function renderSummary() {
    const browserNow = browserFinishedAt ?? performance.now();
    const browserTotalMs = browserStartedAt === null ? null : Math.max(0, browserNow - browserStartedAt);
    const backendTotalMs = protocolState.backendTotalMs;
    ui.browserTotalText.textContent = formatDuration(browserTotalMs);
    ui.backendTotalText.textContent = formatDuration(backendTotalMs);
    ui.timingDifferenceText.textContent = browserTotalMs === null || backendTotalMs === null
      ? "—"
      : formatSignedDuration(browserTotalMs - backendTotalMs);
    ui.firstEventText.textContent = formatDuration(firstEventAtMs);
  }

  function renderAnswer(answer) {
    ui.answerPanel.hidden = false;
    ui.routeText.textContent = String(answer?.route || answer?.debug?.route || "未提供 route");
    ui.shortAnswerText.textContent = String(
      answer?.shortAnswer || answer?.answer || answer?.verdict || "后端未提供简短答案。",
    );
  }

  function setControlsRunning(running) {
    ui.startButton.disabled = running;
    ui.cancelButton.disabled = !running;
    ui.questionInput.disabled = running;
  }

  function setRequestStatus(text, type = "") {
    ui.requestStatus.textContent = text;
    ui.requestStatus.className = `status-badge${type ? ` is-${type}` : ""}`;
  }

  function showError(message) {
    ui.errorText.hidden = false;
    ui.errorText.textContent = message;
  }

  function hideError() {
    ui.errorText.hidden = true;
    ui.errorText.textContent = "";
  }
}

function stageStatusLabel(status) {
  return {
    waiting: "等待",
    running: "运行中",
    done: "已完成",
    failed: "失败",
    skipped: "未执行",
  }[status] || status;
}

function formatSignedDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return "—";
  const sign = duration > 0 ? "+" : duration < 0 ? "−" : "";
  return `${sign}${formatDuration(Math.abs(duration))}`;
}

if (typeof document !== "undefined") initializeTimingTestPage();
