import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGeminiBoundedEvidenceProvider } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';
import { buildRuleStructureMapping, makeQaSourceUnits, stableJson } from '../backend/evidenceSourceStructure.mjs';
import { createFocusedQaView } from '../backend/geminiFocusedQaView.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

const rule = { id: 'fixture-rule', recordType: 'rule-doc', title: 'fixture rule',
  text: 'fixture rule body', sourceAuthority: 'official_reference', official: true };
const qaTools = createQaTools({ qaRevision: 'q', records: [{ id: 'fixture-qa', recordType: 'qa',
  title: 'fixture QA', question: 'fixture question', answer: 'fixture answer', official: true }] });

function assets() {
  const items = qaTools.readSelected(qaTools.snapshotHandles);
  const focused = createFocusedQaView({ qaRevision: 'q', items });
  const byHandle = new Map(focused.items.map(item => [item.handle, item]));
  const qaUnits = makeQaSourceUnits(focused.items).map(unit => ({ ...unit, item: byHandle.get(unit.handle) }));
  const { structureMappingRevision: _old, ...mappingBody } = buildRuleStructureMapping([rule]);
  const structureMapping = { ...mappingBody, qaUnits };
  structureMapping.structureMappingRevision = digest(stableJson(structureMapping));
  return { schemaVersion: 3, manifest: { schemaVersion: 3 }, dataRevision: 'd', bundleRevision: 'b',
    qaRevision: 'q', ruleContentRevision: digest(stableJson([rule])), navigationRevision: 'n',
    structureMappingRevision: structureMapping.structureMappingRevision,
    ruleDenseRevision: 'rd', qaDenseRevision: 'qd', rulesRecords: [rule], structureMapping,
    navigationRecords: [], createQaTools: () => qaTools };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('starts independent preparation together and waits for it before selection', async () => {
  const events = [];
  let generationCount = 0;
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => assets(),
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
        events.push(JSON.parse(payload).groups ? 'selection:count' : 'plan:count');
        return Response.json({ totalTokens: 500 });
      }
      generationCount += 1;
      events.push(generationCount === 1 ? 'plan:generate' : 'selection:generate');
      const output = generationCount === 1
        ? { needs: [] }
        : { selectedIds: [], unableToSelect: false, note: '' };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, totalTokenCount: 520 } });
    },
  });

  await provider.retrieve({ userQuery: 'fixture question', cardResolution: { resolvedCards: [] },
    retrievedEvidence: {}, dataRevision: 'd', env: { GEMINI_API_KEY: 'fixture' } });

  const planCount = events.indexOf('plan:count');
  const planGenerate = events.indexOf('plan:generate');
  const selectionGenerate = events.indexOf('selection:generate');
  assert.ok(planCount >= 0, `plan count missing: ${events.join(', ')}`);
  assert.ok(planGenerate >= 0, `plan generation missing: ${events.join(', ')}`);
  assert.ok(selectionGenerate >= 0, `selection generation missing: ${events.join(', ')}`);
  for (const marker of ['dense:end', 'qaDense:end', 'embedding:end']) {
    assert.ok(events.indexOf(marker) >= 0, `${marker} missing: ${events.join(', ')}`);
    assert.ok(events.indexOf(marker) < selectionGenerate,
      `selection must wait for ${marker}: ${events.join(', ')}`);
  }
  assert.ok(planGenerate < events.indexOf('dense:end'), `plan should overlap asset preparation: ${events.join(', ')}`);
});
