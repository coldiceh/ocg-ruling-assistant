export const LATENCY_TARGETS = Object.freeze({
  duel: { p50Ms: 3000, p95Ms: 8000, hardTimeoutMs: 10000, defaultBudgetMs: 6000 },
  analysis: { p50Ms: 8000, p95Ms: 20000, hardTimeoutMs: 20000, defaultBudgetMs: 16000 },
});

export function createLatencyBudget({ mode = "duel", maxLatencyMs, now = () => Date.now() } = {}) {
  const target = LATENCY_TARGETS[mode] || LATENCY_TARGETS.duel;
  const requested = Number(maxLatencyMs || target.defaultBudgetMs);
  const budgetMs = Math.max(250, Math.min(requested, target.hardTimeoutMs));
  const startedAt = now();
  const deadline = startedAt + budgetMs;
  return {
    mode,
    budgetMs,
    hardTimeoutMs: target.hardTimeoutMs,
    startedAt,
    deadline,
    elapsedMs: () => Math.max(0, now() - startedAt),
    remainingMs: () => Math.max(0, deadline - now()),
    expired: () => now() >= deadline,
    progressMessage(issueFrames = []) {
      const ids = issueFrames.map((frame) => frame.id || frame).filter(Boolean);
      return `正在深度判断；已识别争点：${ids.join("、") || "待识别"}`;
    },
  };
}

export async function runWithinLatencyBudget(task, budget, label = "operation") {
  const remaining = budget.remainingMs();
  if (remaining <= 0) throw createLatencyTimeout(label);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createLatencyTimeout(label)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isLatencyTimeout(error) {
  return error?.code === "FAST_JUDGE_TIMEOUT";
}

function createLatencyTimeout(label) {
  const error = new Error(`${label} exceeded fast judge latency budget`);
  error.code = "FAST_JUDGE_TIMEOUT";
  return error;
}
