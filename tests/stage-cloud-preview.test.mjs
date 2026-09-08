import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { isPreviewSourcePath, planCloudPreview, stageCloudPreview } from "../scripts/stage-cloud-preview.mjs";

test("preview staging excludes private inputs and copies only selected current sources", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ocg-preview-stage-"));
  const root = join(temp, "source");
  const output = join(temp, "preview");
  try {
    await mkdir(root);
    const fixtures = {
      "package.json": '{"type":"module"}\n', "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "vercel.json": '{"outputDirectory":"public"}\n', "index.html": "<h1>Preview</h1>\n",
      "src/app.js": "export const version = 1;\n", "src/styles.css": "body {}\n",
      "data/cards-lite.json": "{}\n", "data/snapshot-meta.json": "{}\n",
      "scripts/build-rag-data-revision-manifest.mjs": "export {};\n",
      "scripts/check-rag-runtime-bundle.mjs": "export {};\n",
      "scripts/lib/retrieval-evidence-lineage.mjs": "export {};\n",
      "scripts/lib/manual-capture-evidence-selection.mjs": "export {};\n",
      "scripts/lib/manual-capture-local-embedding-shadow.mjs": "export {};\n",
      "backend/deleted.mjs": "export {};\n",
      "data/test/private-oracle.json": "private fixture must not ship\n",
      "artifacts/frozen/answers.json": "frozen fixture must not ship\n",
      ".env": "SECRET=private-fixture\n",
    };
    for (const [path, text] of Object.entries(fixtures)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init", "--quiet");
    git("add", "--", ...Object.keys(fixtures));
    git("-c", "user.name=Preview Test", "-c", "user.email=preview-test@example.invalid", "commit", "--quiet", "-m", "fixture");
    await writeFile(join(root, "src", "app.js"), "export const version = 2;\n");
    await rm(join(root, "backend", "deleted.mjs"));
    await writeFile(join(root, "backend", "selected.mjs"), "export const selected = true;\n");
    await writeFile(join(root, "backend", "automatic.mjs"), "export const automatic = true;\n");
    await writeFile(join(root, "scripts", "lib", "unselected.mjs"), "export const unselected = true;\n");
    await writeFile(join(root, "data", "evidence-index.json.gz"), Buffer.from([31, 139, 8, 0]));
    const includeFiles = ["backend/selected.mjs"];
    const plan = await planCloudPreview({ root, includeFiles });
    for (const dependency of ["scripts/lib/manual-capture-evidence-selection.mjs",
      "scripts/lib/manual-capture-local-embedding-shadow.mjs"]) {
      assert.ok(plan.files.some((file) => file.path === dependency), dependency);
    }
    assert.ok(plan.files.some((file) => file.path === "backend/selected.mjs"));
    assert.ok(plan.files.some((file) => file.path === "backend/automatic.mjs"));
    assert.ok(plan.files.some((file) => file.path === "data/evidence-index.json.gz"));
    for (const forbidden of [".env", "data/test/private-oracle.json", "artifacts/frozen/answers.json", "backend/deleted.mjs", "scripts/lib/unselected.mjs"]) {
      assert.equal(plan.files.some((file) => file.path === forbidden), false, forbidden);
    }
    await stageCloudPreview({ root, output, includeFiles });
    assert.deepEqual(await readFile(join(output, "data", "evidence-index.json.gz")), Buffer.from([31, 139, 8, 0]));
    assert.equal(await readFile(join(output, "public", "src", "app.js"), "utf8"), "export const version = 2;\n");
    assert.deepEqual(JSON.parse(await readFile(join(output, "public", "config.json"), "utf8")), {
      answerApiUrl: "/api/answer", budgetApiUrl: "/api/budget", deploymentLabel: "Preview · 未通过质量验收",
    });
    const assetDir = join(temp, "cloud-assets");
    await mkdir(assetDir);
    const corpusManifest = `${JSON.stringify({ schemaVersion: 1, corpusFile: "corpus.json.gz", lexicalIndex: { file: "lexical-index.bin.gz" } })}\n`;
    await writeFile(join(assetDir, "corpus-manifest.json"), corpusManifest);
    await writeFile(join(assetDir, "evidence-vector-index.json"), JSON.stringify({ shards: [{ file: "evidence-vectors-000.f32" }] }));
    await writeFile(join(assetDir, "corpus.json.gz"), Buffer.from([1, 2, 3]));
    await writeFile(join(assetDir, "evidence-vectors-000.f32"), Buffer.from([4, 5, 6, 7]));
    await writeFile(join(assetDir, "lexical-index.bin.gz"), Buffer.from([8, 9, 10]));
    await writeFile(join(assetDir, "vector-documents.json"), "unused build input must not ship\n");
    const withAssets = await stageCloudPreview({ root, output: join(temp, "preview-assets"), includeFiles, assetDir });
    assert.deepEqual(withAssets.manifest.files.filter((file) => file.sourceKind === "cloud-asset").map((file) => file.path), [
      "data/cloud-evidence-v1/corpus-manifest.json", "data/cloud-evidence-v1/corpus.json.gz",
      "data/cloud-evidence-v1/evidence-vector-index.json", "data/cloud-evidence-v1/evidence-vectors-000.f32",
      "data/cloud-evidence-v1/lexical-index.bin.gz",
    ]);
    assert.equal(await readFile(join(withAssets.output, "data", "cloud-evidence-v1", "corpus-manifest.json"), "utf8"), corpusManifest);
    assert.deepEqual(await readFile(join(withAssets.output, "data", "cloud-evidence-v1", "evidence-vectors-000.f32")), Buffer.from([4, 5, 6, 7]));
    await assert.rejects(stageCloudPreview({ root, output, includeFiles }), /already exists/u);
    await assert.rejects(stageCloudPreview({ root, output: join(root, "staging"), includeFiles }), /outside the source repository/u);
    await assert.rejects(planCloudPreview({ root, includeFiles: [".vs/do-not-read.json"] }), /outside the preview allowlist/u);
  } finally {
    // The test owns this fresh temporary directory and never enumerates the project.
    await rm(temp, { recursive: true, force: true });
  }
});

test("the source allowlist rejects traversal and excludes evaluation and credential paths", () => {
  for (const path of [".vs/cache.json", "backend/.vs/cache.mjs", "assets/../.vs/cache.png", "assets/.VS/cache.png",
    "../backend/file.mjs", "backend\\file.mjs", "C:/backend/file.mjs", ".env", ".git/config",
    "data/test/oracle.json", "artifacts/frozen/index.json", "scripts/evaluate-pure-llm-preview.mjs"]) {
    assert.equal(isPreviewSourcePath(path), false, path);
  }
});
