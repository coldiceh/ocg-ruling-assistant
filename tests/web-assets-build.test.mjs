import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("Vercel static build publishes the current admin UI and release identity", async () => {
  const target = await mkdtemp(path.join(tmpdir(), "ocg-web-assets-"));
  try {
    execFileSync(process.execPath, ["scripts/build-web-assets.mjs", target]);
    for (const file of ["index.html", "config.json", "src/app.js", "src/styles.css", "src/uiPresentation.mjs", "data/cards-lite.json"]) {
      assert.deepEqual(await readFile(path.join(target, file)), await readFile(file), file);
    }
    const release = JSON.parse(await readFile(path.join(target, "data/release.json"), "utf8"));
    assert.equal(release.commit, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  } finally {
    assert.equal(path.dirname(path.resolve(target)), path.resolve(tmpdir()));
    await rm(target, { recursive: true, force: true });
  }
});
