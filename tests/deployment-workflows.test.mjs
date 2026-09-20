import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const readWorkflow = (name) =>
  readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
const readPublication = () =>
  readFile(new URL("../scripts/publish-synced-snapshot.sh", import.meta.url), "utf8");

function expandBraces(pattern) {
  const start = pattern.indexOf("{");
  if (start < 0) return [pattern];
  let depth = 0;
  let end = -1;
  for (let index = start; index < pattern.length; index += 1) {
    if (pattern[index] === "{") depth += 1;
    if (pattern[index] === "}") depth -= 1;
    if (depth === 0) {
      end = index;
      break;
    }
  }
  assert.ok(end > start, `unclosed brace glob: ${pattern}`);
  const choices = [];
  let choiceStart = start + 1;
  depth = 0;
  for (let index = choiceStart; index < end; index += 1) {
    if (pattern[index] === "{") depth += 1;
    if (pattern[index] === "}") depth -= 1;
    if (pattern[index] === "," && depth === 0) {
      choices.push(pattern.slice(choiceStart, index));
      choiceStart = index + 1;
    }
  }
  choices.push(pattern.slice(choiceStart, end));
  return choices.flatMap((choice) => expandBraces(
    `${pattern.slice(0, start)}${choice}${pattern.slice(end + 1)}`,
  ));
}

