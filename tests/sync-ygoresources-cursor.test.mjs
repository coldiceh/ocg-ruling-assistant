import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

// Execute the production entry point against an isolated data directory and
// HTTP fixture. No remote data, model or historical evaluation case is used.
test('sync persists unfinished changes and advances only the captured manifest boundary', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-sync-cursor-'));
  context.after(() => fs.rm(root, {recursive:true, force:true}));
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.mkdir(path.join(root, 'data'));
  await fs.cp(new URL('../backend/', import.meta.url), path.join(root, 'backend'), {recursive:true});
  await fs.copyFile(new URL('../scripts/sync-ygoresources.mjs', import.meta.url), path.join(root, 'scripts/sync-ygoresources.mjs'));
  await fs.writeFile(path.join(root, 'data/snapshot-meta.json'), JSON.stringify({sourceRevision:'10'}));
  const mock = path.join(root, 'mock-http.mjs');
  await fs.writeFile(mock, `
    import fs from 'node:fs';
    const round = Number(process.env.SYNC_TEST_ROUND);
    globalThis.fetch = async url => {
      const p = new URL(url).pathname;
      let body = {}, status = 200, revision = '99';
      if (p.startsWith('/manifest/')) {
        if (round === 3) { status = 503; }
        else { revision = round === 1 ? '12' : '15'; body = round === 1 ? {data:{qa:{1001:1,1002:1,1003:1}}} : null; }
      } else if (p === '/data/meta/recent/ja/qa') body = [];
      else if (p.startsWith('/data/qa/')) {
        fs.appendFileSync(process.env.SYNC_TEST_REQUESTS, p+'\\n');
        if (p.endsWith('/1002')) status = round === 1 ? 503 : 410;
        else body = {qaData:{ja:{question:'Fixture question',answer:'Fixture answer'}}};
      }
      return new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json','x-cache-revision':revision}});
    };
  `);
  async function run(round) {
    const requests = path.join(root, `requests-${round}.txt`);
    await fs.writeFile(requests, '');
    await new Promise((resolve,reject) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(mock).href, path.join(root, 'scripts/sync-ygoresources.mjs')], {
        cwd:root, windowsHide:true, stdio:['ignore','pipe','pipe'],
        env:{...process.env, SYNC_TEST_ROUND:String(round), SYNC_TEST_REQUESTS:requests,
          SYNC_ALL_RELEASED_CARDS:'true', MAX_QA_TOTAL:'2', FETCH_RETRY_COUNT:'1', CARD_INDEX_LANGUAGES:'ja'},
      });
      let output=''; child.stdout.on('data', chunk => output+=chunk); child.stderr.on('data', chunk => output+=chunk);
      child.once('error',reject); child.once('exit', code => code===0 ? resolve() : reject(new Error(output)));
    });
    return {meta:JSON.parse(await fs.readFile(path.join(root,'data/snapshot-meta.json'),'utf8')),
      requests:(await fs.readFile(requests,'utf8')).trim().split('\n').filter(Boolean)};
  }
  const first = await run(1);
  assert.equal(first.meta.sourceRevision, '12', 'later response headers must not advance the manifest cursor');
  assert.deepEqual(first.meta.pendingQaIds, ['1002','1003'], 'failed and unselected changes must both survive');
  const second = await run(2);
  assert.equal(second.meta.sourceRevision, '15');
  assert.deepEqual(second.requests, ['/data/qa/1002','/data/qa/1003']);
  assert.deepEqual(second.meta.pendingQaIds, [], 'an explicit withdrawal and a saved record complete both items');
  const third = await run(3);
  assert.equal(third.meta.sourceRevision, '15', 'manifest failure cannot acknowledge unrelated successful responses');
});
