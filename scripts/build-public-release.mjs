import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const manifest = JSON.parse(fs.readFileSync('data/rag-data-revision-manifest.json','utf8'));
const commit = process.env.VERCEL_GIT_COMMIT_SHA || execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{64}$/.test(manifest.revision)) throw Error('release_identity_missing');
const dest=process.argv[2] || 'data/public-release.json';
fs.mkdirSync(path.dirname(dest),{recursive:true});
fs.writeFileSync(dest,JSON.stringify({commit,dataRevision:manifest.revision,builtAt:new Date().toISOString()},null,2)+'\n');
