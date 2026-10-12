import assert from 'node:assert/strict';
import test from 'node:test';
import {loadQaDenseSearch} from '../backend/geminiQaDenseSearch.mjs';

test('a source set with no QA records needs no QA vector file; FAQ remains a separate source kind', async () => {
  const search=await loadQaDenseSearch({qaRevision:'empty-qa',denseRevision:'empty-qa-dense',
    items:[{handle:'faq-1',record:{recordType:'card-faq',conclusion:'Canonical FAQ body.'}}],
    dataDir:'does-not-exist-no-qa-index-required'});
  assert.equal(search.denseRevision,'empty-qa-dense');
  assert.deepEqual(search.search([]),[]);
  assert.deepEqual(await search.searchAsync([]),[]);
});
