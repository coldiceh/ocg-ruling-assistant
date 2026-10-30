// Offline fixture for the bounded evidence provider with the official Luna
// channel. All model and embedding traffic goes to the fetchImpl below.
import { createHash } from 'node:crypto';

import { createGeminiBoundedEvidenceProvider } from '../../backend/geminiBoundedEvidenceProvider.mjs';
import { buildRuleStructureMapping, makeQaSourceUnits, stableJson } from '../../backend/evidenceSourceStructure.mjs';
import { createFocusedQaView } from '../../backend/geminiFocusedQaView.mjs';
import { createQaTools } from '../../backend/geminiQaTools.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export const fixtureRuleRecords = Object.freeze([
  { id: 'rule-doc-a', recordType: 'rule-doc', title: 'fixture rule A', sourceAuthority: 'community_reference',
    official: false, text: 'alpha general rule paragraph one\n\nalpha general rule paragraph two\n\nalpha exception paragraph three' },
  { id: 'rule-doc-b', recordType: 'rule-doc', title: 'fixture rule B', sourceAuthority: 'official_reference',
    official: true, text: 'beta timing paragraph one\n\nbeta timing paragraph two' },
]);
export const fixtureQaRecords = Object.freeze([
  { id: 'qa-1', recordType: 'qa', title: 'fixture QA one', question: 'fixture question one about alpha',
    answer: 'fixture answer one', official: true },
  { id: 'qa-2', recordType: 'qa', title: 'fixture QA two', question: 'fixture question two about beta',
    answer: 'fixture answer two', official: true },
]);

export function ruleTocAssets({ extraRuleRecords = [] } = {}) {
  const ruleRecords = [...fixtureRuleRecords, ...extraRuleRecords].map(record => ({ ...record }));
  const qaRecords = fixtureQaRecords.map(record => ({ ...record }));
  const qaRevision = sha256(stableJson(qaRecords));
  const parentTools = createQaTools({ records: qaRecords, qaRevision });
  const focused = createFocusedQaView({ qaRevision, items: parentTools.readSelected(parentTools.snapshotHandles) });
  const focusedByHandle = new Map(focused.items.map(item => [item.handle, item]));
  const qaUnits = makeQaSourceUnits(focused.items).map(unit => ({ ...unit, item: focusedByHandle.get(unit.handle) }));
  const { structureMappingRevision: _old, ...mappingBody } = buildRuleStructureMapping(ruleRecords, { targetChars: 40 });
  const structureMapping = { ...mappingBody, qaUnits };
  structureMapping.structureMappingRevision = sha256(stableJson(structureMapping));
  const ruleUnits = structureMapping.sources.flatMap(source => source.readingUnits);
  const navigationRecords = [
    ...ruleUnits.map((unit, index) => ({ unitKey: unit.unitKey, sourceId: unit.sourceId,
      canonicalBodySha256: unit.sourceCanonicalSha256, titlePath: unit.titlePath || [],
      descriptionZh: `fixture navigation description ${index + 1}`, descriptionJa: '', searchQuestions: [],
      navigationStatus: 'generated', contextRefs: [], explicitRefs: [] })),
    ...qaUnits.map(unit => ({ unitKey: unit.unitKey, sourceId: unit.sourceId, sourceKind: unit.sourceKind,
      canonicalBodySha256: unit.canonicalBodySha256, titlePath: [], descriptionZh: '', descriptionJa: '',
      searchQuestions: [], navigationStatus: 'not_generated_in_scope', contextRefs: [], explicitRefs: [] })),
  ];
  return { schemaVersion: 3, manifest: { schemaVersion: 3 }, dataRevision: 'd', bundleRevision: 'b', qaRevision,
    ruleContentRevision: sha256(stableJson(ruleRecords)), navigationRevision: 'n',
    structureMappingRevision: structureMapping.structureMappingRevision, ruleDenseRevision: 'rd', qaDenseRevision: 'qd',
    rulesRecords: ruleRecords, structureMapping, navigationRecords,
    navigationRecordsByUnit: new Map(navigationRecords.map(record => [record.unitKey, record])),
    createQaTools: options => createQaTools({ records: qaRecords, qaRevision, ...options }), ruleUnits };
}

