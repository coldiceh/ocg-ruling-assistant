import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiRuleQaEvidenceProvider } from '../backend/geminiRuleQaEvidenceProvider.mjs';
import { createGeminiRuleCacheClient } from '../backend/geminiRuleCacheClient.mjs';
import { buildRuleContext } from '../backend/geminiRuleContext.mjs';

// Claim: selected canonical strings, authority, card input and native tool parts
// survive the actual provider pack. Subject: production provider, not a copy.
// Decision: any byte/identity/protocol mismatch requires a fix before live use.
// These fixtures make no claim about evidence relevance or sufficiency.
test('provider preserves whole selected records and native supplement signatures', async () => {
  const record = { id: 'fixture-qa', recordType: 'qa', question: 'scene\nconditions',
    conclusion: 'complete answer\nsecond branch', rawDetailedQuestion: 'details', official: false };
  const rulesRecords = [{ id: 'fixture-rules', recordType: 'rule-doc', title: 'test', text: 'paragraph one\n\nparagraph two\n' }];
  const modelPart = { role: 'model', parts: [{ functionCall: { name: 'search_qa', args: { queries: ['extra'] }, id: 'native-1' }, thoughtSignature: 'opaque-signature' }] };
  let rounds = 0, searched = 0;
  const provider = createGeminiRuleQaEvidenceProvider({
    loadAssets: async () => ({ dataRevision: 'revision', rulesRecords,
      createQaTools: () => ({ qaRevision: 'qa-version', search: () => { searched++; return { items: [{ handle: 'h', record }] }; },
        readSelected: ids => { assert.deepEqual(ids, ['h']); return [{ handle: 'h', record }]; } }) }),
    clientFactory: () => ({ model: 'gemini-3.8-flash', getCache: async () => ({ reused: true }),
      generate: async (_cache, contents) => {
        rounds++;
        if (rounds === 1) return { candidates: [{ content: modelPart }] };
        assert.deepEqual(contents[1], modelPart);
        assert.equal(contents[2].parts[0].functionResponse.id, 'native-1');
        return {
          candidates: [{
            content: {
              role: 'model',
              parts: [{
                functionCall: {
                  name: 'submit_evidence',
                  args: { ruleUnitIds: ['fixture-rules:R1.1', 'R1.1'], qaHandles: ['h', 'h'] },
                },
              }],
            },
          }],
        };
      } }),
  });
  const result = await provider.retrieve({ userQuery: 'test query', cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    retrievedEvidence: {}, dataRevision: 'revision' });
  assert.equal(rounds, 2); assert.equal(searched, 2);
  const bodies = result.packing.modelEvidence.rawRelatedEvidence;
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].text, 'paragraph one\n\n');
  assert.equal(bodies[0].sourceAuthority, 'community_reference');
  assert.equal(bodies[0].official, false);
  assert.equal(bodies[1].text, JSON.stringify(record));
  assert.equal(bodies[1].official, false);
  assert.deepEqual(result.packing.allowedEvidenceIds, ['R1.1', 'h']);
  const payload = JSON.parse(result.packing.prompt.split('本次用户问题、卡片原文与检索资料如下：\n')[1]);
  assert.deepEqual(payload.evidence.rawRelatedEvidence, JSON.parse(JSON.stringify(bodies)));
});

test('provider gives a third QA search result one final submit-only call', async () => {
  const record = { id: 'third-result', recordType: 'qa', title: 'third result', text: 'whole record' };
  const rulesRecords = [{ id: 'fixture-rules', recordType: 'rule-doc', title: 'test', text: 'rule body' }];
  let generateCalls = 0;
  const provider = createGeminiRuleQaEvidenceProvider({
    loadAssets: async () => ({ dataRevision: 'revision', rulesRecords,
      createQaTools: () => ({ qaRevision: 'qa-version',
        search: ({ queries }) => ({ items: [{ handle: queries[0], record }] }),
        readSelected: (handles) => handles.map((handle) => ({ handle, record })),
      }) }),
    clientFactory: () => ({ model: 'gemini-3.8-flash', getCache: async () => ({ reused: true }),
      generate: async (_cache, contents) => {
        generateCalls += 1;
        if (generateCalls <= 3) return { candidates: [{ content: { role: 'model', parts: [{
          functionCall: { name: 'search_qa', id: `search-${generateCalls}`, args: { queries: [`result-${generateCalls}`] } },
        }] } }] };
        assert.equal(generateCalls, 4);
        const thirdResponse = contents.find((content) => content?.parts?.[0]?.functionResponse?.id === 'search-3');
        assert.deepEqual(thirdResponse.parts[0].functionResponse.response.items[0].handle, 'result-3');
        assert.match(contents.at(-1).parts[0].text, /补查结束/u);
        return { candidates: [{ content: { role: 'model', parts: [{
          functionCall: { name: 'submit_evidence', args: { ruleUnitIds: [], qaHandles: ['result-3'] } },
        }] } }] };
      },
    }),
  });

  const result = await provider.retrieve({ userQuery: 'test query', cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    retrievedEvidence: {}, dataRevision: 'revision' });
  assert.equal(generateCalls, 4);
  assert.deepEqual(result.packing.allowedEvidenceIds, ['result-3']);
});

