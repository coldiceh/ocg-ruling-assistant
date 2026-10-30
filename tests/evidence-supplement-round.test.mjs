import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createGeminiBoundedEvidenceProvider } from "../backend/geminiBoundedEvidenceProvider.mjs";
import { buildRuleStructureMapping, makeQaSourceUnits, stableJson } from "../backend/evidenceSourceStructure.mjs";
import { createFocusedQaView } from "../backend/geminiFocusedQaView.mjs";
import { createQaTools } from "../backend/geminiQaTools.mjs";
import { resolveRagDataRevision } from "../backend/ragDataRevisionManifest.mjs";
import { answerRagRulingQuestion, finalizePreparedRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";
import { extractEvidenceStatusLine } from "../backend/evidenceStatusProtocol.mjs";
import { EVIDENCE_SUPPLEMENT_INVOCATION_BUDGET_MS } from "../backend/evidenceSupplementRound.mjs";
import { DEFAULT_WAIT_BUDGET_MS } from "../backend/engineRepro/session.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const data = { cards: [], records: [], qaRecords: [] };
const dataRevision = resolveRagDataRevision(data, "");
const fakeBudget = () => ({ snapshot: () => ({ calls: [] }) });
const INSUFFICIENT = "首轮回答正文\n证据状态：不足｜缺少：关于发动时点的一般规则";
const SUFFICIENT = "补充后的回答正文\n证据状态：充分";

const ruleRecords = [1, 2, 3, 4].map((n) => ({ id: `rule-${n}`, recordType: "rule-doc", title: `rule source ${n}`,
  text: `rule ${n} first paragraph ${"x".repeat(300)}\n\nrule ${n} second paragraph ${"y".repeat(300)}`,
  sourceAuthority: "official_reference", official: true }));
const qaRecords = [1, 2, 3, 4].map((n) => ({ id: `qa-${n}`, recordType: "qa", title: `fixture QA ${n}`,
  question: `fixture question ${n} ${"q".repeat(200)}`, answer: `fixture answer ${n} ${"a".repeat(200)}`, official: true }));

function schema3Assets() {
  const qaRevision = digest(stableJson(qaRecords));
  const parentTools = createQaTools({ records: qaRecords, qaRevision });
  const parents = parentTools.readSelected(parentTools.snapshotHandles);
  const focused = createFocusedQaView({ qaRevision, items: parents });
  const focusedByHandle = new Map(focused.items.map((item) => [item.handle, item]));
  const qaUnits = makeQaSourceUnits(focused.items).map((unit) => ({ ...unit, item: focusedByHandle.get(unit.handle) }));
  const { structureMappingRevision: _old, ...mappingBody } = buildRuleStructureMapping(ruleRecords);
  const structureMapping = { ...mappingBody, qaUnits };
  structureMapping.structureMappingRevision = digest(stableJson(structureMapping));
  const navigationRecords = [...structureMapping.sources.flatMap((source) => source.readingUnits), ...qaUnits]
    .map((unit) => ({ unitKey: unit.unitKey, sourceId: unit.sourceId,
      canonicalBodySha256: unit.sourceCanonicalSha256 || unit.canonicalBodySha256, contextInputSha256: "c".repeat(64),
      titlePath: unit.titlePath || [], descriptionZh: "", descriptionJa: "", searchQuestions: [],
      navigationStatus: "not_generated_in_scope", contextRefs: unit.contextRefs || [], explicitRefs: unit.explicitRefs || [],
      generator: null }));
  return { schemaVersion: 3, manifest: { schemaVersion: 3 }, dataRevision, bundleRevision: "b", qaRevision,
    ruleContentRevision: digest(stableJson(ruleRecords)), navigationRevision: "n",
    structureMappingRevision: structureMapping.structureMappingRevision, ruleDenseRevision: "rd", qaDenseRevision: "qd",
    rulesRecords: ruleRecords, structureMapping, navigationRecords,
    createQaTools: (options) => createQaTools({ records: qaRecords, qaRevision, ...options }) };
}

// A bounded provider over the fixture release. `select(delivered, round)`
// returns the selected aliases; requests are recorded per round.
function boundedFixture({ select = (delivered) => offeredIds(delivered).slice(0, 1) } = {}) {
  const assets = schema3Assets();
  const requests = [];
  let round = 0;
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => assets,
    loadDenseSearch: async ({ rules }) => ({ searchAsync: async () => [...rules.units.values()] }),
    loadQaSearch: async ({ items }) => ({ searchAsync: async () => items }),
    budgetedRequest: (request) => request.invoke(),
    remainingBudget: async () => Number.POSITIVE_INFINITY,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(":countTokens")) return Response.json({ totalTokens: 500 });
      if (url.endsWith(":embedContent")) return Response.json({ embedding: { values: Array(768).fill(1) },
        usageMetadata: { promptTokenCount: 100 } });
      if (url.endsWith(":batchEmbedContents")) return Response.json({
        embeddings: body.requests.map(() => ({ values: Array(768).fill(1) })), usageMetadata: { promptTokenCount: 100 } });
      const text = JSON.stringify(body);
      const plan = text.includes("为原题规划证据检索") || text.includes("为原题做一次补充检索规划");
      if (plan) round += 1;
      const delivered = JSON.parse(body.contents ? body.contents[0].parts[1].text
        : body.input.find((message) => message.role === "user").content.split("\n").at(-1));
      requests.push({ round, plan, text, delivered });
      const output = plan
        ? { needs: [{ id: "n", question: "fixture relation", ruleQuery: "fixture rule search", qaQuery: "fixture qa search" }] }
        : { selectedIds: select(delivered, round), note: "" };
      if (body.input) return Response.json({ id: "fixture", model: body.model, status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
        usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 } });
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 600 } });
    },
  });
  return { provider, requests, assets };
}

