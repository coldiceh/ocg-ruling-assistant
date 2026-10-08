import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createDecisionsTransport, DECISIONS_ENDPOINT} from '../backend/decisionsTransport.mjs';
import {CLOUD_BUDGET_RESERVE, CLOUD_BUDGET_SETTLE, CLOUD_BUDGET_SETTLE_AND_RESERVE,
  runOfficialDecisionsRequest, runOfficialDecisionsSequence} from '../backend/cloudRequestBudget.mjs';

const env = {OPENAI_API_KEY:'synthetic-secret', PUBLIC_OPENAI_BUDGET_RUN_ID:'sequence-test',
  PUBLIC_OPENAI_DAILY_LIMIT_USD:'5', API_BUDGET_TIMEZONE:'UTC',
  UPSTASH_BUDGET_KV_REST_API_URL:'https://budget.invalid', UPSTASH_BUDGET_KV_REST_API_TOKEN:'synthetic-secret'};
const body = {model:'gpt-6-luna', input:'Synthetic source.', questions:[{type:'choice', name:'source',
  instructions:'Choose one.', choices:[{value:'A'}, {value:'UNKNOWN'}]}]};
const response = (input = 1000) => ({model:body.model, answers:[{name:'source',type:'choice',choice:'A'}],
  ...(input === null ? {} : {usage:{input_tokens:input}})});

function memoryStore() {
  const hashes = new Map();
  const hash = key => {if (!hashes.has(key)) hashes.set(key,new Map()); return hashes.get(key);};
  const settle = (target,id,cny,usd,value) => {
    if (!target.has(id)) return ['missing'];
    const prior = JSON.parse(target.get(id));
    if (prior.status !== 'reserved') return ['settled',target.get(id)];
    target.set('actualNano', String(Number(target.get('actualNano')) + Number(cny) - prior.actualNano));
    target.set('theoreticalNano', String(Number(target.get('theoreticalNano')) + Number(usd) - prior.theoreticalNano));
    target.set(id,value); return ['settled'];
  };
  return {close() {}, async request(command) {
    if (command[0] === 'HGETALL') return [...hash(command[1])].flat();
    if (command[0] === 'HSET') {for(let i=2;i<command.length;i+=2) hash(command[1]).set(command[i],command[i+1]); return 1;}
    assert.equal(command[0],'EVAL');
    const count=Number(command[2]), keys=command.slice(3,3+count), args=command.slice(3+count), target=hash(keys[0]);
    if (command[1]===CLOUD_BUDGET_SETTLE) return settle(target,...args);
    if (command[1]===CLOUD_BUDGET_SETTLE_AND_RESERVE) {
      const prior=target.get(args[11]); if(!prior) return ['settlement_missing'];
      if(JSON.parse(prior).provider!=='openai'||JSON.parse(prior).operation!=='decisions') return ['settlement_invalid'];
      settle(target,args[11],args[12],args[13],args[14]);
    } else assert.equal(command[1],CLOUD_BUDGET_RESERVE);
    if(target.has(args[0])) return ['existing',target.get(args[0])];
    if(args[8]==='official_daily_v1'&&!target.has('theoreticalNano')) {
      let migrated=0;
      for(const [id,value] of hash(keys[1])) {
        if(['actualNano','theoreticalNano'].includes(id)) continue;
        const old=JSON.parse(value);
        if(old.provider==='openai'&&['reserved','usage_settled'].includes(old.status)
          &&old.startedAtUtc>=args[9]&&old.startedAtUtc<args[10]) {target.set(id,value);migrated+=old.theoreticalNano;}
      }
      target.set('actualNano','0');target.set('theoreticalNano',String(migrated));
    }
    const cny=Number(target.get('actualNano')||args[5]), usd=Number(target.get('theoreticalNano')||args[6]);
    if(cny+Number(args[1])>Number(args[3])||usd+Number(args[2])>Number(args[4])) return ['blocked'];
    target.set('actualNano',String(cny+Number(args[1])));target.set('theoreticalNano',String(usd+Number(args[2])));
    target.set(args[0],args[7]);return ['reserved'];
  }};
}

