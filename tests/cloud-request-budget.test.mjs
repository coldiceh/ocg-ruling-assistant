import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudRequestBudget,CLOUD_BUDGET_RESERVE,CLOUD_BUDGET_SETTLE,runCloudBudgetedQuestion,
  runCloudRelayRequest,runCloudBaiRequest,cloudSiliconFlowCallbacks,runOfficialOpenAIRequest,
  getOfficialOpenAIBudgetStatus,getCloudEvidenceBudgetStatus} from '../backend/cloudRequestBudget.mjs';
import {callSiliconFlowEmbeddings} from '../backend/siliconFlowEvidenceClient.mjs';
import {createPublicAnswerModelEnv} from '../backend/ragModelClient.mjs';

const env={CLOUD_BUDGET_RUN_ID:'test-scope',CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'10',
  CLOUD_BUDGET_THEORETICAL_LIMIT_USD:'5',CLOUD_BUDGET_INITIAL_ACTUAL_CNY:'0.00062622',
  RELAY_PRICING_MULTIPLIER:'0.27',RELAY_SITE_DOLLAR_CNY:'1'};
const body={model:'gpt-6-astra',messages:[{role:'user',content:'synthetic request'}],max_completion_tokens:4096};

test('b.ai records official token cost separately and keeps missing usage reserved',async()=>{
  const redis=recorder();const budget=createCloudRequestBudget({env,command:redis.command});
  const result=await runCloudBudgetedQuestion({env:{...env,RAG_MODEL_PROVIDER:'bai'},budget},async()=>{
    await runCloudBaiRequest({body,invoke:async()=>({model:'gpt-6-astra',usage:{
      prompt_tokens:1000,completion_tokens:100,total_tokens:1100,
      prompt_tokens_details:{cached_tokens:200,cache_write_tokens:100},
      completion_tokens_details:{reasoning_tokens:80},
    }})});
    await runCloudBaiRequest({body,invoke:async()=>({model:'gpt-6-astra'})});
    return {};
  });
  assert.equal(redis.calls.filter(call=>call[1]===CLOUD_BUDGET_RESERVE).length,2);
  assert.equal(redis.calls.filter(call=>call[1]===CLOUD_BUDGET_SETTLE).length,1);
  assert.equal(result.debug.cloudCosts.theoreticalUsd,0.01345);
  assert.equal(result.debug.cloudCosts.actualCostKnown,false);
  assert.deepEqual(result.debug.cloudCosts.calls.map(call=>call.provider),['bai','bai']);
  assert.equal(result.debug.cloudCosts.calls[0].actualCny,null);
  assert.equal(result.debug.cloudCosts.calls[1].status,'reserved');
  assert.ok(result.debug.cloudCosts.reservedTheoreticalUsd>0);
});

