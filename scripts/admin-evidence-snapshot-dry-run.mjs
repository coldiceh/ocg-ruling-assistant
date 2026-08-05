import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createConfiguredLegacyLuaSemanticPacketFactory,
} from "../backend/legacyLuaSemanticProduction.mjs";
import {
  createLegacyLuaUnknownPacket,
} from "../backend/legacyLuaSemanticPacket.mjs";
import {
  normalizeAdminEvidenceDryRunCases,
  readAdminEvidenceDryRunCases,
  runAdminEvidenceSnapshotDryRun,
} from "./lib/admin-evidence-snapshot-dry-run.mjs";

const DEFAULT_CASES_URL = new URL(
  "../tests/fixtures/admin-evidence-dry-run-cases.json",
  import.meta.url,
);

export function parseAdminEvidenceDryRunArguments(argv = []) {
  const result = {
    casesPath: fileURLToPath(DEFAULT_CASES_URL),
    dataDir: undefined,
    caseIds: [],
    compact: false,
    allowCommunityCardNetwork: false,
    engineUrl: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cases") result.casesPath = requiredNext(argv, ++index, argument);
    else if (argument === "--data-dir") result.dataDir = requiredNext(argv, ++index, argument);
    else if (argument === "--case") result.caseIds.push(requiredNext(argv, ++index, argument));
    else if (argument === "--compact") result.compact = true;
    else if (argument === "--allow-community-card-network") result.allowCommunityCardNetwork = true;
    else if (argument === "--engine-url") result.engineUrl = requiredNext(argv, ++index, argument);
    else if (argument === "--help" || argument === "-h") result.help = true;
    else throw new TypeError(`unsupported argument: ${argument}`);
  }
  return result;
}

export async function runAdminEvidenceDryRunCli(
  argv = process.argv.slice(2),
  {
    readCases = readAdminEvidenceDryRunCases,
    runDryRun = runAdminEvidenceSnapshotDryRun,
    createLegacyLuaFactory = createLocalDryRunLegacyLuaSemanticPacketFactory,
    fetchImpl = globalThis.fetch,
    engineToken = process.env.OCG_ENGINE_TOKEN,
    stdout = process.stdout,
  } = {},
) {
  const options = parseAdminEvidenceDryRunArguments(argv);
  if (options.help) {
    stdout.write([
      "Usage: node scripts/admin-evidence-snapshot-dry-run.mjs [options]",
      "",
      "Options:",
      "  --cases <path>    Cases fixture (contains no golden answers)",
      "  --data-dir <path> Override local RAG data directory",
      "  --case <id>       Run one case; may be repeated",
      "  --compact         Print compact JSON",
      "  --allow-community-card-network",
      "                    Allow GET requests only to https://ygocdb.com/api/v0/;",
      "                    final-model transport remains a local sentinel",
      "  --engine-url <url> Use the already-running local Lua engine at",
      "                    http://127.0.0.1:<port> or http://localhost:<port>;",
      "                    OCG_ENGINE_TOKEN is read only for this local engine",
      "  -h, --help        Show this help",
      "",
    ].join("\n"));
    return null;
  }
  const loaded = await readCases(resolve(options.casesPath));
  const wanted = new Set(options.caseIds);
  const selected = wanted.size === 0
    ? loaded
    : normalizeAdminEvidenceDryRunCases({
      schemaVersion: loaded.schemaVersion,
      cases: loaded.cases.filter((item) => wanted.has(item.id)),
    });
  if (wanted.size > 0 && selected.cases.length !== wanted.size) {
    const found = new Set(selected.cases.map((item) => item.id));
    const missing = [...wanted].filter((id) => !found.has(id));
    throw new TypeError(`unknown case id(s): ${missing.join(", ")}`);
  }
  const localEngineUrl = options.engineUrl
    ? normalizeLocalDryRunEngineUrl(options.engineUrl)
    : null;
  const legacyLuaSemanticPacketFactory = localEngineUrl
    ? createLegacyLuaFactory({
        engineUrl: localEngineUrl,
        engineToken,
        fetchImpl,
      })
    : null;
  const report = await runDryRun({
    cases: selected,
    dataDir: options.dataDir ? resolve(options.dataDir) : undefined,
    retrievalFetchImpl: options.allowCommunityCardNetwork
      ? createAllowlistedCommunityCardFetch({ fetchImpl })
      : null,
    legacyLuaSemanticPacketFactory,
    enginePasscodeHydrationEnabled: localEngineUrl !== null,
  });
  stdout.write(`${JSON.stringify(report, null, options.compact ? 0 : 2)}\n`);
  return report;
}

