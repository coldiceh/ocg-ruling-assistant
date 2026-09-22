import { displayedPayload } from './helpers/readable-prompt.mjs';
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGeminiBoundedEvidenceProvider, boundedPlanBody,
  boundedSelectionBody } from "../backend/geminiBoundedEvidenceProvider.mjs";
import { buildRuleStructureMapping, makeQaSourceUnits, stableJson } from "../backend/evidenceSourceStructure.mjs";
import { createFocusedQaView } from "../backend/geminiFocusedQaView.mjs";
import { createQaTools } from "../backend/geminiQaTools.mjs";
import { buildRuleContext } from "../backend/geminiRuleContext.mjs";
import { computeGeminiSelectionPackingBudget } from "../backend/geminiRuleQaPacking.mjs";
import { publicAnswerHttpError } from '../backend/publicAnswerService.mjs';

const digest = value => createHash("sha256").update(value).digest("hex");
const rule = { id: "rule", recordType: "rule-doc", title: "fixture source",
  text: "paragraph one\n\nparagraph two", sourceAuthority: "official_reference", official: true };
const qa = { id: "qa", recordType: "qa", title: "fixture QA", question: "fixture question",
  answer: "complete fixture answer", official: true };

function schema3Assets(ruleRecords = [rule], qaRecords = [qa]) {
  const qaRevision = digest(stableJson(qaRecords));
  const parentTools = createQaTools({ records: qaRecords, qaRevision });
  const parents = parentTools.readSelected(parentTools.snapshotHandles);
  const focused = createFocusedQaView({ qaRevision, items: parents });
  const focusedByHandle = new Map(focused.items.map(item => [item.handle, item]));
  const qaUnits = makeQaSourceUnits(focused.items).map(unit => ({ ...unit,
    item: focusedByHandle.get(unit.handle) }));
  const base = buildRuleStructureMapping(ruleRecords);
  const { structureMappingRevision: _old, ...mappingBody } = base;
  const structureMapping = { ...mappingBody, qaUnits };
  structureMapping.structureMappingRevision = digest(stableJson(structureMapping));
  const navigationRecords = [
    ...structureMapping.sources.flatMap(source => source.readingUnits), ...qaUnits,
  ].map(unit => ({ unitKey: unit.unitKey, sourceId: unit.sourceId,
    canonicalBodySha256: unit.sourceCanonicalSha256 || unit.canonicalBodySha256,
    contextInputSha256: "c".repeat(64), titlePath: unit.titlePath || [], descriptionZh: "",
    descriptionJa: "", searchQuestions: [], navigationStatus: "not_generated_in_scope",
    contextRefs: unit.contextRefs || [], explicitRefs: unit.explicitRefs || [], generator: null }));
  const createTools = options => createQaTools({ records: qaRecords, qaRevision, ...options });
  return { schemaVersion: 3, manifest: { schemaVersion: 3 }, dataRevision: "d",
    bundleRevision: "b", qaRevision, ruleContentRevision: digest(stableJson(ruleRecords)),
    navigationRevision: "n", structureMappingRevision: structureMapping.structureMappingRevision,
    ruleDenseRevision: "rd", qaDenseRevision: "qd", rulesRecords: ruleRecords,
    structureMapping, navigationRecords, createQaTools: createTools };
}

const input = { userQuery: "original complete question and scene", dataRevision: "d",
  env: { GEMINI_API_KEY: "fixture" },
  cardResolution: { resolvedCards: [], unresolvedMentions: ["unresolved original"] },
  retrievedEvidence: { cardTexts: [{ id: "card-text", text: "complete canonical card text" }],
    userProvidedCardTexts: [{ name: "user fixture", text: "complete user-supplied text" }] } };

const unrestrictedEvidenceEnv = { ...input.env,
  EVIDENCE_GENERATION_OUTPUT_LIMIT: 'provider',
  GEMINI_EVIDENCE_DEADLINE_MS: '0', GEMINI_EVIDENCE_MAX_CNY: '0',
  GEMINI_EVIDENCE_MAX_PROMPT_CHARS: '15000' };

