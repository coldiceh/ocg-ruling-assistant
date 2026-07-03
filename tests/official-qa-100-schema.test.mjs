import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaUrl = new URL("./fixtures/official-qa-100/benchmark.schema.json", import.meta.url);

test("official QA benchmark schema fixes the corpus at exactly 100 cases", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.properties.targetCaseCount.const, 100);
  assert.equal(schema.properties.cases.minItems, 100);
  assert.equal(schema.properties.cases.maxItems, 100);
  assert.deepEqual(schema.$defs.case.required, ["id", "category", "inputText", "snapshot", "request", "expected", "provenance"]);
});

test("official QA benchmark case schema records route order and safety expectations", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  const expected = schema.$defs.case.properties.expected;
  assert.deepEqual(expected.properties.answerRoute.enum, [
    "official_qa_exact_match",
    "official_qa_near_case_match",
    "rule_engine_answer",
    "conditional_branch_answer",
    "insufficient",
  ]);
  assert.ok(expected.required.includes("mustCallTemplate"));
  assert.ok(expected.required.includes("mustCallModel"));
  assert.deepEqual(Object.keys(expected.properties.dangerousFailures.properties), [
    "unsafeConfirmed",
    "illegalChainEnteredResolution",
    "cardMisidentifiedWithoutWarning",
    "llmOverrideProgramVerdict",
  ]);
});
