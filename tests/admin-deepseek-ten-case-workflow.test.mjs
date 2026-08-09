import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WORKFLOW_URL = new URL(
  "../.github/workflows/admin-deepseek-ten-case-benchmark.yml",
  import.meta.url,
);

test("DeepSeek ten-case workflow freezes the four paid configurations behind preflight and confirmation", async () => {
  const workflow = await readFile(WORKFLOW_URL, "utf8");
  const expectedConfigurations = [
    "deepseek:deepseek-v4-flash:standard:none:full",
    "deepseek:deepseek-v4-flash:pro:high:full",
    "deepseek:deepseek-v4-pro:standard:none:full",
    "deepseek:deepseek-v4-pro:pro:max:full",
  ];

  assert.match(workflow, /workflow_dispatch:/u);
  const confirmationInput = workflow.match(/confirm_paid_run:([\s\S]*?)permissions:/u)?.[1] || "";
  assert.match(confirmationInput, /type: boolean/u);
  assert.match(confirmationInput, /default: false/u);
  assert.match(confirmationInput, /40 paid DeepSeek final-ruling calls/u);

  assert.match(workflow, /tests\/fixtures\/model-effort-ten-case-cases\.json/u);
  for (const configuration of expectedConfigurations) {
    assert.equal(
      (workflow.match(new RegExp(`--config ${configuration.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "gu")) || []).length,
      1,
    );
  }
  assert.equal((workflow.match(/--config /gu) || []).length, 4);
  assert.match(workflow, /--concurrency 1/u);
  assert.match(workflow, /--max-final-requests 40/u);
  assert.match(workflow, /--estimated-cny-per-request 0\.20/u);
  assert.match(workflow, /--max-cost-cny 8/u);
  assert.match(workflow, /--timeout-ms 600000/u);

  const evidencePreflight = workflow.indexOf("Zero-cost ten-case evidence readiness preflight");
  const capabilitiesPreflight = workflow.indexOf("Save and validate sanitized production capabilities");
  const confirmation = workflow.indexOf("Require explicit paid-run confirmation");
  const paidRun = workflow.indexOf("Run four-config DeepSeek benchmark sequentially");
  assert.ok(evidencePreflight >= 0);
  assert.ok(capabilitiesPreflight > evidencePreflight);
  assert.ok(confirmation > capabilitiesPreflight);
  assert.ok(paidRun > confirmation);

  assert.match(workflow, /admin-evidence-snapshot-dry-run\.mjs/u);
  assert.match(workflow, /realProviderTransportCalls !== 0/u);
  assert.match(workflow, /reports\.length !== 10/u);
  assert.match(workflow, /allSnapshotsFrozen !== true/u);
  assert.match(workflow, /productionReadiness\?\.ready !== true/u);
  assert.match(workflow, /createAdminModelLabHttpClient/u);
  assert.match(workflow, /persistent final-call budget is unavailable/u);
  assert.match(workflow, /budgetConfigured !== true/u);
  assert.match(workflow, /budgetAvailable !== true/u);
  assert.match(workflow, /supportedReasoningModes/u);
  assert.match(workflow, /supportedReasoningEfforts/u);

  assert.equal((workflow.match(/secrets\.ADMIN_MODEL_LAB_PASSWORD/gu) || []).length, 2);
  assert.doesNotMatch(workflow, /DEEPSEEK_API_KEY|secrets\.DEEPSEEK/iu);
  assert.doesNotMatch(workflow, /repair_once|--retries|for\s+attempt/iu);
  assert.match(workflow, /if: always\(\)[\s\S]*actions\/upload-artifact@v4/u);
  assert.match(workflow, /deepseek-ten-case-evidence-preflight\.json/u);
  assert.match(workflow, /deepseek-ten-case-capabilities-preflight\.json/u);
  assert.match(workflow, /deepseek-ten-case-benchmark\.json/u);
  assert.match(workflow, /cancel-in-progress: false/u);
});

test("DeepSeek benchmark fixture contains exactly ten answer-free cases", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/model-effort-ten-case-cases.json", import.meta.url),
    "utf8",
  ));
  assert.equal(fixture.cases.length, 10);
  assert.equal(new Set(fixture.cases.map((item) => item.id)).size, 10);
  assert.doesNotMatch(JSON.stringify(fixture), /expectedAnswer|golden|leakCanary/u);
});
