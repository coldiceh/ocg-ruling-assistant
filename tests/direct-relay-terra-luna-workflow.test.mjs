import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "../.github/workflows/direct-relay-terra-luna-ten-case.yml",
  import.meta.url,
);

test("frozen-source workflow accepts one model, one effort, and a bounded case scope", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /workflow_dispatch:/u);
  const modelInput = workflow.match(/model:([\s\S]*?)effort:/u)?.[1] || "";
  assert.match(modelInput, /type: choice/u);
  assert.match(modelInput, /- relay-gpt-5\.6-sol/u);
  assert.match(modelInput, /- relay-gpt-5\.6-terra/u);
  assert.match(modelInput, /- relay-gpt-5\.6-luna/u);
  assert.equal((modelInput.match(/^\s+- relay-gpt-5\.6-(?:sol|terra|luna)$/gmu) || []).length, 3);

  const effortInput = workflow.match(/effort:([\s\S]*?)case_scope:/u)?.[1] || "";
  for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
    assert.match(effortInput, new RegExp(`^\\s+- ${effort}$`, "mu"));
  }
  assert.equal((effortInput.match(/^\s+- (?:none|low|medium|high|xhigh|max)$/gmu) || []).length, 6);
  assert.doesNotMatch(effortInput, /all-six|low-high|none-low/iu);

  const scopeInput = workflow.match(/case_scope:([\s\S]*?)source_run_id:/u)?.[1] || "";
  assert.match(scopeInput, /default: ten/u);
  assert.match(scopeInput, /- original-four/u);
  assert.match(scopeInput, /- ten/u);
  assert.equal((scopeInput.match(/^\s+- (?:original-four|ten)$/gmu) || []).length, 2);

  assert.match(workflow, /source_run_id:[\s\S]*?required: true/u);
  assert.match(workflow, /source_artifact_name:[\s\S]*?required: true/u);
  assert.match(workflow, /Download canonical frozen ten-case source bundle/u);
  assert.match(workflow, /name: \$\{\{ inputs\.source_artifact_name \}\}/u);
  assert.match(workflow, /run-id: \$\{\{ inputs\.source_run_id \}\}/u);
  assert.match(workflow, /Expected exactly one \*source-bundle\.json/u);
  assert.match(workflow, /if \[ "\$\{#matches\[@\]\}" -ne 1 \]/u);
  assert.match(workflow, /ids\.length !== 10/u);
  assert.match(workflow, /new Set\(ids\)\.size !== ids\.length/u);
  assert.match(workflow, /every source bundle case must contain an Evidence Snapshot/u);

  const expectedCaseIds = [
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
  for (const caseId of expectedCaseIds) {
    assert.match(workflow, new RegExp(`"${caseId}"`, "u"));
    assert.match(workflow, new RegExp(`--case ${caseId}`, "u"));
  }
  assert.equal((workflow.match(/^\s+--case [a-z0-9-]+$/gmu) || []).length, 10);
});

test("frozen-source workflow is serial, zero-retry, scope-bounded, and isolated from Upstash", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.equal((workflow.match(/node scripts\/local-relay-effort-experiment\.mjs/gu) || []).length, 1);
  assert.match(workflow, /--timeout-ms 900000/u);
  assert.match(workflow, /original-four\)[\s\S]*max_calls=4/u);
  assert.match(workflow, /ten\)[\s\S]*max_calls=10/u);
  assert.match(workflow, /--max-calls "\$max_calls"/u);
  assert.match(workflow, /selected_case_count="\$\(\( \$\{#case_args\[@\]\} \/ 2 \)\)"/u);
  assert.match(workflow, /"\$selected_case_count" -ne "\$max_calls"/u);
  assert.doesNotMatch(workflow, /if \[ "\$\{#case_args\[@\]\}" -ne "\$max_calls" \]/u);
  assert.match(workflow, /Selected case count does not match max_calls/u);
  assert.match(workflow, /--model "\$RELAY_MODEL"/u);
  assert.match(workflow, /--effort "\$REASONING_EFFORT"/u);
  assert.doesNotMatch(workflow, /strategy:|matrix:|parallel|for\s+attempt|--retries/iu);
  assert.doesNotMatch(workflow, /resume|recover-running-as-outcome-unknown/iu);
  assert.match(workflow, /cancel-in-progress: false/u);

  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(secrets)], ["RELAY_API_KEY"]);
  assert.equal((workflow.match(/secrets\.RELAY_API_KEY/gu) || []).length, 1);
  assert.doesNotMatch(workflow, /UPSTASH|KV_REST|REDIS|ADMIN_MODEL_LAB|api\/admin-model-lab/iu);
  assert.doesNotMatch(workflow, /admin-evidence-snapshot-dry-run|--bundle-output/iu);

  assert.match(
    workflow,
    /name: direct-relay-\$\{\{ inputs\.model \}\}-\$\{\{ inputs\.case_scope \}\}-\$\{\{ inputs\.effort \}\}-\$\{\{ github\.run_id \}\}/u,
  );
  assert.match(workflow, /if: always\(\)/u);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /sha256sum --check artifacts\/direct-relay-source-bundle\.sha256/u);
});
