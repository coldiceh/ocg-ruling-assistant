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
if ARGV[9] == 'official_daily_v1' and redis.call('HEXISTS', KEYS[1], 'theoreticalNano') == 0 then
  local migrated = 0
  local legacy = redis.call('HGETALL', KEYS[2])
  for i = 1, #legacy, 2 do
    if legacy[i] ~= 'actualNano' and legacy[i] ~= 'theoreticalNano' then
      local ok, ticket = pcall(cjson.decode, legacy[i + 1])
      if not ok then return {'migration_invalid'} end
      if ticket.provider == 'openai' and (ticket.status == 'reserved' or ticket.status == 'usage_settled')
          and type(ticket.startedAtUtc) == 'string' and ticket.startedAtUtc >= ARGV[10]
          and ticket.startedAtUtc < ARGV[11] and type(ticket.theoreticalNano) == 'number'
          and ticket.theoreticalNano >= 0 then
        migrated = migrated + ticket.theoreticalNano
        redis.call('HSET', KEYS[1], legacy[i], legacy[i + 1])
      end
    end
  end
  redis.call('HSET', KEYS[1], 'actualNano', '0', 'theoreticalNano', tostring(migrated))
end
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
function deepSeekBusyRates(env={}) {
  return {
    cacheHitCnyPerMtok:amount(env.DEEPSEEK_CLOUD_BUSY_CACHE_HIT_CNY_PER_MTOK??0.04,'deepseek_cache_hit_rate'),
    cacheMissCnyPerMtok:amount(env.DEEPSEEK_CLOUD_BUSY_CACHE_MISS_CNY_PER_MTOK??2,'deepseek_cache_miss_rate'),
    outputCnyPerMtok:amount(env.DEEPSEEK_CLOUD_BUSY_OUTPUT_CNY_PER_MTOK??8,'deepseek_output_rate'),
  };
}
function deepSeekBusyCost(usage={},env={}) {
  const rates=deepSeekBusyRates(env);
  const prompt=Math.max(0,Number(usage.prompt_tokens??usage.input_tokens??0));
  const hit=Math.min(prompt,Math.max(0,Number(usage.prompt_cache_hit_tokens??usage.cached_input_tokens??0)));
  const explicitMiss=Number(usage.prompt_cache_miss_tokens);
  const miss=Number.isFinite(explicitMiss)?Math.min(prompt,Math.max(0,explicitMiss)):prompt-hit;
  const uncategorized=Math.max(0,prompt-hit-miss);
  const output=Math.max(0,Number(usage.completion_tokens??usage.output_tokens??0));
  return (hit*rates.cacheHitCnyPerMtok+(miss+uncategorized)*rates.cacheMissCnyPerMtok
    +output*rates.outputCnyPerMtok)/1_000_000;
}
function dayKeyAt(now, timezone) {
  const day = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit',
  }).formatToParts(now).map(part=>[part.type,part.value]));
  return `${day.year}-${day.month}-${day.day}`;
}
function timezoneOffsetMinutes(at,timezone) {
  const value=new Intl.DateTimeFormat('en-US',{timeZone:timezone||'Asia/Shanghai',timeZoneName:'longOffset'})
    .formatToParts(at).find(part=>part.type==='timeZoneName')?.value;
  const match=/^GMT(?:(?<sign>[+-])(?<hours>\d{2}):(?<minutes>\d{2}))?$/u.exec(value||'');
  if(!match) throw new Error('cloud_budget_invalid_timezone');
  if(!match.groups?.sign) return 0;
  const minutes=Number(match.groups.hours)*60+Number(match.groups.minutes);
  return match.groups.sign==='-'?-minutes:minutes;
}
function localMidnightUtc(dayKey,timezone) {
  const [year,month,day]=dayKey.split('-').map(Number);
  const localAsUtc=Date.UTC(year,month-1,day);
  let result=localAsUtc-timezoneOffsetMinutes(new Date(localAsUtc),timezone)*60_000;
  result=localAsUtc-timezoneOffsetMinutes(new Date(result),timezone)*60_000;
  return new Date(result);
}
function utcDayBounds(dayKey,timezone) {
  const start=localMidnightUtc(dayKey,timezone);
  const [year,month,day]=dayKey.split('-').map(Number);
  const nextLocal=new Date(Date.UTC(year,month-1,day+1));
  const nextKey=`${nextLocal.getUTCFullYear()}-${String(nextLocal.getUTCMonth()+1).padStart(2,'0')}-${String(nextLocal.getUTCDate()).padStart(2,'0')}`;
  return {startUtc:start.toISOString(),endUtc:localMidnightUtc(nextKey,timezone).toISOString()};
}
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
  const dayKey = period === 'daily' ? dayKeyAt(now, env.API_BUDGET_TIMEZONE) : null;
  const key = `ruling-cloud-budget:v1:${namespace}${dayKey ? `:${dayKey}` : ''}`;
  return {namespace, period, dayKey, key};
}