function globMatches(file, pattern) {
  const expression = pattern.replace(/[.+^$()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${expression}$`, "u").test(file);
}

async function listFiles(relativeDirectory) {
  const root = new URL(`../${relativeDirectory}/`, import.meta.url);
  const files = [];
  async function visit(directory, prefix = relativeDirectory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(new URL(`${entry.name}/`, directory), relative);
      else files.push(relative);
    }
  }
  await visit(root);
  return files;
}

function matchedFiles(files, includeGlob, excludeGlob) {
  const includes = expandBraces(includeGlob);
  const excludes = expandBraces(excludeGlob);
  return files.filter((file) => includes.some((pattern) => globMatches(file, pattern))
    && !excludes.some((pattern) => globMatches(file, pattern))).sort();
}

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
  const refresh = workflow.indexOf("node scripts/sync-bounded-evidence-assets.mjs");
  const promotion = workflow.indexOf("name: Promote verified bounded evidence assets");
  const geminiVerify = workflow.indexOf("--stage verify");
  assert.ok(refresh > revision && refresh < promotion && promotion < geminiVerify && geminiVerify < runtime,
    "source sync must refresh navigation and vectors, promote the complete asset set, then verify before building runtime");
  assert.match(workflow, /--cloud[\s\S]*?--execute/u);
  assert.match(workflow, /vars\.EVIDENCE_PREPROCESS_MAX_USD/u);
  assert.match(workflow, /secrets\.GEMINI_RULE_QA_API_KEY/u);
  assert.match(workflow, /secrets\.BAI_API_KEY/u);
  assert.match(workflow, /report\.publishable !== true/u);
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
    "tests/sync-bounded-evidence-assets.test.mjs",
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
  assert.match(previewWorkflow, /node scripts\/run-free-tests\.mjs/u);
  assert.doesNotMatch(previewWorkflow, /--test-isolation=none/u);
});

test("concurrent publication rechecks the combined snapshot and retains the original tree on failure", async () => {
  const workflow = await readWorkflow("sync-data.yml");
  const publication = await readPublication();
  const rebase = publication.indexOf('rebase --onto "$remote_main" "$checked_out_main"');
  const push = publication.indexOf("git push origin HEAD:refs/heads/main");
  for (const check of [
    "pnpm install --frozen-lockfile", "pnpm check:data", "pnpm check:freshness", "pnpm check\n",
    "--check-only", "--stage verify", "tests/rag-runtime-parity.test.mjs", "tests/sync-snapshot-publication.test.mjs",
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

test("Vercel verifies the source, runtime, and enabled Gemini asset bindings before deployment", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const syncWorkflow = await readWorkflow("sync-data.yml");
  const publication = await readPublication();
  assert.ok(config.buildCommand.length <= 256, "Vercel schema limits buildCommand to 256 characters");
  assert.equal(config.buildCommand, "pnpm run build:vercel");

  assert.equal(
    packageJson.scripts["build:vercel"],
    "pnpm run check:rag-revision && pnpm run check:rag-runtime && pnpm run verify:gemini-rule-qa && node scripts/build-public-release.mjs && node scripts/build-web-assets.mjs",
  );
  assert.doesNotMatch(packageJson.scripts["build:vercel"], /cloud-evidence-v1/u);
  assert.match(syncWorkflow,
    /node scripts\/sync-cloud-evidence-assets\.mjs[\s\S]*?--cloud-dir data\/cloud-evidence-v1/u);
  assert.match(publication,
    /node scripts\/sync-cloud-evidence-assets\.mjs --data-dir data --cloud-dir data\/cloud-evidence-v1 --check-only/u);
  assert.equal(packageJson.scripts["verify:gemini-rule-qa"],
    "node scripts/build-gemini-rule-qa-assets.mjs --stage verify --data-dir data --output-dir data/gemini-rule-qa-v1");
  assert.equal(config.outputDirectory, "public");
  assert.equal(
    (await readFile(new URL("../public/.gitkeep", import.meta.url), "utf8")).replaceAll("\r\n", "\n"),
    "\n",
  );
  for (const [route, functionConfig] of Object.entries(config.functions || {})) {
    for (const field of ["includeFiles", "excludeFiles"]) {
      if (functionConfig[field] !== undefined) {
        assert.ok(
          String(functionConfig[field]).length <= 256,
          `${route}.${field} exceeds Vercel's 256-character schema limit`,
        );
      }
    }
  }
  const boundedAssetFiles = (await Promise.all([
    listFiles("data/gemini-rule-qa-v1"),
    listFiles("data/rule-embedding-v1"),
    listFiles("data/qa-embedding-v1"),
  ])).flat();
  const expectedBoundedAssets = [
    "data/gemini-rule-qa-v1/manifest.json",
    "data/gemini-rule-qa-v1/navigation-lexical-index.bm25.gz",
    "data/gemini-rule-qa-v1/navigation-records.json.gz",
    "data/gemini-rule-qa-v1/qa-lexical-index.bm25.gz",
    "data/gemini-rule-qa-v1/qa-records.json.gz",
    "data/gemini-rule-qa-v1/rule-records.json.gz",
    "data/gemini-rule-qa-v1/structure-mapping.release.json.gz",
    "data/qa-embedding-v1/evidence-vector-index.json",
    "data/qa-embedding-v1/evidence-vectors-000.f32",
    "data/rule-embedding-v1/evidence-vector-index.json",
    "data/rule-embedding-v1/evidence-vectors-000.f32",
  ].sort();
  for (const route of ["api/answer.js", "api/admin-model-lab.js"]) {
    const included = String(config.functions?.[route]?.includeFiles || "");
    const excluded = String(config.functions?.[route]?.excludeFiles || "");
    assert.match(included, /config\/evidence-generation\/(?:gemini-3\.8-flash-low\.json|\*\.json)/u);
    assert.match(included, /gemini-rule-qa-v1\/\*\*/u);
    assert.match(included, /\{rule,qa\}-embedding-v1\/\*\*/u);
    assert.deepEqual(
      matchedFiles(boundedAssetFiles, included, excluded),
      expectedBoundedAssets,
      `${route} must package exactly the seven Gemini runtime files and two files per dense index`,
    );
    assert.match(excluded, /data\/\{cards,rulings,qa-index,evidence-index,ocg-rule-corpus,official-responses\}\.json/u);
    assert.match(excluded, /data\/evidence-index\.json\.gz/u);
    assert.match(excluded, /canonical-manifest\.json/u);
    assert.match(excluded, /navigation-inputs\.json\.gz/u);
    assert.match(excluded, /dense-inputs\.json\.gz/u);
    assert.match(excluded, /structure-mapping\.json\.gz/u);
    assert.doesNotMatch(excluded, /rag-data-revision-manifest|rag-runtime-v1|legacy-lua-semantic-cache-v2/u);
  }
});

