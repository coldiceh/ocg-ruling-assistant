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
  assert.match(workflow, /github\.event\.label\.name == 'private-pure-llm-retrieval-pilot'/u);
  assert.match(workflow, /github\.event\.label\.name == 'private-pure-llm-evaluation'/u);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/u);
  assert.match(workflow, /github\.actor == github\.repository_owner/u);
  assert.match(workflow, /github\.triggering_actor == github\.repository_owner/u);
  assert.match(workflow, /github\.event\.pull_request\.user\.login == github\.repository_owner/u);
  assert.match(workflow, /evaluation_limit:[\s\S]*type: choice[\s\S]*- "1"[\s\S]*- "32"/u);
  assert.match(workflow, /github\.event\.label\.name == 'private-pure-llm-evaluation' && '32' \|\| '1'/u);
  assert.match(workflow, /needs: validate/u);
  assert.match(workflow, /timeout-minutes: 75/u);
  assert.doesNotMatch(workflow, /timeout-minutes: 300/u);
  assert.match(workflow, /group: private-pure-llm-evaluation-\$\{\{ github\.repository \}\}/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /PUBLIC_RULING_MODEL_PROFILE: relay-gpt-5\.6-sol-low/u);
  assert.match(workflow, /RELAY_MAX_COMPLETION_TOKENS: "8192"/u);
  assert.match(workflow, /RELAY_STREAM_TIMEOUT_MS: "60000"/u);
  assert.doesNotMatch(workflow, /RELAY_LOCAL_STREAM_TIMEOUT_MAX_MS/u);
  assert.match(workflow, /secrets\.RELAY_API_KEY/u);
  assert.match(workflow, /secrets\.PURE_LLM_EVALUATION_DATASET_BASE64/u);
  assert.match(workflow, /--generate-only/u);
  assert.match(workflow, /--limit "\$EVALUATION_LIMIT"/u);
  assert.match(workflow, /if \[ "\$EVALUATION_LIMIT" = "32" \]; then/u);
  assert.match(workflow, /case_count_args\+=\(--require-case-count 32\)/u);
  assert.match(workflow, /"\$\{case_count_args\[@\]\}"/u);
  assert.match(workflow, /--generation-timeout-ms 90000/u);
  assert.doesNotMatch(workflow, /RELAY_STREAM_TIMEOUT_MS: "(?:240000|270000)"/u);
  assert.doesNotMatch(workflow, /--generation-timeout-ms (?:300000|330000|600000)/u);
  assert.match(workflow, /evaluate-pure-llm-preview\.mjs/u);
  assert.doesNotMatch(workflow, /--auto-judge|--judge-only|--judge-timeout-ms/u);
  assert.doesNotMatch(workflow, /Generate and judge|Judge the|Sol high/iu);
  assert.doesNotMatch(workflow, /for\s+attempt|--retries|strategy:[\s\S]*matrix:/iu);
  assert.doesNotMatch(workflow, /UPSTASH|legacy.?lua|formal.?engine/iu);
});

