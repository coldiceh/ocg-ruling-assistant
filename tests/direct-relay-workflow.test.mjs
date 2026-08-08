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
  assert.match(workflow, /direct-relay-sol-scored\.json/u);
  assert.match(workflow, /none-low-medium/u);
  assert.match(workflow, /all-six/u);
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
