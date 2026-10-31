import { createHash } from 'node:crypto';

export const QA_SOURCE_DISPLAY_SCHEMA = 'qa-source-display-v1';
const QUESTION_FIELDS = ['question', 'rawQuestion', 'rawDetailedQuestion', 'detailedQuestion'];
const ANSWER_FIELDS = ['answer', 'officialAnswer', 'conclusion'];
const CID = /<<(\d{1,10})>>/gu;
const text = value => typeof value === 'string' && value.trim() ? value : '';
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const normalize = value => String(value || '').normalize('NFKC');

// Identity belongs to the untouched source record, never to its reading view.
export const qaSourceDisplayRecordHash = record => hash(JSON.stringify(record));

function sourceFields(source = {}) {
  return { title: text(source.title), question: text(source.question), answer: text(source.answer) };
}

function duplicateLegacyTitle(record, source) {
  const title = text(record.title);
  const question = normalize(source.question).replace(/\s+/gu, ' ');
  const truncated = question.length > 90 ? `${question.slice(0, 89)}…` : question;
  // A reconstruction must not erase a unique old heading. These are exact
  // source-title duplicates or the historical adapter's generated Q prefix.
  return !title || [source.title, normalize(source.title), question, truncated].includes(title);
}

function reconstruction(record, source) {
  if (!duplicateLegacyTitle(record, source)) return null;
  const question = normalize(source.question), answer = normalize(source.answer);
  for (const separator of [' ', '\n']) {
    if (record.text === [question, record.title, answer].filter(Boolean).join(separator)) {
      return { normalizer: 'NFKC', separator, parts: ['question', 'originalTitle', 'answer'] };
    }
  }
  return null;
}

/** Capture structure only when the upstream fields reconstruct the entire old body. */
export function bindQaSourceDisplay(record, source, metadata = {}) {
  if (record?.recordType !== 'qa' || !text(record.id) || !text(record.text)) return null;
  if ([...QUESTION_FIELDS, ...ANSWER_FIELDS].some(key => Object.hasOwn(record, key))) return null;
  const fields = sourceFields(source);
  if (!fields.title || !fields.question || !fields.answer) return null;
  const recipe = reconstruction(record, fields);
  if (!recipe) return null;
  return {
    recordId: record.id,
    originalRecordSha256: qaSourceDisplayRecordHash(record),
    originalTextSha256: hash(record.text),
    originalTitle: record.title || '',
    sourceUrl: text(metadata.sourceUrl),
    sourceLocale: text(metadata.sourceLocale) || 'ja',
    fetchedAt: text(metadata.fetchedAt),
    responseSha256: text(metadata.responseSha256),
    source: fields,
    sourceFieldsSha256: hash(JSON.stringify(fields)),
    reconstruction: recipe,
    cards: structuredClone(metadata.cards || {}),
  };
}

function validatedMapping(record, mapping) {
  if (mapping?.schema !== QA_SOURCE_DISPLAY_SCHEMA) return null;
  const entry = mapping.records?.[record.id];
  if (!entry || entry.recordId !== record.id
      || entry.originalRecordSha256 !== qaSourceDisplayRecordHash(record)
      || entry.originalTextSha256 !== hash(record.text || '')
      || entry.originalTitle !== (record.title || '')) return null;
  const fields = sourceFields(entry.source);
  if (!fields.title || !fields.question || !fields.answer
      || entry.sourceFieldsSha256 !== hash(JSON.stringify(fields))) return null;
  const recipe = reconstruction(record, fields);
  if (!recipe || JSON.stringify(recipe) !== JSON.stringify(entry.reconstruction)) return null;
  return entry;
}

function uniqueFields(record, fields, omitted = new Set()) {
  const entries = [], seen = new Set(omitted);
  for (const key of fields) {
    const value = text(record[key]);
    if (value && !seen.has(value)) { entries.push([key, value]); seen.add(value); }
  }
  return entries.length === 1 ? entries[0][1] : Object.fromEntries(entries);
}

function knownCombinedBody(record) {
  const answer = text(record.answer) || text(record.officialAnswer) || text(record.conclusion);
  const detail = text(record.detailedQuestion) || text(record.rawDetailedQuestion);
  // These are the exact concatenation recipes used by the synchronized index.
  const indexed = [record.question, detail && detail !== record.question ? detail : '', record.title, answer]
    .filter(Boolean).join('\n').trim();
  const synchronized = [record.question, detail && detail !== record.question ? detail : '', answer]
    .filter(Boolean).join('\n');
  return text(record.text) && [indexed, synchronized].includes(record.text);
}

function fullSourceTitle(record) {
  const heading = text(record.rawQuestion);
  if (!heading) return text(record.title);
  const flattened = heading.replace(/\s+/gu, ' ');
  const truncated = flattened.length > 90 ? `${flattened.slice(0, 89)}…` : flattened;
  // Recover the original heading only when it explains the generated old title.
  return record.title === flattened || record.title === truncated ? heading : text(record.title);
}