function luaStore() {
  const child=spawn(process.env.CLOUD_BUDGET_LUA_PYTHON,['tests/helpers/cloud-budget-lua.py'],{stdio:['pipe','pipe','inherit']});
  const pending=[];
  createInterface({input:child.stdout}).on('line',line=>pending.shift()?.(JSON.parse(line)));
  const fail=error=>{while(pending.length) pending.shift()({error:String(error)});};
  child.on('error',fail);child.on('exit',code=>{if(code!==0) fail(`Lua helper exited ${code}`);});
  return {close:()=>child.kill(), request:args=>new Promise((resolve,reject)=>{
    pending.push(reply=>reply.error?reject(new Error(reply.error)):resolve(reply.result));
    child.stdin.write(`${JSON.stringify({args})}\n`);
  })};
}

async function fixture(t, kind, provider=async()=>Response.json(response()), config=env) {
  const storage=kind==='lua'?luaStore():memoryStore();t.after(()=>storage.close());
  const state={commands:[],dispatches:0,keys:new Set(), before:null,after:null};
  const fetchImpl=async(url,options)=>{
    if(url===DECISIONS_ENDPOINT) {state.dispatches++;return provider(options,state);}
    assert.equal(url,env.UPSTASH_BUDGET_KV_REST_API_URL);
    const command=JSON.parse(options.body);state.commands.push(command);state.keys.add(command[3]);
    await state.before?.(command);
    const result=await storage.request(command);
    await state.after?.(command,result);
    return Response.json({result});
  };
  const snapshot=async()=>{
    const rows=[];
    for(const key of state.keys) {
      const fields=await storage.request(['HGETALL',key]);
      rows.push({key,accountedNano:Number(new Map(Array.from({length:fields.length/2},(_,i)=>fields.slice(i*2,i*2+2))).get('theoreticalNano')||0),
        tickets:Array.from({length:fields.length/2},(_,i)=>fields.slice(i*2,i*2+2))
          .filter(([key])=>!['actualNano','theoreticalNano'].includes(key)).map(([,value])=>JSON.parse(value))});
    }
    return rows;
  };
  const transport=createDecisionsTransport({env:config,fetchImpl,waitBeforeRetry:async()=>{}});
  return {state,storage,snapshot,fetchImpl,transport};
}