function offeredIds(delivered) {
  return (delivered.groups || []).flatMap((group) => [
    ...(group.units || []).map((row) => row[0]), ...(group.items || []).map((item) => item.handle)]);
}

// As in production (vercel.json), the first round has no separate retrieval deadline.
const baseEnv = { RAG_EVIDENCE_PIPELINE: "cloud_evidence_v1", GEMINI_RULE_QA_ENABLED: "true",
  RAG_LIVE_OFFICIAL_QA: "false", GEMINI_API_KEY: "fixture", GEMINI_EVIDENCE_READING_TARGET_CHARS: "9000",
  GEMINI_EVIDENCE_DEADLINE_MS: "0" };

async function prepare(provider, env = baseEnv) {
  const prepared = await answerRagRulingQuestion({ question: "original fixture question", ...data,
    prepareForContinuation: true, geminiEvidenceProvider: provider, cloudBudget: fakeBudget(), env,
    cardModelInvoker: async () => JSON.stringify({ cardNames: [], groupMentions: [] }),
    fetchImpl: async () => { throw new Error("unexpected transport"); } });
  assert.equal(prepared.status, "evidence_prepared");
  return JSON.parse(JSON.stringify(prepared.continuation));
}

function scriptedModel(...answers) {
  const prompts = [];
  return { prompts, modelInvoker: async ({ prompt }) => {
    prompts.push(prompt);
    assert.ok(prompts.length <= answers.length, "unexpected extra final-model call");
    return answers[prompts.length - 1];
  } };
}

function recordingProgress() {
  const events = [];
  return { events, transition() {}, phase: (name) => events.push(["phase_start", name]),
    endPhase: () => events.push(["phase_end"]) };
}

