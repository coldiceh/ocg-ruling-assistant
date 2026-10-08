import assert from 'node:assert/strict';
import test from 'node:test';
import {createDecisionsTransport, parseDecisionsAnswers, decisionsCostUsd, DECISIONS_ENDPOINT}
  from '../backend/decisionsTransport.mjs';
import {CLOUD_BUDGET_RESERVE, CLOUD_BUDGET_SETTLE, createCloudRequestBudget, runOfficialDecisionsRequest}
  from '../backend/cloudRequestBudget.mjs';

const body = {model:'gpt-6-luna', input:'Synthetic source text.', questions:[
  {type:'choice', name:'source', instructions:'Select one offered source.', choices:[{value:'A'}, {value:'UNKNOWN'}]},
]};
const response = (usage = {input_tokens:1000}) => ({model:body.model,
  answers:[{name:'source', type:'choice', choice:'A'}], ...(usage === null ? {} : {usage})});
const env = {OPENAI_API_KEY:'synthetic-test-secret', PUBLIC_OPENAI_BUDGET_RUN_ID:'decisions-test',
  PUBLIC_OPENAI_DAILY_LIMIT_USD:'5', API_BUDGET_TIMEZONE:'UTC',
  UPSTASH_BUDGET_KV_REST_API_URL:'https://budget.invalid', UPSTASH_BUDGET_KV_REST_API_TOKEN:'synthetic-budget-secret'};

// Only the pre-existing Redis transport contract is simulated; all reservation
// amounts, provider routing and settlement decisions use production functions.
function ledger({settlementFailure = false} = {}) {
  const hashes = new Map(), commands = [];
  async function fetchImpl(url, options) {
    assert.equal(url, env.UPSTASH_BUDGET_KV_REST_API_URL);
    const args = JSON.parse(options.body); commands.push(args);
    assert.equal(args[0], 'EVAL');
    const hash = hashes.get(args[3]) || new Map(); hashes.set(args[3], hash);
    if (args[1] === CLOUD_BUDGET_RESERVE) {
      const shift = Number(args[2]) - 1;
      const index = 4 + shift;
      if (hash.has(args[index])) return Response.json({result:['existing', hash.get(args[index])]});
      const current = Number(hash.get('theoreticalNano') || 0);
      const next = current + Number(args[6 + shift]);
      if (next > Number(args[8 + shift])) return Response.json({result:['blocked']});
      hash.set('actualNano', '0'); hash.set('theoreticalNano', String(next));
      hash.set(args[index], args[11 + shift]);
      return Response.json({result:['reserved']});
    }
    assert.equal(args[1], CLOUD_BUDGET_SETTLE);
    if (settlementFailure) throw new Error('synthetic settlement unavailable');
    const previous = JSON.parse(hash.get(args[4]));
    hash.set('theoreticalNano', String(Number(hash.get('theoreticalNano')) + Number(args[6]) - previous.theoreticalNano));
    hash.set(args[4], args[7]);
    return Response.json({result:['settled']});
  }
  const tickets = () => [...hashes.values()].flatMap(hash => [...hash].filter(([key]) => !['actualNano', 'theoreticalNano'].includes(key)).map(([,value]) => JSON.parse(value)));
  return {fetchImpl, hashes, commands, tickets};
}

function productionTransport(store, provider, customEnv = env, options = {}) {
  let providerCalls = 0;
  const transport = createDecisionsTransport({...options, env:customEnv, fetchImpl:async (url, options) => {
    if (url === env.UPSTASH_BUDGET_KV_REST_API_URL) return store.fetchImpl(url, options);
    assert.equal(url, DECISIONS_ENDPOINT);
    providerCalls += 1;
    return provider(url, options);
  }});
  return {...transport, providerCalls:() => providerCalls};
}

test('Decisions price uses input-only billing and the exact long-context boundary', () => {
  assert.equal(decisionsCostUsd(0), 0);
  assert.equal(decisionsCostUsd(1_000_000), 0.2);
  assert.equal(decisionsCostUsd(272000), 0.0272);
  assert.equal(decisionsCostUsd(272001), 0.0544002);
  for (const invalid of [-1, 1.5, NaN, Infinity, '100']) assert.throws(() => decisionsCostUsd(invalid));
});

