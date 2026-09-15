import { readFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { getLoadedGeminiEvidenceReleaseInfo } from './geminiRuleQaAssets.mjs';

const evidenceRevisionProjection = value => value ? Object.freeze({
  assetSchemaVersion: value.assetSchemaVersion ?? null,
  bundleRevision: value.bundleRevision ?? null,
  dataRevision: value.dataRevision ?? null,
  navigationRevision: value.navigationRevision ?? null,
  structureMappingRevision: value.structureMappingRevision ?? null,
  ruleDenseRevision: value.ruleDenseRevision ?? null,
  qaDenseRevision: value.qaDenseRevision ?? null,
}) : null;

export function getPublicReleaseInfo(env = process.env, read = readFileSync,
  getLoadedEvidenceReleaseInfo = getLoadedGeminiEvidenceReleaseInfo) {
  let manifest = null;
  let build = null;
  try { manifest = JSON.parse(read(new URL('../data/rag-data-revision-manifest.json', import.meta.url), 'utf8')); } catch {}
  try { build = JSON.parse(read(new URL('../data/public-release.json', import.meta.url), 'utf8')); } catch {}
  return {
    commit: env.VERCEL_GIT_COMMIT_SHA || build?.commit || null,
    dataRevision: manifest?.revision || null,
    builtAt: build?.builtAt || null,
    runtimeMemory: {
      heapLimitBytes: getHeapStatistics().heap_size_limit,
      ...process.memoryUsage(),
    },
    evidenceAssets: {
      expected: evidenceRevisionProjection(build?.evidenceAssets?.expected),
      loaded: evidenceRevisionProjection(getLoadedEvidenceReleaseInfo()),
    },
  };
}