test("the status line is read as a field, removed from the shown text, and unknown when unreadable", () => {
  assert.deepEqual(extractEvidenceStatusLine("结论\n\n证据状态：充分"),
    { text: "结论", evidenceStatus: "sufficient", evidenceGap: "", evidenceStatusLine: "parsed" });
  assert.deepEqual(extractEvidenceStatusLine("结论\n证据状态：不足｜缺少：关于发动时点的一般规则  \n"),
    { text: "结论", evidenceStatus: "insufficient", evidenceGap: "关于发动时点的一般规则", evidenceStatusLine: "parsed" });
  assert.deepEqual(extractEvidenceStatusLine("结论\n**证据状态: 不足|缺少: 规则 X**"),
    { text: "结论", evidenceStatus: "insufficient", evidenceGap: "规则 X", evidenceStatusLine: "parsed" });
  // A protocol line with an undocumented value is still removed, but unknown.
  assert.deepEqual(extractEvidenceStatusLine("结论\n证据状态：部分不足"),
    { text: "结论", evidenceStatus: "unknown", evidenceGap: "", evidenceStatusLine: "malformed" });
  // Only the last line is the protocol position; nothing else is searched.
  for (const text of ["结论\n证据状态：充分\n补充说明", "没有状态行的结论"]) {
    assert.deepEqual(extractEvidenceStatusLine(text), { text, evidenceStatus: "unknown", evidenceGap: "", evidenceStatusLine: "absent" });
  }
});

test("finalized answers never show the status line and record the parsed status", async () => {
  const continuation = { schemaVersion: 1, mode: "rag_baseline", promptBundle: { prompt: "saved prompt",
    modelEvidence: {}, allowedEvidenceIds: [] }, evidence: {},
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] }, timingsMs: {} };
  for (const [raw, status, gap] of [[SUFFICIENT, "sufficient", ""],
    [INSUFFICIENT, "insufficient", "关于发动时点的一般规则"], ["只有正文", "unknown", ""]]) {
    const answer = await finalizePreparedRagRulingQuestion({ continuation, env: { RAG_MODEL_PROVIDER: "mock" },
      modelInvoker: async () => raw });
    assert.doesNotMatch(answer.shortAnswer, /证据状态/u);
    assert.equal(answer.debug.evidenceSupplement.evidenceStatus, status);
    assert.equal(answer.debug.evidenceSupplement.evidenceGap, gap);
    // The switch is off by default: no round is started.
    assert.equal(answer.debug.evidenceSupplement.triggered, false);
    assert.equal(answer.debug.evidenceSupplement.status, status === "insufficient" ? "disabled" : "not_needed");
  }
});

test("a supplementary provider round reads only units the first round never offered", async () => {
  const { provider, requests } = boundedFixture();
  const first = await provider.retrieve({ userQuery: "original fixture question", dataRevision, env: baseEnv,
    cardResolution: { resolvedCards: [] }, retrievedEvidence: { cardTexts: [] } });
  const firstOffered = first.telemetry.bounded.reading.offered.map((bundle) => bundle.unitKey);
  const firstSelected = first.packing.modelEvidence.rawRelatedEvidence.map((item) => item.id);
  assert.ok(firstOffered.length > 0 && first.telemetry.bounded.reading.omitted.length > 0,
    "the fixture window must leave candidates unread");
  const second = await provider.retrieve({ userQuery: "original fixture question", dataRevision, env: baseEnv,
    cardResolution: { resolvedCards: [] }, retrievedEvidence: { cardTexts: [] },
    supplement: { evidenceGap: "关于发动时点的一般规则", baseSelectionIds: firstSelected,
      excludeUnitKeys: firstOffered,
      excludeEntryIds: first.telemetry.bounded.reading.offered.flatMap((bundle) => bundle.atomIds),
      priorLanes: first.telemetry.bounded.reading.lanes, previousQueryPlan: first.telemetry.queryPlan,
      previouslyDelivered: [{ recordType: "rule-doc", title: "rule source 1" }],
      basePromptChars: first.packing.prompt.length } });
  const supplementRequests = requests.filter((request) => request.round === 2);
  assert.equal(supplementRequests.length, 2);
  assert.match(supplementRequests[0].text, /为原题做一次补充检索规划/u);
  assert.equal(supplementRequests[0].delivered.supplement.evidenceGap, "关于发动时点的一般规则");
  const selection = supplementRequests[1];
  assert.match(selection.text, /本次是补充选证/u);
  const reread = selection.delivered.groups.map((group) => group.groupId);
  assert.ok(reread.length > 0);
  for (const unitKey of reread) assert.equal(firstOffered.includes(unitKey), false, unitKey);
  // The selector's base already contains the first package.
  assert.equal(selection.delivered.packingBudget.basePromptChars, first.packing.prompt.length);
  const delivered = second.packing.modelEvidence.rawRelatedEvidence.map((item) => item.id);
  assert.deepEqual(delivered.slice(0, firstSelected.length), firstSelected);
  assert.equal(delivered.length, firstSelected.length + 1);
  assert.deepEqual(second.supplement.addedEntryIds, delivered.slice(firstSelected.length));
  assert.deepEqual(second.supplement.trimmedEntryIds, []);
  assert.equal(second.supplement.basePromptSha256, digest(first.packing.prompt));
  assert.equal(second.supplement.excludedUnits >= firstOffered.length, true);
  assert.equal(second.supplement.offeredUnits, reread.length);
});

