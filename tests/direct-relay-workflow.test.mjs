import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Direct Relay workflow has a hard paid-call gate and no Admin or Upstash dependency", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/direct-relay-sol-effort-pilot.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /secrets\.RELAY_API_KEY/u);
  assert.match(workflow, /local-relay-effort-experiment\.mjs/u);
  assert.match(workflow, /admin-evidence-snapshot-dry-run\.mjs/u);
  assert.match(workflow, /--bundle-output/u);
  assert.match(workflow, /--max-calls "\$MAX_CALLS"/u);
  assert.match(workflow, /score-admin-model-experiment\.mjs/u);
  assert.match(workflow, /direct-relay-scored\.json/u);
  assert.match(workflow, /relay-gpt-5\.6-sol/u);
  assert.match(workflow, /relay-gpt-5\.6-terra/u);
  assert.match(workflow, /relay-gpt-5\.6-luna/u);
  assert.match(workflow, /low-only/u);
  assert.match(workflow, /low-medium/u);
  assert.match(workflow, /none-low-medium/u);
  assert.match(workflow, /all-six/u);
  assert.match(workflow, /source_run_id:/u);
  assert.match(workflow, /source_artifact_name:/u);
  assert.match(workflow, /resume_artifact_name:/u);
  assert.match(workflow, /Download canonical frozen source bundle/u);
  assert.match(workflow, /artifacts\/source/u);
  assert.match(workflow, /artifacts\/resume/u);
  assert.match(workflow, /copy_unique artifacts\/source '\*source-bundle\.json'/u);
  assert.match(workflow, /copy_unique artifacts\/resume '\*result-checkpoint\.json'/u);
  assert.match(workflow, /\[ -s artifacts\/direct-relay-result-checkpoint\.json \][\s\S]*--recover-running-as-outcome-unknown/u);
  assert.match(workflow, /if: always\(\)/u);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.doesNotMatch(workflow, /ADMIN_MODEL_LAB|UPSTASH|api\/admin-model-lab/iu);
  assert.equal((workflow.match(/node scripts\/local-relay-effort-experiment\.mjs/gu) || []).length, 1);
  assert.equal((workflow.match(/secrets\.RELAY_API_KEY/gu) || []).length, 1);
});

test("four-case source fixture contains no answer fields and uses resolvable card identities", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/admin-evidence-dry-run-cases.json", import.meta.url),
    "utf8",
  ));
  assert.equal(fixture.cases.length, 4);
  assert.doesNotMatch(JSON.stringify(fixture), /expectedAnswer|golden|leakCanary/u);
  const cards = fixture.cases.flatMap((item) => item.candidateCards);
  for (const exactName of [
    "加速同步士",
    "纠罪巧ϝ’－恐怖“tromarIA”",
    "谜码圣手・封元",
    "渊兽 玛格纳姆特",
  ]) assert.ok(cards.includes(exactName));
});

test("Sol ablation workflow reuses one canonical bundle for exactly six serial zero-retry calls", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/direct-relay-sol-ablation.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /Confirm at most 6 paid Sol calls/u);
  assert.match(workflow, /default: false/u);
  assert.match(workflow, /effort:[\s\S]*options:[\s\S]*- none[\s\S]*- low[\s\S]*- medium[\s\S]*- high[\s\S]*- xhigh[\s\S]*- max/u);
  assert.match(workflow, /source_run_id:[\s\S]*required: true/u);
  assert.match(workflow, /source_artifact_name:[\s\S]*required: true/u);
  assert.match(workflow, /Download canonical frozen source bundle/u);
  assert.match(workflow, /copy_exactly_one artifacts\/source '\*source-bundle\.json' artifacts\/direct-relay-source-bundle\.json/u);
  assert.equal((workflow.match(/--snapshots artifacts\/direct-relay-source-bundle\.json/gu) || []).length, 2);
  assert.ok((workflow.match(/sha256sum --check artifacts\/direct-relay-source-bundle\.sha256/gu) || []).length >= 4);
  assert.match(workflow, /group: direct-relay-gpt-5\.6-effort-pilot/u);
  assert.match(workflow, /cancel-in-progress: false/u);

  const runnerCalls = workflow.match(/node scripts\/local-relay-effort-experiment\.mjs[\s\S]*?(?=\n\s*sha256sum --check)/gu) || [];
  assert.equal(runnerCalls.length, 2);
  const cardTextOnly = runnerCalls.find((block) => /--evidence-variant card_text_only/u.test(block));
  const withoutLua = runnerCalls.find((block) => /--evidence-variant without_lua/u.test(block));
  assert.ok(cardTextOnly);
  assert.ok(withoutLua);
  assert.match(cardTextOnly, /--max-calls 4/u);
  assert.match(withoutLua, /--max-calls 2/u);
  assert.equal((cardTextOnly.match(/--case /gu) || []).length, 4);
  assert.equal((withoutLua.match(/--case /gu) || []).length, 2);
  assert.match(withoutLua, /--case double-tempest-impermanence/u);
  assert.match(withoutLua, /--case unchained-replacement/u);
  assert.doesNotMatch(workflow, /--evidence-variant full/u);
  assert.doesNotMatch(workflow, /relay-gpt-5\.6-(?:terra|luna)/u);
  assert.doesNotMatch(workflow, /admin-evidence-snapshot-dry-run|ADMIN_MODEL_LAB|UPSTASH/iu);

  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(secrets)], ["RELAY_API_KEY"]);
  assert.equal((workflow.match(/score-admin-model-experiment\.mjs/gu) || []).length, 2);
  assert.ok((workflow.match(/if: always\(\)/gu) || []).length >= 3);
  assert.match(workflow, /sol-card-text-only-result-checkpoint\.json/u);
  assert.match(workflow, /sol-without-lua-result-checkpoint\.json/u);
  assert.match(workflow, /Download prior ablation checkpoints/u);
  assert.match(workflow, /copy_at_most_one artifacts\/resume '\*card-text-only-result-checkpoint\.json'/u);
  assert.match(workflow, /copy_at_most_one artifacts\/resume '\*without-lua-result-checkpoint\.json'/u);
  assert.doesNotMatch(workflow, /retry|for\s+attempt/iu);
});

test("ablation case ids stay out of production answer code", async () => {
  const caseIds = [
    "double-tempest-impermanence",
    "unchained-replacement",
    "accel-synchro-trigger-window",
    "lost-target-continue-resolution",
  ];
  const productionFiles = [
    "../src/app.js",
    "../backend/server.mjs",
    "../backend/ragRulingPipeline.mjs",
    "../backend/ragRulingPrompt.mjs",
    "../api/answer.js",
  ];
  const productionSource = (await Promise.all(productionFiles.map((pathname) => (
    readFile(new URL(pathname, import.meta.url), "utf8")
  )))).join("\n");
  for (const caseId of caseIds) assert.doesNotMatch(productionSource, new RegExp(caseId, "u"));
});
