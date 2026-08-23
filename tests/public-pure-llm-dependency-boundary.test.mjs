import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PUBLIC_FILES = [
  "../backend/publicAnswerService.mjs",
  "../backend/ragRulingPipeline.mjs",
  "../backend/ragEvidenceRetriever.mjs",
  "../backend/ragModelClient.mjs",
  "../backend/ragRulingPrompt.mjs",
  "../backend/publicRagAnswerValidator.mjs",
];

const PROHIBITED_PUBLIC_MODULES = [
  "ocgEngineClient",
  "ocgScenarioPlanner",
  "formalEngineShadow",
  "formalScenarioDraftModel",
  "legacyLuaSemanticProduction",
  "legacyLuaSemanticPacket",
  "effectStateReasoner",
  "summonLegalityContext",
  "effectApplicabilityContext",
  "operationLegalityAnalyzer",
  "ruleScenarioCompiler",
];

const PROHIBITED_PUBLIC_SYMBOLS = [
  "callRulebookGroundingModel",
  "selectPriorityConstraintEvidence",
];

test("the public pure-LLM path has no engine, Lua, formal, or handwritten reasoner dependency", async () => {
  const sources = await Promise.all(PUBLIC_FILES.map((path) => (
    readFile(new URL(path, import.meta.url), "utf8")
  )));
  const combined = sources.join("\n");
  for (const moduleName of PROHIBITED_PUBLIC_MODULES) {
    assert.doesNotMatch(
      combined,
      new RegExp(`from\\s+["'][^"']*${moduleName}[^"']*["']`, "u"),
      `public path must not import ${moduleName}`,
    );
  }
  for (const symbol of PROHIBITED_PUBLIC_SYMBOLS) {
    assert.equal(
      combined.includes(symbol),
      false,
      `public path must not contain ${symbol}`,
    );
  }
});

test("the public pipeline keeps the established retrieval boundary and disables model repair", async () => {
  const source = await readFile(
    new URL("../backend/ragRulingPipeline.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /retrieveRagEvidence\s*\(\s*\{/u);
  assert.match(source, /buildRagRulingPromptBundle\s*\(\s*\{/u);
  assert.doesNotMatch(source, /runValidatedPublicRagFinal/u);
  assert.match(source, /outputMode:\s*"plain_text"/u);
  assert.match(source, /recoveryPrompt:\s*""/u);
});

test("the display adapter contains no ruling-polarity or question-shape validator", async () => {
  const source = await readFile(
    new URL("../backend/publicRagAnswerValidator.mjs", import.meta.url),
    "utf8",
  );
  for (const removedSymbol of [
    "buildPublicRagDirectedRepairPrompt",
    "buildSafePublicRagFallback",
    "applyOperationLegalityOverride",
    "applySemanticStateConstraint",
  ]) {
    assert.equal(source.includes(removedSymbol), false, removedSymbol);
  }
  assert.match(source, /rulingSemantics:\s*"not_evaluated"/u);
  assert.match(source, /callCount:\s*1/u);
  assert.match(source, /repairAttempted:\s*false/u);
});

test("public retrieval and prompt do not expose handwritten mechanism routing or engine identity hydration", async () => {
  const [retriever, prompt] = await Promise.all([
    readFile(new URL("../backend/ragEvidenceRetriever.mjs", import.meta.url), "utf8"),
    readFile(new URL("../backend/ragRulingPrompt.mjs", import.meta.url), "utf8"),
  ]);
  const publicRetrieverBody = retriever.slice(
    retriever.indexOf("export async function retrieveRagEvidence"),
    retriever.indexOf("export async function loadRagData"),
  );
  for (const prohibitedCall of [
    "retrieveGlobalMechanismOfficialQaAnalogues(",
    "reserveRelatedEvidenceCoverage(",
    "prioritizeOperationSubjectDefinitionFaqs(",
    "enginePasscodeRequired(",
  ]) {
    assert.equal(publicRetrieverBody.includes(prohibitedCall), false, prohibitedCall);
  }
  assert.doesNotMatch(publicRetrieverBody, /engine_passcode_baige_cid_/u);
  assert.match(publicRetrieverBody, /resolveUnresolvedMentionCardsWithBaige/u);
  assert.match(publicRetrieverBody, /searchOfficialQaEvidence/u);
  assert.match(publicRetrieverBody, /scopedRecordBuckets\.faq/u);

  for (const hiddenField of [
    "playerRoleCompatibility",
    "scenarioPremiseCompatibility",
    "queryApplicabilityFrame",
    "evidenceApplicabilityFrame",
  ]) {
    const serializationStart = prompt.indexOf("function prepareEvidenceForPrompt");
    assert.equal(prompt.slice(serializationStart).includes(hiddenField), false, hiddenField);
  }
});
