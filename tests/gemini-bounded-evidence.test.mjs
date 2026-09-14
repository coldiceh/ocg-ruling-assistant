import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGeminiBoundedEvidenceProvider, boundedSelectionBody, boundedPlanBody } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { buildRuleContext } from '../backend/geminiRuleContext.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';

const rule = { id: 'rule', recordType: 'rule-doc', title: 'fixture source', text: 'paragraph one\n\nparagraph two',
  sourceAuthority: 'official_reference', official: true };
const qa = { id: 'qa', recordType: 'qa', title: 'fixture QA', question: 'fixture question', answer: 'complete fixture answer', official: true };
const assets = { dataRevision: 'd', qaRevision: 'q', rulesRecords: [rule],
  createQaTools: options => createQaTools({ records: [qa], qaRevision: 'q', ...options }) };

test('planning reads original retrieved paragraphs with canonical identities and source flags', () => {
  const rules = buildRuleContext([rule]);
  const unit = [...rules.units.values()][1];
  const body = boundedPlanBody({question:'fixture'}, rules, [unit]);
  const payload = JSON.parse(body.contents[0].parts[1].text);
  assert.deepEqual(payload.ruleHits, [[unit.id, rules.unitSections.get(unit.id) ?? null, unit.text, unit.sourceAuthority, unit.official]]);
});

function createFixtureProvider(options) {
  return createGeminiBoundedEvidenceProvider({ ...options,
    loadDenseSearch: options.loadDenseSearch || (async ({rules}) => ({search: () => [...rules.units.values()]})),
    fetchImpl: async (url, init) => url.endsWith(':embedContent')
      ? Response.json({embedding:{values:Array(768).fill(1)},usageMetadata:{promptTokenCount:100}})
      : options.fetchImpl(url, init),
  });
}

function fixture({ unknown = false, excessive = false } = {}) {
  const requests = [];
  const provider = createFixtureProvider({ loadAssets: async () => assets,
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

test('a paragraph read during navigation remains offered when an expanded section fills reading capacity', async () => {
  const first = `${'fixture search '.repeat(1800)}\n\n`;
  const second = `${'canonical navigation text '.repeat(230)}\n\n`;
  const text = first + second;
  const record = {...rule, text, structure:{schemaVersion:1,
    canonicalSha256:createHash('sha256').update(text).digest('hex'),
    sections:[{id:'large',title:'Large section',start:0,end:first.length},
      {id:'small',title:'Navigation section',start:first.length,end:text.length}]}};
  const requests=[];
  const provider=createFixtureProvider({loadAssets:async()=>({...assets,rulesRecords:[record]}),
    loadDenseSearch:async({rules})=>({search:()=>[...rules.units.values()].reverse()}),
    budgetedRequest:request=>request.invoke(),fetchImpl:async(url,init)=>{
      const body=JSON.parse(init.body);
      if(url.endsWith(':countTokens'))return Response.json({totalTokens:500});
      requests.push(body);
      const output=requests.length===1?{informationNeeds:[],queries:['fixture search'],ruleSectionIds:['S1.1']}
        :{ruleUnitIds:[],qaHandles:[]};
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(output)}]}}],
        usageMetadata:{promptTokenCount:500,candidatesTokenCount:80,thoughtsTokenCount:20,totalTokenCount:600}});
    }});
  await provider.retrieve({...input,retrievedEvidence:{},cardResolution:{resolvedCards:[]}});
  const planning=JSON.parse(requests[0].contents[0].parts[1].text);
  const selection=JSON.parse(requests[1].contents[0].parts[1].text);
  assert.deepEqual(planning.ruleHits, [], 'planning must use the rule directory without replaying navigation paragraphs');
  assert.ok(selection.groups.flatMap(group=>group.units||[]).some(row=>row[0]==='R1.2'&&row[1]===second));
});

test('FAQ source units are independently budgeted while each canonical excerpt stays complete', async () => {
  const faq = { id: 'faq-parent', recordType: 'card-faq', title: 'fixture FAQ', cards: [], cardIds: [],
    conclusion: `${'L'.repeat(15000)}\n\n${'R'.repeat(15000)}`, official: true };
  const requests = [];
  const provider = createFixtureProvider({
    loadAssets: async () => ({ dataRevision: 'd', qaRevision: 'q', rulesRecords: [rule],
      createQaTools: options => createQaTools({ records: [faq], qaRevision: 'q', ...options }) }),
    loadDenseSearch: async () => ({ search: () => [] }),
    budgetedRequest: request => request.invoke(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 500 });
      requests.push(body);
      const output = requests.length === 1
        ? { informationNeeds: ['fixture relation'], queries: ['qa-only'] }
        : { selectionNotes: '', ruleUnitIds: [], qaHandles: [] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 600 } });
    },
  });
  await provider.retrieve({ ...input, userQuery: 'qa-only', cardResolution: { resolvedCards: [] }, retrievedEvidence: {} });
  const selected = JSON.parse(requests[1].contents[0].parts[1].text);
  const qaItems = selected.groups.flatMap(group => group.items || []);
  assert.ok(qaItems.length >= 1, 'at least one complete FAQ source unit must enter the reading set');
  assert.ok(qaItems.every(item => item.record.sourceExcerpt && item.record.conclusion.length > 0));
  assert.equal(new Set(qaItems.map(item => item.handle)).size, qaItems.length);
});

