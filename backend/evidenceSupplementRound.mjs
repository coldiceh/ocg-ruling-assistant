// One supplementary evidence round after the final model reports, in its
// explicit status line (evidenceStatusProtocol.mjs), that the supplied
// evidence was insufficient. Every decision here is mechanical: the switch,
// the model-written status field, the first round's bounded-evidence identity,
// package room and invocation time. Nothing reads or judges the answer text.
import { createHash } from 'node:crypto';
import { callRagModel } from './ragModelClient.mjs';
import { EVIDENCE_STATUSES, evidenceSupplementEnabled } from './evidenceStatusProtocol.mjs';
import { boundedEvidenceMaxPromptChars,
  createGeminiBoundedEvidenceProvider } from './geminiBoundedEvidenceProvider.mjs';

export const EVIDENCE_SUPPLEMENT_PHASE = 'evidence_supplement';
// api/answer.js runs at most 300 s (vercel.json maxDuration). Like the engine
// reproduction wait (engineRepro/session.mjs DEFAULT_WAIT_BUDGET_MS), keep the
// last 20 s for the audit update and the response.
export const EVIDENCE_SUPPLEMENT_INVOCATION_BUDGET_MS = 280_000;
export const DEFAULT_EVIDENCE_SUPPLEMENT_ESTIMATED_ROUND_MS = 110_000;

export { evidenceSupplementEnabled };

export function evidenceSupplementEstimatedRoundMs(env = {}) {
  const value = Number(env.EVIDENCE_SUPPLEMENT_ESTIMATED_ROUND_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_EVIDENCE_SUPPLEMENT_ESTIMATED_ROUND_MS;
}

/**
 * Decide whether the single supplementary round starts. `invocationStartedAt`
 * is when the current serverless invocation began: the public request for a
 * single-request answer (external API/Bot), or the finalize request for the
 * web page's prepared answer.
 */
export function decideEvidenceSupplement({ env = {}, continuation, firstModelResult, invocationStartedAt,
  invocationShape = 'prepared_finalize', nowMs = Date.now(), requestCancelled = false } = {}) {
  const answer = firstModelResult?.answer || {};
  const evidenceStatus = EVIDENCE_STATUSES.includes(answer.evidenceStatus) ? answer.evidenceStatus : 'unknown';
  const evidenceGap = evidenceStatus === 'insufficient' ? String(answer.evidenceGap || '').trim() : '';
  const base = { enabled: evidenceSupplementEnabled(env), evidenceStatus, evidenceGap,
    evidenceStatusLine: answer.evidenceStatusLine || 'absent', triggered: false };
  if (evidenceStatus !== 'insufficient') return { ...base, attempt: false, status: 'not_needed' };
  if (!base.enabled) return { ...base, attempt: false, status: 'disabled' };
  const skip = (skipReason, extra = {}) => ({ ...base, attempt: false, status: 'skipped', skipReason, ...extra });
  // The request ended after the first answer completed: no paid round starts.
  if (requestCancelled === true) return skip('request_cancelled');
  if (!evidenceGap) return skip('evidence_gap_absent');
  const reading = continuation?.ruleQueryModel?.bounded?.reading;
  if (continuation?.mode !== 'cloud_evidence_v1' || !Array.isArray(reading?.lanes) || !Array.isArray(reading?.offered)
    || !Array.isArray(continuation?.promptBundle?.modelEvidence?.rawRelatedEvidence)) {
    return skip('bounded_evidence_unavailable');
  }
  if (continuation.ruleQueryModel.evidenceSelector !== 'luna') return skip('selector_not_supported');
  const question = continuation.promptBundle.promptPayload?.userQuery;
  if (typeof question !== 'string' || !question.trim()) return skip('question_unavailable');
  let maxPromptChars;
  try { maxPromptChars = boundedEvidenceMaxPromptChars(env); } catch { return skip('package_limit_unavailable'); }
  const basePromptChars = String(continuation.promptBundle.prompt || '').length;
  if (basePromptChars >= maxPromptChars) return skip('pack_capacity_exhausted', { basePromptChars, maxPromptChars });
  const startedAt = Number(invocationStartedAt);
  const invocation = { shape: invocationShape, elapsedMs: Number.isFinite(startedAt) ? Math.max(0, nowMs - startedAt) : null,
    estimatedRoundMs: evidenceSupplementEstimatedRoundMs(env), budgetMs: EVIDENCE_SUPPLEMENT_INVOCATION_BUDGET_MS };
  if (invocation.elapsedMs === null || invocation.elapsedMs + invocation.estimatedRoundMs > invocation.budgetMs) {
    return skip('skipped_time_budget', { invocation });
  }
  return { ...base, attempt: true, triggered: true, status: 'attempting', invocation, question,
    basePromptChars, maxPromptChars, deadlineAt: startedAt + invocation.budgetMs };
}

function supplementRequest(continuation, decision) {
  const bounded = continuation.ruleQueryModel.bounded;
  const delivered = continuation.promptBundle.modelEvidence.rawRelatedEvidence;
  const keys = values => values.filter(value => typeof value === 'string' && value);
  return {
    evidenceGap: decision.evidenceGap,
    baseSelectionIds: keys(delivered.map(item => item?.id)),
    excludeUnitKeys: keys(bounded.reading.offered.map(bundle => bundle?.unitKey)),
    excludeEntryIds: keys(bounded.reading.offered.flatMap(bundle => Array.isArray(bundle?.atomIds) ? bundle.atomIds : [])),
    priorLanes: bounded.reading.lanes,
    previousQueryPlan: continuation.ruleQueryModel.queryPlan || null,
    previouslyDelivered: delivered.map(item => ({ recordType: item?.recordType, title: item?.title,
      section: item?.sourceSection?.title })),
    basePromptChars: decision.basePromptChars,
    priorSpentUsd: Math.max(0, Number(bounded.estimatedCostUsd) || 0),
  };
}

function displayable(modelResult) {
  const answer = modelResult?.answer;
  return Boolean(answer && !modelResult.providerFailure
    && !(answer.riskFlags || []).includes('model_output_not_displayable')
    && String(answer.shortAnswer || '').trim());
}

function cancelledOutcome(outcome) {
  return { ...outcome, status: 'cancelled', failureReason: 'cancelled_during_supplement' };
}

function failureCode(error) {
  for (const value of [error?.code, error?.message]) {
    if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/u.test(value)) return value;
  }
  return 'evidence_supplement_failed';
}