test('production request can omit output, single-question cost and deadline limits', async () => {
  const { provider, requests } = fixture({ countTokens: 100000 });
  const result = await provider.retrieve({ ...input, env: unrestrictedEvidenceEnv,
    elapsedBeforeRetrievalMs: 61000 });
  assert.equal(requests.length, 2);
  for (const request of requests) assert.equal(Object.hasOwn(request.generationConfig, 'maxOutputTokens'), false);
  assert.equal(result.telemetry.bounded.deadlineMs, null);
  assert.equal(result.telemetry.bounded.perQuestionMaxUsd, null);
  assert.equal(result.telemetry.bounded.maxPromptChars, 15000);
  assert.ok(result.packing.prompt.length <= 15000);
});

test('removing generation limits still rejects a final evidence prompt over 15000 characters', async () => {
  const oversizedQa = { ...qa, answer: 'complete fixture body '.repeat(900) };
  const { provider } = fixture({ assets: schema3Assets([rule], [oversizedQa]),
    select: delivered => ({ selectedIds: delivered.groups.flatMap(group => group.items || []).map(item => item.handle), unableToSelect: false, note: '' }) });
  await assert.rejects(provider.retrieve({ ...input, env: { ...unrestrictedEvidenceEnv,
    GEMINI_EVIDENCE_READING_TARGET_CHARS: '100000' } }), error => {
    assert.ok(error.boundedRetrieval.packingFailure.actualPromptChars > 15000);
    return true;
  });
});

function fixture({ assets = schema3Assets(), plan, select, countTokens = 500,
  denseRules, denseQa, remainingBudget, onEvent } = {}) {
  const requests = [];
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => assets,
    loadDenseSearch: async ({ rules }) => ({ searchAsync: async () => denseRules || [...rules.units.values()] }),
    loadQaSearch: async ({ items }) => ({ searchAsync: async () => denseQa || items }),
    budgetedRequest: request => request.invoke(),
    ...(remainingBudget ? { remainingBudget } : {}),
    ...(onEvent ? { onEvent } : {}),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(":countTokens")) return Response.json({ totalTokens: typeof countTokens === 'function' ? countTokens(body) : countTokens });
      if (url.endsWith(":embedContent")) return Response.json({ embedding: { values: Array(768).fill(1) },
        usageMetadata: { promptTokenCount: 100 } });
      if (url.endsWith(":batchEmbedContents")) return Response.json({
        embeddings: body.requests.map(() => ({ values: Array(768).fill(1) })),
        usageMetadata: { promptTokenCount: 100 } });
      requests.push(body);
      const delivered = JSON.parse(body.contents ? body.contents[0].parts[1].text
        : body.input.find(message => message.role === 'user').content.split('\n').at(-1));
      const output = requests.length === 1
        ? (plan || { needs: [{ id: "source-id", question: "fixture relation",
          ruleQuery: "fixture rule search", qaQuery: "fixture qa search" }] })
        : (typeof select === "function" ? select(delivered) : select || { selectedIds: delivered.groups.flatMap(group => [
          ...(group.units || []).map(row => row[0]), ...(group.items || []).map(item => item.handle),
        ]).slice(0, 2), unableToSelect: false, note: "" });
      if (output instanceof Response) return output;
      if (body.input) return Response.json({ id: 'fixture-response', model: body.model, status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
        usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 } });
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80,
          thoughtsTokenCount: 20, totalTokenCount: 600 } });
    },
  });
  return { provider, requests };
}

test("plan-v2 carries the complete question/card projection without a corpus directory", () => {
  const body = boundedPlanBody({ question: "q", confirmedCards: [{ id: "c", text: "full" }],
    cardTexts: [{ text: "card" }], userProvidedCardTexts: [], unresolvedMentions: [], ambiguousMentions: [] });
  const delivered = JSON.parse(body.contents[0].parts[1].text);
  assert.equal(delivered.question, "q");
  assert.equal(delivered.confirmedCards[0].text, "full");
  assert.equal(Object.hasOwn(delivered, "ruleSections"), false);
  assert.equal(Object.hasOwn(delivered, "qaCandidates"), false);
  assert.match(body.contents[0].parts[0].text, /"needs"/u);
});

