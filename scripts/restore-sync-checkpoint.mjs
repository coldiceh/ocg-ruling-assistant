// Restore only a validated unpublished data snapshot. No source/model API calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec = promisify(execFile);
const fail = code => { throw new Error(code); };
const directories = new Set(['rag-runtime-v1','cloud-evidence-v1','gemini-rule-qa-v1','rule-embedding-v1','qa-embedding-v1']);
const proofSteps = ['Validate synchronized data','Incrementally refresh current navigation and Gemini vectors',
  'Promote verified bounded evidence assets','Build and verify versioned RAG runtime bundle','Verify runtime behavior matches the raw snapshot'];
export const MAX_CPU_CONTINUATIONS = 8;
export function parseResumeInputs(runId = '', sequence = '0') {
  if (!/^(?:0|[1-8])$/.test(sequence)) fail('sync_resume_sequence_invalid');
  if (runId && !/^[1-9][0-9]{0,18}$/.test(runId)) fail('sync_resume_run_id_invalid');
  if (!runId && sequence !== '0') fail('sync_resume_run_id_required');
  return {runId, sequence:Number(sequence)};
}
export function validateCheckpointRun(run, jobs, {repo, runId, currentRunId}) {
  if (String(run?.id)!==runId || runId===currentRunId || run?.repository?.full_name!==repo
      || run?.head_branch!=='main' || run?.path!=='.github/workflows/sync-data.yml'
      || run?.status!=='completed' || run?.conclusion!=='failure'
      || !/^[a-f0-9]{40}$/.test(run?.head_sha || '')
      || !Number.isSafeInteger(run?.run_attempt) || run.run_attempt < 1) fail('sync_checkpoint_run_provenance_invalid');
  const candidates=(jobs?.jobs || []).filter(job=>job.name==='sync');
  if(candidates.length!==1) fail('sync_checkpoint_job_ambiguous');
  const job=candidates[0];
  if(String(job.run_id)!==runId || job.status!=='completed' || job.conclusion!=='failure') fail('sync_checkpoint_job_invalid');
  for(const name of proofSteps) {
    const steps=(job.steps || []).filter(step=>step.name===name);
    // A continuation may skip the already-verified paid stage after restoration.
    const restored=(job.steps || []).some(step=>step.name==='Restore verified unpublished snapshot without paid calls'&&step.conclusion==='success');
    const maySkip=restored&&(name==='Incrementally refresh current navigation and Gemini vectors'||name==='Promote verified bounded evidence assets');
    if(steps.length!==1 || !(steps[0].conclusion==='success'||(maySkip&&steps[0].conclusion==='skipped'))) fail('sync_checkpoint_required_stage_unverified');
  }
  const cpu=(job.steps || []).find(step=>step.name==='Incrementally synchronize and mechanically verify cloud evidence assets');
  if(cpu?.conclusion!=='failure') fail('sync_checkpoint_not_cpu_failure');
  return {headSha:run.head_sha, artifactName:`sync-resume-snapshot-${runId}-${run.run_attempt}`};
}
export async function validateCheckpointDirectory(directory) {
  const files=[];
  async function visit(base, prefix='') {
    for(const item of await fs.readdir(base,{withFileTypes:true})) {
      const relative=prefix?`${prefix}/${item.name}`:item.name;
      if(item.isSymbolicLink() || !/^[a-zA-Z0-9._/-]+$/.test(relative) || item.name.startsWith('.')) fail('sync_checkpoint_file_scope_invalid');
      if(item.isDirectory()) {
        if(!directories.has(relative)) fail('sync_checkpoint_directory_scope_invalid');
        await visit(path.join(base,item.name),relative);
      } else if(item.isFile()) {
        if(!/\.(?:json|json\.gz|json\.br|bm25\.gz|bin\.gz|f32)$/.test(item.name)) fail('sync_checkpoint_file_type_invalid');
        files.push(relative);
      } else fail('sync_checkpoint_file_type_invalid');
    }
  }
  await visit(directory);
  for(const required of ['cards.json','cards-lite.json','rulings.json','qa-index.json','ocg-rule-corpus.json',
    'snapshot-meta.json','rag-data-revision-manifest.json','rag-runtime-v1/manifest.json',
    'gemini-rule-qa-v1/canonical-manifest.json','gemini-rule-qa-v1/manifest.json',
    'cloud-evidence-v1/corpus-manifest.json','cloud-evidence-v1/evidence-vector-index.json']) {
    if(!files.includes(required)) fail('sync_checkpoint_required_file_missing');
  }
  const read = async p=>JSON.parse(await fs.readFile(path.join(directory,p),'utf8'));
  const [revision,runtime,bounded]=await Promise.all([read('rag-data-revision-manifest.json'),read('rag-runtime-v1/manifest.json'),read('gemini-rule-qa-v1/manifest.json')]);
  if(!/^[a-f0-9]{64}$/.test(revision.revision||'') || runtime.dataRevision!==revision.revision || bounded.dataRevision!==revision.revision) fail('sync_checkpoint_revision_mismatch');
  return {files,dataRevision:revision.revision};
}
export function shouldContinueCpu(progress, sequence) {
  return Number.isInteger(sequence)&&sequence>=0&&sequence<MAX_CPU_CONTINUATIONS
    && progress?.schemaVersion===1 && progress?.status==='paused_time'
    && Number.isInteger(progress.totalRows)&&progress.totalRows>0
    && Number.isInteger(progress.cachedRows)&&progress.cachedRows>=0
    && Number.isInteger(progress.computedRows)&&progress.computedRows>0
    && Number.isInteger(progress.remainingRows)&&progress.remainingRows>0
    && progress.cachedRows+progress.computedRows+progress.remainingRows===progress.totalRows;
}
async function output(values) {
  if(!process.env.GITHUB_OUTPUT) fail('sync_resume_output_required');
  await fs.appendFile(process.env.GITHUB_OUTPUT,Object.entries(values).map(([k,v])=>`${k}=${v}\n`).join(''));
}
async function command(program,args,options={}) { return (await exec(program,args,{maxBuffer:20*1024*1024,...options})).stdout.trim(); }
async function api(endpoint) { return JSON.parse(await command('gh',['api',endpoint])); }
export async function restoreCheckpoint({runId,sequence,repo,currentRunId,workspace,temp}) {
  if(!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo||'')) fail('sync_resume_repository_invalid');
  if(!runId) { await output({resumed:'false',resume_sequence:sequence}); return; }
  const endpoint=`repos/${repo}/actions/runs/${runId}`;
  const run=await api(endpoint);
  const jobs=await api(`${endpoint}/attempts/${run.run_attempt}/jobs?per_page=100`);
  const proof=validateCheckpointRun(run,jobs,{repo,runId,currentRunId});
  const git=args=>command('git',args,{cwd:workspace});
  await git(['merge-base','--is-ancestor',proof.headSha,'HEAD']);
  if(await git(['diff','--name-only',proof.headSha,'HEAD','--','data','public/data/cards-lite.json','public/data/snapshot-meta.json'])) fail('sync_checkpoint_published_base_changed');
  const artifacts=await api(`${endpoint}/artifacts?per_page=100`);
  const matches=(artifacts.artifacts||[]).filter(a=>a.name===proof.artifactName&&!a.expired);
  if(matches.length!==1 || String(matches[0].workflow_run?.id)!==runId) fail('sync_checkpoint_artifact_missing_or_ambiguous');
  const destination=await fs.mkdtemp(path.join(temp,'sync-restore-'));
  await command('gh',['run','download',runId,'--repo',repo,'--name',proof.artifactName,'--dir',destination]);
  const verified=await validateCheckpointDirectory(destination);
  // Only data is imported. Source code and workflows always come from main.
  const target=path.join(workspace,'data');
  for(const entry of await fs.readdir(target,{withFileTypes:true})) {
    if(directories.has(entry.name)||(entry.isFile()&&/\.json(?:\.gz)?$/.test(entry.name))) await fs.rm(path.join(target,entry.name),{recursive:true,force:true});
  }
  await fs.cp(destination,target,{recursive:true,force:true});
  await fs.mkdir(path.join(workspace,'public/data'),{recursive:true});
  for(const file of ['cards-lite.json','snapshot-meta.json']) await fs.copyFile(path.join(target,file),path.join(workspace,'public/data',file));
  await output({resumed:'true',resume_sequence:sequence});
  console.log(`SYNC RESTORED: run ${runId}; frozen revision ${verified.dataRevision}; source fetching and paid stages will be skipped.`);
}
async function main() {
  const inputs=parseResumeInputs(process.env.SYNC_RESUME_RUN_ID||'',process.env.SYNC_RESUME_SEQUENCE||'0');
  if(process.argv.includes('--check-progress')) {
    let progress=null;
    try { progress=JSON.parse(await fs.readFile(process.env.CLOUD_EMBED_PROGRESS_PATH,'utf8')); } catch {}
    const ready=shouldContinueCpu(progress,inputs.sequence);
    await output({ready:String(ready),next_sequence:inputs.sequence+1});
    const reason=ready?'paused_time_continuing':inputs.sequence>=MAX_CPU_CONTINUATIONS?'chain_limit_reached':!progress?'progress_missing':'not_a_positive_time_checkpoint';
    console.log('SYNC_CPU_STATUS '+JSON.stringify({reason,sequence:inputs.sequence,maxSequence:MAX_CPU_CONTINUATIONS,progress,published:false}));
    if(process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## CPU synchronization status\n${reason}; continuation ${inputs.sequence}/${MAX_CPU_CONTINUATIONS}.\n\n`+
      `Remaining rows: ${progress?.remainingRows ?? 'unknown'}. This run has NOT published new data.\n`);
    console.log(ready?'SYNC CPU CHECKPOINT: saved; continuing without source or paid work.':'SYNC CPU STOPPED: '+reason+'; saved data retained; no automatic paid restart.');
    return;
  }
  await restoreCheckpoint({...inputs,repo:process.env.GITHUB_REPOSITORY,currentRunId:process.env.GITHUB_RUN_ID,
    workspace:process.env.GITHUB_WORKSPACE,temp:process.env.RUNNER_TEMP});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
