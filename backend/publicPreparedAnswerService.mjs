import { answerPublicRulingQuestion } from "./publicAnswerService.mjs";
import { createPublicAnswerModelEnv } from "./ragModelClient.mjs";
import { assertPublicRulingModelProfileAvailable, resolvePublicRulingModelProfile } from "./publicRulingModelConfig.mjs";
import { finalizePreparedRagRulingQuestionForVersion } from "./rulingVersionRegistry.mjs";
import { preparationError } from "./publicAnswerPreparationStore.mjs";
import { PUBLIC_EXHAUSTED_FALLBACK_PROFILE, selectAvailablePublicProfile, withPublicGenerationInfo } from './publicGenerationInfo.mjs';

export async function preparePublicAnswer({
  payload, env, signal, progress, store,
  answerPublic = answerPublicRulingQuestion, now = Date.now,
} = {}) {
  signal?.throwIfAborted();
  const startedAt = now();
  const result = await answerPublic({ payload, env, signal, progress, prepareForContinuation: true });
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
  });
  return { preparationId, progress: measuredProgress,
    evidencePackage: { text: result.answer.continuation.promptBundle.prompt, filename: 'ocg-evidence.txt',
      diagnostics: {
        request: result.answer.debug?.requestDiagnostics || null,
        retrieval: result.answer.continuation.evidence?.debug?.cloudEvidence || null,
        ruleHints: result.answer.continuation.ruleQueryModel || null,
      },
    } };
}

export function preparedAnswerProgress(preparation, now = Date.now) {
  return {
    ...preparation.progress,
    totalMs: preparation.progress.totalMs + Math.max(0, now() - preparation.preparedAt),
  };
}

export async function finalizePublicAnswer({
  preparation, env, signal, progress,
  finalize = finalizePreparedRagRulingQuestionForVersion, now = Date.now,
  selectProfile = selectAvailablePublicProfile, addGeneration = withPublicGenerationInfo,
} = {}) {
  signal?.throwIfAborted();
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
  let answer;
  try {
    const invokeFinal = () => finalize({
      continuation: preparation.continuation,
      rulingVersion: preparation.rulingVersion,
      env: publicEnv, signal, progress,
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
  answer = { ...answer, debug: { ...answer.debug,
    requestDiagnostics: { ...preparation.requestDiagnostics,
      preparationProgress: preparation.progress,
      completedAt: new Date(now()).toISOString(),
    },
  } };
  return { answer, latency: { profileId: profile.id, durationMs: Math.max(0, now() - preparation.startedAt), exactMatchMs: 0 } };
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
