import { answerPublicRulingQuestion } from "./publicAnswerService.mjs";
import { createPublicAnswerModelEnv } from "./ragModelClient.mjs";
import { assertPublicRulingModelProfileAvailable, resolvePublicRulingModelProfile } from "./publicRulingModelConfig.mjs";
import { finalizePreparedRagRulingQuestionForVersion } from "./rulingVersionRegistry.mjs";
import { preparationError } from "./publicAnswerPreparationStore.mjs";

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
  });
  return { preparationId, progress: measuredProgress };
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
} = {}) {
  signal?.throwIfAborted();
  const profile = resolvePublicRulingModelProfile(preparation.profileId);
  assertPublicRulingModelProfileAvailable(profile, env);
  if (preparation.pipeline !== (env.RAG_EVIDENCE_PIPELINE || "rag_baseline")) {
    throw preparationError("服务配置已更新，请重新提交问题", "answer_preparation_deployment_changed", 409);
  }
  // The original public profile is server-owned. A finalize payload cannot
  // replace it, the question, the prompt, evidence, or any provider parameter.
  const publicEnv = createPublicAnswerModelEnv(env, profile.id);
  let answer;
  try {
    answer = await finalize({
      continuation: preparation.continuation,
      rulingVersion: preparation.rulingVersion,
      env: publicEnv, signal, progress,
    });
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
