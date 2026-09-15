import { createHash } from "node:crypto";

const markerPrefix = "\uE000OCG_RULE_STRUCTURE_";
const markerSuffix = "\uE001";
const structuralTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "table", "dl"]);
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/**
 * Extract the canonical text and source-DOM structure in one pass. Markers are
 * inserted before HTML is stripped so every returned offset is tied to the
 * exact canonical string, rather than recovered with a later text search.
 */
export function parseOcgRuleHtml(html) {
  const mainHtml = extractMainHtml(html);
  if (mainHtml.includes(markerPrefix) || mainHtml.includes(markerSuffix)) {
    throw new Error("OCG Rule HTML contains reserved structure marker");
  }

  const dom = parseStructuralDom(removeIgnoredContainers(mainHtml));
  const selectedNodes = selectStructuralNodes(dom.nodes);
  const descriptors = [];
  const insertions = [];

  for (const node of selectedNodes) {
    const descriptor = {
      type: "block",
      kind: kindForTag(node.tag),
      level: /^h[1-6]$/.test(node.tag) ? Number(node.tag.slice(1)) : undefined,
      title: /^h[1-6]$/.test(node.tag) ? cleanText(stripHtml(node.innerHtml)) : undefined,
      sourceFragment: extractHtmlId(node.attributes) || undefined,
      node,
    };
    addRangeMarkers(descriptor, node, descriptors, insertions);
  }

  for (const node of dom.nodes.filter((item) => item.tag === "a" && item.closeStart != null)) {
    const sourceHref = extractHtmlAttribute(node.attributes, "href");
    if (!sourceHref) continue;
    addRangeMarkers({ type: "link", sourceHref, node }, node, descriptors, insertions);
  }

  for (const node of dom.nodes.filter((item) => item.closeStart != null && extractHtmlId(item.attributes))) {
    addRangeMarkers({ type: "anchor", sourceFragment: `#${extractHtmlId(node.attributes)}`, node }, node, descriptors, insertions);
  }

  for (const table of selectedNodes.filter((node) => node.tag === "table")) {
    const rows = descendantNodes(table, dom.nodes).filter((node) => node.tag === "tr");
    rows.forEach((row, rowIndex) => {
      descendantNodes(row, dom.nodes)
        .filter((node) => (node.tag === "th" || node.tag === "td") && nearestAncestorTag(node, "tr") === row)
        .forEach((cell) => {
          addRangeMarkers({
            type: "cell",
            table,
            row: rowIndex,
            tag: cell.tag,
            rowSpan: positiveIntegerAttribute(cell.attributes, "rowspan"),
            columnSpan: positiveIntegerAttribute(cell.attributes, "colspan"),
            node: cell,
          }, cell, descriptors, insertions);
        });
    });
  }

  const markedHtml = applyInsertions(dom.html, insertions);
  const text = cleanText(stripHtml(dom.html));
  const markedText = cleanText(stripHtml(markedHtml));
  const locatedRanges = locateAndRemoveMarkers(markedText, descriptors.length);
  const ranges = normalizeLocatedRanges(locatedRanges);
  if (ranges.text !== text) throw new Error("OCG Rule structure encoding changed canonical text");

  const blocks = [];
  const links = [];
  const anchors = [];
  const cellsByTable = new Map();
  descriptors.forEach((descriptor, index) => {
    const range = ranges.byIndex[index];
    if (descriptor.type === "block") {
      blocks.push({
        kind: descriptor.kind,
        start: range.start,
        end: range.end,
        ...(descriptor.level ? { level: descriptor.level } : {}),
        ...(descriptor.title != null ? { title: descriptor.title } : {}),
        ...(descriptor.sourceFragment ? { sourceFragment: `#${descriptor.sourceFragment}` } : {}),
        _node: descriptor.node,
      });
    } else if (descriptor.type === "link") {
      links.push(Object.freeze({ sourceHref: descriptor.sourceHref, start: range.start, end: range.end }));
    } else if (descriptor.type === "anchor") {
      anchors.push(Object.freeze({ sourceFragment: descriptor.sourceFragment, start: range.start, end: range.end }));
    } else {
      const cells = cellsByTable.get(descriptor.table) || [];
      cells.push({
        row: descriptor.row,
        tag: descriptor.tag,
        rowSpan: descriptor.rowSpan,
        columnSpan: descriptor.columnSpan,
        start: range.start,
        end: range.end,
      });
      cellsByTable.set(descriptor.table, cells);
    }
  });

  for (const block of blocks) {
    if (block.kind !== "table") continue;
    const cells = cellsByTable.get(block._node) || [];
    assignTableColumns(cells);
    block.tableLayout = Object.freeze({
      rowCount: cells.reduce((maximum, cell) => Math.max(maximum, cell.row + cell.rowSpan), 0),
      columnCount: cells.reduce((maximum, cell) => Math.max(maximum, cell.column + cell.columnSpan), 0),
      cells: Object.freeze(cells),
    });
  }

  return Object.freeze({
    text,
    blocks: Object.freeze(blocks.map(({ _node, ...block }) => Object.freeze(block))),
    links: Object.freeze(links),
    anchors: Object.freeze(anchors),
  });
}

