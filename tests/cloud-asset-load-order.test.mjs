import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudEvidenceProvider} from '../backend/cloudEvidenceProvider.mjs';

const request={userQuery:'synthetic input',cardResolution:{},retrievedEvidence:{},dataRevision:'ordering-test',env:{CLOUD_EVIDENCE_ASSET_DIR:'.',CLOUD_EVIDENCE_DENSE:'true'}};

test('the production loader completes corpus work before allocating vector shards', async()=>{
  const events=[];
  let corpusComplete=false;
  const provider=createCloudEvidenceProvider({
    loadCorpus:async()=>{events.push('corpus-start');await new Promise(resolve=>setImmediate(resolve));corpusComplete=true;events.push('corpus-complete');return {schemaVersion:1,dataRevision:'ordering-test',candidates:[],documents:[]};},
    loadVectorIndex:async()=>{assert.equal(corpusComplete,true);events.push('vectors');return {entries:new Map()};},
    generatePlan:async()=>{throw new Error('stop-before-model');},
  });
  await assert.rejects(provider.retrieve(request),/stop-before-model/);
  assert.deepEqual(events,['corpus-start','corpus-complete','vectors']);
});

test('a corpus load failure does not start a second large allocation', async()=>{
  let vectorLoads=0;
  const provider=createCloudEvidenceProvider({
    loadCorpus:async()=>{throw new Error('corpus-load-failed');},
    loadVectorIndex:async()=>{vectorLoads++;return {entries:new Map()};},
    generatePlan:async()=>{throw new Error('must-not-generate');},
  });
  await assert.rejects(provider.retrieve(request),/corpus-load-failed/);
  assert.equal(vectorLoads,0);
});
