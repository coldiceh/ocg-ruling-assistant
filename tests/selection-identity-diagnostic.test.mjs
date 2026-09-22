import assert from 'node:assert/strict';
import test from 'node:test';
import { saveSelectionIdentityDiagnostic } from '../backend/queryAuditStore.mjs';
import { answerPublicRulingQuestion, publicAnswerHttpError } from '../backend/publicAnswerService.mjs';

const env = { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'fixture-secret' };
const event = { type: 'selection_identity_failure', attempt: 1, retryAvailable: true,
  model: 'gpt-5.6-luna', providerId: 'bai', reasoningEffort: 'high', requestSha256: 'a'.repeat(64),
  responseId: 'fixture-response', rawSelectedIds: [' Q999 '], selectedIds: ['Q999'], unknownIds: ['Q999'],
  offered: [{ alias: 'Q1', id: 'canonical-1', kind: 'qa', bodySha256: 'b'.repeat(64), body: 'must-not-store-body' }],
  revisions: { dataRevision: 'fixture-revision', unwanted: 'must-not-store-extra' },
  raw: 'must-not-store-response', note: 'must-not-store-note' };

test('identity diagnostics persist privately with exact field projection and individual expiry', async () => {
  const commands = [];
  const result = await saveSelectionIdentityDiagnostic({ requestId: 'fixture-request', event, env,
    fetchImpl: async (_url, options) => { commands.push(JSON.parse(options.body)); return Response.json({ result: 'OK' }); } });
  assert.equal(result.stored, true);
  assert.equal(commands.length, 1);
  const [operation, key, json, expiry, seconds] = commands[0];
  assert.equal(operation, 'SET');
  assert.equal(key, 'rag-query-audit:v1:selection-identity:fixture-request:1');
  assert.equal(expiry, 'EX');
  assert.equal(seconds, '2592000');
  const saved = JSON.parse(json);
  assert.deepEqual(saved.rawSelectedIds, [' Q999 ']);
  assert.deepEqual(saved.selectedIds, ['Q999']);
  assert.deepEqual(saved.unknownIds, ['Q999']);
  assert.equal(saved.offered[0].id, 'canonical-1');
  assert.equal(saved.requestId, 'fixture-request');
  assert.equal(saved.responseId, 'fixture-response');
  assert.equal(json.includes('must-not-store'), false);
  assert.equal(json.includes('fixture-secret'), false);
});

test('identity diagnostics ignore other events, storage failure, and hanging storage', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; throw new Error('fixture-storage-unavailable'); };
  await saveSelectionIdentityDiagnostic({ event: { type: 'response', raw: 'private' }, env, fetchImpl });
  assert.equal(called, 0);
  assert.equal((await saveSelectionIdentityDiagnostic({ event, env: {}, fetchImpl })).stored, false);
  assert.equal(called, 0);
  assert.equal((await saveSelectionIdentityDiagnostic({ event, env, fetchImpl })).stored, false);
  const result = await saveSelectionIdentityDiagnostic({ event, env: { ...env, QUERY_AUDIT_REDIS_TIMEOUT_MS: '250' },
    fetchImpl: () => new Promise(() => {}) });
  assert.equal(result.stored, false);
});

test('oversized diagnostic copies are marked incomplete without changing selection values', async () => {
  const longIds = ['private-fixture\n'.repeat(25000)];
  let saved;
  await saveSelectionIdentityDiagnostic({ event: { ...event, rawSelectedIds: longIds, selectedIds: longIds, unknownIds: longIds }, env,
    fetchImpl: async (_url, options) => { saved = JSON.parse(JSON.parse(options.body)[2]); return Response.json({ result: 'OK' }); } });
  assert.equal(saved.incomplete, true);
  assert.equal(saved.unknownCount, 1);
  assert.ok(saved.originalBytes > 262144);
  assert.match(saved.diagnosticSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(saved).includes('private-fixture'), false);
  assert.equal(longIds[0].length, 400000);
});

test('public service routes only identity events to private storage and never exposes them', async () => {
  for (const fail of [false, true]) {
    let requestId;
    const saved = [];
    const options = { payload: { question: 'synthetic diagnostic question', rulingModelProfile: 'official-astra-low' },
      env: { MODEL_PROVIDER: 'mock', PUBLIC_OFFTOPIC_RISK_CONTROL_ENABLED: 'false', RAG_EVIDENCE_PIPELINE: 'rag_baseline' },
      appendAudit: async input => { requestId = input.requestId; return null; },
      saveSelectionDiagnostic: async input => saved.push(input),
      answerRuling: async input => {
        await input.onEvidenceEvent({ type: 'response', raw: 'must-not-store' });
        await input.onEvidenceEvent(event);
        if (fail) throw Object.assign(new Error('gemini_bounded_selected_identity_not_offered'),
          { code: 'gemini_bounded_selected_identity_not_offered' });
        return { status: 'evidence_prepared', debug: {} };
      },
    };
    let published;
    if (fail) { try { await answerPublicRulingQuestion(options); assert.fail('expected failure'); }
      catch (error) { published = publicAnswerHttpError(error).payload; } }
    else published = (await answerPublicRulingQuestion(options)).answer;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].requestId, requestId);
    assert.equal(saved[0].event.type, 'selection_identity_failure');
    assert.equal(JSON.stringify(published).includes('Q999'), false);
    assert.equal(JSON.stringify(published).includes('canonical-1'), false);
  }
});