test('successful provider responses survive uncertain settlement without another model call',async()=>{
  const cases=[
    {provider:'relay',method:'relay',requestBody:body,usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15}},
    {provider:'deepseek',method:'deepseek',requestBody:{model:'deepseek-v4-flash',messages:body.messages,max_tokens:64},
      usage:{prompt_tokens:12,prompt_cache_hit_tokens:2,prompt_cache_miss_tokens:10,completion_tokens:3,total_tokens:15}},
    {provider:'openai',method:'openai',requestBody:body,usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15}},
    {provider:'bai',method:'bai',requestBody:body,usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15}},
  ];
  for(const testCase of cases) {
    const commands=[];
    const command=async args=>{
      commands.push(args);
      if(args[1]===CLOUD_BUDGET_RESERVE) return ['reserved'];
      throw new Error('simulated settlement outage');
    };
    const budget=createCloudRequestBudget({env,command});
    let providerInvocations=0;
    const providerResult={body:`${testCase.provider} answer`,model:testCase.requestBody.model,usage:testCase.usage};
    const result=await runCloudBudgetedQuestion({env:{...env,RAG_MODEL_PROVIDER:testCase.provider},budget},
      ()=>budget[testCase.method]({body:testCase.requestBody,invoke:async()=>{
        providerInvocations+=1;
        return providerResult;
      }}));
    assert.equal(providerInvocations,1,testCase.provider);
    assert.equal(result.body,providerResult.body,testCase.provider);
    assert.deepEqual(result.usage,providerResult.usage,testCase.provider);
    assert.equal(commands.length,2,testCase.provider);
    assert.equal(commands.filter(args=>args[1]===CLOUD_BUDGET_RESERVE).length,1,testCase.provider);
    assert.equal(commands.filter(args=>args[1]===CLOUD_BUDGET_SETTLE).length,1,testCase.provider);
    assert.equal(result.debug.cloudCosts.calls[0].status,'reserved',testCase.provider);
    assert.deepEqual(result.debug.cloudCosts.calls[0].usage,testCase.usage,testCase.provider);
    assert.equal(result.debug.cloudCosts.calls[0].uncertainty,
      'provider_response_received_settlement_uncertain_reservation_retained',testCase.provider);
    assert.ok(result.debug.cloudCosts.reservedCny>0 || result.debug.cloudCosts.reservedTheoreticalUsd>0,
      testCase.provider);
  }
});
function recorder({block=false}={}) {
  const calls=[];
  return {calls,command:async args=>{
    calls.push(args);
    assert.equal(args[0],'EVAL');assert.equal(args[2],'1');
    assert.equal(args[3],'ruling-cloud-budget:v1:test-scope');
    return [args[1]===CLOUD_BUDGET_RESERVE?(block?'blocked':'reserved'):'settled'];
  }};
}

function redisFetch(initial={}) {
  const hashes=new Map(Object.entries(initial).map(([key,value])=>[key,new Map(Object.entries(value))]));
  const calls=[];
  const fetchImpl=async(_url,options)=>{
    const args=JSON.parse(options.body);calls.push(args);
    if(args[0]==='HGETALL') return Response.json({result:[...(hashes.get(args[1])||new Map()).entries()].flat()});
    assert.equal(args[0],'EVAL');
    const key=args[3];
    const hash=hashes.get(key)||new Map();hashes.set(key,hash);
    if(args[1]===CLOUD_BUDGET_RESERVE) {
      const shift=args[2]==='2'?1:0;
      if(shift&& !hash.has('theoreticalNano')) {
        let migrated=0;
        for(const [id,value] of hashes.get(args[4])||new Map()) {
          if(['actualNano','theoreticalNano'].includes(id)) continue;
          const ticket=JSON.parse(value);
          if(ticket.provider==='openai'&&['reserved','usage_settled'].includes(ticket.status)
              && ticket.startedAtUtc>=args[14]&&ticket.startedAtUtc<args[15]) {
            migrated+=ticket.theoreticalNano;hash.set(id,value);
          }
        }
        hash.set('actualNano','0');hash.set('theoreticalNano',String(migrated));
      }
      const ticketIndex=4+shift;
      if(hash.has(args[ticketIndex])) return Response.json({result:['existing',hash.get(args[ticketIndex])]});
      const cny=Number(hash.get('actualNano')??args[9+shift]);
      const usd=Number(hash.get('theoreticalNano')??args[10+shift]);
      const nextCny=cny+Number(args[5+shift]);const nextUsd=usd+Number(args[6+shift]);
      if(nextCny>Number(args[7+shift])||nextUsd>Number(args[8+shift])) return Response.json({result:['blocked',String(cny),String(usd)]});
      hash.set('actualNano',String(nextCny));hash.set('theoreticalNano',String(nextUsd));hash.set(args[ticketIndex],args[11+shift]);
      return Response.json({result:['reserved',String(nextCny),String(nextUsd)]});
    }
    if(args[1]===CLOUD_BUDGET_SETTLE) {
      const ticket=JSON.parse(hash.get(args[4]));
      hash.set('actualNano',String(Number(hash.get('actualNano'))+Number(args[5])-ticket.actualNano));
      hash.set('theoreticalNano',String(Number(hash.get('theoreticalNano'))+Number(args[6])-ticket.theoreticalNano));
      hash.set(args[4],args[7]);
      return Response.json({result:['settled',hash.get('actualNano'),hash.get('theoreticalNano')]});
    }
    throw new Error('unexpected Redis script');
  };
  return {fetchImpl,calls,hashes};
}

