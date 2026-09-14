import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiBoundedEvidenceProvider } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';

const rulesRecords = [{ id: 'rule', recordType: 'rule-doc', title: 'fixture source',
  text: 'fixture rule paragraph', sourceAuthority: 'official_reference', official: true }];
const qaRecords = [
  { id: 'large-qa', recordType: 'qa', title: 'large fixture QA', question: 'fixture question',
    answer: 'large complete source '.repeat(350), official: true },
  { id: 'small-qa', recordType: 'qa', title: 'small fixture QA', question: 'fixture question',
    answer: 'small complete source', official: true },
];

test('token-shrunk reading rebuild keeps later complete groups after an oversized first group', async () => {
  const requests = [];
  let generationCalls = 0;
  let countCalls = 0;
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => ({ dataRevision: 'd', qaRevision: 'q', rulesRecords,
      createQaTools: options => createQaTools({ records: qaRecords, qaRevision: 'q', ...options }) }),
    loadDenseSearch: async () => ({ search: () => [] }),
    loadQaSearch: async () => ({ search: () => [] }),
    budgetedRequest: request => request.invoke(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(':embedContent')) {
        return Response.json({ embedding: { values: Array(768).fill(1) },
          usageMetadata: { promptTokenCount: 100 } });
      }
      if (url.endsWith(':batchEmbedContents')) {
        return Response.json({ embeddings: Array.from({ length: body.requests.length },
          () => ({ values: Array(768).fill(1) })), usageMetadata: { promptTokenCount: 100 } });
      }
      if (url.endsWith(':countTokens')) {
        countCalls += 1;
        if (countCalls === 1) return Response.json({ totalTokens: 22000 });
        const countedBody = JSON.parse(body.generateContentRequest.contents[0].parts[1].text);
        const offered = countedBody.groups || [];
        const hasLarge = offered.some(group => (group.items || [])
          .some(item => String(item.record?.answer || '').length > 5000));
        return Response.json({ totalTokens: offered.length === 0 ? 2000 : hasLarge ? 12000 : 3000 });
      }
      if (!url.endsWith(':generateContent')) throw new Error('unexpected_fixture_endpoint');
      generationCalls += 1;
      requests.push(body);
      const payload = JSON.parse(body.contents[0].parts[1].text);
      const output = generationCalls === 1
        ? { informationNeeds: ['fixture relation'], queries: ['fixture query'],
          // Force the failure trigger: the model orders the large QA first.
          qaCandidateIds: [...payload.qaCandidates].sort((left, right) => right[2] - left[2]).map(row => row[0]) }
        : { selectionNotes: '', ruleUnitIds: [], qaHandles: [] };
      return Response.json({ candidates: [{ content: { role: 'model',
        parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80,
          thoughtsTokenCount: 20, totalTokenCount: 600 } });
    },
  });

  const result = await provider.retrieve({
    userQuery: 'fixture question and scene',
    dataRevision: 'd',
    env: { GEMINI_API_KEY: 'fixture' },
    cardResolution: { resolvedCards: [] },
    retrievedEvidence: {},
  });
  const selection = JSON.parse(requests[1].contents[0].parts[1].text);
  const offeredQa = selection.groups.flatMap(group => group.items || []);
  assert.equal(generationCalls, 2);
  assert.equal(result.telemetry.tokenCounts.filter(item => item.stage === 'selection').at(-1).tokens, 3000);
  assert.ok(offeredQa.some(item => item.record.id === 'small-qa'));
  assert.equal(offeredQa.some(item => item.record.id === 'large-qa'), false);
  assert.equal(offeredQa.find(item => item.record.id === 'small-qa').record.answer,
    'small complete source');
  assert.ok(result.telemetry.readGroupIds.some(id => id.startsWith('qa:')));
  assert.ok(result.telemetry.omittedGroupIds.length > 0);
  const generatedInputTokens = result.telemetry.calls
    .filter(call => call.stage === 'plan' || call.stage === 'selection')
    .reduce((total, call) => total + call.countedInputTokens, 0);
  assert.equal(generatedInputTokens, 25000);
  assert.ok(generatedInputTokens <= 32000);
});
