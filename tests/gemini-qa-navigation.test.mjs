import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGeminiBoundedEvidenceProvider } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';
import { buildRuleStructureMapping, makeQaSourceUnits, stableJson } from '../backend/evidenceSourceStructure.mjs';
import { createFocusedQaView } from '../backend/geminiFocusedQaView.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

test('short planning and independent retrieval preserve a late complete QA record', async () => {
  const records = Array.from({ length: 80 }, (_, index) => ({ id: `fixture-${index}`,
    recordType: 'qa', title: `source title ${index}`, question: `whole question ${index}`,
    answer: `whole answer ${index}`, official: true }));
  const qaTools = createQaTools({ records, qaRevision: 'q' });
  const items = qaTools.readSelected(qaTools.snapshotHandles);
  const target = items[65];
  const focused = createFocusedQaView({ qaRevision: 'q', items });
  const focusedByHandle = new Map(focused.items.map(item => [item.handle, item]));
  const qaUnits = makeQaSourceUnits(focused.items).map(unit => ({ ...unit,
    item: focusedByHandle.get(unit.handle) }));
  const ruleRecords = [{ id: 'rule-fixture', recordType: 'rule-doc', title: 'fixture', text: 'rule body' }];
  const { structureMappingRevision: _old, ...mappingBody } = buildRuleStructureMapping(ruleRecords);
  const structureMapping = { ...mappingBody, qaUnits };
  structureMapping.structureMappingRevision = digest(stableJson(structureMapping));
  const stages = [];
  const requests = [];
  const card = { id: 'fixture-card', name: 'fixture card', aliases: ['fixture alias'],
    effectText: 'complete original effect text', cardType: '', typeLine: '',
    resolutionSource: '', attribute: '', race: '', atk: null, def: null,
    level: null, rank: null, link: null, properties: [], monsterProperties: [], source: '' };
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => ({ schemaVersion: 3, manifest: { schemaVersion: 3 }, dataRevision: 'd',
      bundleRevision: 'b', qaRevision: 'q', ruleContentRevision: digest(stableJson(ruleRecords)), navigationRevision: 'n',
      structureMappingRevision: structureMapping.structureMappingRevision, ruleDenseRevision: 'rd', qaDenseRevision: 'qd', rulesRecords: ruleRecords,
      structureMapping, navigationRecords: [], createQaTools: () => qaTools }),
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
        stages.push('plan');
        assert.equal(payload.question, 'fixture question');
        assert.deepEqual(payload.confirmedCards, [card]);
        assert.deepEqual(payload.cardTexts, [{ id: 'fixture-card', text: 'complete canonical card text' }]);
        assert.equal(Object.hasOwn(payload, 'ruleSections'), false);
        assert.equal(Object.hasOwn(payload, 'qaCandidates'), false);
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          needs: [{ id: 'need-1', question: 'fixture relation', ruleQuery: 'fixture rule',
            qaQuery: target.record.title }],
        }) }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, totalTokenCount: 520 } });
      }
      stages.push('selection');
      const visible = payload.groups.flatMap(group => group.items || []);
      const offeredTarget = visible.find(item => item.record.title === target.record.title);
      assert.ok(offeredTarget, 'late QA candidate must remain offered after query expansion');
      assert.deepEqual(offeredTarget.record, target.record);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        selectedIds: [offeredTarget.handle], unableToSelect: false, note: '',
      }) }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, totalTokenCount: 520 } });
    },
  });
  const result = await provider.retrieve({ userQuery: 'fixture question', cardResolution: { resolvedCards: [card] },
    retrievedEvidence: { cardTexts: [{ id: 'fixture-card', text: 'complete canonical card text' }] },
    dataRevision: 'd', env: { GEMINI_API_KEY: 'fixture' } });

  assert.deepEqual(stages, ['plan', 'selection']);
  assert.equal(requests.length, 2, 'planning must not add a third model request');
  assert.equal(result.telemetry.rounds, 2);
  assert.equal(result.packing.modelEvidence.rawRelatedEvidence[0].text, JSON.stringify(target.record));
});
