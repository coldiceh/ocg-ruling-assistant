import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminHistoryService } from '../backend/adminHistoryService.mjs';
import { createMemoryAdminLabRecordStore } from '../backend/adminLabRecordStore.mjs';
import { createProductionAdminModelLabHandler } from '../api/admin-model-lab.js';

test('hosted history preserves questions and ratings without touching a run store or model', async () => {
  const store = createMemoryAdminLabRecordStore();
  await store.registerRun({ runId: 'history-1', createdAt: '2026-09-24T00:00:00Z', questionSummary: '保留的问题', modelConfig: {} });
  const service = createAdminHistoryService({ recordStore: store, fetchImpl: () => { throw Error('No network expected'); } });
  await service.saveRating({ runId: 'history-1', rating: 'correct', notes: '保留评分' });
  const run = await service.getRun({ runId: 'history-1' });
  assert.equal(run.question, '保留的问题');
  assert.equal(run.humanRating.rating, 'correct');
  assert.equal(run.historyOnly, true);
  assert.equal('evidenceSnapshot' in run, false);
  assert.equal((await service.listRuns()).records.length, 1);
  assert.equal((await service.exportRuns()).count, 1);
  for (const action of ['createRun','forkRun','executeRun','cancelRun','replayEvents','pollRun']) {
    await assert.rejects(service[action]({}), { code: 'admin_model_lab_local_only' });
  }
});

test('actual hosted route defaults to history-only and rejects experiment creation before any Redis write', async () => {
  let networkCalls = 0;
  const handler = createProductionAdminModelLabHandler({
    env: { ADMIN_MODEL_LAB_ENABLED: 'true', UPSTASH_REDIS_REST_URL: 'https://redis.invalid', UPSTASH_REDIS_REST_TOKEN: 'test' },
    fetchImpl: async () => { networkCalls++; throw Error('Unexpected request'); },
    manager: { checkOrigin: () => ({ ok: true, origin: 'https://admin.invalid' }), authorize: async () => ({ ok: true }) },
  });
  function response(){return { headers: {}, setHeader(k,v){this.headers[k]=v;}, status(v){this.statusCode=v;return this;}, json(v){this.body=v;return this;}};}
  const caps=response();await handler({method:'GET',url:'/api/admin-model-lab?action=capabilities'},caps);
  assert.equal(caps.statusCode,200);assert.equal(caps.body.data.historyOnly,true);assert.equal(caps.body.data.features.createRun,false);
  const result=response();await handler({method:'POST',url:'/api/admin-model-lab',body:{action:'create',question:'不应存储'}},result);
  assert.equal(result.statusCode,410);assert.equal(result.body.error,'admin_model_lab_local_only');assert.equal(networkCalls,0);
});
