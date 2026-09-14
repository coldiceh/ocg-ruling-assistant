import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiBoundedEvidenceProvider } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';

test('QA navigation can read a late candidate and final packing preserves its complete record', async () => {
  const records = Array.from({length:80},(_,i)=>({id:`fixture-${i}`,recordType:'qa',
    title:`source title ${i}`,question:`whole question ${i}`,answer:`whole answer ${i}`,official:true}));
  const qaTools=createQaTools({records,qaRevision:'q'});
  const items=qaTools.readSelected(qaTools.snapshotHandles);
  const target=items[65];
  const stages=[];
  const provider=createGeminiBoundedEvidenceProvider({loadAssets:async()=>({dataRevision:'d',qaRevision:'q',
    rulesRecords:[{id:'rule-fixture',recordType:'rule-doc',title:'fixture',text:'rule body'}],createQaTools:()=>qaTools}),loadDenseSearch:async()=>({search:()=>[]}),
    loadQaSearch:async()=>({search:()=>items}),budgetedRequest:r=>r.invoke(),fetchImpl:async(url,init)=>{
      const b=JSON.parse(init.body);
      if(url.endsWith(':embedContent'))return Response.json({embedding:{values:Array(768).fill(1)},usageMetadata:{promptTokenCount:100}});
      if(url.endsWith(':countTokens'))return Response.json({totalTokens:500});
      const p=JSON.parse(b.contents[0].parts[1].text);
      let output;
      if(p.qaCandidates){
        stages.push('qa_navigation');
        const row=p.qaCandidates.find(row=>row[1]===target.record.title);
        assert.ok(row,'late candidate title must be offered');
        output={qaCandidateIds:[row[0]]};
      } else if(p.groups){
        stages.push('selection');
        const visible=p.groups.flatMap(g=>g.items||[]);
        assert.deepEqual(visible.map(i=>i.handle),[target.handle]);
        assert.deepEqual(visible[0].record,target.record);
        output={ruleUnitIds:[],qaHandles:[target.handle]};
      } else {stages.push('plan');output={informationNeeds:[],queries:[],ruleSectionIds:[]};}
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(output)}]}}],
        usageMetadata:{promptTokenCount:500,candidatesTokenCount:20,totalTokenCount:520}});
    }});
  const result=await provider.retrieve({userQuery:'fixture question',cardResolution:{resolvedCards:[]},dataRevision:'d',env:{GEMINI_API_KEY:'fixture'}});
  assert.deepEqual(stages,['plan','qa_navigation','selection']);
  assert.equal(result.telemetry.rounds,3);
  assert.equal(result.packing.modelEvidence.rawRelatedEvidence[0].text,JSON.stringify(target.record));
});
