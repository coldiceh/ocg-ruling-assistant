import { loadRuleDenseSearch } from './geminiRuleDenseSearch.mjs';

function check(condition, code) {
  if (!condition) throw new Error(code);
}

function qaItems(items) {
  check(Array.isArray(items), 'gemini_qa_dense_items_invalid');
  return items.filter(item => item?.record?.recordType === 'qa');
}

export function buildQaDenseContext({ qaRevision, items } = {}) {
  check(typeof qaRevision === 'string' && qaRevision.length > 0,
    'gemini_qa_dense_revision_invalid');
  const units = new Map();
  for (const item of qaItems(items)) {
    const handle = item?.handle;
    check(typeof handle === 'string' && handle.length > 0 && !units.has(handle),
      'gemini_qa_dense_handle_invalid');
    const text = JSON.stringify(item.record);
    check(typeof text === 'string', 'gemini_qa_dense_record_invalid');
    units.set(handle, Object.freeze({
      id: handle,
      title: item.record.title,
      text,
    }));
  }
  return Object.freeze({ ruleRevision: qaRevision, units });
}

export async function loadQaDenseSearch({ qaRevision, items, dataDir } = {}) {
  const selected = qaItems(items);
  const rules = buildQaDenseContext({ qaRevision, items: selected });
  const byHandle = new Map(selected.map(item => [item.handle, item]));
  const dense = await loadRuleDenseSearch({ rules, dataDir });

  function search(queryVector) {
    return Object.freeze(dense.search(queryVector).map((unit) => {
      const item = byHandle.get(unit.id);
      check(item, 'gemini_qa_dense_handle_binding_changed');
      return item;
    }));
  }

  return Object.freeze({ search });
}