test("selection-v2 exposes only offered aliases and preserves rule authority and table layout", () => {
  const unit = { id: "A1", text: "full table", ruleUnitIndex: 2, tableLayout: { rowCount: 1,
    columnCount: 1, cells: [{ row: 0, column: 0, tag: "td", rowSpan: 1, columnSpan: 1, start: 0, end: 10 }] },
    recordType: "rule-doc", title: "t", sourceAuthority: "official_reference", official: true,
    parentSourceId: "s", sourceSection: { titlePath: ["root", "leaf"] } };
  const body = boundedSelectionBody({ question: "q" }, { needs: [] },
    [{ groupId: "u", kind: "rule", units: [unit] }], { bundleRevision: "b" });
  const delivered = JSON.parse(body.contents[0].parts[1].text);
  assert.deepEqual(delivered.ruleUnitFields, ["id", "text", "ruleUnitIndex", "sourceRef", "tableLayout"]);
  assert.equal(delivered.groups[0].units[0][0], "A1");
  assert.deepEqual(delivered.groups[0].units[0][4], unit.tableLayout);
  assert.equal(Object.values(delivered.ruleSources)[0].sourceAuthority, "official_reference");
  assert.match(body.contents[0].parts[0].text, /selectedIds/u);
});

test("selection packing budget contains exact serialized costs for offered aliases only", async () => {
  const assets = schema3Assets();
  const { provider, requests } = fixture({ assets });
  await provider.retrieve(input);
  const delivered = JSON.parse(requests[1].contents[0].parts[1].text);
  const offeredRules = delivered.groups.flatMap(group => group.units || []);
  const offeredQa = delivered.groups.flatMap(group => group.items || []);
  const rules = buildRuleContext(assets.rulesRecords, { ruleContentRevision: assets.ruleContentRevision,
    structureMapping: assets.structureMapping });
  const ruleByProjection = new Map([...rules.sourceAtoms.values()]
    .map(atom => [`${atom.ruleUnitIndex}:${atom.text}`, atom]));
  const qaItems = assets.createQaTools().readSelected(assets.createQaTools().snapshotHandles);
  const qaById = new Map(qaItems.map(item => [item.record.id, item]));
  const expected = computeGeminiSelectionPackingBudget({
    rules: offeredRules.map(row => ruleByProjection.get(`${row[2]}:${row[1]}`)),
    qaItems: offeredQa.map(item => qaById.get(item.record.id)),
    userQuery: input.userQuery, cardResolution: input.cardResolution,
    retrievedEvidence: input.retrievedEvidence,
  });
  assert.equal(delivered.packingBudget.limitChars, 14000);
  assert.equal(delivered.packingBudget.basePromptChars, expected.basePromptChars);
  assert.equal(delivered.packingBudget.availableEvidenceChars, expected.availableEvidenceChars);
  assert.deepEqual(Object.keys(delivered.packingBudget.ruleUnitChars).sort(),
    [...new Set(offeredRules.map(row => row[0]))].sort());
  assert.deepEqual(Object.keys(delivered.packingBudget.qaHandleChars).sort(),
    [...new Set(offeredQa.map(item => item.handle))].sort());
  offeredRules.forEach(row => assert.equal(delivered.packingBudget.ruleUnitChars[row[0]],
    expected.ruleUnitChars[ruleByProjection.get(`${row[2]}:${row[1]}`).id]));
  offeredQa.forEach(item => assert.equal(delivered.packingBudget.qaHandleChars[item.handle],
    expected.qaHandleChars[qaById.get(item.record.id).handle]));
});

test("oversized selected evidence preserves the actual prompt diagnostic without another model call", async () => {
  const oversizedQa = { ...qa, answer: "complete fixture body ".repeat(720) };
  const assets = schema3Assets([rule], [oversizedQa]);
  const { provider, requests } = fixture({ assets, select: delivered => ({
    selectedIds: [delivered.groups.flatMap(group => group.items || [])[0].handle],
    unableToSelect: false, note: "",
  }) });
  await assert.rejects(provider.retrieve(input), error => {
    assert.equal(error.message, "gemini_bounded_pack_capacity_exceeded");
    const captured = error.boundedRetrieval.packingFailure;
    assert.equal(captured.prompt, error.packing.prompt);
    assert.equal(captured.actualPromptChars, captured.prompt.length);
    assert.ok(captured.actualPromptChars > 14000);
    assert.deepEqual(captured.allowedEvidenceIds, error.packing.allowedEvidenceIds);
    return true;
  });
  assert.equal(requests.length, 2);
});

