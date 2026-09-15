import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiBoundedEvidenceProvider, boundedPlanBody } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { buildRuleStructureMapping, sourceSha256, stableJson } from '../backend/evidenceSourceStructure.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';
import { loadEvidenceGenerationContract } from '../backend/evidenceGenerationContract.mjs';
import { runCloudBudgetedQuestion } from '../backend/cloudRequestBudget.mjs';

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
function fixture({unknown=false, planTokens=500, selectionTokens, selectionInputLimit,
  offlineEvaluationLimits, loadAssets=async()=>assets(), generationContract}={}) {
  const requests=[], reservations=[], counts=[];
  const provider=createGeminiBoundedEvidenceProvider({loadAssets, offlineEvaluationLimits,
    loadGenerationContract:stage=>{
      const contract=structuredClone(loadEvidenceGenerationContract(stage));
      if(stage==='selection' && selectionInputLimit) contract.capacityContract.maxInputTokens=selectionInputLimit;
      return generationContract ? generationContract(stage, contract) : contract;
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
  assert.equal(result.telemetry.bounded.perQuestionMaxUsd, 0.30 / 7);
  assert.ok(result.telemetry.bounded.reading.lanes.some(lane=>lane.needId==='original'));
  assert.ok(result.packing.promptChars<=14000);
  assert.equal(result.telemetry.bounded.maxPromptChars, 14000);
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

test('default deadline keeps the existing online cap when the environment asks for an offline-sized limit', async () => {
  const {provider} = fixture();
  await assert.rejects(provider.retrieve({ ...input,
    env: { ...input.env, GEMINI_EVIDENCE_DEADLINE_MS: '300000' },
    elapsedBeforeRetrievalMs: 26001,
  }), /evidence_config_invalid_GEMINI_EVIDENCE_DEADLINE_MS/);
});

test('constructor-only offline evaluation limits accept elapsed time beyond the online deadline and report the effective limits', async () => {
  const {provider} = fixture({ offlineEvaluationLimits: { deadlineMs: 300000, perQuestionMaxUsd: 0.20 } });
  const result = await provider.retrieve({ ...input,
    env: { ...input.env, GEMINI_EVIDENCE_DEADLINE_MS: '300000', GEMINI_EVIDENCE_MAX_CNY: '9' },
    elapsedBeforeRetrievalMs: 26001,
  });
  assert.equal(result.telemetry.bounded.deadlineMs, 300000);
  assert.equal(result.telemetry.bounded.perQuestionMaxUsd, 0.20);
  assert.equal(result.telemetry.bounded.maxUsd, 0.20);
});

test('constructor-only offline prompt limit binds selection budget, final serialization, and telemetry', async () => {
  const {provider, requests} = fixture({ offlineEvaluationLimits: {
    deadlineMs: 300000, perQuestionMaxUsd: 0.20, maxPromptChars: 15000,
  } });
  const result = await provider.retrieve({ ...input, elapsedBeforeRetrievalMs: 26001 });
  const selectionRequest = requests.find(request => {
    const payload = JSON.parse(request.contents[0].parts[1].text);
    return payload.queryPlan;
  });
  const selectionPayload = JSON.parse(selectionRequest.contents[0].parts[1].text);
  assert.equal(selectionPayload.packingBudget.limitChars, 15000);
  assert.match(selectionRequest.contents[0].parts[0].text, /上限15000字符/u);
  assert.ok(result.packing.promptChars <= 15000);
  assert.equal(result.telemetry.bounded.maxPromptChars, 15000);
});

test('production environment binds the 30 second, 15000 character and 64000 reading contracts', async () => {
  const {provider, requests} = fixture();
  const result = await provider.retrieve({ ...input, env: {
    ...input.env,
    GEMINI_EVIDENCE_DEADLINE_MS: '30000',
    GEMINI_EVIDENCE_MAX_PROMPT_CHARS: '15000',
    GEMINI_EVIDENCE_READING_TARGET_CHARS: '64000',
  }});
  const selectionRequest = requests.find(request => {
    const payload = JSON.parse(request.contents[0].parts[1].text);
    return payload.queryPlan;
  });
  const selectionPayload = JSON.parse(selectionRequest.contents[0].parts[1].text);
  assert.equal(selectionPayload.packingBudget.limitChars, 15000);
  assert.ok(result.packing.promptChars <= 15000);
  assert.equal(result.telemetry.bounded.deadlineMs, 30000);
  assert.equal(result.telemetry.bounded.maxPromptChars, 15000);
});

test('production prompt limit rejects values above the authorized serialized cap', async () => {
  const {provider} = fixture();
  await assert.rejects(provider.retrieve({ ...input, env: {
    ...input.env, GEMINI_EVIDENCE_MAX_PROMPT_CHARS: '15001',
  }}), /evidence_config_invalid_GEMINI_EVIDENCE_MAX_PROMPT_CHARS/);
});

test('stage telemetry reports independent generation contracts while preserving top-level compatibility fields', async () => {
  const {provider} = fixture({ generationContract: (stage, contract) => {
    if (stage === 'planning') {
      contract.modelId = 'planning-fixture-model';
      contract.reasoningConfig = { thinkingConfig: { thinkingLevel: 'medium' } };
    } else if (stage === 'selection') {
      contract.modelId = 'selection-fixture-model';
      contract.reasoningConfig = { thinkingConfig: { thinkingLevel: 'high' } };
    }
    return contract;
  } });
  const result = await provider.retrieve(input);
  assert.deepEqual(result.telemetry.stageTelemetry, {
    planning: { provider: 'gemini', model: 'planning-fixture-model', reasoningEffort: 'medium' },
    selection: { provider: 'gemini', model: 'selection-fixture-model', reasoningEffort: 'high' },
  });
  assert.equal(result.telemetry.provider, 'gemini');
  assert.equal(result.telemetry.model, 'planning-fixture-model');
  assert.equal(result.telemetry.reasoningEffort, 'medium');
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

test('nonlinear selection count trims whole offered bundles after the ratio resize', async () => {
  const records = [
    { ...record, id: 'rule-one', text: 'x' },
    { ...record, id: 'rule-two', text: 'y' },
  ];
  const { structureMappingRevision: _old, ...base } = buildRuleStructureMapping(records);
  const mapping = { ...base, qaUnits: [] };
  const structureMapping = { ...mapping, structureMappingRevision: sourceSha256(stableJson(mapping)) };
  const loadAssets = async () => ({ schemaVersion: 3, dataRevision: 'd', qaRevision: 'q',
    bundleRevision: 'bundle', ruleContentRevision: 'rule-content',
    structureMappingRevision: structureMapping.structureMappingRevision,
    navigationRevision: 'navigation', rulesRecords: records, structureMapping,
    navigationRecords: [], createQaTools: options => createQaTools({ records: [], qaRevision: 'q', ...options }) });
  const { provider, requests, counts } = fixture({ loadAssets, selectionInputLimit: 1500,
    selectionTokens: payload => payload.groups.length === 0 ? 500
      : payload.groups.length === 1 ? 1700 : 1800 });
  const result = await provider.retrieve(input);
  const selectionRequest = requests.find(body => JSON.parse(body.contents[0].parts[1].text).queryPlan);
  const selectionPayload = JSON.parse(selectionRequest.contents[0].parts[1].text);
  assert.equal(requests.length, 2);
  assert.equal(result.telemetry.rounds, 2);
  assert.deepEqual(selectionPayload.groups, []);
  assert.ok(result.telemetry.bounded.omittedGroupIds.length >= 2);
  assert.equal(JSON.parse(counts.at(-1).generateContentRequest.contents[0].parts[1].text).groups.length, 0);
  for (const call of result.telemetry.bounded.calls.filter(row => row.operation === 'generate_content')) {
    const contract = result.telemetry.generationContracts[call.stage];
    const measurement = call.measurement;
    const capacity = contract.capacityContract;
    assert.ok(capacity.maxInputTokens === null || measurement.inputTokensUpperBound <= capacity.maxInputTokens);
    assert.ok(capacity.maxRequestBodyBytes === null || measurement.requestBodyBytes <= capacity.maxRequestBodyBytes);
    if (capacity.sharedContextRuleId === 'input_plus_max_billable_output_lte_shared_context') {
      assert.ok(measurement.contextInputTokensUpperBound + contract.maxBillableOutputTokens
        <= capacity.maxSharedContextTokens);
    }
    if (call.stage === 'selection') assert.ok(measurement.inputTokensUpperBound <= 1500);
  }
});

test('aborting a request stops waiting for shared assets and leaves their promise reusable',async()=>{
  let resolveAssets;
  const shared=new Promise(resolve=>{resolveAssets=resolve;});
  const {provider}=fixture({loadAssets:()=>shared});
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(new Error('fixture_request_cancelled')),10);
  try {
    await assert.rejects(Promise.race([
      provider.retrieve({...input,signal:controller.signal,elapsedBeforeRetrievalMs:1234}),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('shared_asset_wait_did_not_cancel')),250))
    ]),error=>{
      assert.match(error.message,/fixture_request_cancelled/);
      assert.equal(error.boundedRetrieval.elapsedBeforeRetrievalMs,1234);
      assert.equal(typeof error.boundedRetrieval.timingsMs,'object');
      return true;
    });
    resolveAssets(assets());
    const result=await provider.retrieve(input);
    assert.equal(result.telemetry.rounds,2);
  } finally {clearTimeout(timeout);resolveAssets(assets());}
});

test('B.AI profiles bind both generation stages to measured Responses wires and produce a final pack',async()=>{
  const profiles=[
    ['deepseek-v4.1-flash','../config/evidence-generation/bai-deepseek-v4.1-flash-low-theoretical.json'],
    ['gpt-5.6-luna','../config/evidence-generation/bai-gpt-5.6-luna-low-theoretical.json'],
  ];
  for(const [model,relativeProfile] of profiles){
    const generationRequests=[],events=[];
    const provider=createGeminiBoundedEvidenceProvider({
      loadAssets:async()=>assets(),
      loadDenseSearch:async({rules})=>({search:()=>[...rules.units.values()]}),
      loadQaSearch:async()=>({search:()=>[]}),
      loadGenerationContract:stage=>loadEvidenceGenerationContract(stage,{profileUrl:new URL(relativeProfile,import.meta.url)}),
      remainingBudget:async()=>1,
      budgetedRequest:request=>request.invoke(),
      onEvent:async event=>events.push(event),
      fetchImpl:async(url,init)=>{
        const body=JSON.parse(init.body);
        if(url.endsWith(':embedContent'))return Response.json({embedding:{values:Array(768).fill(1)},usageMetadata:{promptTokenCount:10}});
        if(url.endsWith(':batchEmbedContents'))return Response.json({embeddings:body.requests.map(()=>({values:Array(768).fill(1)})),usageMetadata:{promptTokenCount:10}});
        assert.equal(url,'https://api.b.ai/v1/responses');
        generationRequests.push(body);
        const first=body.input.find(item=>item.role==='user').content;
        const payload=JSON.parse(first.slice(first.lastIndexOf('\n\n')+2));
        const selectedIds=payload.groups?.flatMap(group=>group.units||[]).map(row=>row[0]);
        const output=payload.queryPlan
          ? {selectedIds,unableToSelect:false,note:''}
          : {needs:[{id:'n1',question:'synthetic relation',ruleQuery:'synthetic rule query',qaQuery:'synthetic QA query'}]};
        return Response.json({status:'completed',model,
          output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}],
          usage:{input_tokens:500,output_tokens:70,output_tokens_details:{reasoning_tokens:10},total_tokens:570}});
      },
    });
    const result=await provider.retrieve({...input,env:{GEMINI_API_KEY:'fixture',BAI_API_KEY:'fixture'}});
    assert.equal(generationRequests.length,2);
    assert.ok(generationRequests.every(body=>body.model===model&&body.max_output_tokens===4096&&body.stream===false));
    const requestEvents=events.filter(event=>event.type==='request');
    assert.equal(requestEvents.length,2);
    assert.ok(requestEvents.every(event=>event.body.model===model
      &&event.measurement.requestBodyBytes===Buffer.byteLength(JSON.stringify(event.body))
      &&event.measurement.basis==='user_authorized_theoretical'
      &&event.measurement.exact===false));
    assert.equal(result.telemetry.providerUsed,'bai');
    assert.equal(result.telemetry.modelUsed,model);
    assert.equal(result.telemetry.reasoningEffort,'low');
    assert.equal(result.telemetry.tokenUsage.prompt_tokens,1000);
    assert.ok(result.packing.prompt.includes('complete synthetic source paragraph'));
    assert.ok(result.packing.promptChars<=14000);
  }
});

