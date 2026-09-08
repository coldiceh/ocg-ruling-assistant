import { answerPublicRulingQuestion } from './publicAnswerService.mjs';
import { answerRagRulingQuestionForVersion, answerExactOfficialQaQuestionForVersion } from './rulingVersionRegistry.mjs';
import { createCloudRequestBudget } from './cloudRequestBudget.mjs';

/** Authenticated admin operation using the public profile and production pipeline.
 * Inputs are the original question/profile and an explicit cumulative run budget.
 * No Oracle, frozen evidence, transport, model override, or environment is accepted.
 */
export async function capturePublicRulingEvidence({
  payload, env = process.env, fetchImpl = globalThis.fetch,
  answerPublic = answerPublicRulingQuestion,
  answerRuling = answerRagRulingQuestionForVersion,
  createBudget = createCloudRequestBudget,
} = {}) {
  if (env.RAG_EVIDENCE_PIPELINE !== 'cloud_evidence_v1') {
    throw Object.assign(new Error('cloud evidence capture requires the cloud pipeline'),
      { code: 'admin_capture_cloud_pipeline_required', statusCode: 400 });
  }
  const budget = payload?.budget || {};
  const budgetEnv = {
    ...env,
    CLOUD_BUDGET_RUN_ID: `admin-capture-${String(budget.runId || '')}`,
    CLOUD_BUDGET_PERIOD: 'run',
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY: budget.actualLimitCny,
    CLOUD_BUDGET_THEORETICAL_LIMIT_USD: budget.theoreticalLimitUsd,
    CLOUD_BUDGET_INITIAL_ACTUAL_CNY: '0',
    CLOUD_BUDGET_INITIAL_THEORETICAL_USD: '0',
  };
  if (!/^[a-zA-Z0-9_-]{1,70}$/u.test(String(budget.runId || ''))) {
    throw Object.assign(new Error('capture run ID required'),
      { code: 'admin_capture_run_id_required', statusCode: 400 });
  }
  const cloudBudget = createBudget({ env: budgetEnv, fetchImpl });
  const startedAt = new Date().toISOString();
  try {
    const result = await answerPublic({
      payload: { question: payload.question, rulingVersion: payload.rulingVersion,
        rulingModelProfile: payload.rulingModelProfile },
      env,
      // Private evaluation questions must not enter the public question history.
      appendAudit: async () => null,
      answerOfficialExact: options => answerExactOfficialQaQuestionForVersion({
        ...options, cloudBudget, fetchImpl,
      }),
      answerRuling: options => answerRuling({ ...options, fetchImpl,
        cloudBudget, captureEvidenceOnly: true }),
    });
    return { ...result, startedAt, completedAt: new Date().toISOString(),
      deployment: { commit: env.VERCEL_GIT_COMMIT_SHA || null,
        environment: env.VERCEL_ENV || null, url: env.VERCEL_URL || null },
      cloudCosts: cloudBudget.snapshot() };
  } catch (error) {
    return { status: 'failed', error: { code: String(error?.code || 'capture_failed') },
      startedAt, completedAt: new Date().toISOString(),
      cloudCosts: error?.cloudCosts || cloudBudget.snapshot() };
  }
}
