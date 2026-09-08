import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { estimateOpenAIModelCost, estimateRelayModelCost, getModelPricingConfig } from './modelPricing.mjs';

const scope = new AsyncLocalStorage();
const UNIT = 1_000_000_000;
// Mechanical invariant: every actual dispatch holds a durable reservation in
// both authorized currencies. Signals are amounts, limits, request IDs and
// provider usage; no evidence or answer meaning is inspected. A conservative
// false positive prevents a call, never replaces its answer. Existing daily
// accounting cannot enforce this cross-provider, cross-day experiment limit.
export const CLOUD_BUDGET_RESERVE = `
local old = redis.call('HGET', KEYS[1], ARGV[1])
if old then return {'existing', old} end
local cny = tonumber(redis.call('HGET', KEYS[1], 'actualNano') or ARGV[6])
local usd = tonumber(redis.call('HGET', KEYS[1], 'theoreticalNano') or ARGV[7])
local nextCny = cny + tonumber(ARGV[2])
local nextUsd = usd + tonumber(ARGV[3])
if nextCny > tonumber(ARGV[4]) or nextUsd > tonumber(ARGV[5]) then
  return {'blocked', tostring(cny), tostring(usd)}
end
redis.call('HSET', KEYS[1], 'actualNano', tostring(nextCny), 'theoreticalNano', tostring(nextUsd), ARGV[1], ARGV[8])
return {'reserved', tostring(nextCny), tostring(nextUsd)}
`;
export const CLOUD_BUDGET_SETTLE = `
local old = redis.call('HGET', KEYS[1], ARGV[1])
if not old then return {'missing'} end
local ticket = cjson.decode(old)
if ticket.status ~= 'reserved' then return {'settled', old} end
local cny = tonumber(redis.call('HGET', KEYS[1], 'actualNano')) + tonumber(ARGV[2]) - ticket.actualNano
local usd = tonumber(redis.call('HGET', KEYS[1], 'theoreticalNano')) + tonumber(ARGV[3]) - ticket.theoreticalNano
redis.call('HSET', KEYS[1], 'actualNano', tostring(cny), 'theoreticalNano', tostring(usd), ARGV[1], ARGV[4])
return {'settled', tostring(cny), tostring(usd)}
`;

function amount(value, label, allowZero = false) {
  if(value===null || value===undefined || value==='') throw new Error(`cloud_budget_invalid_${label}`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) throw new Error(`cloud_budget_invalid_${label}`);
  return number;
}
function nano(value) { return Math.ceil(value * UNIT); }
function redisConfig(env) {
  for (const [url, token] of [
    ['UPSTASH_BUDGET_KV_REST_API_URL','UPSTASH_BUDGET_KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN'],
    ['KV_REST_API_URL','KV_REST_API_TOKEN'],
    ['REDIS_REST_API_URL','REDIS_REST_API_TOKEN'],
  ]) if (env[url] && env[token]) return {url:env[url],token:env[token]};
  throw new Error('cloud_budget_persistent_store_required');
}
function usagePresent(usage) {
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  const output = usage?.completion_tokens ?? usage?.output_tokens;
  return Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0
    && input + output > 0
    && (usage.total_tokens === undefined || usage.total_tokens === input + output);
}

function cloudBudgetScope(env, now) {
  const namespace = String(env.CLOUD_BUDGET_RUN_ID || '');
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(namespace)) throw new Error('cloud_budget_run_id_required');
  // Production may reuse its daily allowance. Experiment scopes stay cumulative.
  // The observable invariant is the Redis key's configured calendar day; no
  // request content is interpreted and existing run balances are not reset.
  const period = String(env.CLOUD_BUDGET_PERIOD || 'run');
  if (!['run','daily'].includes(period)) throw new Error('cloud_budget_invalid_period');
  const day = period === 'daily' ? Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: env.API_BUDGET_TIMEZONE || 'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit',
  }).formatToParts(now).map(part=>[part.type,part.value])) : null;
  const dayKey = day ? `${day.year}-${day.month}-${day.day}` : null;
  const key = `ruling-cloud-budget:v1:${namespace}${dayKey ? `:${dayKey}` : ''}`;
  return {namespace, period, dayKey, key};
}