test("two-round retrieval keeps the original question and complete independent card texts", async () => {
  const { provider, requests } = fixture();
  const result = await provider.retrieve(input);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const delivered = JSON.parse(request.contents[0].parts[1].text);
    assert.equal(delivered.question, input.userQuery);
    assert.deepEqual(delivered.cardTexts, input.retrievedEvidence.cardTexts);
    assert.deepEqual(delivered.userProvidedCardTexts, input.retrievedEvidence.userProvidedCardTexts);
    assert.deepEqual(delivered.unresolvedMentions, input.cardResolution.unresolvedMentions);
    assert.equal(Object.hasOwn(request, "cachedContent"), false);
  }
  assert.ok(result.packing.promptChars <= 14000);
  assert.equal(result.telemetry.rounds, 2);
  assert.ok(result.telemetry.bounded.calls.some(call => call.stage === "original_query_embedding"));
  assert.ok(result.telemetry.bounded.calls.some(call => call.stage === "planned_query_embedding"));
});

test("bounded provider uses the lazy QA lexical path without legacy searchAll", async () => {
  const base = schema3Assets();
  let boundedSearches = 0;
  const assets = { ...base, createQaTools: options => {
    const tools = base.createQaTools(options);
    return { ...tools,
      searchAll() { throw new Error("legacy_search_all_called"); },
      *searchBounded(args) {
        boundedSearches += 1;
        yield* tools.searchBounded(args);
      },
    };
  } };
  const { provider } = fixture({ assets });
  await provider.retrieve(input);
  assert.equal(boundedSearches, 3);
});

test("both rounds preserve the complete confirmed-card identity and source projection", async () => {
  const effectText = "complete canonical monster effect\nsecond condition";
  const pendulumEffectText = "independent complete pendulum effect";
  const card = { id: "fixture-card", name: "fixture card", aliases: ["fixture alias"],
    input: "original mention", matchedQuery: "source lookup", cardId: "fixture-card", cid: "88",
    passcode: "12345678", cnName: "测试卡", jaName: "テストカード", enName: "Test Card",
    sourceUrl: "https://example.invalid/card", sourceLabel: "official fixture", official: true,
    sourceAuthority: "official_reference", relatedOnly: false, linkRating: 2, linkArrows: [1, 2],
    cardType: "monster", typeLine: "[monster|pendulum|effect]", effectText, text: effectText,
    pendulumEffectText, pendulumScale: 7, attribute: "dark", race: "Fiend",
    atk: 1500, def: 1000, level: 4, rank: null, link: null,
    properties: ["Pendulum", "Effect"], monsterProperties: ["Pendulum", "Effect"],
    source: "fixture source", resolutionSource: "card_text_reference" };
  const requestInput = { ...input, cardResolution: { ...input.cardResolution, resolvedCards: [card] } };
  const { provider, requests } = fixture();
  const result = await provider.retrieve(requestInput);
  const marker = "本次用户问题、卡片原文与检索资料如下：\n";
  const finalPayload = displayedPayload(result.packing);
  for (const request of requests) {
    const delivered = JSON.parse(request.contents[0].parts[1].text);
    assert.deepEqual(delivered.confirmedCards, [{ ...finalPayload.resolvedCards[0],
      input: card.input, matchedQuery: card.matchedQuery, cardId: card.cardId, cid: card.cid,
      passcode: card.passcode, cnName: card.cnName, jaName: card.jaName, enName: card.enName,
      sourceUrl: card.sourceUrl, sourceLabel: card.sourceLabel, official: card.official,
      sourceAuthority: card.sourceAuthority, relatedOnly: card.relatedOnly,
      linkRating: card.linkRating, linkArrows: card.linkArrows }]);
    assert.equal(delivered.confirmedCards[0].effectText, effectText);
    assert.equal(delivered.confirmedCards[0].pendulumEffectText, pendulumEffectText);
    assert.equal(delivered.confirmedCards[0].pendulumScale, 7);
    assert.equal(delivered.confirmedCards[0].resolutionSource, "card_text_reference");
  }
});

