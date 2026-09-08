import assert from 'node:assert/strict';
import test from 'node:test';
import {getRagBudgetStatus,resetRagBudget,capPublicChatGptBudget} from '../backend/ragModelClient.mjs';

const now=new Date('2061-03-04T12:00:00.000Z');
const day='2061-03-04';
const baseEnv={API_BUDGET_TIMEZONE:'UTC',API_DAILY_BUDGET_CNY:'10',API_CHATGPT_DAILY_BUDGET_USD:'5',
  KV_REST_API_URL:'https://namespace-kv.example.test',KV_REST_API_TOKEN:'synthetic-test-token'};

function commandRecorder(){
  const commands=[];
  return {commands,fetchImpl:async(url,options)=>{
    assert.equal(String(url),baseEnv.KV_REST_API_URL);
    const command=JSON.parse(options.body);
    commands.push(command);
    assert.ok(['GET','SET','DEL','EVAL'].includes(command[0]));
    return new Response(JSON.stringify({result:'0'}),{status:200,headers:{'content-type':'application/json'}});
  }};
}

function commandKeys(commands){
  return commands.flatMap(command=>command[0]==='EVAL'
    ?command.slice(3,3+Number(command[2]))
    :command[0]==='DEL'?command.slice(1):[command[1]]);
}

for(const [label,action] of [['status',getRagBudgetStatus],['reset',resetRagBudget],['close',capPublicChatGptBudget]]){
  test(`configured namespace isolates every Redis key for ${label}, including closed and migration keys`,async()=>{
    const namespace='cloud_run_alpha';
    const redis=commandRecorder();
    await action({env:{...baseEnv,API_BUDGET_NAMESPACE:namespace},now,fetchImpl:redis.fetchImpl});
    const keys=commandKeys(redis.commands);
    assert.ok(keys.length>0);
    for(const key of keys){
      assert.match(key,/^rag-api-budget:(?:(?:v2|v3):)?cloud_run_alpha:/u,
        `Redis ${label} crossed the configured namespace: ${key}`);
    }
    assert.ok(keys.includes(`rag-api-budget:v3:${namespace}:${day}:final_ruling:relay:manually-closed`));
    assert.equal(keys.some(key=>key.startsWith(`rag-api-budget:v3:${day}:`)),false);
    assert.equal(keys.some(key=>key.startsWith(`rag-api-budget:v2:${day}:`)),false);
    assert.equal(keys.includes(`rag-api-budget:${day}`),false);
  });
}

test('different namespaces use disjoint keys on the same day',async()=>{
  const keySets=[];
  for(const namespace of ['cloud_run_alpha','cloud_run_beta']){
    const redis=commandRecorder();
    await getRagBudgetStatus({env:{...baseEnv,API_BUDGET_NAMESPACE:namespace},now,fetchImpl:redis.fetchImpl});
    await capPublicChatGptBudget({env:{...baseEnv,API_BUDGET_NAMESPACE:namespace},now,fetchImpl:redis.fetchImpl});
    keySets.push(new Set(commandKeys(redis.commands)));
  }
  assert.equal([...keySets[0]].some(key=>keySets[1].has(key)),false);
});

test('missing namespace preserves exact existing public and legacy migration key names',async()=>{
  const redis=commandRecorder();
  for(const action of [getRagBudgetStatus,resetRagBudget,capPublicChatGptBudget]){
    await action({env:baseEnv,now,fetchImpl:redis.fetchImpl});
  }
  const keys=new Set(commandKeys(redis.commands));
  const expected=new Set([
    `rag-api-budget:${day}`,
    `rag-api-budget:v3:${day}:cny-total`,
    `rag-api-budget:v3:${day}:cny-total:legacy-watermark`,
    `rag-api-budget:v3:${day}:final_ruling:relay:manually-closed`,
  ]);
  for(const [bucket,currency] of [['evidence_preparation:deepseek','cny'],['final_ruling:deepseek','cny'],
    ['final_ruling:glm','cny'],['final_ruling:relay','usd']]){
    const current=`rag-api-budget:v3:${day}:${bucket}:${currency}`;
    expected.add(current);expected.add(`${current}:legacy-watermark`);
    expected.add(`rag-api-budget:v2:${day}:${bucket}`);
  }
  assert.deepEqual([...keys].sort(),[...expected].sort());
  assert.ok(redis.commands.some(command=>command[0]==='EVAL'&&command[2]==='4'
    &&command[3]===`rag-api-budget:v3:${day}:final_ruling:relay:usd`
    &&command[4]===`rag-api-budget:v2:${day}:final_ruling:relay`
    &&command[6]===`rag-api-budget:v3:${day}:final_ruling:relay:manually-closed`));
});
