// Human/model display only. JSON remains the storage and HTTP transport format.
// Every string is copied as text. Braces and brackets retain field grouping
// without escaping or indenting the original body. This is a reading format,
// never a canonical store, a machine parsing contract or an identity key.
// Do not unescape arbitrary source strings: a literal backslash may be card text.
export const READABLE_EVIDENCE_FORMAT = 'readable-fields-v1';

export function renderReadableData(value) {
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return value.length ? '[\n' + Array.from(value, renderReadableData).join('\n,\n') + '\n]' : '[]';
  }
  const entries = Object.entries(value).filter(([, item]) =>
    item !== undefined && typeof item !== 'function' && typeof item !== 'symbol');
  if (!entries.length) return '{}';
  return '{\n' + entries.map(([key, item]) => key + ': ' + renderReadableData(item)).join('\n') + '\n}';
}

// makeCandidate owns the outer text/binding/navigation fields. The source
// record itself is retained in full; no overlapping source fields are compared.
export function readableQaItem(item) {
  return { handle: item.handle, record: item.record };
}

// The rule adapter defines text as its canonical body. These are its reading
// fields; hashes, offsets and server lookup keys stay on the original object.
export function readableRuleUnit(unit) {
  const fields = ['id', 'text', 'recordType', 'title', 'sourceUrl', 'source',
    'sourceAuthority', 'sourceTier', 'official', 'updatedAt', 'checkedAt', 'tableLayout'];
  const result = Object.fromEntries(fields.filter(key => Object.hasOwn(unit, key)).map(key => [key, unit[key]]));
  if (unit.sourceSection) result.sourceSection = Object.fromEntries(
    ['title', 'titlePath'].filter(key => Object.hasOwn(unit.sourceSection, key))
      .map(key => [key, unit.sourceSection[key]]));
  return result;
}

// Only this adapter-owned field has a JSON-body contract. Never try to parse
// arbitrary body strings, quoted passages, paths or apparent escape sequences.
export function readableNavigationInput(input) {
  if (input.sourceKind !== 'qa' && input.sourceKind !== 'faq') return input;
  const { unitText, ...rest } = input;
  return { ...rest, unitText: JSON.parse(unitText) };
}