test("the union keeps every first-round entry and trims new entries in selection order at the limit", async () => {
  const { provider } = boundedFixture({ select: (delivered, round) => round === 1
    ? offeredIds(delivered).slice(0, 1) : offeredIds(delivered) });
  const first = await provider.retrieve({ userQuery: "original fixture question", dataRevision, env: baseEnv,
    cardResolution: { resolvedCards: [] }, retrievedEvidence: { cardTexts: [] } });
  const firstSelected = first.packing.modelEvidence.rawRelatedEvidence.map((item) => item.id);
  const supplement = { evidenceGap: "缺少的规则", baseSelectionIds: firstSelected,
    excludeUnitKeys: first.telemetry.bounded.reading.offered.map((bundle) => bundle.unitKey),
    excludeEntryIds: first.telemetry.bounded.reading.offered.flatMap((bundle) => bundle.atomIds),
    priorLanes: first.telemetry.bounded.reading.lanes, basePromptChars: first.packing.prompt.length };
  const unlimited = await provider.retrieve({ userQuery: "original fixture question", dataRevision, env: baseEnv,
    cardResolution: { resolvedCards: [] }, retrievedEvidence: { cardTexts: [] }, supplement });
  const selectedInOrder = unlimited.supplement.addedEntryIds;
  assert.ok(selectedInOrder.length >= 2, "the fixture must select more than one new entry");
  // A limit between "first package + one new entry" and "+ two" keeps exactly one.
  const limit = Math.floor((first.packing.prompt.length + unlimited.packing.prompt.length) / 2);
  const oneMore = await provider.retrieve({ userQuery: "original fixture question", dataRevision,
    env: { ...baseEnv, GEMINI_EVIDENCE_MAX_PROMPT_CHARS: String(limit) },
    cardResolution: { resolvedCards: [] }, retrievedEvidence: { cardTexts: [] }, supplement });
  const delivered = oneMore.packing.modelEvidence.rawRelatedEvidence.map((item) => item.id);
  assert.deepEqual(delivered.slice(0, firstSelected.length), firstSelected);
  assert.ok(oneMore.packing.prompt.length <= limit);
  assert.deepEqual([...oneMore.supplement.addedEntryIds, ...oneMore.supplement.trimmedEntryIds], selectedInOrder);
  assert.ok(oneMore.supplement.addedEntryIds.length >= 1 && oneMore.supplement.trimmedEntryIds.length >= 1);
});

test("a full first package or a Decisions selector stops a supplementary round before any request", async () => {
  const { provider, requests } = boundedFixture();
  const supplement = { evidenceGap: "缺少的规则", baseSelectionIds: [], excludeUnitKeys: [], excludeEntryIds: [],
    priorLanes: [], basePromptChars: 14000 };
  await assert.rejects(provider.retrieve({ userQuery: "q", dataRevision, env: baseEnv,
    cardResolution: { resolvedCards: [] }, supplement }), { code: "evidence_supplement_pack_capacity_exhausted" });
  await assert.rejects(provider.retrieve({ userQuery: "q", dataRevision,
    env: { ...baseEnv, EVIDENCE_SELECTOR: "decisions", OPENAI_DECISIONS_API_KEY: "fixture" },
    cardResolution: { resolvedCards: [] }, supplement: { ...supplement, basePromptChars: 100 } }),
  { code: "evidence_supplement_selector_unsupported" });
  await assert.rejects(provider.retrieve({ userQuery: "q", dataRevision, env: baseEnv,
    cardResolution: { resolvedCards: [] }, supplement: { ...supplement, evidenceGap: "" } }),
  { code: "evidence_supplement_request_invalid" });
  assert.equal(requests.length, 0);
});

