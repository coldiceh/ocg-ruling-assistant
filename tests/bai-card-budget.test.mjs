import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudRequestBudget, CLOUD_BUDGET_RESERVE, runCloudBudgetedQuestion,
  runCloudDeepSeekRequest } from '../backend/cloudRequestBudget.mjs';

const env={CLOUD_BUDGET_RUN_ID:'bai-card-test',CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'1',
  CLOUD_BUDGET_THEORETICAL_LIMIT_USD:'1'};
const body={model:'deepseek-v4.1-flash',messages:[{role:'user',content:'synthetic card input'}],max_tokens:800};
function controller(block=false) {
  const commands=[];
  return {commands,budget:createCloudRequestBudget({env,command:async args=>{
    commands.push(args);
    return [args[1]===CLOUD_BUDGET_RESERVE?(block?'blocked':'reserved'):'settled'];
  }})};
}
test('B.AI card calls are preparation USD estimates and never official CNY or final calls',async()=>{
  const {budget}=controller();
  const result=await runCloudBudgetedQuestion({env,budget},async()=>{
    await runCloudDeepSeekRequest({body,channel:'bai',invoke:async()=>({model:body.model,
      usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100,
        prompt_tokens_details:{cached_tokens:200}}})});
    return {};
  });
  const costs=result.debug.cloudCosts;
  assert.equal(costs.calls[0].provider,'bai');
  assert.equal(costs.calls[0].stage,'evidence_preparation');
  assert.equal(costs.calls[0].pricingBasis,'bai_deepseek_busy_list_upper_usd');
  assert.equal(costs.calls[0].actualCny,null);
  assert.equal(costs.actualCostKnown,false);
  assert.ok(Math.abs(costs.theoreticalUsd-0.0003612)<1e-9);
  assert.equal(costs.actualCny,0);
});
test('B.AI card failures retain USD reservations and exhausted budget prevents dispatch',async()=>{
  const {budget}=controller();
  await assert.rejects(budget.deepseek({body,channel:'bai',invoke:async()=>{throw Error('timeout');}}),/timeout/);
  assert.ok(budget.snapshot().reservedTheoreticalUsd>0);
  assert.equal(budget.snapshot().reservedCny,0);
  const blocked=controller(true);let calls=0;
  await assert.rejects(blocked.budget.deepseek({body,channel:'bai',invoke:async()=>{calls++;}}),/total_exceeded/);
  assert.equal(calls,0);
});
test('default official DeepSeek accounting remains in its original CNY pool',async()=>{
  const {budget}=controller();
  await budget.deepseek({body,invoke:async()=>({model:body.model,
    usage:{prompt_tokens:1000,prompt_cache_hit_tokens:200,completion_tokens:100,total_tokens:1100}})});
  assert.equal(budget.snapshot().calls[0].provider,'deepseek');
  assert.equal(budget.snapshot().theoreticalUsd,0);
  assert.ok(Math.abs(budget.snapshot().actualCny-.002408)<1e-9);
});
