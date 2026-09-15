import { createHash } from "node:crypto";

export const SOURCE_STRUCTURE_MAPPING_CONTRACT = "source-structure-mapping-v1";
export const READING_UNIT_TARGET_CHARS = 2400;

const BODY_KINDS = new Set(["paragraph", "list", "table", "qa", "opaque"]);
const COMPOSITE_KINDS = new Set(["list", "table", "qa"]);

export function sourceSha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function check(condition, code) {
  if (!condition) throw new Error(code);
}

function validRange(value, length, allowEmpty = false) {
  return Number.isSafeInteger(value?.start) && Number.isSafeInteger(value?.end)
    && value.start >= 0 && value.end <= length
    && (allowEmpty ? value.start <= value.end : value.start < value.end);
}

function normalizeSections(record, canonicalSha256) {
  const structure = record.structure;
  if (!structure) return [];
  check(structure.canonicalSha256 === canonicalSha256 && Array.isArray(structure.sections),
    "gemini_source_structure_binding_invalid");
  check(structure.schemaVersion === 1 || structure.schemaVersion === 2,
    "gemini_source_structure_version_invalid");
  const sections = structure.sections.map((section, index) => {
    const sectionKey = String(section.sectionKey || section.id || "").trim();
    const parentKey = section.parentKey ?? section.parentId ?? null;
    check(sectionKey && validRange(section, record.text.length), "gemini_source_section_invalid");
    return Object.freeze({
      sectionKey,
      parentKey: parentKey === null ? null : String(parentKey),
      title: String(section.title || ""),
      start: section.start,
      end: section.end,
      order: index,
      ...(section.sourceFragment ? { sourceFragment: String(section.sourceFragment) } : {}),
    });
  });
  const ids = new Set(sections.map((section) => section.sectionKey));
  check(ids.size === sections.length
    && sections.every((section) => section.parentKey === null || ids.has(section.parentKey)),
  "gemini_source_section_identity_invalid");
  return sections;
}

function sectionForRange(sections, start, end) {
  return sections.filter((section) => section.start <= start && section.end >= end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start)
      || left.order - right.order)[0] || null;
}

function derivedBlocks(record, sections) {
  const headingRanges = [];
  for (const section of sections) {
    if (!section.title || !record.text.startsWith(section.title, section.start)) continue;
    headingRanges.push({ blockKey: `${section.sectionKey}:heading:1`, sectionKey: section.sectionKey,
      kind: "heading", start: section.start, end: section.start + section.title.length });
  }
  const boundaries = new Set([0, record.text.length]);
  for (const match of record.text.matchAll(/[\s\S]+?(?:\n{2,}|$)/gu)) {
    boundaries.add(match.index);
    boundaries.add(match.index + match[0].length);
  }
  for (const heading of headingRanges) { boundaries.add(heading.start); boundaries.add(heading.end); }
  const offsets = [...boundaries].sort((left, right) => left - right);
  const blocks = [...headingRanges];
  let opaqueIndex = 0;
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const start = offsets[index], end = offsets[index + 1];
    if (!record.text.slice(start, end).trim()) continue;
    if (headingRanges.some((heading) => heading.start === start && heading.end === end)) continue;
    const section = sectionForRange(sections, start, end);
    opaqueIndex += 1;
    blocks.push({ blockKey: `${record.id}:opaque:${opaqueIndex}`, sectionKey: section?.sectionKey || null,
      kind: "opaque", start, end });
  }
  return blocks.sort((left, right) => left.start - right.start || left.end - right.end);
}

function normalizeBlocks(record, sections) {
  const raw = record.structure?.schemaVersion === 2 && Array.isArray(record.structure.blocks)
    ? record.structure.blocks : derivedBlocks(record, sections);
  const sectionKeys = new Set(sections.map((section) => section.sectionKey));
  const blocks = raw.map((block, index) => {
    const blockKey = String(block.blockKey || "").trim();
    const sectionKey = block.sectionKey === null || block.sectionKey === undefined
      ? sectionForRange(sections, block.start, block.end)?.sectionKey || null : String(block.sectionKey);
    check(blockKey && (BODY_KINDS.has(block.kind) || block.kind === "heading")
      && validRange(block, record.text.length) && (!sectionKey || sectionKeys.has(sectionKey)),
    "gemini_source_block_invalid");
    return Object.freeze({ ...structuredClone(block), blockKey, sectionKey, order: index });
  });
  check(new Set(blocks.map((block) => block.blockKey)).size === blocks.length,
    "gemini_source_block_identity_invalid");
  return blocks;
}