test('choice identities and values normalize whitespace; refusal remains UNKNOWN', () => {
  const request = {...body, questions:[...body.questions, {...body.questions[0], name:'other'}]};
  const raw = {answers:[{name:'other', type:'refusal'}, {name:' source ', type:'choice', choice:' A '}]};
  assert.deepEqual(parseDecisionsAnswers(raw, request), {source:'A', other:'UNKNOWN'});
  for (const answers of [[], [{name:'absent',type:'choice',choice:'A'}],
    [{name:'source',type:'choice',choice:'not-offered'}], [{name:'source',type:'score',choice:'A'}]]) {
    assert.throws(() => parseDecisionsAnswers({answers}, body));
  }
  assert.throws(() => parseDecisionsAnswers({answers:[raw.answers[1], raw.answers[1]]}, request), /identity/);
  assert.throws(() => parseDecisionsAnswers({...response(), model:'other-model'}, body), /model_mismatch/);
});

test('the 255 choice limit is separate from the request question count', () => {
  const transport = createDecisionsTransport({env, fetchImpl:async () => {throw new Error('unexpected fetch');}});
  const choices = Array.from({length:255}, (_, index) => ({value:`source-${index}`}));
  const request = {...body, questions:[{...body.questions[0], choices}]};
  assert.ok(transport.measure(request).inputTokensUpperBound > 0);
  assert.deepEqual(parseDecisionsAnswers({answers:[{name:'source', type:'choice', choice:'source-254'}]}, request), {source:'source-254'});
  assert.throws(() => transport.measure({...request, questions:[{...request.questions[0], choices:[...choices, {value:'overflow'}]}]}), /question_contract/);
  assert.throws(() => transport.measure({...request, questions:[{...request.questions[0], choices:[choices[0]]}]}), /question_contract/);
});

test('official-only transport snapshots bytes, prefers the dedicated key, and settles exact input usage', async () => {
  const store = ledger(); let wire;
  const config = {...env, OPENAI_DECISIONS_API_KEY:'synthetic-dedicated', OPENAI_BASE_URL:'https://ignored.invalid'};
  const transport = productionTransport(store, async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer synthetic-dedicated');
    wire = JSON.parse(options.body);
    return Response.json(response({input_tokens:1000, output_tokens:999999}));
  }, config);
  const measurement = transport.measure(body);
  assert.equal(measurement.exact, false);
  assert.ok(measurement.inputTokensUpperBound > Buffer.byteLength(JSON.stringify(body), 'utf8'));
  let dispatches = 0;
  await transport.invoke(body, {measurement, onDispatch:() => {
    dispatches += 1;
    assert.equal(store.tickets()[0].status, 'reserved');
    assert.equal(transport.providerCalls(), 0);
  }});
  assert.deepEqual(wire, body);
  assert.equal(transport.providerCalls(), 1);
  assert.equal(dispatches, 1);
  assert.equal(store.commands.length, 2);
  const [ticket] = store.tickets();
  assert.equal(ticket.provider, 'openai');
  assert.equal(ticket.operation, 'decisions');
  assert.equal(ticket.status, 'usage_settled');
  assert.equal(ticket.theoreticalNano, 100000);
  assert.deepEqual(ticket.reservationMetadata, measurement);
  assert.match([...store.hashes.keys()][0], /^ruling-cloud-budget:v1:decisions-test:\d{4}-\d{2}-\d{2}$/u);
});

test('a changed request, generation parameter, missing key or pre-abort cannot dispatch', async () => {
  let called = 0;
  const transport = createDecisionsTransport({env, fetchImpl:async () => {called += 1;},
    budgetedRequest:async () => {called += 1;}});
  const measurement = transport.measure(body);
  await assert.rejects(transport.invoke({...body, input:'different'}, {measurement}), /measurement_mismatch/);
  await assert.rejects(transport.invoke({...body, max_output_tokens:5}), /request_contract/);
  const abort = new AbortController(); const reason = new Error('synthetic abort'); abort.abort(reason);
  await assert.rejects(transport.invoke(body, {signal:abort.signal}), error => error === reason);
  const missing = createDecisionsTransport({env:{}, fetchImpl:async () => {called += 1;}});
  await assert.rejects(missing.invoke(body), /api_key_required/);
  assert.equal(called, 0);
});

