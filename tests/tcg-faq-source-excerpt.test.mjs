import assert from 'node:assert/strict';
import test from 'node:test';
import {createFocusedQaView} from '../backend/geminiFocusedQaView.mjs';
import {projectQaForDisplay,restoreQaFromDisplay} from '../backend/decisionsEvidenceDisplay.mjs';

test('an official FAQ without optional catalog fields remains JSON serializable with its TCG provenance', () => {
  const record={id:'tcg-faq',recordType:'card-faq',title:'Official FAQ',conclusion:'First canonical paragraph.\n\nSecond canonical paragraph.',
    ruleSystem:'TCG',region:'North America',sourceLanguage:'en',sourceVersion:'trial',sourceDate:null,effectiveAt:null,
    sourceAuthority:'official_reference',official:true};
  const view=createFocusedQaView({qaRevision:'trial',items:[{handle:'faq-parent',record}]});
  assert(view.items.length);
  for(const item of view.items) {
    const projected=projectQaForDisplay(item.record);
    assert.deepEqual(restoreQaFromDisplay(projected),JSON.parse(JSON.stringify(item.record)));
    assert.equal(item.record.ruleSystem,'TCG');
    assert.equal(item.record.region,'North America');
    assert.equal(item.record.sourceVersion,'trial');
    assert.equal(item.record.conclusion,record.conclusion.slice(item.record.sourceExcerpt.start,item.record.sourceExcerpt.end));
  }
});
