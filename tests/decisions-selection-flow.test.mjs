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

test('the last selected source is not offered for cleanup and stays in the package', async () => {
  const { flow } = fixture();
  const stages = [];
  const result = await executeSelectionFlow(flow, { ask: async (stage) => {
    stages.push(stage);
    if (stage === 'select-1') return { next_source: 'A1' };
    if (stage === 'select-2') return { next_source: 'NONE' };
    if (stage.startsWith('clean-')) return { action: 'DROP' };
    return { current_status: 'NEEDS_EVIDENCE' };
  } });
  // 2026-10-12 规则变更: an UNKNOWN nomination now triggers the interim status
  // check, so this cleanup case stops acquisition with NONE instead.
  assert.deepEqual(stages, ['select-1', 'select-2', 'final-status']);
  assert.deepEqual(result.selectedIds, ['A1']);
  assert.deepEqual(result.events.at(-1), { stage: 'clean', alias: 'A1', answer: 'LAST_SOURCE_KEPT' });
});

test('cleanup still removes sources while another selected source remains', async () => {
  const { flow } = fixture();
  const stages = [];
  const result = await executeSelectionFlow(flow, { ask: async (stage) => {
    stages.push(stage);
    if (stage === 'select-1') return { next_source: 'A1' };
    if (stage === 'select-2') return { next_source: 'A2' };
    if (stage === 'select-3') return { next_source: 'NONE' };
    if (stage.startsWith('clean-')) return { action: 'DROP' };
    return { current_status: 'UNKNOWN' };
  } });
  assert.equal(stages.filter(stage => stage.startsWith('clean-')).length, 1);
  assert.equal(result.selectedIds.length, 1);
  assert.equal(result.events.at(-1).answer, 'LAST_SOURCE_KEPT');
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

test('an UNKNOWN stop resumes acquisition once when the interim status reports NEEDS_EVIDENCE', async () => {
  const { flow } = fixture();
  const stages = [], requests = new Map();
  const result = await executeSelectionFlow(flow, { cleanup: false, ask: async (stage, request) => {
    stages.push(stage); requests.set(stage, request);
    if (stage === 'select-1') return { next_source: 'A1' };
    if (stage === 'select-2') return { next_source: 'UNKNOWN' };
    if (stage === 'select-3') return { next_source: 'A2' };
    if (stage === 'select-4') return { next_source: 'NONE' };
    return { current_status: stage === 'interim-status' ? 'NEEDS_EVIDENCE' : 'COMPLETE' };
  } });
  assert.deepEqual(stages, ['select-1', 'select-2', 'interim-status', 'select-3', 'select-4', 'final-status']);
  assert.deepEqual(result.selectedIds, ['A1', 'A2']);
  assert.equal(result.finalStatus, 'COMPLETE');
  assert.equal(result.acquisitionStop, 'model_reports_no_addition');
  // The first acquisition is unchanged; only resumed requests carry the status.
  for (const stage of ['select-1', 'select-2']) {
    assert(!Object.hasOwn(payload(requests.get(stage)), 'independentPackageCheck'));
    assert.doesNotMatch(requests.get(stage).questions[0].instructions, /independentPackageCheck/u);
  }
  for (const stage of ['select-3', 'select-4']) {
    assert.equal(payload(requests.get(stage)).independentPackageCheck, 'NEEDS_EVIDENCE');
    assert.match(requests.get(stage).questions[0].instructions, /independentPackageCheck/u);
    assert(requests.get(stage).questions[0].choices.some(choice => choice.value === 'NONE'));
  }
  assert.deepEqual(Object.keys(payload(requests.get('interim-status'))), ['actualPackage', 'actualPackageChars', 'maxPromptChars']);
  assert.deepEqual(result.events.filter(event => event.stage === 'status' || event.stage === 'resume'),
    [{ stage: 'status', label: 'interim', answer: 'NEEDS_EVIDENCE' }, { stage: 'resume', reason: 'interim_status_needs_evidence' }]);
});

test('without NEEDS_EVIDENCE the interim status is the final status and no request repeats', async () => {
  for (const status of ['COMPLETE', 'UNKNOWN']) {
    const { flow } = fixture();
    const stages = [];
    const result = await executeSelectionFlow(flow, { cleanup: false, ask: async (stage) => {
      stages.push(stage);
      if (stage === 'select-1') return { next_source: 'A1' };
      if (stage === 'select-2') return { next_source: 'UNKNOWN' };
      return { current_status: status };
    } });
    assert.deepEqual(stages, ['select-1', 'select-2', 'interim-status']);
    assert.equal(result.finalStatus, status);
    assert.equal(result.acquisitionStop, 'uncertain_nomination');
  }
});

test('a resumed acquisition that adds nothing reuses the identical status answer', async () => {
  const { flow } = fixture();
  const stages = [];
  const result = await executeSelectionFlow(flow, { cleanup: false, ask: async (stage) => {
    stages.push(stage);
    if (stage === 'select-1') return { next_source: 'A1' };
    if (stage.startsWith('select-')) return { next_source: 'UNKNOWN' };
    return { current_status: 'NEEDS_EVIDENCE' };
  } });
  assert.deepEqual(stages, ['select-1', 'select-2', 'interim-status', 'select-3']);
  assert.equal(result.finalStatus, 'NEEDS_EVIDENCE');
  assert.equal(result.status, 'model_reports_incomplete');
});

test('resumed selection shares the step limit and a final-step UNKNOWN does not resume', async () => {
  for (const unknownAt of [3, 8]) {
    const { flow } = fixture({ count: 12 });
    const stages = [];
    await executeSelectionFlow(flow, { cleanup: false, ask: async (stage) => {
      stages.push(stage);
      if (stage.startsWith('select-')) {
        const index = Number(stage.slice(7));
        return { next_source: index === unknownAt ? 'UNKNOWN' : `A${index}` };
      }
      return { current_status: 'NEEDS_EVIDENCE' };
    } });
    const selects = stages.filter(stage => stage.startsWith('select-'));
    assert.equal(selects.length, 8);
    assert.equal(selects.at(-1), 'select-8');
    assert.equal(stages.includes('interim-status'), unknownAt < 8);
    assert.equal(stages.at(-1), 'final-status');
  }
});

function needFixture(needs) {
  const { options } = fixture();
  const input = { ...options.input, queryPlan: { needs } };
  return createDecisionsSelectionFlow({ ...options, input });
}
const twoNeeds = [{ id: 'n1', question: 'First relation?', ruleQuery: 'r1', qaQuery: 'q1' },
  { id: 'n2', question: 'Second relation?', ruleQuery: 'r2', qaQuery: 'q2' }];

test('need-directed acquisition nominates for the first need reported missing', async () => {
  const flow = needFixture(twoNeeds);
  const stages = [], requests = new Map();
  const coverage = [{ need_1: 'MISSING', need_2: 'MISSING' }, { need_1: 'COVERED', need_2: 'MISSING' }, { need_1: 'COVERED', need_2: 'COVERED' }];
  const result = await executeSelectionFlow(flow, { cleanup: false, needDirected: true, ask: async (stage, request) => {
    stages.push(stage); requests.set(stage, request);
    if (stage.startsWith('coverage-')) return coverage[Number(stage.slice(9)) - 1];
    if (stage === 'select-1') return { next_source: 'A1' };
    if (stage === 'select-2') return { next_source: 'A2' };
    return { current_status: 'COMPLETE' };
  } });
  assert.deepEqual(stages, ['coverage-1', 'select-1', 'coverage-2', 'select-2', 'coverage-3', 'final-status']);
  assert.deepEqual(result.selectedIds, ['A1', 'A2']);
  assert.equal(result.acquisitionStop, 'plan_needs_covered');
  const firstCoverage = requests.get('coverage-1');
  assert.deepEqual(firstCoverage.questions.map(question => question.name), ['need_1', 'need_2']);
  assert.deepEqual(Object.keys(payload(firstCoverage)), ['actualPackage', 'actualPackageChars', 'needs']);
  assert.deepEqual(payload(firstCoverage).needs, [{ id: 'n1', question: 'First relation?' }, { id: 'n2', question: 'Second relation?' }]);
  assert.deepEqual(payload(requests.get('select-1')).focusNeed, { id: 'n1', question: 'First relation?' });
  assert.deepEqual(payload(requests.get('select-2')).focusNeed, { id: 'n2', question: 'Second relation?' });
  assert.match(requests.get('select-2').questions[0].instructions, /focusNeed/u);
  assert.deepEqual(result.events.filter(event => event.stage === 'select').map(event => event.need), ['n1', 'n2']);
});

test('a need whose nomination returns NONE or UNKNOWN is not asked about again', async () => {
  for (const refusal of ['NONE', 'UNKNOWN']) {
    const flow = needFixture(twoNeeds);
    const stages = [], requests = new Map();
    const result = await executeSelectionFlow(flow, { cleanup: false, needDirected: true, ask: async (stage, request) => {
      stages.push(stage); requests.set(stage, request);
      if (stage === 'coverage-1') return { need_1: 'MISSING', need_2: 'UNKNOWN' };
      if (stage === 'coverage-2') return { need_1: 'MISSING' };
      if (stage === 'coverage-3') return { need_1: 'COVERED' };
      if (stage === 'select-1') return { next_source: refusal };
      if (stage === 'select-2') return { next_source: 'A3' };
      return { current_status: 'NEEDS_EVIDENCE' };
    } });
    assert.deepEqual(stages, ['coverage-1', 'select-1', 'coverage-2', 'select-2', 'coverage-3', 'final-status']);
    assert.deepEqual(payload(requests.get('select-1')).focusNeed.id, 'n1');
    assert.deepEqual(payload(requests.get('coverage-2')).needs.map(need => need.id), ['n2']);
    assert.deepEqual(payload(requests.get('select-2')).focusNeed.id, 'n2');
    assert.deepEqual(result.selectedIds, ['A3']);
    assert.equal(result.finalStatus, 'NEEDS_EVIDENCE');
  }
});

test('need-directed mode without plan needs, or switched off, uses the ordinary acquisition', async () => {
  for (const [needs, needDirected] of [[[], true], [twoNeeds, false]]) {
    const flow = needFixture(needs);
    const stages = [];
    await executeSelectionFlow(flow, { cleanup: false, needDirected, ask: async (stage) => {
      stages.push(stage);
      if (stage === 'select-1') return { next_source: 'A1' };
      if (stage === 'select-2') return { next_source: 'NONE' };
      return { current_status: 'COMPLETE' };
    } });
    assert.deepEqual(stages, ['select-1', 'select-2', 'final-status']);
  }
});

test('need-directed acquisition shares the eight-step limit', async () => {
  const stages = [];
  const { options } = fixture({ count: 12 });
  const wide = createDecisionsSelectionFlow({ ...options, input: { ...options.input, queryPlan: { needs: twoNeeds } } });
  await executeSelectionFlow(wide, { cleanup: false, needDirected: true, ask: async (stage) => {
    stages.push(stage);
    if (stage.startsWith('coverage-')) return { need_1: 'MISSING', need_2: 'MISSING' };
    if (stage.startsWith('select-')) return { next_source: `A${stage.slice(7)}` };
    return { current_status: 'NEEDS_EVIDENCE' };
  } });
  assert.equal(stages.filter(stage => stage.startsWith('select-')).length, 8);
  assert.equal(stages.filter(stage => stage.startsWith('coverage-')).length, 8);
  assert.equal(stages.at(-1), 'final-status');
});