test('cloud calls require persistent accounting and a known price before dispatch',async()=>{
  assert.throws(()=>createCloudRequestBudget({env}),/persistent_store_required/);
  const redis=recorder();const budget=createCloudRequestBudget({env,command:redis.command});
  let invoked=false;
  await assert.rejects(budget.relay({body:{...body,model:'unpriced'},invoke:async()=>{invoked=true;}}),/price_missing/);
  await assert.rejects(budget.relay({body:{...body,max_completion_tokens:undefined},invoke:async()=>{invoked=true;}}),/explicit_output_limit/);
  assert.equal(invoked,false);assert.equal(redis.calls.length,0);
});

test('exhausted dual-currency reservation prevents the actual model transport',async()=>{
  const redis=recorder({block:true});const budget=createCloudRequestBudget({env,command:redis.command});
  let invoked=false;
  await assert.rejects(budget.relay({body,invoke:async()=>{invoked=true;}}),/total_exceeded/);
  assert.equal(invoked,false);
  assert.equal(redis.calls[0][7],'10000000000');
  assert.equal(redis.calls[0][8],'5000000000');
  assert.equal(redis.calls[0][9],'626220');
});

test('real relay callback settles output including reasoning once and retains a vendor price upper bound',async()=>{
  const redis=recorder();const budget=createCloudRequestBudget({env,command:redis.command});
  const result=await runCloudBudgetedQuestion({env,budget},async()=>{
    await runCloudRelayRequest({body,invoke:async()=>({model:body.model,
      usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100,completion_tokens_details:{reasoning_tokens:80}}})});
    return {answer:'test'};
  });
  assert.equal(redis.calls.length,2);assert.equal(redis.calls[1][1],CLOUD_BUDGET_SETTLE);
  assert.equal(result.debug.cloudCosts.theoreticalUsd,.015);
  assert.equal(result.debug.cloudCosts.actualCny,.00405);
  assert.equal(result.debug.cloudCosts.accountedActualUpperCny,.015);
  assert.equal(result.debug.cloudCosts.reservedCny,0);
});

test('ambiguous transport and missing usage keep reservations without retrying',async()=>{
  for(const invoke of [async()=>{throw new Error('transport failed');},async()=>({model:body.model})]) {
    const redis=recorder();const budget=createCloudRequestBudget({env,command:redis.command});
    await budget.relay({body,invoke}).catch(()=>{});
    assert.equal(redis.calls.length,1);
    assert.ok(budget.snapshot().reservedCny>0);
    assert.equal(budget.snapshot().calls[0].status,'reserved');
  }
});

test('actual SiliconFlow client carries its reservation to settlement with complete vector response',async()=>{
  const redis=recorder();const budget=createCloudRequestBudget({env,command:redis.command});
  const result=await runCloudBudgetedQuestion({env,budget},async()=>{
    const response=await callSiliconFlowEmbeddings({inputs:['synthetic query'],env:{SILICONFLOW_API_KEY:'synthetic'},
      ...cloudSiliconFlowCallbacks(),fetchImpl:async()=>new Response(JSON.stringify({model:'Qwen/Qwen3-Embedding-0.6B',
        data:[{index:0,embedding:Array(1024).fill(0)}],usage:{prompt_tokens:287,total_tokens:287}}))});
    return {count:response.vectors.length};
  });
  assert.equal(result.count,1);assert.equal(result.debug.cloudCosts.actualCny,.00002009);
  assert.equal(result.debug.cloudCosts.theoreticalUsd,0);
  assert.equal(redis.calls.length,2);
});

