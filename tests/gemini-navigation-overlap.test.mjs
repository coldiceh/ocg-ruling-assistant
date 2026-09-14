import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiBoundedEvidenceProvider } from '../backend/geminiBoundedEvidenceProvider.mjs';

const rule = { id: 'fixture-rule', recordType: 'rule-doc', title: 'fixture rule',
  text: 'fixture rule body', sourceAuthority: 'official_reference', official: true };

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('starts plan count and generation while dense, QA dense, and query embedding are pending', async () => {
  const events = [];
  let generationCount = 0;
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => ({ dataRevision: 'd', qaRevision: 'q', rulesRecords: [rule],
      createQaTools: () => ({ snapshotHandles: [], readSelected: () => [], search: () => ({ items: [] }) }) }),
    loadDenseSearch: async () => {
      events.push('dense:start');
      await wait(40);
      events.push('dense:end');
      return { search: () => [] };
    },
    loadQaSearch: async () => {
      events.push('qaDense:start');
      await wait(40);
      events.push('qaDense:end');
      return { search: () => [] };
    },
    budgetedRequest: request => request.invoke(),
    fetchImpl: async (url, init) => {
      if (url.endsWith(':embedContent')) {
        events.push('embedding:start');
        await wait(40);
        events.push('embedding:end');
        return Response.json({ embedding: { values: Array(768).fill(1) },
          usageMetadata: { promptTokenCount: 100 } });
      }
      if (url.endsWith(':countTokens')) {
        events.push(JSON.parse(init.body).generateContentRequest.contents[0].parts[0].text.includes('原题')
          ? 'plan:count' : 'other:count');
        return Response.json({ totalTokens: 500 });
      }
      generationCount += 1;
      events.push(generationCount === 1 ? 'plan:generate' : 'selection:generate');
      const output = generationCount === 1
        ? { informationNeeds: [], queries: [], ruleSectionIds: [] }
        : { selectionNotes: '', ruleUnitIds: [], qaHandles: [] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, totalTokenCount: 520 } });
    },
  });

  await provider.retrieve({ userQuery: 'fixture question', cardResolution: { resolvedCards: [] },
    retrievedEvidence: {}, dataRevision: 'd', env: { GEMINI_API_KEY: 'fixture' } });

  assert.ok(events.indexOf('plan:count') >= 0);
  assert.ok(events.indexOf('plan:generate') >= 0);
  assert.ok(events.indexOf('plan:count') < events.indexOf('dense:end'),
    `plan count must overlap dense initialization: ${events.join(', ')}`);
  assert.ok(events.indexOf('plan:count') < events.indexOf('qaDense:end'),
    `plan count must overlap QA dense initialization: ${events.join(', ')}`);
  assert.ok(events.indexOf('plan:count') < events.indexOf('embedding:end'),
    `plan count must overlap query embedding: ${events.join(', ')}`);
  assert.ok(events.indexOf('plan:generate') < events.indexOf('dense:end'),
    `plan generation must overlap dense initialization: ${events.join(', ')}`);
  assert.ok(events.indexOf('plan:generate') < events.indexOf('qaDense:end'),
    `plan generation must overlap QA dense initialization: ${events.join(', ')}`);
  assert.ok(events.indexOf('plan:generate') < events.indexOf('embedding:end'),
    `plan generation must overlap query embedding: ${events.join(', ')}`);
});
