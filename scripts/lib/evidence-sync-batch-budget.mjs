import { setTimeout as delay } from 'node:timers/promises';
const SCALE = 1e9;
export const BATCH_SCRIPT = `
-- SYNC_BATCH_BUDGET_V1: atomic integer nano-USD, not the old JSON ledger
local k=KEYS[1]
local op=ARGV[1]
local lim=tonumber(ARGV[2])
local batch=ARGV[3]
local seed=tonumber(ARGV[6])
local schema=redis.call('HGET',k,'schema')
if not schema then
 redis.call('HSET',k,'schema','1','batch',batch,'limit',lim,'spent',seed,'held',0,'seed',seed)
elseif schema~='1' or redis.call('HGET',k,'batch')~=batch or tonumber(redis.call('HGET',k,'limit'))~=lim or tonumber(redis.call('HGET',k,'seed'))~=seed then
 return {'CONFIG_CONFLICT'}
end
local spent=tonumber(redis.call('HGET',k,'spent'))
local held=tonumber(redis.call('HGET',k,'held'))
if not spent or not held or spent<0 or held<0 then return {'INVALID_STATE'} end
local function result(status) return {status,tostring(spent),tostring(held),tostring(lim)} end
if op=='read' then return result('OK') end
local ticket=ARGV[4]
local amount=tonumber(ARGV[5])
if ticket=='' or not amount or amount<0 or amount~=math.floor(amount) then return {'INVALID_REQUEST'} end
local r='r:'..ticket
local s='s:'..ticket
local reserved=redis.call('HGET',k,r)
local settled=redis.call('HGET',k,s)
if op=='reserve' then
 if reserved or settled then return result('EXISTING') end
 if spent+held+amount>lim then return result('BLOCKED') end
 held=held+amount
 redis.call('HSET',k,r,amount,'held',held)
 return result('RESERVED')
elseif op=='settle' then
 if settled then
  if tonumber(settled)~=amount then return result('SETTLEMENT_CONFLICT') end
  return result('SETTLED')
 end
 if not reserved then return result('HISTORICAL_IGNORED') end
 held=held-tonumber(reserved)
 spent=spent+amount
 redis.call('HDEL',k,r)
 redis.call('HSET',k,s,amount,'spent',spent,'held',held)
 return result('SETTLED')
end
return {'INVALID_OPERATION'}
`;
const fail=(code,exitCode=3)=>Object.assign(new Error(code),{code,exitCode});
function nano(value) {
 const n=Math.ceil(value*SCALE);
 if(!Number.isFinite(value)||value<0||!Number.isSafeInteger(n))throw fail('sync_batch_amount_invalid',2);
 return n;
}
export function quoteNavigation(contract, request = null) {
 const p=contract.pricingContract, c=contract.capacityContract;
 // The old bytes/3 measurement is an estimate, not a spending upper bound.
 const rate=Math.max(p.inputUsdPerMillion,p.cachedInputUsdPerMillion,p.cacheWriteUsdPerMillion??p.inputUsdPerMillion);
 // Full serialized wire bytes plus framing allowance, not an average bytes/token guess.
 // This is a conservative configured-rate allocation, not a supplier billing guarantee.
 const wireBytes = request?.body ? Buffer.byteLength(JSON.stringify(request.body), 'utf8') : null;
 const inputTokens = wireBytes === null ? c.maxInputTokens
   : Math.min(c.maxInputTokens, Math.max(wireBytes + 1024, Number(request?.measurement?.inputTokensUpperBound || 0)));
 const amount=(inputTokens*rate+contract.maxBillableOutputTokens*p.outputUsdPerMillion)/1e6;
 if(!Number.isFinite(amount)||amount<=0)throw fail('sync_batch_quote_unavailable',2);
 return amount;
}
export async function createSyncBatchBudget({command,namespace,batchId,limitUsd=1,initialSpentUsd=0,costReporter,onProgress=()=>{}}) {
 if(typeof command!=='function'||!/^[a-zA-Z0-9._-]{1,160}$/.test(namespace||'')||!/^[a-f0-9]{64}$/.test(batchId||'')||!(limitUsd>0&&limitUsd<=1))throw fail('sync_batch_configuration_invalid',2);
 const limit=nano(limitUsd),seed=nano(initialSpentUsd);
 const key=`evidence-sync-batch:v1:{${namespace}}:${batchId}`;
 const live=new Set(), settlements=new Map();let version=0,stopped=false;
 let state={batchId,limitUsd,carriedCostUsd:initialSpentUsd,spentUsd:initialSpentUsd,reservedUsd:0,remainingUsd:Math.max(0,limitUsd-initialSpentUsd),blocked:false,accountingBasis:'configured_rates_not_supplier_invoice'};
 const notify=()=>onProgress({budget:{...state},activeRequests:live.size});
 const stop=()=>{stopped=true;version++;};
 async function operate(op,ticket='',amount=0) {
  try {
   const r=await command(['EVAL',BATCH_SCRIPT,'1',key,op,String(limit),batchId,ticket,String(amount),String(seed)]);
   if(!Array.isArray(r)||r.length!==4)throw fail(`sync_batch_${String(r?.[0]||'invalid_response').toLowerCase()}`,2);
   const [spent,held,l]=r.slice(1).map(Number);
   if(![spent,held,l].every(Number.isSafeInteger)||spent<0||held<0||l!==limit)throw fail('sync_batch_invalid_response',2);
   state={...state,spentUsd:spent/SCALE,reservedUsd:held/SCALE,remainingUsd:Math.max(0,(limit-spent-held)/SCALE)};
   notify();return r[0];
  }catch(e){stop();throw e;}
 }
 await operate('read');
 async function settle({ticket,spentUsd}) {
  nano(spentUsd);
  const prior = settlements.get(ticket);
  if(prior){if(prior.amount!==spentUsd){stop();throw fail('sync_batch_settlement_conflict',2);}return prior.promise;}
  const promise = settleOnce({ticket,spentUsd});
  settlements.set(ticket,{amount:spentUsd,promise});
  try{return await promise;}catch(error){settlements.delete(ticket);throw error;}
 }
 async function settleOnce({ticket,spentUsd}) {
  try {
   const status=await operate('settle',ticket,nano(spentUsd));
   if(!['SETTLED','HISTORICAL_IGNORED'].includes(status))throw fail(`sync_batch_${status.toLowerCase()}`,2);
   live.delete(ticket);version++;
   await costReporter?.settle({ticket,spentUsd});notify();
   return {status:status.toLowerCase()};
  }catch(e){stop();throw e;}
 }
 return Object.freeze({
  kind:'evidence-sync-batch-budget',reportOnly:false,quoteNavigation,
  snapshot:()=>({...state}),stop,
  async reserve({ticket,amountUsd,providerId,modelId}) {
   const amount=nano(amountUsd);if(!ticket||amount<=0)throw fail('sync_batch_reservation_invalid',2);
   for(;;){
    if(stopped)throw fail('sync_batch_stopped');
    const before=version,status=await operate('reserve',ticket,amount);
    if(status==='RESERVED'){
     live.add(ticket);version++;await costReporter?.reserve({ticket,providerId,modelId});notify();return {status:'reserved',ticket};
    }
    if(status!=='BLOCKED'){stop();throw fail(`sync_batch_${status.toLowerCase()}_request`,2);}
    if(live.size&&amount<=nano(Math.max(0,state.limitUsd-state.spentUsd))){
     while(before===version&&live.size&&!stopped)await delay(100);
     continue;
    }
    state={...state,blocked:true,nextReservationUsd:amount/SCALE};notify();
    throw fail('evidence_preprocess_budget_exceeded');
   }
  },
  async recordUsage({ticket,usage}){
   await costReporter?.recordUsage({ticket,usage});const c=usage?.billableCost;
   if(c?.status==='known'&&Number.isFinite(c.amountUsd)&&c.amountUsd>=0)return settle({ticket,spentUsd:c.amountUsd});
   live.delete(ticket);version++;notify();return {status:'unknown_reservation_retained'};
  },
  async recordRejectedAttempt(value){await costReporter?.recordRejectedAttempt?.(value);},
  async markRequestUnknown(ticket){live.delete(ticket);version++;notify();},
  settle,async refresh(){await operate('read');return {...state};},
 });
}
