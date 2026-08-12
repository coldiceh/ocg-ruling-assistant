import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readWorkflow = (name) =>
  readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

test("pages workflow is reusable and can publish an explicit ref", async () => {
  const workflow = await readWorkflow("deploy-pages.yml");

  assert.match(workflow, /^  workflow_call:\s*$/mu);
  assert.match(workflow, /^      checkout_ref:\s*$/mu);
  assert.match(workflow, /ref: \$\{\{ inputs\.checkout_ref \|\| github\.sha \}\}/u);
  assert.match(workflow, /^  group: pages\s*$/mu);
  assert.match(workflow, /^  pages: write\s*$/mu);
  assert.match(workflow, /^  id-token: write\s*$/mu);
});

test("successful data pushes explicitly call the Pages workflow", async () => {
  const workflow = await readWorkflow("sync-data.yml");

  assert.match(workflow, /^permissions: \{\}\s*$/mu);
  assert.match(workflow, /^      contents: write\s*$/mu);
  assert.match(workflow, /^      data_changed: \$\{\{ steps\.commit\.outputs\.data_changed \}\}\s*$/mu);
  assert.match(workflow, /git push origin HEAD:main[\s\S]*echo "data_changed=true" >> "\$GITHUB_OUTPUT"/u);
  assert.match(workflow, /echo "data_changed=false" >> "\$GITHUB_OUTPUT"/u);
  assert.match(workflow, /^    if: needs\.sync\.outputs\.data_changed == 'true'\s*$/mu);
  assert.match(workflow, /^    uses: \.\/\.github\/workflows\/deploy-pages\.yml\s*$/mu);
  assert.match(workflow, /^      checkout_ref: main\s*$/mu);
  assert.match(workflow, /^      pages: write\s*$/mu);
  assert.match(workflow, /^      id-token: write\s*$/mu);
});

test("data sync rebuilds and commits the versioned RAG runtime before snapshot tests", async () => {
  const workflow = await readWorkflow("sync-data.yml");
  const evidence = workflow.indexOf("pnpm build:evidence");
  const revision = workflow.indexOf("pnpm build:rag-revision");
  const runtime = workflow.indexOf("pnpm build:rag-runtime");
  const verifyRuntime = workflow.indexOf("pnpm check:rag-runtime");
  const parity = workflow.indexOf("tests/rag-runtime-parity.test.mjs");
  const snapshotTests = workflow.indexOf("pnpm test");

  assert.ok(evidence >= 0 && evidence < revision);
  assert.ok(revision < runtime && runtime < verifyRuntime);
  assert.ok(verifyRuntime < parity && parity < snapshotTests);
  assert.match(workflow, /git add data\/\*\.json data\/rag-runtime-v1\/\*\*/u);
});

test("the ordinary repository check rejects stale revision and runtime artifacts", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const check = String(packageJson.scripts?.check || "");

  assert.match(check, /pnpm run check:rag-revision/u);
  assert.match(check, /pnpm run check:rag-runtime/u);
  assert.ok(check.indexOf("check:rag-revision") < check.indexOf("node --check"));
  assert.ok(check.indexOf("check:rag-runtime") < check.indexOf("node --check"));
});

test("Vercel runs the revision and runtime verification as its actual build gate", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

  assert.equal(
    config.buildCommand,
    "pnpm run check:rag-revision && pnpm run check:rag-runtime",
  );
});

test("RAG source snapshots are checked out with stable LF line endings", async () => {
  const attributes = await readFile(new URL("../.gitattributes", import.meta.url), "utf8");
  for (const path of [
    "cards.json",
    "rulings.json",
    "qa-index.json",
    "evidence-index.json",
    "ocg-rule-corpus.json",
    "official-responses.json",
  ]) {
    assert.match(attributes, new RegExp(`^/data/${path.replaceAll(".", "\\.")} text eol=lf$`, "mu"));
  }
});
