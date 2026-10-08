import { decisionsCostUsd, measureDecisionsRequest, runOfficialDecisionsRequest } from './cloudRequestBudget.mjs';

export { decisionsCostUsd };
export const DECISIONS_ENDPOINT = 'https://api.openai.com/v1/decisions';

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
  budgetedRequest = runOfficialDecisionsRequest} = {}) {
  if (typeof fetchImpl !== 'function' || typeof budgetedRequest !== 'function') {
    throw new Error('decisions_transport_configuration_invalid');
  }
  function measure(body) {
    requestQuestions(body);
    return measureDecisionsRequest(body);
  }
  async function invoke(body, {signal, measurement, onDispatch} = {}) {
    signal?.throwIfAborted();
    if (onDispatch !== undefined && typeof onDispatch !== 'function') throw new Error('decisions_dispatch_callback_invalid');
    const measured = measure(body);
    if (measurement !== undefined && Object.keys(measured).some(key => measurement?.[key] !== measured[key])) {
      throw new Error('decisions_measurement_mismatch');
    }
    const apiKey = String(env.OPENAI_DECISIONS_API_KEY || '').trim() || String(env.OPENAI_API_KEY || '').trim();
    if (!apiKey) throw new Error('decisions_api_key_required');
    const timeoutMs = Number(env.OPENAI_DECISIONS_TIMEOUT_MS ?? 60000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('decisions_timeout_invalid');
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // Bind the bytes sent to the measured snapshot before awaiting the ledger.
    const wire = JSON.stringify(body);
    const request = JSON.parse(wire);
    const raw = await budgetedRequest({env, body:request, signal:requestSignal, measurement:measured, fetchImpl,
      invoke:async () => {
        requestSignal.throwIfAborted();
        onDispatch?.();
        const response = await fetchImpl(DECISIONS_ENDPOINT, {
          method:'POST', redirect:'error', signal:requestSignal,
          headers:{authorization:`Bearer ${apiKey}`, 'content-type':'application/json'}, body:wire,
        });
        if (!response.ok) {
          const error = new Error(`decisions_http_${response.status}`);
          error.code = 'decisions_http_error'; error.status = response.status;
          throw error;
        }
        try { return await response.json(); }
        catch {
          requestSignal.throwIfAborted();
          throw new Error('decisions_response_json_invalid');
        }
      }});
    // Return the received usage even when answer validation will fail. The
    // caller accounts for that observed usage before parseDecisionsAnswers.
    return raw;
  }
  return {measure, invoke};
}
