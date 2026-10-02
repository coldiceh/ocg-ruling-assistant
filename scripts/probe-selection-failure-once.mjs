import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { answerPublicRulingQuestion } from '../backend/publicAnswerService.mjs';
import { answerRagRulingQuestionForVersion } from '../backend/rulingVersionRegistry.mjs';
import { estimateGenerationUpperBoundUsd } from '../backend/evidenceGenerationContract.mjs';

Object.assign(process.env, JSON.parse(await readFile('vercel.json', 'utf8')).env);
Object.assign(process.env, { CLOUD_BUDGET_RUN_ID: 'selection-failure-fix-20261002',
  CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '3.5', CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '0.50' });
const events = [], cachedResponses = [];
const nativeFetch = globalThis.fetch;
let generationReserveUsd = 0;
globalThis.fetch = async (url, options = {}) => {
  const address = new URL(String(url));
  const provider = ['api.b.ai', 'generativelanguage.googleapis.com'].includes(address.hostname);
  const body = typeof options.body === 'string' ? options.body : '';
  if (provider && body && /gpt-6-astra/.test(JSON.parse(body).model || '')) {
    throw new Error('diagnostic_final_model_call_forbidden');
  }
  const response = await nativeFetch(url, options);
  if (provider) cachedResponses.push({
    url: address.origin + address.pathname, body,
    key: createHash('sha256').update(address.origin + address.pathname + '\n' + body).digest('hex'),
    status: response.status, text: await response.clone().text(),
  });
  return response;
};
await mkdir('selection-diagnostic', { recursive: true });
const summary = { baselineCommit: '5adcdd9c4dded856b21999708c3055225d490ca4', finalModelCalls: 0 };
try {
  const result = await answerPublicRulingQuestion({
    payload: { question: '场上有 完美电子多元驱动蛇·神龙，四花缭乱之灵使加多少攻击力？',
      rulingModelProfile: 'bai-astra-low', answerLocale: 'zh-CN' },
    env: process.env, signal: AbortSignal.timeout(240000), prepareForContinuation: true,
    appendAudit: async () => null,
    answerRuling: args => answerRagRulingQuestionForVersion({ ...args,
      onEvidenceEvent: async event => {
        events.push(event);
        if (event.type === 'request') {
          generationReserveUsd += estimateGenerationUpperBoundUsd({ measurement: event.measurement, contract: event.contract }).amountUsd;
          if (generationReserveUsd > 0.50) throw new Error('diagnostic_generation_budget_exceeded');
        }
      },
    }),
  });
  summary.status = result.answer.status;
  await writeFile('selection-diagnostic/prepared.json', JSON.stringify(result, null, 2));
} catch (error) {
  summary.status = 'failed'; summary.error = error.code || error.message;
  summary.boundedRetrieval = error.boundedRetrieval;
  summary.cloudCosts = error.cloudCosts;
}
summary.generationReserveUsd = generationReserveUsd;
await writeFile('selection-diagnostic/frozen.json', JSON.stringify({ events, cachedResponses }, null, 2));
await writeFile('selection-diagnostic/summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ status: summary.status, error: summary.error,
  generationReserveUsd, providerResponses: cachedResponses.length, finalModelCalls: 0 }));
