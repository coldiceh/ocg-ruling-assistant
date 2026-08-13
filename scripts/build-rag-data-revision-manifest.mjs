import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRawGenericSourceData } from "../backend/rawGenericDataStore.mjs";
import {
  buildRagDataRevisionManifest,
  createRagDataSourceDescriptor,
  RAG_DATA_REVISION_MANIFEST_FILE,
  RAG_DATA_REVISION_SOURCE_FILES,
  validateRagDataRevisionManifest,
} from "../backend/ragDataRevisionManifest.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(readArgument("--data-dir") || join(projectRoot, "data"));
const outputPath = join(dataDir, RAG_DATA_REVISION_MANIFEST_FILE);
const checkOnly = process.argv.slice(2).includes("--check");

const rawSources = await Promise.all(RAG_DATA_REVISION_SOURCE_FILES.map(async (path) => ({
  path,
  content: await readFile(join(dataDir, path)),
})));
const sources = rawSources.map(({ path, content }) => createRagDataSourceDescriptor(path, content));
// A revision manifest is the trust root for the precompiled runtime bundle.
// Always derive it from the synchronized source files; otherwise a stale but
// still-valid bundle could certify itself after those source files changed.
const data = await loadRawGenericSourceData(dataDir);
const manifest = buildRagDataRevisionManifest({ data, sources });
const validation = validateRagDataRevisionManifest(manifest, {
  data,
  sources,
  verifyCanonicalCorpus: true,
});
if (!validation.ok) throw new Error(`generated RAG revision manifest is invalid: ${validation.reasons.join(",")}`);

const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
if (checkOnly) {
  let current = "";
  try {
    current = await readFile(outputPath, "utf8");
  } catch {
    // Report the same deterministic mismatch for missing and stale manifests.
  }
  if (current !== serialized) {
    throw new Error(`RAG data revision manifest is missing or stale; run: pnpm build:rag-revision`);
  }
} else {
  await writeFile(outputPath, serialized, "utf8");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  checked: checkOnly,
  output: outputPath,
  revision: manifest.revision,
  sourceCount: manifest.sources.length,
  counts: manifest.counts,
})}\n`);

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
