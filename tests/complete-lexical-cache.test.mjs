import assert from "node:assert/strict";
import test from "node:test";
import {
  buildManualCaptureCompleteLexicalQueryQueue,
  serializeManualCaptureLexicalIndex,
  installManualCaptureLexicalIndex,
} from "../scripts/lib/manual-capture-evidence-selection.mjs";

const candidate = (digit, text) => ({binding:digit.repeat(64),text});

test("an immutable canonical pool normalizes each body once across query surfaces", () => {
  const candidates=Object.freeze([
    Object.freeze(candidate("a","unique synthetic body alpha")),
    Object.freeze(candidate("b","unique synthetic body beta")),
  ]);
  const bodies=new Set(candidates.map(item=>item.text));
  const original=String.prototype.normalize;
  let bodyNormalizations=0;
  String.prototype.normalize=function(...args){
    if(bodies.has(String(this)))bodyNormalizations+=1;
    return original.apply(this,args);
  };
  try {
    assert.equal(buildManualCaptureCompleteLexicalQueryQueue({query:"alpha",candidates})[0].binding,"a".repeat(64));
    assert.equal(buildManualCaptureCompleteLexicalQueryQueue({query:"beta",candidates})[0].binding,"b".repeat(64));
    assert.equal(bodyNormalizations,2);
  } finally {String.prototype.normalize=original;}
});

test("a frozen array with mutable candidate text is recomputed without changing its binding", () => {
  const candidates=Object.freeze([candidate("a","alpha alpha"),candidate("b","beta beta")]);
  const first=buildManualCaptureCompleteLexicalQueryQueue({query:"alpha",candidates});
  assert.equal(first[0].binding,"a".repeat(64));
  candidates[0].text="gamma gamma";
  candidates[1].text="alpha alpha";
  const second=buildManualCaptureCompleteLexicalQueryQueue({query:"alpha",candidates});
  assert.equal(second[0].binding,"b".repeat(64));
});

test("complete scores and zero-score rows stay observable without exposing mutable cache state", () => {
  const candidates=Object.freeze([
    Object.freeze(candidate("c","gamma")),
    Object.freeze(candidate("b","alpha")),
    Object.freeze(candidate("a","alpha")),
  ]);
  let observed;
  const queue=buildManualCaptureCompleteLexicalQueryQueue({query:"alpha",candidates,onScores:value=>{observed=value;}});
  assert.deepEqual(queue.map(item=>item.binding),["a","b","c"].map(digit=>digit.repeat(64)));
  assert.equal(observed.scores.length,3);
  assert.equal(observed.scores[0],observed.scores[1]);
  assert.equal(observed.scores[2],0);
  assert.throws(()=>{observed.scores[0]=0;},TypeError);
  assert.throws(()=>{observed.candidates.reverse();},TypeError);
  assert.deepEqual(buildManualCaptureCompleteLexicalQueryQueue({query:"alpha",candidates}).map(item=>item.binding),queue.map(item=>item.binding));
});

const immutablePool = () => Object.freeze([
  candidate("d", ""), candidate("b", "alpha alpha 日本語 ＡＢＣ"),
  candidate("c", "beta 日本語"), candidate("a", "alpha alpha 日本語 ＡＢＣ"),
].map(Object.freeze));
const scoreAndQueue = (candidates, query) => {
  let scores;
  const queue = buildManualCaptureCompleteLexicalQueryQueue({candidates, query, onScores: value => {scores = value;}});
  return {scores: scores.scores, bindings: scores.candidates.map(row => row.binding), queue: queue.map(row => row.binding)};
};

test("prebuilt postings preserve every exact score, tie and zero row without tokenizing bodies", () => {
  const originalPool = immutablePool(), installedPool = immutablePool();
  const bytes = serializeManualCaptureLexicalIndex({candidates: originalPool, dataRevision: "synthetic-index"});
  const queries = ["alpha alpha", "ＡＢＣ", "日本語", "zzqxx", "beta alpha"];
  const expected = queries.map(query => scoreAndQueue(originalPool, query));
  const bodies = new Set(installedPool.map(row => row.text));
  const normalize = String.prototype.normalize;
  let bodyNormalizations = 0;
  String.prototype.normalize = function(...args) {
    if (bodies.has(String(this))) bodyNormalizations++;
    return normalize.apply(this, args);
  };
  try {
    const installed = installManualCaptureLexicalIndex({candidates: installedPool, dataRevision: "synthetic-index", bytes});
    assert.equal(installed.documentCount, originalPool.length);
    assert.equal(installed.byteLength, bytes.length);
    bytes.fill(0); // The live cache owns its bytes independently of the caller.
    assert.deepEqual(queries.map(query => scoreAndQueue(installedPool, query)), expected);
    assert.equal(bodyNormalizations, 0);
  } finally {String.prototype.normalize = normalize;}
});

test("prebuilt index binds actual lexical text as well as identity and revision", () => {
  const candidates = immutablePool();
  const bytes = serializeManualCaptureLexicalIndex({candidates, dataRevision: "synthetic-index"});
  const changedText = Object.freeze(candidates.map((row, index) => Object.freeze({...row, text: index ? row.text : "changed body"})));
  for (const input of [
    {candidates: changedText, dataRevision: "synthetic-index"},
    {candidates, dataRevision: "changed-revision"},
  ]) assert.throws(() => installManualCaptureLexicalIndex({...input, bytes}), /lexical_index_binding_invalid/u);
  assert.throws(() => installManualCaptureLexicalIndex({candidates: [...candidates], dataRevision: "synthetic-index", bytes}), /immutable_candidates_required/u);
});

test("prebuilt index rejects broken byte layout, normalization and posting ranges", () => {
  const candidates = immutablePool();
  const bytes = serializeManualCaptureLexicalIndex({candidates, dataRevision: "synthetic-index"});
  const offset = Math.ceil((12 + bytes.readUInt32LE(8)) / 8) * 8;
  const corruptions = [
    [value => value.subarray(0, value.length - 1), /lexical_index_length_invalid/u],
    [value => {value.writeDoubleLE(NaN, offset); return value;}, /lexical_index_normalization_invalid/u],
    [value => {value.writeUInt32LE(candidates.length, offset + candidates.length * 8); return value;}, /lexical_index_posting_invalid/u],
    [value => {value.writeUInt32LE(0, offset + candidates.length * 8 + 4); return value;}, /lexical_index_posting_invalid/u],
  ];
  for (const [mutate, error] of corruptions) {
    assert.throws(() => installManualCaptureLexicalIndex({candidates, dataRevision: "synthetic-index", bytes: mutate(Buffer.from(bytes))}), error);
  }
});
