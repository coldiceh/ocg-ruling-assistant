import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildRuleContext } from '../backend/geminiRuleContext.mjs';
import { buildRuleStructureMapping } from '../backend/evidenceSourceStructure.mjs';

test('rule context computes each canonical document hash once and preserves locator bindings', t => {
  const records = [{ id: 'public-rule', recordType: 'rule-doc', title: '规则',
    text: '第一段。\n\n第二段。\n\n第三段。\n\n第四段。' }];
  const mapping = buildRuleStructureMapping(records);
  const expected = crypto.createHash('sha256').update(records[0].text).digest('hex');
  const original = crypto.Hash.prototype.update;
  let documentHashes = 0;
  t.mock.method(crypto.Hash.prototype, 'update', function (data, ...args) {
    if (data === records[0].text) documentHashes += 1;
    return original.call(this, data, ...args);
  });
  const rules = buildRuleContext(records, { structureMapping: mapping, ruleContentRevision: 'fixed' });
  assert.ok(rules.denseLocators.size > 1);
  for (const locator of rules.denseLocators.values()) {
    assert.equal(locator.sourceCanonicalSha256, expected);
    assert.equal(locator.sourceId, records[0].id);
  }
  assert.equal(documentHashes, 1);
});

test('reusing a document hash still rejects a mismatched canonical source', () => {
  const records = [{ id: 'public-rule', recordType: 'rule-doc', title: '规则', text: '原文。' }];
  const mapping = buildRuleStructureMapping(records);
  assert.throws(() => buildRuleContext([{ ...records[0], text: '另一个正文。' }], {
    structureMapping: mapping, ruleContentRevision: 'fixed',
  }), /gemini_rule_structure_mapping_source_binding_invalid/);
});
