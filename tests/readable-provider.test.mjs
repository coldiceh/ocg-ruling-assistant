import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiBoundedEvidenceProvider } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { buildRuleStructureMapping, sourceSha256, stableJson } from '../backend/evidenceSourceStructure.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';
import { loadEvidenceGenerationContract } from '../backend/evidenceGenerationContract.mjs';

test('actual provider serializes readable planning and selection inputs and returns the exact readable final prompt', async () => {
  const record = { id: 'public-source', recordType: 'rule-doc', title: '来源',
    sourceUrl: 'https://example.test/rules', sourceAuthority: 'community_reference',
    text: '原文第一段\n第二行\n\n原文第二段', official: false };
  const { structureMappingRevision: _old, ...base } = buildRuleStructureMapping([record]);
  const mapping = { ...base, qaUnits: [] };
  const assets = { schemaVersion: 3, dataRevision: 'd', qaRevision: 'q', bundleRevision: 'bundle',
    ruleContentRevision: 'rule-content', navigationRevision: 'navigation', navigationRecords: [],
    structureMappingRevision: sourceSha256(stableJson(mapping)),
    structureMapping: { ...mapping, structureMappingRevision: sourceSha256(stableJson(mapping)) },
    rulesRecords: [record], createQaTools: options => createQaTools({ records: [], qaRevision: 'q', ...options }) };
  const generations = [], counted = [];
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => assets,
    loadGenerationContract: stage => loadEvidenceGenerationContract(stage),
    loadDenseSearch: async ({ rules }) => ({ search: () => [...rules.units.values()] }),
    loadQaSearch: async () => ({ search: () => [] }),
    budgetedRequest: async request => request.invoke(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(':batchEmbedContents')) return Response.json({
        embeddings: body.requests.map(() => ({ values: Array(768).fill(1) })) });
      if (url.endsWith(':embedContent')) return Response.json({ embedding: { values: Array(768).fill(1) } });
      if (url.endsWith(':countTokens')) {
        counted.push(body.generateContentRequest.contents[0].parts[1].text);
        return Response.json({ totalTokens: 500 });
      }
      assert.ok(url.endsWith(':generateContent'));
      const text = body.contents[0].parts[1].text;
      generations.push(text);
      // Mechanical extraction of emitted selector aliases for the fake model.
      // It does not decide whether these source bodies are relevant.
      const aliases = [...text.matchAll(/^id: (A\d+)$/gmu)].map(match => match[1]);
      const output = /^queryPlan:/mu.test(text)
        ? { selectedIds: aliases, unableToSelect: false, note: '' }
        : { needs: [{ id: 'n1', question: '待查事项', ruleQuery: '一般规则查询', qaQuery: 'QA查询' }] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 60, thoughtsTokenCount: 10, totalTokenCount: 570 } });
    },
  });
  const result = await provider.retrieve({ userQuery: '问题第一行\n问题第二行', dataRevision: 'd',
    env: { GEMINI_API_KEY: 'fixture' }, cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    retrievedEvidence: { cardTexts: [] } });
  assert.equal(generations.length, 2);
  assert.ok(counted.includes(generations[0]));
  assert.ok(counted.includes(generations[1]));
  assert.match(generations[0], /问题第一行\n\s*问题第二行/u);
  assert.match(generations[1], /原文第一段\n\s*第二行/u);
  assert.equal(generations[1].includes('bundleRevision'), false);
  assert.equal(generations[1].includes('$lines'), false);
  assert.ok(result.packing.allowedEvidenceIds.length > 0);
  assert.match(result.packing.prompt, /原文第一段\n\s*第二行/u);
  assert.equal(result.packing.promptChars, result.packing.prompt.length);
  assert.equal(record.text, '原文第一段\n第二行\n\n原文第二段');
});
