import { getRagBudgetStatus } from './ragModelClient.mjs';
import { getOfficialOpenAIBudgetStatus } from './cloudRequestBudget.mjs';
import { configuredPublicRulingModelProfile, publicRulingModelProfileAvailable, resolvePublicRulingModelProfile } from './publicRulingModelConfig.mjs';

export const PUBLIC_EXHAUSTED_FALLBACK_PROFILE = 'deepseek-v4.1-flash-none';

export async function selectAvailablePublicProfile(profileId, env, {readOfficial = getOfficialOpenAIBudgetStatus} = {}) {
  const profile = configuredPublicRulingModelProfile(resolvePublicRulingModelProfile(profileId), env);
  if (profile.provider !== 'openai' || env.MODEL_PROVIDER === 'mock' || env.RAG_MODEL_PROVIDER === 'mock') return {profile};
  const budget = await readOfficial({env}).catch(() => null);
  // Unknown storage status does not establish exhausted credit. The actual
  // dispatcher still requires its atomic reservation before contacting OpenAI.
  if (budget?.remainingAmount === 0 && publicRulingModelProfileAvailable(PUBLIC_EXHAUSTED_FALLBACK_PROFILE, env)) {
    return {profile:configuredPublicRulingModelProfile(resolvePublicRulingModelProfile(PUBLIC_EXHAUSTED_FALLBACK_PROFILE),env), fallbackFrom:profile.id};
  }
  return {profile};
}

export async function withPublicGenerationInfo(answer, profile, env, {fallbackFrom, readBudget = getRagBudgetStatus} = {}) {
  if (!answer || answer.status === 'evidence_prepared') return answer;
  const debug = answer.debug || {};
  const generated = debug.dryRun === false && !debug.providerFailure;
  const provider = generated ? debug.providerUsed : null;
  const model = generated ? (debug.returnedModel || debug.modelUsed || debug.requestedModel || null) : null;
  const status = await readBudget({env}).catch(() => null);
  const pool = status?.buckets?.find(item => item.id === `final_ruling:${provider || profile.provider}`);
  return {...answer, generation:{
    generated, provider, model,
    label: generated ? (model && model !== profile.model ? `${profile.label}（返回 ${model}）` : profile.label) : '未生成模型答案',
    reasoningEffort: generated ? (debug.generationConfig?.reasoningEffort ?? null) : null,
    thinkingMode: generated ? (debug.generationConfig?.thinkingMode ?? null) : null,
    budget:{currency:pool?.currency || (profile.provider === 'openai' || profile.provider === 'relay' ? 'USD' : 'CNY'),
      remainingAmount:pool?.remainingToday ?? null, dailyBudgetAmount:pool?.dailyBudget ?? null,
      sharedPoolLabel:pool?.label || '本站每日额度',
      asOf:new Date().toISOString(), timezone:status?.timezone || env.API_BUDGET_TIMEZONE || 'Asia/Shanghai'},
    ...(fallbackFrom ? {fallbackFrom} : {}),
  }};
}
