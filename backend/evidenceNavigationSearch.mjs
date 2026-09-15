import { createHash } from 'node:crypto';
import { buildManualCaptureCompleteLexicalQueryQueue } from '../scripts/lib/manual-capture-evidence-selection.mjs';

export const NAVIGATION_LEXICAL_CONTRACT = 'context-navigation-lexical-v1';

// Navigation is a separate search channel. Its text is never an evidence DTO.
export function createNavigationSearch(records = []) {
  const candidates = records.map(record => Object.freeze({
    binding: createHash('sha256').update(`navigation\0${record.unitKey}`).digest('hex'),
    unitKey: record.unitKey,
    sourceKind: record.sourceKind,
    text: [ ...(record.titlePath || []), record.descriptionZh || '', record.descriptionJa || '',
      ...(record.searchQuestions || []).map(question => question.text) ].join('\n'),
  }));
  if (new Set(candidates.map(item => item.unitKey)).size !== candidates.length) {
    throw new Error('evidence_navigation_unit_identity_duplicate');
  }
  Object.freeze(candidates);
  const byBinding = new Map(candidates.map(item => [item.binding, item]));
  return { search(query) {
    if (!candidates.length) return [];
    return buildManualCaptureCompleteLexicalQueryQueue({ query, candidates }).map(hit => {
      const record = byBinding.get(hit.binding);
      if (!record) throw new Error('evidence_navigation_binding_invalid');
      return { unitKey: record.unitKey, sourceKind: record.sourceKind };
    });
  } };
}
