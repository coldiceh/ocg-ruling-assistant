// Scripted responses prove production control flow and mechanical delivery only.
// They do not evaluate relevance, sufficiency or ruling correctness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDecisionsSelectionFlow, executeSelectionFlow } from '../backend/decisionsSelectionFlow.mjs';
import { createDecisionsSourceResolver, createDecisionsReadingDependencies, removalProposal } from '../backend/decisionsReadingDependencies.mjs';
import { compact, expand } from '../backend/decisionsExactTextCodec.mjs';
import { projectQaForDisplay, restoreQaFromDisplay } from '../backend/decisionsEvidenceDisplay.mjs';
import { packGeminiSelection } from '../backend/geminiRuleQaPacking.mjs';
import { compactSelectionRequest } from '../backend/decisionsCompactRequest.mjs';

const payload = request => JSON.parse(request.input.split('\n').at(-1));
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture({ count = 8, maxPromptChars = 15000, dependencies } = {}) {
  const entries = new Map(Array.from({ length: count }, (_, index) => {
    const id = `source:atom:${index}`, alias = `A${index + 1}`;
    const body = { id, recordType: 'rule-doc', title: 'Synthetic source', sourceUrl: 'https://example.invalid/source',
      parentSourceId: 'source', source: 'Synthetic source', official: false,
      sourceSection: { title: 'Synthetic section', titlePath: ['Synthetic source', 'Synthetic section'] },
      text: `Body ${index}\n` + String(index).repeat(index === count - 1 ? 2000 : 300) };
    return [alias, { id, alias, kind: 'rule', body }];
  }));
  const input = { question: 'Synthetic question', ruleRevision: 'rules-1', qaRevision: 'qa-1', queryPlan: {},
    groups: [{ groupId: 'synthetic', kind: 'rule', units: [...entries].map(([alias, entry]) => ({ ...entry.body, id: alias })) }] };
  const options = { entries, input, dependencies: dependencies || new Map([...entries.keys()].map(id => [id, [id]])),
    cardResolution: { resolvedCards: [], unresolvedMentions: [], ambiguousMentions: [] }, retrievedEvidence: {}, maxPromptChars };
  return { options, flow: createDecisionsSelectionFlow(options) };
}

test('production pack keeps bodies and source identity with exact display encoding', () => {
  const { flow, options } = fixture();
  const selected = flow.pack(['A1', 'A2']);
  assert.deepEqual(selected.packing.modelEvidence.rawRelatedEvidence, selected.selection.selectedRules);
  assert.equal(selected.packing.promptTruncated, false);
  assert.equal(selected.packing.promptChars, selected.prompt.length);
  const literal = packGeminiSelection({ ...options, userQuery: options.input.question,
    selection: selected.selection, compactDisplay: false });
  const defaultDisplay = packGeminiSelection({ ...options, userQuery: options.input.question, selection: selected.selection });
  assert.deepEqual(literal, defaultDisplay, 'existing Luna display remains unchanged');
  assert.deepEqual(literal.evidence, selected.evidence);
  const underLimit = createDecisionsSelectionFlow({ ...options, maxPromptChars: selected.length - 1 }).pack(['A1', 'A2']);
  assert.equal(underLimit.prompt, selected.prompt, 'capacity never slices an entry');
  assert.equal(underLimit.capacityExceeded, true);
});

test('full JSON QA records including unfamiliar fields round-trip exactly', () => {
  const repeated = 'Preserve this complete line with trailing space. '.repeat(15);
  const record = { id: 'qa-source', recordType: 'qa', question: repeated, answer: repeated,
    fullText: `${repeated}\n${repeated}`, unknownField: { authority: false, text: repeated },
    literalKeys: { $s: 3, $l: [2] } };
  assert.deepEqual(expand(compact(record, { protectKeys: [] })), record);
  const projection = projectQaForDisplay(record);
  assert.equal(projection.format, 'exact-strings-lines-v1');
  assert.deepEqual(restoreQaFromDisplay(projection), record);
  assert.throws(() => expand({ codec: 'exact-strings-lines-v1', refs: { string: '$s', lines: '$l' }, strings: [], value: { $s: 0 } }), /Invalid string reference/);
});

test('live optional undefined fields match their exact JSON request representation', () => {
  const body = { id: 'source:atom:1', text: 'Complete canonical text.\n', source: undefined, sourceUrl: undefined,
    metadata: { optional: undefined, explicitNull: null, official: false } };
  const entries = new Map([['A1', { id: body.id, kind: 'rule', body }]]);
  const input = { groups: [{ groupId: 'source', kind: 'rule', units: [{ ...body, id: 'A1' }] }] };
  const data = { candidates: [{ id: 'A1', body }], contextSources: [] };
  const request = { input: 'Quoted source data.\n' + JSON.stringify(data), questions: [] };
  const result = payload(compactSelectionRequest(request, { entries, input }));
  assert.deepEqual(result.sourcePool.groups[0].units[0], JSON.parse(JSON.stringify({ ...body, id: 'A1' })));
  assert.equal(result.sourcePool.groups[0].units[0].text, body.text);
  assert(Object.hasOwn(body, 'sourceUrl'), 'original live object is not mutated');
  const corrupted = { ...data, candidates: [{ id: 'A1', body: { ...body, text: body.text + 'changed' } }] };
  assert.throws(() => compactSelectionRequest({ ...request, input: 'Quoted source data.\n' + JSON.stringify(corrupted) },
    { entries, input }), /source_body_binding_changed/);
});