test('provider does not execute a fourth-round QA search instead of submission', async () => {
  let generateCalls = 0;
  let searches = 0;
  const provider = createGeminiRuleQaEvidenceProvider({
    loadAssets: async () => ({ dataRevision: 'revision', rulesRecords: [],
      createQaTools: () => ({ qaRevision: 'qa-version',
        search: () => { searches += 1; return { items: [] }; },
        readSelected: () => [],
      }) }),
    clientFactory: () => ({ model: 'gemini-3.8-flash', getCache: async () => ({ reused: true }),
      generate: async () => {
        generateCalls += 1;
        return { candidates: [{ content: { role: 'model', parts: [{
          functionCall: { name: 'search_qa', args: { queries: [`query-${generateCalls}`] } },
        }] } }] };
      },
    }),
  });

  await assert.rejects(provider.retrieve({ userQuery: 'test query', cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    retrievedEvidence: {}, dataRevision: 'revision' }), /gemini_rule_qa_final_submission_required/u);
  assert.equal(generateCalls, 4);
  assert.equal(searches, 4);
});

test('provider ignores a fourth-round QA search when the same response submits evidence', async () => {
  const record = { id: 'submitted-result', recordType: 'qa', title: 'submitted result', text: 'whole record' };
  let generateCalls = 0;
  let searches = 0;
  const provider = createGeminiRuleQaEvidenceProvider({
    loadAssets: async () => ({ dataRevision: 'revision', rulesRecords: [],
      createQaTools: () => ({ qaRevision: 'qa-version',
        search: () => { searches += 1; return { items: [] }; },
        readSelected: (handles) => handles.map((handle) => ({ handle, record })),
      }) }),
    clientFactory: () => ({ model: 'gemini-3.8-flash', getCache: async () => ({ reused: true }),
      generate: async () => {
        generateCalls += 1;
        if (generateCalls <= 3) return { candidates: [{ content: { role: 'model', parts: [{
          functionCall: { name: 'search_qa', args: { queries: [`query-${generateCalls}`] } },
        }] } }] };
        return { candidates: [{ content: { role: 'model', parts: [{
          functionCall: { name: 'search_qa', args: { queries: ['ignored-final-search'] } },
        }, {
          functionCall: { name: 'submit_evidence', args: { ruleUnitIds: [], qaHandles: ['submitted'] } },
        }] } }] };
      },
    }),
  });

  const result = await provider.retrieve({ userQuery: 'test query', cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] },
    retrievedEvidence: {}, dataRevision: 'revision' });
  assert.equal(generateCalls, 4);
  assert.equal(searches, 4);
  assert.deepEqual(result.packing.allowedEvidenceIds, ['submitted']);
});

test('cache uses a fixed short TTL and reuses rule identity without QA identity', async () => {
  const rules = buildRuleContext([{ id: 'r', recordType: 'rule-doc', text: 'canonical full rules' }]);
  const requests = [];
  const client = createGeminiRuleCacheClient({ env: { GEMINI_RULE_QA_API_KEY: 'unit-test-cache-key' },
    budgetedRequest: ({ invoke }) => invoke(), fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return Response.json({ name: 'cachedContents/test', expireTime: new Date(Date.now() + 180000).toISOString(), usageMetadata: { totalTokenCount: 100 } });
    } });
  const first = await client.getCache(rules), second = await client.getCache(rules);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.ttl, '180s');
  assert.equal(first.name, second.name); assert.equal(second.reused, true);
  assert.equal(Object.hasOwn(requests[0].body, 'qaRevision'), false);
});
