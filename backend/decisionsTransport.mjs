import { decisionsCostUsd, measureDecisionsRequest, runOfficialDecisionsRequest, runOfficialDecisionsSequence } from './cloudRequestBudget.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export { decisionsCostUsd };
export const DECISIONS_ENDPOINT = 'https://api.openai.com/v1/decisions';
const RETRYABLE_HTTP = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const RETRY_DELAY_MS = 500;
const safeRequestId = response => {
  const value = response.headers?.get?.('x-request-id');
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/u.test(value) ? value : null;
};

function requestQuestions(request) {
  measureDecisionsRequest(request);
  const questions = new Map();
  for (const question of request.questions) {
    const name = typeof question?.name === 'string' ? question.name.trim() : '';
    if (!name || questions.has(name) || question.type !== 'choice'
        || typeof question.instructions !== 'string'
        || !Array.isArray(question.choices) || question.choices.length < 2 || question.choices.length > 255) {
      throw new Error('decisions_question_contract_invalid');
    }
    const choices = new Map();
    for (const choice of question.choices) {
      const value = typeof choice?.value === 'string' ? choice.value.trim() : '';
      if (!value || choices.has(value)) throw new Error('decisions_choice_contract_invalid');
      choices.set(value, choice.value);
    }
    questions.set(name, {name:question.name, choices});
  }
  return questions;
}

// Identity, count, type and offered-value validation only. No evidence meaning
// or confidence is inspected; an explicit refusal is recorded as UNKNOWN.
export function parseDecisionsAnswers(raw, request) {
  const questions = requestQuestions(request);
  if (raw?.model !== undefined && raw.model !== request.model) throw new Error('decisions_returned_model_mismatch');
  if (!Array.isArray(raw?.answers) || raw.answers.length !== questions.size) {
    throw new Error('decisions_answer_count_mismatch');
  }
  const answers = new Map();
  for (const answer of raw.answers) {
    const name = typeof answer?.name === 'string' ? answer.name.trim() : '';
    const question = questions.get(name);
    if (!question || answers.has(name)) throw new Error('decisions_answer_identity_mismatch');
    if (answer.type === 'refusal') answers.set(name, 'UNKNOWN');
    else {
      const choice = typeof answer.choice === 'string' ? answer.choice.trim() : '';
      if (answer.type !== 'choice' || !question.choices.has(choice)) throw new Error('decisions_answer_choice_invalid');
      answers.set(name, question.choices.get(choice));
    }
  }
  return Object.fromEntries([...questions].map(([name, question]) => [question.name, answers.get(name)]));
}