test('unknown HTTP outcomes retain the durable reservation and never retry or fall back', async () => {
  for (const status of [401, 429, 500]) {
    const store = ledger();
    const transport = productionTransport(store, async () => new Response('untrusted error detail', {status}));
    await assert.rejects(transport.invoke(body), error => error.message === `decisions_http_${status}` && error.status === status);
    assert.equal(transport.providerCalls(), 1);
    assert.equal(store.commands.length, 1);
    assert.equal(store.tickets()[0].status, 'reserved');
  }
});

test('an explicit 504 retries identical bytes once with a fresh ticket and preserves unknown spend', async () => {
  const store = ledger(), sent = [], pauses = [];
  const transport = productionTransport(store, async (_url, options) => {
    sent.push(options.body);
    return sent.length === 1 ? new Response('ignored gateway body', {status:504, headers:{'x-request-id':'req_failed'}})
      : Response.json(response(), {headers:{'x-request-id':'req_success'}});
  }, env, {waitBeforeRetry:async delay => pauses.push(delay)});
  const result = await transport.invoke(body);
  assert.deepEqual(sent, [JSON.stringify(body), JSON.stringify(body)]);
  assert.equal(pauses.length, 1);
  const tickets = store.tickets();
  assert.equal(tickets.length, 2); assert.notEqual(tickets[0].id, tickets[1].id);
  assert.deepEqual(tickets.map(ticket => ticket.status), ['reserved', 'usage_settled']);
  assert.equal(tickets[0].theoreticalNano, Math.ceil(transport.measure(body).estimatedCostUsd * 1e9));
  assert.equal(tickets[1].theoreticalNano, 100000);
  const {decisionsTransport:metadata, ...received} = result;
  assert.deepEqual(received, response());
  assert.equal(metadata.attemptCount, 2); assert.equal(metadata.dispatchCount, 2);
  assert.equal(metadata.unknownReservedUsd, transport.measure(body).estimatedCostUsd);
  assert.deepEqual(metadata.attempts.map(item => [item.httpStatus, item.requestId]), [[504,'req_failed'],[200,'req_success']]);
});

test('a second 504 stops and exposes only mechanical failure metadata', async () => {
  const store = ledger();
  const transport = productionTransport(store, async () => new Response('SECRET_BODY_DO_NOT_RETAIN',
    {status:504, headers:{'x-request-id':'req_gateway'}}), env, {waitBeforeRetry:async () => {}});
  await assert.rejects(transport.invoke(body), error => {
    assert.equal(error.statusCode, 504); assert.equal(error.status, 504);
    assert.equal(error.decisionsFailure.upstreamHttpStatus, 504);
    assert.equal(error.decisionsFailure.attemptCount, 2); assert.equal(error.decisionsFailure.dispatchCount, 2);
    assert.equal(error.decisionsFailure.requestId, 'req_gateway');
    assert.equal(error.decisionsFailure.unknownReservedUsd, transport.measure(body).estimatedCostUsd * 2);
    assert(!JSON.stringify(error).includes('SECRET_BODY_DO_NOT_RETAIN'));
    return true;
  });
  assert.equal(transport.providerCalls(), 2);
  assert.deepEqual(store.tickets().map(ticket => ticket.status), ['reserved','reserved']);
});

test('a retry response without usage retains both unknown reservations', async () => {
  const store = ledger(); let count = 0;
  const transport = productionTransport(store, async () => ++count === 1
    ? new Response('',{status:504}) : Response.json(response(null)), env, {waitBeforeRetry:async()=>{}});
  const result = await transport.invoke(body);
  assert.equal(result.decisionsTransport.unknownReservedUsd, 2 * transport.measure(body).estimatedCostUsd);
  assert.deepEqual(store.tickets().map(ticket=>ticket.status),['reserved','reserved']);
});

