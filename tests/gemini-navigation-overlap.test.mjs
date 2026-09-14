import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiBoundedEvidenceProvider } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';

const rule = { id: 'fixture-rule', recordType: 'rule-doc', title: 'fixture rule',
  text: 'fixture rule body', sourceAuthority: 'official_reference', official: true };
const qaTools = createQaTools({ qaRevision: 'q', records: [{ id: 'fixture-qa', recordType: 'qa',
  title: 'fixture QA', question: 'fixture question', answer: 'fixture answer', official: true }] });

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('waits for dense, QA dense, and original query embedding before the joint plan', async () => {
  const events = [];
  let generationCount = 0;
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => ({ dataRevision: 'd', qaRevision: 'q', rulesRecords: [rule],
      createQaTools: () => qaTools }),
    loadDenseSearch: async () => {
      events.push('dense:start');
      await wait(40);
      events.push('dense:end');
      return { search: () => [] };
    },
    loadQaSearch: async ({ items }) => {
      events.push('qaDense:start');
      await wait(40);
      events.push('qaDense:end');
      return { search: () => items };
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
      if (url.endsWith(':batchEmbedContents')) {
        return Response.json({ embeddings: [], usageMetadata: { promptTokenCount: 0 } });
      }
      if (url.endsWith(':countTokens')) {
        const payload = JSON.parse(init.body).generateContentRequest.contents[0].parts[1].text;
        events.push(JSON.parse(payload).qaCandidates ? 'joint_plan:count' : 'other:count');
        return Response.json({ totalTokens: 500 });
      }
      generationCount += 1;
      events.push(generationCount === 1 ? 'joint_plan:generate' : 'selection:generate');
      const output = generationCount === 1
        ? { informationNeeds: [], queries: [], ruleSectionIds: [], qaCandidateIds: [] }
        : { selectionNotes: '', ruleUnitIds: [], qaHandles: [] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, totalTokenCount: 520 } });
    },
  });

  await provider.retrieve({ userQuery: 'fixture question', cardResolution: { resolvedCards: [] },
    retrievedEvidence: {}, dataRevision: 'd', env: { GEMINI_API_KEY: 'fixture' } });

  const planCount = events.indexOf('joint_plan:count');
  const planGenerate = events.indexOf('joint_plan:generate');
  assert.ok(planCount >= 0, `joint plan count missing: ${events.join(', ')}`);
  assert.ok(planGenerate >= 0, `joint plan generation missing: ${events.join(', ')}`);
  for (const marker of ['dense:end', 'qaDense:end', 'embedding:end']) {
    assert.ok(events.indexOf(marker) >= 0, `${marker} missing: ${events.join(', ')}`);
    assert.ok(events.indexOf(marker) < planCount,
      `joint plan count must wait for ${marker}: ${events.join(', ')}`);
  }
});
