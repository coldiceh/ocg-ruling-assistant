import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const engineRoot = path.resolve(process.env.OCG_ENGINE_ROOT || path.resolve(projectRoot, "..", "游戏王游戏引擎"));
const engineEntry = path.join(engineRoot, "tools", "serve.mjs");
await access(engineEntry);

const enginePort = Number(process.env.OCG_ENGINE_PORT || 8790);
const engineUrl = process.env.OCG_ENGINE_URL || "http://127.0.0.1:" + enginePort;
const children = new Set();

function start(command, args, options) {
  const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

const engine = start(process.execPath, [
  engineEntry, "--port", String(enginePort), "--profile", process.env.OCG_ENGINE_PROFILE || "ygopro",
], {
  cwd: engineRoot,
  env: { ...process.env, OCG_ENGINE_ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || "*" },
});

async function waitForEngine() {
  const deadline = Date.now() + Number(process.env.OCG_ENGINE_STARTUP_TIMEOUT_MS || 180_000);
  while (Date.now() < deadline) {
    if (engine.exitCode !== null) throw new Error("OCG engine exited before becoming ready");
    try {
      const response = await fetch(engineUrl + "/health", {
        headers: process.env.OCG_ENGINE_TOKEN ? { authorization: "Bearer " + process.env.OCG_ENGINE_TOKEN } : {},
      });
      if (response.ok) return;
    } catch {
      // The native host may still be verifying its immutable resource snapshot.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("timed out waiting for OCG engine at " + engineUrl);
}

await waitForEngine();
const backend = start(process.execPath, [path.join(projectRoot, "backend", "server.mjs")], {
  cwd: projectRoot,
  env: { ...process.env, OCG_ENGINE_URL: engineUrl },
});

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = exitCode;
}
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
engine.once("exit", (code) => {
  if (!stopping) {
    console.error("OCG engine exited:", code);
    stop(code || 1);
  }
});
backend.once("exit", (code) => {
  if (!stopping) stop(code || 0);
});
