import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudRequestBudget, CLOUD_BUDGET_RESERVE, CLOUD_BUDGET_SETTLE} from '../backend/cloudRequestBudget.mjs';
import {loadEvidenceGenerationContract, buildEvidenceInputMeasurement} from '../backend/evidenceGenerationContract.mjs';
import {convertEvidenceGenerationRequest} from '../backend/evidenceGenerationTransport.mjs';

const env = {
  CLOUD_BUDGET_RUN_ID: 'evidence-deadline-fixture',
  CLOUD_BUDGET_ACTUAL_LIMIT_CNY: '10', CLOUD_BUDGET_THEORETICAL_LIMIT_USD: '10',
  UPSTASH_BUDGET_KV_REST_API_URL: 'https://budget.invalid',
  UPSTASH_BUDGET_KV_REST_API_TOKEN: 'fixture',
};
const embedBody = {content:{parts:[{text:'public fixture'}]}};

test('evidence budget reads and both provider reservations share the retrieval deadline', async () => {
  const controller = new AbortController();
  const calls = [];
  const budget = createCloudRequestBudget({env, fetchImpl:async (_url, init) => {
    const command = JSON.parse(init.body);
    calls.push({command, signal:init.signal});
    return Response.json({result:command[0] === 'HGETALL' ? []
      : [command[1] === CLOUD_BUDGET_RESERVE ? 'reserved' : 'settled']});
  }});
  await budget.remainingPreparationUsd({provider:'bai', signal:controller.signal});
  await budget.gemini({body:embedBody, operation:'embed_content', model:'gemini-embedding-2',
    signal:controller.signal, invoke:async () => ({usageMetadata:{promptTokenCount:10}})});
  const contract = loadEvidenceGenerationContract('selection', {profileUrl:new URL(
    '../config/evidence-generation/bai-gpt-5.6-luna-low-theoretical.json', import.meta.url)});
  const body = convertEvidenceGenerationRequest({contents:[{role:'user',parts:[{text:'fixture'}]}]}, contract);
  const measurement = await buildEvidenceInputMeasurement({body, contract});
  await budget.bai({body, operation:'generate_content', model:contract.modelId, measurement,
    generationContract:contract, signal:controller.signal,
    invoke:async () => ({model:contract.modelId, usage:{input_tokens:20,output_tokens:5,total_tokens:25}})});
  const preSend = calls.filter(row => row.command[0] === 'HGETALL' || row.command[1] === CLOUD_BUDGET_RESERVE);
  assert.equal(preSend.length, 3);
  for (const row of preSend) assert.equal(row.signal, controller.signal);
  const settlements = calls.filter(row => row.command[1] === CLOUD_BUDGET_SETTLE);
  assert.equal(settlements.length, 2);
  for (const row of settlements) assert.notEqual(row.signal, controller.signal);
  assert.equal(budget.snapshot().calls.filter(row => row.status === 'usage_settled').length, 2);
});

test('the retrieval deadline cancels a pending reservation before model submission', async () => {
  const controller = new AbortController();
  let invoked = 0;
  const budget = createCloudRequestBudget({env, fetchImpl:async (_url, init) => {
    assert.equal(init.signal, controller.signal);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), {once:true});
      queueMicrotask(() => controller.abort(new Error('retrieval deadline reached')));
    });
  }});
  await assert.rejects(budget.gemini({body:embedBody, operation:'embed_content', model:'gemini-embedding-2',
    signal:controller.signal, invoke:async () => {invoked += 1; return {};}}), /retrieval deadline reached/);
  assert.equal(invoked, 0);
});

test('requests without a retrieval signal retain their existing storage timeout', async t => {
  const timeouts = [];
  const original = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', value => {timeouts.push(value); return original(value);});
  const budget = createCloudRequestBudget({env, fetchImpl:async () => Response.json({result:[]})});
  await budget.remainingPreparationUsd({provider:'bai'});
  assert.deepEqual(timeouts, [5000]);
});
