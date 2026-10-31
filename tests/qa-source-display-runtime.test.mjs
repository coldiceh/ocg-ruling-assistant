import test from 'node:test';
import assert from 'node:assert/strict';
import { applyQaSourceDisplay, qaSourceDisplayReleaseInfo } from '../backend/qaSourceDisplayRuntime.mjs';
import { bindQaSourceDisplay, QA_SOURCE_DISPLAY_SCHEMA } from '../backend/qaSourceDisplay.mjs';
import { previewQaSourceDisplay } from '../backend/qaSourceDisplayPreview.mjs';
import { packGeminiSelection } from '../backend/geminiRuleQaPacking.mjs';
import { selectedPromptEvidenceRefs } from '../backend/ragRulingPipeline.mjs';

function fixture(name = '資料内だけに登場するカード') {
  const source = { title: '「<<123>>」の質問', question: '「<<123>>」の効果を発動できますか？', answer: '発動できます。' };
  const title = source.question.normalize('NFKC');
  const record = { id: 'qa-fixture', recordType: 'qa', title,
    text: [source.question.normalize('NFKC'), title, source.answer].join(' ') };
  const entry = bindQaSourceDisplay(record, source);
  const mapping = { schema: QA_SOURCE_DISPLAY_SCHEMA, records: { [record.id]: entry } };
  const cards = [{ id: '123', jaName: name }];
  const { packing } = packGeminiSelection({ selection: { selectedRules: [], selectedQa: [{ handle: 'h', record }] },
    userQuery: 'fixture', cardResolution: { resolvedCards: [] } });
  const options = { env: { QA_SOURCE_DISPLAY_ENABLED: 'true' }, maxPromptChars: 14000,
    loadMapping: async () => ({ mapping, mappingSha256: 'a'.repeat(64) }), loadCardData: async () => ({ cards }) };
  return { packing, options, mapping, cards };
}

test('disabled display is byte-identical and performs no local loading', async () => {
  const { packing, options } = fixture();
  const unexpected = async () => { throw new Error('must not load'); };
  assert.equal(await applyQaSourceDisplay(packing, { ...options, env: {}, loadMapping: unexpected, loadCardData: unexpected }), packing);
  assert.equal(await applyQaSourceDisplay(packing, { ...options, env: { QA_SOURCE_DISPLAY_ENABLED: 'false' } }), packing);
});

test('runtime uses the complete card table and exactly the evaluated preview without changing canonical evidence', async () => {
  const { packing, options, mapping, cards } = fixture();
  const before = JSON.stringify(packing);
  const result = await applyQaSourceDisplay(packing, options);
  const preview = previewQaSourceDisplay(packing, { mapping, cards, maxPromptChars: 14000 });
  assert.equal(result.prompt, preview.candidatePrompt);
  assert.ok(result.prompt.includes(cards[0].jaName));
  assert.equal(result.modelEvidence, packing.modelEvidence);
  assert.equal(result.allowedEvidenceIds, packing.allowedEvidenceIds);
  assert.equal(JSON.stringify(packing), before);
  assert.equal(result.qaSourceDisplay.applied, true);
  const original = selectedPromptEvidenceRefs(packing.modelEvidence, packing.allowedEvidenceIds);
  const displayed = selectedPromptEvidenceRefs(result.modelEvidence, result.allowedEvidenceIds, result.qaSourceDisplayTitles);
  assert.equal(displayed[0].title, original[0].title);
  assert.equal(displayed[0].sourceHash, original[0].sourceHash);
  assert.equal(displayed[0].text, original[0].text);
  assert.equal(displayed[0].displayTitle, preview.candidatePayload.evidence.rawRelatedEvidence[0].title);
  assert.deepEqual(selectedPromptEvidenceRefs(result.modelEvidence, result.allowedEvidenceIds,
    [{ id: 'h', original: 'unrelated title', display: 'wrong alias' }]), original);
});

test('a larger candidate falls back to the whole legacy package at the unchanged limit', async () => {
  const { packing, options } = fixture('長い正式カード名'.repeat(100));
  const result = await applyQaSourceDisplay(packing, { ...options, maxPromptChars: packing.prompt.length });
  assert.equal(result.qaSourceDisplay.status, 'prompt_limit_exceeded');
  assert.equal(result.qaSourceDisplay.applied, false);
  assert.equal(result.prompt, packing.prompt);
  assert.equal(result.promptPayload, packing.promptPayload);
  assert.equal(result.modelEvidence, packing.modelEvidence);
  assert.equal(result.qaSourceDisplayTitles, undefined);
});

test('missing resources and stale record mappings preserve the legacy prompt', async () => {
  const { packing, options, mapping } = fixture();
  const missing = await applyQaSourceDisplay(packing, { ...options, loadMapping: async () => { throw new Error('missing'); } });
  assert.equal(missing.prompt, packing.prompt);
  assert.equal(missing.qaSourceDisplay.status, 'source_data_unavailable');
  mapping.records['qa-fixture'].originalRecordSha256 = '0'.repeat(64);
  const stale = await applyQaSourceDisplay(packing, options);
  assert.equal(stale.prompt, packing.prompt);
  assert.equal(stale.qaSourceDisplay.status, 'no_verified_structure');
});

test('release diagnostics expose only the flag and mapped-asset identity', async () => {
  assert.deepEqual(await qaSourceDisplayReleaseInfo({}), { enabled: false, schema: QA_SOURCE_DISPLAY_SCHEMA,
    mappingLoaded: false, recordCount: 0 });
  const info = await qaSourceDisplayReleaseInfo({ QA_SOURCE_DISPLAY_ENABLED: 'true' });
  assert.equal(info.mappingLoaded, true);
  assert.ok(info.recordCount >= 1);
  assert.match(info.mappingSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(info).sort(), ['enabled', 'mappingLoaded', 'mappingSha256', 'recordCount', 'schema'].sort());
});
