import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readWorkflow = (name) =>
  readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
const readPublication = () =>
  readFile(new URL("../scripts/publish-synced-snapshot.sh", import.meta.url), "utf8");

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
  const publication = await readPublication();

  assert.match(workflow, /^permissions: \{\}\s*$/mu);
  assert.match(workflow, /^      contents: write\s*$/mu);
  assert.match(workflow, /^      data_changed: \$\{\{ steps\.commit\.outputs\.data_changed \}\}\s*$/mu);
  const checkoutStep = workflow.match(
    /- name: Checkout[\s\S]*?(?=\n\s+- name:)/u,
  )?.[0] || "";
  assert.match(checkoutStep, /ref: refs\/heads\/main/u);
  assert.match(workflow, /run: bash scripts\/publish-synced-snapshot\.sh/u);
  assert.match(publication, /git fetch --no-tags origin refs\/heads\/main/u);
  assert.match(publication, /checked_out_main="\$\(git rev-parse HEAD\)"/u);
  assert.match(publication, /git merge-base --is-ancestor "\$checked_out_main" "\$remote_main"/u);
  assert.match(publication, /rebase --onto "\$remote_main" "\$checked_out_main"/u);
  assert.match(publication, /git merge-base --is-ancestor "\$remote_main" HEAD/u);
  assert.match(publication, /git push origin HEAD:refs\/heads\/main[\s\S]*echo "data_changed=true" >> "\$GITHUB_OUTPUT"/u);
  assert.doesNotMatch(publication, /git push[^\n]*(?:--force|\s-f\b)/u);
  assert.match(publication, /echo "data_changed=false" >> "\$GITHUB_OUTPUT"/u);
  assert.match(workflow, /^    if: needs\.sync\.outputs\.data_changed == 'true'\s*$/mu);
  assert.match(workflow, /^    uses: \.\/\.github\/workflows\/deploy-pages\.yml\s*$/mu);
  assert.match(workflow, /^      checkout_ref: main\s*$/mu);
  assert.match(workflow, /^      pages: write\s*$/mu);
  assert.match(workflow, /^      id-token: write\s*$/mu);
});

