import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export function resolveLocalStackSettings(env = process.env) {
  const backendPort = readPort(env.BACKEND_PORT || env.PORT, 8787, "BACKEND_PORT");
  const frontendPort = readPort(env.FRONTEND_PORT, 4173, "FRONTEND_PORT");
  const enginePort = readPort(env.OCG_ENGINE_PORT, 8790, "OCG_ENGINE_PORT");
  const engineRoot = path.resolve(
    env.OCG_ENGINE_ROOT || path.resolve(projectRoot, "..", "游戏王游戏引擎"),
  );
  const engineUrl = normalizeHttpUrl(env.OCG_ENGINE_URL || `http://127.0.0.1:${enginePort}`);
  return {
    backendPort,
    frontendPort,
    enginePort,
    engineRoot,
    engineEntry: path.join(engineRoot, "tools", "serve.mjs"),
    engineProfile: String(env.OCG_ENGINE_PROFILE || "ygopro").trim() || "ygopro",
    engineUrl,
    backendUrl: `http://127.0.0.1:${backendPort}`,
    frontendUrl: `http://127.0.0.1:${frontendPort}`,
  };
}

export function createManagedEngineToken() {
  return randomBytes(32).toString("base64url");
}

export function createLocalStackChildEnvironments({
  env = process.env,
  settings,
  engineToken,
} = {}) {
  const backendBase = {
    ...env,
    OCG_ENGINE_URL: settings.engineUrl,
    OCG_ENGINE_TOKEN: engineToken,
  };
  // The engine and static-file server do not need the backend's provider,
  // Redis, budget or authentication configuration. Build their environment
  // from an explicit runtime allowlist instead of trying to recognize every
  // possible secret-bearing variable name.
  const engineBase = createLocalChildRuntimeEnvironment(env);
  const frontendBase = createLocalChildRuntimeEnvironment(env);
  return {
    engine: {
      ...engineBase,
      OCG_ENGINE_URL: settings.engineUrl,
      OCG_ENGINE_TOKEN: engineToken,
      OCG_ENGINE_BIND: "127.0.0.1",
      OCG_ENGINE_PORT: String(settings.enginePort),
      OCG_ENGINE_PROFILE: settings.engineProfile,
      OCG_ENGINE_ALLOWED_ORIGIN: settings.backendUrl,
    },
    backend: {
      ...backendBase,
      HOST: "127.0.0.1",
      PORT: String(settings.backendPort),
      ALLOWED_ORIGIN: env.ALLOWED_ORIGIN || settings.frontendUrl,
      ADMIN_ALLOWED_ORIGINS: mergeCsvValues(
        env.ADMIN_ALLOWED_ORIGINS || env.ADMIN_ALLOWED_ORIGIN,
        settings.frontendUrl,
      ),
    },
    frontend: {
      ...frontendBase,
      PORT: String(settings.frontendPort),
      LOCAL_BACKEND_URL: settings.backendUrl,
    },
  };
}

function mergeCsvValues(value, requiredValue) {
  return [...new Set([
    ...String(value || "").split(","),
    String(requiredValue || ""),
  ].map((item) => item.trim()).filter(Boolean))].join(",");
}

const LOCAL_CHILD_RUNTIME_ENV_NAMES = new Set([
  "APPDATA",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS",
  "NODE_NO_WARNINGS",
  "NODE_OPTIONS",
  "NO_COLOR",
  "NUMBER_OF_PROCESSORS",
  "OCG_ENGINE_REQUEST_TIMEOUT_MS",
  "OCG_ENGINE_SNAPSHOT",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "UV_THREADPOOL_SIZE",
  "WINDIR",
  "WT_SESSION",
]);

function createLocalChildRuntimeEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env || {}).filter(([name]) => (
      LOCAL_CHILD_RUNTIME_ENV_NAMES.has(String(name).toUpperCase())
    )),
  );
}

