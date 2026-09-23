import assert from "node:assert/strict";
import test from "node:test";
import { sourceTranslationFields, translatePublicSource } from "../backend/publicSourceTranslation.mjs";

const sourceSnapshotId = "a".repeat(64);
const payload = { sourceSnapshotId, sourceId: "qa-1", targetLocale: "en" };
const source = { id: "qa-1", sourceHash: "b".repeat(64), text: JSON.stringify({
  recordType: "qa", question: "原文问题", rawDetailedQuestion: "详细场面", answer: "原文回答",
}) };

function fixture() {
  const cache = new Map();
  const locks = new Set();
  let snapshot = { system: "OCG", sources: [source] };
  let calls = 0;
  const store = {
    readSourceSnapshot: async () => snapshot,
    readSourceTranslation: async (identity) => cache.get(JSON.stringify(identity)) || null,
    saveSourceTranslation: async (identity, value) => { cache.set(JSON.stringify(identity), value); },
    claimSourceTranslation: async (identity) => {
      const key = JSON.stringify(identity);
      if (locks.has(key)) return false;
      locks.add(key);
      return true;
    },
  };
  const createBudget = ({ env }) => {
    assert.equal(env.CLOUD_BUDGET_RUN_ID, "source_translation");
    assert.equal(env.CLOUD_BUDGET_THEORETICAL_LIMIT_USD, "1");
    return { sourceTranslation: async ({ body, invoke }) => {
      assert.equal(body.model, "gpt-6-luna");
      assert.equal(body.reasoning.effort, "low");
      calls += 1;
      return invoke();
    } };
  };
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const fields = JSON.parse(body.input);
    return { ok: true, json: async () => ({ model: "gpt-6-luna", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(
        Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, `EN: ${value}`])),
      ) }] }], usage: { input_tokens: 100, output_tokens: 50 } }) };
  };
  return { store, createBudget, fetchImpl, get calls() { return calls; },
    setSnapshot(value) { snapshot = value; }, cache };
}

test("source display fields preserve QA strings without exposing the record wrapper", () => {
  assert.deepEqual(sourceTranslationFields(source), {
    question: "原文问题", rawDetailedQuestion: "详细场面", answer: "原文回答",
  });
});

test("translation is cached by source hash, language and config and never accepts caller text", async () => {
  const f = fixture();
  const env = { SOURCE_TRANSLATION_DAILY_BUDGET_USD: "1", BAI_API_KEY: "fixture-secret" };
  const args = { payload, store: f.store, createBudget: f.createBudget, fetchImpl: f.fetchImpl, env };
  const first = await translatePublicSource(args);
  assert.equal(first.status, "translated");
  assert.equal(first.fields.answer, "EN: 原文回答");
  assert.equal(first.cached, false);
  const second = await translatePublicSource(args);
  assert.equal(second.cached, true);
  assert.equal(f.calls, 1);
  const changed = { ...source, sourceHash: "c".repeat(64), answer: "新版本" };
  f.setSnapshot({ system: "OCG", sources: [changed] });
  const third = await translatePublicSource(args);
  assert.equal(third.cached, false);
  assert.equal(f.calls, 2);
  const fourth = await translatePublicSource({ ...args, payload: { ...payload, targetLocale: "ja" } });
  assert.equal(fourth.targetLocale, "ja");
  assert.equal(f.calls, 3);
});

test("without an explicit translation allowance no provider request is sent", async () => {
  const f = fixture();
  await assert.rejects(translatePublicSource({ payload, store: f.store,
    env: { BAI_API_KEY: "fixture-secret" }, createBudget: f.createBudget, fetchImpl: f.fetchImpl }),
  { code: "source_translation_disabled" });
  assert.equal(f.calls, 0);
});

test("a paid translation remains readable when its cache write fails", async () => {
  const f = fixture();
  f.store.saveSourceTranslation = async () => { throw new Error("storage_down"); };
  const result = await translatePublicSource({ payload, store: f.store,
    env: { SOURCE_TRANSLATION_DAILY_BUDGET_USD: "1", BAI_API_KEY: "fixture-secret" },
    createBudget: f.createBudget, fetchImpl: f.fetchImpl });
  assert.equal(result.status, "translated");
  assert.equal(result.fields.answer, "EN: 原文回答");
  assert.equal(result.cachePersisted, false);
  assert.equal(f.calls, 1);
});
