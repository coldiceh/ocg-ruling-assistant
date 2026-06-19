import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

await run(join(rootDir, "scripts", "sync-ygoresources.mjs"));
await run(join(rootDir, "scripts", "check-data.mjs"));

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: rootDir,
      env: {
        ...process.env,
        SYNC_ALL_RELEASED_CARDS: process.env.SYNC_ALL_RELEASED_CARDS || "false",
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}