test("original and both planned query variants stay as independent retrieval lanes", async () => {
  const seenRule = [], seenQa = [];
  const assets = schema3Assets();
  const { provider } = fixture({ assets,
    denseRules: undefined, denseQa: undefined });
  const wrapped = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => assets,
    loadDenseSearch: async ({ rules }) => ({ searchAsync: async vector => { seenRule.push(vector); return [...rules.units.values()]; } }),
    loadQaSearch: async ({ items }) => ({ searchAsync: async vector => { seenQa.push(vector); return items; } }),
    budgetedRequest: request => request.invoke(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(":countTokens")) return Response.json({ totalTokens: 500 });
      if (url.endsWith(":embedContent")) return Response.json({ embedding: { values: Array(768).fill(1) } });
      if (url.endsWith(":batchEmbedContents")) return Response.json({ embeddings: body.requests.map(() => ({ values: Array(768).fill(2) })) });
      const delivered = JSON.parse(body.contents[0].parts[1].text);
      const output = delivered.groups ? { selectedIds: [], unableToSelect: false, note: "" }
        : { needs: [{ question: "need", ruleQuery: "rule variant", qaQuery: "qa variant" }] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
    },
  });
  await wrapped.retrieve({ ...input, retrievedEvidence: {}, cardResolution: { resolvedCards: [] } });
  assert.equal(seenRule.length, 3);
  assert.equal(seenQa.length, 3);
});

test("a selection cannot name an alias that was not actually offered", async () => {
  const { provider } = fixture({ select: { selectedIds: ["A999"], unableToSelect: false, note: "" } });
  await assert.rejects(provider.retrieve(input), /gemini_bounded_selected_identity_not_offered/u);
});

test('unknown selection aliases get one measured reselection using the identical offered material', async () => {
  let attempts = 0;
  const events = [];
  const { provider, requests } = fixture({ onEvent: event => events.push(event),
    select: delivered => ({ selectedIds: ++attempts === 1 ? ['A999']
      : [delivered.groups.flatMap(group => group.units || [])[0][0]],
    unableToSelect: false, note: '' }) });
  const result = await provider.retrieve(input);
  assert.equal(attempts, 2);
  assert.equal(requests.length, 3, 'planning happens only once');
  assert.deepEqual(requests[2].contents[0], requests[1].contents[0]);
  const diagnostic = events.find(event => event.type === 'selection_identity_failure');
  assert.deepEqual(diagnostic.unknownIds, ['A999']);
  const feedback = JSON.parse(requests[2].contents.at(-1).parts[0].text);
  assert.deepEqual(feedback.validSelectedIds, diagnostic.offered.map(entry => entry.alias));
  assert.deepEqual(feedback.previousSelectedIds, ['A999']);
  const selections = result.telemetry.bounded.calls.filter(row => row.stage === 'selection');
  assert.deepEqual(selections.map(row => [row.status, row.retry]), [['failed', false], ['success', true]]);
  assert.ok(selections.every(row => row.accountedUsd > 0), 'both completed model responses are charged');
  assert.notEqual(selections[0].requestSha256, selections[1].requestSha256);
  assert.equal(result.telemetry.estimatedCostUsd.toFixed(12),
    result.telemetry.bounded.calls.reduce((sum, row) => sum + row.accountedUsd, 0).toFixed(12));
  assert.equal(result.telemetry.bounded.calls.filter(row => row.stage === 'planned_query_embedding').length, 1);
  assert.equal(Object.hasOwn(result.telemetry.bounded, 'unknownIds'), false);
});

