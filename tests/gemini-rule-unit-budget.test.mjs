import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createGeminiBoundedEvidenceProvider } from '../backend/geminiBoundedEvidenceProvider.mjs';
import { createQaTools } from '../backend/geminiQaTools.mjs';

const paragraph = (letter) => `${letter.repeat(3_500)}\n\n`;
const ruleText = `${['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(paragraph).join('')}${'H'.repeat(3_500)}`;
const ruleRecord = {
  id: 'large-rule-document', recordType: 'rule-doc', title: '大章', text: ruleText,
  sourceName: 'official rules', sourceAuthority: 'official_reference', official: true,
  structure: { schemaVersion: 1, canonicalSha256: createHash('sha256').update(ruleText).digest('hex'),
    sections: [{ id: 'large-section', title: '大章小节', start: 0, end: ruleText.length }] },
};
const qaRecords = [
  { id: 'qa-first', recordType: 'qa', title: '第一条QA', question: '先读的QA', answer: '短回答', official: true },
  { id: 'qa-second', recordType: 'qa', title: '第二条完整QA', question: '必须保留的QA',
    answer: `完整回答${'Q'.repeat(4_000)}`, official: true },
];

function qaToolsFactory(options = {}) {
  const tools = createQaTools({ records: qaRecords, qaRevision: 'q', ...options });
  const items = tools.readSelected(tools.snapshotHandles);
  return { ...tools, search: () => ({ items, handles: items.map(item => item.handle),
    cursor: null, nextCursor: null, hasMore: false, total: items.length }) };
}

test('large rule section is budgeted by complete canonical units so the second QA remains readable', async () => {
  const requests = [];
  let countCalls = 0;
  const provider = createGeminiBoundedEvidenceProvider({
    loadAssets: async () => ({ dataRevision: 'd', qaRevision: 'q', rulesRecords: [ruleRecord],
      createQaTools: qaToolsFactory }),
    loadDenseSearch: async () => ({ search: () => [] }),
    loadQaSearch: async () => ({ search: () => [] }),
    budgetedRequest: request => request.invoke(),
    fetchImpl: async (url, init) => {
      if (url.endsWith(':embedContent')) return Response.json({ embedding: { values: Array(768).fill(1) },
        usageMetadata: { promptTokenCount: 10 } });
      if (url.endsWith(':batchEmbedContents')) {
        const count = JSON.parse(init.body).requests.length;
        return Response.json({ embeddings: Array.from({ length: count }, () => ({ values: Array(768).fill(1) })),
          usageMetadata: { promptTokenCount: 10 } });
      }
      if (url.endsWith(':countTokens')) {
        countCalls += 1;
        return Response.json({ totalTokens: [22_792, 15_851, 2_500, 9_000][countCalls - 1] || 9_000 });
      }
      requests.push(JSON.parse(init.body));
      const payload = JSON.parse(requests.at(-1).contents[0].parts[1].text);
      const output = requests.length === 1
        ? { informationNeeds: ['读取大章与QA'], queries: ['必须保留的QA'],
          ruleSectionIds: [payload.ruleSections.find(row => row[2] === '大章小节')[0]], qaCandidateIds: ['Q1', 'Q2'] }
        : { selectionNotes: '', ruleUnitIds: [], qaHandles: [] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 510 } });
    },
  });
  const result = await provider.retrieve({ userQuery: '必须保留的QA', cardResolution: { resolvedCards: [] },
    retrievedEvidence: {}, dataRevision: 'd', env: { GEMINI_API_KEY: 'fixture' } });

  const selection = JSON.parse(requests[1].contents[0].parts[1].text);
  const qaItems = selection.groups.flatMap(group => group.items || []);
  const secondQa = qaItems.find(item => item.record?.id === 'qa-second');
  assert.ok(secondQa, 'the second complete QA must remain in the reading input');
  assert.equal(secondQa.record.answer, qaRecords[1].answer);
  const ruleItems = selection.groups.flatMap(group => group.units || []);
  assert.ok(ruleItems.length >= 2, 'the large section must be admitted as multiple rule units');
  const byId = new Map(ruleItems.map(row => [row[0], row[1]]));
  assert.equal(byId.get('R1.1'), `${paragraph('A')}`);
  assert.equal(byId.get('R1.2'), `${paragraph('B')}`);
  assert.ok([...byId].every(([id, text]) => {
    const index = Number(id.slice(3)) - 1;
    return text === ruleText.split(/(?<=\n\n)/u)[index] || (id === 'R1.8' && text === 'H'.repeat(3_500));
  }));
});
