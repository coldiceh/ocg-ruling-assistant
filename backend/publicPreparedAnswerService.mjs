import { answerPublicRulingQuestion, shouldClassifyPublicQuestion } from "./publicAnswerService.mjs";
import { createPublicAnswerModelEnv } from "./ragModelClient.mjs";
import { assertPublicRulingModelProfileAvailable, resolvePublicRulingModelProfile } from "./publicRulingModelConfig.mjs";
import { finalizePreparedRagRulingQuestionForVersion } from "./rulingVersionRegistry.mjs";
import { preparationError } from "./publicAnswerPreparationStore.mjs";
import { PUBLIC_EXHAUSTED_FALLBACK_PROFILE, selectAvailablePublicProfile, withPublicGenerationInfo } from './publicGenerationInfo.mjs';
import { updateQueryAudit, safeQueryAuditRetrievalTimings } from './queryAuditStore.mjs';
import { queryAuditAnswerPatch, queryAuditFailurePatch, saveQueryAuditUpdate } from './publicQueryAudit.mjs';
import { attachEngineReproWhenReady, engineReproWaitDeadline } from './engineRepro/session.mjs';
import { startOfficialQaJudge } from './engineRepro/officialQaJudge.mjs';
import { selectedPromptEvidenceRefs } from './ragRulingPipeline.mjs';

export async function preparePublicAnswer({
  payload, env, signal, progress, store,
  answerPublic = answerPublicRulingQuestion, now = Date.now,
  requestContext, updateAudit = updateQueryAudit,
} = {}) {
  let result;
  try {
  signal?.throwIfAborted();
  const startedAt = now();
  result = await answerPublic({ payload, env, signal, progress, requestContext, prepareForContinuation: true });
  // Existing early answers (for example empty/non-ruling requests) do not
  // require another model call, and keep their original public envelope.
  if (result.answer?.status !== "evidence_prepared") return result;
  signal?.throwIfAborted();
  const measuredProgress = progress.complete();
  const preparationId = await store.create({
    continuation: result.answer.continuation,
    rulingVersion: result.answer.rulingVersion,
    profileId: result.latency.profileId,
    pipeline: env.RAG_EVIDENCE_PIPELINE || "rag_baseline",
    startedAt, preparedAt: now(), progress: measuredProgress,
    cloudCosts: result.answer.debug?.cloudCosts || null,
    requestDiagnostics: result.answer.debug?.requestDiagnostics || null,
    fallbackFrom: result.fallbackFrom || null,
    auditId: result.auditId || null,
    engineRepro: result.engineRepro || null,
  });
  await saveQueryAuditUpdate(result.auditId, {
    status: "prepared", profileId: result.latency.profileId, latencyMs: measuredProgress.totalMs,
    ...safeQueryAuditRetrievalTimings(result.answer.continuation.ruleQueryModel?.timingsMs),
  }, env, updateAudit);
  // The evidence the final model will be given, in the same shape the answer's usedEvidence will
  // have (finalize rebuilds that list from this same prompt bundle): the web page shows it while
  // the final model writes. No extra model call.
  const promptBundle = result.answer.continuation.promptBundle;
  const evidencePreview = selectedPromptEvidenceRefs(promptBundle.modelEvidence, promptBundle.allowedEvidenceIds);
  // Where the engine reproduction started during this preparation stores its result (history record id
  // and this invocation's start): a 仅引擎复现 request waits for it after preparing (api/answer.js).
  const engineReproWait = result.engineRepro?.enabled && result.auditId
    ? { auditId: result.auditId, requestStartedAt: result.engineRepro.requestStartedAt } : null;
  return { preparationId, progress: measuredProgress, evidencePreview, engineReproWait,
    evidencePackage: { text: promptBundle.prompt, filename: 'ocg-evidence.txt',
      diagnostics: {
        request: result.answer.debug?.requestDiagnostics || null,
        cloudCosts: result.answer.debug?.cloudCosts || null,
        retrieval: result.answer.continuation.evidence?.debug?.cloudEvidence || null,
        ruleHints: result.answer.continuation.ruleQueryModel || null,
        cardLookup: {
          totalMs: result.answer.continuation.timingsMs?.cardPreparation ?? null,
          baigeSearchCount: result.answer.continuation.evidence?.debug?.baigeSearchCount ?? null,
          baigeCacheHitCount: result.answer.continuation.evidence?.debug?.baigeCacheHitCount ?? null,
          baigeWarnings: result.answer.continuation.evidence?.debug?.baigeWarnings || [],
          retrievalWarnings: result.answer.continuation.evidence?.retrievalWarnings || [],
          timingsMs: result.answer.continuation.evidence?.debug?.timingsMs || null,
          extraction: result.answer.continuation.cardNameModel || null,
        },
        serverPreparationTimingsMs: result.answer.continuation.timingsMs || null,
      },
    } };
  } catch (error) {
    await saveQueryAuditUpdate(result?.auditId, queryAuditFailurePatch(error), env, updateAudit);
    throw error;
  }
}

export function preparedAnswerProgress(preparation) {
  return { ...preparation.progress };
}

