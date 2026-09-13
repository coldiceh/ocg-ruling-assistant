import test from 'node:test';
import assert from 'node:assert/strict';

import { packGeminiSelection } from '../backend/geminiRuleQaPacking.mjs';

test('selected QA source metadata preserves explicit URLs, synced details, and card FAQ CID links', () => {
  const records = [{
    id: 'faq-explicit',
    recordType: 'card-faq',
    sourceUrl: 'https://example.test/explicit',
    sources: [{ detail: 'https://example.test/detail' }],
    cardIds: ['12344'],
  }, {
    id: 'faq-detail',
    recordType: 'card-faq',
    sources: [{ label: 'YGOResources Card FAQ', detail: 'https://db.ygoresources.com/data/card/12345' }],
    cardIds: ['12345'],
  }, {
    id: 'card-faq-12345-1',
    recordType: 'card-faq',
    title: 'fixture FAQ',
    cardIds: ['12345'],
    sourceAuthority: 'official_database',
    official: true,
  }];

  const { packing } = packGeminiSelection({
    selection: { selectedRules: [], selectedQa: records.map((record, index) => ({ handle: `faq-${index}`, record })) },
    userQuery: 'fixture question',
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
  });
  const packed = packing.modelEvidence.rawRelatedEvidence;

  assert.deepEqual(packed.map((item) => item.sourceUrl), [
    'https://example.test/explicit',
    'https://db.ygoresources.com/data/card/12345',
    'https://db.ygoresources.com/data/card/12345',
  ]);
  assert.equal(packed[2].sourceAuthority, 'official_database');
  assert.equal(packed[2].official, true);
  assert.equal(packed[2].text, JSON.stringify(records[2]));
});
