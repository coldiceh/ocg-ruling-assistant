import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "../.github/workflows/validate-preview.yml",
  import.meta.url,
);

test("private pure LLM evaluation is serial, bounded, and does not publish private checkpoints", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /types: \[opened, synchronize, reopened, labeled\]/u);
  assert.match(workflow, /github\.event\.action == 'labeled'/u);
  assert.match(workflow, /github\.event\.label\.name == 'private-pure-llm-evaluation'/u);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u);
  assert.match(workflow, /needs: validate/u);
  assert.match(workflow, /PUBLIC_RULING_MODEL_PROFILE: relay-gpt-5\.6-sol-low/u);
  assert.match(workflow, /secrets\.RELAY_API_KEY/u);
  assert.match(workflow, /secrets\.PURE_LLM_EVALUATION_DATASET_BASE64/u);
  assert.match(workflow, /--limit 32/u);
  assert.match(workflow, /--generation-timeout-ms 300000/u);
  assert.match(workflow, /--judge-timeout-ms 300000/u);
  assert.match(workflow, /evaluate-pure-llm-preview\.mjs/u);
  assert.match(workflow, /pure-llm-private-public-report\.json/u);
  assert.match(workflow, /openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000/u);
  assert.match(workflow, /pure-llm-private-checkpoint\.tar\.gz\.enc/u);
  assert.match(workflow, /retention-days: 1/u);
  const uploadPaths = [...workflow.matchAll(/^\s+path:\s+([^\r\n]+)$/gmu)]
    .map((match) => match[1].trim());
  assert.ok(uploadPaths.includes("artifacts/pure-llm-private-public-report.json"));
  assert.ok(uploadPaths.includes("artifacts/pure-llm-private-checkpoint.tar.gz.enc"));
  assert.equal(uploadPaths.some((path) => (
    path.includes("pure-llm-private-checkpoint") && !path.endsWith(".enc")
  )), false);
  assert.doesNotMatch(workflow, /for\s+attempt|--retries|strategy:[\s\S]*matrix:/iu);
  assert.doesNotMatch(workflow, /UPSTASH|DEEPSEEK|legacy.?lua|formal.?engine/iu);
});

test("private dataset is decoded only into runner temp and scrubbed after the run", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /umask 077/u);
  assert.match(workflow, /base64 --decode > "\$RUNNER_TEMP\/private-dataset\.txt"/u);
  assert.match(workflow, /parseDatasetText/u);
  assert.match(workflow, /reportText\.includes\(item\.question\)/u);
  assert.match(workflow, /reportText\.includes\(item\.referenceAnswer\)/u);
  assert.match(workflow, /rm -rf[\s\S]*private-dataset\.txt[\s\S]*pure-llm-private-checkpoint/u);
  assert.doesNotMatch(workflow, /cat "?\$RUNNER_TEMP\/private-dataset/u);
});
