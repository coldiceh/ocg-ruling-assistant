import test from 'node:test';
import assert from 'node:assert/strict';
import {getPublicReleaseInfo} from '../backend/publicReleaseInfo.mjs';
test('release identity uses the deployed manifest and deployment commit',()=>{
  const read=url=>JSON.stringify(String(url).endsWith('rag-data-revision-manifest.json')?{revision:'data-r'}:{commit:'build-c',builtAt:'stamp'});
  assert.deepEqual(getPublicReleaseInfo({VERCEL_GIT_COMMIT_SHA:'deployed-c'},read),{commit:'deployed-c',dataRevision:'data-r',builtAt:'stamp'});
  assert.deepEqual(getPublicReleaseInfo({},read),{commit:'build-c',dataRevision:'data-r',builtAt:'stamp'});
  assert.deepEqual(getPublicReleaseInfo({},()=>{throw Error('missing');}),{commit:null,dataRevision:null,builtAt:null});
});
