import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "../.github/workflows/direct-relay-sol-true-lua-ablation.yml",
  import.meta.url,
);

test("true Lua ablation builds one frozen source and makes exactly four serial generation calls", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /four Sol low generations plus four independent Sol high judgments/iu);
  assert.match(workflow, /lua-return-to-hand-ablation-cases\.json/u);
  assert.match(workflow, /--bundle-output artifacts\/lua-ablation-source-bundle\.json/u);
  assert.match(workflow, /--model relay-gpt-5\.6-sol/u);
  assert.match(workflow, /--effort low/u);
  assert.equal(
    (workflow.match(/node scripts\/local-relay-effort-experiment\.mjs/gu) || []).length,
    2,
  );
  assert.equal((workflow.match(/--max-calls 2/gu) || []).length, 1);
  assert.equal(
    (workflow.match(/--case double-tempest-impermanence(?:\s|$)/gu) || []).length,
    1,
  );
  assert.equal(
    (workflow.match(/--case double-tempest-impermanence-extra-returnable/gu) || []).length,
    1,
  );
  assert.match(workflow, /--evidence-variant card_text_only/u);
  assert.match(workflow, /--evidence-variant card_text_plus_lua/u);
  assert.doesNotMatch(workflow, /strategy:|matrix:|parallel|--retries|for\s+attempt/iu);
  assert.doesNotMatch(workflow, /UPSTASH|KV_REST|REDIS|ADMIN_MODEL_LAB/iu);

  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(secrets)], ["RELAY_API_KEY"]);
});

test("true Lua ablation seals candidates before a fixed independent Sol high judge", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  const generationIndex = workflow.indexOf("Generate and checkpoint exactly four Sol low candidates sequentially");
  const sealIndex = workflow.indexOf("Seal all candidates before opening private reference answers");
  const judgeIndex = workflow.indexOf("Judge the sealed candidates independently with Sol high");
  assert.ok(generationIndex >= 0 && sealIndex > generationIndex && judgeIndex > sealIndex);
  assert.match(workflow, /node scripts\/judge-lua-ablation\.mjs/u);
  assert.match(workflow, /--checkpoint card_text_only=artifacts\/lua-ablation-card-text-only-checkpoint\.json/u);
  assert.match(workflow, /--checkpoint card_text_plus_lua=artifacts\/lua-ablation-card-text-plus-lua-checkpoint\.json/u);
  assert.match(workflow, /--bundle artifacts\/lua-ablation-source-bundle\.json/u);
  assert.match(workflow, /--private-output artifacts\/lua-ablation-private-judgments\.json/u);
  assert.match(workflow, /--public-output artifacts\/lua-ablation-public-summary\.json/u);
  assert.doesNotMatch(workflow, /score-admin-model-experiment|non-authoritative offline assertions/u);
  const uploadStep = workflow.slice(workflow.indexOf("Upload only the anonymous public aggregate"));
  assert.match(uploadStep, /path: artifacts\/lua-ablation-public-summary\.json/u);
  assert.doesNotMatch(uploadStep, /source-bundle|checkpoint|private-judgments/u);
});

test("true Lua ablation fails before payment unless the decisive Lua semantics are present", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  const preflightIndex = workflow.indexOf("Require a usable Twin Tempests Lua activation check");
  const paidIndex = workflow.indexOf("Generate and checkpoint exactly four Sol low candidates sequentially");
  assert.ok(preflightIndex >= 0 && paidIndex > preflightIndex);
  assert.match(workflow, /--cid 22130/u);
  assert.match(workflow, /--passcode 12197223/u);
  assert.match(workflow, /--atomic-operation RETURN_TO_HAND/u);
  assert.match(workflow, /--predicate-api Card\.IsAbleToHand/u);
  assert.match(workflow, /--selector-api Duel\.IsExistingMatchingCard/u);
  assert.match(workflow, /--required-minimum 1/u);
  assert.match(workflow, /LUA_ABLATION_GOLD_ONLY_CANARY_A/u);
  assert.match(workflow, /LUA_ABLATION_GOLD_ONLY_CANARY_B/u);
  assert.match(workflow, /golden leaked into source/u);
});
