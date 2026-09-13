import { buildRagRulingPromptBundle } from './ragRulingPrompt.mjs';

const RULE_SOURCE_FIELDS = [
  'recordType', 'title', 'sourceUrl', 'source', 'sourceAuthority', 'official', 'parentSourceId',
];
const RULE_SOURCE_INSTRUCTION = 'ruleSources 保存规则的共用来源字段；每段 sourceRef 对应 ruleSources 中同名条目，其来源字段均继承自该条目。结合来源等级阅读原文，引用使用对应来源的 title。';

function renderSelectedPrompt(prefix, marker, payload) {
  const original = prefix + marker + JSON.stringify(payload);
  const ruleSources = {}, sourceRefs = new Map();
  const selectedBodies = payload.evidence.rawRelatedEvidence.map((item) => {
    if (item.recordType !== 'rule-doc') return item;
    const source = Object.fromEntries(RULE_SOURCE_FIELDS
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
      ...Object.fromEntries(Object.entries(item).filter(([key]) => !RULE_SOURCE_FIELDS.includes(key))),
      sourceRef,
    };
  });
  if (!sourceRefs.size) return original;
  // The copy is model-visible only. Server evidence retains full source fields
  // for citation links and the player's original-evidence display.
  const compact = prefix + RULE_SOURCE_INSTRUCTION + '\n' + marker + JSON.stringify({
    ...payload, evidence: { ...payload.evidence, rawRelatedEvidence: selectedBodies }, ruleSources,
  });
  return compact.length < original.length ? compact : original;
}

function selectedQaSourceUrl(record = {}) {
  const explicit = String(record.sourceUrl || '').trim();
  if (explicit) return explicit;
  const sourceDetail = (Array.isArray(record.sources) ? record.sources : [])
    .map((source) => typeof source?.detail === 'string' ? source.detail.trim() : '')
    .find(Boolean);
  if (sourceDetail) return sourceDetail;
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

export function packGeminiSelection({ selection, userQuery, cardResolution, retrievedEvidence = {}, maxPromptChars = 36000 }) {
  const selectedBodies = [...selection.selectedRules, ...selection.selectedQa.map(({ handle, record }) => ({
    id: handle, recordType: record.recordType, title: record.title,
    source: record.sourceName || '', sourceUrl: selectedQaSourceUrl(record),
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
  const prompt = renderSelectedPrompt(base.prompt.slice(0, at), marker, payload);
  const packing = { ...base, prompt, promptChars: prompt.length, promptTruncated: false,
    modelEvidence: payload.evidence, allowedEvidenceIds: payload.allowedEvidenceIds,
    selectedEntryChars: selectedBodies.map(item => ({ id: item.id, chars: item.text.length })),
    capacityExceeded: prompt.length > maxPromptChars };
  return { packing, evidence: { ...payload.evidence, cardResolution } };
}
