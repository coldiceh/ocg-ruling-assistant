import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { loadRagData } from '../backend/ragEvidenceRetriever.mjs';
import { getTrustedRagDataRevision } from '../backend/ragDataRevisionManifest.mjs';
import {
  buildSafeCandidates,
  buildManualCaptureReferenceParagraphRecords,
  serializeManualCaptureLexicalIndex,
} from './lib/manual-capture-evidence-selection.mjs';
import {
  buildManualCaptureEmbeddingDocumentViews,
  MANUAL_CAPTURE_EMBEDDING_MODEL,
  MANUAL_CAPTURE_EMBEDDING_INPUT_CONTRACT,
  MANUAL_CAPTURE_EMBEDDING_INPUT_CONTRACT_SHA256,
} from './lib/manual-capture-local-embedding-shadow.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const zip = promisify(gzip);
const MAX_ASSET_FILE_BYTES = 100_000_000;

export async function writeCloudEvidenceLexicalIndex({outputDir, dataRevision, candidates}) {
  const bytes = serializeManualCaptureLexicalIndex({candidates, dataRevision});
  const compressed = await zip(bytes);
  if (compressed.length >= MAX_ASSET_FILE_BYTES) throw new Error('cloud_lexical_index_compressed_file_too_large');
  await fs.writeFile(path.join(outputDir, 'lexical-index.bin.gz'), compressed, {flag:'wx'});
  return {file:'lexical-index.bin.gz', encoding:'gzip', bytes:bytes.length, sha256:hash(bytes),
    compressedBytes:compressed.length, compressedSha256:hash(compressed)};
}

export async function writeCloudEvidenceCorpus({outputDir, dataRevision, candidates}) {
  const documents = candidates.map(buildManualCaptureEmbeddingDocumentViews);
  // corpus.json.gz is the runtime body contract. vector-documents.json is only
  // the explicitly hash-only input to the existing vector export tool.
  const corpus = {schemaVersion:1, dataRevision, candidates, documents};
  const corpusBytes = Buffer.from(JSON.stringify(corpus));
  const compressed = await zip(corpusBytes);
  if (compressed.length >= MAX_ASSET_FILE_BYTES) throw new Error('cloud_corpus_compressed_file_too_large');
  const vectorDocuments = documents.map(d => ({...d, views:d.views.map(v => ({kind:v.kind,textSha256:v.textSha256}))}));
  const vectorDocumentBytes = Buffer.from(JSON.stringify({documents:vectorDocuments}));
  if (vectorDocumentBytes.length >= MAX_ASSET_FILE_BYTES) throw new Error('cloud_vector_document_file_too_large');
  await fs.writeFile(path.join(outputDir, 'corpus.json.gz'), compressed, {flag:'wx'});
  await fs.writeFile(path.join(outputDir, 'vector-documents.json'), vectorDocumentBytes, {flag:'wx'});
  const lexicalIndex = candidates.length ? await writeCloudEvidenceLexicalIndex({outputDir, dataRevision, candidates}) : null;
  return {
    corpusFile:'corpus.json.gz', corpusEncoding:'gzip',
    corpusSha256:hash(corpusBytes), corpusBytes:corpusBytes.length,
    corpusCompressedSha256:hash(compressed), corpusCompressedBytes:compressed.length,
    candidateCount:candidates.length,
    uniqueDocumentViews:new Set(documents.flatMap(d=>d.views.map(v=>v.textSha256))).size,
    ...(lexicalIndex ? {lexicalIndex} : {}),
  };
}

