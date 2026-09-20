import test from 'node:test';
import assert from 'node:assert/strict';
import { admitWholeReadingUnits, mapRankedUnits } from '../backend/evidenceReadingScheduler.mjs';

const lane = (needId, queryVariantId, sourceKind, channel, keys) => ({ needId, queryVariantId, sourceKind, channel,
  hits: keys.map((unitKey, sourceRank) => ({ unitKey, sourceRank, mappingOrdinal: 0 })) });
const materialize = (unitKey) => ({ unitKey, sourceKind: 'rule', entries: [{ id: unitKey, chars: 1 }] });
const measure = bundles => bundles.flatMap(bundle => bundle.entries).reduce((sum, entry) => sum + entry.chars, 0);

test('one admission per need and language/source/channel cursors survive rounds', () => {
  const result = admitWholeReadingUnits({ materialize, measure, maxChars: 6, lanes: [
    lane('original','original','rule','dense',['o1','o2']),
    lane('n1','n1.zh','qa','lexical',['z1','z2']),
    lane('n1','n1.ja','rule','dense',['j1','j2']),
  ] });
  assert.deepEqual(result.offered.map(bundle => bundle.unitKey), ['o1','z1','o2','j1','z2','j2']);
});

test('oversized whole bundle does not block later candidates; shared context counts once', () => {
  const bundles = {
    long: { unitKey: 'long', entries: [{id:'long',chars:100},{id:'context',chars:2}] },
    first: { unitKey: 'first', entries: [{id:'first',chars:2},{id:'context',chars:2}] },
    second: { unitKey: 'second', entries: [{id:'second',chars:2},{id:'context',chars:2}] },
  };
  const args = { lanes: [lane('original','original','rule','dense',['long','first','second'])],
    materialize: key => bundles[key], measure };
  const result = admitWholeReadingUnits({ ...args, maxChars: 6 });
  assert.deepEqual(result.offeredIds, ['first','context','second']);
  assert.deepEqual(result.omitted.map(row => row.unitKey), ['long']);
  const resized = admitWholeReadingUnits({ ...args, maxChars: 4 });
  assert.deepEqual(resized.offeredIds, ['first','context']);
  assert.equal(resized.visits, 3);
});

test('all explicit links alternate with original hits and expand only one hop', () => {
  const refs = {
    a: [{refKey:'r1',linkOrdinal:0,targetReadingUnitKeys:['x','y']}, {refKey:'r2',linkOrdinal:1,targetReadingUnitKeys:['z']}],
    x: [{refKey:'nested',linkOrdinal:0,targetReadingUnitKeys:['forbidden-second-hop']}],
  };
  const result = admitWholeReadingUnits({ materialize, measure, maxChars: 100,
    lanes: [lane('original','original','rule','dense',['a','b'])], getReferences: key => refs[key] || [] });
  assert.deepEqual(result.offered.map(bundle => bundle.unitKey), ['a','x','b','y','z']);
});

test('duplicate identities merge hits and do not consume successful admission turns', () => {
  const result = admitWholeReadingUnits({ materialize, measure, maxChars: 4, lanes: [
    lane('original','original','rule','dense',['a','b']),
    lane('n1','n1.zh','rule','lexical',['a','c']),
  ] });
  assert.deepEqual(result.offered.map(bundle => bundle.unitKey), ['a','c','b']);
  assert.equal(result.offered[0].hits.length, 2);
});

test('dense mapping expands beyond old top k and keeps one-to-many ordered positions', () => {
  const rows = Array.from({length:40},(_,index) => index);
  const mapped = mapRankedUnits(rows, row => row < 35 ? ['same'] : [`u${row}`,`v${row}`], 5);
  assert.deepEqual(mapped.map(hit => hit.unitKey), ['same','u35','u36','u37','u38']);
  const spread = mapRankedUnits([0,1], row => row ? ['b1','b2'] : ['a1','a2'], 4);
  assert.deepEqual(spread.map(hit => hit.unitKey), ['a1','b1','a2','b2']);
});

test('a duplicate does not spend the inner source/channel reading turn', () => {
  const result = admitWholeReadingUnits({ materialize, measure, maxChars: 3, lanes: [
    lane('original', 'original', 'rule', 'dense', ['shared', 'next-original']),
    lane('planned', 'planned.zh', 'rule', 'dense', ['shared', 'next-rule']),
    lane('planned', 'planned.zh', 'qa', 'dense', ['qa-first']),
  ] });
  assert.deepEqual(result.offered.map(bundle => bundle.unitKey), ['shared', 'next-rule', 'next-original']);
  assert.equal(result.visits, 5);
  assert.equal(result.offered[0].hits.length, 2);
});

test('adding supplemental needs does not dilute the original query reading turn', () => {
  const result = admitWholeReadingUnits({ materialize, measure, maxChars: 4, lanes: [
    lane('original', 'original', 'rule', 'dense', ['o1', 'o2', 'o3']),
    lane('n1', 'n1.zh', 'rule', 'dense', ['a1', 'a2']),
    lane('n2', 'n2.zh', 'qa', 'dense', ['b1', 'b2']),
    lane('n3', 'n3.zh', 'qa', 'lexical', ['c1', 'c2']),
  ] });
  assert.deepEqual(result.offered.map(bundle => bundle.unitKey), ['o1', 'a1', 'o2', 'b1']);
});
