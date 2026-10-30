// Mirrors every ledger reservation and settlement the production budget code
// sends (memory or Upstash), attributes it to the job that issued it, appends
// it to ledger.jsonl and enforces the run's --budget-usd. Amounts are the
// ledger's own figures: settlements are priced from provider-reported usage
// by the production code (gpt-6-astra via data/model-pricing.json; Luna and
// Gemini via the list prices built into the backend, which that table lacks).
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const UNIT = 1_000_000_000;
// Same fixed rate the evidence provider uses for its CNY display figures.
export const CNY_PER_USD = 7;
const CNY_PROVIDERS = new Set(["deepseek", "siliconflow"]);

export function ticketUsd(ticket = {}) {
  const theoretical = Number(ticket.theoreticalNano || 0) / UNIT;
  const actualCny = CNY_PROVIDERS.has(ticket.provider) ? Number(ticket.actualNano || 0) / UNIT : 0;
  return theoretical + actualCny / CNY_PER_USD;
}

export function priceSourceFor(model, pricingTable) {
  const models = pricingTable?.models || {};
  const resolved = pricingTable?.aliases?.[model] || model;
  return Object.hasOwn(models, resolved) ? "data/model-pricing.json" : "backend_builtin_list_price";
}

export function createCostTracker({ logPath, budgetUsd = Infinity, pricingTable, sessionId, now = () => new Date() } = {}) {
  const tickets = new Map();
  const blockedJobs = new Set();
  const activeJobs = new Set();
  let budgetExceeded = false;

  function append(event) {
    if (logPath) appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  function upsert(event) {
    const prior = tickets.get(event.ticketId) || {};
    const next = { ...prior, ...event };
    tickets.set(event.ticketId, next);
    return next;
  }

  function load() {
    if (!logPath || !existsSync(logPath)) return 0;
    let count = 0;
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // a torn final line from a crash; earlier lines remain valid
      }
      if (event?.ticketId) {
        upsert(event);
        count += 1;
      }
    }
    return count;
  }

  function recordFromTicket(type, jobKey, ticket, result) {
    return {
      type,
      at: now().toISOString(),
      sessionId,
      jobKey: jobKey || null,
      ticketId: ticket.id,
      provider: ticket.provider || null,
      model: ticket.model || null,
      returnedModel: ticket.returnedModel || null,
      operation: ticket.operation || null,
      stage: ticket.stage || null,
      pricingBasis: ticket.pricingBasis || null,
      priceSource: priceSourceFor(ticket.model, pricingTable),
      status: ticket.status || null,
      result: result || null,
      usd: ticketUsd(ticket),
      usage: ticket.usage || null,
      elapsedMs: Number.isFinite(ticket.elapsedMs) ? ticket.elapsedMs : null,
      startedAtUtc: ticket.startedAtUtc || null,
      completedAtUtc: ticket.completedAtUtc || null,
    };
  }

  // Ledger amounts for settled calls, plus the conservative reservation of any
  // call that never settled outside a job still running in this session.
  function spentUsd() {
    let total = 0;
    for (const ticket of tickets.values()) {
      if (ticket.result === "blocked") continue;
      if (ticket.status === "usage_settled") total += ticket.settledUsd ?? ticket.usd;
      else if (!(ticket.sessionId === sessionId && activeJobs.has(ticket.jobKey))) total += ticket.reservedUsd ?? ticket.usd;
    }
    return total;
  }

  return {
    load,
    spentUsd,
    get budgetExceeded() { return budgetExceeded; },
    blockedJobs,
    activeJobs,
    // Called before a reservation is forwarded. Returns false to block it.
    allowReservation(jobKey) {
      if (spentUsd() < budgetUsd) return true;
      budgetExceeded = true;
      if (jobKey) blockedJobs.add(jobKey);
      return false;
    },
    onReserve(jobKey, ticket, result) {
      const record = recordFromTicket("reserve", jobKey, ticket, result);
      record.reservedUsd = record.usd;
      append(record);
      upsert(record);
    },
    onBlocked(jobKey, ticket) {
      const record = recordFromTicket("blocked_by_bench_budget", jobKey, ticket, "blocked");
      append(record);
      upsert(record);
    },
    onSettle(jobKey, settledTicket, result) {
      const record = recordFromTicket("settle", jobKey, settledTicket, result);
      record.settledUsd = record.usd;
      append(record);
      upsert(record);
    },
    jobCalls(jobKey) {
      return [...tickets.values()].filter((ticket) => ticket.jobKey === jobKey).map((ticket) => ({
        ticketId: ticket.ticketId,
        provider: ticket.provider,
        model: ticket.model,
        returnedModel: ticket.returnedModel,
        operation: ticket.operation,
        stage: ticket.stage,
        status: ticket.result === "blocked" ? "blocked" : ticket.status,
        costUsd: ticket.status === "usage_settled" ? ticket.settledUsd ?? ticket.usd : ticket.reservedUsd ?? ticket.usd,
        costBasis: ticket.status === "usage_settled" ? "settled_from_provider_usage" : "reservation_upper_bound",
        reservedUsd: ticket.reservedUsd ?? null,
        priceSource: ticket.priceSource,
        pricingBasis: ticket.pricingBasis,
        usage: ticket.usage,
        elapsedMs: ticket.elapsedMs,
        sessionId: ticket.sessionId,
      }));
    },
    jobCostUsd(jobKey) {
      return this.jobCalls(jobKey).reduce((sum, call) => sum + (call.status === "blocked" ? 0 : call.costUsd), 0);
    },
    ticketCount() {
      return tickets.size;
    },
  };
}
