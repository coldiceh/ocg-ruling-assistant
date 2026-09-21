import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {buildSafeCandidates,buildManualCaptureReferenceParagraphRecords,
  manualCaptureCandidateStableFingerprint} from '../scripts/lib/manual-capture-evidence-selection.mjs';
import {buildManualCaptureEmbeddingDocumentViews} from '../scripts/lib/manual-capture-local-embedding-shadow.mjs';
const cardResolution={resolvedCards:[],unresolvedMentions:[],ambiguousMentions:[]};
const build=(referenceRecords)=>buildSafeCandidates({referenceRecords,officialQaRecords:[],cardResolution,dataRevision:'fixture'});
const official={id:'publisher:fixture-rules',recordType:'rule-doc',title:'Published rules',text:'First paragraph.\n\nSecond paragraph.',
  sourceAuthority:'official_reference',official:true,sourceUrl:'https://publisher.example/rules'};
test('official reference retains its original provenance and exact full body',()=>{
 const [row]=build([official]);assert.equal(row.body.sourceAuthority,'official_reference');
 assert.equal(row.body.sourceTier,'S0_OFFICIAL_REFERENCE');assert.equal(row.body.official,true);
 assert.equal(row.body.fullText,official.text);assert.equal(row.body.isDirect,false);assert.equal(row.bucket,'rawRelatedEvidence');
 assert.equal(row.binding,manualCaptureCandidateStableFingerprint(row,'fixture'));
 assert.equal(buildManualCaptureEmbeddingDocumentViews(row).views.find(v=>v.kind==='ruling_body_v1').text, '[source_record_body]\n'+official.text);
});
test('explicit official tier is retained without upgrading to database authority',()=>{
 const [row]=build([{...official,sourceTier:'S0_OFFICIAL_REFERENCE'}]);assert.equal(row.body.sourceAuthority,'official_reference');
 assert.notEqual(row.body.sourceAuthority,'official_database');
});
test('community reference defaults remain byte-identical to explicitly supplied defaults',()=>{
 const legacy={id:'fixture:community',recordType:'rule-doc',text:'Community body'};
 assert.deepEqual(build([legacy]),build([{...legacy,sourceAuthority:'community_reference',sourceTier:'S2_COMMUNITY_REFERENCE',official:false}]));
});
test('inconsistent authority flags continue to fail rather than silently discard or relabel',()=>{
 for(const bad of [{...official,official:false},{...official,sourceTier:'S2_COMMUNITY_REFERENCE'},
 {...official,sourceAuthority:'official_database'},{...official,sourceTier:'S0_OFFICIAL_DB_MIRROR'},
 {...official,sourceAuthority:'community_reference'},{id:'unknown',recordType:'rule-doc',text:'body',official:true}]){
   assert.throws(()=>build([bad]),/manual_capture_reference_record_authority_conflict/);
 }
});
test('all exact source chunks retain official provenance and concatenate losslessly',()=>{
 const pieces=buildManualCaptureReferenceParagraphRecords([official],{maxBodyBytes:18});
 assert.ok(pieces.length>1);assert.equal(pieces.map(p=>p.text).join(''),official.text);
 assert.ok(build(pieces).every(r=>r.body.sourceAuthority==='official_reference'&&r.body.official===true));
});
test('source preflight occurs before paid synchronization and failures retain a resumable snapshot',async()=>{
 const s=await readFile(new URL('../.github/workflows/sync-data.yml',import.meta.url),'utf8');
 assert.ok(s.indexOf('--validate-only')<s.indexOf('id: bounded_sync'));
 assert.ok(s.includes('sync-resume-snapshot-${{ github.run_id }}-${{ github.run_attempt }}'));
 assert.ok(s.includes('cron: "0 19 * * *"'));assert.ok(s.includes('--batch-budget-usd 1'));
});