test('production daily budget follows the configured day and preserves cumulative experiment keys',async()=>{
  const keys=[];
  const command=async args=>{keys.push(args[3]);return ['reserved'];};
  const dailyEnv={...env,CLOUD_BUDGET_PERIOD:'daily',API_BUDGET_TIMEZONE:'Asia/Shanghai'};
  for(const instant of ['2026-09-08T15:59:59.000Z','2026-09-08T16:00:00.000Z']) {
    const budget=createCloudRequestBudget({env:dailyEnv,command,now:new Date(instant)});
    await budget.beforeSend({operation:'embeddings',model:'synthetic',count:1});
  }
  const cumulative=createCloudRequestBudget({env,command,now:new Date('2026-09-08T16:00:00.000Z')});
  await cumulative.beforeSend({operation:'embeddings',model:'synthetic',count:1});
  assert.deepEqual(keys,['ruling-cloud-budget:v1:test-scope:2026-09-08',
    'ruling-cloud-budget:v1:test-scope:2026-09-09','ruling-cloud-budget:v1:test-scope']);
});

test('official OpenAI reservations are cumulative, include initial spend, and settle cache-write usage',async()=>{
  const calls=[];
  const command=async args=>{calls.push(args);return [args[1]===CLOUD_BUDGET_RESERVE?'reserved':'settled'];};
  const officialEnv={...env,CLOUD_BUDGET_RUN_ID:'official-public',CLOUD_BUDGET_PERIOD:'run',
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'0',CLOUD_BUDGET_THEORETICAL_LIMIT_USD:'5',
    CLOUD_BUDGET_INITIAL_ACTUAL_CNY:'0',CLOUD_BUDGET_INITIAL_THEORETICAL_USD:'0.2870175'};
  const budget=createCloudRequestBudget({env:officialEnv,command});
  await budget.openai({body,invoke:async()=>({model:'gpt-6-astra',usage:{prompt_tokens:21666,
    completion_tokens:324,total_tokens:21990,prompt_tokens_details:{cache_write_tokens:21663}}})});
  assert.equal(calls.length,2);
  assert.equal(calls[0][3],'ruling-cloud-budget:v1:official-public');
  assert.equal(calls[0][8],'5000000000');
  assert.equal(calls[0][10],'287017500');
  assert.equal(calls[1][1],CLOUD_BUDGET_SETTLE);
  assert.equal(calls[1][7].includes('"theoreticalNano":287017500'),true);
  assert.equal(budget.snapshot().theoreticalUsd,.2870175);
});

test('DeepSeek cloud budget uses busy flash rates once and retains an unknown reservation',async()=>{
  const deepSeekBody={model:'deepseek-v4-flash',messages:[{role:'user',content:'auxiliary'}],max_tokens:4096};
  const settledRedis=recorder();
  const settled=createCloudRequestBudget({env,command:settledRedis.command});
  await settled.deepseek({body:deepSeekBody,invoke:async()=>({model:deepSeekBody.model,
    usage:{prompt_tokens:1000,prompt_cache_hit_tokens:250,prompt_cache_miss_tokens:750,
      completion_tokens:100,total_tokens:1100}})});
  assert.equal(settledRedis.calls.length,2);
  assert.equal(settled.snapshot().actualCny,0.00231); // (250*0.04 + 750*2 + 100*8) / 1e6
  assert.equal(settled.snapshot().calls[0].pricingBasis,'busy_rate_estimate');

  const unknownRedis=recorder();
  const unknown=createCloudRequestBudget({env,command:unknownRedis.command});
  await assert.rejects(unknown.deepseek({body:deepSeekBody,invoke:async()=>{throw new Error('transport unknown');}}),
    /transport unknown/);
  assert.equal(unknownRedis.calls.length,1);
  assert.equal(unknown.snapshot().calls[0].status,'reserved');
  assert.equal(unknown.snapshot().calls[0].uncertainty,'request_or_settlement_failed_reservation_retained');
});

