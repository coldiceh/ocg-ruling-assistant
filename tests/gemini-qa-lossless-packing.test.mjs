import test from 'node:test';
import assert from 'node:assert/strict';
import { packGeminiSelection } from '../backend/geminiRuleQaPacking.mjs';

const marker = '本次用户问题、卡片原文与检索资料如下：\n';
const payload = prompt => JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
function decode(value, lines) {
  if (value && !Array.isArray(value) && typeof value === 'object'
      && Object.keys(value).length === 1 && Array.isArray(value.$lines)) {
    return value.$lines.map(part => typeof part === 'number' ? lines[part] : part).join('\n');
  }
  if (Array.isArray(value)) return value.map(item => decode(item, lines));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, lines)]));
  return value;
}
function fixture() {
  const question = 'Original quoted question with a newline, whitespace and punctuation. '.repeat(14) + '\r\n';
  const answer = '\n' + 'Original answer: different capitalization, symbols, and Unicode 原文。'.repeat(14) + '\n\n';
  return {
    userQuery: 'Synthetic question only', cardResolution: { resolvedCards: [] },
    selection: { selectedRules: [], selectedQa: [{ handle: 'canonical-handle', record: {
      id: 'source-id', recordType: 'qa', title: question, question, rawQuestion: question,
      rawDetailedQuestion: question + '\nDistinct complete scenario.', answer,
      text: question + '\n' + answer, fullText: question + '\nDifferent field must also survive.',
      sourceUrl: 'https://example.test/source', sourceAuthority: 'official_database', official: true,
      questionLocales: { ja: { title: question, question }, en: { question: question + 'different' } },
    } }] },
  };
}

test('an overflowing QA pack fits by lossless encoding and restores every source field exactly', () => {
  const input = fixture();
  const originalRecord = structuredClone(input.selection.selectedQa[0].record);
  const uncompressed = packGeminiSelection({ ...input, maxPromptChars: 100000 });
  const limit = uncompressed.packing.promptChars - 1500;
  const encoded = packGeminiSelection({ ...input, maxPromptChars: limit });
  assert.equal(encoded.packing.capacityExceeded, false);
  assert.ok(encoded.packing.promptChars <= limit);
  const visible = payload(encoded.packing.prompt);
  assert.ok(visible.qaTextLines.length);
  const item = decode(visible.evidence.rawRelatedEvidence[0], visible.qaTextLines);
  assert.equal(JSON.stringify(item.sourceRecord), JSON.stringify(originalRecord));
  assert.equal(encoded.packing.modelEvidence.rawRelatedEvidence[0].text, JSON.stringify(originalRecord));
  assert.deepEqual(input.selection.selectedQa[0].record, originalRecord);
  assert.equal(item.id, 'canonical-handle');
  assert.equal(item.sourceAuthority, 'official_database');
  assert.equal(item.official, true);
  assert.deepEqual(encoded.packing.allowedEvidenceIds, uncompressed.packing.allowedEvidenceIds);
});