export async function probeEngineHealth({
  engineUrl,
  engineToken = "",
  fetchImpl = globalThis.fetch,
  timeoutMs = 1_000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${engineUrl}/health`, {
      headers: engineToken ? { authorization: `Bearer ${engineToken}` } : {},
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // A listener returning non-JSON is not the OCG engine.
    }
    return { reachable: true, status: response.status, ok: response.ok, payload };
  } catch (error) {
    return { reachable: false, status: null, ok: false, payload: null, error };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeLegacyLuaCapabilities({
  engineUrl,
  engineToken = "",
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(
      `${engineUrl}/formal/v1/legacy-lua/capabilities`,
      {
        headers: engineToken ? { authorization: `Bearer ${engineToken}` } : {},
        signal: controller.signal,
      },
    );
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // A listener returning non-JSON does not implement the negotiated API.
    }
    return { reachable: true, status: response.status, ok: response.ok, payload };
  } catch (error) {
    return { reachable: false, status: null, ok: false, payload: null, error };
  } finally {
    clearTimeout(timer);
  }
}

export function assertCompatibleEngineHealth(probe, expectedProfile) {
  if (!probe?.reachable) throw new Error("OCG engine is not reachable");
  if (probe.status === 401) {
    throw new Error("OCG engine rejected OCG_ENGINE_TOKEN; close the old engine or set its matching token");
  }
  if (!probe.ok || probe.payload?.ok !== true || probe.payload?.service !== "ocg-engine") {
    throw new Error("the configured engine URL is occupied by an incompatible or unhealthy service");
  }
  const actualProfile = String(probe.payload?.profile?.id || probe.payload?.profile?.sourceId || "").trim();
  if (actualProfile && actualProfile !== expectedProfile) {
    throw new Error(`OCG engine profile mismatch: expected ${expectedProfile}, received ${actualProfile}`);
  }
  return probe.payload;
}

export function assertCompatibleLegacyLuaCapabilities(probe) {
  if (!probe?.reachable) throw new Error("legacy Lua capability API is not reachable");
  if (probe.status === 401) {
    throw new Error("legacy Lua capability API rejected OCG_ENGINE_TOKEN");
  }
  const payload = probe.payload;
  if (!probe.ok
    || payload?.ok !== true
    || payload?.schemaVersion !== "ocg-legacy-lua-http-capabilities/v1"
    || payload?.kind !== "LEGACY_LUA_HTTP_CAPABILITIES"
    || payload?.authority !== "LEGACY_DISCOVERY_ONLY"
    || payload?.verdict !== "UNKNOWN"
    || payload?.legacyAcceptedAsTruth !== false) {
    throw new Error("the configured engine does not expose a compatible legacy Lua capability API");
  }
  const cardIdentities = payload?.endpoints?.cardIdentities;
  if (cardIdentities?.path !== "/formal/v1/legacy-lua/card-identities"
    || cardIdentities?.method !== "POST"
    || payload?.sourceResolution?.lockedExactCardNames !== true) {
    throw new Error("the configured engine lacks locked exact-name legacy Lua resolution");
  }
  return payload;
}

export async function isTcpPortListening({ host = "127.0.0.1", port, timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function runLocalStack({ env = process.env } = {}) {
  const settings = resolveLocalStackSettings(env);
  await access(settings.engineEntry);

  // Check all user-facing ports before starting any child. This prevents a
  // half-started stack when an old backend or frontend is still listening.
  const [backendBusy, frontendBusy] = await Promise.all([
    isTcpPortListening({ port: settings.backendPort }),
    isTcpPortListening({ port: settings.frontendPort }),
  ]);
  if (backendBusy) throw localPortError("backend", settings.backendPort);
  if (frontendBusy) throw localPortError("frontend", settings.frontendPort);

  const configuredToken = String(env.OCG_ENGINE_TOKEN || "").trim();
  const localEngine = isLocalEngineUrl(settings.engineUrl, settings.enginePort);
  const initialEngineProbe = await probeEngineHealth({
    engineUrl: settings.engineUrl,
    engineToken: configuredToken,
  });
  const children = new Map();
  let ownsEngine = false;
  let engineToken = configuredToken;

  try {
    if (initialEngineProbe.reachable) {
      assertCompatibleEngineHealth(initialEngineProbe, settings.engineProfile);
      const capabilities = await probeLegacyLuaCapabilities({
        engineUrl: settings.engineUrl,
        engineToken: configuredToken,
      });
      assertCompatibleLegacyLuaCapabilities(capabilities);
      console.log(`Using existing OCG engine: ${settings.engineUrl}`);
    } else {
      if (!localEngine) {
        throw new Error(`configured OCG engine is unreachable: ${settings.engineUrl}`);
      }
      if (await isTcpPortListening({ port: settings.enginePort })) {
        throw localPortError("engine", settings.enginePort);
      }
      engineToken ||= createManagedEngineToken();
      const childEnvs = createLocalStackChildEnvironments({ env, settings, engineToken });
      const engine = startChild(children, "engine", process.execPath, [
        settings.engineEntry,
        "--port", String(settings.enginePort),
        "--profile", settings.engineProfile,
      ], { cwd: settings.engineRoot, env: childEnvs.engine });
      ownsEngine = true;
      await waitForHttpService({
        name: "OCG engine",
        child: engine,
        timeoutMs: readPositiveInteger(env.OCG_ENGINE_STARTUP_TIMEOUT_MS, 180_000),
        probe: async () => {
          const result = await probeEngineHealth({
            engineUrl: settings.engineUrl,
            engineToken,
          });
          if (!result.reachable) return false;
          assertCompatibleEngineHealth(result, settings.engineProfile);
          const capabilities = await probeLegacyLuaCapabilities({
            engineUrl: settings.engineUrl,
            engineToken,
          });
          if (!capabilities.reachable) return false;
          assertCompatibleLegacyLuaCapabilities(capabilities);
          return true;
        },
      });
    }

    const childEnvs = createLocalStackChildEnvironments({ env, settings, engineToken });
    const backend = startChild(children, "backend", process.execPath, [
      path.join(projectRoot, "backend", "server.mjs"),
    ], { cwd: projectRoot, env: childEnvs.backend });
    await waitForHttpService({
      name: "ruling backend",
      child: backend,
      timeoutMs: readPositiveInteger(env.LOCAL_BACKEND_STARTUP_TIMEOUT_MS, 30_000),
      probe: () => probeExpectedJson(`${settings.backendUrl}/health`, (payload) => payload?.ok === true),
    });

    const frontend = startChild(children, "frontend", process.execPath, [
      path.join(projectRoot, "scripts", "serve.mjs"),
    ], { cwd: projectRoot, env: childEnvs.frontend });
    await waitForHttpService({
      name: "ruling frontend",
      child: frontend,
      timeoutMs: readPositiveInteger(env.LOCAL_FRONTEND_STARTUP_TIMEOUT_MS, 10_000),
      probe: () => probeExpectedText(`${settings.frontendUrl}/`, "游戏王 OCG AI裁定"),
    });
  } catch (error) {
    for (const child of children.values()) child.kill("SIGTERM");
    throw error;
  }

  console.log("");
  console.log(`Ready: ${settings.frontendUrl}/`);
  console.log(`Backend: ${settings.backendUrl}`);
  console.log(`Engine: ${settings.engineUrl}${ownsEngine ? " (managed)" : " (reused)"}`);
  console.log(`Relay: ${String(env.RELAY_API_KEY || "").trim() ? "configured" : "not configured"}`);
  console.log("Press Ctrl+C once to stop this local stack.");

  let stopping = false;
  const stop = (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    for (const [name, child] of children) {
      if (name === "engine" && !ownsEngine) continue;
      child.kill("SIGTERM");
    }
  };
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
  for (const [name, child] of children) {
    child.once("exit", (code, signal) => {
      children.delete(name);
      if (!stopping) {
        console.error(`${name} exited unexpectedly (${signal || code || 0})`);
        stop(code || 1);
      }
    });
  }
}

function startChild(children, name, command, args, options) {
  const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
  children.set(name, child);
  return child;
}

async function waitForHttpService({ name, child, probe, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${name} exited before becoming ready`);
    }
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${name}`);
}

async function probeExpectedJson(url, predicate) {
  try {
    const response = await fetch(url);
    const payload = await response.json();
    return response.ok && predicate(payload);
  } catch {
    return false;
  }
}

async function probeExpectedText(url, marker) {
  try {
    const response = await fetch(url);
    return response.ok && (await response.text()).includes(marker);
  } catch {
    return false;
  }
}

function localPortError(service, port) {
  const error = new Error(
    `${service} port ${port} is already in use. Close the previous local stack with Ctrl+C, then run this command again.`,
  );
  error.code = "LOCAL_STACK_PORT_IN_USE";
  return error;
}

function isLocalEngineUrl(value, expectedPort) {
  const url = new URL(value);
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  const actualPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return localHost && actualPort === expectedPort;
}

function normalizeHttpUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("OCG_ENGINE_URL must use http or https");
  return url.toString().replace(/\/+$/u, "");
}

function readPort(value, fallback, name) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${name} must be a valid TCP port`);
  return parsed;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value || fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runLocalStack().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
