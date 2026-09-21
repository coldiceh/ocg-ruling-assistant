// Read-only checkpoint selection. Never fetch sources, invoke models, or reset a batch.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify, stripVTControlCharacters} from 'node:util';
import {fileURLToPath} from 'node:url';
import {MAX_CPU_CONTINUATIONS, parseResumeInputs, validateCheckpointRun} from './restore-sync-checkpoint.mjs';
const exec = promisify(execFile);
const fail = code => {throw new Error(code);};
const cpuStep = 'Incrementally synchronize and mechanically verify cloud evidence assets';
export function selectPreviousMainRun(runs, currentRunId) {
  if (!/^[1-9][0-9]*$/.test(String(currentRunId))) fail('sync_current_run_id_invalid');
  return [...runs].filter(r => r.head_branch === 'main' && r.path === '.github/workflows/sync-data.yml'
    && /^[1-9][0-9]*$/.test(String(r.id)) && BigInt(r.id) < BigInt(currentRunId))
    .sort((a,b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1)[0] || null;
}
export function parseCpuCheckpointLog(raw) {
  const lines = stripVTControlCharacters(raw).split(/\r?\n/)
    .map(line => line.replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ''));
  const matches = expression => lines.map(line => line.match(expression)).filter(Boolean);
  const cache = matches(/^cloud-embedding-cache:reused=(\d+) pending=(\d+)$/).at(-1);
  const done = matches(/^missing-cloud-embeddings:(\d+)\/(\d+)$/).at(-1);
  const sequences = [...new Set(matches(/^\s*SYNC_RESUME_SEQUENCE:\s*(\d+)\s*$/).map(m => Number(m[1])))];
  const states = lines.filter(line=>line.startsWith('SYNC_CPU_STATUS '))
    .map(line=>JSON.parse(line.slice('SYNC_CPU_STATUS '.length)));
  if(states.length>1 || (!states.length && sequences.length>1)) fail('sync_checkpoint_sequence_ambiguous');
  const sequence = states.length ? states[0].sequence : (sequences[0] ?? 0);
  const cachedRows = Number(cache?.[1]), pendingRows = Number(cache?.[2]);
  const computedRows = Number(done?.[1]);
  if (!lines.includes('cloud_sync_embedding_checkpoint_saved:resume_next_run')
    || !lines.includes('Error: cloud_sync_embedder_exit_75')
    || ![cachedRows,pendingRows,computedRows,sequence].every(Number.isSafeInteger)
    || cachedRows < 0 || computedRows <= 0 || computedRows >= pendingRows
    || Number(done?.[2]) !== pendingRows || sequence < 0 || sequence > MAX_CPU_CONTINUATIONS
    || !Number.isSafeInteger(cachedRows + pendingRows)) fail('sync_checkpoint_not_positive_time_pause');
  const checkpoint = {schemaVersion:1,status:'paused_time',totalRows:cachedRows+pendingRows,
    cachedRows,computedRows,remainingRows:pendingRows-computedRows,sequence};
  if(states.length) {
    if(states[0].published !== false || !['paused_time_continuing','chain_limit_reached'].includes(states[0].reason))
      fail('sync_checkpoint_structured_status_invalid');
    validateProgressProof(states[0].progress,checkpoint);
  }
  return checkpoint;
}
export function nextCpuSequence(previous, requested = 0) {
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= MAX_CPU_CONTINUATIONS)
    fail('sync_cpu_chain_limit_reached_no_paid_restart');
  const next = previous + 1;
  if (!Number.isSafeInteger(requested) || (requested !== 0 && requested !== next))
    fail('sync_checkpoint_sequence_cannot_reset_or_jump');
  return next;
}
export function validateProgressProof(progress, logged) {
  for (const field of ['schemaVersion','status','totalRows','cachedRows','computedRows','remainingRows'])
    if (progress?.[field] !== logged[field]) fail('sync_checkpoint_progress_proof_mismatch');
  return progress;
}
async function command(program, args, options = {}) {
  try { return (await exec(program,args,{maxBuffer:32*1024*1024,timeout:120000,...options})).stdout.trim(); }
  catch { fail('sync_checkpoint_read_command_failed_no_paid_restart'); }
}
async function output(values) {
  if (!process.env.GITHUB_OUTPUT) fail('sync_checkpoint_output_required');
  await fs.appendFile(process.env.GITHUB_OUTPUT,Object.entries(values).map(([k,v])=>`${k}=${v}\n`).join(''));
}
export async function selectCheckpoint({repo,currentRunId,workspace,temp,runId='',sequence=0}) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo || '')) fail('sync_resume_repository_invalid');
  const explicit = Boolean(runId);
  const api = async suffix => JSON.parse(await command('gh',['api',`repos/${repo}/${suffix}`]));
  const recent = await api('actions/workflows/sync-data.yml/runs?branch=main&per_page=100');
  const latest = selectPreviousMainRun(recent.workflow_runs || [],currentRunId);
  const fresh = async () => { await output({run_id:'',sequence:0}); return {mode:'fresh'}; };
  if (!runId && (!latest || latest.conclusion === 'success')) return fresh();
  if (runId && String(latest?.id) !== runId) fail('sync_checkpoint_not_latest_no_duplicate_or_regression');
  runId ||= String(latest.id);
  const endpoint = `actions/runs/${runId}`;
  let run = await api(endpoint);
  // A dispatched child can start just before its parent's dispatch job finishes.
  for(let tries=0; run.status!=='completed' && tries<10; tries++) {
    await new Promise(resolve => setTimeout(resolve,2000)); run = await api(endpoint);
  }
  if(run.status !== 'completed') fail('sync_previous_run_active_no_duplicate');
  const jobs = await api(`${endpoint}/attempts/${run.run_attempt}/jobs?per_page=100`);
  const job = (jobs.jobs || []).find(j=>j.name==='sync');
  if(run.conclusion !== 'failure' || job?.steps?.find(s=>s.name===cpuStep)?.conclusion !== 'failure') {
    if(explicit) fail('sync_requested_checkpoint_not_cpu_pause');
    if(job?.steps?.some(s=>['Select saved CPU checkpoint before new source or paid work',
      'Restore verified unpublished snapshot without paid calls'].includes(s.name) && s.conclusion==='failure'))
      fail('sync_previous_checkpoint_failure_no_paid_restart');
    if(job?.steps?.some(s=>s.name==='Select saved CPU checkpoint before new source or paid work' && s.conclusion==='success')) {
      const previousLog=stripVTControlCharacters(await command('gh',['api',`repos/${repo}/actions/jobs/${job.id}/logs`,'--allow-escape-sequences']));
      if(previousLog.split(/\r?\n/).some(line=>/^\d{4}-\d{2}-\d{2}T[\d:.]+Z SYNC_CPU_SELECTION /.test(line)))
        fail('sync_previous_checkpoint_failure_no_paid_restart');
    }
    if(run.conclusion === 'cancelled') fail('sync_previous_run_cancelled_reinspect_before_paid_work');
    return fresh();
  }
  const proof = validateCheckpointRun(run,jobs,{repo,runId,currentRunId});
  for(const name of ['Preserve completed vectors even after an interrupted increment',
    'Preserve unpublished source and derived assets after downstream failure']) {
    if(job.steps.find(s=>s.name===name)?.conclusion !== 'success') fail('sync_checkpoint_preservation_unverified');
  }
  await command('git',['merge-base','--is-ancestor',proof.headSha,'HEAD'],{cwd:workspace});
  const changed = await command('git',['diff','--name-only',proof.headSha,'HEAD','--','data',
    'public/data/cards-lite.json','public/data/snapshot-meta.json'],{cwd:workspace});
  if(changed) {
    if(explicit) fail('sync_checkpoint_published_base_changed');
    return fresh();
  }
  // Narrow escape opt-in for a captured API log, then remove terminal controls. Never print raw logs.
  const logged = parseCpuCheckpointLog(await command('gh',['api',`repos/${repo}/actions/jobs/${job.id}/logs`,'--allow-escape-sequences']));
  const next = nextCpuSequence(logged.sequence,sequence);
  const artifacts = (await api(`${endpoint}/artifacts?per_page=100`)).artifacts || [];
  const exact = name => artifacts.filter(a=>a.name===name && !a.expired && String(a.workflow_run?.id)===runId);
  if(exact(proof.artifactName).length !== 1) fail('sync_checkpoint_snapshot_missing_no_paid_restart');
  const progressName = `cloud-sync-progress-${runId}-${run.run_attempt}`;
  const progressArtifacts = exact(progressName);
  if(progressArtifacts.length === 1) {
    const dir = await fs.mkdtemp(path.join(temp || os.tmpdir(),'cpu-proof-'));
    try {
      await command('gh',['run','download',runId,'--repo',repo,'--name',progressName,'--dir',dir]);
      validateProgressProof(JSON.parse(await fs.readFile(path.join(dir,'cloud-sync-progress.json'),'utf8')),logged);
    } finally {await fs.rm(dir,{recursive:true,force:true});}
  } else if(progressArtifacts.length || job.steps.some(s=>s.name==='Preserve CPU progress diagnostics')) {
    fail('sync_checkpoint_progress_artifact_missing_or_ambiguous');
  }
  const cacheKey = `cloud-embedding-rows-v1-Linux-${runId}-${run.run_attempt}`;
  const caches = (await api(`actions/caches?key=${cacheKey}&per_page=100`)).actions_caches || [];
  if(!caches.some(c=>c.key===cacheKey && c.ref==='refs/heads/main' && c.size_in_bytes>0))
    fail('sync_checkpoint_cpu_cache_missing_no_recompute');
  const values={run_id:runId,sequence:next,cache_key:cacheKey,
    expected_rows:logged.totalRows,required_cached_rows:logged.cachedRows+logged.computedRows};
  await output(values);
  const summary={mode:'cpu_resume',...values,remaining_rows:logged.remainingRows,
    source_sequence:logged.sequence,max_sequence:MAX_CPU_CONTINUATIONS,model_api_calls:0};
  console.log('SYNC_CPU_SELECTION '+JSON.stringify(summary));
  if(process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## CPU checkpoint selected\nSource run: ${runId}; continuation ${next}/${MAX_CPU_CONTINUATIONS}.\n\n`+
    `Saved rows: ${values.required_cached_rows}/${logged.totalRows}; remaining: ${logged.remainingRows}.\n\n`+
    `Sources and paid stages will be skipped only after snapshot restoration succeeds. New data is not yet published.\n`);
  return summary;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const parsed=parseResumeInputs(process.env.SYNC_RESUME_RUN_ID || '',process.env.SYNC_RESUME_SEQUENCE || '0');
  await selectCheckpoint({...parsed,repo:process.env.GITHUB_REPOSITORY,currentRunId:process.env.GITHUB_RUN_ID,
    workspace:process.env.GITHUB_WORKSPACE || process.cwd(),temp:process.env.RUNNER_TEMP});
}