test("an insufficient first answer runs one supplementary round and shows the second answer", async () => {
  const { provider, requests } = boundedFixture();
  const continuation = await prepare(provider);
  const firstSelected = continuation.promptBundle.modelEvidence.rawRelatedEvidence.map((item) => item.id);
  // The second answer may still report a gap: there is never a third call.
  const model = scriptedModel(INSUFFICIENT, "补充后的回答正文\n证据状态：不足｜缺少：另一条规则");
  const progress = recordingProgress();
  const env = { ...baseEnv, EVIDENCE_SUPPLEMENT_ENABLED: "true" };
  const answer = await finalizePreparedRagRulingQuestion({ continuation, env, cloudBudget: fakeBudget(),
    modelInvoker: model.modelInvoker, evidenceSupplementProvider: provider, progress,
    returnSupplementedEvidencePackage: true });
  assert.equal(model.prompts.length, 2);
  assert.equal(model.prompts[0], continuation.promptBundle.prompt);
  assert.notEqual(model.prompts[1], model.prompts[0]);
  assert.equal(answer.shortAnswer, "补充后的回答正文");
  assert.deepEqual(progress.events, [["phase_start", "evidence_supplement"], ["phase_end"]]);
  const used = answer.usedEvidence.map((item) => item.id);
  assert.deepEqual(used.slice(0, firstSelected.length), firstSelected);
  assert.equal(used.length, firstSelected.length + 1);
  assert.deepEqual(answer.evidencePackage, { text: model.prompts[1], filename: "ocg-evidence.txt", supplemented: true });
  assert.equal(answer.debug.finalPromptSha256, digest(model.prompts[1]));
  const supplement = answer.debug.evidenceSupplement;
  assert.equal(supplement.status, "applied");
  assert.equal(supplement.triggered, true);
  assert.equal(supplement.evidenceGap, "关于发动时点的一般规则");
  assert.equal(supplement.invocation.shape, "prepared_finalize");
  assert.equal(supplement.retrieval.addedEntries, 1);
  assert.equal(supplement.retrieval.trimmedEntries, 0);
  assert.equal(supplement.retrieval.baseRepackIdentical, true);
  assert.ok(supplement.retrieval.offeredUnits > 0 && supplement.retrieval.recalledUnits >= supplement.retrieval.offeredUnits);
  assert.equal(supplement.finalModel.evidenceStatus, "insufficient");
  assert.equal(supplement.firstRound.evidenceStatus, "insufficient");
  assert.ok(supplement.estimatedCostUsd > 0);
  assert.ok(answer.debug.estimatedCostUsd >= supplement.estimatedCostUsd);
  assert.ok(Number.isFinite(answer.debug.timingsMs.evidenceSupplement));
  assert.ok(Number.isFinite(answer.debug.timingsMs.finalModel));
  assert.equal(requests.filter((request) => request.round === 2).length, 2);
  // Without the web finalize request's flag no package is attached.
  const { provider: other } = boundedFixture();
  const plain = await finalizePreparedRagRulingQuestion({ continuation: await prepare(other), env,
    cloudBudget: fakeBudget(), modelInvoker: scriptedModel(INSUFFICIENT, SUFFICIENT).modelInvoker,
    evidenceSupplementProvider: other });
  assert.equal(plain.debug.evidenceSupplement.status, "applied");
  assert.equal(Object.hasOwn(plain, "evidencePackage"), false);
});

