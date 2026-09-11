import { readFileSync } from 'node:fs';

export function getPublicReleaseInfo(env = process.env, read = readFileSync) {
  let manifest = null;
  let build = null;
  try { manifest = JSON.parse(read(new URL('../data/rag-data-revision-manifest.json', import.meta.url), 'utf8')); } catch {}
  try { build = JSON.parse(read(new URL('../data/public-release.json', import.meta.url), 'utf8')); } catch {}
  return {
    commit: env.VERCEL_GIT_COMMIT_SHA || build?.commit || null,
    dataRevision: manifest?.revision || null,
    builtAt: build?.builtAt || null,
  };
}
