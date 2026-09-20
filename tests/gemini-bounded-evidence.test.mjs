import { renderReadableData, readableRuleUnit } from '../backend/readableEvidenceText.mjs';
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

// The fake model reads only emitted selector aliases from synthetic fixtures.
function fixtureView(text) {
  return { text, selection: /^queryPlan:/mu.test(text),
    ruleAliases: [...text.matchAll(/^id: (A\d+)$/gmu)].map(match => match[1]),
    qaAliases: [...text.matchAll(/^handle: (Q\d+)$/gmu)].map(match => match[1]),
    aliases: [...text.matchAll(/^(?:id|handle): ([AQ]\d+)$/gmu)].map(match => match[1]) };
}

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
    select: delivered => ({ selectedIds: delivered.qaAliases, unableToSelect: false, note: '' }) });
  await assert.rejects(provider.retrieve({ ...input, env: { ...unrestrictedEvidenceEnv,
    GEMINI_EVIDENCE_READING_TARGET_CHARS: '100000' } }), error => {
    assert.ok(error.boundedRetrieval.packingFailure.actualPromptChars > 15000);
    return true;
  });
});

function fixture({ assets = schema3Assets(), plan, select, countTokens = 500,
  denseRules, denseQa } = {}) {
  const requests = [];
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => assets,
    loadDenseSearch: async ({ rules }) => ({ searchAsync: async () => denseRules || [...rules.units.values()] }),
    loadQaSearch: async ({ items }) => ({ searchAsync: async () => denseQa || items }),
    budgetedRequest: request => request.invoke(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith(":countTokens")) return Response.json({ totalTokens: countTokens });
      if (url.endsWith(":embedContent")) return Response.json({ embedding: { values: Array(768).fill(1) },
        usageMetadata: { promptTokenCount: 100 } });
      if (url.endsWith(":batchEmbedContents")) return Response.json({
        embeddings: body.requests.map(() => ({ values: Array(768).fill(1) })),
        usageMetadata: { promptTokenCount: 100 } });
      requests.push(body);
      const delivered = fixtureView(body.contents[0].parts[1].text);
      const output = requests.length === 1
        ? (plan || { needs: [{ id: "source-id", question: "fixture relation",
          ruleQuery: "fixture rule search", qaQuery: "fixture qa search" }] })
        : (typeof select === "function" ? select(delivered) : select || { selectedIds: delivered.aliases.slice(0, 2), unableToSelect: false, note: "" });
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
  const delivered = fixtureView(body.contents[0].parts[1].text);
  assert.ok(delivered.text.includes("question: q\n"));
  assert.ok(delivered.text.includes(renderReadableData([{ id: "c", text: "full" }])));
  assert.equal(delivered.text.includes("ruleSections:"), false);
  assert.equal(delivered.text.includes("qaCandidates:"), false);
  assert.match(body.contents[0].parts[0].text, /"needs"/u);
});

test("selection-v2 exposes only offered aliases and preserves rule authority and table layout", () => {
  const unit = { id: "A1", text: "full table", ruleUnitIndex: 2, tableLayout: { rowCount: 1,
    columnCount: 1, cells: [{ row: 0, column: 0, tag: "td", rowSpan: 1, columnSpan: 1, start: 0, end: 10 }] },
    recordType: "rule-doc", title: "t", sourceAuthority: "official_reference", official: true,
    parentSourceId: "s", sourceSection: { titlePath: ["root", "leaf"] } };
  const body = boundedSelectionBody({ question: "q" }, { needs: [] },
    [{ groupId: "u", kind: "rule", units: [unit] }], { bundleRevision: "b" });
  const delivered = fixtureView(body.contents[0].parts[1].text);
  assert.deepEqual(delivered.ruleAliases, ['A1']);
  assert.ok(delivered.text.includes(renderReadableData(readableRuleUnit(unit))));
  assert.equal(delivered.text.includes('ruleUnitFields:'), false);
  assert.equal(delivered.text.includes('bundleRevision:'), false);
  assert.match(body.contents[0].parts[0].text, /selectedIds/u);
});

