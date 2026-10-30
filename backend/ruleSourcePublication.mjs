import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Publication of fixed official rule sources is decided by source identity:
// a source id plus the ids of its structural sections. The full source text
// stays in the synchronized corpus; only the listed sections are published to
// the evidence assets. No text is inspected to decide what is published.
export const RULE_SOURCE_PUBLICATION_CONTRACT = 'rule-source-section-publication-v1';
export const RULE_SOURCE_ALLOWLIST_KIND = 'rule-source-section-allowlist';
// Every rule document in this namespace must be listed in the allowlist, so a
// new or renamed official source can never be published (or hidden) silently.
export const GOVERNED_RULE_SOURCE_PREFIX = 'konami:';
const MODES = new Set(['sections', 'withhold']);

function fail(code) {
  throw new Error(code);
}

function check(condition, code) {
  if (!condition) fail(code);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sectionKeyOf(section) {
  return String(section?.sectionKey || section?.id || '').trim();
}

function parentKeyOf(section) {
  const parent = section?.parentKey ?? section?.parentId ?? null;
  return parent === null ? null : String(parent);
}

function recordSections(record) {
  const sections = record?.structure?.sections;
  check(Array.isArray(sections), `rule_source_publication_structure_absent:${record?.id}`);
  return sections;
}

/**
 * Returns the publication attached to a published rule record, or null when
 * the record is published whole. Invariant: every published section key names
 * a section of the record's own structure; `sections` publishes at least one
 * section and `withhold` publishes none.
 */
export function readRulePublication(record) {
  if (!record || record.publication === undefined) return null;
  const value = record.publication;
  check(value && typeof value === 'object' && !Array.isArray(value)
    && value.contract === RULE_SOURCE_PUBLICATION_CONTRACT && MODES.has(value.mode)
    && Array.isArray(value.publishedSectionKeys)
    && value.publishedSectionKeys.every(nonEmptyString), 'rule_source_publication_invalid');
  const keys = value.publishedSectionKeys.map(String);
  check(new Set(keys).size === keys.length, 'rule_source_publication_duplicate_section');
  check(value.mode === 'sections' ? keys.length > 0 : keys.length === 0,
    'rule_source_publication_mode_invalid');
  const known = new Set(recordSections(record).map(sectionKeyOf));
  check(keys.every(key => known.has(key)), 'rule_source_publication_section_unknown');
  return Object.freeze({ contract: value.contract, mode: value.mode,
    publishedSectionKeys: Object.freeze([...keys]) });
}

/**
 * Published sections plus their ancestors. Ancestors stay visible only as
 * structure (titles of the path); their own body is published only when the
 * ancestor itself is listed.
 */
export function rulePublicationVisibility(publication, sections) {
  const byKey = new Map(sections.map(section => [sectionKeyOf(section), section]));
  const published = new Set(publication.publishedSectionKeys);
  const visible = new Set();
  for (const key of published) {
    check(byKey.has(key), 'rule_source_publication_section_unknown');
    for (let section = byKey.get(key); section && !visible.has(sectionKeyOf(section));) {
      visible.add(sectionKeyOf(section));
      const parent = parentKeyOf(section);
      section = parent === null ? null : byKey.get(parent);
    }
  }
  return Object.freeze({ published, visible });
}

function titlePathOf(sectionKey, byKey) {
  const path = [];
  const seen = new Set();
  for (let section = byKey.get(sectionKey); section;) {
    const key = sectionKeyOf(section);
    check(!seen.has(key), 'rule_source_allowlist_section_cycle');
    seen.add(key);
    path.unshift(String(section.title || ''));
    const parent = parentKeyOf(section);
    section = parent === null ? null : byKey.get(parent);
  }
  return path;
}

/**
 * Validates the allowlist document. It fails instead of returning an empty or
 * partial list: an empty list must never mean "hide everything" or "publish
 * everything".
 */
export function validateRuleSourceAllowlist(value) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === 1 && value.kind === RULE_SOURCE_ALLOWLIST_KIND,
  'rule_source_allowlist_invalid');
  check(Array.isArray(value.sources) && value.sources.length > 0, 'rule_source_allowlist_empty');
  const categories = value.categories && typeof value.categories === 'object' ? value.categories : null;
  const sourceIds = new Set();
  const sources = value.sources.map(source => {
    check(source && typeof source === 'object' && nonEmptyString(source.sourceId)
      && MODES.has(source.mode), 'rule_source_allowlist_source_invalid');
    check(!sourceIds.has(source.sourceId), `rule_source_allowlist_source_duplicate:${source.sourceId}`);
    sourceIds.add(source.sourceId);
    if (source.mode === 'withhold') {
      check(source.sections === undefined || (Array.isArray(source.sections) && !source.sections.length),
        `rule_source_allowlist_withhold_sections_invalid:${source.sourceId}`);
      check(nonEmptyString(source.reason), `rule_source_allowlist_reason_missing:${source.sourceId}`);
      return Object.freeze({ sourceId: source.sourceId, mode: 'withhold', sections: Object.freeze([]),
        reason: source.reason });
    }
    check(Array.isArray(source.sections) && source.sections.length > 0,
      `rule_source_allowlist_sections_empty:${source.sourceId}`);
    const keys = new Set();
    const sections = source.sections.map(section => {
      check(section && typeof section === 'object' && nonEmptyString(section.sectionKey)
        && nonEmptyString(section.title) && nonEmptyString(section.reason)
        && (section.titlePath === undefined || (Array.isArray(section.titlePath)
          && section.titlePath.every(item => typeof item === 'string')))
        && (!categories || Object.hasOwn(categories, section.category)),
      `rule_source_allowlist_section_invalid:${source.sourceId}:${section?.sectionKey}`);
      check(!keys.has(section.sectionKey),
        `rule_source_allowlist_section_duplicate:${source.sourceId}:${section.sectionKey}`);
      keys.add(section.sectionKey);
      return Object.freeze({ sectionKey: section.sectionKey, title: section.title, reason: section.reason,
        ...(section.titlePath ? { titlePath: Object.freeze([...section.titlePath]) } : {}),
        ...(section.category ? { category: section.category } : {}) });
    });
    return Object.freeze({ sourceId: source.sourceId, mode: 'sections', sections: Object.freeze(sections) });
  });
  // The normalized form validates again unchanged, so callers may pass either.
  return Object.freeze({ schemaVersion: 1, kind: RULE_SOURCE_ALLOWLIST_KIND,
    ...(categories ? { categories: Object.freeze({ ...categories }) } : {}), sources: Object.freeze(sources) });
}

