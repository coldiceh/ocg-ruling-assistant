import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiBoundedEvidenceProvider, boundedPlanBody } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { buildRuleStructureMapping, sourceSha256, stableJson } from '../backend/evidenceSourceStructure.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';
import { loadEvidenceGenerationContract } from '../backend/evidenceGenerationContract.mjs';

const record = { id: 'synthetic-rule', recordType: 'rule-doc', title: 'Synthetic source',
  text: 'complete synthetic source paragraph\n\nanother complete paragraph', official: false, sourceAuthority: 'community_reference' };
function assets() {
  const { structureMappingRevision: _old, ...base } = buildRuleStructureMapping([record]);
  const mapping = { ...base, qaUnits: [] };
  const structureMapping = { ...mapping, structureMappingRevision: sourceSha256(stableJson(mapping)) };
  return { schemaVersion: 3, dataRevision:'d', qaRevision:'q', bundleRevision:'bundle', ruleContentRevision:'rule-content',
    structureMappingRevision:structureMapping.structureMappingRevision, navigationRevision:'navigation',
    rulesRecords:[record], structureMapping, navigationRecords:[],
    createQaTools: options => createQaTools({ records:[],qaRevision:'q',...options }) };
}
const input = { userQuery:'complete synthetic original question', dataRevision:'d', env:{ GEMINI_API_KEY:'fixture' },
  cardResolution:{resolvedCards:[],unresolvedMentions:[],ambiguousMentions:[]},
  retrievedEvidence:{cardTexts:[{id:'fixture-card',text:'entire confirmed card text'}]} };
function fixture({unknown=false, planTokens=500, selectionTokens, selectionInputLimit, loadAssets=async()=>assets()}={}) {
  const requests=[], reservations=[], counts=[];
  const provider=createGeminiBoundedEvidenceProvider({loadAssets,
    loadGenerationContract:stage=>{
      const contract=structuredClone(loadEvidenceGenerationContract(stage));
      if(stage==='selection' && selectionInputLimit) contract.capacityContract.maxInputTokens=selectionInputLimit;
      return contract;
    },
    loadDenseSearch:async({rules})=>({search:()=>[...rules.units.values()]}),
    loadQaSearch:async()=>({search:()=>[]}),
    budgetedRequest:async request=>{reservations.push(request);return request.invoke();},
    fetchImpl:async(url,init)=>{
      const body=JSON.parse(init.body);
      if(url.endsWith(':embedContent'))return Response.json({embedding:{values:Array(768).fill(1)},usageMetadata:{promptTokenCount:10}});
      if(url.endsWith(':batchEmbedContents'))return Response.json({embeddings:body.requests.map(()=>({values:Array(768).fill(1)})),usageMetadata:{promptTokenCount:10}});
      if(url.endsWith(':countTokens')){
        const payload=JSON.parse(body.generateContentRequest.contents[0].parts[1].text);
        counts.push(body);
        return Response.json({totalTokens:payload.queryPlan?(selectionTokens?.(payload)??500):planTokens});
      }
      assert.ok(url.endsWith(':generateContent'));
      requests.push(body);
      const payload=JSON.parse(body.contents[0].parts[1].text);
      const selectedIds=payload.groups?.flatMap(group=>group.units||[]).map(row=>row[0]);
      const output=payload.queryPlan?{selectedIds:unknown?['unoffered']:selectedIds,unableToSelect:false,note:''}
        :{needs:[{id:'n1',question:'synthetic relation',ruleQuery:'synthetic rule query',qaQuery:'synthetic QA query'}]};
      const tokens=payload.queryPlan?500:planTokens;
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(output)}]}}],
        usageMetadata:{promptTokenCount:tokens,candidatesTokenCount:60,thoughtsTokenCount:10,totalTokenCount:tokens+70}});
    }});
  return {provider,requests,reservations,counts};
}

test('short plan preserves exact input and never carries source directories',()=>{
  const expected={question:'unaltered question',cardTexts:[{text:'entire card'}]};
  const body=boundedPlanBody(expected,{sections:new Map([['huge','directory']])},[],['irrelevant']);
  assert.deepEqual(JSON.parse(body.contents[0].parts[1].text),expected);
});
test('production provider uses two counted generations, original query lane and canonical source pack',async()=>{
  const {provider,requests,reservations}=fixture();
  const result=await provider.retrieve(input);
  assert.equal(requests.length,2);
  for(const request of reservations.filter(row=>row.operation==='generate_content')) {
    assert.ok(request.measurement.exact);
    assert.equal(request.measurement.modelId,request.generationContract.modelId);
  }
  assert.equal(result.telemetry.strategy,'source_preprocessed_v1');
  assert.ok(result.telemetry.bounded.reading.lanes.some(lane=>lane.needId==='original'));
  assert.ok(result.packing.promptChars<=14000);
  assert.ok(result.packing.prompt.includes('complete synthetic source paragraph'));
  assert.equal(result.telemetry.rounds,2);
});
test('old cumulative 32000 input rule does not reject an otherwise affordable request',async()=>{
  const {provider,requests}=fixture({planTokens:32500});
  const result=await provider.retrieve(input);
  assert.equal(requests.length,2);
  assert.ok(result.telemetry.estimatedCostCny<=0.30);
});
test('unknown selected ID stops before packing and does not trigger protocol retry',async()=>{
  const {provider,requests}=fixture({unknown:true});
  await assert.rejects(provider.retrieve(input),/selected_identity_not_offered/);
  assert.equal(requests.length,2);
});

test('selection above input capacity is measured and rebuilt once before generation',async()=>{
  const {provider,requests,counts}=fixture({selectionInputLimit:1000,
    selectionTokens:payload=>payload.groups.length?1500:500});
  const result=await provider.retrieve(input);
  const selectionRequests=requests.filter(body=>JSON.parse(body.contents[0].parts[1].text).queryPlan);
  assert.equal(selectionRequests.length,1);
  assert.deepEqual(JSON.parse(selectionRequests[0].contents[0].parts[1].text).groups,[]);
  assert.ok(counts.length<=4); // planning, fixed, initial, rebuilt (identical bodies may reuse)
  assert.equal(result.telemetry.rounds,2);
});

test('aborting a request stops waiting for shared assets and leaves their promise reusable',async()=>{
  let resolveAssets;
  const shared=new Promise(resolve=>{resolveAssets=resolve;});
  const {provider}=fixture({loadAssets:()=>shared});
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(new Error('fixture_request_cancelled')),10);
  try {
    await assert.rejects(Promise.race([
      provider.retrieve({...input,signal:controller.signal}),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('shared_asset_wait_did_not_cancel')),250))
    ]),/fixture_request_cancelled/);
    resolveAssets(assets());
    const result=await provider.retrieve(input);
    assert.equal(result.telemetry.rounds,2);
  } finally {clearTimeout(timeout);resolveAssets(assets());}
});
