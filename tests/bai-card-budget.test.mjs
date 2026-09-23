import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudRequestBudget, CLOUD_BUDGET_RESERVE, runCloudBudgetedQuestion,
  runCloudBaiCardRequest } from '../backend/cloudRequestBudget.mjs';

const env={CLOUD_BUDGET_RUN_ID:'bai-card-test',CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'1',
  CLOUD_BUDGET_THEORETICAL_LIMIT_USD:'1'};
const body={model:'gpt-6-luna',input:[{role:'user',content:'synthetic card input'}],
  reasoning:{effort:'none'},max_output_tokens:800};
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
    await runCloudBaiCardRequest({body,invoke:async()=>({model:body.model,
      usage:{input_tokens:1000,output_tokens:100,total_tokens:1100,
        input_tokens_details:{cached_tokens:200}}})});
    return {};
  });
  const costs=result.debug.cloudCosts;
  assert.equal(costs.calls[0].provider,'bai');
  assert.equal(costs.calls[0].stage,'evidence_preparation');
  assert.equal(costs.calls[0].operation,'responses');
  assert.equal(costs.calls[0].model,'gpt-6-luna');
  assert.equal(costs.calls[0].pricingBasis,'bai_gpt6_luna_context_tiered_theoretical_20260923');
  assert.equal(costs.calls[0].actualCny,null);
  assert.equal(costs.actualCostKnown,false);
  assert.ok(Math.abs(costs.theoreticalUsd-0.000132)<1e-9);
  assert.equal(costs.actualCny,0);
});
test('B.AI card failures retain USD reservations and exhausted budget prevents dispatch',async()=>{
  const {budget}=controller();
  await assert.rejects(budget.baiCard({body,invoke:async()=>{throw Error('timeout');}}),/timeout/);
  assert.ok(budget.snapshot().reservedTheoreticalUsd>0);
  assert.equal(budget.snapshot().reservedCny,0);
  const blocked=controller(true);let calls=0;
  await assert.rejects(blocked.budget.baiCard({body,invoke:async()=>{calls++;}}),/total_exceeded/);
  assert.equal(calls,0);
});
test('B.AI Luna card usage is required for settlement and model binding remains exact',async()=>{
  const missing=controller();
  await missing.budget.baiCard({body,invoke:async()=>({model:body.model,usage:{input_tokens:100}})});
  assert.equal(missing.budget.snapshot().theoreticalUsd,0);
  assert.ok(missing.budget.snapshot().reservedTheoreticalUsd>0);
  assert.equal(missing.budget.snapshot().calls[0].uncertainty,'provider_usage_missing_reservation_retained');
  const mismatch=controller();
  await assert.rejects(mismatch.budget.baiCard({body,invoke:async()=>({model:'other-model',
    usage:{input_tokens:100,output_tokens:10}})}),/bai_card_returned_model_mismatch/);
  assert.ok(mismatch.budget.snapshot().reservedTheoreticalUsd>0);
});
test('B.AI Luna card request requires a priced model and explicit output reservation',async()=>{
  const {budget,commands}=controller();let calls=0;
  for(const invalid of [{...body,model:'other-model'},{...body,max_output_tokens:undefined}]) {
    await assert.rejects(budget.baiCard({body:invalid,invoke:async()=>{calls++;}}),/model_price_missing|explicit_output_limit_required/);
  }
  assert.equal(calls,0);
  assert.equal(commands.length,0);
});
test('B.AI Luna long-context pricing uses the whole request and counts each cache write once',async()=>{
  const cases=[
    {input:272000,details:{cached_tokens:2000,cache_write_tokens:1000},expected:0.027095},
    {input:272001,details:{cached_tokens:2000,cache_write_tokens:1000},expected:0.0541652},
    {input:272001,details:{cached_tokens:2000,cache_write_input_tokens:1000},expected:0.0541652},
    {input:272001,details:{cached_tokens:2000},extra:{cache_write_tokens:1000},expected:0.0541652},
    {input:272001,details:{cached_tokens:2000},extra:{cache_write_input_tokens:1000},expected:0.0541652},
    {input:272001,details:{cached_tokens:2000,cache_write_tokens:1000},
      extra:{cache_write_tokens:1000,cache_write_input_tokens:1000},expected:0.0541652},
  ];
  for(const item of cases) {
    const {budget}=controller();
    await budget.baiCard({body,invoke:async()=>({model:body.model,usage:{
      input_tokens:item.input,output_tokens:100,input_tokens_details:item.details,...item.extra}})});
    assert.ok(Math.abs(budget.snapshot().theoreticalUsd-item.expected)<1e-9,JSON.stringify(item));
  }
  const {budget,commands}=controller();
  const longBody={...body,input:'x'.repeat(272001)};
  await budget.baiCard({body:longBody,invoke:async()=>({model:body.model})});
  const reserved=JSON.parse(commands[0].at(-1));
  const bytes=Buffer.byteLength(JSON.stringify(longBody),'utf8');
  assert.equal(reserved.theoreticalNano,Math.ceil((bytes*0.125*2+800*0.50*1.5)*1000));
  assert.ok(budget.snapshot().reservedTheoreticalUsd>0);
});
test('default official DeepSeek accounting remains in its original CNY pool',async()=>{
  const {budget}=controller();
  const officialBody={model:'deepseek-v4.1-flash',messages:[{role:'user',content:'synthetic card input'}],max_tokens:800};
  await budget.deepseek({body:officialBody,invoke:async()=>({model:officialBody.model,
    usage:{prompt_tokens:1000,prompt_cache_hit_tokens:200,completion_tokens:100,total_tokens:1100}})});
  assert.equal(budget.snapshot().calls[0].provider,'deepseek');
  assert.equal(budget.snapshot().theoreticalUsd,0);
  assert.ok(Math.abs(budget.snapshot().actualCny-.002408)<1e-9);
});