export function bindOcgRuleStructure(parsed, canonicalText, {
  sourceId = "ocg-rule:document",
  sourceUrl = "",
  removedRange,
} = {}) {
  const sourceText = String(parsed?.text || "");
  const text = String(canonicalText || "");
  const deletion = validateExplicitEncoding(sourceText, text, removedRange);
  const parsedBlocks = (parsed?.blocks || []).map((block) => ({
    ...block,
    start: rebaseBoundary(block.start, deletion),
    end: rebaseBoundary(block.end, deletion),
    ...(block.tableLayout ? {
      tableLayout: {
        ...block.tableLayout,
        cells: block.tableLayout.cells.map((cell) => ({
          ...cell,
          start: rebaseBoundary(cell.start, deletion),
          end: rebaseBoundary(cell.end, deletion),
        })),
      },
    } : {}),
  })).filter((block) => block.end > block.start);

  const headings = parsedBlocks.filter((block) => block.kind === "heading");
  const { sections, sectionByHeading } = buildSections(headings, text.length, sourceId);
  const ownedIntervals = parsedBlocks
    .filter((block) => block.kind !== "heading")
    .map((block) => ({ start: block.start, end: block.end }));
  const opaqueBlocks = buildOpaqueGaps(text, [...ownedIntervals, ...headings], sections);
  const allBlocks = [...parsedBlocks, ...opaqueBlocks]
    .sort((left, right) => left.start - right.start || left.end - right.end || compareCodeUnits(left.kind, right.kind));
  const counters = new Map();
  const blocks = allBlocks.map((block) => {
    const sectionKey = block.kind === "heading"
      ? sectionByHeading.get(block)
      : findOwningSection(sections, block.start).sectionKey;
    const counterKey = `${sectionKey}\u0000${block.kind}`;
    const ordinal = (counters.get(counterKey) || 0) + 1;
    counters.set(counterKey, ordinal);
    return Object.freeze({
      blockKey: `${sectionKey}::${block.kind}-${ordinal}`,
      sectionKey,
      kind: block.kind,
      start: block.start,
      end: block.end,
      ...(block.tableLayout ? { tableLayout: freezeTableLayout(block.tableLayout) } : {}),
    });
  });

  const anchoredBlocks = new Map();
  for (const anchor of parsed?.anchors || []) {
    const start = rebaseBoundary(anchor.start, deletion);
    const end = rebaseBoundary(anchor.end, deletion);
    const containing = smallestContainingBlock(blocks, start, end) || findPreviousBlock(blocks, start);
    if (containing && !anchoredBlocks.has(anchor.sourceFragment)) anchoredBlocks.set(anchor.sourceFragment, containing.blockKey);
  }

  const explicitLinks = (parsed?.links || []).filter((link) => !rangeRemovedByDeletion(link, deletion)).map((link) => ({
    sourceHref: link.sourceHref,
    start: rebaseBoundary(link.start, deletion),
    end: rebaseBoundary(link.end, deletion),
  })).filter((link) => link.end >= link.start).map((link, linkOrdinal) => {
    const containing = smallestContainingBlock(blocks, link.start, link.end) || findPreviousBlock(blocks, link.start);
    if (!containing) return null;
    return Object.freeze({
      fromBlockKey: containing.blockKey,
      sourceHref: link.sourceHref,
      linkOrdinal,
    ...resolveExplicitTarget(link.sourceHref, sourceUrl, sourceId, sections, anchoredBlocks),
    });
  }).filter(Boolean);

  return Object.freeze({
    schemaVersion: 2,
    canonicalSha256: sha256(text),
    sections: Object.freeze(sections.map((section) => Object.freeze(section))),
    blocks: Object.freeze(blocks),
    explicitLinks: Object.freeze(explicitLinks),
  });
}