test("retrieval-only pilot completes prompt construction without receiving or dispatching a paid key", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /RETRIEVAL_ONLY_PILOT:[^\r\n]*private-pure-llm-retrieval-pilot/u);
  assert.match(workflow, /Start the retrieval-only preview backend without a paid key/u);
  const materializeStep = workflow.match(
    /- name: Materialize the private dataset without logging it[\s\S]*?(?=\n\s+- name:)/u,
  )?.[0] || "";
  assert.doesNotMatch(materializeStep, /RELAY_API_KEY|secrets\.RELAY_API_KEY/u);
  assert.match(workflow, /if: env\.RETRIEVAL_ONLY_PILOT == 'true'[\s\S]*RAG_DRY_RUN: "true"[\s\S]*PRIVATE_EVALUATION_DIAGNOSTICS: "true"/u);
  assert.match(workflow, /MODEL_PROVIDER: mock/u);
  assert.match(workflow, /if \[ -n "\$\{RELAY_API_KEY:-\}" \]/u);
  assert.match(workflow, /Start the paid preview branch backend[\s\S]*if: env\.RETRIEVAL_ONLY_PILOT != 'true'[\s\S]*RELAY_API_KEY: \$\{\{ secrets\.RELAY_API_KEY \}\}/u);
  assert.match(workflow, /DEEPSEEK_API_KEY: \$\{\{ secrets\.DEEPSEEK_API_KEY \}\}/u);
  assert.doesNotMatch(workflow, /^\s{6}RELAY_API_KEY: \$\{\{ secrets\.RELAY_API_KEY \}\}$/mu);
  assert.match(workflow, /event\.kind !== "private_evaluation_stage"/u);
  assert.match(workflow, /const byTrace = new Map\(\)/u);
  assert.match(workflow, /const completedOneTrace/u);
  assert.match(workflow, /ended\.has\("retrieval"\)/u);
  assert.match(workflow, /ended\.has\("prompt_build"\)/u);
  assert.match(workflow, /ended\.has\("total"\)/u);
  assert.match(workflow, /event\.event === "relay_dispatch"/u);
  assert.match(workflow, /--limit "\$EVALUATION_LIMIT"/u);
  assert.match(workflow, /preview_dry_run_response/u);
  assert.match(workflow, /record\.candidateResponseText !== ""/u);
  assert.match(workflow, /Print anonymous pilot stage diagnostics/u);
  assert.match(workflow, /if: always\(\) && env\.EVALUATION_LIMIT == '1'/u);
  assert.match(workflow, /projectPrivateEvaluationStageLog/u);
  assert.match(workflow, /private_evaluation_stage_summary/u);
  assert.match(workflow, /scripts\/lib\/private-evaluation-stage-log\.mjs/u);
  assert.doesNotMatch(workflow, /cat [^\r\n]*private-evaluation-backend\.log/u);
});

test("private generation runs on an isolated loopback budget ledger, never the production public ledger", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /HOST: 127\.0\.0\.1[\s\S]*PORT: "18787"/u);
  assert.match(workflow, /node backend\/server\.mjs/u);
  assert.match(workflow, /--base-url "http:\/\/127\.0\.0\.1:\$PORT"/u);
  assert.doesNotMatch(workflow, /budgetApiUrl|\/api\/budget|cap_public_chatgpt/u);
  assert.doesNotMatch(workflow, /UPSTASH|KV_REST_API|REDIS_REST_API/u);
  const paidBackendStep = workflow.match(
    /- name: Start the paid preview branch backend[\s\S]*?(?=\n\s+- name:)/u,
  )?.[0] || "";
  assert.match(paidBackendStep, /PRIVATE_EVALUATION_RUN_ID: \$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ github\.sha \}\}/u);
  assert.match(paidBackendStep, /PRIVATE_EVALUATION_MODE: "true"/u);
  assert.match(paidBackendStep, /PRIVATE_EVALUATION_DIAGNOSTICS: "true"/u);
  assert.match(paidBackendStep, /PRIVATE_EVALUATION_BUDGET_USD: "40"/u);
  assert.match(paidBackendStep, /PRIVATE_EVALUATION_AUXILIARY_BUDGET_CNY: "10"/u);
  const retrievalBackendStep = workflow.match(
    /- name: Start the retrieval-only preview backend without a paid key[\s\S]*?(?=\n\s+- name:)/u,
  )?.[0] || "";
  assert.doesNotMatch(retrievalBackendStep, /PRIVATE_EVALUATION_MODE|PRIVATE_EVALUATION_(?:AUXILIARY_)?BUDGET|PRIVATE_EVALUATION_RUN_ID/u);
});

