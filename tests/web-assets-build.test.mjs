import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

async function runProductionLoadAppConfig(payload, href) {
  const appSource = await readFile("src/app.js", "utf8");
  const start = appSource.indexOf("async function loadAppConfig()");
  const end = appSource.indexOf("async function loadBackendModelInfo()", start);
  assert.ok(start >= 0 && end > start, "loadAppConfig must remain directly testable");
  const context = vm.createContext({
    URL,
    window: { location: { href } },
    document: { body: { classList: { toggle() {} } }, title: "" },
    ui: { deploymentLabel: null },
    readOptionalJson: async () => payload,
    fallbackRulingModelProfiles: () => ({}),
  });
  vm.runInContext(`
    const DEFAULT_RULING_MODEL_PROFILE = "test-profile";
    const PAGE_TITLE = "Test";
    let appConfig = {};
    function getBudgetApiUrl() { return ""; }
    ${appSource.slice(start, end)}
  `, context);
  await vm.runInContext("loadAppConfig()", context);
  return vm.runInContext("JSON.parse(JSON.stringify(appConfig))", context);
}

test("Vercel environment serves API routes from the visited deployment", async () => {
  const target = await mkdtemp(path.join(tmpdir(), "ocg-web-origin-"));
  try {
    execFileSync(process.execPath, ["scripts/build-web-assets.mjs", target], {
      env: { ...process.env, VERCEL: "1", VERCEL_GIT_COMMIT_SHA: "7f4a19ab21b31074cd16d20585c9d6f8e8ab4251" },
    });
    const config = JSON.parse((await readFile(path.join(target, "config.json"), "utf8")).replace(/^\uFEFF/u, ""));
    assert.equal(config.answerApiUrl, "/api/answer");
    assert.equal(config.budgetApiUrl, "/api/budget");
    assert.equal(config.adminPageUrl, "/?admin=1");
  } finally {
    assert.equal(path.dirname(path.resolve(target)), path.resolve(tmpdir()));
    await rm(target, { recursive: true, force: true });
  }
});

test("production config loader binds relative endpoints to the visited preview origin", async () => {
  const preview = await runProductionLoadAppConfig({
    answerApiUrl: "/api/answer",
    budgetApiUrl: "/api/budget",
    adminPageUrl: "/?admin=1",
  }, "https://preview-123.example.vercel.app/path/index.html");
  assert.equal(preview.answerApiUrl, "https://preview-123.example.vercel.app/api/answer");
  assert.equal(preview.budgetApiUrl, "https://preview-123.example.vercel.app/api/budget");
  assert.equal(preview.adminPageUrl, "https://preview-123.example.vercel.app/?admin=1");

  const pages = await runProductionLoadAppConfig({
    answerApiUrl: "https://ocg-ruling-assistant.vercel.app/api/answer",
    budgetApiUrl: "https://ocg-ruling-assistant.vercel.app/api/budget",
    adminPageUrl: "https://ocg-ruling-assistant.vercel.app/?admin=1",
  }, "https://coldiceh.github.io/ocg-ruling-assistant/");
  assert.equal(pages.answerApiUrl, "https://ocg-ruling-assistant.vercel.app/api/answer");
  assert.equal(pages.budgetApiUrl, "https://ocg-ruling-assistant.vercel.app/api/budget");
  assert.equal(pages.adminPageUrl, "https://ocg-ruling-assistant.vercel.app/?admin=1");
});

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
