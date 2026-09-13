import test from 'node:test';
import assert from 'node:assert/strict';
import {packGeminiSelection} from '../backend/geminiRuleQaPacking.mjs';

// Source-schema roles, stable metadata and actual production prompt only.
// No substring/keyword comparison and no evidence sufficiency assertion.
for (const answerField of ['answer', 'conclusion']) {
  test(`QA prompt preserves source roles once for ${answerField} schema`, () => {
    const record = {id:'ygoresources-qa-94001',recordType:'qa',title:'display title',question:'derived heading',
      rawQuestion:'source heading',rawDetailedQuestion:'source scene\nconditions',[answerField]:'source answer\nbranch',
      text:'derived search view',cardIds:['8'],sourceUrl:'https://example.test/qa/94001',sourceName:'fixture',official:false,
      questionLocales:{en:{title:'independent localized heading'}},answerLocale:'ja'};
    const original = JSON.stringify(record);
    const result = packGeminiSelection({selection:{selectedRules:[],selectedQa:[{handle:'bound-handle',record}]},
      userQuery:'fixture',cardResolution:{resolvedCards:[],unresolvedMentions:[],ambiguousMentions:[]}});
    const row = result.packing.modelEvidence.rawRelatedEvidence[0];
    const body = JSON.parse(row.text);
    assert.deepEqual(body.sourceQa,{title:record.rawQuestion,question:record.rawDetailedQuestion,answer:record[answerField]});
    assert.equal(Object.hasOwn(body,'text'),false);
    assert.equal(Object.hasOwn(body,answerField),false);
    assert.deepEqual(body.questionLocales,record.questionLocales);
    assert.equal(body.answerLocale,'ja');
    assert.equal(row.sourceUrl,record.sourceUrl);
    assert.equal(row.official,false);
    assert.equal(row.id,'bound-handle');
    assert.equal(JSON.stringify(record),original);
  });
}
