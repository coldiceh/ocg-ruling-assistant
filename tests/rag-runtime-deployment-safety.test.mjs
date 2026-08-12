import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRagData, loadRawRagData } from "../backend/ragEvidenceRetriever.mjs";
import { publicAnswerHttpError } from "../backend/publicAnswerService.mjs";

test("a deployment that requires the runtime bundle fails closed without consulting raw files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-deployment-bundle-required-"));
  try {
    await assert.rejects(
      loadRagData(dataDir, { requireRuntimeBundle: true }),
      (error) => {
        assert.equal(error.code, "rag_data_unavailable");
        assert.equal(error.statusCode, 503);
        assert.equal(error.details.phase, "runtime_bundle");
        assert.equal(error.details.reason, "runtime_bundle_required");
        assert.equal(error.details.bundleReason, "bundle_manifest_missing");
        return true;
      },
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("raw fallback rejects a missing required source instead of synthesizing empty corpora", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-deployment-raw-missing-"));
  try {
    await writeRawSources(dataDir, { omit: "qa-index.json" });
    await assert.rejects(
      loadRawRagData(dataDir),
      (error) => {
        assert.equal(error.code, "rag_data_unavailable");
        assert.equal(error.details.phase, "raw_fallback");
        assert.equal(error.details.reason, "raw_source_missing");
        assert.equal(error.details.source, "qa-index.json");
        return true;
      },
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("raw fallback rejects corrupt JSON and invalid top-level corpus shape", async () => {
  const corruptDir = await mkdtemp(join(tmpdir(), "rag-deployment-raw-corrupt-"));
  const shapeDir = await mkdtemp(join(tmpdir(), "rag-deployment-raw-shape-"));
  try {
    await writeRawSources(corruptDir);
    await writeFile(join(corruptDir, "rulings.json"), "{not-json", "utf8");
    await assert.rejects(
      loadRawRagData(corruptDir),
      (error) => error?.details?.reason === "raw_source_json_invalid"
        && error?.details?.source === "rulings.json",
    );

    await writeRawSources(shapeDir);
    await writeFile(join(shapeDir, "evidence-index.json"), '{"records":{}}\n', "utf8");
    await assert.rejects(
      loadRawRagData(shapeDir),
      (error) => error?.details?.reason === "raw_source_shape_invalid"
        && error?.details?.source === "evidence-index.json",
    );
  } finally {
    await rm(corruptDir, { recursive: true, force: true });
    await rm(shapeDir, { recursive: true, force: true });
  }
});

test("raw fallback rejects structurally valid but empty normalized corpora", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-deployment-raw-empty-"));
  try {
    await writeRawSources(dataDir, { empty: true });
    await assert.rejects(
      loadRawRagData(dataDir),
      (error) => {
        assert.equal(error.code, "rag_data_unavailable");
        assert.equal(error.details.reason, "raw_corpus_empty");
        assert.equal(error.details.cards, 0);
        assert.equal(error.details.evidenceRecords, 0);
        return true;
      },
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("public answer error mapping exposes only the stable 503 data-unavailable message", () => {
  const error = new Error("private path: D:/deployment/data/cards.json");
  error.code = "rag_data_unavailable";
  error.statusCode = 503;
  error.expose = true;
  error.publicMessage = "裁定资料暂时不可用，请稍后再试。";
  assert.deepEqual(publicAnswerHttpError(error), {
    statusCode: 503,
    payload: {
      error: "裁定资料暂时不可用，请稍后再试。",
      code: "rag_data_unavailable",
    },
  });
});

async function writeRawSources(dataDir, { omit = "", empty = false } = {}) {
  await mkdir(dataDir, { recursive: true });
  const sources = {
    "cards.json": { records: empty ? [] : [{ id: "1", name: "部署安全测试卡" }] },
    "rulings.json": {
      records: empty ? [] : [{ id: "rule-1", title: "部署规则", text: "部署安全证据。" }],
    },
    "qa-index.json": { records: [] },
    "evidence-index.json": { records: [] },
    "ocg-rule-corpus.json": { records: [] },
    "official-responses.json": { records: [] },
  };
  await Promise.all(Object.entries(sources)
    .filter(([name]) => name !== omit)
    .map(([name, value]) => writeFile(
      join(dataDir, name),
      `${JSON.stringify(value)}\n`,
      "utf8",
    )));
}
