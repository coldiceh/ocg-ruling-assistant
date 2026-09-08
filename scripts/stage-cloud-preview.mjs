import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FILES = new Set([
  ".gitattributes", ".nojekyll", "index.html", "package.json", "pnpm-lock.yaml", "vercel.json",
]);
const DATA_FILES = new Set([
  "cards.json", "rulings.json", "qa-index.json", "evidence-index.json.gz",
  "ocg-rule-corpus.json", "official-responses.json", "rag-data-revision-manifest.json",
  "qa-discovery-index.json", "cards-lite.json", "snapshot-meta.json", "card-alias-index.json",
  "model-pricing.json", "deepseek-model-pricing.json", "relay-model-pricing.json",
]);
const BUILD_FILES = new Set([
  "scripts/build-rag-data-revision-manifest.mjs",
  "scripts/check-rag-runtime-bundle.mjs",
  "scripts/lib/retrieval-evidence-lineage.mjs",
  "scripts/lib/manual-capture-evidence-selection.mjs",
  "scripts/lib/manual-capture-local-embedding-shadow.mjs",
]);
const SAME_ORIGIN_CONFIG = `${JSON.stringify({
  answerApiUrl: "/api/answer",
  budgetApiUrl: "/api/budget",
  deploymentLabel: "Preview · 未通过质量验收",
}, null, 2)}\n`;

// This is a filename allowlist, not a content or evidence classifier.
export function isPreviewSourcePath(path) {
  if (typeof path !== "string" || !path || path.includes("\\") || isAbsolute(path)) return false;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".vs")) return false;
  if (ROOT_FILES.has(path) || BUILD_FILES.has(path)) return true;
  if (/^(?:api|backend)\/[A-Za-z0-9_-]+\.(?:mjs|js)$/u.test(path)) return true;
  if (/^src\/[A-Za-z0-9_-]+\.(?:mjs|js|css)$/u.test(path)) return true;
  if (/^assets\/[A-Za-z0-9_./-]+\.(?:png|jpg|jpeg|webp|svg|ico|woff2?)$/u.test(path)) return true;
  if (/^public\/timing-test\.(?:html|js|css)$/u.test(path) || path === "public/.gitkeep") return true;
  if (path.startsWith("data/") && DATA_FILES.has(path.slice(5))) return true;
  if (/^data\/rag-runtime-v1\/(?:manifest\.json|(?:cards|records|qa-records|card-alias-index)\.json\.br)$/u.test(path)) return true;
  return /^data\/legacy-lua-semantic-cache-v2\/(?:manifest\.json|shards\/[a-f0-9]{2}\.json)$/u.test(path);
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

