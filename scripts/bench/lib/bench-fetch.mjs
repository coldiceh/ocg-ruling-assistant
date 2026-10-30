// The runner's single network boundary. It replaces globalThis.fetch before
// any backend module is imported, so every production transport (models,
// embeddings, 百鸽, live Q&A and the budget ledger) passes through here:
//   - budget ledger commands are observed for per-call cost and checked
//     against --budget-usd before a reservation is forwarded;
//   - with --mock, every other request is answered in-process and anything
//     without a fake route fails instead of reaching the network;
//   - in real mode, requests go to the original fetch and are timed.
import { describeLedgerCommand } from "./memory-ledger.mjs";

function requestParts(input, init = {}) {
  const href = typeof input === "string" ? input
    : input instanceof URL ? input.href
      : String(input?.url || "");
  return {
    url: new URL(href),
    method: String(init.method || input?.method || "GET").toUpperCase(),
    body: typeof init.body === "string" ? init.body : null,
  };
}

function parseCommand(body) {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ledgerResponse(result) {
  return Response.json({ result });
}

export function createBenchFetch({
  mode,
  originalFetch,
  ledgerMode,
  ledgerUrls,
  memoryLedger,
  mockResponder,
  tracker,
  getContext = () => undefined,
  onUnattributedNetwork = () => {},
}) {
  if (!["mock", "real"].includes(mode)) throw new Error(`bench fetch mode invalid: ${mode}`);
  const ledgerHrefs = new Set((ledgerUrls || []).map((value) => new URL(value).href));
  let sequence = 0;

  function log(entry) {
    const context = getContext();
    const record = { seq: ++sequence, at: new Date().toISOString(), ...entry };
    if (context?.network) context.network.push(record);
    else onUnattributedNetwork(record);
  }

  async function handleLedger(parts, init) {
    const context = getContext();
    const jobKey = context?.jobKey || null;
    const command = parseCommand(parts.body);
    const described = command ? describeLedgerCommand(command) : null;
    const startedAt = performance.now();
    if (described && described.name !== "settle") {
      const ticket = JSON.parse(described.argv[7] || "{}");
      if (!tracker.allowReservation(jobKey)) {
        tracker.onBlocked(jobKey, ticket);
        log({ route: "ledger", ledger: ledgerMode, command: `EVAL:${described.name}`, result: "blocked_by_bench_budget",
          host: parts.url.host, path: parts.url.pathname, status: 200, ms: performance.now() - startedAt });
        return ledgerResponse(["blocked", "0", "0"]);
      }
    }
    let response;
    let payload;
    if (ledgerMode === "memory") {
      try {
        payload = { result: memoryLedger.execute(command) };
      } catch (error) {
        payload = { error: error.message };
      }
      response = Response.json(payload);
    } else {
      response = await originalFetch(parts.url.href, init);
      payload = await response.clone().json().catch(() => null);
    }
    const result = Array.isArray(payload?.result) ? payload.result : null;
    if (described) {
      if (described.name === "settle") {
        if (result?.[0] === "settled") tracker.onSettle(jobKey, JSON.parse(described.argv[3]), result[0]);
      } else {
        const ticket = JSON.parse(described.argv[7] || "{}");
        tracker.onReserve(jobKey, ticket, result?.[0] || "error");
        if (described.name === "settle_and_reserve" && result && ["reserved", "blocked", "existing"].includes(result[0])) {
          tracker.onSettle(jobKey, JSON.parse(described.argv[14]), "settled");
        }
      }
    }
    log({ route: "ledger", ledger: ledgerMode, command: described ? `EVAL:${described.name}` : String(command?.[0] || "invalid"),
      result: result?.[0] ?? (payload?.error ? `error:${payload.error}` : null),
      host: parts.url.host, path: parts.url.pathname, status: response.status, ms: performance.now() - startedAt });
    return response;
  }

  return async function benchFetch(input, init = {}) {
    const parts = requestParts(input, init);
    if (ledgerHrefs.has(parts.url.href)) return handleLedger(parts, init);
    const startedAt = performance.now();
    if (mode === "mock") {
      const handled = await mockResponder(parts.url, { ...init, method: parts.method, body: parts.body });
      if (!handled) {
        log({ route: "mock_unrouted", host: parts.url.host, path: parts.url.pathname, method: parts.method,
          status: null, ms: 0, error: "bench_mock_unrouted_request" });
        throw new TypeError(`bench_mock_unrouted_request:${parts.method} ${parts.url.host}${parts.url.pathname}`);
      }
      log({ route: "mock", task: handled.task, host: parts.url.host, path: parts.url.pathname, method: parts.method,
        status: handled.response.status, ms: performance.now() - startedAt });
      return handled.response;
    }
    try {
      const response = await originalFetch(input, init);
      log({ route: "network", host: parts.url.host, path: parts.url.pathname, method: parts.method,
        status: response.status, ms: performance.now() - startedAt });
      return response;
    } catch (error) {
      log({ route: "network", host: parts.url.host, path: parts.url.pathname, method: parts.method,
        status: null, ms: performance.now() - startedAt, error: String(error?.message || error).slice(0, 200) });
      throw error;
    }
  };
}