function selectedBodyBlocks(blocks) {
  const composites = blocks.filter((block) => COMPOSITE_KINDS.has(block.kind));
  const selected = blocks.filter((block) => BODY_KINDS.has(block.kind)
    && (COMPOSITE_KINDS.has(block.kind) || !composites.some((outer) => (
      outer.start <= block.start && outer.end >= block.end && outer.blockKey !== block.blockKey
    )))).sort((left, right) => left.start - right.start || right.end - left.end || left.order - right.order);
  for (let index = 1; index < selected.length; index += 1) {
    check(selected[index - 1].end <= selected[index].start, "gemini_source_atom_overlap_invalid");
  }
  return selected;
}

function titlePath(section, byKey) {
  const result = [];
  const seen = new Set();
  for (let current = section; current; current = current.parentKey ? byKey.get(current.parentKey) : null) {
    check(!seen.has(current.sectionKey), "gemini_source_section_cycle_invalid");
    seen.add(current.sectionKey);
    result.unshift(current.title);
  }
  return result.filter(Boolean);
}

function unique(values, self) {
  return [...new Set(values.filter((value) => value && value !== self))];
}

export function buildRuleSourceStructure(record, { targetChars = READING_UNIT_TARGET_CHARS } = {}) {
  check(record?.recordType === "rule-doc" && typeof record.id === "string"
    && typeof record.text === "string" && Number.isSafeInteger(targetChars) && targetChars > 0,
  "gemini_rule_source_record_invalid");
  const canonicalSha256 = sourceSha256(record.text);
  const sections = normalizeSections(record, canonicalSha256);
  const bySection = new Map(sections.map((section) => [section.sectionKey, section]));
  const blocks = normalizeBlocks(record, sections);
  const structureStatus = record.structure?.schemaVersion === 2 && Array.isArray(record.structure.blocks)
    ? "available" : "unavailable";
  const headingsBySection = new Map();
  for (const block of blocks.filter((item) => item.kind === "heading")) {
    if (!headingsBySection.has(block.sectionKey)) headingsBySection.set(block.sectionKey, []);
    headingsBySection.get(block.sectionKey).push(block);
  }
  const atoms = selectedBodyBlocks(blocks).map((block, index) => Object.freeze({
    atomKey: `${record.id}:atom:${index + 1}`,
    sourceId: record.id,
    sourceCanonicalSha256: canonicalSha256,
    sectionKey: block.sectionKey,
    blockKey: block.blockKey,
    kind: block.kind,
    start: block.start,
    end: block.end,
    text: record.text.slice(block.start, block.end),
    ...(block.tableLayout ? { tableLayout: block.tableLayout } : {}),
  }));
  const groups = new Map();
  for (const atom of atoms) {
    const key = atom.sectionKey || `${record.id}:root`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(atom);
  }
  const readingUnits = [];
  for (const [sectionKey, sourceAtoms] of groups) {
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      const unitIndex = readingUnits.filter((unit) => unit.sectionKey === sectionKey).length + 1;
      const section = bySection.get(sectionKey);
      const heading = unitIndex === 1 ? (headingsBySection.get(sectionKey) || [])[0] : null;
      const start = heading ? Math.min(heading.start, pending[0].start) : pending[0].start;
      const end = pending.at(-1).end;
      const path = section ? titlePath(section, bySection) : [String(record.title || "")].filter(Boolean);
      const atomIds = pending.map((atom) => atom.atomKey);
      readingUnits.push({ unitKey: `${record.id}:reading:${sectionKey}:${unitIndex}`,
        sourceKind: "rule", sourceId: record.id, sourceCanonicalSha256: canonicalSha256, sectionKey,
        title: path.at(-1) || String(record.title || ""), titlePath: path,
        start, end, text: record.text.slice(start, end), atomIds, atomKeys: atomIds,
        contextRefs: [], explicitRefs: [] });
      pending = [];
    };
    for (const atom of sourceAtoms) {
      if (pending.length && sections.some((candidate) => candidate.sectionKey !== sectionKey
          && candidate.start >= pending.at(-1).end && candidate.start < atom.start)) flush();
      if (pending.length && atom.end - pending[0].start > targetChars) flush();
      pending.push(atom);
      if (atom.end - pending[0].start >= targetChars) flush();
    }
    flush();
  }
  readingUnits.sort((left, right) => left.start - right.start || left.end - right.end || left.unitKey.localeCompare(right.unitKey));
  const unitByAtom = new Map();
  for (const unit of readingUnits) for (const atomKey of unit.atomKeys) unitByAtom.set(atomKey, unit);
  const directAtomsBySection = new Map();
  for (const atom of atoms) {
    if (!directAtomsBySection.has(atom.sectionKey)) directAtomsBySection.set(atom.sectionKey, []);
    directAtomsBySection.get(atom.sectionKey).push(atom);
  }
  const firstChildStart = new Map();
  for (const section of sections) {
    const childStarts = sections.filter((candidate) => candidate.parentKey === section.sectionKey)
      .map((candidate) => candidate.start);
    firstChildStart.set(section.sectionKey, childStarts.length ? Math.min(...childStarts) : section.end);
  }
  const unitsBySection = new Map();
  for (const unit of readingUnits) {
    if (!unitsBySection.has(unit.sectionKey)) unitsBySection.set(unit.sectionKey, []);
    unitsBySection.get(unit.sectionKey).push(unit);
  }
  for (const unit of readingUnits) {
    const refs = [];
    const sameSection = unitsBySection.get(unit.sectionKey) || [];
    if (sameSection[0] && sameSection[0] !== unit) refs.push(sameSection[0].unitKey);
    const firstAtom = atoms.find((atom) => atom.atomKey === unit.atomKeys[0]);
    if (firstAtom && (firstAtom.kind === "list" || firstAtom.kind === "table")) {
      const direct = directAtomsBySection.get(unit.sectionKey) || [];
      const position = direct.findIndex((atom) => atom.atomKey === firstAtom.atomKey);
      if (position > 0) refs.push(unitByAtom.get(direct[position - 1].atomKey)?.unitKey);
    }
    let section = bySection.get(unit.sectionKey);
    while (section?.parentKey) {
      const parent = bySection.get(section.parentKey);
      const introductions = (directAtomsBySection.get(parent.sectionKey) || [])
        .filter((atom) => atom.end <= firstChildStart.get(parent.sectionKey));
      for (const atom of introductions) refs.push(unitByAtom.get(atom.atomKey)?.unitKey);
      section = parent;
    }
    unit.contextRefs = unique(refs, unit.unitKey);
  }
  const unitForBlock = new Map();
  for (const block of blocks) {
    const owners = atoms.filter((atom) => atom.start <= block.start && atom.end >= block.end);
    const owner = owners[0] ? unitByAtom.get(owners[0].atomKey) : null;
    const sectionFirst = (unitsBySection.get(block.sectionKey) || [])[0];
    if (owner || sectionFirst) unitForBlock.set(block.blockKey, (owner || sectionFirst).unitKey);
  }
  return { sourceId: record.id, sourceCanonicalSha256: canonicalSha256, structureStatus, sections, blocks,
    atoms, readingUnits, unitForBlock,
    explicitLinks: Array.isArray(record.structure?.explicitLinks) ? record.structure.explicitLinks : [] };
}

