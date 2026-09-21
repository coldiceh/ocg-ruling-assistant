import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const file='scripts/lib/manual-capture-evidence-selection.mjs';
const current=fs.readFileSync(file);
const original=spawnSync('git',['show','HEAD:'+file]);assert.equal(original.status,0);
function run(label){const r=spawnSync(process.execPath,['--test','tests/cloud-evidence-plan.test.mjs'],{encoding:'utf8'});const text=r.stdout+r.stderr;fs.writeFileSync(process.env.RUNNER_TEMP+'/cloud-plan-'+label+'.log',text);return {status:r.status,missing:(text.match(/Error: manual_capture_fixed_card_missing/g)||[]).length,fail:Number(text.match(/(?:#|ℹ) fail (\d+)/u)?.[1]),pass:Number(text.match(/(?:#|ℹ) pass (\d+)/u)?.[1])};}
let baseline;try{fs.writeFileSync(file,original.stdout);baseline=run('baseline');}finally{fs.writeFileSync(file,current);}
const repaired=run('repaired');assert.deepEqual(repaired,baseline,'source fix must not add cloud-plan regressions');
assert.equal(baseline.fail,2);assert.equal(baseline.missing,2);
const result={baseline,repaired,knownPreexistingFailure:'manual_capture_fixed_card_missing in both existing preview/production wire-prompt tests',newRegressions:0};
fs.writeFileSync(process.env.RUNNER_TEMP+'/cloud-plan-baseline-comparison.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
