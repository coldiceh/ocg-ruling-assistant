import test from 'node:test';
import assert from 'node:assert/strict';
import {getPublicReleaseInfo} from '../backend/publicReleaseInfo.mjs';
test('release identity uses the deployed manifest and deployment commit',()=>{
  const expected={assetSchemaVersion:3,bundleRevision:'bundle',dataRevision:'data-r',navigationRevision:'nav',
    structureMappingRevision:'mapping',ruleDenseRevision:'rule-dense',qaDenseRevision:'qa-dense'};
  const loaded={...expected,loadedAt:'ignored',loadMs:1};
  const read=url=>JSON.stringify(String(url).endsWith('rag-data-revision-manifest.json')?{revision:'data-r'}:
    {commit:'build-c',builtAt:'stamp',evidenceAssets:{expected}});
  assert.deepEqual(getPublicReleaseInfo({VERCEL_GIT_COMMIT_SHA:'deployed-c'},read,()=>loaded),
    {commit:'deployed-c',dataRevision:'data-r',builtAt:'stamp',evidenceAssets:{expected,loaded:expected}});
  assert.deepEqual(getPublicReleaseInfo({},read,()=>null),
    {commit:'build-c',dataRevision:'data-r',builtAt:'stamp',evidenceAssets:{expected,loaded:null}});
  assert.deepEqual(getPublicReleaseInfo({},()=>{throw Error('missing');},()=>null),
    {commit:null,dataRevision:null,builtAt:null,evidenceAssets:{expected:null,loaded:null}});
});
