import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFocusedQaView} from '../backend/geminiFocusedQaView.mjs';
import {renderReadableData} from '../backend/readableEvidenceText.mjs';
import {searchTcgCards} from '../backend/tcgCardProvider.mjs';
import {loadRawRagData,loadPreparedRagCardData} from '../backend/ragEvidenceRetriever.mjs';
import {findDescribedCardCandidates} from '../backend/ragDescribedCardCandidates.mjs';
import {classifyPublicRequestChannel} from '../backend/publicAnswerPresentation.mjs';
const dataDir=fileURLToPath(new URL('../data/tcg',import.meta.url));

test('OCG FAQ readable bytes match main 7c5b75e including original field order',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/ocg-faq-readable-main.json',import.meta.url),'utf8'));
  const actual=renderReadableData(createFocusedQaView({qaRevision:'ocg-compatibility',items:[fixture.item]}).items);
  assert.deepEqual(Buffer.from(actual),Buffer.from(fixture.rendered));
});

test('TCG card endpoint uses bound compressed runtime with raw snapshots absent',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tcg-compressed-card-'));
  await mkdir(join(dir,'rag-runtime-v1'));
  for(const file of ['rag-runtime-v1/manifest.json','rag-runtime-v1/cards.json.br','rag-runtime-v1/card-alias-index.json.br','rag-data-revision-manifest.json','card-nicknames.v1.json'])
    await cp(join(dataDir,file),join(dir,file));
  const result=await searchTcgCards('Mystical Space Typhoon',{env:{TCG_DATA_DIR:dir}});
  assert.equal(result.results.length,1);
  const card=result.results[0];
  assert.equal(card.ruleSystem,'TCG');
  assert.equal(card.id,String(card.cid));
  assert.equal(card.source,'konami-tcg');
  assert.equal(typeof card.text,'string');
  assert.ok(card.text.length);
});

test('TCG raw adapter maps declared Spell/Trap subtypes to matcher properties',async()=>{
  const {cards}=await loadRawRagData(dataDir);
  const expected={'Field':'field','Quick-Play':'quickplay','Continuous':'continuous','Equip':'equip','Ritual':'ritual','Counter':'counter','Normal':'','':''};
  for(const [subtype,property] of Object.entries(expected)){
    const card=cards.find(c=>['spell','trap'].includes(String(c.cardType).toLowerCase())&&c.spellTrapSubtype===subtype);
    if(!card)continue;
    assert.equal(card.property,property,subtype);
  }
});

test('TCG prepared cards supply exact stored properties for described candidates',async()=>{
  const {cards}=await loadPreparedRagCardData(dataDir);
  const descriptor=cardKind=>({originalText:'Toon spell',archetypeEnName:'Toon',cardKind});
  const field=findDescribedCardCandidates(cards,descriptor('field_spell'));
  const normal=findDescribedCardCandidates(cards,descriptor('normal_spell'));
  assert.ok(field.some(id=>cards.find(c=>c.id===id).enName==='Toon Kingdom'));
  assert.ok(normal.length);
  for(const id of normal)assert.equal(cards.find(c=>c.id===id).property,'');
});

test('external API permits only valid optional ruleset and locale fields',()=>{
  for(const ruleSystem of ['OCG','TCG'])for(const answerLocale of ['zh-CN','en','ja']){
    for(const body of [{question:'test',ruleSystem},{question:'test',answerLocale},{question:'test',ruleSystem,answerLocale}])
      assert.equal(classifyPublicRequestChannel(body),'external_api');
  }
  for(const body of [{question:'test',ruleSystem:'bad'},{question:'test',answerLocale:'bad'},{question:'test',ruleSystem:null},{question:'test',ruleSystem:'TCG',extra:true}])
    assert.equal(classifyPublicRequestChannel(body),'unknown');
});