test('selection retries share the same two attempts across identity, JSON and HTTP errors', async () => {
  for (const sequence of [['http', 'identity'], ['identity', 'http'], ['identity', 'json']]) {
    let attempts = 0;
    const { provider, requests } = fixture({ select: () => {
      const fault = sequence[attempts++];
      if (fault === 'http') return Response.json({}, { status: 503 });
      return fault === 'json' ? {} : { selectedIds: ['A999'], unableToSelect: false, note: '' };
    } });
    await assert.rejects(provider.retrieve(input));
    assert.equal(attempts, 2, sequence.join(' -> '));
    assert.equal(requests.length, 3);
  }
});

test('B.AI Luna reselects from the same input and accepts only the second complete selection', async () => {
  let attempts = 0;
  let expected;
  const events = [];
  const { provider, requests } = fixture({ onEvent: event => events.push(event), select: delivered => {
    const ids = delivered.groups.flatMap(group => (group.units || []).map(row => row[0]));
    expected = ids.at(-1);
    return { selectedIds: ++attempts === 1 ? [ids[0], 'Q999'] : [expected], unableToSelect: false, note: '' };
  } });
  const result = await provider.retrieve({ ...input, env: { ...unrestrictedEvidenceEnv, BAI_API_KEY: 'fixture',
    EVIDENCE_SELECTION_PROFILE: 'bai-gpt-5.6-luna-high-theoretical' } });
  assert.equal(attempts, 2);
  assert.deepEqual(requests[2].input.slice(0, requests[1].input.length), requests[1].input);
  assert.deepEqual(result.telemetry.bounded.selectedIds, [expected]);
  const failure = events.find(event => event.type === 'selection_identity_failure');
  assert.equal(failure.responseId, 'fixture-response');
  assert.equal(failure.model, 'gpt-5.6-luna');
  assert.equal(failure.reasoningEffort, 'high');
  assert.deepEqual(failure.unknownIds, ['Q999']);
  assert.equal(JSON.stringify(result).includes('Q999'), false);
});

test('an unknown alias after an output-contract retry cannot start a third selection', async () => {
  let attempts = 0;
  const { provider, requests } = fixture({ select: () => ++attempts === 1 ? {}
    : { selectedIds: ['A999'], unableToSelect: false, note: '' } });
  await assert.rejects(provider.retrieve(input), /gemini_bounded_selected_identity_not_offered/u);
  assert.equal(attempts, 2);
  assert.equal(requests.length, 3);
});

test('unknown selection aliases still fail after one correction and stay out of public diagnostics', async () => {
  const events = [];
  const { provider, requests } = fixture({ onEvent: event => events.push(event),
    select: { selectedIds: ['A999'], unableToSelect: false, note: '' } });
  await assert.rejects(provider.retrieve(input), error => {
    assert.equal(error.code, 'gemini_bounded_selected_identity_not_offered');
    assert.equal(JSON.stringify(error.boundedRetrieval).includes('A999'), false);
    return true;
  });
  assert.equal(requests.length, 3);
  const failures = events.filter(event => event.type === 'selection_identity_failure');
  assert.deepEqual(failures.map(event => [event.attempt, event.retryAvailable]), [[1, true], [2, false]]);
});

test('identity feedback exceeding model capacity stops without reducing candidates or a second send', async () => {
  const { provider, requests } = fixture({ countTokens: body => body.generateContentRequest?.contents.length > 1 ? 2000000 : 500,
    select: { selectedIds: ['A999'], unableToSelect: false, note: '' } });
  await assert.rejects(provider.retrieve(input), /capacity_exceeded/u);
  assert.equal(requests.length, 2);
});

test('private arbitrary unknown text never enters the actual HTTP error projection', async () => {
  const marker = 'private fixture text\nunknown identifier';
  const { provider, requests } = fixture({ select: { selectedIds: [marker], unableToSelect: false, note: '' } });
  await assert.rejects(provider.retrieve(input), error => {
    const payload = JSON.stringify(publicAnswerHttpError(error));
    assert.equal(payload.includes('private fixture text'), false);
    assert.equal(payload.includes('unknownIds'), false);
    return true;
  });
  assert.equal(requests.length, 3);
});