test('NONE does not certify completion and final status sees only actual retained package', async () => {
  const { flow } = fixture();
  const stages = [];
  const result = await executeSelectionFlow(flow, { ask: async (stage, request) => {
    stages.push(stage);
    if (stage === 'select-1') return { next_source: 'NONE' };
    assert.deepEqual(Object.keys(payload(request)), ['actualPackage', 'actualPackageChars', 'maxPromptChars']);
    assert.deepEqual(payload(request).actualPackage, flow.pack([]).packing.promptPayload);
    return { current_status: 'NEEDS_EVIDENCE' };
  } });
  assert.deepEqual(stages, ['select-1', 'final-status']);
  assert.equal(result.status, 'model_reports_incomplete');
  assert.equal(result.acquisitionStop, 'model_reports_no_addition');
});

test('eighth addition runs serial cleanup and then status on the retained package', async () => {
  const { flow } = fixture();
  let lastPack, statusPack;
  const stages = [];
  const result = await executeSelectionFlow(flow, { ask: async (stage, request) => {
    stages.push(stage);
    if (stage.startsWith('select-')) return { next_source: `A${stage.slice(7)}` };
    if (stage.startsWith('clean-')) return { action: stage === 'clean-A1' ? 'DROP' : 'KEEP' };
    statusPack = payload(request).actualPackage;
    return { current_status: 'UNKNOWN' };
  }, onState: (_state, pack) => { lastPack = pack; } });
  assert.equal(stages.filter(stage => stage.startsWith('select-')).length, 8);
  assert.equal(stages.at(-1), 'final-status');
  assert(!result.selectedIds.includes('A1'));
  assert.deepEqual(statusPack, lastPack.packing.promptPayload);
  assert.equal(result.status, 'unverified');
});

test('capacity replacement is one complete feasible package; failure keeps old package', async () => {
  const { flow, options } = fixture();
  const maxPromptChars = Math.max(flow.pack(['A1', 'A2']).length, flow.pack(['A8']).length);
  const bounded = createDecisionsSelectionFlow({ ...options, maxPromptChars });
  assert(bounded.pack(['A1', 'A2', 'A8']).length > maxPromptChars);
  for (const accept of [true, false]) {
    const result = await executeSelectionFlow(bounded, { ask: async (stage, request) => {
      if (stage.startsWith('select-')) return { next_source: ['A1', 'A2', 'A8', 'NONE'][Number(stage.slice(7)) - 1] };
      if (stage.startsWith('replace-')) {
        const alternatives = payload(request).alternatives;
        assert(alternatives.every(item => item.packageChars <= maxPromptChars));
        return { replacement: accept ? alternatives.find(item => item.selectedIds.join() === 'A8').value : 'NO_SAFE_REPLACEMENT' };
      }
      if (stage.startsWith('clean-')) return { action: 'UNKNOWN' };
      return { current_status: 'NEEDS_EVIDENCE' };
    }, onState: (_state, pack) => assert(pack.length <= maxPromptChars) });
    assert.deepEqual(result.selectedIds, accept ? ['A8'] : ['A1', 'A2']);
  }
});

test('request failure preserves last observed state and never records completion', async () => {
  const { flow } = fixture();
  let observed;
  await assert.rejects(executeSelectionFlow(flow, { ask: async stage => {
    if (stage === 'select-1') return { next_source: 'A1' };
    if (stage === 'select-2') return { next_source: 'NONE' };
    throw new Error('aborted');
  }, onState: state => { observed = state; } }), /aborted/);
  assert.equal(observed.finalStatus, null);
  assert.deepEqual(observed.selectedIds, ['A1']);
  assert.equal(observed.acquisitionStop, 'model_reports_no_addition');
});

test('declared source dependencies compose, bind exact text, and retain context until final root removal', () => {
  const texts = ['alpha', 'beta', 'gamma', 'delta'];
  const record = { id: 'source', text: texts.join('') };
  let offset = 0;
  const atoms = texts.map((text, index) => {
    const atom = { id: `source:atom:${index}`, parentSourceId: 'source', text, sourceStart: offset, sourceEnd: offset + text.length };
    offset += text.length; return atom;
  });
  const endpoint = index => ({ id: atoms[index].id, range: [atoms[index].sourceStart, atoms[index].sourceEnd], textSha256: hash(texts[index]) });
  const relation = (left, right, phase) => ({ type: phase === 'coread' ? 'coread' : 'required', phase, sourceId: record.id,
    canonicalSha256: hash(record.text), left: endpoint(left), right: endpoint(right) });
  const relations = [relation(0, 1, 'coread'), relation(1, 2, 'ancestor'), relation(2, 3, 'required')];
  const sourceAtoms = new Map(atoms.map(atom => [atom.id, atom]));
  const entries = new Map(atoms.map((atom, index) => [`A${index + 1}`, { id: atom.id, kind: 'rule', body: atom }]));
  const options = { records: [record], sourceAtoms, relations };
  const resolve = createDecisionsSourceResolver(options);
  assert.deepEqual(resolve([atoms[1].id]), atoms.map(atom => atom.id));
  assert.deepEqual(resolve([atoms[3].id]), [atoms[3].id]);
  const { dependencies } = createDecisionsReadingDependencies({ ...options, entries });
  assert.deepEqual(dependencies.get('A2'), ['A1', 'A2', 'A3', 'A4']);
  const { flow } = fixture({ count: 4, dependencies });
  assert.equal(removalProposal(['A2', 'A4'], 'A4', flow.pack).noBodyLoss, true);
  const stale = createDecisionsSourceResolver({ ...options, records: [{ ...record, text: record.text + 'changed' }] });
  assert.throws(() => stale([atoms[0].id]), /dependency_source_changed/);
  assert.throws(() => createDecisionsReadingDependencies({ ...options, entries: new Map([...entries].slice(0, 3)) }), /required_dependency_body_absent/);
});
