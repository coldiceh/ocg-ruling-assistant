import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const API_ROOT = 'https://api.b.ai/v1';
const ALIASES = Object.freeze({
  astra: ['gpt-6-astra'],
  deepseek: ['DeepSeek-V4.1-Flash', 'deepseek-v4.1-flash'],
  glm: ['glm-5.3-flash', 'GLM-5.3-Flash', 'glm-5-3-flash', 'GLM-5-3-Flash'],
});
const RETRY_HTTP = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const inputPath = path.resolve(process.env.PILOT_INPUT_FILE || 'inputs.enc.json');
const outDir = path.resolve(process.env.PILOT_OUTPUT_DIR || 'pilot-encrypted-results');
let archiveKey;

function requireFact(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function log(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
async function exists(file) { try { await access(file); return true; } catch { return false; } }
function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', archiveKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function decrypt(bytes) {
  const envelope = JSON.parse(String(bytes));
  const iv = Buffer.from(envelope.iv || '', 'base64');
  const tag = Buffer.from(envelope.tag || '', 'base64');
  requireFact(iv.length === 12 && tag.length === 16, 'invalid_encrypted_envelope');
  const decipher = createDecipheriv('aes-256-gcm', archiveKey, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext || '', 'base64')), decipher.final()]).toString('utf8'));
}
async function save(name, value) {
  const target = path.join(outDir, name);
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(encrypt(value)), { mode: 0o600 });
  await rename(temporary, target);
}
function familyOf(model) {
  return Object.entries(ALIASES).find(([, names]) => names.includes(model))?.[0] || null;
}
function validateInput(input) {
  requireFact(input?.schemaVersion === 1 && typeof input.runId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(input.runId), 'invalid_run_contract');
  requireFact(Array.isArray(input.cells) && input.cells.length >= 1 && input.cells.length <= 30, 'cell_count_outside_1_to_30');
  requireFact(new Set(input.cells.map(cell => cell.cellId)).size === input.cells.length, 'duplicate_cell_id');
  for (const cell of input.cells) {
    requireFact(/^[a-zA-Z0-9_-]{1,100}$/.test(cell.cellId || ''), 'invalid_cell_id');
    requireFact(typeof cell.questionId === 'string' && ['F', 'Q'].includes(cell.group), 'invalid_cell_metadata');
    const request = cell.request;
    const family = familyOf(request?.model);
    requireFact(Boolean(family), 'model_outside_frozen_allowlist');
    requireFact(Array.isArray(request.messages) && request.messages.length > 0, 'messages_required');
    requireFact(request.messages.every(message => ['system', 'developer', 'user'].includes(message.role) && typeof message.content === 'string'), 'invalid_frozen_messages');
    requireFact(!request.tools?.length && !request.functions?.length, 'tools_not_allowed');
    requireFact(request.n === undefined || request.n === 1, 'one_completion_per_cell_required');
    requireFact(request.stream === true && request.stream_options?.include_usage === true, 'stream_usage_required');
    requireFact(request.reasoning_effort === (family === 'astra' ? 'low' : 'max'), 'reasoning_setting_changed');
    if (family !== 'astra') requireFact(request.thinking?.type === 'enabled', 'thinking_must_be_enabled');
    const maximum = family === 'astra' ? request.max_completion_tokens : request.max_tokens;
    requireFact(Number.isSafeInteger(maximum) && maximum > 0, 'explicit_output_limit_required');
  }
}

function hasProviderOutput(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return payload.usage != null || (Array.isArray(payload.output) && payload.output.length > 0)
    || (Array.isArray(payload.choices) && payload.choices.some(choice => {
      const message = choice.message || choice.delta || {};
      return Boolean(message.content || message.reasoning_content || message.reasoning || message.tool_calls?.length);
    }));
}

