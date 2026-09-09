import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudRequestBudget,CLOUD_BUDGET_RESERVE,CLOUD_BUDGET_SETTLE,runCloudBudgetedQuestion,
  runCloudRelayRequest,cloudSiliconFlowCallbacks} from '../backend/cloudRequestBudget.mjs';
import {callSiliconFlowEmbeddings} from '../backend/siliconFlowEvidenceClient.mjs';
import {createPublicAnswerModelEnv} from '../backend/ragModelClient.mjs';

const env={CLOUD_BUDGET_RUN_ID:'test-scope',CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'10',
  CLOUD_BUDGET_THEORETICAL_LIMIT_USD:'5',CLOUD_BUDGET_INITIAL_ACTUAL_CNY:'0.00062622',
  RELAY_PRICING_MULTIPLIER:'0.27',RELAY_SITE_DOLLAR_CNY:'1'};
const body={model:'gpt-6-astra',messages:[{role:'user',content:'synthetic request'}],max_completion_tokens:4096};
function recorder({block=false}={}) {
  const calls=[];
  return {calls,command:async args=>{
    calls.push(args);
    assert.equal(args[0],'EVAL');assert.equal(args[2],'1');
    assert.equal(args[3],'ruling-cloud-budget:v1:test-scope');
    return [args[1]===CLOUD_BUDGET_RESERVE?(block?'blocked':'reserved'):'settled'];
  }};
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