test('official OpenAI daily migration counts only dated tickets from today and leaves legacy totals untouched',async()=>{
  const now=new Date('2026-09-08T15:00:00.000Z');
  const legacyKey='ruling-cloud-budget:v1:official-public';
  const todaySettled={provider:'openai',status:'usage_settled',startedAtUtc:'2026-09-07T16:00:00.000Z',theoreticalNano:1_000_000_000};
  const todayUnknown={provider:'openai',status:'reserved',startedAtUtc:'2026-09-08T15:59:59.999Z',theoreticalNano:500_000_000};
  const yesterday={provider:'openai',status:'usage_settled',startedAtUtc:'2026-09-07T15:59:59.999Z',theoreticalNano:2_000_000_000};
  const tomorrow={provider:'openai',status:'reserved',startedAtUtc:'2026-09-08T16:00:00.000Z',theoreticalNano:2_000_000_000};
  const redis=redisFetch({[legacyKey]:{actualNano:'0',theoreticalNano:'4287017500',todaySettled:JSON.stringify(todaySettled),
    todayUnknown:JSON.stringify(todayUnknown),yesterday:JSON.stringify(yesterday),tomorrow:JSON.stringify(tomorrow)}});
  let invoked=false;
  await runOfficialOpenAIRequest({env:{PUBLIC_OPENAI_BUDGET_RUN_ID:'official-public',PUBLIC_OPENAI_DAILY_LIMIT_USD:'5',
    API_BUDGET_TIMEZONE:'Asia/Shanghai',UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'token'},
    body:{...body,max_completion_tokens:1},fetchImpl:redis.fetchImpl,now,
    invoke:async()=>{invoked=true;return {model:body.model,usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};}});
  assert.equal(invoked,true);
  const daily=redis.hashes.get('ruling-cloud-budget:v1:official-public:2026-09-08');
  assert.equal(daily.has('todaySettled'),true);assert.equal(daily.has('todayUnknown'),true);
  assert.equal(daily.has('yesterday'),false);assert.equal(daily.has('tomorrow'),false);
  assert.equal(redis.hashes.get(legacyKey).get('theoreticalNano'),'4287017500');
});

test('official daily exhaustion has a pre-dispatch-only code and transport errors retain their own identity',async()=>{
  const now=new Date('2026-09-08T12:00:00.000Z');
  const common={PUBLIC_OPENAI_BUDGET_RUN_ID:'official-limit',PUBLIC_OPENAI_DAILY_LIMIT_USD:'0.000001',
    API_BUDGET_TIMEZONE:'UTC',UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'token'};
  const redis=redisFetch();let invoked=false;
  await assert.rejects(runOfficialOpenAIRequest({env:common,body,fetchImpl:redis.fetchImpl,now,
    invoke:async()=>{invoked=true;}}),error=>error?.code==='official_daily_budget_exceeded');
  assert.equal(invoked,false);
  const transportRedis=redisFetch();
  await assert.rejects(runOfficialOpenAIRequest({env:{...common,PUBLIC_OPENAI_DAILY_LIMIT_USD:'5'},body,
    fetchImpl:transportRedis.fetchImpl,now,invoke:async()=>{throw Object.assign(new Error('transport failed'),{code:'openai_transport_failed'});}}),
  error=>error?.code==='openai_transport_failed');
});

test('official daily status reports settled and unknown reservations without network fallback',async()=>{
  let called=false;
  const missing=await getOfficialOpenAIBudgetStatus({env:{},fetchImpl:async()=>{called=true;}});
  assert.equal(called,false);assert.equal(missing.currency,'USD');assert.equal(missing.dailyBudgetAmount,5);
  assert.equal(missing.remainingAmount,null);assert.equal(missing.blocked,true);
  const key='ruling-cloud-budget:v1:official-status:2026-09-08';
  const redis=redisFetch({[key]:{actualNano:'0',theoreticalNano:'1500000000',spent:JSON.stringify({provider:'openai',
    status:'usage_settled',startedAtUtc:'2026-09-08T01:00:00.000Z',theoreticalNano:1_000_000_000}),reserved:JSON.stringify({
    provider:'openai',status:'reserved',startedAtUtc:'2026-09-08T02:00:00.000Z',theoreticalNano:500_000_000})}});
  const status=await getOfficialOpenAIBudgetStatus({env:{PUBLIC_OPENAI_BUDGET_RUN_ID:'official-status',
    UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'token',API_BUDGET_TIMEZONE:'UTC'},
    fetchImpl:redis.fetchImpl,now:new Date('2026-09-08T12:00:00.000Z')});
  assert.deepEqual(status,{currency:'USD',dailyBudgetAmount:5,remainingAmount:3.5,spentAmount:1,
    dayKey:'2026-09-08',reservedAmount:.5,blocked:false});
});

