import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ragEvidenceRetriever from "../backend/ragEvidenceRetriever.mjs";
import { checkRagRuntimeBundle } from "../backend/ragRuntimeBundleCompiler.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(readArgument("--data-dir") || join(projectRoot, "data"));
const bundleDir = resolve(readArgument("--bundle-dir") || join(dataDir, "rag-runtime-v1"));

const rawLoader = ragEvidenceRetriever.loadRawRagData;
if (typeof rawLoader !== "function") {
  throw new Error("loadRawRagData integration is required; refusing to compare a bundle with itself");
}

const result = await checkRagRuntimeBundle({
  dataDir,
  bundleDir,
  loadNormalizedData: rawLoader,
});
if (!result.ok) {
  throw new Error(`RAG runtime bundle check failed: ${result.reason}${result.reasons?.length ? ` (${result.reasons.join(",")})` : ""}`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  bundleDir,
  dataRevision: result.dataRevision,
  bundleRevision: result.bundleRevision,
  counts: result.manifest.counts,
})}\n`);

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
