import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const manifest = JSON.parse(fs.readFileSync('data/rag-data-revision-manifest.json','utf8'));
const evidenceManifest = JSON.parse(fs.readFileSync('data/gemini-rule-qa-v1/manifest.json','utf8'));
const commit = process.env.VERCEL_GIT_COMMIT_SHA || execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const SHA256 = /^[a-f0-9]{64}$/u;
const evidenceAssets = {
  assetSchemaVersion: evidenceManifest.schemaVersion,
  bundleRevision: evidenceManifest.bundleRevision,
  dataRevision: evidenceManifest.dataRevision,
  navigationRevision: evidenceManifest.navigationRevision,
  structureMappingRevision: evidenceManifest.structureMappingRevision,
  ruleDenseRevision: evidenceManifest.ruleDenseRevision,
  qaDenseRevision: evidenceManifest.qaDenseRevision,
};
if(!/^[a-f0-9]{40}$/.test(commit) || !SHA256.test(manifest.revision)
    || evidenceAssets.assetSchemaVersion !== 3
    || evidenceAssets.dataRevision !== manifest.revision
    || Object.entries(evidenceAssets).some(([key, value]) => key !== 'assetSchemaVersion' && !SHA256.test(value))) {
  throw Error('release_identity_missing');
}
const dest=process.argv[2] || 'data/public-release.json';
fs.mkdirSync(path.dirname(dest),{recursive:true});
fs.writeFileSync(dest,JSON.stringify({commit,dataRevision:manifest.revision,builtAt:new Date().toISOString(),
  evidenceAssets: { expected: evidenceAssets }},null,2)+'\n');
