import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPrecomputedLegacyLuaCacheManifest,
  createPrecomputedLegacyLuaCacheShard,
  createPrecomputedLegacyLuaShardSummary,
  validatePrecomputedLegacyLuaCacheManifest,
} from "../backend/legacyLuaSemanticStaticCacheV2.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cacheDirectory = path.join(
  repositoryRoot,
  "data",
  "legacy-lua-semantic-cache-v2",
);
const writeChanges = process.argv.slice(2).includes("--write");

const manifestPath = path.join(cacheDirectory, "manifest.json");
const previousManifest = JSON.parse(await readFile(manifestPath, "utf8"));
const summaries = [];
const pendingWrites = [];
let retainedResourceCount = 0;

for (const descriptor of previousManifest.shards) {
  const shardPath = path.join(cacheDirectory, descriptor.path);
  const previousSerialized = await readFile(shardPath, "utf8");
  const previousShard = JSON.parse(previousSerialized);
  const shard = createPrecomputedLegacyLuaCacheShard({
    shardId: previousShard.shardId,
    generatedAt: previousShard.generatedAt,
    entries: previousShard.entries,
  });
  const serialized = `${JSON.stringify(shard, null, 2)}\n`;
  if (serialized !== previousSerialized) {
    pendingWrites.push({ filePath: shardPath, serialized });
  }
  summaries.push(createPrecomputedLegacyLuaShardSummary({
    shard,
    path: descriptor.path,
    serializedBytes: Buffer.byteLength(serialized, "utf8"),
  }));
  retainedResourceCount += shard.entries.length;
}

if (retainedResourceCount !== previousManifest.selection.retainedResourceCount) {
  throw new Error(
    `retained resource count changed: expected ${previousManifest.selection.retainedResourceCount}, got ${retainedResourceCount}`,
  );
}

const manifest = createPrecomputedLegacyLuaCacheManifest({
  generatedAt: previousManifest.generatedAt,
  source: previousManifest.source,
  selection: previousManifest.selection,
  shardSummaries: summaries,
});
validatePrecomputedLegacyLuaCacheManifest(manifest);
const manifestSerialized = `${JSON.stringify(manifest, null, 2)}\n`;
const previousManifestSerialized = await readFile(manifestPath, "utf8");
if (manifestSerialized !== previousManifestSerialized) {
  pendingWrites.push({ filePath: manifestPath, serialized: manifestSerialized });
}

if (writeChanges) {
  for (const item of pendingWrites) {
    await writeFile(item.filePath, item.serialized, "utf8");
  }
}

process.stdout.write(JSON.stringify({
  ok: true,
  mode: writeChanges ? "write" : "check",
  retainedResourceCount,
  shardCount: previousManifest.shards.length,
  changedFileCount: pendingWrites.length,
}, null, 2));
process.stdout.write("\n");

if (!writeChanges && pendingWrites.length > 0) process.exitCode = 1;