function namesById(cards, fallback) {
  const result = new Map();
  const add = (card, key) => {
    const id = String(card?.id ?? card?.cardId ?? key ?? '');
    if (/^\d{1,10}$/u.test(id)) result.set(id, card);
  };
  for (const [id, card] of Object.entries(fallback || {})) add(card, id);
  if (cards instanceof Map) for (const [id, card] of cards) add(card, id);
  else if (Array.isArray(cards)) for (const card of cards) add(card);
  return result;
}

function renderNames(value, byId, japanese, diagnostics) {
  if (typeof value === 'string') return value.replace(CID, (whole, id) => {
    const card = byId.get(id);
    const name = japanese ? text(card?.jaName) || text(card?.cnName) || text(card?.enName)
      : text(card?.cnName) || text(card?.jaName) || text(card?.enName);
    if (!name) { diagnostics.unknownCardIds.add(id); return whole; }
    diagnostics.replacedCardIds.add(id);
    return name;
  });
  if (Array.isArray(value)) return value.map(item => renderNames(item, byId, japanese, diagnostics));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, renderNames(item, byId, japanese, diagnostics)]));
  return value;
}

/**
 * Model-visible view only. Caller must opt in and compare complete request cost.
 * Unknown fields survive. Original records, handles, and source bytes stay intact.
 * null means no verified question/answer structure; caller uses its old rendering.
 */
export function projectQaSourceDisplay(record, { mapping, cards = [] } = {}) {
  if (!record || record.recordType !== 'qa') return null;
  const suppliedMapping = mapping?.records && Object.hasOwn(mapping.records, record.id);
  const entry = validatedMapping(record, mapping);
  // A stale sidecar must not silently turn into another projection strategy.
  if (suppliedMapping && !entry) return null;
  const display = structuredClone(record);
  const removedDuplicateFields = [];
  const groupedSourceFields = [];
  let title, locale, mode;
  if (entry) {
    title = entry.source.title;
    display.question = normalize(entry.source.question);
    display.answer = normalize(entry.source.answer);
    delete display.text;
    removedDuplicateFields.push('text');
    mode = 'verified_source_mapping';
    locale = entry.sourceLocale;
  } else {
    if (!QUESTION_FIELDS.some(key => text(record[key])) || !ANSWER_FIELDS.some(key => text(record[key]))) return null;
    // Non-string values in owned grouping fields cannot be safely overwritten.
    if ([...QUESTION_FIELDS, ...ANSWER_FIELDS].some(key => record[key] != null
        && typeof record[key] !== 'string')) return null;
    title = fullSourceTitle(record);
    const question = uniqueFields(record, QUESTION_FIELDS, new Set([title]));
    const answer = uniqueFields(record, ANSWER_FIELDS);
    for (const key of [...QUESTION_FIELDS, ...ANSWER_FIELDS]) {
      if (Object.hasOwn(display, key)) { delete display[key]; groupedSourceFields.push(key); }
    }
    // Heading-only questions are still questions; do not output an empty group.
    display.question = typeof question === 'string' || Object.keys(question).length ? question : title;
    display.answer = answer;
    if (knownCombinedBody(record)) { delete display.text; removedDuplicateFields.push('text'); }
    mode = 'structured_source_fields';
    locale = record.questionLocale || record.detailedQuestionLocale || '';
  }
  display.title = title || record.title || '';
  const japanese = locale === 'ja' || /[\u3040-\u30ff]/u.test(JSON.stringify([display.title, display.question, display.answer]));
  const nameDiagnostics = { replacedCardIds: new Set(), unknownCardIds: new Set() };
  const byId = namesById(cards, entry?.cards);
  // Render only owned source-body fields, never IDs, links, hashes or unknown metadata.
  for (const key of ['title', ...QUESTION_FIELDS, ...ANSWER_FIELDS, 'text']) {
    if (Object.hasOwn(display, key)) display[key] = renderNames(display[key], byId, japanese, nameDiagnostics);
  }
  return {
    display,
    title: display.title,
    titleAliases: display.title !== record.title ? [{ original: record.title || '', display: display.title }] : [],
    diagnostics: {
      schema: QA_SOURCE_DISPLAY_SCHEMA,
      mode,
      recordId: record.id,
      originalRecordSha256: qaSourceDisplayRecordHash(record),
      originalTextSha256: typeof record.text === 'string' ? hash(record.text) : null,
      sourceUrl: entry?.sourceUrl || record.sourceUrl || '',
      removedDuplicateFields,
      groupedSourceFields,
      replacedCardIds: [...nameDiagnostics.replacedCardIds],
      unknownCardIds: [...nameDiagnostics.unknownCardIds],
    },
  };
}
