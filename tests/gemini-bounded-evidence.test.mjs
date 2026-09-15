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
      const delivered = JSON.parse(body.contents[0].parts[1].text);
      const output = requests.length === 1
        ? (plan || { needs: [{ id: "source-id", question: "fixture relation",
          ruleQuery: "fixture rule search", qaQuery: "fixture qa search" }] })
        : (typeof select === "function" ? select(delivered) : select || { selectedIds: delivered.groups.flatMap(group => [
          ...(group.units || []).map(row => row[0]), ...(group.items || []).map(item => item.handle),
        ]).slice(0, 2), unableToSelect: false, note: "" });
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
  const finalPayload = JSON.parse(result.packing.prompt.split(marker)[1]);
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
