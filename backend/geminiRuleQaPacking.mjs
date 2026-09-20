import { renderReadableData, readableRuleUnit } from './readableEvidenceText.mjs';
import { buildRagRulingPromptBundle } from './ragRulingPrompt.mjs';

// Latest user limit for the complete prompt, in UTF-16 characters, including
// the question, cards, evidence, sources and envelope. This supersedes the
// earlier empirical calibration of 9448 * 1.5; it does not prove sufficiency.
export const GEMINI_EVIDENCE_MAX_PROMPT_CHARS = 14000;

const RULE_SOURCE_FIELDS = [
  'recordType', 'title', 'sourceUrl', 'source', 'sourceAuthority', 'official',
];
const RULE_SOURCE_INSTRUCTION = 'ruleSources 保存规则的共用来源字段；每段 sourceRef 对应 ruleSources 中同名条目，其来源字段均继承自该条目。结合来源等级阅读原文，引用使用对应来源的 title。';
function renderRuleSources(prefix, marker, payload, fields = RULE_SOURCE_FIELDS) {
  const original = prefix + marker + renderReadableData(payload);
  const ruleSources = {}, sourceRefs = new Map();
  const selectedBodies = payload.evidence.rawRelatedEvidence.map((item) => {
    if (item.recordType !== 'rule-doc') return item;
    const source = Object.fromEntries(fields
      .filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));
    // Only identical serialized source fields share an entry. Text, identity,
    // order and authority values are preserved without interpreting meaning.
    const sourceKey = JSON.stringify(source);
    let sourceRef = sourceRefs.get(sourceKey);
    if (!sourceRef) {
      sourceRef = `rs${sourceRefs.size + 1}`;
      sourceRefs.set(sourceKey, sourceRef);
      ruleSources[sourceRef] = source;
    }
    return {
      ...Object.fromEntries(Object.entries(item).filter(([key]) => !fields.includes(key))),
      sourceRef,
    };
  });
  // The copy is model-visible only. Server evidence retains full source fields
  // for citation links and the player's original-evidence display.
  const compactPayload = { ...payload, evidence: { ...payload.evidence, rawRelatedEvidence: selectedBodies }, ruleSources };
  const compactPrefix = prefix + RULE_SOURCE_INSTRUCTION + '\n';
  const compact = compactPrefix + marker + renderReadableData(compactPayload);
  const useRuleSources = sourceRefs.size && compact.length < original.length;
  return useRuleSources ? { prompt: compact, prefix: compactPrefix, payload: compactPayload }
    : { prompt: original, prefix, payload };
}

function renderSelectedPrompt(prefix, marker, payload) {
  return renderRuleSources(prefix, marker, payload);
}

function readableSelectedPayload(payload, selection) {
  const rows = payload.evidence.rawRelatedEvidence;
  const displayed = selection.selectedRules.map(readableRuleUnit);
  selection.selectedQa.forEach(({ record }, index) => {
    const { text: _canonicalJson, ...metadata } = rows[selection.selectedRules.length + index];
    displayed.push({ ...metadata, sourceRecord: record });
  });
  return { ...payload, evidence: { ...payload.evidence, rawRelatedEvidence: displayed } };
}

function selectedQaSourceUrl(record = {}) {
  const explicit = String(record.sourceUrl || '').trim();
  if (explicit) return explicit;
  const sourceDetail = (Array.isArray(record.sources) ? record.sources : [])
    .map((source) => typeof source?.detail === 'string' ? source.detail.trim() : '')
    .find(Boolean);
  if (sourceDetail) return sourceDetail;
  const qaId = record.recordType === 'qa' && /^ygoresources-qa-(\d+)$/u.exec(String(record.id || ''));
  if (qaId) return `https://db.ygoresources.com/data/qa/${qaId[1]}`;
  const cardIds = Array.isArray(record.cardIds) ? record.cardIds : [];
  if (record.recordType !== 'card-faq' || cardIds.length !== 1 || !/^\d+$/u.test(String(cardIds[0]))) return '';
  return `https://db.ygoresources.com/data/card/${cardIds[0]}`;
}

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

/**
 * Expand selected rule units to the complete canonical source section they
 * already belong to. This is mechanical provenance expansion only: section
 * membership comes from unitSections and sections[*].ruleUnitIds, while text
 * comes from the canonical rules.units map. A bad binding can carry the wrong
 * source, so missing canonical members fail closed through the existing identity
 * structure rather than any semantic judgment.
 */
export function expandGeminiSelectionToSourceSections({ selection, rules }) {
  const selectedRules = [];
  const seen = new Set();
  for (const unit of selection?.selectedRules || []) {
    const sectionId = rules.unitSections.get(unit.id);
    const section = sectionId ? rules.sections.get(sectionId) : null;
    const ids = section?.ruleUnitIds || [unit.id];
    for (const id of ids) {
      if (seen.has(id)) continue;
      const canonical = rules.units.get(id);
      if (!canonical) throw new Error('gemini_rule_section_unit_binding_invalid');
      seen.add(id);
      selectedRules.push(canonical);
    }
  }
  return {
    ...selection,
    selectedRules,
    ruleUnitIds: selectedRules.map(unit => unit.id),
  };
}

