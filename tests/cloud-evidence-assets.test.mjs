import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {writeCloudEvidenceCorpus} from '../scripts/build-cloud-evidence-assets.mjs';
import {buildSafeCandidates} from '../scripts/lib/manual-capture-evidence-selection.mjs';
import {buildManualCaptureEmbeddingDocumentViews} from '../scripts/lib/manual-capture-local-embedding-shadow.mjs';
import {createCloudEvidenceProvider} from '../backend/cloudEvidenceProvider.mjs';
import {buildRagRulingPromptBundle} from '../backend/ragRulingPrompt.mjs';

test('builder gzip preserves exact full views and the actual provider reads its artifact', async context => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-assets-test-'));
  context.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const cardResolution={resolvedCards:[],unresolvedMentions:[],ambiguousMentions:[]};
  const dataRevision='synthetic-gzip-revision';
  const candidates=buildSafeCandidates({
    officialQaRecords:[{id:'synthetic-asset',recordType:'qa',official:true,question:'synthetic question',text:'synthetic complete text'}],
    cardResolution,dataRevision,
  });
  const metadata=await writeCloudEvidenceCorpus({outputDir:directory,dataRevision,candidates});
  await fs.writeFile(path.join(directory,'corpus-manifest.json'),JSON.stringify({schemaVersion:1,dataRevision,...metadata}));
  const compressed=await fs.readFile(path.join(directory,'corpus.json.gz'));
  const bytes=gunzipSync(compressed);
  const corpus=JSON.parse(bytes);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),metadata.corpusSha256);
  assert.deepEqual(corpus.documents,candidates.map(buildManualCaptureEmbeddingDocumentViews));
  assert.ok(compressed.length<100_000_000);
  assert.deepEqual(corpus.candidates,candidates);
  assert.equal(metadata.lexicalIndex.file,'lexical-index.bin.gz');
  const compressedIndex=await fs.readFile(path.join(directory,metadata.lexicalIndex.file));
  const indexBytes=gunzipSync(compressedIndex);
  assert.equal(compressedIndex.length,metadata.lexicalIndex.compressedBytes);
  assert.equal(indexBytes.length,metadata.lexicalIndex.bytes);
  assert.equal(crypto.createHash('sha256').update(compressedIndex).digest('hex'),metadata.lexicalIndex.compressedSha256);
  assert.equal(crypto.createHash('sha256').update(indexBytes).digest('hex'),metadata.lexicalIndex.sha256);
  const retrievedEvidence={cardTexts:[],userProvidedCardTexts:[],officialQaDirectCandidates:[],officialQaRelated:[],faqRelated:[],rawRelatedEvidence:[],provisionalOfficialResponses:[]};
  const userQuery='synthetic question';
  const request={
    userQuery,cardResolution,retrievedEvidence,dataRevision,
    env:{CLOUD_EVIDENCE_ASSET_DIR:directory,CLOUD_EVIDENCE_DENSE:'false'},
    packEvidence:evidence=>buildRagRulingPromptBundle({userQuery,cardResolution,evidence}),
  };
  const options={generatePlan:async()=>({informationNeeds:[],queryTexts:[]}),fetchImpl:async()=>{throw new Error('network_forbidden');}};
  const first=await createCloudEvidenceProvider(options).retrieve(request);
  assert.equal(first.officialQaRelated[0].text,'synthetic complete text');
  // Old assets lacking the optional index still execute the original preprocessing.
  const oldDirectory=path.join(directory,'old-assets');
  await fs.mkdir(oldDirectory);
  await fs.writeFile(path.join(oldDirectory,'corpus.json.gz'),compressed);
  const {lexicalIndex,...oldMetadata}=metadata;
  await fs.writeFile(path.join(oldDirectory,'corpus-manifest.json'),JSON.stringify({schemaVersion:1,dataRevision,...oldMetadata}));
  const old=await createCloudEvidenceProvider(options).retrieve({...request,env:{...request.env,CLOUD_EVIDENCE_ASSET_DIR:oldDirectory}});
  assert.deepEqual(old.officialQaRelated,first.officialQaRelated);
  assert.equal(request.packEvidence(old).prompt,request.packEvidence(first).prompt);
  // A declared, corrupted index fails before any plan/model work.
  const brokenDirectory=path.join(directory,'broken-assets');
  await fs.mkdir(brokenDirectory);
  await fs.writeFile(path.join(brokenDirectory,'corpus.json.gz'),compressed);
  await fs.writeFile(path.join(brokenDirectory,'corpus-manifest.json'),JSON.stringify({schemaVersion:1,dataRevision,...metadata}));
  await fs.writeFile(path.join(brokenDirectory,lexicalIndex.file),Buffer.alloc(compressedIndex.length));
  let planCalls=0;
  await assert.rejects(createCloudEvidenceProvider({...options,generatePlan:async()=>{planCalls++;return {};}})
    .retrieve({...request,env:{...request.env,CLOUD_EVIDENCE_ASSET_DIR:brokenDirectory}}),/cloud_evidence_lexical_index_compressed_binding_invalid/u);
  assert.equal(planCalls,0);
  // Cached assets are an immutable revision snapshot, shared across factories.
  await fs.rename(path.join(directory,'corpus.json.gz'),path.join(directory,'corpus.saved.gz'));
  const second=await createCloudEvidenceProvider(options).retrieve(request);
  assert.deepEqual(second.officialQaRelated,first.officialQaRelated);
});