test('reselection retains the final package limit and cannot trigger a third selection', async () => {
  let attempts = 0;
  const { provider, requests } = fixture({ assets: schema3Assets([rule], [{ ...qa, answer: 'complete fixture body '.repeat(900) }]),
    select: delivered => ({ selectedIds: ++attempts === 1 ? ['Q999']
      : delivered.groups.flatMap(group => group.items || []).map(item => item.handle), unableToSelect: false, note: '' }) });
  await assert.rejects(provider.retrieve({ ...input, env: { ...unrestrictedEvidenceEnv,
    GEMINI_EVIDENCE_READING_TARGET_CHARS: '100000' } }), /pack_capacity_exceeded/u);
  assert.equal(requests.length, 3);
});

test('identity correction respects remaining budget and cancellation without resending the selection', async () => {
  for (const stop of ['budget', 'abort']) {
    const controller = new AbortController();
    let selectionReturned = false;
    const { provider, requests } = fixture({
      remainingBudget: async () => stop === 'budget' && selectionReturned ? 0 : 100,
      select: () => {
        selectionReturned = true;
        if (stop === 'abort') controller.abort(new Error('fixture_abort'));
        return { selectedIds: ['A999'], unableToSelect: false, note: '' };
      },
    });
    await assert.rejects(provider.retrieve({ ...input, signal: controller.signal }),
      stop === 'budget' ? /evidence_request_budget_exceeded/u : /fixture_abort/u);
    assert.equal(requests.length, 2);
  }
});

test('an unavailable private diagnostic sink does not prevent a valid correction', async () => {
  let attempts = 0;
  const { provider } = fixture({ onEvent: async event => {
    if (event.type === 'selection_identity_failure') throw new Error('fixture_log_unavailable');
  }, select: delivered => ({ selectedIds: ++attempts === 1 ? ['A999']
    : [delivered.groups.flatMap(group => group.units || [])[0][0]], unableToSelect: false, note: '' }) });
  await provider.retrieve(input);
  assert.equal(attempts, 2);
});

test("counted planning input over the generation contract stops before generation", async () => {
  const { provider, requests } = fixture({ countTokens: 1_046_529 });
  await assert.rejects(provider.retrieve(input), /provider_shared_context_capacity_exceeded/u);
  assert.equal(requests.length, 0);
});

test("native FAQ units retain complete source excerpts and all units map to their parent handle", async () => {
  const faq = { id: "faq-parent", recordType: "card-faq", title: "fixture FAQ",
    cards: [], cardIds: [], conclusion: "first complete branch\n\nsecond complete branch", official: true };
  const assets = schema3Assets([rule], [faq]);
  const units = assets.structureMapping.qaUnits;
  assert.equal(units.length, 2);
  assert.equal(new Set(units.map(unit => unit.parentHandle)).size, 1);
  assert.equal(units.map(unit => unit.item.record.conclusion).join(""), faq.conclusion);
  assert.ok(units.every(unit => unit.item.record.sourceExcerpt.bodyField === "conclusion"));
  const { provider, requests } = fixture({ assets });
  await provider.retrieve({ ...input, userQuery: "fixture FAQ", retrievedEvidence: {},
    cardResolution: { resolvedCards: [] } });
  const delivered = JSON.parse(requests[1].contents[0].parts[1].text);
  assert.ok(delivered.groups.some(group => group.items?.some(item => item.record.sourceExcerpt)));
});