test("selection packing budget contains exact serialized costs for offered aliases only", async () => {
  const assets = schema3Assets();
  const { provider, requests } = fixture({ assets });
  await provider.retrieve(input);
  const delivered = fixtureView(requests[1].contents[0].parts[1].text);
  const rules = buildRuleContext(assets.rulesRecords, { ruleContentRevision: assets.ruleContentRevision,
    structureMapping: assets.structureMapping });
  const qaItems = assets.createQaTools().readSelected(assets.createQaTools().snapshotHandles);
  const budget = computeGeminiSelectionPackingBudget({ rules: [...rules.sourceAtoms.values()], qaItems,
    userQuery: input.userQuery, cardResolution: input.cardResolution, retrievedEvidence: input.retrievedEvidence });
  assert.ok(delivered.text.includes('limitChars: 14000\n'));
  assert.ok(delivered.text.includes('basePromptChars: ' + budget.basePromptChars + '\n'));
  assert.ok(delivered.text.includes('availableEvidenceChars: ' + budget.availableEvidenceChars + '\n'));
  const ruleCosts = {}, qaCosts = {};
  for (const alias of delivered.ruleAliases) {
    const canonical = [...rules.sourceAtoms.values()].find(atom =>
      delivered.text.includes(renderReadableData(readableRuleUnit({ ...atom, id: alias }))));
    assert.ok(canonical, 'alias is bound to an entire emitted canonical source');
    ruleCosts[alias] = budget.ruleUnitChars[canonical.id];
  }
  for (const alias of delivered.qaAliases) {
    const canonical = qaItems.find(item => delivered.text.includes(renderReadableData({ handle: alias, record: item.record })));
    assert.ok(canonical);
    qaCosts[alias] = budget.qaHandleChars[canonical.handle];
  }
  assert.ok(delivered.text.includes('ruleUnitChars: ' + renderReadableData(ruleCosts)));
  assert.ok(delivered.text.includes('qaHandleChars: ' + renderReadableData(qaCosts)));

});

test("oversized selected evidence preserves the actual prompt diagnostic without another model call", async () => {
  const oversizedQa = { ...qa, answer: "complete fixture body ".repeat(720) };
  const assets = schema3Assets([rule], [oversizedQa]);
  const { provider, requests } = fixture({ assets, select: delivered => ({
    selectedIds: [delivered.qaAliases[0]],
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
    const delivered = fixtureView(request.contents[0].parts[1].text);
    assert.ok(delivered.text.includes("question: " + input.userQuery + "\n"));
    for (const [key, value] of Object.entries({ ...input.retrievedEvidence, unresolvedMentions: input.cardResolution.unresolvedMentions })) {
      assert.ok(delivered.text.includes(key + ": " + renderReadableData(value)));
    }
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
    const delivered = fixtureView(request.contents[0].parts[1].text);
    assert.ok(delivered.text.includes("confirmedCards: " + renderReadableData([{ ...finalPayload.resolvedCards[0],
      input: card.input, matchedQuery: card.matchedQuery, cardId: card.cardId, cid: card.cid,
      passcode: card.passcode, cnName: card.cnName, jaName: card.jaName, enName: card.enName,
      sourceUrl: card.sourceUrl, sourceLabel: card.sourceLabel, official: card.official,
      sourceAuthority: card.sourceAuthority, relatedOnly: card.relatedOnly,
      linkRating: card.linkRating, linkArrows: card.linkArrows }])));
    assert.ok(delivered.text.includes("effectText: " + effectText));
    assert.ok(delivered.text.includes("pendulumEffectText: " + pendulumEffectText));
    assert.ok(delivered.text.includes("pendulumScale: 7"));
    assert.ok(delivered.text.includes("resolutionSource: card_text_reference"));
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
      const delivered = fixtureView(body.contents[0].parts[1].text);
      const output = delivered.selection ? { selectedIds: [], unableToSelect: false, note: "" }
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
  const delivered = fixtureView(requests[1].contents[0].parts[1].text);
  assert.ok(units.some(unit => delivered.text.includes("record: " + renderReadableData(unit.item.record))));
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
    selectedIds: [delivered.qaAliases[0]],
    unableToSelect: false, note: "",
  }) });
  const resolved = { resolvedCards: [{ id: "7" }], unresolvedMentions: [], ambiguousMentions: [] };
  const result = await provider.retrieve({ ...input, userQuery: "fixture FAQ", retrievedEvidence: {},
    env: { GEMINI_API_KEY: "fixture", GEMINI_EVIDENCE_READING_TARGET_CHARS: "128000" }, cardResolution: resolved });
  const delivered = fixtureView(requests[1].contents[0].parts[1].text);
  let position = 0;
  for (const fragment of expectedFragments) {
    const text = 'record: ' + renderReadableData(fragment.item.record);
    const at = delivered.text.indexOf(text, position);
    assert.ok(at >= position, 'every source-ordered FAQ fragment is emitted completely');
    position = at + text.length;
  }
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
  const delivered = fixtureView(requests[1].contents[0].parts[1].text);
  assert.ok(delivered.text.includes('record: ' + renderReadableData(records.at(-1))));

});

 test("configured evidence transport deadline can exceed the 30 second target", async () => {
  const { provider, requests } = fixture();
  const result = await provider.retrieve({ ...input, elapsedBeforeRetrievalMs: 30001,
    env: { ...input.env, GEMINI_EVIDENCE_DEADLINE_MS: "60000" } });
  assert.equal(requests.length, 2);
  assert.equal(result.telemetry.bounded.deadlineMs, 60000);
  assert.ok(result.packing.prompt.length > 0);
 });
