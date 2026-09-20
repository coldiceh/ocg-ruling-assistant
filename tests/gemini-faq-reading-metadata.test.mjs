import assert from 'node:assert/strict';
import test from 'node:test';

import { boundedSelectionBody } from '../backend/geminiBoundedEvidenceProvider.mjs';

function readPayload(body) {
  return JSON.parse(body.contents[0].parts[1].text);
}

test('bounded FAQ reading encoding shares source metadata without changing records', () => {
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
  const payload = readPayload(body);

  assert.ok(payload.qaSources && typeof payload.qaSources === 'object');
  const compactItems = payload.groups.flatMap((group) => group.items || []);
  const compactFaq = compactItems.filter((item) => item.record?.qaSourceRef);
  assert.equal(compactFaq.length, 2);
  assert.equal(new Set(compactFaq.map((item) => item.record.qaSourceRef)).size, 1);
  assert.equal(compactItems.find((item) => item.handle === ordinaryQa.handle).record.question, '问题');
  assert.deepEqual(compactItems.find((item) => item.handle === ordinaryQa.handle), originalOrdinary);

  const source = payload.qaSources[compactFaq[0].record.qaSourceRef];
  assert.ok(source && source.record && source.sourceExcerpt);
  assert.equal(Object.hasOwn(source.record, 'id'), false);
  assert.equal(Object.hasOwn(source.record, 'conclusion'), false);
  assert.equal(Object.hasOwn(source.sourceExcerpt, 'start'), false);
  assert.equal(Object.hasOwn(source.sourceExcerpt, 'end'), false);
  assert.equal(Object.hasOwn(source.sourceExcerpt, 'heading'), false);

  for (const compactItem of compactFaq) {
    const original = items.find((item) => item.handle === compactItem.handle);
    const compactRecord = { ...compactItem.record };
    delete compactRecord.qaSourceRef;
    const restored = {
      ...source.record,
      ...compactRecord,
      sourceExcerpt: { ...source.sourceExcerpt, ...compactRecord.sourceExcerpt },
    };
    assert.deepEqual(restored, original.record);
    assert.equal(restored[restored.sourceExcerpt.bodyField], original.record[original.record.sourceExcerpt.bodyField]);
    assert.equal(restored.sourceExcerpt.start, original.record.sourceExcerpt.start);
    assert.equal(restored.sourceExcerpt.end, original.record.sourceExcerpt.end);
    assert.deepEqual(restored.sourceExcerpt.heading, original.record.sourceExcerpt.heading);
    assert.equal(restored.sourceAuthority, original.record.sourceAuthority);
  }
  assert.deepEqual(records, originalRecords);
  assert.deepEqual(items, originalItems);
  assert.ok(JSON.stringify(payload).length < JSON.stringify({ ...input, queryPlan: { informationNeeds: ['读取元数据'], queries: ['FAQ'] },
    dataRevision: 'data-revision', ruleRevision: 'rule-revision', qaRevision: 'qa-revision-1', groups }).length);
});