async function sendRedisCommand({env,fetchImpl}, args) {
  const redis=redisConfig(env);
  const response=await fetchImpl(redis.url,{
    method:'POST',headers:{authorization:`Bearer ${redis.token}`,'content-type':'application/json'},
    body:JSON.stringify(args),signal:AbortSignal.timeout(5000),
  });
  if(!response.ok) throw new Error(`cloud_budget_store_http_${response.status}`);
  const payload=await response.json();
  if(payload.error || !Array.isArray(payload.result)) throw new Error('cloud_budget_store_invalid_response');
  return payload.result;
}

function parseHashResult(result) {
  if(!Array.isArray(result) || result.length%2!==0) throw new Error('cloud_budget_store_invalid_response');
  const fields=new Map();
  for(let index=0;index<result.length;index+=2) fields.set(String(result[index]),String(result[index+1]));
  return fields;
}

function officialDailyConfig(env,now) {
  const dailyBudgetAmount=amount(env.PUBLIC_OPENAI_DAILY_LIMIT_USD??5,'official_daily_limit');
  const namespace=String(env.PUBLIC_OPENAI_BUDGET_RUN_ID||'');
  if(!/^[a-zA-Z0-9_-]{1,100}$/u.test(namespace)) throw new Error('cloud_budget_run_id_required');
  const dayKey=dayKeyAt(now,env.API_BUDGET_TIMEZONE);
  return {dailyBudgetAmount,dayKey,legacyKey:`ruling-cloud-budget:v1:${namespace}`,
    dailyKey:`ruling-cloud-budget:v1:${namespace}:${dayKey}`};
}

function ticketsForDay(fields,{dayKey,timezone}) {
  const tickets=[];
  for(const [id,value] of fields) {
    if(['actualNano','theoreticalNano'].includes(id)) continue;
    let ticket;
    try { ticket=JSON.parse(value); } catch { throw new Error('cloud_budget_ticket_invalid'); }
    if(ticket.provider!=='openai') continue;
    if(!['reserved','usage_settled'].includes(ticket.status)
        || !Number.isSafeInteger(ticket.theoreticalNano) || ticket.theoreticalNano<0
        || typeof ticket.startedAtUtc!=='string') throw new Error('cloud_budget_ticket_invalid');
    const started=new Date(ticket.startedAtUtc);
    if(Number.isNaN(started.valueOf())) throw new Error('cloud_budget_ticket_invalid');
    if(dayKeyAt(started,timezone)===dayKey) tickets.push([id,value,ticket]);
  }
  return tickets;
}

function officialStatusFromFields(fields,config) {
  let spentNano=0,reservedNano=0;
  for(const [id,value] of fields) {
    if(['actualNano','theoreticalNano'].includes(id)) continue;
    let ticket;
    try { ticket=JSON.parse(value); } catch { throw new Error('cloud_budget_ticket_invalid'); }
    if(ticket.provider!=='openai') continue;
    if(!['reserved','usage_settled'].includes(ticket.status)
        || !Number.isSafeInteger(ticket.theoreticalNano) || ticket.theoreticalNano<0) {
      throw new Error('cloud_budget_ticket_invalid');
    }
    if(ticket.status==='reserved') reservedNano+=ticket.theoreticalNano;
    else spentNano+=ticket.theoreticalNano;
  }
  const spentAmount=spentNano/UNIT;
  const reservedAmount=reservedNano/UNIT;
  const remainingAmount=Math.max(0,config.dailyBudgetAmount-spentAmount-reservedAmount);
  return {currency:'USD',dailyBudgetAmount:config.dailyBudgetAmount,remainingAmount,spentAmount,
    dayKey:config.dayKey,reservedAmount,blocked:remainingAmount<=0};
}

