import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {selectPreviousMainRun,parseCpuCheckpointLog,nextCpuSequence,validateProgressProof,selectCheckpoint} from '../scripts/select-sync-cpu-checkpoint.mjs';
import {MAX_CPU_CONTINUATIONS} from '../scripts/restore-sync-checkpoint.mjs';
const log=(seq=4)=>`2026-09-21T15:00:00.000Z   SYNC_RESUME_SEQUENCE: ${seq}\n2026-09-21T15:00:01.000Z cloud-embedding-cache:reused=31993 pending=10217\n2026-09-21T15:31:27.000Z missing-cloud-embeddings:1680/10217\n2026-09-21T15:31:27.001Z cloud_sync_embedding_checkpoint_saved:resume_next_run\n2026-09-21T15:31:27.002Z Error: cloud_sync_embedder_exit_75\n`;
const progress={schemaVersion:1,status:'paused_time',totalRows:42210,cachedRows:31993,computedRows:1680,remainingRows:8537};
test('the observed fourth checkpoint advances to five without resetting its history',()=>{
  assert.equal(MAX_CPU_CONTINUATIONS,8);assert.deepEqual(parseCpuCheckpointLog(log()),{...progress,sequence:4});
  assert.equal(nextCpuSequence(4),5);assert.equal(nextCpuSequence(4,5),5);assert.equal(nextCpuSequence(7),8);
  for(const [a,b] of [[4,1],[4,4],[4,6],[8,0],[-1,0],[NaN,0],[4,NaN]]) assert.throws(()=>nextCpuSequence(a,b));
});
test('terminal controls cannot break log reading and raw echoed code cannot prove progress',()=>{
  assert.deepEqual(parseCpuCheckpointLog(log().replace('missing-cloud-embeddings:1680/10217','\x1b[32mmissing-cloud-embeddings:1680/10217\x1b[0m'))),{...progress,sequence:4});
  assert.throws(()=>parseCpuCheckpointLog(log().replace('cloud_sync_embedding_checkpoint_saved:resume_next_run',"console.log('cloud_sync_embedding_checkpoint_saved:resume_next_run')")));
});
test('invalid, zero, complete, mismatched and non-time progress cannot resume',()=>{
  for(const text of [log().replace('1680/10217','0/10217'),log().replace('1680/10217','10217/10217'),
    log().replace('1680/10217','1680/10218'),log().replace('cloud_sync_embedder_exit_75','cloud_sync_embedder_exit_1'),
    log().replace('31993','9007199254740993'),log(99),log()+'  SYNC_RESUME_SEQUENCE: 3\n']) assert.throws(()=>parseCpuCheckpointLog(text));
});
test('structured saved progress must agree exactly with the actual CPU log',()=>{
  assert.equal(validateProgressProof(progress,parseCpuCheckpointLog(log())),progress);
  for(const field of Object.keys(progress))assert.throws(()=>validateProgressProof({...progress,[field]:'wrong'},parseCpuCheckpointLog(log())));
});
test('selection ignores maintenance branches, other workflows, the current run and newer queued runs',()=>{
  const item=id=>({id,head_branch:'main',path:'.github/workflows/sync-data.yml'});
  assert.equal(selectPreviousMainRun([item(1),item(7),item(10),{...item(8),head_branch:'fix/test'},
    {...item(9),path:'.github/workflows/deploy-pages.yml'},item(11)],'10').id,7);
  assert.equal(selectPreviousMainRun([],10),null);
});
const proofNames=['Validate synchronized data','Incrementally refresh current navigation and Gemini vectors',
  'Promote verified bounded evidence assets','Build and verify versioned RAG runtime bundle','Verify runtime behavior matches the raw snapshot',
  'Restore verified unpublished snapshot without paid calls','Preserve completed vectors even after an interrupted increment',
  'Preserve unpublished source and derived assets after downstream failure','Preserve CPU progress diagnostics'];