async function invoke(request, apiKey, cellStarted) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  const state = { startedAt: new Date().toISOString(), httpStatus: null, content: '', usage: null,
    returnedModels: [], finishReasons: [], firstAnswerMs: null, firstAnswerFromCellStartMs: null, doneReceived: false, rawResponse: '',
    retryEligible: false, status: 'technical_failure', errorCode: null };
  const consume = block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data.trim()) return;
    if (data.trim() === '[DONE]') { state.doneReceived = true; return; }
    const payload = JSON.parse(data);
    if (payload.error) throw Object.assign(new Error('provider_stream_error'), { code: 'provider_stream_error' });
    if (typeof payload.model === 'string' && !state.returnedModels.includes(payload.model)) state.returnedModels.push(payload.model);
    if (payload.usage != null) state.usage = payload.usage;
    for (const choice of payload.choices || []) {
      requireFact(choice.index === undefined || choice.index === 0, 'unexpected_multiple_choices');
      const chunk = choice.delta?.content ?? choice.message?.content;
      if (typeof chunk === 'string' && chunk.length > 0) {
        if (state.firstAnswerMs === null && chunk.trim().length > 0) {
          const firstAnswerAt = performance.now();
          state.firstAnswerMs = firstAnswerAt - started;
          state.firstAnswerFromCellStartMs = firstAnswerAt - cellStarted;
        }
        state.content += chunk;
      }
      if (choice.finish_reason != null && !state.finishReasons.includes(choice.finish_reason)) state.finishReasons.push(choice.finish_reason);
    }
  };
  try {
    const response = await fetch(`${API_ROOT}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(request), signal: controller.signal,
    });
    state.httpStatus = response.status;
    state.responseHeadersMs = performance.now() - started;
    state.providerRequestId = response.headers.get('x-request-id') || response.headers.get('request-id') || null;
    if (!response.ok) {
      state.rawResponse = await response.text();
      let payload = null;
      try { payload = JSON.parse(state.rawResponse); } catch { /* Error bodies may be plain text. */ }
      state.usage = payload?.usage ?? null;
      const isEventStream = response.headers.get('content-type')?.includes('text/event-stream')
        || /^data:/m.test(state.rawResponse);
      state.retryEligible = RETRY_HTTP.has(response.status) && !hasProviderOutput(payload) && !isEventStream;
      state.errorCode = `http_${response.status}`;
      return state;
    }
    requireFact(response.body, 'response_stream_missing');
    const decoder = new TextDecoder();
    let pending = '';
    for await (const bytes of response.body) {
      const text = decoder.decode(bytes, { stream: true });
      state.rawResponse += text;
      pending += text;
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const block = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        consume(block);
      }
    }
    const tail = decoder.decode();
    state.rawResponse += tail;
    pending += tail;
    if (pending.trim()) consume(pending);
    if (!state.content.trim()) state.errorCode = 'empty_answer';
    else if (state.finishReasons.length !== 1 || state.finishReasons[0] !== 'stop') state.errorCode = state.finishReasons.includes('length') ? 'output_truncated' : 'completion_not_confirmed';
    else state.status = 'completed';
  } catch (error) {
    state.errorCode = controller.signal.aborted ? 'timeout_outcome_unknown' : (error.code || 'transport_or_stream_failure');
    state.retryEligible = false;
  } finally {
    clearTimeout(timer);
    state.elapsedMs = performance.now() - started;
    state.completedAt = new Date().toISOString();
  }
  return state;
}

async function runCell(cell, resolvedModel, apiKey, inputHash) {
  const checkpointName = `${cell.cellId}.checkpoint.enc.json`;
  const checkpointPath = path.join(outDir, checkpointName);
  if (await exists(checkpointPath)) {
    const previous = decrypt(await readFile(checkpointPath));
    requireFact(previous.inputHash === inputHash, 'checkpoint_input_changed');
    log({ cellId: cell.cellId, status: 'skipped_already_started', elapsedMs: previous.elapsedMs ?? null, usage: previous.usage ?? null });
    return { cellId: cell.cellId, status: previous.status, skippedAlreadyStarted: true, checkpoint: checkpointName };
  }
  const started = performance.now();
  const request = { ...cell.request, model: resolvedModel };
  const record = { schemaVersion: 1, cellId: cell.cellId, questionId: cell.questionId, group: cell.group,
    label: cell.label, inputHash, originalRequestedModel: cell.request.model, actualRequest: request,
    actualRequestSha256: hash(JSON.stringify(request)), startedAt: new Date().toISOString(), status: 'started', attempts: [] };
  await save(checkpointName, record);
  log({ cellId: cell.cellId, status: 'started' });
  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex++) {
    const attempt = { attemptNumber: attemptIndex + 1, status: 'started', startedAt: new Date().toISOString() };
    record.attempts.push(attempt);
    await save(checkpointName, record);
    Object.assign(attempt, await invoke(request, apiKey, started));
    await save(`${cell.cellId}.attempt-${attemptIndex + 1}.enc.json`, attempt);
    await save(checkpointName, record);
    if (!(attemptIndex === 0 && attempt.retryEligible)) break;
    attempt.retryDelayMs = 2000;
    await save(checkpointName, record);
    await new Promise(resolve => setTimeout(resolve, attempt.retryDelayMs));
  }
  const finalAttempt = record.attempts.at(-1);
  record.status = finalAttempt.status;
  record.answer = finalAttempt.content;
  record.usage = finalAttempt.usage;
  record.errorCode = finalAttempt.errorCode;
  record.elapsedMs = performance.now() - started;
  record.completedAt = new Date().toISOString();
  record.firstAnswerMs = finalAttempt.firstAnswerFromCellStartMs;
  await save(checkpointName, record);
  await save(`${cell.cellId}.result.enc.json`, record);
  log({ cellId: cell.cellId, status: record.status, elapsedMs: record.elapsedMs, usage: record.usage });
  return { cellId: cell.cellId, status: record.status, attempts: record.attempts.length, elapsedMs: record.elapsedMs, resultFile: `${cell.cellId}.result.enc.json` };
}

async function main() {
  requireFact(!process.env.GITHUB_RUN_ATTEMPT || process.env.GITHUB_RUN_ATTEMPT === '1', 'github_workflow_rerun_forbidden');
  archiveKey = Buffer.from(process.env.PILOT_ARCHIVE_KEY || '', 'base64');
  requireFact(archiveKey.length === 32, 'archive_key_must_be_32_bytes');
  const apiKey = String(process.env.BAI_API_KEY || '').trim();
  requireFact(apiKey.length > 0, 'bai_key_missing');
  const inputBytes = await readFile(inputPath);
  const inputHash = hash(inputBytes);
  const input = decrypt(inputBytes);
  validateInput(input);
  await mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'run-manifest.enc.json');
  if (await exists(manifestPath)) requireFact(decrypt(await readFile(manifestPath)).inputHash === inputHash, 'output_directory_input_mismatch');
  else await save('run-manifest.enc.json', { runId: input.runId, inputHash, cellCount: input.cells.length,
    createdAt: new Date().toISOString(), githubRunId: process.env.GITHUB_RUN_ID || null, allowedAliases: ALIASES });

  // Read-only preflight. It cannot change models outside the explicit alias lists.
  const response = await fetch(`${API_ROOT}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000) });
  requireFact(response.ok, `model_list_http_${response.status}`);
  const models = await response.json();
  const available = new Set((models.data || []).map(model => model.id));
  const resolved = new Map();
  for (const cell of input.cells) {
    const aliases = ALIASES[familyOf(cell.request.model)];
    const model = available.has(cell.request.model) ? cell.request.model : aliases.find(alias => available.has(alias));
    requireFact(Boolean(model), `requested_model_unavailable_${familyOf(cell.request.model)}`);
    resolved.set(cell.cellId, model);
  }
  await save('model-preflight.enc.json', { checkedAt: new Date().toISOString(), models,
    resolvedModels: input.cells.map(cell => ({ cellId: cell.cellId, requested: cell.request.model, resolved: resolved.get(cell.cellId) })) });
  const queues = Object.keys(ALIASES).map(family => input.cells.filter(cell => familyOf(cell.request.model) === family));
  const queueResults = queues.map(() => []);
  const outcomes = await Promise.allSettled(queues.map(async (cells, index) => {
    for (const cell of cells) queueResults[index].push(await runCell(cell, resolved.get(cell.cellId), apiKey, inputHash));
  }));
  const summary = { runId: input.runId, inputHash, completedAt: new Date().toISOString(), cells: queueResults.flat(), infrastructureErrors: [] };
  for (let index = 0; index < outcomes.length; index++) {
    const outcome = outcomes[index];
    if (outcome.status === 'rejected') summary.infrastructureErrors.push({ queue: Object.keys(ALIASES)[index], code: outcome.reason?.code || 'local_checkpoint_failure' });
  }
  await save('run-summary.enc.json', summary);
  log({ status: summary.infrastructureErrors.length ? 'finished_with_infrastructure_errors' : 'finished', cellCount: summary.cells.length });
  if (summary.infrastructureErrors.length) process.exitCode = 1;
}

main().catch(async error => {
  const code = error?.code && /^[a-zA-Z0-9_]+$/.test(error.code) ? error.code : 'pilot_preflight_or_storage_failure';
  if (archiveKey?.length === 32) {
    try { await mkdir(outDir, { recursive: true }); await save('run-error.enc.json', { code, recordedAt: new Date().toISOString() }); } catch { /* Never print private diagnostics. */ }
  }
  log({ status: 'stopped', code });
  process.exitCode = 1;
});