function parseStructuralDom(html) {
  const nodes = [];
  const stack = [];
  const tagPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-zA-Z][\w:-]*)([^>]*)>/g;
  let match;
  while ((match = tagPattern.exec(html))) {
    if (!match[1]) continue;
    const tag = match[1].toLowerCase();
    const closing = html[match.index + 1] === "/";
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag !== tag) continue;
        const node = stack[index];
        node.closeStart = match.index;
        node.end = tagPattern.lastIndex;
        node.innerHtml = html.slice(node.startTagEnd, node.closeStart);
        stack.length = index;
        break;
      }
      continue;
    }
    const node = {
      tag,
      attributes: match[2] || "",
      start: match.index,
      startTagEnd: tagPattern.lastIndex,
      closeStart: null,
      end: tagPattern.lastIndex,
      innerHtml: "",
      parent: stack[stack.length - 1] || null,
    };
    nodes.push(node);
    if (!voidTags.has(tag) && !/\/\s*>$/.test(match[0])) stack.push(node);
  }
  return { html, nodes };
}

function selectStructuralNodes(nodes) {
  return nodes.filter((node) => {
    if (!structuralTags.has(node.tag) || node.closeStart == null) return false;
    if ((node.tag === "p" || /^h[1-6]$/.test(node.tag)) && hasCompoundAncestor(node)) return false;
    if ((node.tag === "ul" || node.tag === "ol" || node.tag === "dl") && hasCompoundAncestor(node)) return false;
    return true;
  });
}

function hasCompoundAncestor(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.tag === "table" || parent.tag === "ul" || parent.tag === "ol" || parent.tag === "dl") return true;
  }
  return false;
}

function kindForTag(tag) {
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "p") return "paragraph";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "table") return "table";
  if (tag === "dl") return "qa";
  return "opaque";
}

function addRangeMarkers(descriptor, node, descriptors, insertions) {
  if (node.closeStart == null) return;
  const index = descriptors.length;
  descriptors.push(descriptor);
  insertions.push({ position: node.startTagEnd, text: marker(index, "S"), order: 1 });
  insertions.push({ position: node.closeStart, text: marker(index, "E"), order: 0 });
}

function marker(index, edge) {
  return `${markerPrefix}${index}_${edge}${markerSuffix}`;
}

function applyInsertions(html, insertions) {
  const sorted = [...insertions].sort((left, right) => right.position - left.position || right.order - left.order);
  let value = html;
  for (const insertion of sorted) value = `${value.slice(0, insertion.position)}${insertion.text}${value.slice(insertion.position)}`;
  return value;
}

