import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedPlanBody, boundedSelectionBody } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { packGeminiSelection, computeGeminiSelectionPackingBudget } from '../backend/geminiRuleQaPacking.mjs';
import { buildNavigationRequestBody } from '../scripts/prepare-evidence-navigation.mjs';

const record = {
  id: 'source-one', recordType: 'qa', title: '公开资料',
  question: '第一行\n第二行', answer: '回答："原文"\n\n末段',
  extra: { ja: '日本語の原文', literalPath: String.raw`C:\tierra\qliphoth.exe` },
  sourceUrl: 'https://example.test/source', official: true, updatedAt: '2026-09-20',
};
const item = { handle: 'Q1', binding: 'server-only-hash', unitKey: 'internal-unit',
  text: JSON.stringify(record), record };
const input = { question: '第一问\n第二问', confirmedCards: [], cardTexts: [] };
const selection = { selectedRules: [], selectedQa: [item] };
const common = { selection, userQuery: input.question, cardResolution: { resolvedCards: [] } };
const visible = request => request.contents.flatMap(x => x.parts).map(p => p.text || '').join('\n');

test('planning renders actual line breaks instead of JSON string escapes', () => {
  const text = visible(boundedPlanBody(input));
  assert.equal(text.includes(String.raw`第一问\n第二问`), false);
  assert.match(text, /第一问\n\s*第二问/u);
});

test('selection reads fields directly and keeps server bookkeeping out of the model text', () => {
  const before = JSON.stringify(item);
  const text = visible(boundedSelectionBody(input, { needs: [] },
    [{ kind: 'qa', items: [item] }], { bundleRevision: 'server-only-revision' }));
  assert.equal(text.includes(String.raw`第一行\n第二行`), false);
  assert.equal(text.includes('server-only-hash'), false);
  assert.equal(text.includes('server-only-revision'), false);
  assert.equal(text.includes('$lines'), false);
  assert.match(text, /第一行\n\s*第二行/u);
  assert.ok(text.includes('回答："原文"'));
  assert.ok(text.includes(record.extra.literalPath));
  assert.equal(JSON.stringify(item), before);
});

test('final pack displays the complete QA record as fields, without rewriting the canonical record', () => {
  const result = packGeminiSelection({ ...common, maxPromptChars: 1000000 });
  const text = result.packing.prompt;
  assert.equal(text.includes(String.raw`第一行\n第二行`), false);
  assert.equal(text.includes('$lines'), false);
  assert.match(text, /第一行\n\s*第二行/u);
  assert.ok(text.includes(record.extra.literalPath));
  assert.ok(text.includes(record.extra.ja));
  assert.ok(text.includes(record.sourceUrl));
  assert.equal(result.packing.modelEvidence.rawRelatedEvidence[0].text, JSON.stringify(record));
  assert.deepEqual(result.packing.allowedEvidenceIds, ['Q1']);
  assert.equal(result.packing.promptChars, text.length);
});

test('synchronization navigation uses readable fields for the adapter-owned canonical QA JSON', () => {
  const request = buildNavigationRequestBody({ input: {
    sourceKind: 'qa', unitText: JSON.stringify(record), referenceCards: [],
  } }, { maxBillableOutputTokens: 200, reasoningConfig: {}, responseFormatConfig: {} });
  const text = visible(request);
  assert.equal(text.includes(String.raw`第一行\n第二行`), false);
  assert.match(text, /第一行\n\s*第二行/u);
  assert.ok(text.includes(record.extra.literalPath));
});

test('readable pack counts the actual rendered size, and preserves whole records on overflow', () => {
  const full = packGeminiSelection({ ...common, maxPromptChars: 1000000 });
  const small = packGeminiSelection({ ...common, maxPromptChars: 1 });
  assert.equal(small.packing.capacityExceeded, true);
  assert.equal(small.packing.modelEvidence.rawRelatedEvidence[0].text, JSON.stringify(record));
  const costs = computeGeminiSelectionPackingBudget({ ...common, qaItems: [item], maxPromptChars: 1000000 });
  assert.ok(costs.basePromptChars + costs.qaHandleChars.Q1 >= full.packing.promptChars);
});
