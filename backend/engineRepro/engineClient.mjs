// Engine access for the reproduction section. Production: the engine HTTP service
// (ENGINE_REPRO_URL + ENGINE_REPRO_SECRET). Local batch: the same operations through
// `python3 -m ocgrepro api` in an ocg-sim-core checkout. Both return the operation's JSON body.
import { spawn } from "node:child_process";

export function createHttpEngineClient({ baseUrl, secret, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  const root = String(baseUrl || "").replace(/\/+$/u, "");
  if (!/^https?:\/\//u.test(root)) throw Object.assign(new Error("engine_repro_url_invalid"), { code: "engine_repro_not_configured" });
  const engine = async function engine(op, body) {
    const response = await fetchImpl(`${root}/v1/${op}`, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", "x-engine-secret": String(secret || "") },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* reported below */ }
    if (!response.ok || !payload?.ok) {
      throw Object.assign(new Error(`engine_http_${response.status}${payload?.error ? `:${payload.error}` : ""}`),
        { code: response.status === 429 ? "engine_busy" : "engine_unavailable", httpStatus: response.status });
    }
    return payload;
  };
  engine.cacheKey = `http:${root}`;
  return engine;
}

// Wake the engine service (Cloud Run cold start) without waiting for it; GET /health needs no secret.
export function warmHttpEngine({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
  const root = String(baseUrl || "").replace(/\/+$/u, "");
  if (!/^https?:\/\//u.test(root)) return Promise.resolve(false);
  return Promise.resolve()
    .then(() => fetchImpl(`${root}/health`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) }))
    .then((response) => Boolean(response?.ok), () => false);
}

export function createLocalEngineClient({ repo, root }) {
  const engine = function engine(op, body) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn("python3", ["-m", "ocgrepro", "api"], { cwd: repo,
        env: { PATH: process.env.PATH, OCG_REPRO_ROOT: root, LANG: "C.UTF-8" } });
      const chunks = [];
      const errors = [];
      child.stdout.on("data", (c) => chunks.push(c));
      child.stderr.on("data", (c) => errors.push(c));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`engine api failed (${code}): ${Buffer.concat(errors).toString().slice(-800)}`));
        try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); }
      });
      child.stdin.end(JSON.stringify({ ...body, op }));
    });
  };
  engine.cacheKey = `local:${repo}:${root}`;
  return engine;
}
