import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudRequestBudget,CLOUD_BUDGET_RESERVE,CLOUD_BUDGET_SETTLE,runCloudBudgetedQuestion,
  runCloudRelayRequest,cloudSiliconFlowCallbacks} from '../backend/cloudRequestBudget.mjs';
import {callSiliconFlowEmbeddings} from '../backend/siliconFlowEvidenceClient.mjs';

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
