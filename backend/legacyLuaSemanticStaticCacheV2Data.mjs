import { readFile, readFileSync } from "node:fs";
import { promisify } from "node:util";

const DEFAULT_MANIFEST_URL = new URL(
  "../data/legacy-lua-semantic-cache-v2/manifest.json",
  import.meta.url,
);

let bundledManifestMemo;

/** Loads only the small v2 index manifest during production composition. */
export function loadBundledLegacyLuaSemanticManifest({
  fileUrl = DEFAULT_MANIFEST_URL,
  readFileImpl = readFileSync,
} = {}) {
  if (sameUrl(fileUrl, DEFAULT_MANIFEST_URL) &&
      bundledManifestMemo !== undefined) {
    return bundledManifestMemo;
  }
  let value = null;
  try {
    value = JSON.parse(readFileImpl(fileUrl, "utf8"));
  } catch {
    value = null;
  }
  if (sameUrl(fileUrl, DEFAULT_MANIFEST_URL)) bundledManifestMemo = value;
  return value;
}

/**
 * Creates an asynchronous, memoized shard reader. Descriptor paths have
 * already been restricted by the manifest validator to shards/xx.json, and
 * URL resolution keeps them beneath the manifest directory.
 */
export function createBundledLegacyLuaShardLoader({
  manifestUrl = DEFAULT_MANIFEST_URL,
  readFileImpl = promisify(readFile),
} = {}) {
  const promises = new Map();
  return async function loadBundledLegacyLuaShard(descriptor) {
    const key = `${descriptor?.path || ""}:${descriptor?.contentSha256 || ""}`;
    if (!promises.has(key)) {
      const shardUrl = new URL(String(descriptor?.path || ""), manifestUrl);
      promises.set(key, Promise.resolve(readFileImpl(shardUrl, "utf8"))
        .then((serialized) => JSON.parse(String(serialized)))
        .catch((error) => {
          promises.delete(key);
          throw error;
        }));
    }
    return promises.get(key);
  };
}

export function bundledLegacyLuaManifestUrl() {
  return new URL(DEFAULT_MANIFEST_URL.href);
}

function sameUrl(left, right) {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}
