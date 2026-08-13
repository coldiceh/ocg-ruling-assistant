import { hydrateRagCardAliasRuntimeIndex } from "./ragCardExtractor.mjs";
import {
  finalizeVerifiedRawGenericRuntimeBundle,
  loadVerifiedRawGenericRuntimeBundle,
  runtimeBundleFallback,
} from "./rawGenericRuntimeBundle.mjs";

export {
  canonicalJsonBytes,
  recomputeBundleRevision,
  RAG_RUNTIME_AUXILIARY_ARTIFACTS,
  RAG_RUNTIME_BUNDLE_ABI,
  RAG_RUNTIME_BUNDLE_COMPILER_ABI,
  RAG_RUNTIME_BUNDLE_DIRECTORY,
  RAG_RUNTIME_BUNDLE_MANIFEST_FILE,
  RAG_RUNTIME_BUNDLE_SCHEMA_VERSION,
  RAG_RUNTIME_CORPORA,
  sha256,
  stableJsonStringify,
  validateRagRuntimeBundleManifest,
  validateSourceRevisionBinding,
} from "./rawGenericRuntimeBundle.mjs";

/**
 * Legacy-compatible runtime loader.
 *
 * The storage, manifest, source-binding and byte-integrity checks live in the
 * neutral raw-only loader. This wrapper alone interprets the optional alias
 * artifact and hydrates the legacy extractor's caches.
 */
export async function loadRagRuntimeBundle(options = {}) {
  const verified = await loadVerifiedRawGenericRuntimeBundle(options);
  if (!verified.ok) return verified;
  if (!hydrateRagCardAliasRuntimeIndex(verified.data.cards, verified.artifacts.cardAliasIndex)) {
    return runtimeBundleFallback("card_alias_index_hydration_failed", ["cardAliasIndex"]);
  }
  return finalizeVerifiedRawGenericRuntimeBundle(verified);
}