for(const kind of ['memory',...(process.env.CLOUD_BUDGET_LUA_PYTHON?['lua']:[])]) {
  test(`${kind}: sixteen sequential calls need seventeen ledger trips with a durable reservation before every dispatch`,async t=>{
    const f=await fixture(t,kind,async()=>{
      const [{tickets}]=await f.snapshot();assert.equal(tickets.at(-1).status,'reserved');
      return Response.json(response());
    });
    const results=await f.transport.runSequence(async()=>{
      const results=[];
      for(let i=0;i<16;i++) {results.push(await f.transport.invoke(body));
        const [{tickets}]=await f.snapshot();assert.equal(tickets.at(-1).status,'reserved');}
      return results;
    });
    assert.deepEqual(results,Array.from({length:16},()=>response()));
    assert.equal(f.state.dispatches,16);assert.equal(f.state.commands.length,17);
    assert.deepEqual(f.state.commands.map(c=>c[1]),[CLOUD_BUDGET_RESERVE,
      ...Array(15).fill(CLOUD_BUDGET_SETTLE_AND_RESERVE),CLOUD_BUDGET_SETTLE]);
    const [{tickets,accountedNano}]=await f.snapshot();
    assert(tickets.every(row=>row.status==='usage_settled'));assert.equal(accountedNano,16*100000);
  });

  test(`${kind}: blocked next reservation still settles the previous response`,async t=>{
    const config={...env,PUBLIC_OPENAI_DAILY_LIMIT_USD:'0.0006'};
    const f=await fixture(t,kind,async()=>Response.json(response(2000)),config);
    await assert.rejects(f.transport.runSequence(async()=>{
      await f.transport.invoke(body);await f.transport.invoke(body);
    }),error=>error.code==='official_daily_budget_exceeded');
    const [{tickets,accountedNano}]=await f.snapshot();assert.equal(f.state.dispatches,1);
    assert.equal(f.state.commands.length,2);assert.equal(tickets[0].status,'usage_settled');assert.equal(accountedNano,200000);
  });

  test(`${kind}: retry has its own full reservation and unknown usage is never released`,async t=>{
    const f=await fixture(t,kind,async(_options,state)=>state.dispatches===2
      ?new Response('',{status:504}):Response.json(response()));
    await f.transport.runSequence(async()=>{
      await f.transport.invoke(body);await f.transport.invoke(body);await f.transport.invoke(body);
    });
    const [{tickets,accountedNano}]=await f.snapshot();
    assert.deepEqual(tickets.map(t=>t.status),['usage_settled','reserved','usage_settled','usage_settled']);
    assert.equal(accountedNano,300000+Math.ceil(f.transport.measure(body).estimatedCostUsd*1e9));
    assert.equal(f.state.commands.length,5);
  });

  test(`${kind}: missing usage retains the reservation while following known usage settles`,async t=>{
    const f=await fixture(t,kind,async(_options,state)=>Response.json(response(state.dispatches===1?null:0)));
    await f.transport.runSequence(async()=>{await f.transport.invoke(body);await f.transport.invoke(body);});
    const [{tickets,accountedNano}]=await f.snapshot();assert.deepEqual(tickets.map(t=>t.status),['reserved','usage_settled']);
    assert.equal(accountedNano,tickets[0].theoreticalNano);assert.equal(tickets[1].theoreticalNano,0);
  });

  test(`${kind}: a transport failure after a known response retains only the failed call's full allocation`,async t=>{
    const failure=new DOMException('synthetic provider timeout','TimeoutError');
    const f=await fixture(t,kind,async(_options,state)=>{
      if(state.dispatches===2) throw failure;
      return Response.json(response());
    });
    await assert.rejects(f.transport.runSequence(async()=>{await f.transport.invoke(body);await f.transport.invoke(body);}),error=>error===failure);
    const [{tickets,accountedNano}]=await f.snapshot();
    assert.deepEqual(tickets.map(ticket=>ticket.status),['usage_settled','reserved']);
    assert.equal(accountedNano,100000+Math.ceil(f.transport.measure(body).estimatedCostUsd*1e9));
    assert.equal(f.state.dispatches,2);
  });

  test(`${kind}: caller abort or selection failure flushes known usage and preserves the original error`,async t=>{
    for(const mode of ['abort','selection']) {
      const f=await fixture(t,kind), reason=new Error(`synthetic ${mode}`), controller=new AbortController();
      await assert.rejects(f.transport.runSequence(async()=>{
        await f.transport.invoke(body);
        if(mode==='abort') {controller.abort(reason);await f.transport.invoke(body,{signal:controller.signal});}
        throw reason;
      }),error=>error===reason);
      const [{tickets,accountedNano}]=await f.snapshot();assert.equal(f.state.dispatches,1);
      assert.equal(tickets[0].status,'usage_settled');assert.equal(accountedNano,100000);
    }
  });

  test(`${kind}: final settlement outage leaves a conservative reservation without replacing a selection error`,async t=>{
    const f=await fixture(t,kind), reason=new Error('selection failure');
    f.state.before=command=>{if(command[1]===CLOUD_BUDGET_SETTLE) throw new Error('ledger offline');};
    await assert.rejects(f.transport.runSequence(async()=>{await f.transport.invoke(body);throw reason;}),error=>error===reason);
    const [{tickets,accountedNano}]=await f.snapshot();assert.equal(tickets[0].status,'reserved');
    assert.equal(accountedNano,Math.ceil(f.transport.measure(body).estimatedCostUsd*1e9));
  });

  for(const phase of ['before','after']) {
    test(`${kind}: uncertain combined ${phase}-commit response never dispatches the next request`,async t=>{
      const f=await fixture(t,kind), failure=new Error('combined response lost');
      f.state[phase]=command=>{if(command[1]===CLOUD_BUDGET_SETTLE_AND_RESERVE) throw failure;};
      await assert.rejects(f.transport.runSequence(async()=>{await f.transport.invoke(body);await f.transport.invoke(body);}),error=>error===failure);
      const [{tickets,accountedNano}]=await f.snapshot();assert.equal(f.state.dispatches,1);
      assert.equal(tickets[0].status,'usage_settled');
      assert.equal(tickets.length,phase==='after'?2:1);
      assert.equal(accountedNano,100000+(phase==='after'?Math.ceil(f.transport.measure(body).estimatedCostUsd*1e9):0));
      if(phase==='after') assert.equal(tickets[1].status,'reserved');
    });
  }

  test(`${kind}: usage above the reservation settles immediately and a failed write is surfaced`,async t=>{
    for(const fail of [false,true]) {
      const f=await fixture(t,kind,async()=>Response.json(response(100000)));
      if(fail) f.state.before=command=>{if(command[1]===CLOUD_BUDGET_SETTLE) throw new Error('overage settlement failed');};
      const run=f.transport.runSequence(async()=>{await f.transport.invoke(body);
        const [{tickets}]=await f.snapshot();assert.equal(tickets[0].status,'usage_settled');});
      if(fail) await assert.rejects(run,/overage settlement failed/);else {await run;assert.equal((await f.snapshot())[0].accountedNano,10000000);}
      assert.equal(f.state.dispatches,1);assert.equal(f.state.commands.length,2);
    }
  });

  test(`${kind}: other requests see the full pending reservation until it is durably settled`,async t=>{
    const config={...env,PUBLIC_OPENAI_DAILY_LIMIT_USD:'0.0006'}, f=await fixture(t,kind,undefined,config);
    let release;const gate=new Promise(resolve=>{release=resolve;});let started;
    const ready=new Promise(resolve=>{started=resolve;});
    const first=f.transport.runSequence(async()=>{await f.transport.invoke(body);started();await gate;});
    await ready;
    try {await assert.rejects(f.transport.invoke(body),error=>error.code==='official_daily_budget_exceeded');}
    finally {release();await first;}
    await f.transport.invoke(body);
    const [{tickets,accountedNano}]=await f.snapshot();assert.equal(tickets.length,2);assert.equal(accountedNano,200000);
  });

  test(`${kind}: midnight and nested sequences never mix pending tickets`,async t=>{
    const f=await fixture(t,kind);
    const call=now=>runOfficialDecisionsRequest({env,fetchImpl:f.fetchImpl,body,now:new Date(now),invoke:async()=>response()});
    await runOfficialDecisionsSequence(async()=>{
      await call('2060-01-01T23:59:59.000Z');await call('2060-01-02T00:00:01.000Z');
      await runOfficialDecisionsSequence(()=>call('2060-01-02T00:00:02.000Z'));
      await call('2060-01-02T00:00:03.000Z');
    });
    const rows=await f.snapshot();assert.equal(rows.length,2);
    assert.deepEqual(rows.map(row=>row.accountedNano),[100000,300000]);
    assert(rows.every(row=>row.tickets.every(ticket=>ticket.status==='usage_settled')));
    const combined=f.state.commands.filter(c=>c[1]===CLOUD_BUDGET_SETTLE_AND_RESERVE);assert.equal(combined.length,1);
    assert.match(combined[0][3],/2060-01-02$/);
  });

  test(`${kind}: dated legacy migration is preserved and replaying the combined command cannot charge twice`,async t=>{
    const f=await fixture(t,kind), now=new Date('2060-01-01T12:00:00.000Z');
    const legacy={id:'legacy-observed',provider:'openai',operation:'decisions',status:'reserved',actualNano:0,
      theoreticalNano:300000,startedAtUtc:'2060-01-01T01:00:00.000Z'};
    await f.storage.request(['HSET','ruling-cloud-budget:v1:sequence-test',legacy.id,JSON.stringify(legacy)]);
    const call=()=>runOfficialDecisionsRequest({env,fetchImpl:f.fetchImpl,body,now,invoke:async()=>response()});
    await runOfficialDecisionsSequence(async()=>{
      await call();await call();
      const command=f.state.commands.at(-1);assert.equal(command[1],CLOUD_BUDGET_SETTLE_AND_RESERVE);
      const before=await f.snapshot();
      assert.equal((await f.storage.request(command))[0],'existing');assert.deepEqual(await f.snapshot(),before);
    });
    const [{tickets,accountedNano}]=await f.snapshot();assert.equal(tickets.length,3);
    assert.equal(tickets[0].id,legacy.id);assert.equal(tickets[0].status,'reserved');assert.equal(accountedNano,500000);
  });

  test(`${kind}: concurrent use inside one sequence fails before an extra dispatch`,async t=>{
    let release,started;const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
    const f=await fixture(t,kind,async()=>{started();await gate;return Response.json(response());});
    await f.transport.runSequence(async()=>{
      const first=f.transport.invoke(body);await ready;
      try {await assert.rejects(f.transport.invoke(body),/sequence_concurrent/);}finally {release();await first;}
    });
    assert.equal(f.state.dispatches,1);assert.equal((await f.snapshot())[0].tickets[0].status,'usage_settled');
  });
}

test('an injected budget adapter preserves its original invocation and settlement contract',async()=>{
  let calls=0;
  const transport=createDecisionsTransport({env,fetchImpl:async()=>Response.json(response()),
    budgetedRequest:async request=>{calls++;return request.invoke();}});
  const value=await transport.runSequence(async()=>{await transport.invoke(body);await transport.invoke(body);return 17;});
  assert.equal(value,17);assert.equal(calls,2);
});
