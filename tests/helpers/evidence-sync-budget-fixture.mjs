import assert from 'node:assert/strict';
import {BATCH_SCRIPT} from '../../scripts/lib/evidence-sync-batch-budget.mjs';
export function fakeBatchRedis(){
 const states=new Map();const command=async args=>{
  assert.equal(args[0],'EVAL');assert.equal(args[1],BATCH_SCRIPT);assert.equal(args[2],'1');
  const [,,,key,op,ls,batch,ticket,as,ss]=args;const limit=Number(ls),amount=Number(as),seed=Number(ss);
  let s=states.get(key);if(!s){s={batch,limit,seed,spent:seed,held:0,r:new Map(),s:new Map()};states.set(key,s);}
  if(s.batch!==batch||s.limit!==limit||s.seed!==seed)return ['CONFIG_CONFLICT'];
  const result=status=>[status,String(s.spent),String(s.held),String(s.limit)];
  if(op==='read')return result('OK');
  if(op==='reserve'){if(s.r.has(ticket)||s.s.has(ticket))return result('EXISTING');if(s.spent+s.held+amount>limit)return result('BLOCKED');s.r.set(ticket,amount);s.held+=amount;return result('RESERVED');}
  assert.equal(op,'settle');if(s.s.has(ticket))return result(s.s.get(ticket)===amount?'SETTLED':'SETTLEMENT_CONFLICT');if(!s.r.has(ticket))return result('HISTORICAL_IGNORED');s.held-=s.r.get(ticket);s.r.delete(ticket);s.s.set(ticket,amount);s.spent+=amount;return result('SETTLED');
 };return {states,command};
}
