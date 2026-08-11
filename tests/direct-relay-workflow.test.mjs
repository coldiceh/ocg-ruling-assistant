import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Direct Relay Sol workflow defaults to the six unfinished cases and permits parallel single-effort dispatches", async () => {
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
  assert.match(workflow, /RELAY_MODEL: relay-gpt-5\.6-sol/u);
  assert.doesNotMatch(workflow, /relay-gpt-5\.6-(?:terra|luna)/u);
  const caseScopeInput = workflow.match(/case_scope:([\s\S]*?)confirm_paid_run:/u)?.[1] || "";
  assert.match(caseScopeInput, /default: new-six[\s\S]*- new-six/u);
  assert.doesNotMatch(caseScopeInput, /- four|- ten/u);
  assert.match(workflow, /tests\/fixtures\/admin-evidence-dry-run-cases\.json/u);
  assert.match(workflow, /tests\/fixtures\/model-effort-ten-case-cases\.json/u);
  for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
    assert.match(workflow, new RegExp(`- ${effort}-only`, "u"));
    assert.match(workflow, new RegExp(`${effort}-only\\) efforts=\\(${effort}\\)`, "u"));
  }
  const effortInput = workflow.match(/effort_range:([\s\S]*?)max_calls:/u)?.[1] || "";
  assert.doesNotMatch(effortInput, /low-medium|none-low-medium|all-six/u);
  const maxCallsInput = workflow.match(/max_calls:([\s\S]*?)resume_run_id:/u)?.[1] || "";
  assert.match(maxCallsInput, /default: "6"[\s\S]*- "6"/u);
  assert.doesNotMatch(maxCallsInput, /- "(?:10|20|30|40|60)"/u);
  assert.match(workflow, /source_run_id:/u);
  assert.match(workflow, /source_artifact_name:/u);
  assert.match(workflow, /resume_artifact_name:/u);
  assert.match(workflow, /Download canonical frozen source bundle/u);
  assert.match(workflow, /artifacts\/source/u);
  assert.match(workflow, /artifacts\/resume/u);
  assert.match(workflow, /copy_unique artifacts\/source '\*source-bundle\.json'/u);
  assert.match(workflow, /copy_unique artifacts\/resume '\*result-checkpoint\.json'/u);
  assert.match(workflow, /bundle_case_ids=\$\(node --input-type=module/u);
  const newSixBlock = workflow.match(/new_six=\(([\s\S]*?)\)\s+case_args=/u)?.[1] || "";
  for (const caseId of [
    "tearlaments-scream-activation-window",
    "mind-scan-red-lotus-public-hand",
    "harmonia-topologic-field-activation",
    "photon-emperor-mausoleum-extra-summon",
    "timaeus-gaze-dragoon-one-destruction",
    "memento-cactus-avramax-direct-attack",
  ]) assert.match(newSixBlock, new RegExp(caseId, "u"));
  assert.equal((newSixBlock.match(/^\s+[a-z].+$/gmu) || []).length, 6);
  assert.match(workflow, /new-six\)\s+required_case_ids=\("\$\{new_six\[@\]\}"\)/u);
  assert.match(workflow, /case_scope new-six requires a 6-case or 10-case source bundle/u);
  assert.match(workflow, /selected_case_count=\$\{#required_case_ids\[@\]\}/u);
  assert.match(workflow, /planned=\$\(\(selected_case_count \* \$\{#efforts\[@\]\}\)\)/u);
  assert.match(workflow, /"\$\{case_args\[@\]\}"/u);
  assert.match(workflow, /\[ -s artifacts\/direct-relay-result-checkpoint\.json \][\s\S]*--recover-running-as-outcome-unknown/u);
  assert.match(workflow, /if: always\(\)/u);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /group: direct-relay-gpt-5\.6-sol-\$\{\{ inputs\.case_scope \}\}-\$\{\{ inputs\.effort_range \}\}/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.doesNotMatch(workflow, /ADMIN_MODEL_LAB|UPSTASH|api\/admin-model-lab/iu);
  assert.equal((workflow.match(/node scripts\/local-relay-effort-experiment\.mjs/gu) || []).length, 1);
  assert.equal((workflow.match(/secrets\.RELAY_API_KEY/gu) || []).length, 1);
  assert.doesNotMatch(workflow, /for\s+attempt|--retries/iu);
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

test("ten-case source fixture is unique, answer-free, and contains the original four cases", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/model-effort-ten-case-cases.json", import.meta.url),
    "utf8",
  ));
  assert.equal(fixture.cases.length, 10);
  assert.equal(new Set(fixture.cases.map((item) => item.id)).size, 10);
  assert.doesNotMatch(JSON.stringify(fixture), /expectedAnswer|golden|leakCanary/u);
  for (const caseId of [
    "double-tempest-impermanence",
    "unchained-replacement",
    "accel-synchro-trigger-window",
    "lost-target-continue-resolution",
  ]) assert.ok(fixture.cases.some((item) => item.id === caseId));
});

test("Sol ablation workflow defaults to only the fourteen missing serial zero-retry calls", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/direct-relay-sol-ablation.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /Confirm the 14 missing paid Sol calls/u);
  assert.match(workflow, /default: false/u);
  const caseScopeInput = workflow.match(/case_scope:([\s\S]*?)confirm_paid_run:/u)?.[1] || "";
  assert.match(caseScopeInput, /default: missing-only[\s\S]*- missing-only/u);
  assert.doesNotMatch(caseScopeInput, /- four|- ten/u);
  assert.match(workflow, /effort:[\s\S]*options:[\s\S]*- none[\s\S]*- low[\s\S]*- medium[\s\S]*- high[\s\S]*- xhigh[\s\S]*- max/u);
  assert.match(workflow, /source_run_id:[\s\S]*required: true/u);
  assert.match(workflow, /source_artifact_name:[\s\S]*required: true/u);
  assert.match(workflow, /Download canonical frozen source bundle/u);
  assert.match(workflow, /copy_exactly_one artifacts\/source '\*source-bundle\.json' artifacts\/direct-relay-source-bundle\.json/u);
  assert.equal((workflow.match(/--snapshots artifacts\/direct-relay-source-bundle\.json/gu) || []).length, 2);
  assert.ok((workflow.match(/sha256sum --check artifacts\/direct-relay-source-bundle\.sha256/gu) || []).length >= 4);
  assert.match(workflow, /group: direct-relay-gpt-5\.6-sol-ablation-\$\{\{ inputs\.case_scope \}\}-\$\{\{ inputs\.effort \}\}/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /missing-only\)[\s\S]*card_text_only_case_count=6[\s\S]*without_lua_case_count=8[\s\S]*expected_total_planned_calls=14/u);
  assert.match(workflow, /four\)[\s\S]*card_text_only_case_count=4[\s\S]*without_lua_case_count=2[\s\S]*expected_total_planned_calls=6/u);
  assert.match(workflow, /ten\)[\s\S]*card_text_only_case_count=10[\s\S]*without_lua_case_count=10[\s\S]*expected_total_planned_calls=20/u);
  assert.match(workflow, /total_planned_calls=\$\(\(card_text_only_case_count \+ without_lua_case_count\)\)/u);
  assert.match(workflow, /\[ "\$total_planned_calls" -ne "\$expected_total_planned_calls" \]/u);

  const runnerCalls = workflow.match(/node scripts\/local-relay-effort-experiment\.mjs[\s\S]*?(?=\n\s*sha256sum --check)/gu) || [];
  assert.equal(runnerCalls.length, 2);
  const cardTextOnly = runnerCalls.find((block) => /--evidence-variant card_text_only/u.test(block));
  const withoutLua = runnerCalls.find((block) => /--evidence-variant without_lua/u.test(block));
  assert.ok(cardTextOnly);
  assert.ok(withoutLua);
  assert.match(cardTextOnly, /--max-calls "\$CARD_TEXT_ONLY_CASE_COUNT"/u);
  assert.match(withoutLua, /--max-calls "\$WITHOUT_LUA_CASE_COUNT"/u);
  assert.match(cardTextOnly, /"\$\{case_args\[@\]\}"/u);
  assert.match(withoutLua, /"\$\{case_args\[@\]\}"/u);
  const missingWithoutLua = workflow.match(/missing_without_lua=\(([\s\S]*?)\)\s+case "\$CASE_SCOPE"/u)?.[1] || "";
  assert.equal((missingWithoutLua.match(/^\s+[a-z].+$/gmu) || []).length, 8);
  assert.match(missingWithoutLua, /accel-synchro-trigger-window/u);
  assert.match(missingWithoutLua, /lost-target-continue-resolution/u);
  assert.doesNotMatch(missingWithoutLua, /double-tempest-impermanence|unchained-replacement/u);
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
  assert.match(
    workflow,
    /if \[ -s artifacts\/sol-card-text-only-result-checkpoint\.json \]; then[\s\S]*?resume_args\+=\(--recover-running-as-outcome-unknown\)[\s\S]*?--evidence-variant card_text_only/u,
  );
  assert.match(
    workflow,
    /if \[ -s artifacts\/sol-without-lua-result-checkpoint\.json \]; then[\s\S]*?resume_args\+=\(--recover-running-as-outcome-unknown\)[\s\S]*?--evidence-variant without_lua/u,
  );
  assert.equal((workflow.match(/"\$\{resume_args\[@\]\}"/gu) || []).length, 2);
  assert.doesNotMatch(workflow, /for\s+attempt|--retries/iu);
});

test("ablation case ids stay out of production answer code", async () => {
  const caseIds = [
    "double-tempest-impermanence",
    "unchained-replacement",
    "accel-synchro-trigger-window",
    "lost-target-continue-resolution",
    "tearlaments-scream-activation-window",
    "mind-scan-red-lotus-public-hand",
    "harmonia-topologic-field-activation",
    "photon-emperor-mausoleum-extra-summon",
    "timaeus-gaze-dragoon-one-destruction",
    "memento-cactus-avramax-direct-attack",
  ];
  const productionFiles = [
    "../src/app.js",
    "../backend/server.mjs",
    "../backend/publicAnswerService.mjs",
    "../backend/ragRulingPipeline.mjs",
    "../backend/ragRulingPrompt.mjs",
    "../api/answer.js",
  ];
  const productionSource = (await Promise.all(productionFiles.map((pathname) => (
    readFile(new URL(pathname, import.meta.url), "utf8")
  )))).join("\n");
  for (const caseId of caseIds) assert.doesNotMatch(productionSource, new RegExp(caseId, "u"));
});
