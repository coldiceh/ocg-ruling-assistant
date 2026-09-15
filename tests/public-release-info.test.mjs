import test from 'node:test';
import assert from 'node:assert/strict';
import {getPublicReleaseInfo} from '../backend/publicReleaseInfo.mjs';
const readRelease = (...args) => {
  const { runtimeMemory, ...release } = getPublicReleaseInfo(...args);
  assert.deepEqual(Object.keys(runtimeMemory).sort(),
    ['arrayBuffers', 'external', 'heapLimitBytes', 'heapTotal', 'heapUsed', 'rss']);
  for (const value of Object.values(runtimeMemory)) assert.ok(Number.isFinite(value) && value >= 0);
  assert.ok(runtimeMemory.heapLimitBytes > 0);
  return release;
};
test('release identity uses the deployed manifest and deployment commit',()=>{
  const expected={assetSchemaVersion:3,bundleRevision:'bundle',dataRevision:'data-r',navigationRevision:'nav',
    structureMappingRevision:'mapping',ruleDenseRevision:'rule-dense',qaDenseRevision:'qa-dense'};
  const loaded={...expected,loadedAt:'ignored',loadMs:1};
  const read=url=>JSON.stringify(String(url).endsWith('rag-data-revision-manifest.json')?{revision:'data-r'}:
    {commit:'build-c',builtAt:'stamp',evidenceAssets:{expected}});
  assert.deepEqual(readRelease({VERCEL_GIT_COMMIT_SHA:'deployed-c'},read,()=>loaded),
    {commit:'deployed-c',dataRevision:'data-r',builtAt:'stamp',evidenceAssets:{expected,loaded:expected}});
  assert.deepEqual(readRelease({},read,()=>null),
    {commit:'build-c',dataRevision:'data-r',builtAt:'stamp',evidenceAssets:{expected,loaded:null}});
  assert.deepEqual(readRelease({},()=>{throw Error('missing');},()=>null),
    {commit:null,dataRevision:null,builtAt:null,evidenceAssets:{expected:null,loaded:null}});
});
