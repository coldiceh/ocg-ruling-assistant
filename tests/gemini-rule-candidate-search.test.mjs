import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRuleCandidateSearch,
  readParentGroups,
} from '../backend/geminiRuleCandidateSearch.mjs';

function unit(id, text, sectionId, titlePath) {
  return {
    id,
    recordType: 'rule-doc',
    text,
    sourceSection: sectionId ? { sectionId, titlePath } : undefined,
  };
}

function fixtureRules() {
  const first = unit('R1', 'alpha timing text', 'S1', ['Timing', 'Activation']);
  const second = unit('R2', 'beta procedure text', 'S1', ['Timing', 'Activation']);
  const third = unit('R3', 'gamma exception text', 'S2', ['Exceptions']);
  const orphan = unit('R4', 'orphan source text', null, []);
  return {
    units: new Map([first, second, third, orphan].map((item) => [item.id, item])),
    sections: new Map([
      ['S1', { sectionId: 'S1', title: 'Activation', parentSectionId: null,
        ruleDocumentId: 'doc-1', ruleUnitIds: ['R1', 'R2'] }],
      ['S2', { sectionId: 'S2', title: 'Exceptions', parentSectionId: 'S0',
        ruleDocumentId: 'doc-1', ruleUnitIds: ['R3'] }],
    ]),
    unitSections: new Map([['R1', 'S1'], ['R2', 'S1'], ['R3', 'S2']]),
  };
}

test('search returns original units, keeps source text, and unions round-robin query queues', () => {
  const rules = fixtureRules();
  const searcher = createRuleCandidateSearch(rules);
  const oneQuery = searcher.search('alpha');
  const manyQueries = searcher.search(['alpha', 'gamma']);

  assert.equal(oneQuery.length, rules.units.size);
  assert.deepEqual(new Set(manyQueries.map((item) => item.id)), new Set([...rules.units.keys()]));
  assert.equal(manyQueries.length, new Set(manyQueries.map((item) => item.id)).size);
  for (const item of manyQueries) {
    assert.strictEqual(item, rules.units.get(item.id));
    assert.equal(item.text, rules.units.get(item.id).text);
  }
  assert.deepEqual(manyQueries.map((item) => item.id), searcher.search(['alpha', 'gamma']).map((item) => item.id));
});

test('parent groups expand only the canonical smallest section and preserve orphan identity', () => {
  const rules = fixtureRules();
  const searcher = createRuleCandidateSearch(rules);
  const selected = [rules.units.get('R2'), rules.units.get('R3'), rules.units.get('R4'), rules.units.get('R1')];
  const groups = searcher.readParentGroups(selected);

  assert.deepEqual(groups.map((group) => group.groupId), ['S1', 'S2', 'R4']);
  assert.deepEqual(groups[0].units.map((item) => item.id), ['R1', 'R2']);
  assert.deepEqual(groups[1].section, {
    sectionId: 'S2', title: 'Exceptions', parentSectionId: 'S0', ruleDocumentId: 'doc-1',
  });
  assert.strictEqual(groups[2].section, null);
  assert.strictEqual(groups[2].units[0], rules.units.get('R4'));
  assert.deepEqual(readParentGroups(rules, [rules.units.get('R1')])[0].units.map((item) => item.id), ['R1', 'R2']);
});

