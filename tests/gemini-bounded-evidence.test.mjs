import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGeminiBoundedEvidenceProvider, boundedSelectionBody } from '../backend/geminiBoundedEvidenceProvider.mjs';
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

test('long rule groups use one source reference per identical source and section metadata', async () => {
  const sharedSection = { sectionId: 'S1', title: 'Shared section', parentSectionId: null,
    ruleDocumentId: 'doc-1' };
  const shared = { recordType: 'rule-doc', title: 'Shared rule title', sourceUrl: 'https://example.test/rules',
    source: 'Shared rule source', sourceAuthority: 'official_reference', official: true,
    parentSourceId: 'doc-1', sourceSection: { sectionId: 'S1', title: 'Shared section',
      parentSectionId: null, titlePath: ['Rules', 'Shared section'] } };
  const units = Array.from({ length: 300 }, (_, index) => ({ ...shared, id: `R${index + 1}`,
    ruleUnitIndex: index, text: `完整规则正文 ${index + 1}。` }));
  const input = { question: 'fixture question', confirmedCards: [], cardTexts: [],
    userProvidedCardTexts: [], unresolvedMentions: [], ambiguousMentions: [] };
  const body = boundedSelectionBody(input, { informationNeeds: ['fixture need'], queries: ['fixture query'] },
    [{ groupId: 'S1', kind: 'rule', section: sharedSection, units }],
    { dataRevision: 'd', ruleRevision: 'r', qaRevision: 'q' });
  const serialized = JSON.stringify(body);
  assert.ok(serialized.length < 32000, `compact reading copy must fit: ${serialized.length}`);
  const payload = JSON.parse(body.contents[0].parts[1].text);
  assert.ok(payload.ruleSources && typeof payload.ruleSources === 'object');
  const compactGroup = payload.groups[0];
  assert.equal(compactGroup.units.length, units.length);
  assert.equal(new Set(compactGroup.units.map(unit => unit.sourceRef)).size, 1);
  const source = payload.ruleSources[compactGroup.units[0].sourceRef];
  const restored = compactGroup.units.map((unit) => ({ ...source,
    ...Object.fromEntries(Object.entries(unit).filter(([key]) => key !== 'sourceRef')) }));
  assert.deepEqual(restored, units);
  assert.deepEqual(compactGroup.section, sharedSection);
  assert.deepEqual(compactGroup.units.map(unit => unit.id), units.map(unit => unit.id));
  assert.deepEqual(compactGroup.units.map(unit => unit.ruleUnitIndex), units.map(unit => unit.ruleUnitIndex));
  assert.equal(createHash('sha256').update(JSON.stringify(restored)).digest('hex'),
    createHash('sha256').update(JSON.stringify(units)).digest('hex'));

  const canonicalText = units.map(unit => unit.text).join('\n\n');
  const ruleRecord = { id: 'doc-1', recordType: 'rule-doc', title: shared.title,
    sourceName: shared.source, sourceUrl: shared.sourceUrl, text: canonicalText,
    sourceAuthority: shared.sourceAuthority, official: shared.official,
    structure: { schemaVersion: 1,
      canonicalSha256: createHash('sha256').update(canonicalText).digest('hex'),
      sections: [{ id: 'shared', title: 'Shared section', start: 0, end: canonicalText.length }] } };
  const requests = [];
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => ({ dataRevision: 'd', qaRevision: 'q', rulesRecords: [ruleRecord],
      createQaTools: options => createQaTools({ records: [], qaRevision: 'q', ...options }) }),
    budgetedRequest: request => request.invoke(),
    fetchImpl: async (url, init) => {
      const requestBody = JSON.parse(init.body);
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 500 });
      requests.push(requestBody);
      const output = requests.length === 1
        ? { informationNeeds: ['fixture relation'], queries: ['fixture search'] }
        : { selectionNotes: 'fixture selection', ruleUnitIds: [], qaHandles: [] };
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 600 } });
    },
  });
  await provider.retrieve({ userQuery: input.question, dataRevision: 'd', env: { GEMINI_API_KEY: 'fixture' },
    cardResolution: { resolvedCards: [] }, retrievedEvidence: {} });
  const delivered = JSON.parse(requests[1].contents[0].parts[1].text);
  const deliveredRuleGroup = delivered.groups.find(group => group.kind === 'rule');
  assert.ok(deliveredRuleGroup, 'compact rule group must remain offered within the reading budget');
  assert.ok(delivered.ruleSources && Object.keys(delivered.ruleSources).length === 1);
});