function selectedBodiesForSelection(selection) {
  return [...selection.selectedRules, ...selection.selectedQa.map(({ handle, record }) => ({
    id: handle, recordType: record.recordType, title: record.title,
    source: record.sourceName || (record.recordType === 'qa' && /^ygoresources-qa-\d+$/u.test(String(record.id || '')) ? 'YGOResources DB' : ''),
    sourceUrl: selectedQaSourceUrl(record),
    ...Object.fromEntries(['sourceAuthority', 'sourceTier', 'official']
      .filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]])),
    text: JSON.stringify(record),
  }))];
}

export function packGeminiSelection({ selection, userQuery, cardResolution, retrievedEvidence = {}, maxPromptChars = GEMINI_EVIDENCE_MAX_PROMPT_CHARS }) {
  const selectedBodies = selectedBodiesForSelection(selection);
  const baseEvidence = { userProvidedCardTexts: retrievedEvidence.userProvidedCardTexts || [],
    cardTexts: retrievedEvidence.cardTexts || [] };
  const base = buildRagRulingPromptBundle({ userQuery, cardResolution, evidence: baseEvidence,
    env: { RAG_MAX_PROMPT_CHARS: '100000000', RAG_MAX_CARDS: Math.max(1, cardResolution.resolvedCards.length) } });
  const marker = '本次用户问题、卡片原文与检索资料如下：\n';
  const at = base.prompt.indexOf(marker);
  if (at < 0) throw new Error('gemini_published_prompt_envelope_absent');
  const payload = structuredClone(base.promptPayload);
  payload.evidence.rawRelatedEvidence = selectedBodies;
  payload.allowedEvidenceIds = [...new Set([
    ...(base.allowedEvidenceIds || []), ...selectedBodies.map(item => item.id),
  ])];
  const rendered = renderSelectedPrompt(base.prompt.slice(0, at), marker, readableSelectedPayload(payload, selection));
  const { prompt } = rendered;
  const packing = { ...base, prompt, promptPayload: rendered.payload, promptChars: prompt.length, promptTruncated: false,
    modelEvidence: payload.evidence, allowedEvidenceIds: payload.allowedEvidenceIds,
    selectedEntryChars: selectedBodies.map(item => ({ id: item.id, chars: item.text.length })),
    capacityExceeded: prompt.length > maxPromptChars };
  return { packing, evidence: { ...payload.evidence, cardResolution } };
}

/**
 * Estimate only the serialized prompt-character cost of adding each offered
 * source. The estimate is mechanical bookkeeping; it does not assess
 * relevance, completeness, authority, or evidence sufficiency.
 *
 * The canonical uncompressed selected body is an upper bound for the
 * production renderer, whose source-map path only replaces repeated metadata
 * with shorter references. Per-entry readable fields plus their full nesting and separators bound
 * any multi-entry serialization, including shared source metadata.
 */
export function computeGeminiSelectionPackingBudget({
  rules = [], qaItems = [], userQuery, cardResolution, retrievedEvidence = {},
  maxPromptChars = GEMINI_EVIDENCE_MAX_PROMPT_CHARS,
} = {}) {
  if (!Array.isArray(rules)) throw new TypeError('gemini_selection_budget_rules_invalid');
  if (!Array.isArray(qaItems)) throw new TypeError('gemini_selection_budget_qa_items_invalid');
  if (!Number.isSafeInteger(maxPromptChars) || maxPromptChars < 0) {
    throw new TypeError('gemini_selection_budget_limit_invalid');
  }

  const common = { userQuery, cardResolution, retrievedEvidence, maxPromptChars };
  const emptySelection = { selectedRules: [], selectedQa: [] };
  const base = packGeminiSelection({ ...common, selection: emptySelection });
  const basePromptChars = base.packing.promptChars;
  const ruleUnitChars = {};
  const qaHandleChars = {};

  const uniqueRules = new Map();
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string') {
      throw new TypeError('gemini_selection_budget_rule_invalid');
    }
    if (!uniqueRules.has(rule.id)) uniqueRules.set(rule.id, rule);
  }
  for (const [id, rule] of uniqueRules) {
    const [body] = selectedBodiesForSelection({ selectedRules: [rule], selectedQa: [] });
    ruleUnitChars[id] = renderReadableData({ evidence: { rawRelatedEvidence: [readableRuleUnit(body)] }, allowedEvidenceIds: [body.id] }).length + 2;
  }

  const uniqueQa = new Map();
  for (const item of qaItems) {
    if (!item || typeof item !== 'object' || typeof item.handle !== 'string' || !item.record
      || typeof item.record !== 'object') {
      throw new TypeError('gemini_selection_budget_qa_item_invalid');
    }
    if (!uniqueQa.has(item.handle)) uniqueQa.set(item.handle, item);
  }
  for (const [handle, item] of uniqueQa) {
    const [body] = selectedBodiesForSelection({ selectedRules: [], selectedQa: [item] });
    const { text: _canonicalJson, ...metadata } = body;
    qaHandleChars[handle] = renderReadableData({ evidence: { rawRelatedEvidence: [{ ...metadata, sourceRecord: item.record }] }, allowedEvidenceIds: [body.id] }).length + 2;
  }

  return {
    limitChars: maxPromptChars,
    basePromptChars,
    availableEvidenceChars: Math.max(0, maxPromptChars - basePromptChars),
    ruleUnitChars,
    qaHandleChars,
  };
}
