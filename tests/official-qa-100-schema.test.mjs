import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaUrl = new URL("./fixtures/official-qa-100/benchmark.schema.json", import.meta.url);

test("official QA benchmark schema fixes the corpus at exactly 100 cases", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.properties.targetCaseCount.const, 100);
  assert.equal(schema.properties.cases.minItems, 100);
  assert.equal(schema.properties.cases.maxItems, 100);
  for (const field of ["id", "userQuery", "expectedRoute", "expectedAnswerShape", "expectedConfirmationLevel", "expectedSafety", "sourceType", "involvedCards", "expectedKeyPoints", "forbiddenOutputs", "failureTags"]) {
    assert.ok(schema.$defs.case.required.includes(field), field);
  }
});

test("official QA benchmark case schema records route order and safety expectations", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  const caseSchema = schema.$defs.case.properties;
  assert.deepEqual(caseSchema.expectedRoute.enum, [
    "official_qa_exact_match",
    "official_qa_near_case_match",
    "rule_engine_answer",
    "conditional_branch_answer",
    "insufficient",
  ]);
  assert.deepEqual(Object.keys(caseSchema.expectedSafety.properties), [
    "unsafeConfirmed",
    "officialScopeMismatchUsedAsDirect",
    "wrongCardResolvedWithoutWarning",
    "llmOverrideProgramVerdict",
    "relatedEvidenceUsedAsOfficialDirect",
  ]);
});