test('B.AI automatic-cache reading budget matches the generation reservation rate', async () => {
  const largeRecord = { ...record, id: 'large-synthetic-rule', text: 'complete synthetic source paragraph '.repeat(450) };
  const { structureMappingRevision: _old, ...base } = buildRuleStructureMapping([largeRecord]);
  const mapping = { ...base, qaUnits: [] };
  const structureMapping = { ...mapping, structureMappingRevision: sourceSha256(stableJson(mapping)) };
  const largeAssets = {
    schemaVersion: 3, dataRevision: 'd', qaRevision: 'q', bundleRevision: 'bundle',
    ruleContentRevision: 'rule-content', structureMappingRevision: structureMapping.structureMappingRevision,
    navigationRevision: 'navigation', rulesRecords: [largeRecord], structureMapping,
    navigationRecords: [],
    createQaTools: options => createQaTools({ records: [], qaRevision: 'q', ...options }),
  };
  const profileUrl = new URL('../config/evidence-generation/bai-gpt-5.6-luna-low-theoretical.json', import.meta.url);
  const requests = [];
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => largeAssets,
    loadDenseSearch: async ({ rules }) => ({ search: () => [...rules.units.values()] }),
    loadQaSearch: async () => ({ search: () => [] }),
    loadGenerationContract: stage => loadEvidenceGenerationContract(stage, { profileUrl }),
    remainingBudget: async () => 1,
    offlineEvaluationLimits: { deadlineMs: 300000, perQuestionMaxUsd: 0.0117, maxPromptChars: 25000 },
    budgetedRequest: request => request.invoke(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(':embedContent')) {
        return Response.json({ embedding: { values: Array(768).fill(1) }, usageMetadata: { promptTokenCount: 10 } });
      }
      if (url.endsWith(':batchEmbedContents')) {
        return Response.json({ embeddings: body.requests.map(() => ({ values: Array(768).fill(1) })),
          usageMetadata: { promptTokenCount: 10 } });
      }
      assert.equal(url, 'https://api.b.ai/v1/responses');
      requests.push(body);
      const first = body.input.find(item => item.role === 'user').content;
      const payload = JSON.parse(first.slice(first.lastIndexOf('\n\n') + 2));
      const selectedIds = payload.groups?.flatMap(group => group.units || []).map(row => row[0]);
      const output = payload.queryPlan
        ? { selectedIds, unableToSelect: false, note: '' }
        : { needs: [{ id: 'n1', question: 'synthetic relation', ruleQuery: 'synthetic rule query', qaQuery: 'synthetic QA query' }] };
      return Response.json({ status: 'completed', model: 'gpt-5.6-luna',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
        usage: payload.queryPlan ? { input_tokens: 500, output_tokens: 70, total_tokens: 570 } : {} });
    },
  });
  const result = await provider.retrieve({ ...input,
    env: { ...input.env, BAI_API_KEY: 'fixture' },
  });
  assert.equal(requests.length, 2);
  assert.equal(result.telemetry.rounds, 2);
});