export function buildRuleStructureMapping(records, options = {}) {
  const sources = records.filter((record) => record?.recordType === "rule-doc")
    .map((record) => buildRuleSourceStructure(record, options));
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  const explicitReferences = [];
  for (const source of sources) {
    for (const link of source.explicitLinks) {
      const refKey = `${source.sourceId}:ref:${Number(link.linkOrdinal)}`;
      const fromUnitKey = source.unitForBlock.get(link.fromBlockKey) || null;
      let target = link.targetSourceId ? sourceById.get(link.targetSourceId) : null;
      if (!target && link.sourceHref) {
        const href = new URL(link.sourceHref, records.find((record) => record.id === source.sourceId)?.sourceUrl);
        target = sources.find((candidate) => {
          const sourceUrl = records.find((record) => record.id === candidate.sourceId)?.sourceUrl;
          if (!sourceUrl) return false;
          const normalized = new URL(sourceUrl);
          return normalized.origin === href.origin && normalized.pathname === href.pathname;
        });
      }
      let targetUnits = [];
      const targetKey = link.targetBlockKey || link.targetSectionKey || null;
      if (target && link.targetBlockKey) {
        const key = target.unitForBlock.get(link.targetBlockKey);
        if (key) targetUnits = [key];
      } else if (target && link.targetSectionKey) {
        const section = target.sections.find((item) => item.sectionKey === link.targetSectionKey);
        if (section) targetUnits = target.readingUnits.filter((unit) => unit.start >= section.start && unit.end <= section.end)
          .map((unit) => unit.unitKey);
      } else if (target) targetUnits = target.readingUnits.map((unit) => unit.unitKey);
      explicitReferences.push({ refKey, fromBlockKey: link.fromBlockKey,
        sourceHref: String(link.sourceHref || ""),
        linkOrdinal: Number(link.linkOrdinal), targetSourceId: target?.sourceId || link.targetSourceId || null,
        targetKind: link.targetBlockKey ? "block" : link.targetSectionKey ? "section" : target ? "source" : "unresolved",
        targetKey, targetReadingUnitKeys: [...new Set(targetUnits)],
        resolutionStatus: targetUnits.length ? "resolved" : "unresolved" });
      if (fromUnitKey) {
        const unit = source.readingUnits.find((item) => item.unitKey === fromUnitKey);
        if (unit) unit.explicitRefs.push(refKey);
      }
    }
  }
  const plain = {
    schemaVersion: 1,
    contract: SOURCE_STRUCTURE_MAPPING_CONTRACT,
    targetChars: options.targetChars || READING_UNIT_TARGET_CHARS,
    sources: sources.map(({ unitForBlock: _map, explicitLinks: _links, ...source }) => source),
    explicitReferences,
  };
  return Object.freeze({ ...plain, structureMappingRevision: sourceSha256(stableJson(plain)) });
}

