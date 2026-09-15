import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedSelectionBody } from '../backend/geminiBoundedEvidenceProvider.mjs';

function payload(body) {
  return JSON.parse(body.contents[0].parts[1].text);
}

function decode(value, lines) {
  if (value && !Array.isArray(value) && typeof value === 'object'
      && Object.keys(value).length === 1 && Array.isArray(value.$lines)) {
    return value.$lines.map(part => typeof part === 'number' ? lines[part] : part).join('\n');
  }
  if (Array.isArray(value)) return value.map(item => decode(item, lines));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, decode(item, lines)]));
  return value;
}

test('bounded QA reading body losslessly encodes repeated normal and FAQ source records', () => {
  const repeated = '相同的日文原文、来源与条件。'.repeat(32);
  const normal = { id: 'normal-1', recordType: 'qa', title: repeated, question: repeated,
    rawQuestion: repeated, rawDetailedQuestion: `${repeated}\n${repeated}`, answer: repeated,
    text: `${repeated}\n${repeated}`, sourceAuthority: 'official_database', sourceTier: 'S0_OFFICIAL_DB', official: true };
  const reserved = { id: 'reserved-1', recordType: 'qa', title: { $lines: ['source-owned value'] },
    question: repeated, sourceAuthority: 'official_database', sourceTier: 'S0_OFFICIAL_DB', official: true };
  const sharedRecord = { recordType: 'card-faq', title: repeated, cards: ['测试卡'], cardIds: ['7'],
    status: 'confirmed', sourceAuthority: 'official_database', sourceTier: 'S0_OFFICIAL_DB', official: true,
    sources: [{ label: repeated, detail: 'https://example.test/card/7' }] };
  const sharedExcerpt = { parentRecordId: 'faq-parent', parentHandle: 'faq-parent-handle', qaRevision: 'q',
    bodyField: 'conclusion', bodySha256: 'h'.repeat(64) };
  const faqRecords = [0, 1].map(index => ({ ...structuredClone(sharedRecord), id: `faq-parent-${index}`,
    conclusion: `${repeated}\n片段${index}`, sourceExcerpt: { ...structuredClone(sharedExcerpt), start: index * 10,
      end: index * 10 + 9, heading: { text: repeated, start: 0, end: 9 } } }));
  const groups = [
    { groupId: 'normal', kind: 'qa', items: [{ handle: 'Q1', record: normal }] },
    { groupId: 'reserved', kind: 'qa', items: [{ handle: 'QR', record: reserved }] },
    ...faqRecords.map((record, index) => ({ groupId: `faq-${index}`, kind: 'qa', items: [{ handle: `QF${index}`, record }] })),
  ];
  const body = boundedSelectionBody({ question: repeated, confirmedCards: [], cardTexts: [],
    userProvidedCardTexts: [], unresolvedMentions: [], ambiguousMentions: [] }, { needs: [] }, groups,
  { dataRevision: 'd', ruleRevision: 'r', qaRevision: 'q' });
  const visible = payload(body);
  assert.ok(visible.qaTextLines?.length);
  assert.ok(visible.qaSources && Object.keys(visible.qaSources).length === 1);
  const restoredItems = visible.groups.flatMap(group => group.items || []).map(item => ({ ...item, record: decode(item.record, visible.qaTextLines) }));
  assert.deepEqual(restoredItems.map(item => item.handle), ['Q1', 'QR', 'QF0', 'QF1']);
  assert.equal(JSON.stringify(restoredItems[0].record), JSON.stringify(normal));
  assert.equal(JSON.stringify(visible.groups[1].items[0].record), JSON.stringify(reserved));
  const decodedSource = decode(visible.qaSources[restoredItems[2].record.qaSourceRef], visible.qaTextLines);
  for (const [index, item] of restoredItems.slice(2).entries()) {
    const record = { ...decodedSource.record, ...item.record,
      sourceExcerpt: { ...decodedSource.sourceExcerpt, ...item.record.sourceExcerpt } };
    delete record.qaSourceRef;
    assert.equal(JSON.stringify(record), JSON.stringify(faqRecords[index]));
    assert.equal(record.sourceAuthority, 'official_database');
    assert.equal(record.recordType, 'card-faq');
  }
});