async function selectedSource(root, path, { optional = false } = {}) {
  const fullPath = join(root, ...path.split("/"));
  let stat;
  try {
    let current = root;
    for (const part of path.split("/")) {
      current = join(current, part);
      stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Source must not traverse a link: ${path}`);
    }
  } catch (error) {
    if (optional && error.code === "ENOENT") return null; // Honor tracked working-tree deletions.
    throw error;
  }
  const actual = await realpath(fullPath);
  const actualRelative = relative(root, actual);
  if (!stat.isFile() || stat.isSymbolicLink() || actualRelative.startsWith(`..${sep}`)
    || actualRelative === ".." || isAbsolute(actualRelative)) {
    throw new Error(`Source must be an ordinary file inside the repository: ${path}`);
  }
  const content = await readFile(fullPath);
  return { path, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") };
}

export async function planCloudPreview({ root, includeFiles = [], assetDir }) {
  root = await realpath(resolve(root));
  const tracked = git(root, ["ls-files", "-z", "--", "api", "backend", "src", "assets", "public", "data",
    ...ROOT_FILES, ...BUILD_FILES, ":(exclude).vs", ":(exclude)**/.vs/**"])
    .split("\0").filter(isPreviewSourcePath);
  // The delivery task explicitly includes every top-level backend module, including new files.
  // Do not recurse: excluded directories and experimental script trees are never enumerated here.
  const backendSources = (await readdir(join(root, "backend")))
    .map((name) => `backend/${name}`).filter(isPreviewSourcePath);
  // A first storage migration creates the gzip before it becomes tracked.
  // The exact filename allowlist keeps this bounded to public data sources.
  const migrationSources = ["data/evidence-index.json.gz"];
  for (const path of includeFiles) {
    if (!isPreviewSourcePath(path)) throw new Error(`Explicit source is outside the preview allowlist: ${path}`);
  }
  const explicit = new Set(includeFiles);
  const files = [];
  for (const path of [...new Set([...tracked, ...backendSources, ...migrationSources, ...includeFiles])].sort()) {
    const entry = await selectedSource(root, path, { optional: !explicit.has(path) });
    if (entry) files.push(entry);
  }
  for (const path of ["package.json", "pnpm-lock.yaml", "vercel.json", "index.html", "src/app.js", "src/styles.css",
    "data/cards-lite.json", "data/snapshot-meta.json", ...BUILD_FILES]) {
    if (!files.some((file) => file.path === path)) throw new Error(`Required preview source is missing: ${path}`);
  }
  if (assetDir) {
    if (assetDir.split(/[\\/]/u).some((part) => part.toLowerCase() === ".vs")) {
      throw new Error("Cloud assets must not use the excluded .vs directory");
    }
    assetDir = await realpath(resolve(assetDir));
    await selectedSource(assetDir, "evidence-vector-index.json");
    const vectorManifest = JSON.parse(await readFile(join(assetDir, "evidence-vector-index.json"), "utf8"));
    const corpusManifest = JSON.parse(await readFile(join(assetDir, "corpus-manifest.json"), "utf8"));
    const lexicalFiles = corpusManifest.lexicalIndex ? ["lexical-index.bin.gz"] : [];
    if (corpusManifest.lexicalIndex && corpusManifest.lexicalIndex.file !== lexicalFiles[0]) {
      throw new Error("Cloud lexical manifest must name the ordinary lexical index file");
    }
    const shardFiles = vectorManifest.shards?.map((shard) => shard.file);
    if (!Array.isArray(shardFiles) || !shardFiles.length
      || shardFiles.some((file) => typeof file !== "string" || !/^evidence-vectors-[0-9]{3}\.f32$/u.test(file))) {
      throw new Error("Cloud asset manifest must name ordinary vector shard files");
    }
    for (const file of [...new Set(["corpus-manifest.json", "corpus.json.gz", "evidence-vector-index.json", ...shardFiles, ...lexicalFiles])].sort()) {
      const source = await selectedSource(assetDir, file);
      files.push({ ...source, path: `data/cloud-evidence-v1/${file}`, sourceKind: "cloud-asset" });
    }
  }
  return {
    schemaVersion: 1,
    kind: "cloud-preview-source-manifest",
    baseCommit: git(root, ["rev-parse", "HEAD"]).trim(),
    sourceMode: "current-working-files",
    explicitUntrackedSources: [...explicit].filter((path) => !tracked.includes(path)).sort(),
    untrackedBackendSources: backendSources.filter((path) => !tracked.includes(path)).sort(),
    cloudEvidenceAssetDirectory: assetDir ? "data/cloud-evidence-v1" : null,
    files,
    generated: ["config.json", "public/config.json", "public/index.html", "public/src/**", "public/assets/**",
      "public/data/cards-lite.json", "public/data/snapshot-meta.json"],
    sourceBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

export async function stageCloudPreview({ root, output, includeFiles = [], assetDir }) {
  root = await realpath(resolve(root));
  output = resolve(output);
  if (output.split(/[\\/]/u).some((part) => part.toLowerCase() === ".vs")) {
    throw new Error("Preview output must not use the excluded .vs directory");
  }
  const actualOutputParent = await realpath(dirname(output));
  output = join(actualOutputParent, output.slice(output.lastIndexOf(sep) + 1));
  const outputRelative = relative(root, output);
  if (!outputRelative || (!outputRelative.startsWith(`..${sep}`) && outputRelative !== ".." && !isAbsolute(outputRelative))) {
    throw new Error("Preview output must be outside the source repository");
  }
  try {
    await lstat(output);
    throw new Error("Preview output already exists; choose a fresh directory");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const manifest = await planCloudPreview({ root, includeFiles, assetDir });
  await mkdir(output);
  for (const entry of manifest.files) {
    const source = entry.sourceKind === "cloud-asset"
      ? join(assetDir, entry.path.slice("data/cloud-evidence-v1/".length))
      : join(root, ...entry.path.split("/"));
    const target = join(output, ...entry.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    const copied = await readFile(target);
    if (createHash("sha256").update(copied).digest("hex") !== entry.sha256) {
      throw new Error(`Source changed while staging: ${entry.path}; choose a fresh output and stage again`);
    }
    const frontend = entry.path === "index.html" || entry.path.startsWith("src/") || entry.path.startsWith("assets/")
      || ["data/cards-lite.json", "data/snapshot-meta.json"].includes(entry.path);
    if (frontend) {
      const publicTarget = join(output, "public", ...entry.path.split("/"));
      await mkdir(dirname(publicTarget), { recursive: true });
      await copyFile(target, publicTarget);
    }
  }
  await mkdir(join(output, "public"), { recursive: true });
  await writeFile(join(output, "config.json"), SAME_ORIGIN_CONFIG, { flag: "wx" });
  await writeFile(join(output, "public", "config.json"), SAME_ORIGIN_CONFIG, { flag: "wx" });
  // Keep provenance outside public/ so the website does not publish its source manifest.
  await writeFile(join(output, "preview-source-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { output, fileCount: manifest.files.length, sourceBytes: manifest.sourceBytes, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let output;
  let assetDir;
  const includeFiles = [];
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!["--root", "--out", "--include-file", "--asset-dir"].includes(name) || !args[index + 1]) {
      throw new Error("Usage: node scripts/stage-cloud-preview.mjs [--root PATH] [--out NEW_EXTERNAL_DIRECTORY] [--include-file RELATIVE_PATH] [--asset-dir PATH]");
    }
    const value = args[++index];
    if (name === "--root") root = value;
    if (name === "--out") output = value;
    if (name === "--asset-dir") assetDir = value;
    if (name === "--include-file") includeFiles.push(value);
  }
  const result = output ? await stageCloudPreview({ root, output, includeFiles, assetDir }) : await planCloudPreview({ root, includeFiles, assetDir });
  process.stdout.write(`${JSON.stringify(output ? {
    output: result.output, fileCount: result.fileCount, sourceBytes: result.sourceBytes,
    manifest: join(result.output, "preview-source-manifest.json"),
  } : result, null, 2)}\n`);
}