function locateAndRemoveMarkers(markedText, count) {
  const events = [];
  const pattern = new RegExp(`${markerPrefix}(\\d+)_(S|E)${markerSuffix}`, "g");
  let match;
  let removed = 0;
  const byIndex = Array.from({ length: count }, () => ({}));
  while ((match = pattern.exec(markedText))) {
    const position = match.index - removed;
    const index = Number(match[1]);
    byIndex[index][match[2] === "S" ? "start" : "end"] = position;
    events.push({ index: match.index, length: match[0].length });
    removed += match[0].length;
  }
  if (events.length !== count * 2 || byIndex.some((range) => !Number.isInteger(range.start) || !Number.isInteger(range.end))) {
    throw new Error("OCG Rule structure marker was not preserved by canonical encoding");
  }
  let text = markedText;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    text = `${text.slice(0, event.index)}${text.slice(event.index + event.length)}`;
  }
  return { text, byIndex };
}

function normalizeLocatedRanges(located) {
  const text = cleanText(located.text);
  const positions = new Map();
  const mapPosition = (position) => {
    if (!positions.has(position)) positions.set(position, cleanText(located.text.slice(0, position)).length);
    return positions.get(position);
  };
  return {
    text,
    byIndex: located.byIndex.map((range) => {
      let start = mapPosition(range.start);
      let end = mapPosition(range.end);
      while (start < end && /\s/u.test(text[start])) start += 1;
      while (end > start && /\s/u.test(text[end - 1])) end -= 1;
      return { start, end };
    }),
  };
}

function buildSections(headings, textLength, sourceId) {
  const root = {
    sectionKey: `${sourceId}#document`,
    parentKey: null,
    title: "",
    start: 0,
    end: textLength,
  };
  const sections = [root];
  const ancestors = [];
  const siblingCounts = new Map();
  const sectionByHeading = new Map();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    while (ancestors.length && ancestors[ancestors.length - 1].level >= heading.level) ancestors.pop();
    const parent = ancestors[ancestors.length - 1] || { ...root, level: 0, pathKey: "document" };
    const siblingBase = `${parent.sectionKey}\u0000${heading.title}`;
    const siblingOrdinal = (siblingCounts.get(siblingBase) || 0) + 1;
    siblingCounts.set(siblingBase, siblingOrdinal);
    const pathPart = `${encodeURIComponent(heading.title || "untitled")}~${siblingOrdinal}`;
    const sectionKey = heading.sourceFragment
      ? `${sourceId}${heading.sourceFragment}`
      : `${sourceId}#${parent.pathKey === "document" ? "" : `${parent.pathKey}/`}${pathPart}`;
    let end = textLength;
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) {
        end = headings[next].start;
        break;
      }
    }
    const section = {
      sectionKey,
      parentKey: parent.sectionKey,
      title: heading.title || "",
      start: heading.start,
      end,
      ...(heading.sourceFragment ? { sourceFragment: heading.sourceFragment } : {}),
      level: heading.level,
      pathKey: parent.pathKey === "document" ? pathPart : `${parent.pathKey}/${pathPart}`,
    };
    sections.push(section);
    ancestors.push(section);
    sectionByHeading.set(heading, sectionKey);
  }
  return {
    sections: sections.map(({ level, pathKey, ...section }) => section),
    sectionByHeading,
  };
}

function buildOpaqueGaps(text, intervals, sections) {
  const covered = intervals
    .filter((item) => item.end > item.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const interval of covered) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ start: interval.start, end: interval.end });
  }
  const gaps = [];
  let cursor = 0;
  for (const interval of [...merged, { start: text.length, end: text.length }]) {
    if (interval.start > cursor && text.slice(cursor, interval.start).trim()) {
      gaps.push({ kind: "opaque", start: cursor, end: interval.start, sectionKey: findOwningSection(sections, cursor).sectionKey });
    }
    cursor = Math.max(cursor, interval.end);
  }
  return gaps;
}

function findOwningSection(sections, position) {
  return sections
    .filter((section) => section.start <= position && position < section.end)
    .sort((left, right) => right.start - left.start || left.end - right.end)[0] || sections[0];
}