test('cloud evidence status exposes the shared Relay theoretical pool without changing SiliconFlow fields',async()=>{
  const key='ruling-cloud-budget:v1:shared-status:2026-09-08';
  const redis=redisFetch({[key]:{actualNano:'2000000000',theoreticalNano:'2750000000',
    sf:JSON.stringify({provider:'siliconflow',status:'usage_settled',actualNano:100_000_000,theoreticalNano:0}),
    deepseek:JSON.stringify({provider:'deepseek',status:'usage_settled',actualNano:200_000_000,theoreticalNano:0,
      pricingBasis:'busy_rate_estimate'}),
    relaySpent:JSON.stringify({provider:'relay',status:'usage_settled',actualNano:1_000_000_000,theoreticalNano:1_000_000_000}),
    relayReserved:JSON.stringify({provider:'relay',status:'reserved',actualNano:500_000_000,theoreticalNano:500_000_000})}});
  const status=await getCloudEvidenceBudgetStatus({env:{...env,CLOUD_BUDGET_RUN_ID:'shared-status',CLOUD_BUDGET_PERIOD:'daily',
    API_BUDGET_TIMEZONE:'UTC',UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'token'},
    fetchImpl:redis.fetchImpl,now:new Date('2026-09-08T12:00:00.000Z')});
  assert.equal(status.spentTodayCny,.3);assert.equal(status.reservedTodayCny,0);assert.equal(status.dailyBudgetCny,10);
  assert.deepEqual(status.relayPool,{spentUsd:1,reservedUsd:.5,theoreticalLimitUsd:5,
    accountedUsd:2.75,actualRemainingCny:8});
});

test('deepseek and glm keep their existing provider preflight inside the cloud request scope',async()=>{
  for(const provider of ['deepseek','glm']) {
    const budget={snapshot:()=>({provider}),relay:()=>{},beforeSend:()=>{},onResponse:()=>{}};
    const result=await runCloudBudgetedQuestion({env:{RAG_MODEL_PROVIDER:provider},budget},async()=>({answer:provider}));
    assert.equal(result.answer,provider);
  }
});

test('concurrent official requests reserve before dispatch and unknown usage retains its reservation',async()=>{
  const calls=[];
  const command=async args=>{calls.push(args);return args[1]===CLOUD_BUDGET_RESERVE?['reserved']:['settled'];};
  const budget=createCloudRequestBudget({env:{...env,CLOUD_BUDGET_RUN_ID:'official-concurrency',
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'0'},command});
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const first=budget.openai({body,invoke:async()=>{await gate;return {model:'gpt-6-astra'};}});
  const second=budget.openai({body,invoke:async()=>({model:'gpt-6-astra'})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(args=>args[1]===CLOUD_BUDGET_RESERVE).length,2);
  release();
  await Promise.all([first,second]);
  assert.equal(calls.filter(args=>args[1]===CLOUD_BUDGET_SETTLE).length,0);
  assert.equal(budget.snapshot().calls.every(call=>call.status==='reserved'),true);
});

test('the real public environment retains only the non-secret Relay rates needed by auxiliary reservations',async()=>{
  const publicEnv=createPublicAnswerModelEnv({...env,RELAY_API_KEY:'relay-secret',
    RELAY_BASE_URL:'https://relay.example.test/v1',OCG_FINAL_OPENAI_API_KEY:'official-secret'},
  'official-astra-low');
  assert.equal(publicEnv.RELAY_API_KEY,undefined);
  assert.equal(publicEnv.RELAY_BASE_URL,undefined);
  assert.equal(publicEnv.RELAY_PRICING_MULTIPLIER,'0.27');
  assert.equal(publicEnv.RELAY_SITE_DOLLAR_CNY,'1');
  const redis=recorder();
  const budget=createCloudRequestBudget({env:publicEnv,command:redis.command});
  let invoked=false;
  await budget.relay({body,invoke:async()=>{invoked=true;return {model:body.model,
    usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};}});
  assert.equal(invoked,true);
  assert.equal(redis.calls.length,2);
});
