import fs from 'node:fs';
const file='tests/gemini-rule-qa-assets.test.mjs';
const source=fs.readFileSync(file,'utf8');
const start=source.indexOf('  const canonical = workflow.indexOf("--stage canonical");');
const end=source.indexOf('  assert.match(workflow, /tests',start);
if(start<0||end<start)throw Error('publication_test_baseline_mismatch');
const replacement=`  const syncSource = await readFile(new URL("../scripts/sync-bounded-evidence-assets.mjs", import.meta.url), "utf8");
  const canonical = syncSource.indexOf('stage: "canonical"');
  const release = syncSource.indexOf('stage: "release"');
  const verify = syncSource.indexOf('stage: "verify"');
  assert.ok(canonical >= 0 && canonical < release && release < verify,
    "bounded data sync must build canonical, release, and verify stages in order");
  const releaseStep = syncSource.slice(release, verify);
  assert.match(releaseStep, /navigationPath/u);
  assert.match(releaseStep, /ruleDenseDir: join\\(normalized\\.outDir, "rule-embedding-v1"\\)/u);
  assert.match(releaseStep, /qaDenseDir: join\\(normalized\\.outDir, "qa-embedding-v1"\\)/u);
  const refresh = workflow.indexOf('node scripts/sync-bounded-evidence-assets.mjs');
  const promote = workflow.indexOf('bounded_sync_not_publishable');
  const verifyPromoted = workflow.indexOf('--stage verify', promote);
  assert.ok(refresh >= 0 && refresh < promote && promote < verifyPromoted,
    "workflow must use the bounded builder, gate promotion, then verify promoted assets");
  assert.match(syncSource, /report\\.publishable = true/u);
`;
fs.writeFileSync(file,source.slice(0,start)+replacement+source.slice(end));
