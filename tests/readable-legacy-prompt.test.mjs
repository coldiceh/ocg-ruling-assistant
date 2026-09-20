import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRagRulingPromptBundle } from '../backend/ragRulingPrompt.mjs';
import { displayedPayload } from './helpers/readable-prompt.mjs';
import { createGeminiRuleQaEvidenceProvider } from '../backend/geminiRuleQaEvidenceProvider.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';

test('general prompt and its trace display real newlines and quotes from the canonical body', () => {
  const text = '原文第一行\n第二行包含 "引号" 和路径 C:\\tierra\\qliphoth.exe';
  const events = [];
  const bundle = buildRagRulingPromptBundle({ userQuery: '问题第一行\n问题第二行',
    cardResolution: { resolvedCards: [] },
    evidence: { rawRelatedEvidence: [{ id: 'readable-rule', recordType: 'rule-doc',
      title: '来源', text, sourceAuthority: 'community_reference' }] },
    lineageTraceSink: event => events.push(event),
  });
  assert.ok(bundle.prompt.includes(text));
  assert.ok(bundle.prompt.includes('问题第一行\n问题第二行'));
  assert.equal(bundle.promptChars, bundle.prompt.length);
  assert.deepEqual(bundle.allowedEvidenceIds, ['readable-rule']);
  const visible = events.find(event => event.type === 'PROMPT_VISIBLE');
  assert.equal(visible.returnedItems[0].text, text);
  assert.equal(displayedPayload(bundle).evidence.rawRelatedEvidence[0].text, text);
});

test('compact rendering measures readable complete entries and binds the visible IDs', () => {
  const records = Array.from({ length: 12 }, (_, index) => ({
    id: `record-${index}`, recordType: 'rule-doc', sourceAuthority: 'community_reference',
    title: '来源', text: `段落${index}\n` + '完整原文'.repeat(120),
  }));
  const bundle = buildRagRulingPromptBundle({ userQuery: '问题\n下一行',
    evidence: { rawRelatedEvidence: records }, env: { RAG_MAX_PROMPT_CHARS: 4000 } });
  const payload = displayedPayload(bundle);
  const selected = Array.isArray(payload.evidence) ? payload.evidence : Object.values(payload.evidence).flat();
  assert.ok(bundle.promptChars <= 4000);
  assert.ok(selected.length > 0 && selected.length < records.length);
  assert.deepEqual(bundle.allowedEvidenceIds, selected.map(item => item.id));
  for (const item of selected) assert.equal(item.text, records.find(record => record.id === item.id).text);
});

test('direct QA rendering displays its source fields without JSON escapes', () => {
  const question = '公开问题\n条件', answer = '答复 "原话"\n后续处理';
  const bundle = buildRagRulingPromptBundle({ userQuery: question,
    cardResolution: { resolvedCards: [{ id: 'card', name: '公开卡片' }] },
    evidence: { officialQaDirectCandidates: [{ id: 'direct', recordType: 'qa', type: 'official_qa',
      official: true, sourceAuthority: 'official_database', question, answer,
      isDirect: true, matchLevel: 'official_qa_exact', authoritativeSceneMatch: true,
      authoritativeSceneMatchReason: 'raw_or_normalized_query', questionCardIdCoverage: 1,
      questionCardIdCount: 1, matchedQuestionCardIds: ['card'] }] } });
  assert.equal(bundle.authoritativeOfficialDirectId, 'direct');
  assert.equal(displayedPayload(bundle).officialQaDirectCandidate.answer, answer);
  assert.ok(bundle.prompt.includes(question));
  assert.ok(bundle.prompt.includes(answer));
});

test('cache provider presents readable initial and paged QA and retains real continuation cursors', async () => {
  const records = Array.from({ length: 5 }, (_, index) => ({ id: `qa-${index}`, recordType: 'qa',
    cardIds: ['1'], question: `完整问题${index}\n第二行`, answer: '完整答复 "引号"\n第二行',
    sourceAuthority: 'official_database', official: true }));
  const qaTools = createQaTools({ records, qaRevision: 'revision', cardIds: ['1'], pageSize: 4 });
  const firstPage = qaTools.search({ queries: ['原题'] });
  let calls = 0;
  const provider = createGeminiRuleQaEvidenceProvider({
    loadAssets: async () => ({ dataRevision: 'd', rulesRecords: [], createQaTools: () => qaTools }),
    clientFactory: () => ({ model: 'fixture', getCache: async () => ({ reused: true }),
      generate: async (_cache, contents) => {
        calls++;
        if (calls === 1) {
          const text = contents[0].parts[0].text;
          assert.ok(text.includes(firstPage.nextCursor));
          assert.ok(text.includes(firstPage.items[0].record.question));
          assert.equal(text.includes('unitKey:'), false);
          return { candidates: [{ content: { role: 'model', parts: [{ functionCall: {
            name: 'search_qa', id: 'page-two', args: { queries: ['原题'], cursor: firstPage.nextCursor },
          }, thoughtSignature: 'signature' }] } }] };
        }
        const response = contents[2].parts[0].functionResponse;
        assert.equal(response.id, 'page-two');
        assert.equal(contents[1].parts[0].thoughtSignature, 'signature');
        const secondPage = qaTools.search({ queries: ['原题'], cursor: firstPage.nextCursor });
        assert.ok(response.response.text.includes(secondPage.items[0].record.question));
        assert.ok(response.response.text.includes('hasMore: false'));
        return { candidates: [{ content: { parts: [{ functionCall: { name: 'submit_evidence',
          args: { ruleUnitIds: [], qaHandles: [secondPage.items[0].handle] } } }] } }] };
      } }),
  });
  const result = await provider.retrieve({ userQuery: '原题', cardResolution: { resolvedCards: [] },
    retrievedEvidence: {}, dataRevision: 'd' });
  assert.equal(calls, 2);
  const payload = displayedPayload(result.packing);
  const selected = payload.evidence.rawRelatedEvidence[0];
  assert.equal(result.packing.modelEvidence.rawRelatedEvidence[0].text, JSON.stringify(selected.sourceRecord));
  assert.deepEqual(result.packing.allowedEvidenceIds, [selected.id]);
});