test("public artifact has only aggregate completion, latency and cost metadata", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /pure-llm-private-public-report\.json/u);
  assert.match(workflow, /test -s artifacts\/pure-llm-private-public-report\.json/u);
  assert.match(workflow, /const forbiddenKeys = new Set/u);
  assert.match(workflow, /id: public_report_privacy/u);
  assert.match(workflow, /const assertExactKeys = \(value, allowed, label\)/u);
  assert.match(workflow, /approved anonymous aggregate schema/u);
  assert.match(workflow, /assertExactKeys\(report\.summary\.latencyMs\.generation,[\s\S]*"count", "average", "p50", "p95", "min", "max"/u);
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
  assert.match(workflow, /const expectedGenerated = retrievalOnly \? 0 : Number\(process\.env\.EVALUATION_LIMIT\)/u);
  assert.match(workflow, /const expectedFailed = retrievalOnly \? Number\(process\.env\.EVALUATION_LIMIT\) : 0/u);
  assert.match(workflow, /retention-days: 1/u);
  const publicUploadStep = workflow.match(
    /- name: Upload the anonymous aggregate report[\s\S]*?(?=\n\s+- name:)/u,
  )?.[0] || "";
  assert.match(publicUploadStep, /if: always\(\) && steps\.public_report_privacy\.outcome == 'success'/u);
});

test("private questions, references and candidates are encrypted before upload", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /umask 077/u);
  assert.match(workflow, /base64 --decode > "\$RUNNER_TEMP\/private-dataset\.txt"/u);
  assert.match(workflow, /parseDatasetText/u);
  assert.match(workflow, /reportText\.includes\(item\.question\)/u);
  assert.match(workflow, /reportText\.includes\(item\.referenceAnswer\)/u);
  assert.match(workflow, /openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000/u);
  assert.match(workflow, /- name: Encrypt the private diagnostic checkpoint[\s\S]*id: private_archive/u);
  assert.match(workflow, /verification_archive="\$RUNNER_TEMP\/pure-llm-private-checkpoint\.verify\.tar\.gz"/u);
  assert.match(workflow, /trap 'rm -f "\$verification_archive"' EXIT/u);
  assert.match(workflow, /openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000[\s\S]*-in artifacts\/pure-llm-private-checkpoint\.tar\.gz\.enc[\s\S]*-out "\$verification_archive"/u);
  assert.match(workflow, /tar -tzf "\$verification_archive" > \/dev\/null/u);
  assert.match(workflow, /rm -f "\$verification_archive"[\s\S]*trap - EXIT/u);
  assert.match(workflow, /PRIVATE_ARCHIVE_KEY: \$\{\{ secrets\.PURE_LLM_EVALUATION_ARCHIVE_KEY \}\}/u);
  assert.match(workflow, /\$\{#PRIVATE_ARCHIVE_KEY\}.*-lt 32/u);
  assert.doesNotMatch(workflow, /archive_key="\$\(sha256sum/u);
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

  const encryptedUploadStep = workflow.match(
    /- name: Upload the encrypted diagnostic checkpoint[\s\S]*?(?=\n\s+- name:)/u,
  )?.[0] || "";
  assert.match(encryptedUploadStep, /if: always\(\) && steps\.private_archive\.outcome == 'success'/u);
  assert.match(encryptedUploadStep, /path: artifacts\/pure-llm-private-checkpoint\.tar\.gz\.enc/u);
  assert.match(encryptedUploadStep, /if-no-files-found: error/u);

  const cleanupStep = workflow.match(
    /- name: Stop the preview branch backend and scrub plaintext[\s\S]*?(?=\n\s+- name:)/u,
  )?.[0] || "";
  assert.match(cleanupStep, /if \[ ! -s artifacts\/pure-llm-private-checkpoint\.tar\.gz\.enc \]; then/u);
  assert.match(cleanupStep, /archive_missing=1/u);
  assert.match(cleanupStep, /kill "\$backend_pid" 2>\/dev\/null \|\| true/u);
  assert.match(cleanupStep, /for _ in \$\(seq 1 50\); do[\s\S]*kill -0 "\$backend_pid"[\s\S]*sleep 0\.1/u);
  assert.match(cleanupStep, /if kill -0 "\$backend_pid"[\s\S]*kill -KILL "\$backend_pid"/u);
  assert.match(cleanupStep, /kill -KILL[\s\S]*rm -rf[\s\S]*exit "\$archive_missing"/u);
});