function smallestContainingBlock(blocks, start, end) {
  return blocks.filter((block) => block.start <= start && end <= block.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
}

function findPreviousBlock(blocks, position) {
  return [...blocks].filter((block) => block.end <= position).sort((left, right) => right.end - left.end)[0] || blocks[0];
}

function resolveExplicitTarget(href, sourceUrl, sourceId, sections, anchoredBlocks) {
  try {
    const base = sourceUrl || "https://invalid.local/";
    const target = new URL(href, base);
    const current = new URL(base);
    const sameDocument = target.origin === current.origin && target.pathname === current.pathname && target.search === current.search;
    if (!sameDocument) return {};
    const fragment = target.hash;
    if (!fragment) return { targetSourceId: sourceId };
    const section = sections.find((item) => item.sourceFragment === fragment);
    if (section) return { targetSourceId: sourceId, targetSectionKey: section.sectionKey };
    const targetBlockKey = anchoredBlocks.get(fragment);
    return targetBlockKey ? { targetSourceId: sourceId, targetBlockKey } : { targetSourceId: sourceId };
  } catch {
    return {};
  }
}

function rangeRemovedByDeletion(range, deletion) {
  return deletion.end > deletion.start && range.start >= deletion.start && range.end <= deletion.end;
}

function freezeTableLayout(layout) {
  return Object.freeze({
    rowCount: layout.rowCount,
    columnCount: layout.columnCount,
    cells: Object.freeze(layout.cells.map((cell) => Object.freeze({ ...cell }))),
  });
}

function assignTableColumns(cells) {
  const occupied = new Map();
  for (const cell of cells) {
    let column = 0;
    while ((occupied.get(`${cell.row}:${column}`) || 0) > 0) column += 1;
    cell.column = column;
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      for (let offset = 0; offset < cell.columnSpan; offset += 1) occupied.set(`${row}:${column + offset}`, 1);
    }
  }
}

function descendantNodes(parent, nodes) {
  return nodes.filter((node) => node !== parent && node.start >= parent.startTagEnd && node.end <= parent.closeStart);
}

function nearestAncestorTag(node, tag) {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent.tag === tag) return parent;
  return null;
}

function positiveIntegerAttribute(attributes, name) {
  const value = Number(extractHtmlAttribute(attributes, name));
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function extractHtmlId(attributes) {
  return decodeHtmlEntities(extractHtmlAttribute(attributes, "id"));
}

function extractHtmlAttribute(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(attributes || "").match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function validateExplicitEncoding(sourceText, canonicalText, removedRange) {
  if (removedRange == null) {
    if (sourceText !== canonicalText) throw new Error("OCG Rule structure requires literal canonical text without an explicit source edit");
    return { start: 0, end: 0 };
  }
  const start = Number(removedRange.start);
  const end = Number(removedRange.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > sourceText.length) {
    throw new Error("Invalid explicit OCG Rule source edit range");
  }
  if (`${sourceText.slice(0, start)}${sourceText.slice(end)}` !== canonicalText) {
    throw new Error("Explicit OCG Rule source edit range does not reproduce canonical text");
  }
  return { start, end };
}

function rebaseBoundary(position, deletion) {
  if (!Number.isInteger(position) || position < 0) throw new Error("Invalid OCG Rule structure boundary");
  if (position <= deletion.start) return position;
  if (position >= deletion.end) return position - (deletion.end - deletion.start);
  return deletion.start;
}

function extractMainHtml(html) {
  const value = String(html || "");
  const articleMatch = value.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) return articleMatch[1];
  const mainMatch = value.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return mainMatch[1];
  const bodyMatch = value.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : value;
}

function removeIgnoredContainers(value) {
  return String(value || "").replace(/<(script|style|nav|footer)\b[\s\S]*?<\/\1>/gi, " ");
}

function stripHtml(value) {
  return removeIgnoredContainers(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|section|article|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function cleanText(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '\"', apos: "'", nbsp: " " };
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = String(entity).toLowerCase();
    if (lower[0] === "#") {
      const isHex = lower[1] === "x";
      const codePoint = Number.parseInt(lower.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
  });
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