export async function getOfficialOpenAIBudgetStatus({env={},fetchImpl=globalThis.fetch,now=new Date()}={}) {
  let config;
  try { config=officialDailyConfig(env,now); }
  catch {
    const dailyBudgetAmount=Number(env.PUBLIC_OPENAI_DAILY_LIMIT_USD??5);
    return {currency:'USD',dailyBudgetAmount:Number.isFinite(dailyBudgetAmount)?dailyBudgetAmount:5,
      remainingAmount:null,spentAmount:null,dayKey:dayKeyAt(now,env.API_BUDGET_TIMEZONE),
      reservedAmount:null,blocked:true};
  }
  if(typeof fetchImpl!=='function') return {currency:'USD',dailyBudgetAmount:config.dailyBudgetAmount,
    remainingAmount:null,spentAmount:null,dayKey:config.dayKey,reservedAmount:null,blocked:true};
  try {
    const daily=parseHashResult(await sendRedisCommand({env,fetchImpl},['HGETALL',config.dailyKey]));
    if(daily.size>0) return officialStatusFromFields(daily,config);
    const legacy=parseHashResult(await sendRedisCommand({env,fetchImpl},['HGETALL',config.legacyKey]));
    const todaysTickets=ticketsForDay(legacy,{dayKey:config.dayKey,timezone:env.API_BUDGET_TIMEZONE});
    return officialStatusFromFields(new Map(todaysTickets.map(([id,value])=>[id,value])),config);
  } catch {
    return {currency:'USD',dailyBudgetAmount:config.dailyBudgetAmount,remainingAmount:null,
      spentAmount:null,dayKey:config.dayKey,reservedAmount:null,blocked:true};
  }
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
  let relaySpentNano = 0;
  let relayReservedNano = 0;
  let baiSpentNano = 0;
  let baiReservedNano = 0;
  const fields=parseHashResult(payload.result);
  for (let index = 0; index < payload.result.length; index += 2) {
    if (['actualNano','theoreticalNano'].includes(payload.result[index])) continue;
    const ticket = JSON.parse(payload.result[index + 1]);
    if (!['reserved','usage_settled'].includes(ticket.status)) throw new Error('cloud_budget_ticket_invalid');
    if (['siliconflow','deepseek'].includes(ticket.provider)) {
      if (!Number.isSafeInteger(ticket.actualNano) || ticket.actualNano < 0) throw new Error('cloud_budget_ticket_invalid');
      spentNano += ticket.actualNano;
      if (ticket.status === 'reserved') reservedNano += ticket.actualNano;
    }
    if (ticket.provider === 'relay') {
      if (!Number.isSafeInteger(ticket.theoreticalNano) || ticket.theoreticalNano < 0) throw new Error('cloud_budget_ticket_invalid');
      if (ticket.status === 'reserved') relayReservedNano += ticket.theoreticalNano;
      else relaySpentNano += ticket.theoreticalNano;
    }
    if (ticket.provider === 'bai') {
      if (!Number.isSafeInteger(ticket.theoreticalNano) || ticket.theoreticalNano < 0) throw new Error('cloud_budget_ticket_invalid');
      if (ticket.status === 'reserved') baiReservedNano += ticket.theoreticalNano;
      else baiSpentNano += ticket.theoreticalNano;
    }
  }
  const actualLimit=amount(env.CLOUD_BUDGET_ACTUAL_LIMIT_CNY,'actual_limit');
  const theoreticalLimit=amount(env.CLOUD_BUDGET_THEORETICAL_LIMIT_USD,'theoretical_limit');
  const accountedActualNano=Number(fields.get('actualNano')??nano(amount(env.CLOUD_BUDGET_INITIAL_ACTUAL_CNY||0,'initial_actual',true)));
  const accountedTheoreticalNano=Number(fields.get('theoreticalNano')??nano(amount(env.CLOUD_BUDGET_INITIAL_THEORETICAL_USD||0,'initial_theoretical',true)));
  if(!Number.isSafeInteger(accountedActualNano)||accountedActualNano<0
      ||!Number.isSafeInteger(accountedTheoreticalNano)||accountedTheoreticalNano<0) throw new Error('cloud_budget_total_invalid');
  return {spentTodayCny:spentNano / UNIT, reservedTodayCny:reservedNano / UNIT,
    dailyBudgetCny:actualLimit,relayPool:{spentUsd:relaySpentNano/UNIT,reservedUsd:relayReservedNano/UNIT,
      theoreticalLimitUsd:theoreticalLimit,accountedUsd:accountedTheoreticalNano/UNIT,
      actualRemainingCny:Math.max(0,actualLimit-accountedActualNano/UNIT)},
    baiPool:{spentUsd:baiSpentNano/UNIT,reservedUsd:baiReservedNano/UNIT,
      theoreticalLimitUsd:theoreticalLimit,accountedUsd:accountedTheoreticalNano/UNIT,
      costBasis:'official_theoretical',actualCostKnown:false,
      actualRemainingCny:Math.max(0,actualLimit-accountedActualNano/UNIT)}};
}