// Read the same durable tickets used by the production dispatcher. Only stored
// provider IDs, statuses and currency amounts are used; no answer text is read.
export async function getCloudEvidenceBudgetStatus({env, fetchImpl = globalThis.fetch, now = new Date()} = {}) {
  const {key} = cloudBudgetScope(env, now);
  const redis = redisConfig(env);
  const response = await fetchImpl(redis.url, {
    method:'POST', headers:{authorization:`Bearer ${redis.token}`,'content-type':'application/json'},
    body:JSON.stringify(['HGETALL', key]), signal:AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`cloud_budget_store_http_${response.status}`);
  const payload = await response.json();
  if (payload.error || !Array.isArray(payload.result) || payload.result.length % 2 !== 0) {
    throw new Error('cloud_budget_store_invalid_response');
  }
  let spentNano = 0;
  let reservedNano = 0;
  for (let index = 0; index < payload.result.length; index += 2) {
    if (['actualNano','theoreticalNano'].includes(payload.result[index])) continue;
    const ticket = JSON.parse(payload.result[index + 1]);
    if (ticket.provider !== 'siliconflow') continue;
    if (!Number.isSafeInteger(ticket.actualNano) || ticket.actualNano < 0
        || !['reserved','usage_settled'].includes(ticket.status)) throw new Error('cloud_budget_ticket_invalid');
    spentNano += ticket.actualNano;
    if (ticket.status === 'reserved') reservedNano += ticket.actualNano;
  }
  return {spentTodayCny:spentNano / UNIT, reservedTodayCny:reservedNano / UNIT,
    dailyBudgetCny:amount(env.CLOUD_BUDGET_ACTUAL_LIMIT_CNY,'actual_limit')};
}

export function createCloudRequestBudget({env, fetchImpl = globalThis.fetch, command, now = new Date()} = {}) {
  const {namespace, period, dayKey, key} = cloudBudgetScope(env, now);
  const limits = {
    actualCny:amount(env.CLOUD_BUDGET_ACTUAL_LIMIT_CNY,'actual_limit'),
    theoreticalUsd:amount(env.CLOUD_BUDGET_THEORETICAL_LIMIT_USD,'theoretical_limit'),
  };
  const initial = {
    actualCny:amount(env.CLOUD_BUDGET_INITIAL_ACTUAL_CNY || 0,'initial_actual',true),
    theoreticalUsd:amount(env.CLOUD_BUDGET_INITIAL_THEORETICAL_USD || 0,'initial_theoretical',true),
  };
  // Reserve against the undiscounted vendor rate; settle against the latest
  // observed token group. The user confirmed one CNY buys one site dollar.
  const relayMultiplier = amount(env.RELAY_PRICING_MULTIPLIER,'relay_multiplier');
  const siteDollarCny = amount(env.RELAY_SITE_DOLLAR_CNY,'site_dollar_cny');
  const records=[];
  const redis = command ? null : redisConfig(env);
  const send = command || (async (args) => {
    const response = await fetchImpl(redis.url, {
      method:'POST',headers:{authorization:`Bearer ${redis.token}`,'content-type':'application/json'},
      body:JSON.stringify(args), signal:AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`cloud_budget_store_http_${response.status}`);
    const payload = await response.json();
    if (payload.error || !Array.isArray(payload.result)) throw new Error('cloud_budget_store_invalid_response');
    return payload.result;
  });
  async function reserve({provider,model,operation,actualCny,theoreticalUsd}) {
    amount(actualCny,'reservation_actual',true);
    amount(theoreticalUsd,'reservation_theoretical',true);
    const ticket={id:randomUUID(),provider,model,operation,status:'reserved',startedAtUtc:new Date().toISOString(),
      actualNano:nano(actualCny),theoreticalNano:nano(theoreticalUsd),started:performance.now()};
    const result=await send(['EVAL',CLOUD_BUDGET_RESERVE,'1',key,ticket.id,String(ticket.actualNano),String(ticket.theoreticalNano),
      String(nano(limits.actualCny)),String(nano(limits.theoreticalUsd)),String(nano(initial.actualCny)),String(nano(initial.theoreticalUsd)),JSON.stringify(ticket)]);
    if(result[0]!=='reserved') throw new Error(result[0]==='blocked'?'cloud_budget_total_exceeded':'cloud_budget_reservation_uncertain');
    records.push(ticket);
    return ticket;
  }
  async function settle(ticket,{actualCny,actualUpperCny=actualCny,theoreticalUsd,usage,returnedModel}) {
    amount(actualCny,'settled_actual',true);
    amount(actualUpperCny,'settled_actual_upper',true);
    amount(theoreticalUsd,'settled_theoretical',true);
    const settled={...ticket,status:'usage_settled',estimatedActualCny:Math.round(actualCny*UNIT)/UNIT,actualNano:nano(actualUpperCny),theoreticalNano:nano(theoreticalUsd),usage,
      returnedModel:returnedModel||null,elapsedMs:performance.now()-ticket.started,completedAtUtc:new Date().toISOString()};
    const result=await send(['EVAL',CLOUD_BUDGET_SETTLE,'1',key,ticket.id,String(settled.actualNano),String(settled.theoreticalNano),JSON.stringify(settled)]);
    if(result[0]!=='settled') throw new Error('cloud_budget_settlement_uncertain');
    Object.assign(ticket,settled);
  }
  async function relay({body,invoke}) {
    const model=body.model;
    const output=body.max_completion_tokens;
    if(!Number.isSafeInteger(output)||output<=0) throw new Error('cloud_budget_explicit_output_limit_required');
    // Whole wire body bytes conservatively include prompt and chat framing.
    const input=Buffer.byteLength(JSON.stringify(body),'utf8');
    const reserveUsage={input_tokens:input,output_tokens:output};
    const officialRates=getModelPricingConfig().models[model];
    if(!officialRates) throw new Error('cloud_budget_model_price_missing');
    const theoreticalUsd=estimateOpenAIModelCost({model,usage:reserveUsage,inputBillingBasis:'all_uncached'}).totalCostUsd
      + input*Math.max(0,officialRates.cacheWriteUsdPerMillion-officialRates.inputUsdPerMillion)/1e6;
    const actualCny=estimateRelayModelCost({model,usage:reserveUsage,pricingMultiplier:1,usdToCnyRate:siteDollarCny,inputBillingBasis:'all_uncached'}).totalCostCny;
    const ticket=await reserve({provider:'relay',model,operation:'chat_completions',actualCny,theoreticalUsd});
    try {
      const result=await invoke();
      if(usagePresent(result.usage)) await settle(ticket,{
        usage:result.usage,returnedModel:result.model,
        actualCny:estimateRelayModelCost({model,usage:result.usage,pricingMultiplier:relayMultiplier,usdToCnyRate:siteDollarCny}).totalCostCny,
        actualUpperCny:estimateRelayModelCost({model,usage:result.usage,pricingMultiplier:1,usdToCnyRate:siteDollarCny,inputBillingBasis:'all_uncached'}).totalCostCny,
        theoreticalUsd:estimateOpenAIModelCost({model,usage:result.usage}).totalCostUsd,
      });
      else ticket.uncertainty='provider_usage_missing_reservation_retained';
      return result;
    } catch(error) { ticket.uncertainty='request_or_settlement_failed_reservation_retained'; throw error; }
  }
  async function beforeSend({operation,model,count}) {
    const rate=operation==='embeddings'?0.07:operation==='rerank'?0.28:null;
    if(rate===null || !Number.isSafeInteger(count) || count<1) throw new Error('cloud_budget_unsupported_sf_request');
    return reserve({provider:'siliconflow',model,operation,actualCny:count*32768*rate/1e6,theoreticalUsd:0});
  }
  async function onResponse(payload,ticket) {
    if(!ticket) throw new Error('cloud_budget_sf_reservation_missing');
    const tokens=payload?.usage?.total_tokens ?? payload?.usage?.prompt_tokens;
    if(!Number.isSafeInteger(tokens)||tokens<1) { ticket.uncertainty='provider_usage_missing_reservation_retained'; return; }
    await settle(ticket,{usage:payload.usage,returnedModel:payload.model,
      actualCny:tokens*(ticket.operation==='embeddings'?0.07:0.28)/1e6,theoreticalUsd:0});
  }
  function snapshot() {
    return {runId:namespace,period,dayKey,limits,actualCostBasis:'provider_usage_and_observed_relay_group',relayMultiplier,siteDollarCny,
      actualCny:records.filter(r=>r.status==='usage_settled').reduce((n,r)=>n+r.estimatedActualCny,0),
      accountedActualUpperCny:records.filter(r=>r.status==='usage_settled').reduce((n,r)=>n+r.actualNano/UNIT,0),
      theoreticalUsd:records.filter(r=>r.status==='usage_settled').reduce((n,r)=>n+r.theoreticalNano/UNIT,0),
      reservedCny:records.filter(r=>r.status==='reserved').reduce((n,r)=>n+r.actualNano/UNIT,0),
      reservedTheoreticalUsd:records.filter(r=>r.status==='reserved').reduce((n,r)=>n+r.theoreticalNano/UNIT,0),
      calls:records.map(({started,...r})=>({...r,actualCny:r.estimatedActualCny??null,accountedActualUpperCny:r.actualNano/UNIT,theoreticalUsd:r.theoreticalNano/UNIT}))};
  }
  return {relay,beforeSend,onResponse,snapshot};
}

export async function runCloudBudgetedQuestion({env,fetchImpl,budget},invoke) {
  if(env.RAG_MODEL_PROVIDER && env.RAG_MODEL_PROVIDER!=='relay') throw new Error('cloud_budget_provider_not_supported');
  const controller=budget||createCloudRequestBudget({env,fetchImpl});
  return scope.run(controller,async()=>{
    try {
      const result=await invoke();
      if(result===null || result===undefined) return result;
      return {...result,debug:{...result.debug,cloudCosts:controller.snapshot()}};
    } catch(error) { error.cloudCosts=controller.snapshot(); throw error; }
  });
}
export function runCloudRelayRequest({body,invoke}) {
  const controller=scope.getStore();
  return controller?controller.relay({body,invoke}):invoke();
}
export function cloudSiliconFlowCallbacks() {
  const controller=scope.getStore();
  if(!controller) throw new Error('cloud_budget_request_scope_missing');
  return {beforeSend:controller.beforeSend,onResponse:controller.onResponse};
}