test("data sync rebuilds and commits the versioned RAG runtime before synchronization checks", async () => {
  const workflow = await readWorkflow("sync-data.yml");
  const publication = await readPublication();
  const evidence = workflow.indexOf("pnpm build:evidence");
  const revision = workflow.indexOf("pnpm build:rag-revision");
  const runtime = workflow.indexOf("pnpm build:rag-runtime");
  const verifyRuntime = workflow.indexOf("pnpm check:rag-runtime");
  const parity = workflow.indexOf("tests/rag-runtime-parity.test.mjs");
  const snapshotTests = workflow.indexOf("id: snapshot_tests");

  assert.ok(evidence >= 0 && evidence < revision);
  assert.ok(revision < runtime && runtime < verifyRuntime);
  assert.ok(verifyRuntime < parity && parity < snapshotTests);
  assert.match(publication, /git add -u -- data/u);
  assert.match(publication, /git add data\/\*\.json data\/\*\.json\.gz data\/rag-runtime-v1\/\*\* data\/cloud-evidence-v1\/\*\*/u);
  assert.match(workflow, /cp data\/cards-lite\.json data\/snapshot-meta\.json public\/data\//u);
  const snapshotDiff = workflow.indexOf("pnpm diff:rulings");
  const publicCopy = workflow.indexOf("cp data/cards-lite.json data/snapshot-meta.json public/data/");
  assert.ok(snapshotDiff >= 0 && snapshotDiff < publicCopy && publicCopy < snapshotTests,
    "public metadata must be copied after the current snapshot diff is written");
  const metadata = await readFile(new URL("../data/snapshot-meta.json", import.meta.url), "utf8");
  const publicMetadata = await readFile(new URL("../public/data/snapshot-meta.json", import.meta.url), "utf8");
  assert.equal(publicMetadata.replaceAll("\r\n", "\n"), metadata.replaceAll("\r\n", "\n"));
});

test("data sync runs the bounded synchronization checks and keeps the complete suite separate", async () => {
  const workflow = await readWorkflow("sync-data.yml");
  const previewWorkflow = await readWorkflow("validate-preview.yml");
  const syncTests = [
    "tests/sync-ygoresources-selection.test.mjs",
    "tests/sync-ocg-rule.test.mjs",
    "tests/source-freshness.test.mjs",
    "tests/rag-data-source-file.test.mjs",
    "tests/rag-data-revision-manifest.test.mjs",
    "tests/rag-runtime-bundle.test.mjs",
    "tests/rag-runtime-deployment-safety.test.mjs",
    "tests/gemini-qa-tools.test.mjs",
    "tests/gemini-rule-qa-assets.test.mjs",
    "tests/cloud-evidence-assets.test.mjs",
    "tests/cloud-evidence-incremental-sync.test.mjs",
    "tests/evidence-vector-index.test.mjs",
    "tests/deployment-workflows.test.mjs",
    "tests/sync-snapshot-publication.test.mjs",
  ];
  const targetedCommand = [
    "node --test --test-concurrency=1",
    ...syncTests,
  ].join(" ");

  assert.match(workflow, new RegExp(targetedCommand.replaceAll(".", "\\."), "u"));
  const targeted = workflow.indexOf(targetedCommand);
  const parity = workflow.indexOf("tests/rag-runtime-parity.test.mjs");
  assert.ok(parity >= 0 && parity < targeted);
  assert.equal(workflow.indexOf("run: pnpm test"), -1);
  assert.match(previewWorkflow, /node --test --test-force-exit --test-concurrency=1/u);
  assert.match(previewWorkflow, /--test-isolation=none/u);
  assert.match(previewWorkflow, /--test-reporter=spec/u);
});

test("concurrent publication rechecks the combined snapshot and retains the original tree on failure", async () => {
  const workflow = await readWorkflow("sync-data.yml");
  const publication = await readPublication();
  const rebase = publication.indexOf('rebase --onto "$remote_main" "$checked_out_main"');
  const push = publication.indexOf("git push origin HEAD:refs/heads/main");
  for (const check of [
    "pnpm install --frozen-lockfile", "pnpm check:data", "pnpm check:freshness", "pnpm check\n",
    "--check-only", "tests/rag-runtime-parity.test.mjs", "tests/sync-snapshot-publication.test.mjs",
    "git diff --exit-code", "git diff --cached --exit-code",
  ]) {
    const index = publication.indexOf(check);
    assert.ok(rebase >= 0 && index > rebase && index < push, `${check} must run after rebase and before push`);
  }
  assert.match(publication, /echo "snapshot_commit=\$snapshot_commit" >> "\$GITHUB_OUTPUT"/u);
  assert.ok(publication.indexOf('echo "snapshot_commit=') < publication.indexOf("git fetch"));
  assert.match(workflow, /failure\(\) && steps\.commit\.outputs\.snapshot_commit != ''/u);
  assert.match(workflow, /SNAPSHOT_COMMIT: \$\{\{ steps\.commit\.outputs\.snapshot_commit \}\}/u);
  assert.match(workflow, /git archive[^\n]*unpublished-synced-rag-data\.tar[\s\S]*"\$SNAPSHOT_COMMIT" -- data public\/data\/cards-lite\.json public\/data\/snapshot-meta\.json/u);
  assert.ok(workflow.indexOf("name: Preserve the unpublished generated snapshot") > workflow.indexOf("id: commit"));
});

test("a failed but validated synchronized snapshot is retained briefly for diagnosis", async () => {
  const workflow = await readWorkflow("sync-data.yml");
  const tests = workflow.indexOf("id: snapshot_tests");
  const artifact = workflow.indexOf("uses: actions/upload-artifact@v4");
  const commit = workflow.indexOf("id: commit");

  assert.ok(tests >= 0 && tests < artifact && artifact < commit);
  assert.match(workflow, /steps\.data_validation\.outcome == 'success'/u);
  assert.match(workflow, /steps\.runtime_validation\.outcome == 'success'/u);
  assert.match(workflow, /steps\.runtime_parity\.outcome == 'success'/u);
  assert.match(workflow, /steps\.source_check\.outcome == 'success'/u);
  assert.match(workflow, /steps\.snapshot_tests\.outcome == 'failure'/u);
  assert.match(workflow, /retention-days: 1/u);
  assert.match(workflow, /data\/\*\.json[\s\S]*data\/rag-runtime-v1\/\*\*/u);
});

test("the ordinary repository check rejects stale revision and runtime artifacts", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const check = String(packageJson.scripts?.check || "");

  assert.match(check, /pnpm run check:rag-revision/u);
  assert.match(check, /pnpm run check:rag-runtime/u);
  assert.ok(check.indexOf("check:rag-revision") < check.indexOf("node --check"));
  assert.ok(check.indexOf("check:rag-runtime") < check.indexOf("node --check"));
});

test("Vercel verifies source, runtime, and cloud asset bindings before deployment", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

  assert.equal(
    config.buildCommand,
    "pnpm run check:rag-revision && pnpm run check:rag-runtime && pnpm run build:gemini-rule-qa && node scripts/sync-cloud-evidence-assets.mjs --data-dir data --cloud-dir data/cloud-evidence-v1 --check-only && node scripts/build-public-release.mjs",
  );
  assert.equal(config.outputDirectory, "public");
  assert.equal(
    (await readFile(new URL("../public/.gitkeep", import.meta.url), "utf8")).replaceAll("\r\n", "\n"),
    "\n",
  );
  for (const route of ["api/answer.js", "api/admin-model-lab.js"]) {
    const excluded = String(config.functions?.[route]?.excludeFiles || "");
    assert.match(excluded, /data\/\{cards,rulings,qa-index,evidence-index,ocg-rule-corpus,official-responses\}\.json/u);
    assert.match(excluded, /data\/evidence-index\.json\.gz/u);
    assert.doesNotMatch(excluded, /rag-data-revision-manifest|rag-runtime-v1|legacy-lua-semantic-cache-v2/u);
  }
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
