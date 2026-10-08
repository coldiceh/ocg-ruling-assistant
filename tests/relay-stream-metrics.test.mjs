import assert from 'node:assert/strict';
import test from 'node:test';
import { callRagModel } from '../backend/ragModelClient.mjs';
import { finalizePreparedRagRulingQuestion } from '../backend/ragRulingPipeline.mjs';
import { RulingModelProviderError } from '../backend/rulingModelProviders.mjs';
import { queryAuditAnswerPatch, queryAuditFailurePatch } from '../backend/publicQueryAudit.mjs';
import { listQueryAudits, updateQueryAudit } from '../backend/queryAuditStore.mjs';

const env = { RAG_MODEL_PROVIDER: 'bai', BAI_API_KEY: 'synthetic-test-key',
  BAI_BASE_URL: 'https://example.invalid/v1', RAG_MODEL: 'gpt-6-astra' };

test('provider failure diagnostics retain DONE and body-read timings', async () => {
  const result = await callRagModel({ prompt: 'synthetic prompt', env, outputMode: 'plain_text',
    fetchImpl: async () => { throw new RulingModelProviderError('synthetic protocol failure', {
      code: 'relay_stream_protocol_error', provider: 'relay', status: 200,
      streamMetrics: { requestToResponseHeadersMs: 5, requestToDoneMs: 20,
        requestToCompleteMs: 20, responseBodyReadMs: 15 },
    }); },
  });
  assert.equal(result.providerFailure.streamMetrics.requestToDoneMs, 20);
  assert.equal(result.providerFailure.streamMetrics.responseBodyReadMs, 15);
});

test('a successful public finalization retains stream timings through both safe envelopes', async () => {
  let calls = 0;
  const completion = { id: 'synthetic-metrics', model: 'gpt-6-astra',
    choices: [{ index: 0, delta: { content: 'Synthetic complete answer' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } };
  const result = await finalizePreparedRagRulingQuestion({ env,
    continuation: { schemaVersion: 1, promptBundle: { prompt: 'synthetic prompt',
      modelEvidence: {}, allowedEvidenceIds: [] }, evidence: {}, cardResolution: {} },
    fetchImpl: async () => {
      calls += 1;
      return new Response(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.shortAnswer, 'Synthetic complete answer');
  const metrics = result.debug.generationAttempts[0].streamMetrics;
  assert.ok(metrics);
  assert.equal(typeof metrics.requestToDoneMs, 'number');
  assert.equal(metrics.requestToDoneMs, metrics.requestToCompleteMs);
  assert.equal(metrics.responseBodyReadMs, metrics.requestToCompleteMs - metrics.requestToResponseHeadersMs);
  assert.equal(metrics.sseEventCount, 1);
  assert.equal(metrics.finishReason, 'stop');
  const patch = queryAuditAnswerPatch(result);
  assert.equal(patch.streamMetrics.requestToDoneMs, metrics.requestToDoneMs);
  const audit = auditMemory();
  await updateQueryAudit({ id: 'synthetic-audit', patch, ...audit.options });
  const saved = await listQueryAudits(audit.options);
  assert.equal(saved.entries[0].streamMetrics.requestToDoneMs, metrics.requestToDoneMs);
  assert.equal(saved.entries[0].streamMetrics.responseBodyReadMs, metrics.responseBodyReadMs);
});

test('audit write and historical read retain only bounded numeric stream metrics', async () => {
  const audit = auditMemory();
  const unsafe = { requestToDoneMs: 20, responseBodyReadMs: 15, requestToCompleteMs: Number.MAX_VALUE,
    requestToFirstByteMs: -1, requestToResponseHeadersMs: '30', requestToFirstEventMs: 86400001,
    requestToFirstContentMs: null, networkChunkCount: 1.5, responseBytes: 33554433,
    sseEventCount: 2, visibleContentBytes: 80, requestId: 'private-id', content: 'private-text' };
  await updateQueryAudit({ id: 'synthetic-audit', patch: { streamMetrics: unsafe }, ...audit.options });
  const expected = { requestToDoneMs: 20, responseBodyReadMs: 15, requestToFirstContentMs: null,
    sseEventCount: 2, visibleContentBytes: 80 };
  assert.deepEqual(audit.stored().streamMetrics, expected);
  audit.replaceMetrics(unsafe);
  assert.deepEqual((await listQueryAudits(audit.options)).entries[0].streamMetrics, expected);
  const failure = queryAuditFailurePatch({ code: 'model_provider_timeout',
    providerFailure: { streamMetrics: unsafe } });
  assert.deepEqual(failure.streamMetrics, expected);
});

function auditMemory() {
  let record = { id: 'synthetic-audit', question: 'synthetic question',
    createdAt: '2026-10-08T00:00:00.000Z', mode: 'rag' };
  return {
    stored: () => record,
    replaceMetrics: metrics => { record.streamMetrics = metrics; },
    options: { env: { UPSTASH_REDIS_REST_URL: 'https://example.invalid', UPSTASH_REDIS_REST_TOKEN: 'synthetic-token' },
      fetchImpl: async (_url, options) => {
        const command = JSON.parse(options.body);
        if (command[0] === 'EVAL') {
          record = { ...record, ...JSON.parse(command[5]) };
          return Response.json({ result: JSON.stringify(record) });
        }
        assert.equal(command[0], 'LRANGE');
        return Response.json({ result: [JSON.stringify(record)] });
      },
    },
  };
}