test("bounded preview refresh keeps dry-run free, resumes bounded cloud batches, and releases only when complete", async () => {
  const workflow = await readWorkflow("refresh-bounded-evidence-preview.yml");
  assert.match(workflow, /^      execute_preprocessing:\s*$/mu);
  assert.match(workflow, /^      navigation_resume_cursor:\s*$/mu);
  assert.match(workflow, /^        default: false\s*$/mu);
  assert.match(workflow, /^  contents: read\s*$/mu);
  assert.match(workflow, /github\.ref == 'refs\/heads\/codex\/bounded-evidence-preview-20260914'/u);
  assert.match(workflow, /github\.actor == github\.repository_owner/u);
  assert.match(workflow, /--stage canonical/u);
  assert.ok(workflow.indexOf("--stage canonical") < workflow.indexOf("--dry-run"));
  assert.match(workflow, /if: \$\{\{ !inputs\.execute_preprocessing \}\}[\s\S]*--dry-run/u);
  const dryStep = workflow.match(/- name: Dry-run navigation and embedding work without external calls[\s\S]*?(?=\n      - name:)/u)?.[0] || "";
  assert.match(dryStep, /--rule-generation-profile "\$RULE_GENERATION_PROFILE"[\s\S]*--dry-run/u);

  const navigationStep = workflow.match(/- name: Execute authorized cloud navigation batch[\s\S]*?(?=\n      - name:)/u)?.[0] || "";
  assert.match(navigationStep, /--job-runtime-ms 3600000/u);
  assert.match(navigationStep, /--request-timeout-ms 300000/u);
  assert.match(navigationStep, /--resume-cursor "\$NAVIGATION_RESUME_CURSOR"/u);
  assert.match(navigationStep, /--rule-generation-profile "\$RULE_GENERATION_PROFILE"/u);
  assert.match(navigationStep, /--cloud[\s\S]*--all-inputs[\s\S]*--execute/u);
  assert.match(navigationStep, /complete=.*p\.complete === true/u);
  assert.doesNotMatch(navigationStep, /refresh-gemini-source-embeddings|--stage release|--stage verify/u);

  const completeStep = workflow.match(/- name: Build and verify complete preprocessing release[\s\S]*?(?=\n      - name:)/u)?.[0] || "";
  assert.match(completeStep, /steps\.navigation\.outputs\.complete == 'true'/u);
  const embedding = completeStep.indexOf("refresh-gemini-source-embeddings.mjs");
  const release = completeStep.indexOf("--stage release");
  const verify = completeStep.indexOf("--stage verify");
  assert.ok(embedding >= 0 && embedding < release && release < verify,
    "only complete navigation may assemble and verify release assets");
  assert.match(completeStep, /--navigation "\$EVIDENCE_STAGING\/gemini-rule-qa-v1\/navigation-records\.json\.gz"/u);
  assert.match(completeStep, /--rule-dense-dir "\$EVIDENCE_STAGING\/rule-embedding-v1"/u);
  assert.match(completeStep, /--qa-dense-dir "\$EVIDENCE_STAGING\/qa-embedding-v1"/u);

  const assetArtifact = workflow.match(/- name: Upload verified preprocessing release assets[\s\S]*$/u)?.[0] || "";
  assert.match(assetArtifact, /steps\.navigation\.outputs\.complete == 'true'/u);
  assert.ok(assetArtifact.includes("${{ env.EVIDENCE_STAGING }}/**"));
  assert.doesNotMatch(assetArtifact, /EVIDENCE_CACHE|ledger|provider-raw|secret/iu);
  assert.match(workflow, /navigation-records\.partial\.json\.gz/u);
  for (const name of [
    "EVIDENCE_PREPROCESS_AUTHORIZATION_ID",
    "EVIDENCE_PREPROCESS_LEDGER_KEY",
    "EVIDENCE_PREPROCESS_CACHE_NAMESPACE",
    "EVIDENCE_PREPROCESS_MAX_USD",
    "EVIDENCE_PREPROCESS_GENERATION_PROFILE",
    "EVIDENCE_PREPROCESS_RULE_GENERATION_PROFILE",
  ]) assert.match(workflow, new RegExp(name, "u"));
  assert.match(workflow, /vars\.EVIDENCE_PREPROCESS_GENERATION_PROFILE \|\| 'config\/evidence-generation\/gemini-3\.8-flash-low\.json'/u);
  assert.match(workflow, /test -n "\$EVIDENCE_PREPROCESS_GENERATION_PROFILE"/u);
  assert.match(workflow, /PROVIDER_ID=.*providerId/u);
  assert.match(workflow, /case "\$PROVIDER_ID" in[\s\S]*bai\)[\s\S]*RAG_EVIDENCE_BAI_API_KEY[\s\S]*BAI_API_KEY/u);
  assert.match(workflow, /secrets\.GEMINI_RULE_QA_API_KEY/u);
  assert.match(workflow, /secrets\.RAG_EVIDENCE_BAI_API_KEY/u);
  assert.match(workflow, /secrets\.BAI_API_KEY/u);
  assert.match(workflow, /secrets\.UPSTASH_BUDGET_KV_REST_API_URL/u);
  assert.match(workflow, /secrets\.UPSTASH_BUDGET_KV_REST_API_TOKEN/u);
  assert.doesNotMatch(workflow, /git push|ledger.*reset|new.*budget/iu);
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
