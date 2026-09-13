import { buildRagRulingPromptBundle } from './ragRulingPrompt.mjs';

function references(value, name) {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) throw new Error(`gemini_${name}_references_invalid`);
  return [...new Set(list.map(item => item.trim()).filter(Boolean))];
}

export function resolveGeminiSelection({ args, rules, qaTools }) {
  const selectedRules = [], seen = new Set();
  for (const ref of references(args?.ruleUnitIds, 'rule')) {
    let unit = rules.units.get(ref);
    if (!unit) {
      // Documented equivalent wrappers resolve only by exact identity, never text similarity.
      const matches = [...rules.units.values()].filter(item =>
        `${item.parentSourceId}:${item.id}` === ref || `${item.parentSourceId}#${item.id}` === ref);
      if (matches.length !== 1) throw new Error('gemini_rule_reference_binding_invalid');
      [unit] = matches;
    }
    if (!seen.has(unit.id)) { seen.add(unit.id); selectedRules.push(unit); }
  }
  const qaHandles = references(args?.qaHandles, 'qa');
  return { selectedRules, selectedQa: qaTools.readSelected(qaHandles), qaHandles,
    ruleUnitIds: selectedRules.map(item => item.id), ruleRevision: rules.ruleRevision, qaRevision: qaTools.qaRevision };
}

export function packGeminiSelection({ selection, userQuery, cardResolution, retrievedEvidence = {}, maxPromptChars = 36000 }) {
  const selectedBodies = [...selection.selectedRules, ...selection.selectedQa.map(({ handle, record }) => ({
    id: handle, recordType: record.recordType, title: record.title,
    source: record.sourceName || '', sourceUrl: record.sourceUrl || '',
    ...Object.fromEntries(['sourceAuthority', 'sourceTier', 'official']
      .filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]])),
    text: JSON.stringify(record),
  }))];
  const baseEvidence = { userProvidedCardTexts: retrievedEvidence.userProvidedCardTexts || [],
    cardTexts: retrievedEvidence.cardTexts || [] };
  const base = buildRagRulingPromptBundle({ userQuery, cardResolution, evidence: baseEvidence,
    env: { RAG_MAX_PROMPT_CHARS: '100000000', RAG_MAX_CARDS: Math.max(1, cardResolution.resolvedCards.length) } });
  const marker = '本次用户问题、卡片原文与检索资料如下：\n';
  const at = base.prompt.indexOf(marker);
  if (at < 0) throw new Error('gemini_published_prompt_envelope_absent');
  const payload = JSON.parse(base.prompt.slice(at + marker.length));
  payload.evidence.rawRelatedEvidence = selectedBodies;
  payload.allowedEvidenceIds = [...new Set([
    ...(base.allowedEvidenceIds || []), ...selectedBodies.map(item => item.id),
  ])];
  const prompt = base.prompt.slice(0, at + marker.length) + JSON.stringify(payload);
  const packing = { ...base, prompt, promptChars: prompt.length, promptTruncated: false,
    modelEvidence: payload.evidence, allowedEvidenceIds: payload.allowedEvidenceIds,
    selectedEntryChars: selectedBodies.map(item => ({ id: item.id, chars: item.text.length })),
    capacityExceeded: prompt.length > maxPromptChars };
  return { packing, evidence: { ...payload.evidence, cardResolution } };
}
