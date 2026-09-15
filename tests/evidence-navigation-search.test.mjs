import assert from 'node:assert/strict';
import test from 'node:test';

import { createNavigationSearch } from '../backend/evidenceNavigationSearch.mjs';

function navigationRecord(index, sourceKind) {
  return Object.freeze({
    unitKey: `unit-${String(index).padStart(3, '0')}`,
    sourceKind,
    titlePath: [`section ${index % 11}`],
    descriptionZh: index % 4 === 0 ? '伤害步骤 发动 无效' : `普通说明 ${index}`,
    descriptionJa: index % 7 === 0 ? 'ダメージステップ 発動 無効' : '',
    searchQuestions: [{ text: index % 3 === 0 ? '伤害步骤可以发动吗' : `问题 ${index}` }],
  });
}

test('bounded navigation queues preserve the exact legacy top candidates for each actual source kind', () => {
  const sourceKinds = ['rule', 'qa', 'faq'];
  const records = Object.freeze(Array.from({ length: 180 }, (_, index) => (
    navigationRecord(index, sourceKinds[index % sourceKinds.length])
  )));
  const actualKindByUnit = new Map(records.map((record, index) => [
    record.unitKey,
    sourceKinds[(index + (index % 10 === 0 ? 1 : 0)) % sourceKinds.length],
  ]));
  const search = createNavigationSearch(records);
  const query = '伤害步骤 发动 无效';
  const legacy = search.search(query);
  const expected = Object.fromEntries(sourceKinds.map((sourceKind) => [
    sourceKind,
    legacy.filter((hit) => actualKindByUnit.get(hit.unitKey) === sourceKind).slice(0, 32),
  ]));

  const bounded = search.searchBySourceKind(query, {
    sourceKinds,
    limit: 32,
    sourceKindForUnit: (unitKey) => actualKindByUnit.get(unitKey),
  });

  assert.deepEqual(bounded, expected);
  assert.ok(Object.values(bounded).every((hits) => hits.length === 32));
});
