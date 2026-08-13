import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ragEvidenceRetriever from "../backend/ragEvidenceRetriever.mjs";
import { buildRagRuntimeBundle } from "../backend/ragRuntimeBundleCompiler.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(readArgument("--data-dir") || join(projectRoot, "data"));
const outputDir = resolve(readArgument("--output-dir") || join(dataDir, "rag-runtime-v1"));

const rawLoader = ragEvidenceRetriever.loadRawRagData;
if (typeof rawLoader !== "function") {
  throw new Error("loadRawRagData integration is required; refusing to compile from a runtime bundle");
}

const result = await buildRagRuntimeBundle({
  dataDir,
  outputDir,
  loadNormalizedData: rawLoader,
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  outputDir,
  dataRevision: result.manifest.dataRevision,
  bundleRevision: result.manifest.bundleRevision,
  counts: result.manifest.counts,
})}\n`);

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