export function createCloudRequestBudget({env, fetchImpl = globalThis.fetch, command, now = new Date(),officialDailyMigration} = {}) {
  const {namespace, period, dayKey, key} = cloudBudgetScope(env, now);
  const limits = {
    actualCny:amount(env.CLOUD_BUDGET_ACTUAL_LIMIT_CNY,'actual_limit',true),
    theoreticalUsd:amount(env.CLOUD_BUDGET_THEORETICAL_LIMIT_USD,'theoretical_limit'),
  };
  const initial = {
    actualCny:amount(env.CLOUD_BUDGET_INITIAL_ACTUAL_CNY || 0,'initial_actual',true),
    theoreticalUsd:amount(env.CLOUD_BUDGET_INITIAL_THEORETICAL_USD || 0,'initial_theoretical',true),
  };
  // Reserve against the undiscounted vendor rate; settle against the latest
  // observed token group. The user confirmed one CNY buys one site dollar.
  const relayMultiplierValue = env.RELAY_PRICING_MULTIPLIER;
  const siteDollarCnyValue = env.RELAY_SITE_DOLLAR_CNY;
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
  async function reserve({provider,model,operation,actualCny,theoreticalUsd,pricingBasis}) {
    amount(actualCny,'reservation_actual',true);
    amount(theoreticalUsd,'reservation_theoretical',true);
    const ticket={id:randomUUID(),provider,model,operation,status:'reserved',startedAtUtc:new Date().toISOString(),
      ...(pricingBasis?{pricingBasis}:{}),
      actualNano:nano(actualCny),theoreticalNano:nano(theoreticalUsd),started:performance.now()};
    const migrationArgs=officialDailyMigration?['official_daily_v1',officialDailyMigration.startUtc,officialDailyMigration.endUtc]:[];
    const result=await send(['EVAL',CLOUD_BUDGET_RESERVE,officialDailyMigration?'2':'1',key,
      ...(officialDailyMigration?[officialDailyMigration.legacyKey]:[]),ticket.id,String(ticket.actualNano),String(ticket.theoreticalNano),
      String(nano(limits.actualCny)),String(nano(limits.theoreticalUsd)),String(nano(initial.actualCny)),String(nano(initial.theoreticalUsd)),JSON.stringify(ticket),...migrationArgs]);
    if(result[0]!=='reserved') throw new Error(result[0]==='blocked'?'cloud_budget_total_exceeded':'cloud_budget_reservation_uncertain');
    records.push(ticket);
    return ticket;
  }
  async function settle(ticket,{actualCny,actualUpperCny=actualCny,theoreticalUsd,usage,returnedModel}) {
    // Provider usage is observed before persistence; keep it if Redis fails.
    Object.assign(ticket,{usage,returnedModel:returnedModel||null,providerResponseReceivedAtUtc:new Date().toISOString()});
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
    const relayMultiplier = amount(relayMultiplierValue,'relay_multiplier');
    const siteDollarCny = amount(siteDollarCnyValue,'site_dollar_cny');
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
    let result;
    try { result=await invoke(); }
    catch(error) { ticket.uncertainty='request_or_settlement_failed_reservation_retained'; throw error; }
    if(usagePresent(result.usage)) {
      try { await settle(ticket,{
        usage:result.usage,returnedModel:result.model,
        actualCny:estimateRelayModelCost({model,usage:result.usage,pricingMultiplier:relayMultiplier,usdToCnyRate:siteDollarCny}).totalCostCny,
        actualUpperCny:estimateRelayModelCost({model,usage:result.usage,pricingMultiplier:1,usdToCnyRate:siteDollarCny,inputBillingBasis:'all_uncached'}).totalCostCny,
        theoreticalUsd:estimateOpenAIModelCost({model,usage:result.usage}).totalCostUsd,
      }); }
      catch { ticket.uncertainty='provider_response_received_settlement_uncertain_reservation_retained'; }
    } else ticket.uncertainty='provider_usage_missing_reservation_retained';
    return result;
  }
  async function deepseek({body,invoke}) {
    const model=String(body?.model||'').trim();
    const output=body?.max_tokens;
    if(!model) throw new Error('cloud_budget_model_required');
    if(!Number.isSafeInteger(output)||output<=0) throw new Error('cloud_budget_explicit_output_limit_required');
    const input=Buffer.byteLength(JSON.stringify(body),'utf8');
    const reserveUsage={prompt_tokens:input,prompt_cache_miss_tokens:input,completion_tokens:output};
    const ticket=await reserve({provider:'deepseek',model,operation:'chat_completions',
      actualCny:deepSeekBusyCost(reserveUsage,env),theoreticalUsd:0,pricingBasis:'busy_rate_estimate'});
    let result;
    try { result=await invoke(); }
    catch(error) { ticket.uncertainty='request_or_settlement_failed_reservation_retained'; throw error; }
    if(usagePresent(result.usage)) {
      try { await settle(ticket,{usage:result.usage,returnedModel:result.model,
        actualCny:deepSeekBusyCost(result.usage,env),actualUpperCny:deepSeekBusyCost(result.usage,env),theoreticalUsd:0}); }
      catch { ticket.uncertainty='provider_response_received_settlement_uncertain_reservation_retained'; }
    } else ticket.uncertainty='provider_usage_missing_reservation_retained';
    return result;
  }
  async function openai({body,invoke,provider='openai'}) {
    const model=body.model;
    const output=body.max_completion_tokens;
    if(!Number.isSafeInteger(output)||output<=0) throw new Error('cloud_budget_explicit_output_limit_required');
    const input=Buffer.byteLength(JSON.stringify(body),'utf8');
    const reserveUsage={input_tokens:input,output_tokens:output};
    const officialRates=getModelPricingConfig().models[model];
    if(!officialRates) throw new Error('cloud_budget_model_price_missing');
    // Reserve the most expensive possible input tier because cache-write usage
    // is known only after the provider response.
    const theoreticalUsd=estimateOpenAIModelCost({
      model,usage:reserveUsage,inputBillingBasis:'all_uncached',
    }).totalCostUsd + input*Math.max(
      0,officialRates.cacheWriteUsdPerMillion-officialRates.inputUsdPerMillion,
    )/1e6;
    const ticket=await reserve({
      provider,model,operation:'chat_completions',actualCny:0,theoreticalUsd,
      ...(provider==='bai'?{pricingBasis:'official_theoretical'}:{}),
    });
    let result;
    try { result=await invoke(); }
    catch(error) {
      ticket.uncertainty='request_or_settlement_failed_reservation_retained';
      throw error;
    }
    if(usagePresent(result.usage)) {
      try { await settle(ticket,{
        usage:result.usage,returnedModel:result.model,actualCny:0,actualUpperCny:0,
        theoreticalUsd:estimateOpenAIModelCost({model,usage:result.usage}).totalCostUsd,
      }); }
      catch { ticket.uncertainty='provider_response_received_settlement_uncertain_reservation_retained'; }
    } else ticket.uncertainty='provider_usage_missing_reservation_retained';
    return result;
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
    const hasRelay=records.some(record=>record.provider==='relay');
    const relayMultiplier=hasRelay?amount(relayMultiplierValue,'relay_multiplier'):null;
    const siteDollarCny=hasRelay?amount(siteDollarCnyValue,'site_dollar_cny'):null;
    return {runId:namespace,period,dayKey,limits,actualCostBasis:'provider_usage',relayMultiplier,siteDollarCny,
      actualCny:records.filter(r=>r.status==='usage_settled').reduce((n,r)=>n+r.estimatedActualCny,0),
      accountedActualUpperCny:records.filter(r=>r.status==='usage_settled').reduce((n,r)=>n+r.actualNano/UNIT,0),
      theoreticalUsd:records.filter(r=>r.status==='usage_settled').reduce((n,r)=>n+r.theoreticalNano/UNIT,0),
      reservedCny:records.filter(r=>r.status==='reserved').reduce((n,r)=>n+r.actualNano/UNIT,0),
      reservedTheoreticalUsd:records.filter(r=>r.status==='reserved').reduce((n,r)=>n+r.theoreticalNano/UNIT,0),
      actualCostKnown:!records.some(record=>record.provider==='bai'),
      calls:records.map(({started,...r})=>({...r,actualCny:r.provider==='bai'?null:r.estimatedActualCny??null,accountedActualUpperCny:r.provider==='bai'?null:r.actualNano/UNIT,theoreticalUsd:r.theoreticalNano/UNIT}))};
  }
  return {relay,deepseek,openai,bai:request=>openai({...request,provider:'bai'}),beforeSend,onResponse,snapshot};
}

