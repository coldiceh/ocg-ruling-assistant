import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readWorkflow = (name) =>
  readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

test("pages workflow is reusable and can publish an explicit ref", async () => {
  const workflow = await readWorkflow("deploy-pages.yml");

  assert.match(workflow, /^  workflow_call:\s*$/mu);
  assert.match(workflow, /^      checkout_ref:\s*$/mu);
  assert.match(workflow, /ref: \$\{\{ inputs\.checkout_ref \|\| github\.sha \}\}/u);
  assert.match(workflow, /^  group: pages\s*$/mu);
  assert.match(workflow, /^  pages: write\s*$/mu);
  assert.match(workflow, /^  id-token: write\s*$/mu);
});

test("successful data pushes explicitly call the Pages workflow", async () => {
  const workflow = await readWorkflow("sync-data.yml");

  assert.match(workflow, /^permissions: \{\}\s*$/mu);
  assert.match(workflow, /^      contents: write\s*$/mu);
  assert.match(workflow, /^      data_changed: \$\{\{ steps\.commit\.outputs\.data_changed \}\}\s*$/mu);
  assert.match(workflow, /git push origin HEAD:main[\s\S]*echo "data_changed=true" >> "\$GITHUB_OUTPUT"/u);
  assert.match(workflow, /echo "data_changed=false" >> "\$GITHUB_OUTPUT"/u);
  assert.match(workflow, /^    if: needs\.sync\.outputs\.data_changed == 'true'\s*$/mu);
  assert.match(workflow, /^    uses: \.\/\.github\/workflows\/deploy-pages\.yml\s*$/mu);
  assert.match(workflow, /^      checkout_ref: main\s*$/mu);
  assert.match(workflow, /^      pages: write\s*$/mu);
  assert.match(workflow, /^      id-token: write\s*$/mu);
});
