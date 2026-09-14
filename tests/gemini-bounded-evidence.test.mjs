import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiBoundedEvidenceProvider } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';

const rule = { id: 'rule', recordType: 'rule-doc', title: 'fixture source', text: 'paragraph one\n\nparagraph two',
  sourceAuthority: 'official_reference', official: true };
const qa = { id: 'qa', recordType: 'qa', title: 'fixture QA', question: 'fixture question', answer: 'complete fixture answer', official: true };
const assets = { dataRevision: 'd', qaRevision: 'q', rulesRecords: [rule],
  createQaTools: options => createQaTools({ records: [qa], qaRevision: 'q', ...options }) };

function fixture({ unknown = false, excessive = false } = {}) {
  const requests = [];
  const provider = createGeminiBoundedEvidenceProvider({ loadAssets: async () => assets,
    budgetedRequest: request => request.invoke(), fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.generationConfig?.thinkingConfig?.thinkingLevel || 'low', 'low');
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: excessive ? 33000 : 500 });
      requests.push(body);
      let output;
      if (requests.length === 1) output = { informationNeeds: 'fixture relation', queries: 'fixture search' };
      else {
        const input = JSON.parse(body.contents[0].parts[1].text);
        const handles = input.groups.flatMap(group => group.items || []).map(item => item.handle);
        output = { selectionNotes: 'fixture selection', ruleUnitIds: ['R1.1'], qaHandles: unknown ? ['unoffered'] : handles };
      }
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 600 } });
    } });
  return { provider, requests };
}

const input = { userQuery: 'original complete question and scene', dataRevision: 'd', env: { GEMINI_API_KEY: 'fixture' },
  cardResolution: { resolvedCards: [], unresolvedMentions: ['unresolved original'] },
  retrievedEvidence: { cardTexts: [{ id: 'card-text', text: 'complete canonical card text', source: 'fixture' }],
    userProvidedCardTexts: [{ name: 'user fixture', text: 'complete user-supplied text' }] } };

test('both online model requests retain original question and independent complete card texts', async () => {
  const { provider, requests } = fixture();
  const result = await provider.retrieve(input);
  assert.equal(requests.length, 2);
  for (const body of requests) {
    const delivered = JSON.parse(body.contents[0].parts[1].text);
    assert.equal(delivered.question, input.userQuery);
    assert.deepEqual(delivered.cardTexts, input.retrievedEvidence.cardTexts);
    assert.deepEqual(delivered.userProvidedCardTexts, input.retrievedEvidence.userProvidedCardTexts);
    assert.deepEqual(delivered.unresolvedMentions, input.cardResolution.unresolvedMentions);
    assert.equal(Object.hasOwn(body, 'cachedContent'), false);
  }
  const packed = result.packing.modelEvidence.rawRelatedEvidence;
  assert.equal(packed.find(item => item.id === 'R1.1').text, 'paragraph one\n\n');
  assert.equal(packed.find(item => item.recordType === 'qa').text, JSON.stringify(qa));
  assert.ok(result.packing.promptChars <= 14000);
  assert.equal(result.telemetry.cacheProvisionUsd, 0);
});

test('selection cannot refer to a source not offered to the selecting model', async () => {
  const { provider, requests } = fixture({ unknown: true });
  await assert.rejects(provider.retrieve(input), /gemini_bounded_selected_identity_not_offered/);
  assert.equal(requests.length, 2);
});

test('counted input over the spending contract stops before any generation', async () => {
  const { provider, requests } = fixture({ excessive: true });
  await assert.rejects(provider.retrieve(input), /gemini_bounded_request_budget_exceeded/);
  assert.equal(requests.length, 0);
});