test("confirmed-card FAQ delivery offers every source-ordered fragment as one reading bundle", async () => {
  const conclusion = Array.from({ length: 40 }, (_, index) => `完整FAQ片段 ${index + 1}`).join("\n\n");
  const faq = { id: "faq-confirmed-7", recordType: "card-faq", title: "fixture FAQ",
    cards: [], cardIds: ["7"], conclusion, official: true };
  const assets = schema3Assets([rule], [faq]);
  const expectedFragments = assets.structureMapping.qaUnits
    .filter(unit => unit.item.record.id.startsWith("faq-confirmed-7-"));
  assert.equal(expectedFragments.length, 40);
  const { provider, requests } = fixture({ assets, select: delivered => ({
    selectedIds: [delivered.groups.flatMap(group => group.items || [])[0].handle],
    unableToSelect: false, note: "",
  }) });
  const resolved = { resolvedCards: [{ id: "7" }], unresolvedMentions: [], ambiguousMentions: [] };
  const result = await provider.retrieve({ ...input, userQuery: "fixture FAQ", retrievedEvidence: {},
    env: { GEMINI_API_KEY: "fixture", GEMINI_EVIDENCE_READING_TARGET_CHARS: "128000" }, cardResolution: resolved });
  const delivered = JSON.parse(requests[1].contents[0].parts[1].text);
  const offered = delivered.groups.flatMap(group => group.items || [])
    .filter(item => item.record?.id?.startsWith("faq-confirmed-7-"));
  const decode = value => {
    if (value && !Array.isArray(value) && typeof value === 'object'
        && Object.keys(value).length === 1 && Array.isArray(value.$lines)) {
      return value.$lines.map(part => typeof part === 'number' ? delivered.qaTextLines[part] : part).join('\n');
    }
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
    return value;
  };
  const restored = offered.map(item => {
    const { qaSourceRef, ...record } = decode(item.record);
    const source = decode(delivered.qaSources[qaSourceRef]);
    return { ...source.record, ...record,
      sourceExcerpt: { ...source.sourceExcerpt, ...record.sourceExcerpt } };
  });
  assert.deepEqual(restored, JSON.parse(JSON.stringify(expectedFragments.map(unit => unit.item.record))));
  assert.equal(result.telemetry.bounded.selectedIds.length, 1);
  assert.equal(result.telemetry.bounded.reading.lanes[0].channel, "confirmed_card_faq");

  const { provider: unmatched } = fixture({ assets });
  const unmatchedResult = await unmatched.retrieve({ ...input, userQuery: "fixture FAQ", retrievedEvidence: {},
    env: { GEMINI_API_KEY: "fixture", GEMINI_EVIDENCE_READING_TARGET_CHARS: "128000" },
    cardResolution: { resolvedCards: [{ id: "unconfirmed-card" }], unresolvedMentions: [], ambiguousMentions: [] } });
  assert.equal(unmatchedResult.telemetry.bounded.reading.lanes.some(lane => lane.channel === "confirmed_card_faq"), false);
});

test("each confirmed card has an independent lane for source-declared QA links", async () => {
  const records = [
    ...Array.from({ length: 40 }, (_, index) => ({ ...qa, id: `qa-a-${String(index).padStart(2, '0')}`,
      title: `fixture A ${index}`, question: `fixture A ${index}`, answer: `complete fixture answer ${index}`,
      cardIds: ['card-a'] })),
    { ...qa, id: 'qa-z-linked-b', title: 'z', question: 'z', answer: 'z', cardIds: ['card-b'], official: false,
      sourceAuthority: 'community_reference' },
  ];
  const assets = schema3Assets([rule], records);
  const createTools = assets.createQaTools;
  assets.createQaTools = options => ({ ...createTools(options), *searchBounded() {} });
  assets.navigationSearch = { searchBySourceKind: () => ({ rule: [], qa: [], faq: [] }) };
  const { provider, requests } = fixture({ assets, denseQa: [], select: () => ({
    selectedIds: [], unableToSelect: false, note: '',
  }) });
  const result = await provider.retrieve({ ...input,
    cardResolution: { resolvedCards: [{ id: 'card-a' }, { id: 'card-b' }], unresolvedMentions: [], ambiguousMentions: [] },
  });
  const delivered = JSON.parse(requests[1].contents[0].parts[1].text);
  const linked = delivered.groups.flatMap(group => group.items || []).find(item => item.record.id === 'qa-z-linked-b');
  assert.ok(linked);
  assert.equal(linked.record.official, false);
  assert.equal(linked.record.sourceAuthority, 'community_reference');
  assert.deepEqual(linked.record, records.at(-1));
});

 test("configured evidence transport deadline can exceed the 30 second target", async () => {
  const { provider, requests } = fixture();
  const result = await provider.retrieve({ ...input, elapsedBeforeRetrievalMs: 30001,
    env: { ...input.env, GEMINI_EVIDENCE_DEADLINE_MS: "60000" } });
  assert.equal(requests.length, 2);
  assert.equal(result.telemetry.bounded.deadlineMs, 60000);
  assert.ok(result.packing.prompt.length > 0);
 });
