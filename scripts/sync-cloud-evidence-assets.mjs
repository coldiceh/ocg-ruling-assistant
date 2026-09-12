import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {buildCloudEvidenceAssets} from './build-cloud-evidence-assets.mjs';
import {loadEvidenceVectorIndex} from '../backend/evidenceVectorIndex.mjs';
import {loadCloudEvidenceAssetSnapshot} from '../backend/cloudEvidenceProvider.mjs';

const MAX_SHARD_BYTES=48_000_000;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const check=(condition,code)=>{if(!condition)throw new Error(code);};

function orderedViews(documents){
  const byHash=new Map();
  for(const document of documents){
    check(Array.isArray(document?.views)&&document.views.length===2,'cloud_sync_document_views_invalid');
    for(const view of document.views){
      check(typeof view.text==='string'&&hash(view.text)===view.textSha256,'cloud_sync_document_hash_invalid');
      const previous=byHash.get(view.textSha256);
      check(previous===undefined||previous===view.text,'cloud_sync_document_hash_conflict');
      byHash.set(view.textSha256,view.text);
    }
  }
  return byHash;
}

export async function writeIncrementalEvidenceVectorIndex({documents,oldVectorDir,outputDir,manifest,embedMissing,maxShardBytes=MAX_SHARD_BYTES}){
  const old=await loadEvidenceVectorIndex({dataDir:oldVectorDir});
  check(old.manifest.model?.id===manifest.model?.id&&old.manifest.model?.revision===manifest.model?.revision
    &&old.manifest.inputContractSha256===manifest.inputContractSha256,'cloud_sync_embedding_scope_changed');
  const views=orderedViews(documents);
  const missing=[...views].filter(([textSha256])=>!old.entries.has(textSha256));
  let computed=new Map();
  if(missing.length){
    const result=await embedMissing(missing.map(([textSha256,text])=>({textSha256,text})),old.manifest.dimension);
    check(result instanceof Map&&result.size===missing.length,'cloud_sync_embedding_result_count_invalid');
    computed=result;
  }
  await fs.mkdir(outputDir,{recursive:false});
  const rowBytes=old.manifest.dimension*4;
  const rowsPerShard=Math.floor(maxShardBytes/rowBytes);
  check(rowsPerShard>0,'cloud_sync_vector_shard_too_small');
  const orderedContentHashes=[...views.keys()];
  const entries=[]; const shards=[];
  for(let start=0,shardIndex=0;start<orderedContentHashes.length;start+=rowsPerShard,shardIndex++){
    const hashes=orderedContentHashes.slice(start,start+rowsPerShard);
    const bytes=Buffer.allocUnsafe(hashes.length*rowBytes);
    for(let rowIndex=0;rowIndex<hashes.length;rowIndex++){
      const textSha256=hashes[rowIndex];
      const oldEntry=old.entries.get(textSha256);
      let row;
      if(oldEntry){
        const offset=oldEntry.rowIndex*rowBytes;
        row=Buffer.from(old.shards[oldEntry.shardIndex].buffer,
          old.shards[oldEntry.shardIndex].byteOffset+offset,rowBytes);
      }else row=computed.get(textSha256);
      check(Buffer.isBuffer(row)&&row.length===rowBytes,'cloud_sync_vector_row_invalid');
      row.copy(bytes,rowIndex*rowBytes);
      entries.push({textSha256,shardIndex,rowIndex});
    }
    const file=`evidence-vectors-${String(shardIndex).padStart(3,'0')}.f32`;
    await fs.writeFile(path.join(outputDir,file),bytes,{flag:'wx'});
    shards.push({index:shardIndex,file,rowCount:hashes.length,byteLength:bytes.length,sha256:hash(bytes)});
  }
  const index={schemaVersion:1,kind:'evidence-vector-index',encoding:'raw-little-endian-float32',
    model:manifest.model,...(old.manifest.modelSnapshotSha256?{modelSnapshotSha256:old.manifest.modelSnapshotSha256}:{}),
    inputContract:manifest.inputContract,inputContractSha256:manifest.inputContractSha256,
    dataRevision:manifest.dataRevision,dimension:old.manifest.dimension,documentCount:documents.length,
    uniqueContentCount:orderedContentHashes.length,orderedContentHashes,
    orderedContentHashesSha256:hash(JSON.stringify(orderedContentHashes)),entries,shards,
    vectorByteLength:shards.reduce((sum,item)=>sum+item.byteLength,0),
    shardSetSha256:hash(JSON.stringify(shards.map(({index,byteLength,sha256})=>({index,byteLength,sha256}))))};
  await fs.writeFile(path.join(outputDir,'evidence-vector-index.json'),`${JSON.stringify(index,null,2)}\n`,{flag:'wx'});
  return {index,reusedVectorCount:orderedContentHashes.length-missing.length,embeddingComputations:missing.length};
}

async function runPythonEmbedder({python,requestFile,outputFile}){
  await new Promise((resolve,reject)=>{
    const child=spawn(python,[path.join(path.dirname(fileURLToPath(import.meta.url)),'embed-missing-cloud-evidence.py'),
      '--request',requestFile,'--output',outputFile],{stdio:'inherit'});
    child.once('error',reject); child.once('exit',code=>code===0?resolve():reject(new Error(`cloud_sync_embedder_exit_${code}`)));
  });
}

