import { renderReadableData, readableQaItem } from '../backend/readableEvidenceText.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedSelectionBody } from '../backend/geminiBoundedEvidenceProvider.mjs';

test('bounded QA reading displays every field directly, including source-owned marker objects', () => {
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
  const visible = body.contents[0].parts[1].text;
  let position = 0;
  for (const group of groups) for (const item of group.items) {
    const rendered = renderReadableData(readableQaItem(item));
    const at = visible.indexOf(rendered, position);
    assert.ok(at >= position, 'complete records and handles retain their order');
    position = at + rendered.length;
  }
  assert.equal(visible.includes('qaTextLines:'), false);
  assert.equal(visible.includes('qaSources:'), false);
  assert.ok(visible.includes('$lines:'), 'a source-owned field is never treated as an encoding instruction');
});
