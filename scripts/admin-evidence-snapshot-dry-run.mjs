import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildFinalRulingInput,
} from "../backend/adminModelLabService.mjs";
import {
  assertAdminEvidenceSnapshot,
} from "../backend/adminEvidenceSnapshot.mjs";
import {
  hashAdminFinalInput,
} from "../backend/adminEvidenceVariant.mjs";
import {
  createConfiguredLegacyLuaSemanticPacketFactory,
} from "../backend/legacyLuaSemanticProduction.mjs";
import {
  createLegacyLuaUnknownPacket,
} from "../backend/legacyLuaSemanticPacket.mjs";
import {
  inspectAdminEvidencePaidGate,
  normalizeAdminEvidenceDryRunCases,
  readAdminEvidenceDryRunCases,
  runAdminEvidenceSnapshotDryRun,
} from "./lib/admin-evidence-snapshot-dry-run.mjs";

const DEFAULT_CASES_URL = new URL(
  "../tests/fixtures/admin-evidence-dry-run-cases.json",
  import.meta.url,
);
const SENSITIVE_KEY = /^(?:api[_-]?key|authorization|cookie|csrf[_-]?token|password|secret)$/iu;

export function parseAdminEvidenceDryRunArguments(argv = []) {
  const result = {
    casesPaths: [],
    dataDir: undefined,
    caseIds: [],
    compact: false,
    allowCommunityCardNetwork: false,
    engineUrl: null,
    bundleOutput: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cases") result.casesPaths.push(requiredNext(argv, ++index, argument));
    else if (argument === "--data-dir") result.dataDir = requiredNext(argv, ++index, argument);
    else if (argument === "--case") result.caseIds.push(requiredNext(argv, ++index, argument));
    else if (argument === "--compact") result.compact = true;
    else if (argument === "--allow-community-card-network") result.allowCommunityCardNetwork = true;
    else if (argument === "--engine-url") result.engineUrl = requiredNext(argv, ++index, argument);
    else if (argument === "--bundle-output") result.bundleOutput = requiredNext(argv, ++index, argument);
    else if (argument === "--help" || argument === "-h") result.help = true;
    else throw new TypeError(`unsupported argument: ${argument}`);
  }
  if (result.casesPaths.length === 0) {
    result.casesPaths.push(fileURLToPath(DEFAULT_CASES_URL));
  }
  // Retain the original field for callers that only inspect the default or
  // single-fixture CLI parse result.
  result.casesPath = result.casesPaths[0];
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
    writeFileImpl = writeFile,
    now = () => new Date(),
    stdout = process.stdout,
  } = {},
) {
  const options = parseAdminEvidenceDryRunArguments(argv);
  if (options.help) {
    stdout.write([
      "Usage: node scripts/admin-evidence-snapshot-dry-run.mjs [options]",
      "",
      "Options:",
      "  --cases <path>    Cases fixture (contains no golden answers); may be repeated",
      "  --data-dir <path> Override local RAG data directory",
      "  --case <id>       Run one case; may be repeated",
      "  --compact         Print compact JSON",
      "  --allow-community-card-network",
      "                    Allow GET requests only to https://ygocdb.com/api/v0/;",
      "                    final-model transport remains a local sentinel",
      "  --engine-url <url> Use the already-running local Lua engine at",
      "                    http://127.0.0.1:<port> or http://localhost:<port>;",
      "                    bundled precomputed Lua remains enabled without it;",
      "                    OCG_ENGINE_TOKEN is read only for this local engine",
      "  --bundle-output <path>",
      "                    Write a validated frozen-source bundle for the local Relay runner",
      "  -h, --help        Show this help",
      "",
    ].join("\n"));
    return null;
  }
  const loadedFixtures = [];
  for (const casesPath of options.casesPaths) {
    loadedFixtures.push(await readCases(resolve(casesPath)));
  }
  const loaded = normalizeAdminEvidenceDryRunCases({
    schemaVersion: loadedFixtures[0]?.schemaVersion,
    cases: loadedFixtures.flatMap((fixture) => fixture.cases),
  });
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
  const legacyLuaSemanticPacketFactory = createLegacyLuaFactory({
    engineUrl: localEngineUrl,
    engineToken,
    fetchImpl,
  });
  const artifacts = [];
  const report = await runDryRun({
    cases: selected,
    dataDir: options.dataDir ? resolve(options.dataDir) : undefined,
    retrievalFetchImpl: options.allowCommunityCardNetwork
      ? createAllowlistedCommunityCardFetch({ fetchImpl })
      : null,
    legacyLuaSemanticPacketFactory,
    legacyLuaMode: localEngineUrl
      ? "PRECOMPUTED_STATIC_WITH_LOCAL_FALLBACK"
      : "PRECOMPUTED_STATIC",
    enginePasscodeHydrationEnabled: localEngineUrl !== null,
    async onCaseArtifacts(value) {
      artifacts.push(value);
    },
  });
  let bundle = null;
  if (options.bundleOutput) {
    bundle = createOfflineFrozenSourceBundle({ artifacts, now });
    await writeFileImpl(
      resolve(options.bundleOutput),
      `${JSON.stringify(bundle, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  }
  stdout.write(`${JSON.stringify(report, null, options.compact ? 0 : 2)}\n`);
  return bundle ? { report, bundle } : report;
}

/**
 * Converts zero-cost dry-run artifacts into the exact immutable source format
 * consumed by the local Relay runner. Validation is deliberately completed for
 * every case before the caller writes anything.
 */
export function createOfflineFrozenSourceBundle({ artifacts, now = () => new Date() } = {}) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new TypeError("offline frozen-source export requires non-empty dry-run artifacts");
  }
  const ids = new Set();
  const sources = artifacts.map((artifact, index) => {
    const caseId = String(artifact?.definition?.id || "").trim();
    if (!caseId || ids.has(caseId)) {
      throw new TypeError(`invalid or duplicate dry-run artifact case id at index ${index}`);
    }
    ids.add(caseId);
    const report = artifact?.report;
    if (report?.productionReadiness?.ready !== true) {
      throw new Error(`${caseId} production evidence is not ready`);
    }
    const snapshot = assertAdminEvidenceSnapshot(artifact?.snapshot);
    if (report?.snapshot?.id !== snapshot.snapshotId
      || report?.snapshot?.sha256 !== snapshot.contentSha256) {
      throw new Error(`${caseId} report does not match its Evidence Snapshot integrity binding`);
    }
    const executionProfile = artifact?.run?.executionProfile;
    if (!executionProfile || typeof executionProfile !== "object" || Array.isArray(executionProfile)) {
      throw new TypeError(`${caseId} is missing an executionProfile`);
    }
    if (executionProfile.status !== "evidence_frozen") {
      throw new Error(`${caseId} executionProfile is not evidence_frozen`);
    }
    if (String(executionProfile.evidenceSnapshotId || "") !== snapshot.snapshotId) {
      throw new Error(`${caseId} executionProfile snapshot binding mismatches`);
    }
    const prompt = executionProfile.prompt;
    if (!prompt || typeof prompt.instructions !== "string" || !prompt.instructions.trim()) {
      throw new TypeError(`${caseId} executionProfile is missing frozen prompt instructions`);
    }
    if (!/^[a-f0-9]{64}$/u.test(String(prompt.sha256 || ""))
      || prompt.sha256 !== sha256(prompt.instructions)) {
      throw new Error(`${caseId} frozen prompt instructions fail their SHA-256 binding`);
    }
    const evidenceVariant = executionProfile.evidenceVariant || "full";
    const rebuiltFinalInput = buildFinalRulingInput(snapshot, { evidenceVariant });
    if (artifact.finalInput !== rebuiltFinalInput) {
      throw new Error(`${caseId} captured final input differs from the frozen Evidence Snapshot`);
    }
    const finalInputSha256 = hashAdminFinalInput(rebuiltFinalInput);
    if (executionProfile.finalRulingInputSha256 !== finalInputSha256
      || report?.finalInput?.sha256 !== finalInputSha256) {
      throw new Error(`${caseId} final ruling input fails its SHA-256 binding`);
    }
    const inspection = inspectAdminEvidencePaidGate({
      snapshot,
      finalInput: rebuiltFinalInput,
      candidateCards: artifact.definition.candidateCards,
    });
    if (!inspection.ready || report.paidGateBlocked === true) {
      throw new Error(`${caseId} generic paid-gate inspection is not ready`);
    }
    const source = {
      caseId,
      status: String(artifact.run.status || "").trim() || null,
      evidenceSnapshot: snapshot,
      executionProfile: JSON.parse(JSON.stringify(executionProfile)),
    };
    assertNoSensitiveFields(source);
    return source;
  });
  const bundle = {
    schemaVersion: 1,
    kind: "admin-frozen-source-snapshot-bundle",
    generatedAt: now().toISOString(),
    sourceCount: sources.length,
    sources,
  };
  assertNoSensitiveFields(bundle);
  return bundle;
}

function assertNoSensitiveFields(value, path = "bundle", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new Error(`sensitive field is forbidden in offline bundle: ${path}.${key}`);
    }
    assertNoSensitiveFields(child, `${path}.${key}`, seen);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Zero-cost composition for bundled precomputed Lua, with an optional local
 * live-engine fallback. Only an explicitly supplied loopback URL and token may
 * enter the live transport environment; unrelated process credentials never do.
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
  const hasLocalEngine = String(engineUrl || "").trim() !== "";
  const normalizedEngineUrl = hasLocalEngine
    ? normalizeLocalDryRunEngineUrl(engineUrl)
    : null;
  const localFetch = hasLocalEngine
    ? createLocalEngineOnlyFetch({
        engineUrl: normalizedEngineUrl,
        fetchImpl,
      })
    : fetchImpl;
  const token = String(engineToken || "").trim();
  const configured = configuredFactory({
    env: hasLocalEngine
      ? {
          OCG_ENGINE_URL: normalizedEngineUrl,
          ...(token ? { OCG_ENGINE_TOKEN: token } : {}),
        }
      : {},
    fetchImpl: localFetch,
  });
  if (typeof configured !== "function") {
    throw new TypeError("precomputed legacy Lua factory was not configured");
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
