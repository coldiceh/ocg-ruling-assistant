import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Both hosts serve the canonical frontend; never deploy the stale public/ copy.
const destination = path.resolve(process.argv[2] || "public");
mkdirSync(path.join(destination, "data"), { recursive: true });
for (const entry of ["assets", "src", "index.html", "config.json", ".nojekyll",
  "data/cards-lite.json", "data/snapshot-meta.json"]) {
  cpSync(entry, path.join(destination, entry), { recursive: true });
}
if (process.env.VERCEL === "1") {
  const configFile = path.join(destination, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8").replace(/^\uFEFF/u, ""));
  writeFileSync(configFile, JSON.stringify({ ...config,
    answerApiUrl: "/api/answer", budgetApiUrl: "/api/budget", adminPageUrl: "/?admin=1",
  }, null, 2) + "\n");
}
execFileSync(process.execPath, ["scripts/build-public-release.mjs", path.join(destination, "data/release.json")]);
