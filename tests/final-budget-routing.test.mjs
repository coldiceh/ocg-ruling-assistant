import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const source = path.resolve(process.env.CLOUD_BUDGET_TEST_SOURCE || '.');
const {callRagModel, callRelayJsonTask, createPublicAnswerModelEnv} = await import(pathToFileURL(path.join(source, 'backend/ragModelClient.mjs')));
const {runCloudBudgetedQuestion} = await import(pathToFileURL(path.join(source, 'backend/cloudRequestBudget.mjs')));
const {withPublicGenerationInfo} = await import(pathToFileURL(path.join(source, 'backend/publicGenerationInfo.mjs')));
const config = {RAG_EVIDENCE_PIPELINE:'cloud_evidence_v1', RELAY_API_KEY:'synthetic', RELAY_BASE_URL:'https://relay.invalid/v1'};

function transport(calls) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return new Response(`data: ${JSON.stringify({model:body.model,choices:[{index:0,delta:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\ndata: [DONE]\n\n`, {headers:{'content-type':'text/event-stream'}});
  };
}

test('real final and auxiliary Relay adapters route to different accounting stages', async () => {
  const stages = [], sends = [];
  const budget = {relay:async ({stage,invoke}) => {stages.push(stage);return invoke();}, snapshot:() => ({})};
  const env = createPublicAnswerModelEnv(config, 'relay-gpt-5.6-sol-low');
  await runCloudBudgetedQuestion({env,budget}, () => callRagModel({prompt:'Synthetic final prompt',env,outputMode:'plain_text',fetchImpl:transport(sends)}));
  await runCloudBudgetedQuestion({env,budget}, () => callRelayJsonTask({prompt:'Synthetic auxiliary task',env,maxTokens:100,fetchImpl:transport(sends)}));
  assert.deepEqual(stages, ['final_ruling','evidence_preparation']);
  assert.equal(sends.length, 2);
});

test('answer receipts select the corresponding independent GPT allowance', async () => {
  const buckets = [
    {id:'final_ruling:relay',label:'中转 GPT 最终裁定',currency:'USD',remainingToday:8,dailyBudget:10},
    {id:'final_ruling:bai',label:'GPT最终裁定',currency:'USD',remainingToday:9,dailyBudget:10},
  ];
  for (const [provider,remaining,label] of [['relay',8,'中转 GPT 最终裁定'],['bai',9,'GPT最终裁定']]) {
    const answer = await withPublicGenerationInfo({shortAnswer:'Synthetic answer',debug:{dryRun:false,providerUsed:provider,returnedModel:'test-model'}},
      {provider,model:'test-model',label}, {}, {readBudget:async () => ({buckets})});
    assert.equal(answer.generation.budget.remainingAmount, remaining);
    assert.equal(answer.generation.budget.sharedPoolLabel, label);
  }
});