test('the actual local timeout does not retry or become an upstream HTTP 504', async () => {
  const store = ledger(); let pauses = 0;
  const transport = productionTransport(store, async (_url,{signal})=>new Promise((_resolve,reject)=>{
    const keepAlive=setTimeout(()=>reject(new Error('local timeout did not abort')),100);
    signal.addEventListener('abort',()=>{clearTimeout(keepAlive);reject(signal.reason);},{once:true});
  }), {...env,OPENAI_DECISIONS_TIMEOUT_MS:'10'}, {waitBeforeRetry:async()=>{pauses+=1;}});
  await assert.rejects(transport.invoke(body), error=>{
    assert.equal(error.name,'TimeoutError');assert.equal(error.decisionsFailure.upstreamHttpStatus,null);
    assert.equal(error.decisionsFailure.dispatchCount,1);assert.equal(error.statusCode,undefined);return true;
  });
  assert.equal(transport.providerCalls(),1);assert.equal(pauses,0);
});

test('only the explicit transient HTTP allowlist retries', async () => {
  for (const status of [502,503,504,520,521,522,523,524]) {
    const store = ledger(); let count = 0, pauses = 0;
    const transport = productionTransport(store, async () => ++count === 1
      ? new Response('', {status}) : Response.json(response()), env,
    {waitBeforeRetry:async () => {pauses += 1;}});
    await transport.invoke(body);
    assert.equal(count,2); assert.equal(pauses,1);
  }
  for (const failure of [new Error('unknown connection failure'), new DOMException('local timeout','TimeoutError')]) {
    const store = ledger(); let pauses = 0;
    const transport = productionTransport(store, async () => {throw failure;}, env,
      {waitBeforeRetry:async () => {pauses += 1;}});
    await assert.rejects(transport.invoke(body), error => error === failure);
    assert.equal(transport.providerCalls(),1); assert.equal(pauses,0);
  }
});

test('second-attempt budget denial cannot issue a second HTTP request or release the first ticket', async () => {
  const store = ledger();
  const transport = productionTransport(store, async () => new Response('',{status:504}),
    {...env, PUBLIC_OPENAI_DAILY_LIMIT_USD:'0.0006'}, {waitBeforeRetry:async () => {}});
  await assert.rejects(transport.invoke(body), error => {
    assert.equal(error.code,'official_daily_budget_exceeded');
    assert.equal(error.decisionsFailure.attemptCount,2); assert.equal(error.decisionsFailure.dispatchCount,1);
    assert.equal(error.decisionsFailure.attempts[1].dispatched,false);
    return true;
  });
  assert.equal(transport.providerCalls(),1); assert.equal(store.tickets().length,1);
  assert.equal(store.tickets()[0].status,'reserved');
});

test('caller cancellation during retry backoff stops before another reservation', async () => {
  const store = ledger(), controller = new AbortController(), reason = new Error('cancel retry');
  let reachedWait;
  const waiting = new Promise(resolve => {reachedWait=resolve;});
  const transport = productionTransport(store, async () => new Response('',{status:504}), env,
    {waitBeforeRetry:async (_delay,{signal}) => new Promise((_resolve,reject) => {
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true}); reachedWait();
    })});
  const pending=transport.invoke(body,{signal:controller.signal});
  const rejected=assert.rejects(pending,error=>error===reason);
  await waiting; controller.abort(reason); await rejected;
  assert.equal(transport.providerCalls(),1); assert.equal(store.tickets().length,1);
});

test('abort after reservation is propagated and cannot release uncertain spend', async () => {
  const store = ledger(), controller = new AbortController();
  const reason = new Error('synthetic caller disconnect');
  let announce; const started = new Promise(resolve => {announce = resolve;});
  const transport = productionTransport(store, async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true}); announce();
  }));
  const pending = transport.invoke(body, {signal:controller.signal});
  const rejected = assert.rejects(pending, error => error === reason);
  await started; controller.abort(reason); await rejected;
  assert.equal(store.tickets()[0].status, 'reserved');
  assert.equal(transport.providerCalls(), 1);
});

test('cancellation while reading the response preserves the caller reason and reservation', async () => {
  const store = ledger(), controller = new AbortController(), reason = new Error('synthetic body-read abort');
  const transport = productionTransport(store, async () => ({ok:true, json:async () => {
    controller.abort(reason); throw new Error('synthetic stream closed');
  }}));
  await assert.rejects(transport.invoke(body, {signal:controller.signal}), error => error === reason);
  assert.equal(store.tickets()[0].status, 'reserved');
});