test('FAQ units rotate across parent records before taking a second unit from one parent', async () => {
  const faqRecords = ['A', 'B'].map(letter => ({ id: `faq-${letter}`, recordType: 'card-faq',
    title: `qa-only ${letter}`, cards: [], cardIds: [],
    conclusion: `qa-only ${letter}1\n\nqa-only ${letter}2\n\nqa-only ${letter}3`, official: true }));
  const requests = [];
  const provider = createFixtureProvider({
    loadAssets: async () => ({ dataRevision: 'd', qaRevision: 'q', rulesRecords: [rule],
      createQaTools: options => createQaTools({ records: faqRecords, qaRevision: 'q', ...options }) }),
    loadDenseSearch: async () => ({ search: () => [] }),
    budgetedRequest: request => request.invoke(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 500 });
      requests.push(body);
      const output = requests.length === 1
        ? { informationNeeds: ['fixture relation'], queries: ['qa-only'] }
        : { selectionNotes: '', ruleUnitIds: [], qaHandles: [] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 600 } });
    },
  });
  await provider.retrieve({ ...input, userQuery: 'qa-only', cardResolution: { resolvedCards: [] }, retrievedEvidence: {} });
  const selected = JSON.parse(requests[1].contents[0].parts[1].text);
  const qaItems = selected.groups.flatMap(group => group.items || []);
  const parents = qaItems.map(item => item.record.sourceExcerpt?.parentHandle || item.handle);
  assert.equal(parents.length, 6);
  assert.notEqual(parents[0], parents[1]);
  assert.deepEqual(parents, [parents[0], parents[1], parents[0], parents[1], parents[0], parents[1]]);
  assert.ok(selected.groups.filter(group => group.kind === 'qa').every(group => group.items.length === 1));
});

test('navigation and QA groups are interleaved before budget admission', async () => {
  const first = 'navigation paragraph.';
  const second = 'requested paragraph.';
  const text = `${first}\n\n${second}`;
  const record = { ...rule, text, structure: { schemaVersion: 1,
    canonicalSha256: createHash('sha256').update(text).digest('hex'),
    sections: [{ id: 'nav', title: 'Navigation', start: 0, end: first.length + 2 },
      { id: 'requested', title: 'Requested', start: first.length + 2, end: text.length }] } };
  const qaRecords = [1, 2].map(index => ({ id: `qa-${index}`, recordType: 'qa', title: `QA ${index}`,
    question: `question ${index}`, answer: `answer ${index}`, official: true }));
  const requests = [];
  const provider = createFixtureProvider({
    loadAssets: async () => ({ dataRevision: 'd', qaRevision: 'q', rulesRecords: [record],
      createQaTools: options => createQaTools({ records: qaRecords, qaRevision: 'q', ...options }) }),
    loadDenseSearch: async ({ rules }) => ({ search: () => [[...rules.units.values()][0]] }),
    budgetedRequest: request => request.invoke(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(':countTokens')) return Response.json({ totalTokens: 500 });
      requests.push(body);
      const output = requests.length === 1
        ? { informationNeeds: ['fixture relation'], queries: ['qa-only'], ruleSectionIds: ['S1.2'] }
        : { selectionNotes: '', ruleUnitIds: [], qaHandles: [] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 600 } });
    },
  });
  await provider.retrieve({ ...input, userQuery: 'qa-only', cardResolution: { resolvedCards: [] }, retrievedEvidence: {} });
  const selected = JSON.parse(requests[1].contents[0].parts[1].text);
  assert.deepEqual(selected.groups.slice(0, 4).map(group => group.kind), ['qa', 'rule', 'qa', 'rule']);
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
  const provider = createFixtureProvider({
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

test('a requested section retains every original paragraph when navigation already supplied it', async () => {
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
  const provider = createFixtureProvider({
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
  const deliveredUnits = delivered.groups.flatMap(group => group.units || []);
  const requestedUnits = deliveredUnits.filter(unit => delivered.ruleSources[unit[3]].sourceSection?.sectionId === 'S1.2');
  assert.equal(requestedUnits.map(unit => unit[1]).join(''), second);
  assert.equal(new Set(deliveredUnits.map(unit => unit[0])).size, deliveredUnits.length);
  assert.equal(requests.length, 2);
  const planned = JSON.parse(requests[0].contents[0].parts[1].text);
  assert.deepEqual(planned.ruleSections, [['S1.1', null, 'Lexical section', first.length], ['S1.2', null, 'Requested section', second.length]]);
});