export function createDecisionsTransport({env = process.env, fetchImpl = globalThis.fetch,
  budgetedRequest = runOfficialDecisionsRequest,
  waitBeforeRetry = (milliseconds, {signal}) => delay(milliseconds, undefined, {signal})} = {}) {
  if (typeof fetchImpl !== 'function' || typeof budgetedRequest !== 'function' || typeof waitBeforeRetry !== 'function') {
    throw new Error('decisions_transport_configuration_invalid');
  }
  function measure(body) {
    requestQuestions(body);
    return measureDecisionsRequest(body);
  }
  async function invoke(body, {signal, measurement, onDispatch, beforeRetry} = {}) {
    signal?.throwIfAborted();
    if (onDispatch !== undefined && typeof onDispatch !== 'function') throw new Error('decisions_dispatch_callback_invalid');
    if (beforeRetry !== undefined && typeof beforeRetry !== 'function') throw new Error('decisions_retry_callback_invalid');
    const measured = measure(body);
    if (measurement !== undefined && Object.keys(measured).some(key => measurement?.[key] !== measured[key])) {
      throw new Error('decisions_measurement_mismatch');
    }
    const apiKey = String(env.OPENAI_DECISIONS_API_KEY || '').trim() || String(env.OPENAI_API_KEY || '').trim();
    if (!apiKey) throw new Error('decisions_api_key_required');
    const timeoutMs = Number(env.OPENAI_DECISIONS_TIMEOUT_MS ?? 60000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('decisions_timeout_invalid');
    // Bind the bytes sent to the measured snapshot before awaiting the ledger.
    const wire = JSON.stringify(body);
    const attempts = [];
    const metadata = () => {
      const lastResponse = attempts.findLast(attempt => attempt.httpStatus !== null);
      return {provider:'openai', operation:'decisions', attemptCount:attempts.length,
        dispatchCount:attempts.filter(attempt => attempt.dispatched).length,
        upstreamHttpStatus:lastResponse?.httpStatus ?? null, requestId:lastResponse?.requestId ?? null,
        unknownReservedUsd:attempts.filter(attempt => attempt.dispatched && !attempt.usageKnown).length * measured.estimatedCostUsd,
        attempts:structuredClone(attempts)};
    };
    const fail = error => {
      // Preserve the original exception and caller cancellation identity. Only
      // these observed mechanical fields are attached; provider bodies are not.
      if (error && typeof error === 'object') error.decisionsFailure = metadata();
      return error;
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const row = {attempt, dispatched:false, httpStatus:null, requestId:null, elapsedMs:0, outcome:'pending', usageKnown:false};
      attempts.push(row);
      const started = performance.now();
      let explicitHttpError = null;
      try {
        // A new budget reservation is required for each actual attempt. The
        // previous unknown ticket is retained by the existing budget layer.
        const raw = await budgetedRequest({env, body:JSON.parse(wire), signal:requestSignal, measurement:measured, fetchImpl,
          invoke:async () => {
            requestSignal.throwIfAborted();
            onDispatch?.({attempt, requestSha256:measured.requestSha256, reservedUsd:measured.estimatedCostUsd});
            row.dispatched = true;
            const response = await fetchImpl(DECISIONS_ENDPOINT, {
              method:'POST', redirect:'error', signal:requestSignal,
              headers:{authorization:`Bearer ${apiKey}`, 'content-type':'application/json'}, body:wire,
            });
            row.httpStatus = response.status ?? null;
            row.requestId = safeRequestId(response);
            if (!response.ok) {
              explicitHttpError = new Error(`decisions_http_${response.status}`);
              explicitHttpError.code = 'decisions_http_error';
              explicitHttpError.status = response.status; explicitHttpError.statusCode = response.status;
              throw explicitHttpError;
            }
            try { return await response.json(); }
            catch {
              requestSignal.throwIfAborted();
              throw new Error('decisions_response_json_invalid');
            }
          }});
        row.outcome = 'response_received'; row.elapsedMs = performance.now() - started;
        row.usageKnown = Number.isSafeInteger(raw?.usage?.input_tokens) && raw.usage.input_tokens >= 0;
        // Usage is returned before choice validation. Metadata only appears
        // after a retry; ordinary successful responses retain their contract.
        return attempt === 1 ? raw : {...raw, decisionsTransport:metadata()};
      } catch (error) {
        row.outcome = explicitHttpError === error ? 'http_error' : row.dispatched ? 'transport_error' : 'not_dispatched';
        row.elapsedMs = performance.now() - started;
        if (signal?.aborted) throw fail(signal.reason);
        if (attempt === 2 || error !== explicitHttpError || !RETRYABLE_HTTP.has(row.httpStatus)) throw fail(error);
        try {
          await beforeRetry?.({measurement:measured, attempts:structuredClone(attempts)});
          signal?.throwIfAborted();
          await waitBeforeRetry(RETRY_DELAY_MS, {signal});
          signal?.throwIfAborted();
        } catch (retryError) { throw fail(signal?.aborted ? signal.reason : retryError); }
      }
    }
  }
  return {measure, invoke,
    // Injected budget adapters retain their own accounting contract. Production
    // selection explicitly wraps its sequential work so the last ticket is
    // settled on every exit path, including selection/validation failures.
    runSequence:callback => budgetedRequest === runOfficialDecisionsRequest
      ? runOfficialDecisionsSequence(callback) : callback()};
}
