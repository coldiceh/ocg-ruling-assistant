import test from 'node:test';
import assert from 'node:assert/strict';
import { answerPublicRulingQuestion } from '../backend/publicAnswerService.mjs';
import { createGeminiRuleQaEvidenceProvider } from '../backend/geminiRuleQaEvidenceProvider.mjs';
import { preloadRagRequestAssets } from '../backend/ragRulingPipeline.mjs';

// Claim: local snapshot work overlaps classification only after the active
// lock is checked, and the exact promise is passed forward. A failure means
// the scheduling change must not ship; this makes no semantic evidence claim.
const env = { MODEL_PROVIDER: 'mock', UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
  UPSTASH_REDIS_REST_TOKEN: 'test-token' };

test('request asset preload starts both loaders immediately and preserves their promises', async () => {
  let resolveData;
  const dataPromise = new Promise((resolve) => { resolveData = resolve; });
  const geminiPromise = Promise.resolve({ kind: 'gemini-assets' });
  const calls = [];
  const preloaded = preloadRagRequestAssets({
    env: { RAG_EVIDENCE_PIPELINE: 'cloud_evidence_v1', GEMINI_RULE_QA_ENABLED: 'true' },
    dataDir: 'fixture-rag-data',
    loadData: (dataDir) => {
      calls.push(['data', dataDir]);
      return dataPromise;
    },
    loadGeminiAssets: ({ dataDir }) => {
      calls.push(['gemini', dataDir]);
      return geminiPromise;
    },
  });

  assert.deepEqual(calls.map(([name]) => name), ['data', 'gemini']);
  assert.equal(preloaded.data, dataPromise);
  assert.equal(preloaded.geminiAssets, geminiPromise);
  resolveData({ kind: 'rag-data' });
  await Promise.all([preloaded.data, preloaded.geminiAssets]);
});

test('prepared route preloads the explicit card-only snapshot while other routes keep the full loader', async () => {
  const calls = [];
  const common = {
    env: { RAG_EVIDENCE_PIPELINE: 'cloud_evidence_v1', GEMINI_RULE_QA_ENABLED: 'true' },
    dataDir: 'fixture-rag-data',
    loadData: () => { calls.push('full'); return Promise.resolve({ scope: 'complete' }); },
    loadPreparedData: () => { calls.push('prepared'); return Promise.resolve({ scope: 'prepared_cards_only' }); },
    loadGeminiAssets: () => Promise.resolve({ kind: 'gemini-assets' }),
  };

  const prepared = preloadRagRequestAssets({ ...common, officialQaExactAlreadyChecked: true });
  assert.equal((await prepared.data).scope, 'prepared_cards_only');
  const full = preloadRagRequestAssets(common);
  assert.equal((await full.data).scope, 'complete');
  assert.deepEqual(calls, ['prepared', 'full']);
});

test('public request starts one local preload after inactive lock and before classification', async () => {
  const calls = [];
  const preloadedAssets = { data: Promise.resolve({}), geminiAssets: Promise.resolve({}) };
  await answerPublicRulingQuestion({ payload: { question: 'fixture' }, env,
    appendAudit: async () => null,
    readRiskControl: async () => { calls.push('lock'); return { ok: true, active: false }; },
    preloadAssets: (options) => {
      calls.push('preload');
      assert.equal(options.officialQaExactAlreadyChecked, true);
      return preloadedAssets;
    },
    classifyScope: async () => { calls.push('classify'); return { scope: 'in_scope' }; },
    answerRuling: async (options) => {
      calls.push('pipeline');
      assert.equal(options.preloadedAssets, preloadedAssets);
      return { status: 'evidence_prepared' };
    },
    prepareForContinuation: true,
  });
  assert.deepEqual(calls, ['lock', 'preload', 'classify', 'pipeline']);
});

test('active public lock does not start snapshot work', async () => {
  await answerPublicRulingQuestion({ payload: { question: 'fixture' }, env,
    appendAudit: async () => null,
    readRiskControl: async () => ({ ok: true, active: true }),
    preloadAssets: () => assert.fail('locked request must not load snapshots'),
    classifyScope: async () => assert.fail('locked request must not classify'),
    answerRuling: async () => assert.fail('locked request must not prepare'),
  });
});

test('provider consumes the preloaded failure without reloading or calling a model', async () => {
  const expected = new Error('fixture_snapshot_failure');
  const assetsPromise = Promise.reject(expected);
  assetsPromise.catch(() => {});
  const provider = createGeminiRuleQaEvidenceProvider({
    loadAssets: () => assert.fail('must reuse original preload'),
    clientFactory: () => assert.fail('must not call model after snapshot failure'),
  });
  await assert.rejects(provider.retrieve({ assetsPromise, dataRevision: 'fixture' }), (error) => error === expected);
});

test('provider uses a preloaded snapshot and reports the local preparation stages', async () => {
  const assets = { dataRevision: 'fixture', rulesRecords: [], createQaTools: () => ({
    qaRevision: 'fixture-qa', search: () => ({ items: [] }), readSelected: () => [],
  }) };
  const provider = createGeminiRuleQaEvidenceProvider({
    loadAssets: () => assert.fail('must not load again'),
    clientFactory: () => ({ model: 'fixture', getCache: async () => ({ reused: true }),
      generate: async () => ({ candidates: [{ content: { role: 'model', parts: [{
        functionCall: { name: 'submit_evidence', args: { ruleUnitIds: [], qaHandles: [] } },
      }] } }] }),
    }),
  });
  const result = await provider.retrieve({ assetsPromise: Promise.resolve(assets), dataRevision: 'fixture',
    userQuery: 'fixture', cardResolution: { resolvedCards: [] }, retrievedEvidence: {} });
  for (const key of ['assetLoadWait', 'ruleContext', 'qaRequestView', 'initialQaSearch']) {
    assert.ok(Number.isFinite(result.telemetry.timingsMs[key]));
  }
});