test("an invocation that cannot fit the estimated round skips it and records skipped_time_budget", async () => {
  const { provider, requests } = boundedFixture();
  const continuation = await prepare(provider);
  const before = requests.length;
  const model = scriptedModel(INSUFFICIENT);
  const progress = recordingProgress();
  const answer = await finalizePreparedRagRulingQuestion({ continuation, cloudBudget: fakeBudget(),
    env: { ...baseEnv, EVIDENCE_SUPPLEMENT_ENABLED: "true" }, modelInvoker: model.modelInvoker,
    evidenceSupplementProvider: provider, progress,
    invocationStartedAt: Date.now() - (EVIDENCE_SUPPLEMENT_INVOCATION_BUDGET_MS - 100_000) });
  assert.equal(model.prompts.length, 1);
  assert.equal(requests.length, before);
  assert.deepEqual(progress.events, []);
  assert.equal(answer.shortAnswer, "首轮回答正文");
  assert.equal(answer.debug.evidenceSupplement.status, "skipped");
  assert.equal(answer.debug.evidenceSupplement.skipReason, "skipped_time_budget");
  assert.equal(answer.debug.evidenceSupplement.triggered, false);
  assert.equal(answer.debug.evidenceSupplement.invocation.estimatedRoundMs, 110_000);
  // The estimate is configurable.
  const shorter = await finalizePreparedRagRulingQuestion({ continuation, cloudBudget: fakeBudget(),
    env: { ...baseEnv, EVIDENCE_SUPPLEMENT_ENABLED: "true", EVIDENCE_SUPPLEMENT_ESTIMATED_ROUND_MS: "60000" },
    modelInvoker: scriptedModel(INSUFFICIENT, SUFFICIENT).modelInvoker, evidenceSupplementProvider: provider,
    invocationStartedAt: Date.now() - (EVIDENCE_SUPPLEMENT_INVOCATION_BUDGET_MS - 100_000) });
  assert.equal(shorter.debug.evidenceSupplement.status, "applied");
});

test("the single-request path counts its time from the public request", async () => {
  const run = async (nonCardElapsedBeforePipelineMs) => {
    const { provider } = boundedFixture();
    const model = scriptedModel(INSUFFICIENT, SUFFICIENT);
    const answer = await answerRagRulingQuestion({ question: "original fixture question", ...data,
      geminiEvidenceProvider: provider, evidenceSupplementProvider: provider, cloudBudget: fakeBudget(),
      env: { ...baseEnv, EVIDENCE_SUPPLEMENT_ENABLED: "true" }, nonCardElapsedBeforePipelineMs,
      cardModelInvoker: async () => JSON.stringify({ cardNames: [], groupMentions: [] }),
      modelInvoker: model.modelInvoker, fetchImpl: async () => { throw new Error("unexpected transport"); } });
    return { answer, calls: model.prompts.length };
  };
  const late = await run(200_000);
  assert.equal(late.calls, 1);
  assert.equal(late.answer.debug.evidenceSupplement.skipReason, "skipped_time_budget");
  assert.equal(late.answer.debug.evidenceSupplement.invocation.shape, "single_request");
  assert.ok(late.answer.debug.evidenceSupplement.invocation.elapsedMs >= 200_000);
  const early = await run(1_000);
  assert.equal(early.calls, 2);
  assert.equal(early.answer.debug.evidenceSupplement.status, "applied");
  assert.equal(early.answer.debug.evidenceSupplement.invocation.shape, "single_request");
  assert.equal(early.answer.shortAnswer, "补充后的回答正文");
  assert.equal(Object.hasOwn(early.answer, "evidencePackage"), false);
});

