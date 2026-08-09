import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "../.github/workflows/collect-benchmark-results.yml",
  import.meta.url,
);

test("benchmark collector is read-only, bounded, and excludes frozen source bundles", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /permissions:\s+actions: read\s+contents: read/u);
  assert.match(workflow, /\^\[0-9\]\+\(,\[0-9\]\+\)\{0,23\}\$/u);
  assert.match(workflow, /run_ids must not contain duplicates/u);
  assert.match(workflow, /gh run download "\$run_id"/u);
  assert.match(workflow, /--repo "\$GITHUB_REPOSITORY"/u);
  assert.match(workflow, /\*checkpoint\.json/u);
  assert.match(workflow, /\*scored\.json/u);
  assert.match(workflow, /\*benchmark\.json/u);
  assert.match(workflow, /! -name '\*source-bundle\*'/u);
  assert.match(workflow, /sha256sum > results\/SHA256SUMS/u);
  assert.doesNotMatch(workflow, /RELAY_API_KEY|DEEPSEEK_API_KEY|ADMIN_MODEL_LAB_PASSWORD/u);
  assert.doesNotMatch(workflow, /local-relay-effort-experiment|admin-model-matrix/u);
  assert.doesNotMatch(workflow, /push:|pull_request:/u);
});