export async function finalizePublicAnswer({
  preparation, env, signal, progress,
  finalize = finalizePreparedRagRulingQuestionForVersion, now = Date.now,
  selectProfile = selectAvailablePublicProfile, addGeneration = withPublicGenerationInfo,
  updateAudit = updateQueryAudit, attachEngineRepro = attachEngineReproWhenReady,
  startJudge = startOfficialQaJudge,
} = {}) {
  try {
  signal?.throwIfAborted();
  if (shouldClassifyPublicQuestion(env) && preparation?.requestDiagnostics?.scope?.scope !== 'in_scope') {
    throw preparationError("资料未通过当前用途检查，请重新提交问题", "answer_preparation_scope_unverified", 409);
  }
  const finalizeStartedAt = now();
  const selection = await selectProfile(preparation.profileId, env);
  let profile = selection.profile;
  let fallbackFrom = preparation.fallbackFrom || selection.fallbackFrom;
  assertPublicRulingModelProfileAvailable(profile, env);
  if (preparation.pipeline !== (env.RAG_EVIDENCE_PIPELINE || "rag_baseline")) {
    throw preparationError("服务配置已更新，请重新提交问题", "answer_preparation_deployment_changed", 409);
  }
  // The original public profile is server-owned. A finalize payload cannot
  // replace it, the question, the prompt, evidence, or any provider parameter.
  let publicEnv = createPublicAnswerModelEnv(env, profile.id);
  // The section's official-Q&A judge runs alongside the final model call, on the material fixed
  // when the evidence was prepared. It never affects the answer.
  const officialQaJudge = preparation.engineRepro?.enabled === true
    ? startJudge({ input: preparation.continuation?.officialQaJudgeInput || null, env }) : null;
  let answer;
  try {
    const invokeFinal = () => finalize({
      continuation: preparation.continuation,
      rulingVersion: preparation.rulingVersion,
      env: publicEnv, signal, progress,
      invocationStartedAt: finalizeStartedAt,
      // After a supplementary evidence round the page offers the new package.
      returnSupplementedEvidencePackage: true,
    });
    try { answer = await invokeFinal(); }
    catch (error) {
      // Only a rejected reservation proves no official generation was sent.
      if (profile.provider !== 'openai' || error.code !== 'official_daily_budget_exceeded') throw error;
      const replacement = resolvePublicRulingModelProfile(PUBLIC_EXHAUSTED_FALLBACK_PROFILE);
      fallbackFrom = profile.id;
      profile = assertPublicRulingModelProfileAvailable(replacement, env);
      publicEnv = createPublicAnswerModelEnv(env, profile.id);
      signal?.throwIfAborted();
      answer = await invokeFinal();
    }
  } catch (error) {
    if (preparation.cloudCosts || error.cloudCosts) {
      error.cloudCosts = combinedCloudCosts(preparation.cloudCosts, error.cloudCosts);
    }
    throw error;
  }
  if (preparation.cloudCosts || answer.debug?.cloudCosts) {
    answer = { ...answer, debug: { ...answer.debug,
      cloudCosts: combinedCloudCosts(preparation.cloudCosts, answer.debug?.cloudCosts),
    } };
  }
  answer = await addGeneration(answer, profile, env, {fallbackFrom});
  // The answer is complete here. The response waits for the reproduction started by the
  // preparation request, up to this invocation's own duration limit. Timing stays separate:
  // the answer's own completion is taken before the wait.
  const completedAt = now();
  if (preparation.engineRepro?.enabled === true) {
    answer = await attachEngineRepro(answer, { env, auditId: preparation.auditId,
      requestStartedAt: preparation.engineRepro.requestStartedAt,
      waitDeadlineAt: engineReproWaitDeadline(finalizeStartedAt, env), officialQaJudge });
  }
  answer = { ...answer, debug: { ...answer.debug,
    requestDiagnostics: { ...preparation.requestDiagnostics,
      preparationProgress: preparation.progress,
      completedAt: new Date(completedAt).toISOString(),
    },
  } };
  const measuredPreparationMs = Number.isFinite(preparation.progress?.totalMs)
    ? preparation.progress.totalMs
    : Number.isFinite(preparation.requestDiagnostics?.durationMs)
      ? preparation.requestDiagnostics.durationMs
      : Number(preparation.preparedAt) - Number(preparation.startedAt);
  const preparationDurationMs = Math.max(0, measuredPreparationMs);
  const latency = { profileId: profile.id,
    durationMs: preparationDurationMs + Math.max(0, completedAt - finalizeStartedAt), exactMatchMs: 0 };
  await saveQueryAuditUpdate(preparation.auditId, queryAuditAnswerPatch(answer, {
    latencyMs: latency.durationMs, profileId: profile.id,
  }), env, updateAudit);
  return { answer, latency };
  } catch (error) {
    await saveQueryAuditUpdate(preparation?.auditId, queryAuditFailurePatch(error), env, updateAudit);
    throw error;
  }
}

function combinedCloudCosts(preparation, finalization) {
  // Observational cost telemetry only. Both requests keep the existing shared
  // Redis budget namespace; no reservation or settlement is repeated here.
  const totals = {};
  for (const field of ["actualCny", "accountedActualUpperCny", "theoreticalUsd", "reservedCny", "reservedTheoreticalUsd"]) {
    totals[field] = Number(preparation?.[field] || 0) + Number(finalization?.[field] || 0);
  }
  return { ...(finalization || preparation), ...totals,
    calls: [...(preparation?.calls || []), ...(finalization?.calls || [])],
    phases: { preparation, finalization: finalization || null },
  };
}
