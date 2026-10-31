import { createHash } from 'node:crypto';
import { renderReadableData } from './readableEvidenceText.mjs';
import { projectQaSourceDisplay } from './qaSourceDisplay.mjs';

const MARKER = '本次用户问题、卡片原文与检索资料如下：\n';
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const bytes = value => Buffer.byteLength(value, 'utf8');

/**
 * An offline candidate, deliberately separate from the live packer. It does
 * not select evidence, replace the saved prompt, or change canonical titles
 * used by a later supplementary retrieval. No model or counting API is called.
 * Character/byte savings do not establish a billing-token saving.
 */
export function previewQaSourceDisplay(packing, { mapping, cards = [], maxPromptChars } = {}) {
  const prompt = packing?.prompt;
  if (typeof prompt !== 'string' || !packing.promptPayload) {
    throw new TypeError('qa_display_saved_prompt_required');
  }
  const at = prompt.indexOf(MARKER);
  if (at < 0) throw new Error('qa_display_prompt_marker_missing');
  const prefix = prompt.slice(0, at + MARKER.length);
  // Only project a renderer contract we can reproduce exactly. Do not guess
  // at JSON, legacy compression, or unknown prompt layouts.
  if (prefix + renderReadableData(packing.promptPayload) !== prompt) {
    return { status: 'unsupported_prompt_layout', inputCostVerified: false,
      usableForGeneration: false, baselinePromptSha256: hash(prompt) };
  }
  const payload = structuredClone(packing.promptPayload);
  const projected = [], unchangedIds = [], titleAliases = [];
  for (const row of payload.evidence?.rawRelatedEvidence || []) {
    if (!row.sourceRecord) continue;
    const projection = projectQaSourceDisplay(row.sourceRecord, { mapping, cards });
    if (!projection) { unchangedIds.push(row.id); continue; }
    // In this candidate, the citation title and the source title agree. The
    // canonical modelEvidence on the caller's packing is never modified.
    titleAliases.push({ id: row.id, original: row.title, display: projection.title });
    row.title = projection.title;
    row.sourceRecord = projection.display;
    projected.push({ id: row.id, ...projection.diagnostics });
  }
  const candidatePrompt = prefix + renderReadableData(payload);
  return {
    status: projected.length ? 'candidate_ready' : 'no_verified_structure',
    inputCostVerified: false,
    usableForGeneration: false,
    reason: 'final_chat_completions_token_count_not_verified',
    baselinePromptSha256: hash(prompt), candidatePromptSha256: hash(candidatePrompt),
    baselineChars: prompt.length, candidateChars: candidatePrompt.length,
    baselineUtf8Bytes: bytes(prompt), candidateUtf8Bytes: bytes(candidatePrompt),
    charsDoNotIncrease: candidatePrompt.length <= prompt.length,
    bytesDoNotIncrease: bytes(candidatePrompt) <= bytes(prompt),
    withinConfiguredCharLimit: Number.isSafeInteger(maxPromptChars)
      ? candidatePrompt.length <= maxPromptChars : null,
    projected, unchangedIds, titleAliases,
    candidatePrompt, candidatePayload: payload,
  };
}
