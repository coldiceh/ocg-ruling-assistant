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

test('an explicitly selected child is read before its also-selected ancestor without losing remaining units',async()=>{
  const parentPrefix='Parent introduction.\n\n', childText='Child paragraph.';
  const text=parentPrefix+childText;
  let generations=0,selectedInput;
  const provider=createGeminiBoundedEvidenceProvider({
    loadAssets:async()=>({dataRevision:'d',qaRevision:'q',rulesRecords:[{
      id:'nested',recordType:'rule-doc',title:'Nested document',text,
      structure:{schemaVersion:1,canonicalSha256:createHash('sha256').update(text).digest('hex'),
        sections:[{id:'parent',title:'Parent',start:0,end:text.length},
          {id:'child',parentId:'parent',title:'Child',start:parentPrefix.length,end:text.length}]}}],
      createQaTools:()=>({snapshotHandles:[],readSelected:()=>[],search:()=>({items:[]})})}),
    loadDenseSearch:async()=>({search:()=>[]}),loadQaSearch:async()=>({search:()=>[]}),
    budgetedRequest:r=>r.invoke(),fetchImpl:async(url,init)=>{
      if(url.endsWith(':embedContent'))return Response.json({embedding:{values:Array(768).fill(1)},usageMetadata:{promptTokenCount:10}});
      if(url.endsWith(':countTokens'))return Response.json({totalTokens:500});
      generations++;
      const input=JSON.parse(JSON.parse(init.body).contents[0].parts[1].text);
      if(generations===2)selectedInput=input;
      const output=generations===1?{informationNeeds:[],queries:[],ruleSectionIds:['S1.1','S1.2']}:{ruleUnitIds:[],qaHandles:[]};
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(output)}]}}],usageMetadata:{promptTokenCount:500,candidatesTokenCount:10}});
    }});
  await provider.retrieve({userQuery:'fixture',cardResolution:{resolvedCards:[]},retrievedEvidence:{},dataRevision:'d',env:{GEMINI_API_KEY:'fixture'}});
  const units=selectedInput.groups.flatMap(group=>group.units||[]);
  assert.deepEqual(units.map(row=>[row[0],row[1]]),[['R1.2',childText],['R1.1',parentPrefix]]);
});