export async function checkCloudEvidenceAssets({dataDir,cloudDir}={}){
  check(dataDir&&cloudDir,'cloud_sync_paths_required');
  const resolvedDataDir=path.resolve(dataDir),resolvedCloudDir=path.resolve(cloudDir);
  check(resolvedCloudDir===path.join(resolvedDataDir,'cloud-evidence-v1'),'cloud_sync_directory_scope_invalid');
  const [revisionManifest,runtimeManifest,cloudManifest]=await Promise.all([
    fs.readFile(path.join(resolvedDataDir,'rag-data-revision-manifest.json'),'utf8').then(JSON.parse),
    fs.readFile(path.join(resolvedDataDir,'rag-runtime-v1','manifest.json'),'utf8').then(JSON.parse),
    fs.readFile(path.join(resolvedCloudDir,'corpus-manifest.json'),'utf8').then(JSON.parse),
  ]);
  const dataRevision=revisionManifest.revision;
  check(typeof dataRevision==='string'&&dataRevision.length===64
    &&runtimeManifest.dataRevision===dataRevision&&cloudManifest.dataRevision===dataRevision,
  'cloud_sync_data_revision_mismatch');
  const loaded=await loadCloudEvidenceAssetSnapshot({dataDir:resolvedCloudDir,dataRevision});
  check(loaded.corpus.candidates.length===cloudManifest.candidateCount
    &&loaded.vectorIndex.manifest.uniqueContentCount===cloudManifest.uniqueDocumentViews,
  'cloud_sync_asset_count_mismatch');
  return {dataRevision,candidateCount:loaded.corpus.candidates.length,
    uniqueDocumentViews:loaded.vectorIndex.manifest.uniqueContentCount,
    shardCount:loaded.vectorIndex.manifest.shards.length};
}

export async function syncCloudEvidenceAssets({dataDir,cloudDir,python='python3'}={}){
  check(dataDir&&cloudDir,'cloud_sync_paths_required');
  const resolvedDataDir=path.resolve(dataDir);
  const resolvedCloudDir=path.resolve(cloudDir);
  check(resolvedCloudDir===path.join(resolvedDataDir,'cloud-evidence-v1'),'cloud_sync_directory_scope_invalid');
  const workDir=await fs.mkdtemp(path.join(path.dirname(resolvedDataDir),'.cloud-evidence-sync-'));
  const staging=path.join(workDir,'cloud-evidence-v1');
  const backup=path.join(workDir,'previous-cloud-evidence-v1');
  let oldMoved=false;
  try{
    const manifest=await buildCloudEvidenceAssets({dataDir:resolvedDataDir,outputDir:staging});
    const corpus=JSON.parse(gunzipSync(await fs.readFile(path.join(staging,'corpus.json.gz'))));
    const embeddingRequest=path.join(staging,'missing-embedding-request.json');
    const embeddingOutput=path.join(staging,'missing-embedding-output.f32');
    const vectorOutput=path.join(staging,'vectors');
    const vectorResult=await writeIncrementalEvidenceVectorIndex({documents:corpus.documents,oldVectorDir:resolvedCloudDir,
      outputDir:vectorOutput,manifest,embedMissing:async (rows,dimension)=>{
        await fs.writeFile(embeddingRequest,JSON.stringify({schemaVersion:1,model:manifest.model,
          inputContract:manifest.inputContract,inputContractSha256:manifest.inputContractSha256,dimension,rows}));
        await runPythonEmbedder({python,requestFile:embeddingRequest,outputFile:embeddingOutput});
        const bytes=await fs.readFile(embeddingOutput); const rowBytes=dimension*4;
        check(bytes.length===rows.length*rowBytes,'cloud_sync_embedding_output_size_invalid');
        return new Map(rows.map((row,index)=>[row.textSha256,bytes.subarray(index*rowBytes,(index+1)*rowBytes)]));
      }});
    for(const shard of vectorResult.index.shards) await fs.rename(path.join(vectorOutput,shard.file),path.join(staging,shard.file));
    await fs.rename(path.join(vectorOutput,'evidence-vector-index.json'),path.join(staging,'evidence-vector-index.json'));
    await fs.rm(vectorOutput,{recursive:true,force:true});
    await fs.rm(embeddingRequest,{force:true}); await fs.rm(embeddingOutput,{force:true});
    await fs.rm(path.join(staging,'vector-documents.json'),{force:true});
    const finalManifest={...manifest,vectorIndexSha256:hash(await fs.readFile(path.join(staging,'evidence-vector-index.json'))),
      reusedVectorCount:vectorResult.reusedVectorCount,embeddingComputations:vectorResult.embeddingComputations};
    await fs.writeFile(path.join(staging,'corpus-manifest.json'),JSON.stringify(finalManifest,null,2));
    await loadCloudEvidenceAssetSnapshot({dataDir:staging,dataRevision:manifest.dataRevision});
    await fs.rename(resolvedCloudDir,backup); oldMoved=true;
    try{await fs.rename(staging,resolvedCloudDir);}catch(error){
      await fs.rename(backup,resolvedCloudDir); oldMoved=false; throw error;
    }
    return {...finalManifest,previousAssetsPreservedAt:backup};
  }catch(error){
    if(oldMoved){
      try{await fs.rename(backup,resolvedCloudDir);}catch{}
    }
    console.error(`cloud evidence synchronization work preserved at ${workDir}`);
    throw error;
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
  const options={dataDir:option('--data-dir'),cloudDir:option('--cloud-dir')};
  console.log(JSON.stringify(args.includes('--check-only')
    ?await checkCloudEvidenceAssets(options)
    :await syncCloudEvidenceAssets({...options,python:option('--python')||'python3'})));
}
