import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRuleSystem, ruleSystemEnv, ruleSystemDataDir} from '../backend/rulingRuleSystem.mjs';
import {loadCardNicknameData} from '../backend/ragCardNicknameData.mjs';
import {searchCards} from '../backend/baigeCardProvider.mjs';
import {toRagCard} from '../backend/ragEvidenceRetriever.mjs';

test('unspecified system is OCG and invalid enum fails before source selection', () => {
  assert.equal(normalizeRuleSystem(), 'OCG');
  assert.throws(() => normalizeRuleSystem('invalid'), error => error.statusCode === 400);
});

test('TCG snapshot directory, revision and official lookup configuration are isolated', () => {
  const original = {TCG_DATA_DIR:'tcg-fixture', RAG_DATA_REVISION:'ocg-revision', RAG_LIVE_OFFICIAL_QA:'true'};
  const tcg = ruleSystemEnv(original,'TCG');
  assert.equal(ruleSystemDataDir('TCG',tcg),'tcg-fixture');
  assert.equal(tcg.GEMINI_RULE_QA_DATA_DIR,'tcg-fixture');
  assert.equal(tcg.RAG_DATA_REVISION,'');
  assert.equal(tcg.RAG_LIVE_OFFICIAL_QA,'false');
  assert.equal(original.RAG_LIVE_OFFICIAL_QA,'true');
  assert.equal(ruleSystemEnv(original,'OCG').RAG_DATA_REVISION,'ocg-revision');
});

test('nickname caches are independent for each source directory', () => {
  const ocg = loadCardNicknameData('OCG');
  const tcg = loadCardNicknameData('TCG');
  assert.notEqual(ocg,tcg);
  assert.equal(loadCardNicknameData('OCG'),ocg);
  assert.equal(loadCardNicknameData('TCG'),tcg);
});

test('actual TCG card lookup has no OCG network fallback and preserves CID provenance', async () => {
  const result = await searchCards('Mystical Space Typhoon',{ruleSystem:'TCG',
    fetchImpl:() => { throw new Error('unexpected_external_lookup'); }});
  assert.equal(result.provider,'konami-tcg');
  assert.equal(result.results.length,1);
  const card = result.results[0];
  assert.equal(card.idNamespace,'konami-cid');
  assert.equal(card.passcode,'');
  assert.deepEqual(card.imageCandidates,[]);
  const projected = toRagCard(card,'Mystical Space Typhoon',1);
  assert.equal(projected.ruleSystem,'TCG');
  assert.equal(projected.sourceUrl,card.sourceUrl);
  assert.equal(projected.official,card.official);
});
