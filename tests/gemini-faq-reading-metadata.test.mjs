import { renderReadableData, readableQaItem } from '../backend/readableEvidenceText.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { boundedSelectionBody } from '../backend/geminiBoundedEvidenceProvider.mjs';

test('bounded FAQ reading preserves complete source fields without reconstruction tables', () => {
  const sharedRecord = {
    recordType: 'card-faq',
    title: '同一FAQ标题',
    cards: [{ id: 'card-1', name: '测试卡' }],
    cardIds: ['card-1'],
    status: 'published',
    sourceAuthority: 'official_database',
    sourceTier: 'S0_OFFICIAL_DB',
    official: true,
    sourceName: 'YGOResources',
    sourceUrl: 'https://example.test/faq/1',
    unknownRecordMetadata: { stable: true, label: '保留' },
  };
  const sharedExcerpt = {
    parentRecordId: 'parent-1',
    parentHandle: 'parent-handle-1',
    qaRevision: 'qa-revision-1',
    bodyField: 'conclusion',
    bodySha256: 'parent-body-hash',
    unknownExcerptMetadata: { stable: true },
  };
  const records = [
    {
      ...structuredClone(sharedRecord),
      id: 'parent-1-0-12',
      conclusion: '完整的第一段FAQ正文。',
      sourceExcerpt: { ...structuredClone(sharedExcerpt), start: 0, end: 12,
        heading: { text: '【定义】', start: 0, end: 6 } },
    },
    {
      ...structuredClone(sharedRecord),
      id: 'parent-1-12-25',
      conclusion: '完整的第二段FAQ正文，保留全部限定。',
      sourceExcerpt: { ...structuredClone(sharedExcerpt), start: 12, end: 25,
        heading: { text: '【定义】', start: 0, end: 6 }, unknownUnitExcerptPatch: 'keep' },
      unknownUnitMetadata: { segment: 2 },
    },
  ];
  const items = records.map((record, index) => ({ handle: `faq-handle-${index + 1}`, record,
    sourceAuthority: record.sourceAuthority, sourceTier: record.sourceTier, official: record.official }));
  const ordinaryQa = { handle: 'ordinary-qa', record: {
    id: 'qa-1', recordType: 'qa', title: '普通QA', question: '问题', answer: '完整回答', official: true,
  } };
  const input = { question: '读取测试问题', confirmedCards: [], cardTexts: [],
    userProvidedCardTexts: [], unresolvedMentions: [], ambiguousMentions: [] };
  const groups = [
    { groupId: 'qa:faq-1', kind: 'qa', items: [items[0]] },
    { groupId: 'qa:ordinary', kind: 'qa', items: [ordinaryQa] },
    { groupId: 'qa:faq-2', kind: 'qa', items: [items[1]] },
  ];
  const originalRecords = structuredClone(records);
  const originalItems = structuredClone(items);
  const originalOrdinary = structuredClone(ordinaryQa);
  const body = boundedSelectionBody(input, { informationNeeds: ['读取元数据'], queries: ['FAQ'] }, groups,
    { dataRevision: 'data-revision', ruleRevision: 'rule-revision', qaRevision: 'qa-revision-1' });
  const text = body.contents[0].parts[1].text;
  let position = 0;
  for (const item of [items[0], ordinaryQa, items[1]]) {
    const expected = renderReadableData(readableQaItem(item));
    const at = text.indexOf(expected, position);
    assert.ok(at >= position, 'complete field records and handles preserve their order');
    position = at + expected.length;
  }
  assert.equal(text.includes('qaSources:'), false);
  assert.equal(text.includes('qaSourceRef:'), false);
  assert.deepEqual(ordinaryQa, originalOrdinary);
  assert.deepEqual(records, originalRecords);
  assert.deepEqual(items, originalItems);

});
