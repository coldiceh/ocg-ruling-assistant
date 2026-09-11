// Public final rulings use independent provider ledgers. The original cloud
// hash stays intact and is read for old tickets; nothing is copied or reset.
// All decisions below use stored provider/stage/status and integer amounts.
export const PUBLIC_FINAL_BUDGET_LUA = `
local mode = ARGV[1]
local pools = {relay={spent=0,reserved=0,legacy=0}, bai={spent=0,reserved=0,legacy=0}}
local function addTickets(key, legacy)
  local fields = redis.call('HGETALL', key)
  for i = 1, #fields, 2 do
    if fields[i] ~= 'actualNano' and fields[i] ~= 'theoreticalNano' then
      local ticket = cjson.decode(fields[i + 1])
      local pool = pools[ticket.provider]
      if pool then
        local n = ticket.theoreticalNano
        if type(n) ~= 'number' or n < 0 or n ~= math.floor(n) then error('cloud_budget_ticket_invalid') end
        if ticket.status ~= 'reserved' and ticket.status ~= 'usage_settled' then error('cloud_budget_ticket_invalid') end
        -- The old b.ai cloud adapter was only called by final generation.
        -- Old Relay tickets lack a stage and may include preparation: keep
        -- these as unclassified prior charges, never label them final usage.
        if ticket.stage == 'final_ruling' or (legacy and ticket.provider == 'bai' and ticket.stage == nil) then
          if ticket.status == 'reserved' then pool.reserved = pool.reserved + n
          else pool.spent = pool.spent + n end
        elseif legacy and ticket.provider == 'relay' and ticket.stage == nil then
          pool.legacy = pool.legacy + n
        end
      end
    end
  end
end
addTickets(KEYS[1], true)
addTickets(KEYS[2], false)
addTickets(KEYS[3], false)
local closed = redis.call('HGET', KEYS[4], 'closed') == '1'
if mode == 'cap' then
  redis.call('HSET', KEYS[4], 'closed', '1')
  closed = true
elseif mode == 'reset' then
  for provider, pool in pairs(pools) do
    -- Only observed settled fees receive reset credit. Outstanding/unknown
    -- reservations and the source tickets remain intact across reset.
    redis.call('HSET', KEYS[4], provider .. ':resetSpent', tostring(pool.spent))
  end
  redis.call('HDEL', KEYS[4], 'closed')
  closed = false
end
for provider, pool in pairs(pools) do
  pool.spent = math.max(0, pool.spent - tonumber(redis.call('HGET', KEYS[4], provider .. ':resetSpent') or '0'))
  pool.accounted = pool.spent + pool.reserved + pool.legacy
end
if mode == 'reserve' then
  local provider = ARGV[2]
  local pool = pools[provider]
  if not pool then error('cloud_budget_provider_invalid') end
  local key = provider == 'relay' and KEYS[2] or KEYS[3]
  local ticket = cjson.decode(ARGV[3])
  local old = redis.call('HGET', key, ticket.id)
  if old then return {'existing', old} end
  if closed or pool.accounted + ticket.theoreticalNano > tonumber(ARGV[4]) then return {'blocked'} end
  local cny = tonumber(redis.call('HGET', key, 'actualNano') or '0') + ticket.actualNano
  local usd = tonumber(redis.call('HGET', key, 'theoreticalNano') or '0') + ticket.theoreticalNano
  redis.call('HSET', key, 'actualNano', tostring(cny), 'theoreticalNano', tostring(usd), ticket.id, ARGV[3])
  return {'reserved'}
end
return {cjson.encode({relay=pools.relay,bai=pools.bai,closed=closed})}
`;

export function publicFinalBudgetEnabled(env = {}) {
  return env.RAG_EVIDENCE_PIPELINE === 'cloud_evidence_v1' && env.CLOUD_BUDGET_PERIOD === 'daily';
}

export function publicFinalBudgetKeys(cloudKey) {
  return [cloudKey, `${cloudKey}:final:relay`, `${cloudKey}:final:bai`, `${cloudKey}:final:control`];
}

export function publicFinalBudgetCommand(cloudKey, mode, args = []) {
  return ['EVAL', PUBLIC_FINAL_BUDGET_LUA, '4', ...publicFinalBudgetKeys(cloudKey), mode, ...args];
}

export function publicFinalPoolStatus(raw, limit) {
  const toPool = (pool) => ({
    spentUsd: pool.spent / 1e9,
    reservedUsd: pool.reserved / 1e9,
    legacyUnclassifiedUsd: pool.legacy / 1e9,
    accountedUsd: pool.accounted / 1e9,
    theoreticalLimitUsd: limit,
    remainingUsd: raw.closed ? 0 : Math.max(0, limit - pool.accounted / 1e9),
    manuallyClosed: raw.closed,
    blocked: raw.closed || pool.accounted >= Math.ceil(limit * 1e9),
    costBasis: 'official_theoretical',
  });
  return {relayPool: toPool(raw.relay), baiPool: toPool(raw.bai)};
}