function fxCnyPerUsd(env) {
  const value = Number(env.GEMINI_EVIDENCE_FX_CNY_PER_USD);
  return Number.isFinite(value) && value > 0 ? value : 7;
}

function retrievalSummary(retrieved, continuation) {
  const round = retrieved.supplement || {};
  const telemetry = retrieved.telemetry || {};
  const firstPrompt = String(continuation.promptBundle.prompt || '');
  return {
    planNeeds: round.planNeeds ?? null,
    queryPlan: Array.isArray(telemetry.queryPlan?.needs) ? telemetry.queryPlan.needs : [],
    candidateUnits: round.candidateUnits ?? null,
    excludedUnits: round.excludedUnits ?? null,
    recalledUnits: round.recalledUnits ?? null,
    newlyRecalledUnits: round.newlyRecalledUnits ?? null,
    offeredUnits: round.offeredUnits ?? null,
    omittedUnits: round.omittedUnits ?? null,
    selectedIds: round.selectedIds ?? null,
    newSelectedIds: round.newSelectedIds ?? null,
    addedEntries: (round.addedEntryIds || []).length,
    trimmedEntries: (round.trimmedEntryIds || []).length,
    addedEntryIds: round.addedEntryIds || [],
    trimmedEntryIds: round.trimmedEntryIds || [],
    basePromptChars: round.basePromptChars ?? null,
    // Identity check of the re-packed first-round package against the prompt
    // the first answer actually read (diagnostic only).
    baseRepackIdentical: typeof round.basePromptSha256 === 'string'
      ? round.basePromptSha256 === createHash('sha256').update(firstPrompt).digest('hex') : null,
    promptChars: round.promptChars ?? null,
    maxPromptChars: round.maxPromptChars ?? null,
    estimatedCostUsd: Number(telemetry.estimatedCostUsd) || 0,
    estimatedCostCny: Number(telemetry.estimatedCostCny) || 0,
    tokenUsage: telemetry.tokenUsage || {},
    rounds: telemetry.rounds ?? null,
    stageTelemetry: telemetry.stageTelemetry || null,
    timingsMs: telemetry.timingsMs || {},
  };
}

function failedRetrievalSummary(error, env) {
  const bounded = error?.boundedRetrieval;
  if (!bounded) return null;
  const estimatedCostUsd = Number(bounded.estimatedCostUsd) || 0;
  return { estimatedCostUsd, estimatedCostCny: estimatedCostUsd * fxCnyPerUsd(env),
    timingsMs: bounded.timingsMs || {}, completedPlan: Array.isArray(bounded.completedPlan?.needs)
      ? bounded.completedPlan.needs : null };
}

function modelSummary(modelResult, ms) {
  if (!modelResult) return null;
  return { providerUsed: modelResult.providerUsed || modelResult.provider || null,
    modelUsed: modelResult.modelUsed || null, returnedModel: modelResult.returnedModel || null,
    dryRun: modelResult.dryRun === true, tokenUsage: modelResult.tokenUsage || {},
    estimatedCostCny: Number(modelResult.estimatedCostCny) || 0,
    estimatedCostUsd: Number(modelResult.estimatedCostUsd) || 0, ms: Number.isFinite(ms) ? ms : null,
    evidenceStatus: modelResult.answer?.evidenceStatus || 'unknown',
    evidenceGap: modelResult.answer?.evidenceGap || '' };
}

/**
 * Run the round once. Returns { status: 'applied', promptBundle, evidence,
 * modelResult, ... } or a non-applied outcome; the caller then keeps the first
 * answer. Only a cancelled request is rethrown.
 */