test('an overflowing card FAQ pack uses the same lossless encoding without changing source records', () => {
  const input = fixture();
  const repeated = '完整 FAQ 原文、来源身份与限定条件。'.repeat(28);
  input.selection.selectedQa = ['first', 'second'].map((suffix, index) => ({ handle: `faq-${suffix}`, record: {
    id: `card-faq-7-0-${index + 1}`, recordType: 'card-faq', title: repeated,
    cards: ['测试卡'], cardIds: ['7'], status: 'confirmed', updatedAt: '2026-09-15',
    conclusion: `${repeated}\n${repeated}`, sourceUrl: 'https://example.test/card/7',
    sourceAuthority: 'official_database', sourceTier: 'S0_OFFICIAL_DB', official: true,
    sources: [{ label: 'FAQ source', detail: 'https://example.test/card/7' }],
  } }));
  const originals = structuredClone(input.selection.selectedQa.map(item => item.record));
  const uncompressed = packGeminiSelection({ ...input, maxPromptChars: 100000 });
  const encoded = packGeminiSelection({ ...input, maxPromptChars: uncompressed.packing.promptChars - 1500 });
  assert.equal(encoded.packing.capacityExceeded, false);
  const visible = payload(encoded.packing.prompt);
  assert.ok(visible.qaTextLines.length);
  const restored = visible.evidence.rawRelatedEvidence.map(item => decode(item, visible.qaTextLines));
  assert.deepEqual(restored.map(item => item.id), ['faq-first', 'faq-second']);
  assert.deepEqual(restored.map(item => item.sourceAuthority), ['official_database', 'official_database']);
  assert.deepEqual(restored.map(item => item.official), [true, true]);
  assert.deepEqual(restored.map(item => JSON.stringify(item.sourceRecord)), originals.map(JSON.stringify));
  assert.deepEqual(encoded.packing.modelEvidence.rawRelatedEvidence.map(item => item.text), originals.map(JSON.stringify));
  assert.deepEqual(input.selection.selectedQa.map(item => item.record), originals);
});

test('an already fitting prompt keeps its exact previous representation', () => {
  const input = fixture();
  const first = packGeminiSelection({ ...input, maxPromptChars: 100000 });
  const exactLimit = packGeminiSelection({ ...input, maxPromptChars: first.packing.promptChars });
  assert.equal(exactLimit.packing.prompt, first.packing.prompt);
  assert.equal(Object.hasOwn(payload(exactLimit.packing.prompt), 'qaTextLines'), false);
});

test('a source record containing the display marker remains an untouched canonical string', () => {
  const input = fixture();
  input.selection.selectedQa[0].record.originalObject = { $lines: [0, 'literal original field'] };
  const result = packGeminiSelection({ ...input, maxPromptChars: 100 });
  const item = payload(result.packing.prompt).evidence.rawRelatedEvidence[0];
  assert.equal(item.text, JSON.stringify(input.selection.selectedQa[0].record));
  assert.equal(result.packing.capacityExceeded, true);
});

test('overflow shares exact rule section metadata without removing any source field or body', () => {
  const selectedRules = Array.from({ length: 18 }, (_, index) => ({
    id: `rule-${index}`, atomKey: `rule-${index}`, recordType: 'rule-doc',
    title: 'Synthetic rule source', sourceUrl: 'https://example.test/rules',
    source: 'Test publisher', sourceAuthority: 'official_reference', official: true,
    parentSourceId: 'source-one', sourceId: 'source-one', sourceSectionKey: 'section-one',
    sourceSection: { sectionKey: 'section-one', title: 'Exact section heading '.repeat(6),
      titlePath: ['Original parent heading', 'Exact section heading '.repeat(6)] },
    sourceStart: index * 50, sourceEnd: index * 50 + 49,
    text: `Unique original body ${index}: \"quoted\" 原文。\n\n`,
  }));
  const input = { userQuery: 'Synthetic metadata preservation question',
    cardResolution: { resolvedCards: [] }, selection: { selectedRules, selectedQa: [] } };
  const initial = packGeminiSelection({ ...input, maxPromptChars: 100000 });
  const limit = initial.packing.promptChars - 1200;
  const packed = packGeminiSelection({ ...input, maxPromptChars: limit });
  assert.equal(packed.packing.capacityExceeded, false);
  const visible = payload(packed.packing.prompt);
  const restored = visible.evidence.rawRelatedEvidence.map(({ sourceRef, ...item }) => ({
    ...visible.ruleSources[sourceRef], ...item,
  }));
  assert.deepEqual(restored, selectedRules);
  assert.deepEqual(packed.packing.modelEvidence.rawRelatedEvidence, selectedRules);
  assert.deepEqual(packed.packing.allowedEvidenceIds, initial.packing.allowedEvidenceIds);
  assert.equal(packGeminiSelection({ ...input, maxPromptChars: initial.packing.promptChars }).packing.prompt,
    initial.packing.prompt);
});
