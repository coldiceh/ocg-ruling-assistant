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
  assert.deepEqual(payload.ruleUnitFields, ['id', 'text', 'ruleUnitIndex', 'sourceRef']);
  const decoded = compactGroup.units.map(row => Object.fromEntries(payload.ruleUnitFields.map((key, index) => [key, row[index]])));
  assert.equal(new Set(decoded.map(unit => unit.sourceRef)).size, 1);
  const source = payload.ruleSources[decoded[0].sourceRef];
  const restored = decoded.map((unit) => ({ ...source,
    ...Object.fromEntries(Object.entries(unit).filter(([key]) => key !== 'sourceRef')) }));
  assert.deepEqual(restored, units);
  assert.deepEqual(compactGroup.section, sharedSection);
  assert.deepEqual(decoded.map(unit => unit.id), units.map(unit => unit.id));
  assert.deepEqual(decoded.map(unit => unit.ruleUnitIndex), units.map(unit => unit.ruleUnitIndex));
  // Restore the original JSON key order before the byte hash; tuple columns
  // change field order, while the deep equality above checks every field.
  const restoredOriginalKeyOrder = restored.map((unit, index) =>
    Object.fromEntries(Object.keys(units[index]).map(key => [key, unit[key]])));
  assert.equal(createHash('sha256').update(JSON.stringify(restoredOriginalKeyOrder)).digest('hex'),
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

test('a model-requested source section is read before a capacity-filling lexical group', async () => {
  const first = 'fixture search '.repeat(1500) + '\n\n';
  const second = 'Canonical requested paragraph.\n\nRequested qualification.';
  const text = first + second;
  const record = { ...rule, text, structure: { schemaVersion: 1,
    canonicalSha256: createHash('sha256').update(text).digest('hex'),
    sections: [
      { id: 'first', title: 'Lexical section', start: 0, end: first.length },
      { id: 'second', title: 'Requested section', start: first.length, end: text.length },
    ] } };
  const requests = [];
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => ({ ...assets, rulesRecords: [record],
      createQaTools: options => createQaTools({ records: [], qaRevision: 'q', ...options }) }),
    budgetedRequest: request => request.invoke(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 500 });
      requests.push(body);
      const output = requests.length === 1
        ? { informationNeeds: ['fixture relation'], queries: ['fixture search'], ruleSectionIds: ['S1.2'] }
        : { selectionNotes: '', ruleUnitIds: [], qaHandles: [] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 600 } });
    },
  });
  await provider.retrieve({ ...input, userQuery: 'fixture search', cardResolution: { resolvedCards: [] }, retrievedEvidence: {} });
  const delivered = JSON.parse(requests[1].contents[0].parts[1].text);
  assert.equal(delivered.groups[0].groupId, 'S1.2');
  assert.equal(delivered.groups[0].units.map(unit => unit[1]).join(''), second);
  assert.equal(requests.length, 2);
  const planned = JSON.parse(requests[0].contents[0].parts[1].text);
  assert.deepEqual(planned.ruleSections, [['S1.1', null, 'Lexical section', first.length], ['S1.2', null, 'Requested section', second.length]]);
});
