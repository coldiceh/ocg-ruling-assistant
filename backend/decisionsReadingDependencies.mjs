import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DECISIONS_SOURCE_RELATIONS } from './decisionsSourceRelations.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

export function expandDependencies(dependencies, ids) {
  return [...new Set(ids.flatMap(id => {
    assert(dependencies.has(id), 'unknown_dependency_alias');
    return dependencies.get(id);
  }))];
}

/**
 * Resolve existing source-only declarations against canonical source records.
 * Invariant: every applied relation has the same source hash, atom identity,
 * UTF-16 range and exact text hash as its declaration. These are mechanical
 * observations; stale bindings fail explicitly instead of changing meaning.
 * The resolver can be called before reading admission so required atoms travel
 * with their source. It adds no undeclared textual or adjacency relation.
 */
export function createDecisionsSourceResolver({ sourceAtoms, records, relations = DECISIONS_SOURCE_RELATIONS }) {
  const bySource = new Map(records.map(record => [record.id, record]));
  const atomsByRange = new Map([...sourceAtoms].map(([id, atom]) => [
    JSON.stringify([atom.parentSourceId, atom.sourceStart, atom.sourceEnd]), { id, atom },
  ]));
  const bound = relation => {
    const find = end => end.id ? { id: end.id, atom: sourceAtoms.get(end.id) }
      : atomsByRange.get(JSON.stringify([relation.sourceId, ...end.range]));
    return { relation, left: find(relation.left), right: find(relation.right) };
  };
  const bindings = relations.map(bound);
  const validated = new Set();
  const check = binding => {
    if (validated.has(binding)) return;
    const { relation, left, right } = binding;
    const record = bySource.get(relation.sourceId);
    assert(record, 'dependency_source_absent');
    assert.equal(sha(record.text), relation.canonicalSha256, 'dependency_source_changed');
    for (const [entry, declaration] of [[left, relation.left], [right, relation.right]]) {
      assert(entry?.atom, 'required_dependency_body_absent');
      assert.equal(entry.atom.parentSourceId, relation.sourceId, 'dependency_source_identity_changed');
      assert.deepEqual([entry.atom.sourceStart, entry.atom.sourceEnd], declaration.range, 'dependency_range_changed');
      assert.equal(sha(entry.atom.text), declaration.textSha256, 'dependency_candidate_body_changed');
      assert.equal(record.text.slice(...declaration.range), entry.atom.text, 'dependency_canonical_body_changed');
    }
    validated.add(binding);
  };
  const coread = id => {
    const edge = bindings.find(binding => binding.relation.phase === 'coread'
      && (binding.left?.id === id || binding.right?.id === id));
    if (!edge) return [id];
    check(edge);
    return [edge.left.id, edge.right.id];
  };
  const legacy = id => {
    const list = coread(id), seen = new Set(list);
    for (let i = 0; i < list.length; i++) {
      for (const edge of bindings.filter(binding => binding.relation.phase === 'ancestor' && binding.left?.id === list[i])) {
        check(edge);
        if (!seen.has(edge.right.id)) { seen.add(edge.right.id); list.push(edge.right.id); }
      }
    }
    return list;
  };
  const cache = new Map();
  const resolveOne = id => {
    assert(sourceAtoms.has(id), 'dependency_atom_absent');
    if (cache.has(id)) return cache.get(id);
    const list = legacy(id), seen = new Set(list);
    for (let i = 0; i < list.length; i++) {
      const member = list[i];
      const next = legacy(member);
      for (const edge of bindings.filter(binding => binding.relation.phase === 'required' && binding.left?.id === member)) {
        check(edge); next.push(edge.right.id);
      }
      for (const target of next) if (!seen.has(target)) { seen.add(target); list.push(target); }
    }
    cache.set(id, list);
    return list;
  };
  return ids => [...new Set(ids.flatMap(resolveOne))];
}

/** Map the already admitted aliases to the exact declared dependency closure. */
export function createDecisionsReadingDependencies({ entries, records, sourceAtoms, relations }) {
  const atoms = sourceAtoms || new Map([...entries.values()].filter(entry => entry.kind === 'rule')
    .map(entry => [entry.id, entry.body]));
  const resolve = createDecisionsSourceResolver({ sourceAtoms: atoms, records, relations });
  const aliases = new Map([...entries].map(([alias, entry]) => [entry.id, alias]));
  assert.equal(aliases.size, entries.size, 'ambiguous_canonical_identity');
  const dependencies = new Map();
  for (const [alias, entry] of entries) {
    const ids = entry.kind === 'rule' ? resolve([entry.id]) : [entry.id];
    dependencies.set(alias, ids.map(id => {
      assert(aliases.has(id), 'required_dependency_body_absent');
      return aliases.get(id);
    }));
  }
  return { dependencies };
}

// Deleting a root may keep its body through another retained root's closure.
export function removalProposal(members, alias, pack) {
  const current = pack(members), after = members.filter(id => id !== alias), remaining = pack(after);
  const removedIds = current.canonicalIds.filter(id => !remaining.canonicalIds.includes(id));
  const removed = current.packing.modelEvidence.rawRelatedEvidence.filter(row => removedIds.includes(row.id));
  const beforeBodies = new Map(current.packing.modelEvidence.rawRelatedEvidence.map(row => [row.id, row]));
  for (const row of remaining.packing.modelEvidence.rawRelatedEvidence) {
    assert.deepEqual(row, beforeBodies.get(row.id), 'cleanup_changed_retained_body');
  }
  return { after, remaining, removedIds, removed, noBodyLoss: removedIds.length === 0 };
}
