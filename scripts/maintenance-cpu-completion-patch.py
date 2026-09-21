from pathlib import Path

def edit(file, old, new, count=1):
    p = Path(file)
    source = p.read_text()
    assert source.count(old) == count, (file, old, source.count(old))
    p.write_text(source.replace(old, new))

restore = 'scripts/restore-sync-checkpoint.mjs'
edit(restore, 'export const MAX_CPU_CONTINUATIONS = 4;', 'export const MAX_CPU_CONTINUATIONS = 8;')
edit(restore, '/^(?:0|[1-4])$/', '/^(?:0|[1-8])$/')
old = "console.log(ready?'SYNC CPU CHECKPOINT: progress saved; queue a CPU-only continuation.':'SYNC CPU: no automatic continuation (not a time checkpoint, no progress, or chain limit reached).');"
new = """const reason=ready?'paused_time_continuing':inputs.sequence>=MAX_CPU_CONTINUATIONS?'chain_limit_reached':!progress?'progress_missing':'not_a_positive_time_checkpoint';
    console.log('SYNC_CPU_STATUS '+JSON.stringify({reason,sequence:inputs.sequence,maxSequence:MAX_CPU_CONTINUATIONS,progress,published:false}));
    if(process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## CPU synchronization status\\n${reason}; continuation ${inputs.sequence}/${MAX_CPU_CONTINUATIONS}.\\n\\n`+
      `Remaining rows: ${progress?.remainingRows ?? 'unknown'}. This run has NOT published new data.\\n`);
    console.log(ready?'SYNC CPU CHECKPOINT: saved; continuing without source or paid work.':'SYNC CPU STOPPED: '+reason+'; saved data retained; no automatic paid restart.');"""
edit(restore, old, new)

workflow = '.github/workflows/sync-data.yml'
p = Path(workflow)
s = p.read_text()
s = s.replace("${{ inputs.resume_run_id || '' }}", "${{ steps.select_resume.outputs.run_id || '' }}")
s = s.replace("${{ inputs.resume_sequence || '0' }}", "${{ steps.select_resume.outputs.sequence || '0' }}")
before = '      - name: Restore verified unpublished snapshot without paid calls\n'
select = '\n'.join([
    '      - name: Select saved CPU checkpoint before new source or paid work',
    '        id: select_resume',
    '        env:',
    '          GH_TOKEN: ${{ github.token }}',
    "          SYNC_RESUME_RUN_ID: ${{ inputs.resume_run_id || '' }}",
    "          SYNC_RESUME_SEQUENCE: ${{ inputs.resume_sequence || '0' }}",
    '        run: node scripts/select-sync-cpu-checkpoint.mjs',
    '', '',
])
assert s.count(before) == 1
s = s.replace(before, select + before)
assert s.count('timeout-minutes: 120') == 1
s = s.replace('timeout-minutes: 120', 'timeout-minutes: 240')
assert s.count('timeout-minutes: 40') == 1
s = s.replace('timeout-minutes: 40', "timeout-minutes: ${{ steps.restore.outputs.resumed == 'true' && 180 || 40 }}")
s = s.replace('Bounded CPU continuation sequence, 0 through 4', 'Bounded CPU continuation sequence, 0 through 8; 0 derives the next saved sequence')
s = s.replace('^[1-4]$', '^[1-8]$')
s = s.replace('tests/sync-cpu-continuation.test.mjs\n', 'tests/sync-cpu-continuation.test.mjs tests/sync-cpu-selection.test.mjs\n')
old = '          CLOUD_EMBED_MAX_SECONDS: "2100"'
new = '\n'.join([
    "          CLOUD_EMBED_MAX_SECONDS: ${{ steps.restore.outputs.resumed == 'true' && 10500 || 2100 }}",
    "          CLOUD_EMBED_REQUIRED_CACHED_ROWS: ${{ steps.select_resume.outputs.required_cached_rows || '' }}",
    "          CLOUD_EMBED_EXPECTED_ROWS: ${{ steps.select_resume.outputs.expected_rows || '' }}",
])
assert s.count(old) == 1
s = s.replace(old, new)
a = s.index('      - name: Restore completed incremental embedding rows\n')
b = s.index('\n      - name:', a + 10)
block = '\n'.join([
    '      - name: Restore completed incremental embedding rows',
    '        uses: actions/cache/restore@v5',
    '        with:',
    '          path: .cache/cloud-embeddings',
    "          key: ${{ steps.select_resume.outputs.cache_key || format('cloud-embedding-rows-v1-{0}-{1}-{2}', runner.os, github.run_id, github.run_attempt) }}",
    "          restore-keys: ${{ steps.restore.outputs.resumed != 'true' && format('cloud-embedding-rows-v1-{0}-', runner.os) || '' }}",
    "          fail-on-cache-miss: ${{ steps.restore.outputs.resumed == 'true' }}",
    '',
])
s = s[:a] + block + s[b:]
p.write_text(s)

embed = 'scripts/embed-missing-cloud-evidence.py'
guard = '''def require_cached_progress(cached_rows, total_rows):
    floor = os.environ.get("CLOUD_EMBED_REQUIRED_CACHED_ROWS", "").strip()
    expected = os.environ.get("CLOUD_EMBED_EXPECTED_ROWS", "").strip()
    if not floor and not expected:
        return
    if not floor.isascii() or not floor.isdigit() or not expected.isascii() or not expected.isdigit():
        fail("cloud_sync_saved_cache_proof_invalid")
    if int(expected) != total_rows or cached_rows < int(floor) or int(floor) > total_rows:
        fail("cloud_sync_saved_cache_progress_regressed_no_recompute")


'''
edit(embed, 'def sha256_text(value):', guard + 'def sha256_text(value):')
edit(embed, '    progress_file = os.environ.get("CLOUD_EMBED_PROGRESS_PATH")',
     '    require_cached_progress(len(texts)-len(pending), len(texts))\n    progress_file = os.environ.get("CLOUD_EMBED_PROGRESS_PATH")')
tests = 'tests/sync-cpu-continuation.test.mjs'
edit(tests, "['123','5']", "['123','9']")
edit(tests, 'stop at four', 'stop at eight')
edit(tests, 'shouldContinueCpu(p,4),false', 'shouldContinueCpu(p,8),false')
selector = 'scripts/select-sync-cpu-checkpoint.mjs'
edit(selector, '  const api = async suffix =>', '  const explicit = Boolean(runId);\n  const api = async suffix =>')
edit(selector, 'if(sequence || process.env.SYNC_RESUME_RUN_ID)', 'if(explicit)')
edit(selector, 'if(process.env.SYNC_RESUME_RUN_ID)', 'if(explicit)')
print('CPU candidate patch applied; source/model contracts and paid budget unchanged.')
