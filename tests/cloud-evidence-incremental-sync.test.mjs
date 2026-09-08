import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {loadEvidenceVectorIndex} from '../backend/evidenceVectorIndex.mjs';
import {writeIncrementalEvidenceVectorIndex} from '../scripts/sync-cloud-evidence-assets.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const contractHash='a'.repeat(64);
const model={id:'Qwen/Qwen3-Embedding-0.6B',revision:'fixed-revision'};
const inputContract={vectorDtype:'float32'};

async function writeOldIndex(directory,rows){
  await fs.mkdir(directory);
  const bytes=Buffer.from(new Float32Array(rows.flat()).buffer);
  const hashes=rows.map((_,index)=>hash(`text-${index}`));
  const shards=[{index:0,file:'evidence-vectors-000.f32',rowCount:rows.length,byteLength:bytes.length,sha256:hash(bytes)}];
  const manifest={schemaVersion:1,kind:'evidence-vector-index',encoding:'raw-little-endian-float32',model,
    inputContract,inputContractSha256:contractHash,dataRevision:'old',dimension:2,documentCount:rows.length,
    uniqueContentCount:rows.length,orderedContentHashes:hashes,orderedContentHashesSha256:hash(JSON.stringify(hashes)),
    entries:hashes.map((textSha256,rowIndex)=>({textSha256,shardIndex:0,rowIndex})),shards,
    vectorByteLength:bytes.length,shardSetSha256:hash(JSON.stringify(shards.map(({index,byteLength,sha256})=>({index,byteLength,sha256}))))};
  await fs.writeFile(path.join(directory,shards[0].file),bytes);
  await fs.writeFile(path.join(directory,'evidence-vector-index.json'),JSON.stringify(manifest));
  return hashes;
}

test('reuses matching hash rows and computes only new text hashes',async context=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-incremental-sync-'));
  context.after(()=>fs.rm(root,{recursive:true,force:true}));
  const oldDir=path.join(root,'old'); const output=path.join(root,'output');
  const [oldHash]=await writeOldIndex(oldDir,[[1,0]]);
  const newText='new text'; const newHash=hash(newText); let calls=0;
  const documents=[{views:[{text:'text-0',textSha256:oldHash},{text:newText,textSha256:newHash}]}];
  const result=await writeIncrementalEvidenceVectorIndex({documents,oldVectorDir:oldDir,outputDir:output,
    manifest:{model,inputContract,inputContractSha256:contractHash,dataRevision:'new'},
    embedMissing:async (rows,dimension)=>{calls++;assert.equal(dimension,2);assert.deepEqual(rows,[{textSha256:newHash,text:newText}]);
      return new Map([[newHash,Buffer.from(new Float32Array([0,1]).buffer)]]);},maxShardBytes:8});
  assert.equal(calls,1); assert.equal(result.reusedVectorCount,1); assert.equal(result.embeddingComputations,1);
  const loaded=await loadEvidenceVectorIndex({dataDir:output,dataRevision:'new'});
  assert.deepEqual(loaded.manifest.orderedContentHashes,[oldHash,newHash]);
  assert.deepEqual([...loaded.shards[0]],[1,0]); assert.deepEqual([...loaded.shards[1]],[0,1]);
});

test('does not invoke embedding when every current hash is reusable',async context=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-zero-delta-sync-'));
  context.after(()=>fs.rm(root,{recursive:true,force:true}));
  const oldDir=path.join(root,'old'); const output=path.join(root,'output');
  const [textSha256]=await writeOldIndex(oldDir,[[1,0]]); let calls=0;
  const result=await writeIncrementalEvidenceVectorIndex({
    documents:[{views:[{text:'text-0',textSha256},{text:'text-0',textSha256}]}],oldVectorDir:oldDir,outputDir:output,
    manifest:{model,inputContract,inputContractSha256:contractHash,dataRevision:'new'},
    embedMissing:async()=>{calls++;throw new Error('must_not_embed');}});
  assert.equal(calls,0); assert.equal(result.reusedVectorCount,1); assert.equal(result.embeddingComputations,0);
  await loadEvidenceVectorIndex({dataDir:output,dataRevision:'new'});
});