export const fixtureEnv = Object.freeze({ GEMINI_API_KEY: 'fixture-gemini',
  EVIDENCE_PLANNING_PROFILE: 'gemini-3.8-flash-medium-planning-room-theoretical',
  EVIDENCE_SELECTION_PROFILE: 'bai-gpt-6-luna-high-theoretical', EVIDENCE_SELECTOR: 'luna',
  RAG_EVIDENCE_LUNA_CHANNEL: 'official', RAG_EVIDENCE_OPENAI_API_KEY: 'fixture-official',
  EVIDENCE_GENERATION_OUTPUT_LIMIT: 'provider', GEMINI_EVIDENCE_DEADLINE_MS: '0', GEMINI_EVIDENCE_MAX_CNY: '0',
  GEMINI_EVIDENCE_MAX_PROMPT_CHARS: '15000', GEMINI_EVIDENCE_READING_TARGET_CHARS: '5000' });

export const fixtureQuestion = 'fixture question about alpha and beta timing';
export const fixturePlan = Object.freeze({ needs: [{ id: 'n1', question: 'alpha relation',
  ruleQuery: 'alpha general rule', qaQuery: 'fixture question one' }] });

// The first user message is the original request; a format retry appends another.
const userText = body => body.input.find(message => message.role === 'user').content;

// toc(lines, body, init): returns the ToC model output object, a Response, or throws.
// select(delivered, body): returns the selection output object or a Response.
export function ruleTocProvider({ assets = ruleTocAssets(), toc, select, onEvent, plan = fixturePlan,
  tocUsage = { input_tokens: 9000, output_tokens: 150, total_tokens: 9150,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 100 } } } = {}) {
  const calls = [];
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => assets,
    loadDenseSearch: async ({ rules }) => ({ searchAsync: async () => [...rules.units.values()] }),
    loadQaSearch: async ({ items }) => ({ searchAsync: async () => items }),
    remainingBudget: async () => Infinity,
    budgetedRequest: request => request.invoke(),
    ...(onEvent ? { onEvent } : {}),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith(':embedContent')) {
        return Response.json({ embedding: { values: Array(768).fill(1) }, usageMetadata: { promptTokenCount: 10 } });
      }
      if (String(url).endsWith(':batchEmbedContents')) {
        return Response.json({ embeddings: body.requests.map(() => ({ values: Array(768).fill(1) })),
          usageMetadata: { promptTokenCount: 10 } });
      }
      if (String(url).endsWith(':generateContent')) {
        calls.push({ kind: 'plan', url: String(url), body });
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] } }],
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 600 } });
      }
      const text = userText(body);
      const last = JSON.parse(text.split('\n').at(-1));
      if (!Array.isArray(last.groups)) {
        calls.push({ kind: 'toc', url: String(url), body });
        const lines = text.split('\n').filter(line => /^\d+\t/u.test(line));
        if (typeof toc !== 'function') throw new Error('unexpected ToC request');
        const output = await toc(lines, body, init);
        if (output instanceof Response) return output;
        return Response.json({ id: 'toc-fixture', model: 'gpt-6-luna-2026-10-01', status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text',
            text: typeof output === 'string' ? output : JSON.stringify(output) }] }], usage: tocUsage });
      }
      calls.push({ kind: 'selection', url: String(url), body });
      const output = typeof select === 'function' ? select(last, body) : { selectedIds: last.groups.flatMap(group => [
        ...(group.units || []).map(row => row[0]), ...(group.items || []).map(item => item.handle)]).slice(0, 2), note: '' };
      if (output instanceof Response) return output;
      return Response.json({ id: 'selection-fixture', model: 'gpt-6-luna', status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
        usage: { input_tokens: 4000, output_tokens: 300, total_tokens: 4300, input_tokens_details: { cached_tokens: 0 } } });
    },
  });
  return { provider, calls, assets };
}

export function fixtureRetrieveInput(assets, env = fixtureEnv) {
  return { userQuery: fixtureQuestion, dataRevision: assets.dataRevision, env, assetsPromise: Promise.resolve(assets),
    cardResolution: { resolvedCards: [{ id: 'card-1', cnName: '测试卡甲', jaName: 'テストカード甲' }],
      unresolvedMentions: [], ambiguousMentions: [] },
    retrievedEvidence: { cardTexts: [{ id: 'card-1', text: 'fixture card text' }], userProvidedCardTexts: [] } };
}
