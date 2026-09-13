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