export async function loadRuleSourceAllowlist(path) {
  check(nonEmptyString(path), 'rule_source_allowlist_path_required');
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('rule_source_allowlist_missing');
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('rule_source_allowlist_json_invalid', { cause: error });
  }
  return Object.freeze({ allowlist: validateRuleSourceAllowlist(parsed),
    bytes: bytes.byteLength, sha256: sha256(bytes) });
}

/**
 * Attaches the publication to copies of the selected rule records. A governed
 * record without an entry, an unknown section id, or a section whose title or
 * title path no longer matches the source structure stops the build.
 */
export function applyRuleSourceAllowlist(records, allowlist) {
  check(Array.isArray(records), 'rule_source_allowlist_records_invalid');
  const entries = new Map(validateRuleSourceAllowlist(allowlist).sources
    .map(source => [source.sourceId, source]));
  const present = new Set(records.map(record => record?.id));
  const applied = [];
  const published = records.map(record => {
    const entry = entries.get(record?.id);
    if (!entry) {
      check(!String(record?.id || '').startsWith(GOVERNED_RULE_SOURCE_PREFIX),
        `rule_source_allowlist_entry_missing:${record?.id}`);
      return record;
    }
    check(record.publication === undefined, `rule_source_publication_preexisting:${record.id}`);
    const sections = recordSections(record);
    const byKey = new Map(sections.map(section => [sectionKeyOf(section), section]));
    for (const listed of entry.sections) {
      const section = byKey.get(listed.sectionKey);
      check(section, `rule_source_allowlist_section_unknown:${record.id}:${listed.sectionKey}`);
      check(String(section.title || '') === listed.title,
        `rule_source_allowlist_title_mismatch:${record.id}:${listed.sectionKey}`);
      if (listed.titlePath) {
        check(JSON.stringify(titlePathOf(listed.sectionKey, byKey)) === JSON.stringify(listed.titlePath),
          `rule_source_allowlist_title_path_mismatch:${record.id}:${listed.sectionKey}`);
      }
    }
    const listedKeys = new Set(entry.sections.map(section => section.sectionKey));
    const publishedSectionKeys = sections.map(sectionKeyOf).filter(key => listedKeys.has(key));
    const publication = { contract: RULE_SOURCE_PUBLICATION_CONTRACT, mode: entry.mode, publishedSectionKeys };
    applied.push({ sourceId: record.id, mode: entry.mode, publishedSections: publishedSectionKeys.length,
      sourceSections: sections.length });
    return { ...record, publication };
  });
  return Object.freeze({ records: published, applied: Object.freeze(applied),
    absentSourceIds: Object.freeze([...entries.keys()].filter(sourceId => !present.has(sourceId))) });
}
