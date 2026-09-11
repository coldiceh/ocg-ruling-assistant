import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCloudEvidencePlan, generateCloudEvidencePlan } from '../backend/cloudEvidencePlan.mjs';
import { createCloudEvidenceProvider } from '../backend/cloudEvidenceProvider.mjs';
import { buildRagRulingPromptBundle } from '../backend/ragRulingPrompt.mjs';

test('optional hints accept empty and mechanically equivalent forms', () => {
  assert.deepEqual(normalizeCloudEvidencePlan({informationNeeds: []}), {informationNeeds:[],queryTexts:[]});
  assert.deepEqual(normalizeCloudEvidencePlan({informationNeeds: '  extra term  '}), {informationNeeds:['extra term'],queryTexts:[]});
  assert.deepEqual(normalizeCloudEvidencePlan({informationNeeds:{need:'term',query:'query'}}), {informationNeeds:['term'],queryTexts:['query']});
});
test('recoverable hint format failure uses original query once and retains usage', async () => {
  let calls=0;
  const provider=createCloudEvidenceProvider({
    loadCorpus: async()=>({schemaVersion:1,dataRevision:'test-revision',candidates:[],documents:[]}),
    generatePlan: options=>generateCloudEvidencePlan({...options,invokeTask:async()=>{
      calls++; return {wrongField:[],usage:{prompt_tokens:90},requestedModel:'fixture-model'};
    }}),
  });
  const result=await provider.retrieve({userQuery:'original question',dataRevision:'test-revision',
    cardResolution:{resolvedCards:[]},retrievedEvidence:{cardTexts:[]},
    env:{CLOUD_EVIDENCE_ASSET_DIR:'fixture'},
    packEvidence: evidence=>buildRagRulingPromptBundle({userQuery:'original question',cardResolution:{resolvedCards:[]},evidence,env:{RAG_MAX_PROMPT_CHARS:'36000'}})});
  assert.equal(calls,1);
  assert.equal(result.debug.cloudEvidence.querySurfaceCount,1);
  assert.equal(result.debug.cloudEvidence.informationNeedCount,0);
  assert.equal(result.debug.cloudEvidence.planTelemetry.status,'failed_original_query_only');
  assert.equal(result.debug.cloudEvidence.planTelemetry.tokenUsage.prompt_tokens,90);
});
test('budget, binding, safety and abort failures remain hard failures', async()=>{
  for(const code of ['cloud_budget_exceeded','IDENTITY_INPUT_BINDING_ERROR','private_boundary_broken','ABORT_ERR']){
    const error=Object.assign(new Error(code),{code});
    await assert.rejects(generateCloudEvidencePlan({question:'q',invokeTask:async()=>{throw error;}}),e=>e===error);
  }
});
