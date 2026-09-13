import test from 'node:test';
import assert from 'node:assert/strict';
import { createQaSnapshot } from '../backend/geminiQaTools.mjs';
import { createGeminiRuleQaEvidenceProvider } from '../backend/geminiRuleQaEvidenceProvider.mjs';

// Claim: the production provider awaits source-backed pages and packs the exact
// delivered canonical record, title and URL. No semantic sufficiency claim.
// Failure requires repairing source delivery before a paid model experiment.
test('provider delivers and packs one canonical source QA across initial and subsequent pages', async () => {
  const snapshot = createQaSnapshot({ qaRevision: 'source-provider-test', records: [{
    id: 'ygoresources-qa-93001', recordType: 'qa', cardIds: ['8'], text: 'legacy projection',
  }] });
  snapshot.buildLexicalIndex();
  const sourceQa = { id: 93001, title: 'source title', question: 'original scene\nconditions',
    answer: 'original answer\nother branch', thisSrc: { type: 0, date: '2026-01-01' } };
  let sourceCalls = 0, modelCalls = 0, delivered;
  const provider = createGeminiRuleQaEvidenceProvider({
    loadAssets: async () => ({ dataRevision: 'revision', rulesRecords: [], createQaTools: snapshot.createQaTools }),
    fetchImpl: async (url) => {
      sourceCalls++;
      assert.equal(url, 'https://db.ygoresources.com/data/qa/93001');
      return Response.json({ cards: [8], qaData: { ja: sourceQa } }, { headers: { 'X-Cache-Revision': '123' } });
    },
    clientFactory: () => ({ model: 'gemini-3.8-flash', getCache: async () => ({ reused: true }),
      generate: async (_cache, contents) => {
        modelCalls++;
        if (modelCalls === 1) {
          delivered = JSON.parse(contents[0].parts[0].text).initialQa.items[0];
          assert.deepEqual(delivered.record.sourceQa, sourceQa);
          assert.equal(delivered.record.sourceRevision, '123');
          return { candidates: [{ content: { role: 'model', parts: [{ functionCall: {
            name: 'search_qa', args: { queries: ['second query'] },
          } }] } }] };
        }
        const page = contents.at(-1).parts[0].functionResponse.response;
        assert.deepEqual(page.items[0], delivered);
        return { candidates: [{ content: { role: 'model', parts: [{ functionCall: {
          name: 'submit_evidence', args: { ruleUnitIds: [], qaHandles: [delivered.handle] },
        } }] } }] };
      },
    }),
  });
  const result = await provider.retrieve({ userQuery: 'fixture query', dataRevision: 'revision', retrievedEvidence: {},
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] } });
  const body = result.packing.modelEvidence.rawRelatedEvidence[0];
  assert.equal(sourceCalls, 1);
  assert.equal(modelCalls, 2);
  assert.equal(body.id, delivered.handle);
  assert.equal(body.title, sourceQa.title);
  assert.equal(body.sourceUrl, 'https://db.ygoresources.com/data/qa/93001');
  assert.equal(body.text, JSON.stringify(delivered.record));
  assert.deepEqual(JSON.parse(body.text).sourceQa, sourceQa);
  assert.equal(Object.hasOwn(JSON.parse(body.text), 'text'), false);
  assert.equal(result.telemetry.reasoningEffort, 'low');
});