export function makeQaSourceUnits(records) {
  return records.map((input) => {
    const record = input?.record || input;
    const handle = input?.handle;
    const parentHandle = record?.sourceExcerpt?.parentHandle || handle;
    const canonicalBody = JSON.stringify(record);
    return Object.freeze({
      unitKey: `qa:${record.recordType}:${record.id}`,
      sourceKind: record.recordType === "card-faq" ? "faq" : "qa",
      sourceId: `${record.recordType}:${record.sourceExcerpt?.parentRecordId || record.id}`,
      recordId: record.id,
      recordType: record.recordType,
      canonicalBodySha256: sourceSha256(canonicalBody),
      text: canonicalBody,
      titlePath: [String(record.title || record.question || record.id)],
      contextRefs: [],
      explicitRefs: [],
      ...(handle ? { handle, parentHandle } : {}),
    });
  });
}

export function mapDenseLocatorsToReadingUnits(locators, readingUnits) {
  check(Array.isArray(locators) && Array.isArray(readingUnits), "gemini_dense_source_mapping_input_invalid");
  return locators.map((locator) => {
    check(typeof locator?.denseUnitId === "string" && typeof locator.sourceId === "string"
      && typeof locator.sourceCanonicalSha256 === "string" && validRange(locator, Number.MAX_SAFE_INTEGER, true),
    "gemini_dense_source_locator_invalid");
    let matches = locator.start === locator.end ? [] : readingUnits.filter((unit) => (
      unit.sourceId === locator.sourceId
      && unit.sourceCanonicalSha256 === locator.sourceCanonicalSha256
      && unit.start < locator.end && locator.start < unit.end
    )).sort((left, right) => left.start - right.start || left.unitKey.localeCompare(right.unitKey));
    if (locator.start < locator.end && !matches.length && locator.sectionKey) {
      matches = readingUnits.filter((unit) => unit.sourceId === locator.sourceId
        && unit.sourceCanonicalSha256 === locator.sourceCanonicalSha256
        && unit.sectionKey === locator.sectionKey)
        .sort((left, right) => left.start - right.start || left.unitKey.localeCompare(right.unitKey)).slice(0, 1);
    }
    return Object.freeze({ denseUnitId: locator.denseUnitId,
      readingUnitKeys: Object.freeze([...new Set(matches.map((unit) => unit.unitKey))]) });
  });
}
