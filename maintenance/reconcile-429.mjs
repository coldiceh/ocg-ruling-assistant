import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const batch='64198715d3c7819a53a7128bba8998eac5915ab33ee82874148fefec16591d1c';
const namespace='ocg-daily-sync-20260920';
const budgetKey=`evidence-sync-batch:v1:{${namespace}}:${batch}`;
const planField='repair:confirmed-429:35549293738:plan';
const doneField='repair:confirmed-429:35549293738:complete';
const releaseScript=`-- CONFIRMED_429_RELEASE_V1
if redis.call('EXISTS',KEYS[2])==1 or redis.call('EXISTS',KEYS[3])==1 then return 'HAS_RESULT' end
local claim=redis.call('GET',KEYS[1]);if not claim then return 'ALREADY_RELEASED' end
if claim~=ARGV[1] then return 'OWNER_CHANGED' end
redis.call('DEL',KEYS[1]);return 'RELEASED'`;
const settleScript=`-- CONFIRMED_429_SETTLE_V1
if redis.call('HGET',KEYS[1],ARGV[1])~=ARGV[2] then return 'PLAN_CHANGED' end
if redis.call('HGET',KEYS[1],'limit')~='1000000000' or redis.call('HGET',KEYS[1],'seed')~='663648750' or redis.call('HGET',KEYS[1],'spent')~='690985757' then return 'BUDGET_CHANGED' end
local r='r:'..ARGV[3];local s='s:'..ARGV[3]
if redis.call('HGET',KEYS[1],r)=='163840000' and redis.call('HGET',KEYS[1],'held')=='163840000' and not redis.call('HGET',KEYS[1],s) then
redis.call('HDEL',KEYS[1],r);redis.call('HSET',KEYS[1],s,0,'held',0,ARGV[4],'confirmed_http_429_reservation_released');return 'RELEASED'
end
if not redis.call('HGET',KEYS[1],r) and redis.call('HGET',KEYS[1],s)=='0' and redis.call('HGET',KEYS[1],'held')=='0' then return 'ALREADY_RELEASED' end
return 'RESERVATION_CHANGED'`;
function hashObject(value){if(Array.isArray(value))return Object.fromEntries(Array.from({length:value.length/2},(_,i)=>[value[2*i],String(value[2*i+1])]));return value;}
export async function reconcileRejectedBatch({command,proof}){
 assert.equal(proof.error,'gemini_embedding_http_429');assert.equal(proof.status,'failed');
 assert.equal(proof.cost.requestsAttempted,23);assert.equal(proof.cost.unknownCostRequests,1);assert.equal(proof.cost.knownCostUsd,0.027337);
 assert.equal(proof.batchBudget.batchId,batch);assert.equal(proof.batchBudget.spentUsd,0.690985757);assert.equal(proof.batchBudget.reservedUsd,0.16384);
 let state=hashObject(await command(['HGETALL',budgetKey]));
 if(state[doneField])return {status:'already_reconciled',spentUnchanged:true,modelsCalled:0};
 assert.equal(state.limit,'1000000000');assert.equal(state.seed,'663648750');assert.equal(state.spent,'690985757');assert.equal(state.held,'163840000');
 const holds=Object.entries(state).filter(([k])=>k.startsWith('r:'));assert.equal(holds.length,1);assert.equal(holds[0][1],'163840000');
 const ticket=holds[0][0].slice(2), match=ticket.match(/^dense-(rule|qa)-([a-f0-9]{64})$/);assert.ok(match,'unexpected legacy ticket');
 const batchClaimKey=`evidence-preprocess:dense-batch:{${match[2]}}:${namespace}:claim`;
 let plan=state[planField] ? JSON.parse(state[planField]) : null;
 if(!plan){
   const batchClaim=await command(['GET',batchClaimKey]);assert.ok(batchClaim);assert.equal(JSON.parse(batchClaim).ticket,ticket);
   let cursor='0',seen=new Set(),claims=[],pages=0;
   do{const scan=await command(['SCAN',cursor,'MATCH',`evidence-preprocess:dense:*:${namespace}:claim`,'COUNT','500']);assert.ok(Array.isArray(scan)&&Array.isArray(scan[1]));cursor=String(scan[0]);assert.ok(++pages<=2000);
    const keys=scan[1].filter(k=>!seen.has(k));keys.forEach(k=>seen.add(k));
    for(let o=0;o<keys.length;o+=64){const slice=keys.slice(o,o+64),values=await command(['MGET',...slice]);assert.equal(values.length,slice.length);values.forEach((v,i)=>{if(v&&JSON.parse(v).ticket===ticket){assert.deepEqual(JSON.parse(v),JSON.parse(batchClaim));claims.push({key:slice[i],value:v});}});}
   }while(cursor!=='0');
   assert.equal(claims.length,100,'do not clear an unidentified or partially unrelated request');claims.push({key:batchClaimKey,value:batchClaim});
   for(const c of claims){const values=await command(['MGET',c.key.replace(/:claim$/,':raw'),c.key.replace(/:claim$/,':result')]);assert.ok(values.every(v=>v===null),'paid response exists; do not release');}
   plan={runId:35549293738,jobId:106180948122,ticket,reason:'terminal_http_429',proofSha256:createHash('sha256').update(JSON.stringify(proof)).digest('hex'),claims};
   assert.equal(await command(['HSETNX',budgetKey,planField,JSON.stringify(plan)]),1,'concurrent recovery plan');
 }
 assert.equal(plan.ticket,ticket);assert.equal(plan.claims.length,101);assert.equal(plan.reason,'terminal_http_429');
 for(const c of plan.claims){assert.ok(c.key.endsWith(`:${namespace}:claim`));assert.equal(JSON.parse(c.value).ticket,ticket);const status=await command(['EVAL',releaseScript,'3',c.key,c.key.replace(/:claim$/,':raw'),c.key.replace(/:claim$/,':result'),c.value]);assert.ok(['RELEASED','ALREADY_RELEASED'].includes(status),`claim reconciliation stopped: ${status}`);}
 const status=await command(['EVAL',settleScript,'1',budgetKey,planField,JSON.stringify(plan),ticket,doneField]);assert.ok(['RELEASED','ALREADY_RELEASED'].includes(status),`budget reconciliation stopped: ${status}`);
 state=hashObject(await command(['HGETALL',budgetKey]));assert.equal(state.spent,'690985757');assert.equal(state.held,'0');assert.equal(state.limit,'1000000000');
 return {status:'reconciled_confirmed_http_429',runId:35549293738,claimCount:plan.claims.length,spentUsd:Number(state.spent)/1e9,releasedReservationUsd:0.16384,remainingUsd:0.309014243,modelsCalled:0,invoiceReconciliation:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const {createUpstashRedisCommand}=await import('../scripts/lib/evidence-preprocess-cloud.mjs');
 const command=createUpstashRedisCommand({url:process.env.UPSTASH_BUDGET_KV_REST_API_URL,token:process.env.UPSTASH_BUDGET_KV_REST_API_TOKEN});
 const proof=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
 const result=await reconcileRejectedBatch({command,proof});
 await fs.writeFile(process.argv[3],JSON.stringify(result,null,2));console.log('RECONCILED_429 '+JSON.stringify(result));
}
