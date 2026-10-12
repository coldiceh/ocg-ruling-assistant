import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createFocusedQaView} from '../backend/geminiFocusedQaView.mjs';
import {makeQaSourceUnits} from '../backend/evidenceSourceStructure.mjs';
import {createDecisionsReadingDependencies, expandDependencies} from '../backend/decisionsReadingDependencies.mjs';

test('each actual adapter-declared FAQ dependency survives into selection closure', async () => {
  const {records} = JSON.parse(await readFile(new URL('../data/tcg/qa-index.json',import.meta.url),'utf8'));
  const items = createFocusedQaView({qaRevision:'mechanical-fixture',
    items:records.map((record,index) => ({handle:`parent-${index}`,record}))}).items;
  const units = makeQaSourceUnits(items);
  const byRecord = new Map(items.map(item => [item.record.id,item]));
  const entries = new Map(items.map((body,index) => [`Q${index + 1}`,{id:body.handle,kind:'qa',body}]));
  const aliases = new Map([...entries].map(([alias,entry]) => [entry.id,alias]));
  const {dependencies} = createDecisionsReadingDependencies({entries,records:[],sourceAtoms:new Map(),relations:[]});
  let declaredCount = 0;
  for (const unit of units) {
    const item = byRecord.get(unit.recordId);
    const alias = aliases.get(item.handle);
    const delivered = expandDependencies(dependencies,[alias]);
    for (const recordId of item.record.requiredContextRecordIds || []) {
      declaredCount++;
      assert(unit.contextRefs.includes(`qa:card-faq:${recordId}`));
      assert(delivered.includes(aliases.get(byRecord.get(recordId).handle)));
    }
  }
  assert(declaredCount > 0);
});
