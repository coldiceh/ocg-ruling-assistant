import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiBoundedEvidenceProvider } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';

test('joint first round plans rule and QA navigation while preserving a late complete QA record', async () => {
  const records = Array.from({ length: 80 }, (_, index) => ({ id: `fixture-${index}`,
    recordType: 'qa', title: `source title ${index}`, question: `whole question ${index}`,
    answer: `whole answer ${index}`, official: true }));
  const qaTools = createQaTools({ records, qaRevision: 'q' });
  const items = qaTools.readSelected(qaTools.snapshotHandles);
  const target = items[65];
  const stages = [];
  const requests = [];
  const card = { id: 'fixture-card', name: 'fixture card', aliases: ['fixture alias'],
    effectText: 'complete original effect text', cardType: '', typeLine: '',
    resolutionSource: '', attribute: '', race: '', atk: null, def: null,
    level: null, rank: null, link: null, properties: [], monsterProperties: [], source: '' };
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => ({ dataRevision: 'd', qaRevision: 'q', rulesRecords: [
      { id: 'rule-fixture', recordType: 'rule-doc', title: 'fixture', text: 'rule body' },
    ], createQaTools: () => qaTools }),
    loadDenseSearch: async () => ({ search: () => [] }),
    loadQaSearch: async () => ({ search: () => items }),
    budgetedRequest: request => request.invoke(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(':embedContent')) {
        return Response.json({ embedding: { values: Array(768).fill(1) },
          usageMetadata: { promptTokenCount: 100 } });
      }
      if (url.endsWith(':batchEmbedContents')) {
        return Response.json({ embeddings: Array.from({ length: JSON.parse(init.body).requests.length },
          () => ({ values: Array(768).fill(1) })), usageMetadata: { promptTokenCount: 100 } });
      }
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 500 });
      requests.push(body);
      const payload = JSON.parse(body.contents[0].parts[1].text);
      if (requests.length === 1) {
        stages.push('joint_plan');
        assert.equal(payload.question, 'fixture question');
        assert.deepEqual(payload.confirmedCards, [card]);
        assert.deepEqual(payload.cardTexts, [{ id: 'fixture-card', text: 'complete canonical card text' }]);
        assert.ok(Array.isArray(payload.ruleSections), 'joint plan must include the rule directory');
        assert.ok(Array.isArray(payload.qaCandidates), 'joint plan must include the QA directory');
        const row = payload.qaCandidates.find(candidate => candidate[1] === target.record.title);
        assert.ok(row, 'late QA candidate must be offered in the joint first round');
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          informationNeeds: ['fixture relation'], queries: ['fixture query'], ruleSectionIds: [],
          qaCandidateIds: [row[0]],
        }) }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, totalTokenCount: 520 } });
      }
      stages.push('selection');
      const visible = payload.groups.flatMap(group => group.items || []);
      const offeredTarget = visible.find(item => item.handle === target.handle);
      assert.ok(offeredTarget, 'late QA candidate must remain offered after query expansion');
      assert.deepEqual(offeredTarget.record, target.record);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        selectionNotes: '', ruleUnitIds: [], qaHandles: [target.handle],
      }) }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, totalTokenCount: 520 } });
    },
  });
  const result = await provider.retrieve({ userQuery: 'fixture question', cardResolution: { resolvedCards: [card] },
    retrievedEvidence: { cardTexts: [{ id: 'fixture-card', text: 'complete canonical card text' }] },
    dataRevision: 'd', env: { GEMINI_API_KEY: 'fixture' } });

  assert.deepEqual(stages, ['joint_plan', 'selection']);
  assert.equal(requests.length, 2, 'joint planning must not add a third model request');
  assert.equal(result.telemetry.rounds, 2);
  assert.equal(result.packing.modelEvidence.rawRelatedEvidence[0].text, JSON.stringify(target.record));
});
