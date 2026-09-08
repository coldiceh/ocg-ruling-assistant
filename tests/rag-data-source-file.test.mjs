import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

import { createRagDataSourceDescriptor } from "../backend/ragDataRevisionManifest.mjs";
import { loadRawRagData } from "../backend/ragEvidenceRetriever.mjs";
import { readRagRuntimeSources } from "../backend/ragRuntimeBundleCompiler.mjs";
import {
  COMPRESSED_EVIDENCE_INDEX_FILE,
  readRagDataSourceBytes,
  readRagDataSourceJson,
  writeEvidenceIndexJson,
} from "../backend/ragDataSourceFile.mjs";
import { isPreviewSourcePath } from "../scripts/stage-cloud-preview.mjs";

const unzip = promisify(gunzip);

test("evidence index gzip preserves exact canonical source bytes and migrates legacy JSON", async context => {
  const directory = await mkdtemp(join(tmpdir(), "rag-source-gzip-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const value = { schemaVersion: 1, generatedAt: "fixture", records: [{ stableId: "one", text: "正文" }] };
  const legacyBytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  await writeFile(join(directory, "evidence-index.json"), legacyBytes);
  assert.deepEqual(await readRagDataSourceBytes(directory, "evidence-index.json"), legacyBytes);
  const legacyDescriptor = createRagDataSourceDescriptor("evidence-index.json", legacyBytes);

  const result = await writeEvidenceIndexJson(directory, value);
  assert.equal(result.physicalName, COMPRESSED_EVIDENCE_INDEX_FILE);
  await assert.rejects(readFile(join(directory, "evidence-index.json")), error => error?.code === "ENOENT");
  const compressed = await readFile(join(directory, COMPRESSED_EVIDENCE_INDEX_FILE));
  assert.deepEqual(await unzip(compressed), legacyBytes);
  assert.deepEqual(await readRagDataSourceJson(directory, "evidence-index.json"), value);
  assert.deepEqual(
    createRagDataSourceDescriptor("evidence-index.json", await readRagDataSourceBytes(directory, "evidence-index.json")),
    legacyDescriptor,
  );

  const next = { ...value, records: [...value.records, { stableId: "two", text: "more" }] };
  await writeEvidenceIndexJson(directory, next);
  assert.deepEqual(await readRagDataSourceJson(directory, "evidence-index.json"), next);
  assert.equal(isPreviewSourcePath("data/evidence-index.json.gz"), true);
  assert.equal(isPreviewSourcePath("data/evidence-index.json"), false);
});

test("a corrupt gzip never falls back to a legacy evidence index", async context => {
  const directory = await mkdtemp(join(tmpdir(), "rag-source-corrupt-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "evidence-index.json"), '{"records":[]}\n');
  await writeFile(join(directory, COMPRESSED_EVIDENCE_INDEX_FILE), Buffer.from("not-gzip"));
  await assert.rejects(
    readRagDataSourceBytes(directory, "evidence-index.json"),
    error => error?.code === "RAG_DATA_SOURCE_GZIP_INVALID",
  );
});

test("a failed install preserves the legacy source and verified temporary gzip", async context => {
  const directory = await mkdtemp(join(tmpdir(), "rag-source-install-failure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = '{"schemaVersion":1,"records":[]}\n';
  await writeFile(join(directory, "evidence-index.json"), legacy);
  await mkdir(join(directory, COMPRESSED_EVIDENCE_INDEX_FILE));
  await assert.rejects(writeEvidenceIndexJson(directory, { schemaVersion: 1, records: [] }));
  assert.equal(await readFile(join(directory, "evidence-index.json"), "utf8"), legacy);
  const temporary = (await readdir(directory)).filter(name => (
    name.startsWith(`.${COMPRESSED_EVIDENCE_INDEX_FILE}.`) && name.endsWith(".tmp")
  ));
  assert.equal(temporary.length, 1);
  assert.deepEqual(await unzip(await readFile(join(directory, temporary[0]))), Buffer.from(legacy));
});

test("raw and runtime compiler readers consume the same decompressed evidence source", async context => {
  const directory = await mkdtemp(join(tmpdir(), "rag-source-integration-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sources = {
    "cards.json": { records: [{ id: "1", name: "fixture card" }] },
    "rulings.json": { records: [{ id: "rule-1", title: "fixture", text: "rule text" }] },
    "qa-index.json": { records: [] },
    "ocg-rule-corpus.json": { records: [] },
    "official-responses.json": { records: [] },
  };
  await Promise.all(Object.entries(sources).map(([name, value]) => (
    writeFile(join(directory, name), `${JSON.stringify(value)}\n`, "utf8")
  )));
  const evidence = { records: [{ id: "evidence-1", stableId: "evidence-1", text: "evidence text" }] };
  await writeEvidenceIndexJson(directory, evidence);

  const raw = await loadRawRagData(directory);
  assert.equal(raw.records.some(record => record.stableId === "evidence-1"), true);
  const runtimeSources = await readRagRuntimeSources(directory);
  const descriptor = runtimeSources.find(source => source.path === "evidence-index.json");
  assert.equal(descriptor.count, 1);
  assert.deepEqual(descriptor.descriptor, createRagDataSourceDescriptor(
    "evidence-index.json",
    Buffer.from(`${JSON.stringify(evidence)}\n`, "utf8"),
  ));
});
