import assert from 'node:assert/strict';
import test from 'node:test';
import {requestRelayChatCompletionSse} from '../backend/rulingModelProviders.mjs';

const encode=value=>new TextEncoder().encode(value);
const frame=value=>`data: ${JSON.stringify(value)}\n\n`;
const content=frame({id:'synthetic-stream',model:'gpt-6-astra',choices:[{index:0,delta:{content:'Complete answer'},finish_reason:'stop'}]});
const usage=frame({id:'synthetic-stream',model:'gpt-6-astra',choices:[],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}});

test('a valid DONE returns complete content and usage without waiting for a kept-open HTTP body',async()=>{
  let readCalls=0,cancelCalls=0,releaseCalls=0,clockValue=0;
  const chunks=[content,usage,'data: [DONE]\n\n'];
  const controller=new AbortController();
  const watchdog=setTimeout(()=>controller.abort(new Error('test observed unnecessary EOF wait')),40);
  try{
    const result=await requestRelayChatCompletionSse({apiKey:'synthetic-test-key',endpoint:'https://example.invalid/v1/chat/completions',
      body:{model:'gpt-6-astra'},signal:controller.signal,clock:()=>clockValue+=10,
      fetchImpl:async()=>({ok:true,status:200,headers:{get:()=> 'text/event-stream'},body:{getReader:()=>({
        read:async()=>{const text=chunks[readCalls++];return text===undefined?new Promise(()=>{}):{done:false,value:encode(text)};},
        cancel:()=>{cancelCalls+=1;return new Promise(()=>{});},releaseLock:()=>{releaseCalls+=1;},
      })}})});
    assert.equal(result.choices[0].message.content,'Complete answer');
    assert.deepEqual(result.usage,{prompt_tokens:10,completion_tokens:3,total_tokens:13});
    assert.equal(readCalls,3,'no fourth read after terminal DONE');
    assert.equal(cancelCalls,1);assert.equal(releaseCalls,1);
    assert.equal(result.stream_metrics.requestToDoneMs,result.stream_metrics.requestToCompleteMs);
    assert.equal(result.stream_metrics.responseBodyReadMs,
      result.stream_metrics.requestToCompleteMs-result.stream_metrics.requestToResponseHeadersMs);
  }finally{clearTimeout(watchdog);}
});

test('without DONE the parser continues until clean EOF and retains late usage',async()=>{
  let readCalls=0,cancelCalls=0;
  const chunks=[content,usage];
  const result=await requestRelayChatCompletionSse({apiKey:'synthetic-test-key',endpoint:'https://example.invalid/v1/chat/completions',
    body:{model:'gpt-6-astra'},fetchImpl:async()=>({ok:true,status:200,headers:{get:()=> 'text/event-stream'},body:{getReader:()=>({
      read:async()=>{const text=chunks[readCalls++];return text===undefined?{done:true}:{done:false,value:encode(text)};},
      cancel:()=>{cancelCalls+=1;},releaseLock:()=>{},
    })}})});
  assert.equal(readCalls,3);assert.equal(cancelCalls,0);
  assert.equal(result.usage.total_tokens,13);assert.equal(result.choices[0].message.content,'Complete answer');
  assert.equal(result.stream_metrics.requestToDoneMs,null);
});

test('DONE with no answer remains an invalid completion rather than a successful partial result',async()=>{
  let readCalls=0;
  await assert.rejects(requestRelayChatCompletionSse({apiKey:'synthetic-test-key',endpoint:'https://example.invalid/v1/chat/completions',
    body:{model:'gpt-6-astra'},fetchImpl:async()=>({ok:true,status:200,headers:{get:()=> 'text/event-stream'},body:{getReader:()=>({
      read:async()=>++readCalls===1?{done:false,value:encode('data: [DONE]\n\n')}:{done:true},
      cancel:()=>{},releaseLock:()=>{},
    })}})}),error=>error.code==='relay_stream_empty');
});

test('data already received after DONE remains a protocol error',async()=>{
  for(const trailing of [usage,'data: {']){
    let readCalls=0,cancelCalls=0,releaseCalls=0;
    await assert.rejects(requestRelayChatCompletionSse({apiKey:'synthetic-test-key',endpoint:'https://example.invalid/v1/chat/completions',
      body:{model:'gpt-6-astra'},fetchImpl:async()=>({ok:true,status:200,headers:{get:()=> 'text/event-stream'},body:{getReader:()=>({
        read:async()=>{readCalls+=1;return {done:false,value:encode(content+'data: [DONE]\n\n'+trailing)};},
        cancel:()=>{cancelCalls+=1;},releaseLock:()=>{releaseCalls+=1;},
      })}})}),error=>error.code==='relay_stream_protocol_error');
    assert.equal(readCalls,1);assert.equal(cancelCalls,1);assert.equal(releaseCalls,1);
  }
});
