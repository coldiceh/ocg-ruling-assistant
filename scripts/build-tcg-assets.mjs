import {execFileSync} from 'node:child_process';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Canonical inputs and card runtime only. This command never generates vectors,
// navigation text or answers, and never starts an evaluation or deployment.
const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = resolve(process.argv[2] || join(root, 'data/tcg'));
for (const [script, extra] of [
  ['build-rag-data-revision-manifest.mjs', []],
  ['build-rag-runtime-bundle.mjs', []],
  ['build-gemini-rule-qa-assets.mjs', ['--stage','canonical','--output-dir',join(dataDir,'gemini-rule-qa-v1')]],
]) execFileSync(process.execPath, [join(root,'scripts',script),'--data-dir',dataDir,...extra], {cwd:root, stdio:'inherit'});
