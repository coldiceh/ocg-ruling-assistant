import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "../.github/workflows/validate-preview.yml",
  import.meta.url,
);

test("private pure LLM evaluation is explicitly triggered, serial and generation-only", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /types: \[opened, synchronize, reopened, labeled\]/u);
  assert.match(workflow, /github\.event\.action == 'labeled'/u);
  assert.match(workflow, /github\.event\.label\.name == 'private-pure-llm-evaluation-pilot'/u);
  assert.match(workflow, /github\.event\.label\.name == 'private-pure-llm-evaluation'/u);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/u);
  assert.match(workflow, /evaluation_limit:[\s\S]*type: choice[\s\S]*- "1"[\s\S]*- "32"/u);
  assert.match(workflow, /github\.event\.label\.name == 'private-pure-llm-evaluation' && '32' \|\| '1'/u);
  assert.match(workflow, /needs: validate/u);
  assert.match(workflow, /group: private-pure-llm-evaluation-\$\{\{ github\.repository \}\}/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /PUBLIC_RULING_MODEL_PROFILE: relay-gpt-5\.6-sol-low/u);
  assert.match(workflow, /RELAY_MAX_COMPLETION_TOKENS: "8192"/u);
  assert.match(workflow, /RELAY_STREAM_TIMEOUT_MS: "240000"/u);
  assert.doesNotMatch(workflow, /RELAY_LOCAL_STREAM_TIMEOUT_MAX_MS/u);
  assert.match(workflow, /secrets\.RELAY_API_KEY/u);
  assert.match(workflow, /secrets\.PURE_LLM_EVALUATION_DATASET_BASE64/u);
  assert.match(workflow, /--generate-only/u);
  assert.match(workflow, /--limit "\$EVALUATION_LIMIT"/u);
  assert.match(workflow, /--generation-timeout-ms 300000/u);
  assert.match(workflow, /evaluate-pure-llm-preview\.mjs/u);
  assert.doesNotMatch(workflow, /--auto-judge|--judge-only|--judge-timeout-ms/u);
  assert.doesNotMatch(workflow, /Generate and judge|Judge the|Sol high/iu);
  assert.doesNotMatch(workflow, /for\s+attempt|--retries|strategy:[\s\S]*matrix:/iu);
  assert.doesNotMatch(workflow, /UPSTASH|DEEPSEEK|legacy.?lua|formal.?engine/iu);
});

test("public artifact has only aggregate completion, latency and cost metadata", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /pure-llm-private-public-report\.json/u);
  assert.match(workflow, /test -s artifacts\/pure-llm-private-public-report\.json/u);
  assert.match(workflow, /const forbiddenKeys = new Set/u);
  for (const forbidden of [
    "cases",
    "verdict",
    "correct",
    "incorrect",
    "reviewedAccuracy",
    "strictOverallAccuracy",
  ]) {
    assert.match(workflow, new RegExp(`\\b${forbidden}\\b`, "u"));
  }
  assert.match(workflow, /report\.mode !== "generate_only"/u);
  assert.match(workflow, /report\.summary\?\.total !== Number\(process\.env\.EVALUATION_LIMIT\)/u);
  assert.match(workflow, /report\.summary\?\.generated !== Number\(process\.env\.EVALUATION_LIMIT\)/u);
  assert.match(workflow, /report\.summary\?\.generationFailed !== 0/u);
  assert.match(workflow, /retention-days: 1/u);
});

test("private questions, references and candidates are encrypted before upload", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /umask 077/u);
  assert.match(workflow, /base64 --decode > "\$RUNNER_TEMP\/private-dataset\.txt"/u);
  assert.match(workflow, /parseDatasetText/u);
  assert.match(workflow, /reportText\.includes\(item\.question\)/u);
  assert.match(workflow, /reportText\.includes\(item\.referenceAnswer\)/u);
  assert.match(workflow, /openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000/u);
  assert.match(workflow, /pure-llm-private-checkpoint\.tar\.gz\.enc/u);
  assert.match(workflow, /tar_args\+?=\(private-evaluation-backend\.log\)/u);
  const uploadPaths = [...workflow.matchAll(/^\s+path:\s+([^\r\n]+)$/gmu)]
    .map((match) => match[1].trim());
  assert.ok(uploadPaths.includes("artifacts/pure-llm-private-public-report.json"));
  assert.ok(uploadPaths.includes("artifacts/pure-llm-private-checkpoint.tar.gz.enc"));
  assert.equal(uploadPaths.some((path) => (
    path.includes("pure-llm-private-checkpoint") && !path.endsWith(".enc")
  )), false);
  assert.match(workflow, /rm -rf[\s\S]*private-dataset\.txt[\s\S]*pure-llm-private-checkpoint/u);
  assert.doesNotMatch(workflow, /cat "?\$RUNNER_TEMP\/private-dataset/u);
});