test('production mixed-stage profiles use the matching provider in the durable request scope', async () => {
  const routed = [];
  const controller = {
    gemini: async request => { routed.push(['gemini', request.operation]); return request.invoke(); },
    bai: async request => { routed.push(['bai', request.operation]); return request.invoke(); },
    remainingPreparationUsd: async () => 1,
    snapshot: () => ({ calls: routed }),
  };
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => assets(),
    loadDenseSearch: async ({rules}) => ({search: () => [...rules.units.values()]}),
    loadQaSearch: async () => ({search: () => []}),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(':countTokens')) return Response.json({totalTokens: 500});
      if (url.endsWith(':embedContent')) return Response.json({embedding:{values:Array(768).fill(1)},usageMetadata:{promptTokenCount:10}});
      if (url.endsWith(':batchEmbedContents')) return Response.json({embeddings:body.requests.map(()=>({values:Array(768).fill(1)})),usageMetadata:{promptTokenCount:10}});
      if (url.endsWith(':generateContent')) {
        return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({needs:[{
          id:'n1',question:'synthetic relation',ruleQuery:'synthetic rule query',qaQuery:'synthetic QA query',
        }]})}]}}],usageMetadata:{promptTokenCount:500,candidatesTokenCount:60,totalTokenCount:560}});
      }
      assert.equal(url, 'https://evidence.b.ai/v1/responses');
      const first = body.input.find(item => item.role === 'user').content;
      const payload = JSON.parse(first.slice(first.lastIndexOf('\n\n') + 2));
      const selectedIds = payload.groups.flatMap(group => group.units || []).map(row => row[0]);
      return Response.json({status:'completed',model:'gpt-5.6-luna',
        output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({selectedIds,unableToSelect:false,note:''})}]}],
        usage:{input_tokens:500,output_tokens:70,total_tokens:570}});
    },
  });
  const env = {
    ...input.env,
    EVIDENCE_PLANNING_PROFILE: 'gemini-3.8-flash-low',
    EVIDENCE_SELECTION_PROFILE: 'bai-gpt-5.6-luna-low-theoretical',
    RAG_EVIDENCE_BAI_API_KEY: 'fixture',
    RAG_EVIDENCE_BAI_BASE_URL: 'https://evidence.b.ai/v1',
  };
  const result = await runCloudBudgetedQuestion({env, budget:controller}, () => provider.retrieve({...input, env}));
  assert.equal(result.telemetry.stageTelemetry.planning.provider, 'gemini');
  assert.equal(result.telemetry.stageTelemetry.selection.provider, 'bai');
  assert.ok(routed.some(([providerId, operation]) => providerId === 'gemini' && operation === 'generate_content'));
  assert.ok(routed.some(([providerId, operation]) => providerId === 'bai' && operation === 'generate_content'));
  assert.ok(routed.some(([providerId, operation]) => providerId === 'gemini' && operation === 'embed_content'));
});
