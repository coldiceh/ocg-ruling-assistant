import test from 'node:test';
import assert from 'node:assert/strict';
import { packGeminiSelection } from '../backend/geminiRuleQaPacking.mjs';
import { previewQaSourceDisplay } from '../backend/qaSourceDisplayPreview.mjs';

function fixture() {
  const record = { id: 'synthetic-qa', recordType: 'qa', title: '旧标题',
    question: '旧标题', rawDetailedQuestion: '「<<123>>」是否适用？', answer: '适用。',
    text: '旧标题\n「<<123>>」是否适用？\n旧标题\n适用。',
    unknownField: { text: 'must remain unchanged <<123>>' } };
  const selection = { selectedRules: [], selectedQa: [{ handle: 'stable-handle', record }] };
  const input = { selection, userQuery: '合成测试问题', cardResolution: { resolvedCards: [] } };
  return { input, result: packGeminiSelection(input), record };
}

test('preview uses the same selected sources and leaves every live/rollback field unchanged', () => {
  const { result, input } = fixture();
  const before = JSON.stringify(result), selectionBefore = JSON.stringify(input.selection);
  const preview = previewQaSourceDisplay(result.packing, {
    cards: [{ id: '123', cnName: '测试卡' }], maxPromptChars: 15000,
  });
  assert.equal(preview.status, 'candidate_ready');
  assert.ok(preview.candidatePrompt.includes('「测试卡」是否适用？'));
  assert.ok(preview.candidatePrompt.includes('must remain unchanged <<123>>'));
  assert.deepEqual(preview.candidatePayload.allowedEvidenceIds, result.packing.allowedEvidenceIds);
  assert.equal(JSON.stringify(result), before);
  assert.equal(JSON.stringify(input.selection), selectionBefore);
  assert.equal(packGeminiSelection(input).packing.prompt, result.packing.prompt);
  assert.equal(preview.inputCostVerified, false);
  assert.equal(preview.usableForGeneration, false);
});

test('smaller characters never imply permission to use the candidate for generation', () => {
  const { result } = fixture();
  const preview = previewQaSourceDisplay(result.packing, { maxPromptChars: 1 });
  assert.equal(preview.charsDoNotIncrease, true);
  assert.equal(preview.withinConfiguredCharLimit, false);
  assert.equal(preview.usableForGeneration, false);
  assert.equal(preview.inputCostVerified, false);
});

test('unrecognized prompt layouts are preserved rather than heuristically rewritten', () => {
  const { result } = fixture();
  const packing = { ...result.packing, prompt: result.packing.prompt + '\nextra envelope' };
  const before = JSON.stringify(packing);
  const preview = previewQaSourceDisplay(packing);
  assert.equal(preview.status, 'unsupported_prompt_layout');
  assert.equal(Object.hasOwn(preview, 'candidatePrompt'), false);
  assert.equal(JSON.stringify(packing), before);
});
