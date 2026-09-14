import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {createGeminiBoundedEvidenceProvider} from '../backend/geminiBoundedEvidenceProvider.mjs';

test('model-requested section enters reading before automatic navigation hits',async()=>{
  let generation=0,requestedSectionId;
  const provider=createGeminiBoundedEvidenceProvider({
    loadAssets:async()=>({dataRevision:'d',qaRevision:'q',rulesRecords:[
      {id:'first',recordType:'rule-doc',title:'automatic source',text:'automatic paragraph'},
      {id:'second',recordType:'rule-doc',title:'requested source',text:'requested paragraph',structure:{schemaVersion:1,canonicalSha256:createHash('sha256').update('requested paragraph').digest('hex'),sections:[{id:'section',title:'requested source',start:0,end:19}]}}],
      createQaTools:()=>({snapshotHandles:[],readSelected:()=>[],search:()=>({items:[]})})}),
    loadDenseSearch:async({rules})=>({search:()=>[rules.units.get('R1.1')]}),
    loadQaSearch:async()=>({search:()=>[]}),budgetedRequest:r=>r.invoke(),
    fetchImpl:async(url,init)=>{
      if(url.endsWith(':embedContent'))return Response.json({embedding:{values:Array(768).fill(1)},usageMetadata:{promptTokenCount:10}});
      if(url.endsWith(':countTokens'))return Response.json({totalTokens:500});
      if(++generation===1){const input=JSON.parse(JSON.parse(init.body).contents[0].parts[1].text);requestedSectionId=input.ruleSections.find(row=>row[2]==='requested source')[0];}
      const output=generation===1?{informationNeeds:[],queries:[],ruleSectionIds:[requestedSectionId]}:{ruleUnitIds:['R2.1'],qaHandles:[]};
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(output)}]}}],usageMetadata:{promptTokenCount:500,candidatesTokenCount:10}});
    }});
  const result=await provider.retrieve({userQuery:'fixture',cardResolution:{resolvedCards:[]},retrievedEvidence:{},dataRevision:'d',env:{GEMINI_API_KEY:'fixture'}});
  assert.equal(result.telemetry.readGroupIds[0],requestedSectionId);
  assert.ok(result.telemetry.readGroupIds.includes('R1.1'));
});
