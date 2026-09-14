import { createHash } from 'node:crypto';

import {
  buildManualCaptureCompleteLexicalQueryQueue,
} from '../scripts/lib/manual-capture-evidence-selection.mjs';

// The shared lexical helper requires an opaque 64-hex binding for its own
// mechanical corpus fingerprint. Rule unit identity remains the canonical
// `unit.id`; this deterministic adapter binding is only an internal index key.
const compiledRules = new WeakMap();

function stableIndexBinding(unitId) {
  return createHash('sha256').update(`gemini-rule-unit\0${unitId}`, 'utf8').digest('hex');
}

function requireRules(rules) {
  if (!rules || typeof rules !== 'object' || !(rules.units instanceof Map)) {
    throw new TypeError('gemini_rule_candidate_rules_invalid');
  }
  if (!(rules.sections instanceof Map) || !(rules.unitSections instanceof Map)) {
    throw new TypeError('gemini_rule_candidate_structure_invalid');
  }
  return rules;
}

function retrievalText(unit) {
  if (!unit || typeof unit !== 'object' || typeof unit.text !== 'string') {
    throw new TypeError('gemini_rule_candidate_unit_text_invalid');
  }
  const titlePath = unit.sourceSection?.titlePath;
  if (!Array.isArray(titlePath)) return unit.text;
  const titles = titlePath.map((title) => String(title ?? ''));
  return titles.length ? `${titles.join(' / ')}\n${unit.text}` : unit.text;
}

function compileRules(rules) {
  requireRules(rules);
  const cached = compiledRules.get(rules);
  if (cached) return cached;

  const units = [...rules.units.values()];
  const unitsById = new Map();
  const candidatesByBinding = new Map();
  const candidates = units.map((unit) => {
    const id = String(unit?.id ?? '').trim();
    if (!id || unitsById.has(id)) throw new Error('gemini_rule_candidate_unit_identity_invalid');
    unitsById.set(id, unit);
    const binding = stableIndexBinding(id);
    const candidate = Object.freeze({ binding, text: retrievalText(unit), unitId: id });
    candidatesByBinding.set(binding, candidate);
    return candidate;
  });
  if (!candidates.length) throw new Error('gemini_rule_candidate_units_empty');

  // The helper caches its prepared corpus by this immutable candidate array;
  // keeping the same frozen array makes repeated queries reuse one index.
  const compiled = Object.freeze({
    candidates: Object.freeze(candidates),
    candidatesByBinding,
    unitsById,
  });
  compiledRules.set(rules, compiled);
  return compiled;
}

function normalizeQueries(queries) {
  const input = Array.isArray(queries) ? queries : [queries];
  const normalized = [];
  const seen = new Set();
  for (const value of input) {
    const query = String(value ?? '').trim();
    if (!query || seen.has(query)) continue;
    seen.add(query);
    normalized.push(query);
  }
  if (!normalized.length) throw new TypeError('gemini_rule_candidate_queries_invalid');
  return normalized;
}

function roundRobinUnitQueues(queues) {
  const positions = queues.map(() => 0);
  const seen = new Set();
  const ordered = [];
  while (true) {
    let advanced = false;
    for (let queueIndex = 0; queueIndex < queues.length; queueIndex += 1) {
      const unit = queues[queueIndex][positions[queueIndex]];
      if (!unit) continue;
      positions[queueIndex] += 1;
      advanced = true;
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      ordered.push(unit);
    }
    if (!advanced) break;
  }
  return Object.freeze(ordered);
}

function sectionForUnit(rules, unit) {
  const mapped = rules.unitSections.get(unit.id);
  const sectionId = mapped || unit.sourceSection?.sectionId || null;
  if (!sectionId) return null;
  return rules.sections.get(sectionId) || null;
}

function sectionDescriptor(section) {
  return {
    sectionId: section.sectionId,
    title: section.title,
    parentSectionId: section.parentSectionId ?? null,
    ruleDocumentId: section.ruleDocumentId,
  };
}

function readParentGroupsForRules(rules, inputUnits) {
  const compiled = compileRules(rules);
  if (!Array.isArray(inputUnits)) throw new TypeError('gemini_rule_candidate_units_input_invalid');

  const groups = [];
  const groupsByIdentity = new Map();
  const seenUnits = new Set();
  for (const input of inputUnits) {
    const id = String(input?.id ?? '').trim();
    if (!id || seenUnits.has(id)) continue;
    const unit = compiled.unitsById.get(id);
    if (!unit) throw new Error('gemini_rule_candidate_unit_identity_invalid');
    seenUnits.add(id);

    const section = sectionForUnit(rules, unit);
    if (!section) {
      groups.push(Object.freeze({ groupId: id, section: null, units: Object.freeze([unit]) }));
      continue;
    }

    const groupIdentity = `${String(section.ruleDocumentId ?? '')}\0${String(section.sectionId)}`;
    if (groupsByIdentity.has(groupIdentity)) continue;
    const memberIds = Array.isArray(section.ruleUnitIds) ? section.ruleUnitIds : [];
    const members = memberIds.map((memberId) => {
      const member = compiled.unitsById.get(memberId);
      if (!member) throw new Error('gemini_rule_candidate_section_unit_identity_invalid');
      return member;
    });
    if (!members.some((member) => member.id === id)) {
      throw new Error('gemini_rule_candidate_section_membership_invalid');
    }
    const group = Object.freeze({
      groupId: section.sectionId,
      section: Object.freeze(sectionDescriptor(section)),
      units: Object.freeze(members),
    });
    groupsByIdentity.set(groupIdentity, group);
    groups.push(group);
  }
  return Object.freeze(groups);
}

export function readParentGroups(rules, units) {
  return readParentGroupsForRules(requireRules(rules), units);
}

export function createRuleCandidateSearch(rules) {
  requireRules(rules);
  const compiled = compileRules(rules);

  function search(queries) {
    const normalizedQueries = normalizeQueries(queries);
    const queues = normalizedQueries.map((query) => {
      const ranked = buildManualCaptureCompleteLexicalQueryQueue({
        query,
        candidates: compiled.candidates,
      });
      return ranked.map((candidate) => {
        const indexed = compiled.candidatesByBinding.get(candidate.binding);
        if (!indexed) throw new Error('gemini_rule_candidate_binding_invalid');
        const unit = compiled.unitsById.get(indexed.unitId);
        if (!unit) throw new Error('gemini_rule_candidate_unit_identity_invalid');
        return unit;
      });
    });
    return roundRobinUnitQueues(queues);
  }

  return Object.freeze({
    search,
    readParentGroups: (units) => readParentGroupsForRules(rules, units),
  });
}