export async function runEvidenceSupplementRound({ decision, continuation, env = {}, signal, progress,
  provider, modelInvoker, dryRun, fetchImpl, now, thinkingMode, reasoningEffort,
  privateEvaluationDiagnostics } = {}) {
  const startedAt = Date.now();
  const timingsMs = {};
  const deadline = AbortSignal.timeout(Math.max(1, decision.deadlineAt - startedAt));
  const roundSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let retrieval = null;
  let modelResult = null;
  progress?.phase?.(EVIDENCE_SUPPLEMENT_PHASE);
  try {
    const evidence = continuation.evidence || {};
    const retrievalStartedAt = Date.now();
    let retrieved;
    try {
      retrieved = await (provider || createGeminiBoundedEvidenceProvider({ fetchImpl: fetchImpl || globalThis.fetch }))
        .retrieve({
          userQuery: decision.question,
          answerLocale: continuation.answerLocale || 'zh-CN',
          cardResolution: continuation.cardResolution,
          retrievedEvidence: { cardTexts: evidence.cardTexts || [], userProvidedCardTexts: evidence.userProvidedCardTexts || [] },
          dataRevision: continuation.dataRevision,
          env: { ...env, EVIDENCE_SELECTOR: 'luna' },
          signal: roundSignal,
          elapsedBeforeRetrievalMs: 0,
          supplement: supplementRequest(continuation, decision),
        });
    } catch (error) {
      retrieval = failedRetrievalSummary(error, env);
      throw error;
    } finally {
      timingsMs.retrieval = Date.now() - retrievalStartedAt;
    }
    if (!retrieved?.packing || typeof retrieved.packing.prompt !== 'string' || !retrieved.evidence || !retrieved.supplement) {
      throw Object.assign(new Error('evidence_supplement_result_invalid'), { code: 'evidence_supplement_result_invalid' });
    }
    retrieval = retrievalSummary(retrieved, continuation);
    if (!retrieval.addedEntries) return { status: 'no_new_evidence', retrieval, timingsMs };
    const promptBundle = retrieved.packing;
    // Retriever diagnostics stay those of the prepared request.
    const supplementedEvidence = { ...retrieved.evidence, retrievalWarnings: evidence.retrievalWarnings || [],
      debug: evidence.debug || {} };
    const modelStartedAt = Date.now();
    try {
      modelResult = await callRagModel({ prompt: promptBundle.prompt, recoveryPrompt: '', evidence: supplementedEvidence,
        cardResolution: continuation.cardResolution, env, modelInvoker, dryRun, fetchImpl, now, thinkingMode,
        reasoningEffort, outputMode: 'plain_text', signal: roundSignal, privateEvaluationDiagnostics });
    } finally {
      timingsMs.finalModel = Date.now() - modelStartedAt;
    }
    if (!displayable(modelResult)) {
      return signal?.aborted ? cancelledOutcome({ retrieval, modelResult, timingsMs })
        : { status: 'failed', failureReason: deadline.aborted ? 'deadline_exceeded' : 'final_model_not_displayable',
          retrieval, modelResult, timingsMs };
    }
    return { status: 'applied', promptBundle, evidence: supplementedEvidence, modelResult, retrieval, timingsMs };
  } catch (error) {
    // The first answer is already complete: a cancellation or failure during
    // this round only ends the round. The caller keeps the first answer (and
    // a finalize request can still store it for recovery).
    if (signal?.aborted) return cancelledOutcome({ retrieval, modelResult, timingsMs });
    return { status: 'failed', failureReason: deadline.aborted ? 'deadline_exceeded' : failureCode(error),
      retrieval, modelResult, timingsMs };
  } finally {
    timingsMs.total = Date.now() - startedAt;
    progress?.endPhase?.();
  }
}

/** Telemetry for debug.evidenceSupplement. */
export function evidenceSupplementTelemetry({ decision, outcome = null, firstModelResult, firstModelMs,
  continuation } = {}) {
  const { attempt: _attempt, question: _question, deadlineAt: _deadlineAt, ...publicDecision } = decision || {};
  if (!outcome) return publicDecision;
  const retrievalCostUsd = Number(outcome.retrieval?.estimatedCostUsd) || 0;
  const retrievalCostCny = Number(outcome.retrieval?.estimatedCostCny) || 0;
  const finalModel = modelSummary(outcome.modelResult, outcome.timingsMs?.finalModel);
  return {
    ...publicDecision,
    status: outcome.status,
    ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
    retrieval: outcome.retrieval || null,
    finalModel,
    firstRound: { ...modelSummary(firstModelResult, firstModelMs),
      finalPromptSha256: continuation?.finalPromptSha256 || null,
      promptChars: String(continuation?.promptBundle?.prompt || '').length },
    timingsMs: { ...outcome.timingsMs },
    estimatedCostUsd: retrievalCostUsd + (finalModel?.estimatedCostUsd || 0),
    estimatedCostCny: retrievalCostCny + (finalModel?.estimatedCostCny || 0),
  };
}