/**
 * Opt-in composition for the zero-cost dry-run. It intentionally copies only
 * the local engine URL and token into the production Lua factory; unrelated
 * process credentials can never become part of this transport environment.
 */
export function createLocalDryRunLegacyLuaSemanticPacketFactory({
  engineUrl,
  engineToken = "",
  fetchImpl = globalThis.fetch,
  configuredFactory = createConfiguredLegacyLuaSemanticPacketFactory,
} = {}) {
  if (typeof configuredFactory !== "function") {
    throw new TypeError("configured legacy Lua factory must be a function");
  }
  const normalizedEngineUrl = normalizeLocalDryRunEngineUrl(engineUrl);
  const localFetch = createLocalEngineOnlyFetch({
    engineUrl: normalizedEngineUrl,
    fetchImpl,
  });
  const token = String(engineToken || "").trim();
  const configured = configuredFactory({
    env: {
      OCG_ENGINE_URL: normalizedEngineUrl,
      ...(token ? { OCG_ENGINE_TOKEN: token } : {}),
    },
    fetchImpl: localFetch,
  });
  if (typeof configured !== "function") {
    throw new TypeError("local legacy Lua factory was not configured");
  }
  return async (input) => {
    const packet = await configured(input);
    if (packet?.verdict === "UNKNOWN") return packet;
    return createLegacyLuaUnknownPacket({
      code: "LOCAL_DRY_RUN_LUA_NON_UNKNOWN_REJECTED",
      message: "local dry-run rejected a legacy Lua packet that attempted to claim a verdict",
      details: { retryable: false },
    });
  };
}

export function normalizeLocalDryRunEngineUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new TypeError("--engine-url must be a valid local HTTP URL");
  }
  if (url.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/") {
    throw new TypeError(
      "--engine-url only accepts http://127.0.0.1:<port> or http://localhost:<port> without credentials, path, query or fragment",
    );
  }
  return url.origin;
}

export function createLocalEngineOnlyFetch({
  engineUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("local engine dry-run requires fetch");
  }
  const expectedOrigin = normalizeLocalDryRunEngineUrl(engineUrl);
  return async (value, init = {}) => {
    const url = new URL(String(value));
    if (url.origin !== expectedOrigin
      || url.protocol !== "http:"
      || !["127.0.0.1", "localhost"].includes(url.hostname)
      || url.username
      || url.password
      || url.hash) {
      throw new TypeError("local engine dry-run blocked a non-local request");
    }
    const headers = new Headers(init?.headers || {});
    if (headers.has("proxy-authorization")) {
      throw new TypeError("local engine dry-run must not send proxy credentials");
    }
    return fetchImpl(url, {
      ...init,
      headers,
      redirect: "error",
    });
  };
}

export function createAllowlistedCommunityCardFetch({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("allowlisted evidence fetch requires fetch");
  return async (value, init = {}) => {
    const url = new URL(String(value));
    const method = String(init?.method || "GET").trim().toUpperCase();
    if (url.protocol !== "https:"
      || url.hostname !== "ygocdb.com"
      || url.port
      || url.username
      || url.password
      || url.hash
      || url.pathname !== "/api/v0/"
      || method !== "GET") {
      throw new TypeError(`evidence dry-run network target is not allowlisted: ${url.origin}${url.pathname}`);
    }
    const headers = new Headers(init?.headers || {});
    if (headers.has("authorization") || headers.has("proxy-authorization")) {
      throw new TypeError("evidence dry-run must not send authorization headers");
    }
    return fetchImpl(url, { ...init, method: "GET", headers });
  };
}

function requiredNext(argv, index, option) {
  const value = String(argv[index] || "").trim();
  if (!value || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
  return value;
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runAdminEvidenceDryRunCli().catch((error) => {
    process.stderr.write(`${error?.code ? `${error.code}: ` : ""}${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