async function reuseVectorAssets({vectorDir, outputDir, dataRevision, documentFile}) {
  const indexBytes = await fs.readFile(path.join(vectorDir, 'evidence-vector-index.json'));
  const index = JSON.parse(indexBytes);
  const {documents} = JSON.parse(await fs.readFile(documentFile, 'utf8'));
  const orderedHashes = [...new Set(documents.flatMap(document=>document.views.map(view=>view.textSha256)))];
  if (index.dataRevision !== dataRevision
      || JSON.stringify(orderedHashes) !== JSON.stringify(index.orderedContentHashes)) {
    throw new Error('cloud_reused_vector_corpus_binding_invalid');
  }
  if (indexBytes.length >= MAX_ASSET_FILE_BYTES) throw new Error('cloud_vector_index_file_too_large');
  for (const shard of index.shards) {
    if (typeof shard.file !== 'string' || path.basename(shard.file) !== shard.file) throw new Error('cloud_vector_shard_path_invalid');
    const bytes = await fs.readFile(path.join(vectorDir, shard.file));
    if (bytes.length !== shard.byteLength || hash(bytes) !== shard.sha256) throw new Error('cloud_reused_vector_shard_binding_invalid');
    if (bytes.length >= MAX_ASSET_FILE_BYTES) throw new Error('cloud_vector_shard_file_too_large');
    await fs.writeFile(path.join(outputDir, shard.file), bytes, {flag:'wx'});
  }
  await fs.writeFile(path.join(outputDir, 'evidence-vector-index.json'), indexBytes, {flag:'wx'});
  return {vectorIndexSha256:hash(indexBytes), reusedVectorShards:index.shards.length};
}

// Build only from the complete public source snapshot. Evaluation questions,
// reference answers, frozen identities and previously selected evidence are
// deliberately not inputs to this builder.
export async function buildCloudEvidenceAssets({dataDir, outputDir, vectorDir} = {}) {
  if (!dataDir || !outputDir) throw new Error('dataDir and new outputDir are required');
  await fs.mkdir(outputDir, {recursive: false});
  const data = await loadRagData(dataDir);
  const dataRevision = getTrustedRagDataRevision(data);
  const ruleBytes = await fs.readFile(path.join(dataDir, 'ocg-rule-corpus.json'));
  const ruleSource = JSON.parse(ruleBytes);
  const referenceRecords = buildManualCaptureReferenceParagraphRecords(ruleSource.records, {
    maxBodyBytes: MANUAL_CAPTURE_EMBEDDING_INPUT_CONTRACT.tokenizerMaxLength
      - Buffer.byteLength('[source_record_body]\n') - 32,
  });
  const candidates = buildSafeCandidates({
    officialQaRecords: data.qaRecords,
    referenceRecords,
    cardResolution: {resolvedCards: [], unresolvedMentions: [], ambiguousMentions: []},
    cards: data.cards,
    dataRevision,
  }).sort((a, b) => a.binding.localeCompare(b.binding, 'en'));
  const corpusMetadata = await writeCloudEvidenceCorpus({outputDir, dataRevision, candidates});
  const vectorMetadata = vectorDir ? await reuseVectorAssets({
    vectorDir, outputDir, dataRevision, documentFile:path.join(outputDir, 'vector-documents.json'),
  }) : {};
  const metadata = {
    schemaVersion:1, builtAtUtc:new Date().toISOString(), dataRevision,
    model:MANUAL_CAPTURE_EMBEDDING_MODEL,
    inputContract:MANUAL_CAPTURE_EMBEDDING_INPUT_CONTRACT,
    inputContractSha256:MANUAL_CAPTURE_EMBEDDING_INPUT_CONTRACT_SHA256,
    ...corpusMetadata, ...vectorMetadata,
    sourceRuleSha256:hash(ruleBytes),
    privateEvaluationInputs:false, externalCalls:0, embeddingComputations:0,
  };
  await fs.writeFile(path.join(outputDir, 'corpus-manifest.json'), JSON.stringify(metadata,null,2), {flag:'wx'});
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2), option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
  console.log(JSON.stringify(await buildCloudEvidenceAssets({
    dataDir:option('--data-dir'), outputDir:option('--output-dir'), vectorDir:option('--vector-dir'),
  })));
}
