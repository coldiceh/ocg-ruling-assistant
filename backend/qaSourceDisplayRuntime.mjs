import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadPreparedRagCardData } from './ragEvidenceRetriever.mjs';
import { QA_SOURCE_DISPLAY_SCHEMA } from './qaSourceDisplay.mjs';
import { previewQaSourceDisplay } from './qaSourceDisplayPreview.mjs';

let mappingPromise;
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function qaSourceDisplayEnabled(env = {}) {
  return /^(1|true|yes|on)$/iu.test(String(env.QA_SOURCE_DISPLAY_ENABLED || '').trim());
}

export async function loadQaSourceDisplayMapping() {
  if (!mappingPromise) {
    mappingPromise = readFile(new URL('../config/qa-source-display-v1.json', import.meta.url), 'utf8')
      .then(raw => {
        const mapping = JSON.parse(raw);
        if (mapping?.schema !== QA_SOURCE_DISPLAY_SCHEMA || !mapping.records
            || typeof mapping.records !== 'object' || Array.isArray(mapping.records)) {
          throw new Error('qa_display_mapping_invalid');
        }
        return { mapping, mappingSha256: sha256(raw) };
      }).catch(error => { mappingPromise = null; throw error; });
  }
  return mappingPromise;
}

// Public deployment diagnostics contain no source bodies, names or credentials.
export async function qaSourceDisplayReleaseInfo(env = {}) {
  const enabled = qaSourceDisplayEnabled(env);
  const base = { enabled, schema: QA_SOURCE_DISPLAY_SCHEMA, mappingLoaded: false, recordCount: 0 };
  if (!enabled) return base;
  try {
    const { mapping, mappingSha256 } = await loadQaSourceDisplayMapping();
    return { ...base, mappingLoaded: true, recordCount: Object.keys(mapping.records).length, mappingSha256 };
  } catch { return base; }
}

/**
 * Apply the evaluated reading view after selection, within the original cap.
 * The canonical evidence, source bytes, hashes and old renderer remain intact.
 * This performs only local reads; it never counts tokens, retrieves or calls a model.
 */
export async function applyQaSourceDisplay(packing, { env = {}, dataDir, maxPromptChars,
  loadMapping = loadQaSourceDisplayMapping, loadCardData = loadPreparedRagCardData } = {}) {
  if (!qaSourceDisplayEnabled(env)) return packing;
  const fallback = (status, extra = {}) => ({ ...packing,
    qaSourceDisplay: { schema: QA_SOURCE_DISPLAY_SCHEMA, enabled: true, applied: false, status, ...extra } });
  if (!Number.isSafeInteger(maxPromptChars) || maxPromptChars < 0) return fallback('invalid_prompt_limit');
  try {
    const [{ mapping, mappingSha256 }, cardData] = await Promise.all([loadMapping(), loadCardData(dataDir)]);
    if (mapping?.schema !== QA_SOURCE_DISPLAY_SCHEMA || !mapping.records
        || !Array.isArray(cardData?.cards)) return fallback('source_data_unavailable');
    const preview = previewQaSourceDisplay(packing, { mapping, cards: cardData.cards, maxPromptChars });
    const diagnostics = { baselinePromptSha256: preview.baselinePromptSha256,
      candidatePromptSha256: preview.candidatePromptSha256, mappingSha256,
      baselineChars: preview.baselineChars, candidateChars: preview.candidateChars,
      projected: preview.projected || [], unchangedIds: preview.unchangedIds || [] };
    if (preview.status !== 'candidate_ready') return fallback(preview.status, diagnostics);
    if (preview.withinConfiguredCharLimit !== true) return fallback('prompt_limit_exceeded', diagnostics);
    return { ...packing, prompt: preview.candidatePrompt, promptPayload: preview.candidatePayload,
      promptChars: preview.candidatePrompt.length,
      qaSourceDisplayTitles: preview.titleAliases.filter(alias => alias.original !== alias.display),
      qaSourceDisplay: { schema: QA_SOURCE_DISPLAY_SCHEMA, enabled: true, applied: true,
        status: 'applied', ...diagnostics } };
  } catch {
    // Formatting cannot break a previously usable evidence package.
    return fallback('source_data_unavailable');
  }
}

// Aliases affect labels only. The caller computes sourceHash from canonical
// fields first and passes these labels separately to the web page.
export function withQaSourceDisplayTitles(sources, aliases = []) {
  const byId = new Map((Array.isArray(aliases) ? aliases : []).filter(alias =>
    typeof alias?.id === 'string' && typeof alias.original === 'string'
      && typeof alias.display === 'string' && alias.display.trim()).map(alias => [alias.id, alias]));
  return sources.map(source => {
    const alias = byId.get(source.id);
    return alias && alias.original === source.title && alias.display !== source.title
      ? { ...source, displayTitle: alias.display } : source;
  });
}