test("a failed supplementary step or no new entry keeps the first answer", async () => {
  const { provider } = boundedFixture();
  const continuation = await prepare(provider);
  const env = { ...baseEnv, EVIDENCE_SUPPLEMENT_ENABLED: "true" };
  const failing = { retrieve: async () => { throw Object.assign(new Error("evidence_plan_needs_absent"),
    { boundedRetrieval: { estimatedCostUsd: 0.001, timingsMs: { plan: 5 } } }); } };
  const progress = recordingProgress();
  const failed = await finalizePreparedRagRulingQuestion({ continuation, env, cloudBudget: fakeBudget(),
    modelInvoker: scriptedModel(INSUFFICIENT).modelInvoker, evidenceSupplementProvider: failing, progress,
    returnSupplementedEvidencePackage: true });
  assert.equal(failed.shortAnswer, "首轮回答正文");
  assert.equal(failed.debug.evidenceSupplement.status, "failed");
  assert.equal(failed.debug.evidenceSupplement.failureReason, "evidence_plan_needs_absent");
  assert.equal(failed.debug.evidenceSupplement.retrieval.estimatedCostUsd, 0.001);
  assert.equal(failed.debug.finalPromptSha256, continuation.finalPromptSha256);
  assert.deepEqual(failed.usedEvidence.map((item) => item.id),
    continuation.promptBundle.modelEvidence.rawRelatedEvidence.map((item) => item.id));
  assert.equal(Object.hasOwn(failed, "evidencePackage"), false);
  assert.deepEqual(progress.events, [["phase_start", "evidence_supplement"], ["phase_end"]]);

  const { provider: empty } = boundedFixture({ select: (delivered, round) => round === 1 ? offeredIds(delivered).slice(0, 1) : [] });
  const model = scriptedModel(INSUFFICIENT);
  const unchanged = await finalizePreparedRagRulingQuestion({ continuation: await prepare(empty), env,
    cloudBudget: fakeBudget(), modelInvoker: model.modelInvoker, evidenceSupplementProvider: empty });
  assert.equal(model.prompts.length, 1);
  assert.equal(unchanged.shortAnswer, "首轮回答正文");
  assert.equal(unchanged.debug.evidenceSupplement.status, "no_new_evidence");
  assert.equal(unchanged.debug.evidenceSupplement.retrieval.addedEntries, 0);

  // A second final call that fails keeps the first answer too.
  const { provider: third } = boundedFixture();
  const notShown = await finalizePreparedRagRulingQuestion({ continuation: await prepare(third), env,
    cloudBudget: fakeBudget(), modelInvoker: scriptedModel(INSUFFICIENT, "").modelInvoker, evidenceSupplementProvider: third });
  assert.equal(notShown.shortAnswer, "首轮回答正文");
  assert.equal(notShown.debug.evidenceSupplement.status, "failed");
  assert.equal(notShown.debug.evidenceSupplement.failureReason, "final_model_not_displayable");
});

test("the round stops at the invocation deadline, while a cancelled request stays cancelled", async (t) => {
  const { provider } = boundedFixture();
  const continuation = await prepare(provider);
  const env = { ...baseEnv, EVIDENCE_SUPPLEMENT_ENABLED: "true", EVIDENCE_SUPPLEMENT_ESTIMATED_ROUND_MS: "1" };
  const waitsForAbort = { retrieve: ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) };
  // AbortSignal.timeout does not keep a process alive; a served request does.
  const keepAlive = setInterval(() => {}, 20);
  t.after(() => clearInterval(keepAlive));
  const startedAt = Date.now();
  const timedOut = await finalizePreparedRagRulingQuestion({ continuation, env, cloudBudget: fakeBudget(),
    modelInvoker: scriptedModel(INSUFFICIENT).modelInvoker, evidenceSupplementProvider: waitsForAbort,
    invocationStartedAt: Date.now() - EVIDENCE_SUPPLEMENT_INVOCATION_BUDGET_MS + 300 });
  assert.ok(Date.now() - startedAt < 5_000);
  assert.equal(timedOut.shortAnswer, "首轮回答正文");
  assert.equal(timedOut.debug.evidenceSupplement.status, "failed");
  assert.equal(timedOut.debug.evidenceSupplement.failureReason, "deadline_exceeded");

  const controller = new AbortController();
  const pending = finalizePreparedRagRulingQuestion({ continuation, env, cloudBudget: fakeBudget(),
    signal: controller.signal, modelInvoker: scriptedModel(INSUFFICIENT).modelInvoker,
    evidenceSupplementProvider: { retrieve: (input) => {
      setImmediate(() => controller.abort(new Error("client_disconnected")));
      return waitsForAbort.retrieve(input);
    } } });
  await assert.rejects(pending, /client_disconnected/u);
});

test("the round's invocation budget is the engine-reproduction wait budget under the 300 s function limit", async () => {
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(vercel.functions["api/answer.js"].maxDuration, 300);
  assert.equal(EVIDENCE_SUPPLEMENT_INVOCATION_BUDGET_MS, DEFAULT_WAIT_BUDGET_MS);
});
