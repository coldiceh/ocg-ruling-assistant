import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packGeminiSelection, GEMINI_EVIDENCE_MAX_PROMPT_CHARS } from '../backend/geminiRuleQaPacking.mjs';
import { previewQaSourceDisplay } from '../backend/qaSourceDisplayPreview.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const rows = value => Array.isArray(value) ? value : value.records;

/** Local formatting preview only: no requests, model output, or production mutation. */
export async function previewSavedQaSources({ ids, outputDir, sourceDir = resolve(root, 'data'),
  mappingPath = resolve(root, 'config/qa-source-display-v1.json') } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !/^\d{1,10}$/u.test(String(id)))) {
    throw new Error('qa_display_ids_invalid');
  }
  if (!outputDir) throw new Error('qa_display_output_directory_required');
  const [recordBytes, cardText, mappingText] = await Promise.all([
    readFile(resolve(sourceDir, 'gemini-rule-qa-v1/qa-records.json.gz')),
    readFile(resolve(sourceDir, 'cards.json'), 'utf8'), readFile(mappingPath, 'utf8'),
  ]);
  const records = new Map(rows(JSON.parse(gunzipSync(recordBytes))).map(record => [record.id, record]));
  const selectedQa = [...new Set(ids.map(String))].map(id => {
    const record = records.get(`ygoresources-qa-${id}`);
    if (!record) throw new Error(`qa_display_record_missing:${id}`);
    // A local display label, explicitly not a production handle.
    return { handle: `offline-display-${id}`, record };
  });
  const baseline = packGeminiSelection({
    selection: { selectedRules: [], selectedQa },
    userQuery: '资料格式对照（离线，不生成裁定）',
    cardResolution: { resolvedCards: [] }, maxPromptChars: GEMINI_EVIDENCE_MAX_PROMPT_CHARS,
  });
  const preview = previewQaSourceDisplay(baseline.packing, {
    mapping: JSON.parse(mappingText), cards: rows(JSON.parse(cardText)), maxPromptChars: GEMINI_EVIDENCE_MAX_PROMPT_CHARS,
  });
  if (!preview.candidatePrompt) throw new Error(`qa_display_preview_failed:${preview.status}`);
  const { candidatePrompt, candidatePayload, ...summary } = preview;
  await mkdir(outputDir, { recursive: true });
  // wx preserves previous review artifacts; pick another directory to rerun.
  for (const [name, content] of [
    ['summary.json', JSON.stringify({ ...summary, productionEnabled: false,
      comparisonScope: 'offline fixture containing exactly the requested QA sources; not a replay of a paid question' }, null, 2)],
    ['original-records.json', JSON.stringify(selectedQa.map(item => item.record), null, 2)],
    ['legacy-prompt.txt', baseline.packing.prompt],
    ['candidate-prompt.txt', candidatePrompt],
    ['candidate-sources.json', JSON.stringify(candidatePayload.evidence.rawRelatedEvidence, null, 2)],
  ]) await writeFile(resolve(outputDir, name), content + (name.endsWith('.json') ? '\n' : ''),
    { encoding: 'utf8', flag: 'wx' });
  return { outputDir, ...summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  previewSavedQaSources({ ids: value('--ids')?.split(',').filter(Boolean),
    outputDir: value('--output-dir') && resolve(value('--output-dir')) })
    .then(({ candidatePayload, projected, titleAliases, ...summary }) => console.log(JSON.stringify(summary)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