async function fakeEnvironment(t,patch={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cpu-selector-test-'));
  const run={id:123,repository:{full_name:'a/b'},head_branch:'main',path:'.github/workflows/sync-data.yml',status:'completed',conclusion:'failure',head_sha:'a'.repeat(40),run_attempt:1};
  const job={id:999,name:'sync',run_id:123,status:'completed',conclusion:'failure',steps:[...proofNames.map(name=>({name,conclusion:'success'})),
    {name:'Incrementally synchronize and mechanically verify cloud evidence assets',conclusion:'failure'}]};
  const config={run,job,log:log(),progress,cache:true,artifact:true,...patch};
  const configPath=path.join(root,'config.json');await fs.writeFile(configPath,JSON.stringify(config));
  const fake=`#!/usr/bin/env python3\nimport sys,os,json,pathlib\nc=json.loads(pathlib.Path(os.environ['SYNC_FAKE_GH']).read_text())\na=sys.argv[1:]\nwith open(os.environ['SYNC_FAKE_CALLS'],'a') as f:f.write(json.dumps(a)+'\\n')\nif a[0]=='api':\n p=a[1]\n if 'workflows/sync-data.yml/runs?' in p:v={'workflow_runs':[c['run']]}\n elif p.endswith('/actions/runs/123'):v=c['run']\n elif '/attempts/1/jobs?' in p:v={'jobs':[c['job']]}\n elif p.endswith('/jobs/999/logs'):print(c['log']);sys.exit(0)\n elif '/artifacts?' in p:v={'artifacts':[{'name':n,'expired':False,'workflow_run':{'id':123}} for n in (['sync-resume-snapshot-123-1','cloud-sync-progress-123-1'] if c['artifact'] else [])]}\n elif '/actions/caches?' in p:v={'actions_caches':[{'key':'cloud-embedding-rows-v1-Linux-123-1','ref':'refs/heads/main','size_in_bytes':100}] if c['cache'] else []}\n else:raise RuntimeError('UNAUTHORIZED_API')\n print(json.dumps(v))\nelif a[:2]==['run','download']:\n d=pathlib.Path(a[a.index('--dir')+1]);d.mkdir(exist_ok=True);(d/'cloud-sync-progress.json').write_text(json.dumps(c['progress']))\nelse:raise RuntimeError('UNAUTHORIZED_COMMAND')\n`;
  await fs.writeFile(path.join(root,'gh'),fake,{mode:0o755});
  await fs.writeFile(path.join(root,'git'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const env={PATH:root+path.delimiter+process.env.PATH,SYNC_FAKE_GH:configPath,SYNC_FAKE_CALLS:path.join(root,'calls'),
    GITHUB_OUTPUT:path.join(root,'outputs'),GITHUB_STEP_SUMMARY:path.join(root,'summary'),SYNC_RESUME_RUN_ID:''};
  const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
  t.after(async()=>{for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await fs.rm(root,{recursive:true,force:true});});
  return {root,options:{repo:'a/b',currentRunId:'456',workspace:root,temp:root}};
}
test('an ordinary daily run chooses the saved fifth increment before any paid or source work',async t=>{
  const {root,options}=await fakeEnvironment(t);
  const result=await selectCheckpoint(options);assert.equal(result.sequence,5);assert.equal(result.remaining_rows,8537);
  assert.equal(result.required_cached_rows,33673);assert.equal(result.expected_rows,42210);
  assert.equal(result.cache_key,'cloud-embedding-rows-v1-Linux-123-1');
  const calls=await fs.readFile(path.join(root,'calls'),'utf8');assert.ok(!calls.includes('POST'));assert.ok(!calls.includes('dispatches'));
});
test('a missing saved cache fails before any source or model work instead of starting over',async t=>{
  const {options}=await fakeEnvironment(t,{cache:false});await assert.rejects(selectCheckpoint(options),/cache_missing_no_recompute/);
});
test('a missing snapshot fails closed rather than treating the day as a new paid batch',async t=>{
  const {options}=await fakeEnvironment(t,{artifact:false});await assert.rejects(selectCheckpoint(options),/snapshot_missing_no_paid_restart/);
});
test('a contradictory progress artifact stops recovery',async t=>{
  const {options}=await fakeEnvironment(t,{progress:{...progress,remainingRows:1}});await assert.rejects(selectCheckpoint(options),/progress_proof_mismatch/);
});
test('the eighth increment cannot be restarted as sequence one or a fresh paid sync',async t=>{
  const {options}=await fakeEnvironment(t,{log:log(8)});await assert.rejects(selectCheckpoint(options),/chain_limit_reached_no_paid_restart/);
});
test('a successful previous synchronization allows normal daily delta discovery',async t=>{
  const {options}=await fakeEnvironment(t,{run:{id:123,head_branch:'main',path:'.github/workflows/sync-data.yml',status:'completed',conclusion:'success'}});
  assert.equal((await selectCheckpoint(options)).mode,'fresh');
});
test('workflow gives resumed CPU work 175 minutes, exact cache restoration and the original final publication gates',async()=>{
  const w=await fs.readFile(new URL('../.github/workflows/sync-data.yml',import.meta.url),'utf8');
  assert.ok(w.indexOf('node scripts/select-sync-cpu-checkpoint.mjs') < w.indexOf('node scripts/restore-sync-checkpoint.mjs'));
  assert.ok(w.includes("steps.restore.outputs.resumed == 'true' && 10500 || 2100"));
  assert.ok(w.includes('timeout-minutes: 240'));assert.ok(w.includes('steps.select_resume.outputs.cache_key'));
  assert.ok(w.includes("fail-on-cache-miss: ${{ steps.restore.outputs.resumed == 'true' }}"));
  assert.ok(w.includes('CLOUD_EMBED_REQUIRED_CACHED_ROWS'));assert.ok(w.includes('CLOUD_EMBED_EXPECTED_ROWS'));
  assert.ok(w.includes('cron: "0 19 * * *"'));assert.ok(w.includes('--batch-budget-usd 1'));
  assert.ok(w.includes('0.66364875'));assert.ok(w.includes('pnpm check:freshness'));
  assert.ok(w.includes('bash scripts/publish-synced-snapshot.sh'));assert.ok(w.includes('steps.select_resume.outputs.sequence'));
});
test('cache-floor validation rejects lost rows and a changed request before loading the model',()=>{
  const code=`import ast,os\ns=ast.parse(open('scripts/embed-missing-cloud-evidence.py').read())\nf=next(n for n in s.body if isinstance(n,ast.FunctionDef) and n.name=='require_cached_progress')\ndef fail(code):raise RuntimeError(code)\nexec(compile(ast.Module(body=[f],type_ignores=[]),'guard','exec'))\nfor floor,total,actual,size,ok in [('33673','42210',33673,42210,True),('33673','42210',33672,42210,False),('33673','42210',33673,42211,False),('NaN','42210',33673,42210,False),('-1','42210',33673,42210,False),('','','0',42210,True)]:\n os.environ['CLOUD_EMBED_REQUIRED_CACHED_ROWS']=floor;os.environ['CLOUD_EMBED_EXPECTED_ROWS']=total\n try:require_cached_progress(int(actual),size);assert ok\n except RuntimeError:assert not ok\nprint('cache floor: 6 cases passed')\n`;
  assert.match(execFileSync('python3',['-c',code],{encoding:'utf8'}),/6 cases passed/);
});
