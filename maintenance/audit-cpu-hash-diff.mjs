import fs from 'node:fs';
import z from 'node:zlib';
import assert from 'node:assert/strict';
import {stableJson} from '../scripts/lib/evidence-preprocess-cache.mjs';
const read=p=>JSON.parse(z.gunzipSync(fs.readFileSync(p)));
const previous=read('data/cloud-evidence-v1/corpus.json.gz');
const current=read(process.env.RUNNER_TEMP+'/cloud-source/corpus.json.gz');
const oldDocs=new Map(previous.documents.map(d=>[d.binding,d]));
const oldCandidates=new Map(previous.candidates.map(c=>[String(c.body?.recordType)+':'+String(c.body?.id),c]));
const allOldHashes=new Set(previous.documents.flatMap(d=>d.views.map(v=>v.textSha256)));
const newDoc=new Map(current.documents.map(d=>[d.binding,d]));
const counts={},changedFields={},examples=[];
for(const c of current.candidates){
 const id=String(c.body.recordType)+':'+String(c.body.id),o=oldCandidates.get(id),kind=c.body.recordType;
 const group=counts[kind]||={newSources:0,sharedSources:0,changedViews:0,missingViews:0,sameViews:0,sharedSourceMissingViews:0};
 if(o)group.sharedSources++;else group.newSources++;
 const n=newDoc.get(c.binding),od=o?oldDocs.get(o.binding):null;
 for(const v of n.views){
  const ov=od?.views.find(x=>x.kind===v.kind);
  if(ov?.textSha256===v.textSha256)group.sameViews++;else group.changedViews++;
  if(!allOldHashes.has(v.textSha256)){group.missingViews++;if(o)group.sharedSourceMissingViews++;}
 }
 if(o&&n.views.some(v=>!allOldHashes.has(v.textSha256))){
  const fields=Object.keys({...o.body,...c.body}).filter(k=>stableJson(o.body[k]??null)!==stableJson(c.body[k]??null));
  for(const k of fields)changedFields[k]=(changedFields[k]||0)+1;
  if(examples.length<30)examples.push({kind,changedFields:fields,viewChanges:n.views.map(v=>{const ov=od.views.find(x=>x.kind===v.kind);return {kind:v.kind,sameText:ov?.text===v.text,oldChars:ov?.text.length,newChars:v.text.length};})});
 }
}
const result={oldCandidates:previous.candidates.length,newCandidates:current.candidates.length,counts,changedFields,examples,providerCalls:0};
fs.writeFileSync(process.env.RUNNER_TEMP+'/cpu-hash-diff.json',JSON.stringify(result,null,2));
console.log('CPU_HASH_DIFF '+JSON.stringify({...result,examples:result.examples.slice(0,3)}));
