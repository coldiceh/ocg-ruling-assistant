// In-process stand-in for the Upstash REST store used by the cloud budget
// ledger (backend/cloudRequestBudget.mjs). Production sends Redis command
// arrays to a REST URL; the commands the ledger actually issues are HGETALL
// and EVAL of three exported Lua scripts (reserve, settle, settle+reserve).
// This store recognizes those scripts by exact source identity and applies the
// same hash updates in JavaScript. Any other script or command is refused, so
// a production change that needs more fails loudly instead of being guessed.
//
// Only the benchmark runner uses this file; production code is unchanged.
import {
  CLOUD_BUDGET_RESERVE,
  CLOUD_BUDGET_SETTLE,
  CLOUD_BUDGET_SETTLE_AND_RESERVE,
} from "../../../backend/cloudRequestBudget.mjs";

export const LEDGER_SCRIPT_NAMES = new Map([
  [CLOUD_BUDGET_RESERVE, "reserve"],
  [CLOUD_BUDGET_SETTLE, "settle"],
  [CLOUD_BUDGET_SETTLE_AND_RESERVE, "settle_and_reserve"],
]);

const TOTAL_FIELDS = new Set(["actualNano", "theoreticalNano"]);

export class LedgerCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "LedgerCommandError";
  }
}

// Parses an Upstash REST command array into a ledger operation description.
// Returns null for commands that are not ledger scripts.
export function describeLedgerCommand(args) {
  if (!Array.isArray(args) || String(args[0]).toUpperCase() !== "EVAL") return null;
  const name = LEDGER_SCRIPT_NAMES.get(args[1]);
  if (!name) return null;
  const keyCount = Number(args[2]);
  const keys = args.slice(3, 3 + keyCount).map(String);
  const argv = args.slice(3 + keyCount).map((value) => String(value ?? ""));
  return { name, keys, argv };
}

function parseTicket(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createMemoryLedgerStore() {
  const hashes = new Map();
  const hash = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };

  function reserve(keys, argv) {
    const h = hash(keys[0]);
    const id = argv[0];
    if (h.has(id)) return ["existing", h.get(id)];
    if (argv[8] === "official_daily_v1" && !h.has("theoreticalNano")) {
      let migrated = 0;
      const legacy = hashes.get(keys[1]) || new Map();
      for (const [field, value] of legacy) {
        if (TOTAL_FIELDS.has(field)) continue;
        const ticket = parseTicket(value);
        if (!ticket) return ["migration_invalid"];
        if (ticket.provider === "openai" && ["reserved", "usage_settled"].includes(ticket.status)
            && typeof ticket.startedAtUtc === "string" && ticket.startedAtUtc >= argv[9]
            && ticket.startedAtUtc < argv[10] && typeof ticket.theoreticalNano === "number"
            && ticket.theoreticalNano >= 0) {
          migrated += ticket.theoreticalNano;
          h.set(field, value);
        }
      }
      h.set("actualNano", "0");
      h.set("theoreticalNano", String(migrated));
    }
    const cny = Number(h.get("actualNano") ?? argv[5]);
    const usd = Number(h.get("theoreticalNano") ?? argv[6]);
    const nextCny = cny + Number(argv[1]);
    const nextUsd = usd + Number(argv[2]);
    let cappedCny = nextCny;
    let cappedUsd = nextUsd;
    let unlimited = false;
    if (argv[8] === "public_gemini_uncapped_v1") {
      const incoming = parseTicket(argv[7]);
      unlimited = incoming?.provider === "gemini";
      if (!unlimited) {
        for (const [field, value] of h) {
          if (TOTAL_FIELDS.has(field)) continue;
          const prior = parseTicket(value);
          if (prior?.provider === "gemini") {
            cappedCny -= prior.actualNano;
            cappedUsd -= prior.theoreticalNano;
          }
        }
      }
    }
    if (!unlimited && (cappedCny > Number(argv[3]) || cappedUsd > Number(argv[4]))) {
      return ["blocked", String(cny), String(usd)];
    }
    h.set("actualNano", String(nextCny));
    h.set("theoreticalNano", String(nextUsd));
    h.set(id, argv[7]);
    return ["reserved", String(nextCny), String(nextUsd)];
  }

  function settle(keys, argv) {
    const h = hash(keys[0]);
    const old = h.get(argv[0]);
    if (!old) return ["missing"];
    const ticket = parseTicket(old);
    if (ticket?.status !== "reserved") return ["settled", old];
    const cny = Number(h.get("actualNano")) + Number(argv[1]) - ticket.actualNano;
    const usd = Number(h.get("theoreticalNano")) + Number(argv[2]) - ticket.theoreticalNano;
    h.set("actualNano", String(cny));
    h.set("theoreticalNano", String(usd));
    h.set(argv[0], argv[3]);
    return ["settled", String(cny), String(usd)];
  }

  function settleAndReserve(keys, argv) {
    const h = hash(keys[0]);
    const priorId = argv[11];
    const old = h.get(priorId);
    if (!old) return ["settlement_missing"];
    const prior = parseTicket(old);
    if (prior?.provider !== "openai" || prior?.operation !== "decisions") return ["settlement_invalid"];
    if (prior.status === "reserved") {
      const settled = parseTicket(argv[14]);
      if (!settled || settled.id !== prior.id || settled.status !== "usage_settled"
          || settled.provider !== prior.provider || settled.operation !== prior.operation
          || settled.actualNano !== Number(argv[12]) || settled.theoreticalNano !== Number(argv[13])
          || settled.actualNano < 0 || settled.theoreticalNano < 0
          || settled.actualNano > prior.actualNano || settled.theoreticalNano > prior.theoreticalNano) {
        return ["settlement_invalid"];
      }
      const cny = Number(h.get("actualNano")) + settled.actualNano - prior.actualNano;
      const usd = Number(h.get("theoreticalNano")) + settled.theoreticalNano - prior.theoreticalNano;
      h.set("actualNano", String(cny));
      h.set("theoreticalNano", String(usd));
      h.set(priorId, argv[14]);
    } else if (prior.status !== "usage_settled") {
      return ["settlement_invalid"];
    }
    return reserve(keys, argv);
  }

  function execute(args) {
    if (!Array.isArray(args) || !args.length) throw new LedgerCommandError("bench_ledger_command_invalid");
    const command = String(args[0]).toUpperCase();
    if (command === "HGETALL") {
      const h = hashes.get(String(args[1])) || new Map();
      return [...h].flat();
    }
    if (command !== "EVAL") throw new LedgerCommandError(`bench_ledger_command_unsupported:${command}`);
    const described = describeLedgerCommand(args);
    if (!described) throw new LedgerCommandError("bench_ledger_script_unsupported");
    if (described.name === "reserve") return reserve(described.keys, described.argv);
    if (described.name === "settle") return settle(described.keys, described.argv);
    return settleAndReserve(described.keys, described.argv);
  }

  return { execute, hashes };
}
