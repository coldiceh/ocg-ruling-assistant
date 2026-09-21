import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createRetryingGeminiEmbeddingTransport,embeddingHttpDiagnostic} from '../scripts/lib/gemini-embedding-transport.mjs';
import {mapCacheIo} from '../scripts/lib/evidence-sync-io.mjs';
import {stableQaSelection,preserveFetchTimestamp} from '../scripts/lib/sync-input-stability.mjs';
import {buildQaIndex} from '../backend/dataIndex.mjs';
import {fetchText} from '../scripts/sync-ocg-rule.mjs';
import {quoteNavigation,createSyncBatchBudget} from '../scripts/lib/evidence-sync-batch-budget.mjs';
import {fakeBatchRedis} from './helpers/evidence-sync-budget-fixture.mjs';
import {loadEvidenceGenerationContract} from '../backend/evidenceGenerationContract.mjs';
const profile={model:'gemini-embedding-2',dimension:768,autoTruncate:false};
const rejected=(detail=[],headers={})=>new Response(JSON.stringify({error:{status:'RESOURCE_EXHAUSTED',details:detail}}),{status:429,headers});
const ok=()=>new Response(JSON.stringify({embeddings:[{values:[1]}]}),{status:200});
test('429 respects server retry delay and repeats the exact request, with a finite timeout',async()=>{
 let calls=0,time=0;const waits=[],bodies=[];
 const run=createRetryingGeminiEmbeddingTransport({apiKey:'fixture',now:()=>time,sleep:async ms=>{time+=ms;waits.push(ms);},random:()=>0,fetchImpl:async(_url,o)=>{bodies.push(o.body);assert.ok(o.signal);return calls++===0?rejected([],{'retry-after':'7'}):ok();}});
 await run(['source'],profile);assert.equal(calls,2);assert.equal(bodies[0],bodies[1]);assert.equal(waits[0],7000);
});
test('repeated 429s stop after bounded retries and retain a safe structured diagnostic',async()=>{
 let calls=0;const run=createRetryingGeminiEmbeddingTransport({apiKey:'fixture',maxRetries:2,minIntervalMs:0,sleep:async()=>{},random:()=>0,fetchImpl:async()=>{calls++;return rejected();}});
 await assert.rejects(run(['source'],profile),e=>e.requestRejected===true&&e.responseDiagnostic.httpStatus===429);assert.equal(calls,3);
});
test('daily quota does not spin through minute-limit retries',async()=>{
 let calls=0;const run=createRetryingGeminiEmbeddingTransport({apiKey:'fixture',fetchImpl:async()=>{calls++;return rejected([{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'EmbeddingRequestsPerDay'}]}]);}});
 await assert.rejects(run(['source'],profile),e=>e.responseDiagnostic.dailyQuota);assert.equal(calls,1);
});
test('5xx and lost responses remain unknown submitted requests, never silently rebilled',async()=>{
 for(const fetchImpl of [async()=>new Response('{}',{status:503}),async()=>{throw new Error('lost');}]){
  let calls=0;const run=createRetryingGeminiEmbeddingTransport({apiKey:'fixture',fetchImpl:async(...a)=>{calls++;return fetchImpl(...a);}});
  await assert.rejects(run(['source'],profile),e=>e.requestRejected!==true);assert.equal(calls,1);
 }
});
test('RetryInfo and HTTP date are parsed without exposing source data',()=>{
 const d=embeddingHttpDiagnostic({status:429,headers:new Headers({'retry-after':'Thu, 01 Jan 1970 00:00:10 GMT'})},{error:{message:'do not log input',details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'12.5s'}]}},0);
 assert.equal(d.retryAfterMs,12500);assert.ok(!JSON.stringify(d).includes('do not log'));
});
test('cache I/O is bounded concurrent and preserves input order',async()=>{
 let live=0,max=0;const r=await mapCacheIo([1,2,3,4,5],async x=>{max=Math.max(max,++live);await delay(2);live--;return x*2;},2);
 assert.deepEqual(r,[2,4,6,8,10]);assert.equal(max,2);assert.equal(live,0);
});
test('failed cache I/O drains in-flight work before returning',async()=>{
 let live=0;await assert.rejects(mapCacheIo([1,2,3,4],async x=>{live++;await delay(2);live--;if(x===1)throw Error('failed');return x;},2),/failed/);assert.equal(live,0);
});
test('fetch timestamp alone never invalidates source content; real fields still do',()=>{
 const old={id:'1',recordType:'qa',updatedAt:'old',conclusion:'body',sourceUrl:'a'};
 assert.equal(preserveFetchTimestamp({...old,updatedAt:'new'},old),old);
 for(const change of [{conclusion:'new body'},{sourceUrl:'b'},{newField:'added'}])assert.equal(preserveFetchTimestamp({...old,...change,updatedAt:'new'},old).updatedAt,'new');
});
test('rolling QA detail coverage keeps exact prior full records, including all answer fields',()=>{
 const old={id:'ygoresources-qa-1',recordType:'qa',title:'title',question:'question',conclusion:'answer',updatedAt:'old',sources:[{label:'source'}]};
 const idx=JSON.parse(JSON.stringify(buildQaIndex([old],[])));
 assert.equal(stableQaSelection(idx,[],[old],[])[0],old);
 assert.equal(stableQaSelection(idx,[{...old,updatedAt:'new'}],[old],[])[0],old);
 assert.equal(stableQaSelection([],[],[old],[]).length,0);
 const changed={...old,conclusion:'changed answer',updatedAt:'new'};
 assert.equal(stableQaSelection(idx,[changed],[old],[])[0],changed);
 assert.notEqual(stableQaSelection([{...idx[0],answer:'edited index'}],[],[old],[])[0],old);
});
test('GET transient failures retry finitely and never publish a missing source as complete',async()=>{
 let calls=0;assert.equal(await fetchText('https://example.test',{sleep:async()=>{},fetchImpl:async()=>++calls===1?Promise.reject(Error('network')):new Response('body')}),'body');assert.equal(calls,2);
 calls=0;await assert.rejects(fetchText('https://example.test',{sleep:async()=>{},fetchImpl:async()=>{calls++;return new Response('missing',{status:404});}}),/404/);assert.equal(calls,1);
});
test('navigation reservation scales with actual serialized request, not the million-token capacity',()=>{
 const c=loadEvidenceGenerationContract('navigation',{profileUrl:new URL('../config/evidence-generation/bai-gpt-5.6-luna-medium-theoretical.json',import.meta.url)});
 const small=quoteNavigation(c,{body:{input:'short'}}),large=quoteNavigation(c,{body:{input:'長'.repeat(10000)}});
 assert.ok(small<0.01);assert.ok(large>small);assert.ok(large<quoteNavigation(c));
});
test('raw replay settles one batch once even when many rows share the same bill',async()=>{
 const redis=fakeBatchRedis();let calls=0;const budget=await createSyncBatchBudget({command:async args=>{calls++;return redis.command(args);},namespace:'test',batchId:'a'.repeat(64)});
 await budget.reserve({ticket:'batch',amountUsd:0.2});const before=calls;
 await Promise.all(Array.from({length:100},()=>budget.settle({ticket:'batch',spentUsd:0.01})));
 assert.equal(calls-before,1);assert.equal(budget.snapshot().spentUsd,0.01);
});
import {buildFaqRecords} from '../scripts/sync-ygoresources.mjs';
import {embeddingInputAllocation} from '../scripts/refresh-gemini-source-embeddings.mjs';
test('FAQ fallback fetch dates are stable but source-authored dates are never suppressed',()=>{
 const item={record:{id:'1',name:'fixture',sourceUrl:'source',updatedAt:'first'},payload:{faqData:{entries:{'0':['body']}}}};
 const [old]=buildFaqRecords([item]);item.record.updatedAt='second';assert.equal(buildFaqRecords([item],[old])[0],old);
 item.payload.faqData.meta={ja:{date:'explicit-date'}};assert.equal(buildFaqRecords([item],[old])[0].updatedAt,'explicit-date');
});
test('short embedding requests do not reserve the entire model input capacity',()=>{
 assert.equal(embeddingInputAllocation('abc'),259);assert.equal(embeddingInputAllocation('abc'.repeat(10000)),8192);assert.equal(embeddingInputAllocation('中文'),262);
});