test('missing input usage keeps a reservation while input-only and zero usage settle', async () => {
  for (const usage of [null, {output_tokens:1}, {input_tokens:'100'}, {input_tokens:-1}, {input_tokens:1.5}, {input_tokens:100}, {input_tokens:0}]) {
    const store = ledger();
    const transport = productionTransport(store, async () => Response.json(response(usage)));
    assert.deepEqual(await transport.invoke(body), response(usage));
    const valid = Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0;
    assert.equal(store.tickets()[0].status, valid ? 'usage_settled' : 'reserved');
    if (valid) assert.equal(store.tickets()[0].theoreticalNano, Math.ceil(decisionsCostUsd(usage.input_tokens) * 1e9));
  }
});

test('settlement outage preserves a valid result and leaves the durable upper bound reserved', async () => {
  const store = ledger({settlementFailure:true});
  const transport = productionTransport(store, async () => Response.json(response()));
  assert.deepEqual(await transport.invoke(body), response());
  assert.equal(store.tickets()[0].status, 'reserved');
  assert.equal(transport.providerCalls(), 1);
});

test('malformed receipt stays reserved; raw answer errors remain available for caller accounting before parsing', async () => {
  const store = ledger();
  const invalidJson = productionTransport(store, async () => new Response('{broken'));
  await assert.rejects(invalidJson.invoke(body), /response_json_invalid/);
  assert.equal(store.tickets()[0].status, 'reserved');
  const malformed = productionTransport(store, async () => Response.json({...response(), answers:[]}));
  const raw = await malformed.invoke(body);
  assert.equal(raw.usage.input_tokens, 1000);
  assert.throws(() => parseDecisionsAnswers(raw, body), /answer_count/);
  assert.equal(store.tickets()[1].status, 'usage_settled');
});

test('daily limit accounts for unknown reservations across new transport instances', async () => {
  const store = ledger(), config = {...env, PUBLIC_OPENAI_DAILY_LIMIT_USD:'0.0006'};
  const first = productionTransport(store, async () => {throw new Error('synthetic network reset');}, config);
  await assert.rejects(first.invoke(body), /network reset/);
  const second = productionTransport(store, async () => Response.json(response()), config);
  let dispatches = 0;
  await assert.rejects(second.invoke(body, {onDispatch:() => {dispatches += 1;}}), error => error.code === 'official_daily_budget_exceeded');
  assert.equal(dispatches, 0);
  assert.equal(first.providerCalls(), 1); assert.equal(second.providerCalls(), 0);
  assert.equal(store.tickets().length, 1);
  assert.equal(store.tickets()[0].status, 'reserved');
});

test('budget layer rejects forged measurements and prices long context without generation output', async () => {
  const commands = [];
  const budget = createCloudRequestBudget({env:{CLOUD_BUDGET_RUN_ID:'local', CLOUD_BUDGET_ACTUAL_LIMIT_CNY:'0',
    CLOUD_BUDGET_THEORETICAL_LIMIT_USD:'5'}, command:async args => {commands.push(args); return ['reserved'];}});
  await assert.rejects(budget.decisions({body, measurement:{inputTokensUpperBound:1}, invoke:async () => response()}), /measurement_mismatch/);
  assert.equal(commands.length, 0);
  const long = {...body, input:'x'.repeat(273000)};
  await budget.decisions({body:long, invoke:async () => response(null)});
  const ticket = JSON.parse(commands[0][11]);
  assert.equal(ticket.theoreticalNano, Math.ceil(decisionsCostUsd(ticket.reservationMetadata.inputTokensUpperBound) * 1e9));
  assert.ok(ticket.theoreticalNano > 54000000);
});

test('official Decisions cannot dispatch without the persistent daily store', async () => {
  let invoked = false;
  await assert.rejects(runOfficialDecisionsRequest({env:{PUBLIC_OPENAI_BUDGET_RUN_ID:'test'}, body,
    invoke:async () => {invoked = true; return response();}}), /persistent_store_required/);
  assert.equal(invoked, false);
});