export async function runCloudBudgetedQuestion({env,fetchImpl,budget},invoke) {
  if(env.RAG_MODEL_PROVIDER && !['relay','openai','bai','deepseek','glm'].includes(env.RAG_MODEL_PROVIDER)) {
    throw new Error('cloud_budget_provider_not_supported');
  }
  const controller=budget||createCloudRequestBudget({env,fetchImpl});
  return scope.run(controller,async()=>{
    try {
      const result=await invoke();
      if(result===null || result===undefined) return result;
      return {...result,debug:{...result.debug,cloudCosts:controller.snapshot()}};
    } catch(error) { error.cloudCosts=controller.snapshot(); throw error; }
  });
}
export function cloudRequestBudgetActive() {
  return Boolean(scope.getStore());
}
export function runCloudRelayRequest({body,invoke}) {
  const controller=scope.getStore();
  return controller?controller.relay({body,invoke}):invoke();
}
export async function runOfficialOpenAIRequest({env,body,invoke,fetchImpl=globalThis.fetch,now=new Date()}) {
  const daily=officialDailyConfig(env,now);
  const officialEnv={
    ...env,
    CLOUD_BUDGET_RUN_ID:String(env.PUBLIC_OPENAI_BUDGET_RUN_ID||''),
    CLOUD_BUDGET_PERIOD:'daily',
    CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'0',
    CLOUD_BUDGET_THEORETICAL_LIMIT_USD:String(env.PUBLIC_OPENAI_DAILY_LIMIT_USD??5),
    CLOUD_BUDGET_INITIAL_ACTUAL_CNY:'0',
    // The legacy initial amount has no dated provenance. Only dated tickets are
    // migrated during reservation, preserving history without charging it to today.
    CLOUD_BUDGET_INITIAL_THEORETICAL_USD:'0',
  };
  try {
    return await createCloudRequestBudget({env:officialEnv,fetchImpl,now,
      officialDailyMigration:{legacyKey:daily.legacyKey,...utcDayBounds(daily.dayKey,env.API_BUDGET_TIMEZONE)}})
      .openai({body,invoke});
  } catch(error) {
    if(error?.message==='cloud_budget_total_exceeded') {
      const exceeded=new Error('official_daily_budget_exceeded',{cause:error});
      exceeded.code='official_daily_budget_exceeded';
      throw exceeded;
    }
    throw error;
  }
}
export function runCloudBaiRequest({body,invoke}) {
  const controller=scope.getStore();
  return controller?controller.bai({body,invoke}):invoke();
}
export function runCloudDeepSeekRequest({body,invoke}) {
  const controller=scope.getStore();
  return controller?controller.deepseek({body,invoke}):invoke();
}
export function cloudSiliconFlowCallbacks() {
  const controller=scope.getStore();
  if(!controller) throw new Error('cloud_budget_request_scope_missing');
  return {beforeSend:controller.beforeSend,onResponse:controller.onResponse};
}
