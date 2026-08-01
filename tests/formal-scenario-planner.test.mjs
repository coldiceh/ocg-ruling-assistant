import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { planFormalScenario } from "../backend/formalScenarioPlanner.mjs";
import { materializeFixture } from "./helpers/formal-engine-mock.mjs";

const realFixture = JSON.parse(await readFile(new URL("./fixtures/formal-engine/real-three-card.json", import.meta.url), "utf8"));
const anonymousFixture = JSON.parse(await readFile(new URL("./fixtures/formal-engine/anonymous-equivalent.json", import.meta.url), "utf8"));

function planFixture(fixture) {
  const input = materializeFixture(fixture);
  return planFormalScenario({ scenarioDraft: input.draft, userQuery: input.question, resolvedCards: input.resolvedCards });
}

test("real three-card fixture produces two independent formal queries with exact source bindings", () => {
  const result = planFixture(realFixture);
  assert.equal(result.kind, "READY");
  assert.deepEqual(result.scenario.queries.map((query) => query.queryId), ["q1-summon-procedure", "q2-hand-trigger"]);
  assert.equal(result.scenario.intents[0].type, "TRY_SUMMON_PROCEDURE");
  assert.equal(result.scenario.branchPolicy.preserveUnspecifiedResponses, true);
  assert.equal(result.scenario.definitionSnapshot.snapshotId, "fixture:formal-definitions:v1");
  assert.match(result.scenario.definitionSnapshot.manifestSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.scenario.cardInstances.every((instance) => /^[a-f0-9]{64}$/u.test(instance.definitionBinding.contentSha256)), true);
  assert.equal(result.scenario.cardInstances.every((instance) => Number.isInteger(instance.objectEpoch)), true);
  for (const item of [...result.scenario.cardInstances, ...result.scenario.queries, ...result.scenario.intents]) {
    assert.equal(result.scenario.question.text.slice(item.sourceSpan.start, item.sourceSpan.end), item.sourceSpan.text);
  }
});

test("anonymous equivalent fixture plans the same mechanisms without card-name branches", () => {
  const real = planFixture(realFixture).scenario;
  const anonymous = planFixture(anonymousFixture).scenario;
  assert.deepEqual(anonymous.queries.map((query) => query.predicate), real.queries.map((query) => query.predicate));
  assert.deepEqual(anonymous.requiredCapabilities, real.requiredCapabilities);
  assert.equal(anonymous.cardInstances.length, real.cardInstances.length);
  assert.equal(anonymous.eventHistory.length, real.eventHistory.length);
});

test("ambiguous card binding remains UNKNOWN instead of guessing a definition", () => {
  const input = materializeFixture(anonymousFixture);
  input.resolvedCards.push(structuredClone(input.resolvedCards[0]));
  const result = planFormalScenario({ scenarioDraft: input.draft, userQuery: input.question, resolvedCards: input.resolvedCards });
  assert.equal(result.kind, "UNKNOWN");
  assert.equal(result.unknownReasons[0].code, "AMBIGUOUS_CARD_BINDING");
});

test("missing strict state and authored engine conclusions remain UNKNOWN", () => {
  const missing = materializeFixture(anonymousFixture);
  missing.draft.missingStateFacts = ["opponent response policy"];
  const missingResult = planFormalScenario({ scenarioDraft: missing.draft, userQuery: missing.question, resolvedCards: missing.resolvedCards });
  assert.equal(missingResult.kind, "UNKNOWN");
  assert.equal(missingResult.unknownReasons[0].code, "MISSING_STATE_FACT");

  const authored = materializeFixture(anonymousFixture);
  authored.draft.stateFacts[0].banishedByCardEffect = true;
  const authoredResult = planFormalScenario({ scenarioDraft: authored.draft, userQuery: authored.question, resolvedCards: authored.resolvedCards });
  assert.equal(authoredResult.kind, "UNKNOWN");
  assert.equal(authoredResult.unknownReasons[0].code, "UNTRUSTED_DERIVED_FACT");

  const authoredType = materializeFixture(anonymousFixture);
  authoredType.draft.stateFacts[0].type = "BANISHED_BY_CARD_EFFECT";
  const authoredTypeResult = planFormalScenario({ scenarioDraft: authoredType.draft, userQuery: authoredType.question, resolvedCards: authoredType.resolvedCards });
  assert.equal(authoredTypeResult.kind, "UNKNOWN");
  assert.equal(authoredTypeResult.unknownReasons[0].code, "UNTRUSTED_DERIVED_FACT");
});

test("input provenance, references, and immutable definition snapshots fail closed", () => {
  const missingProvenance = materializeFixture(anonymousFixture);
  delete missingProvenance.draft.stateFacts[0].provenance;
  const missingProvenanceResult = planFormalScenario({
    scenarioDraft: missingProvenance.draft,
    userQuery: missingProvenance.question,
    resolvedCards: missingProvenance.resolvedCards,
  });
  assert.equal(missingProvenanceResult.kind, "UNKNOWN");

  const injectedConclusion = materializeFixture(anonymousFixture);
  injectedConclusion.draft.stateFacts[0].legal = true;
  const injectedConclusionResult = planFormalScenario({
    scenarioDraft: injectedConclusion.draft,
    userQuery: injectedConclusion.question,
    resolvedCards: injectedConclusion.resolvedCards,
  });
  assert.equal(injectedConclusionResult.kind, "UNKNOWN");
  assert.equal(injectedConclusionResult.unknownReasons[0].code, "UNTRUSTED_DERIVED_FACT");

  const wrongProvenance = materializeFixture(anonymousFixture);
  wrongProvenance.draft.stateFacts[0].provenance = "PRINTED_TEXT";
  const wrongProvenanceResult = planFormalScenario({
    scenarioDraft: wrongProvenance.draft,
    userQuery: wrongProvenance.question,
    resolvedCards: wrongProvenance.resolvedCards,
  });
  assert.equal(wrongProvenanceResult.kind, "UNKNOWN");
  assert.equal(wrongProvenanceResult.unknownReasons[0].code, "UNTRUSTED_DERIVED_FACT");

  const unknownEvent = materializeFixture(anonymousFixture);
  unknownEvent.draft.eventHistory[0].type = "DERIVED_CHAIN_RESULT";
  const unknownEventResult = planFormalScenario({
    scenarioDraft: unknownEvent.draft,
    userQuery: unknownEvent.question,
    resolvedCards: unknownEvent.resolvedCards,
  });
  assert.equal(unknownEventResult.kind, "UNKNOWN");
  assert.equal(unknownEventResult.unknownReasons[0].code, "UNTRUSTED_DERIVED_FACT");

  const badReference = materializeFixture(anonymousFixture);
  badReference.draft.intents[0].actorInstanceId = "missing@0";
  const badReferenceResult = planFormalScenario({
    scenarioDraft: badReference.draft,
    userQuery: badReference.question,
    resolvedCards: badReference.resolvedCards,
  });
  assert.equal(badReferenceResult.kind, "UNKNOWN");
  assert.equal(badReferenceResult.unknownReasons[0].code, "FORMAL_REFERENCE_INVALID");

  const cyclicQueries = materializeFixture(anonymousFixture);
  cyclicQueries.draft.queries[0].dependsOn = ["q2-hand-trigger"];
  const cyclicQueriesResult = planFormalScenario({
    scenarioDraft: cyclicQueries.draft,
    userQuery: cyclicQueries.question,
    resolvedCards: cyclicQueries.resolvedCards,
  });
  assert.equal(cyclicQueriesResult.kind, "UNKNOWN");
  assert.equal(cyclicQueriesResult.unknownReasons[0].code, "FORMAL_REFERENCE_INVALID");

  const printedReference = materializeFixture(anonymousFixture);
  printedReference.draft.stateFacts[0] = {
    factId: "printed-effect-reference",
    type: "PRINTED_EFFECT_REFERENCE",
    provenance: "PRINTED_TEXT",
    definitionRef: { cardId: "card-c", effectId: "effect-1" },
    sourceSpan: structuredClone(printedReference.draft.stateFacts[0].sourceSpan),
  };
  const printedReferenceResult = planFormalScenario({
    scenarioDraft: printedReference.draft,
    userQuery: printedReference.question,
    resolvedCards: printedReference.resolvedCards,
  });
  assert.equal(printedReferenceResult.kind, "READY");
  printedReference.draft.stateFacts[0].definitionRef.effectId = "missing-effect";
  const badPrintedReferenceResult = planFormalScenario({
    scenarioDraft: printedReference.draft,
    userQuery: printedReference.question,
    resolvedCards: printedReference.resolvedCards,
  });
  assert.equal(badPrintedReferenceResult.kind, "UNKNOWN");
  assert.equal(badPrintedReferenceResult.unknownReasons[0].code, "FORMAL_REFERENCE_INVALID");

  const mixedSnapshot = materializeFixture(anonymousFixture);
  mixedSnapshot.resolvedCards[1].formalDefinitionSnapshotId = "fixture:other-snapshot:v1";
  const mixedSnapshotResult = planFormalScenario({
    scenarioDraft: mixedSnapshot.draft,
    userQuery: mixedSnapshot.question,
    resolvedCards: mixedSnapshot.resolvedCards,
  });
  assert.equal(mixedSnapshotResult.kind, "UNKNOWN");
  assert.equal(mixedSnapshotResult.unknownReasons[0].code, "FORMAL_DEFINITION_SNAPSHOT_INVALID");
});

test("production formal planner contains no real-fixture card names", async () => {
  const source = await readFile(new URL("../backend/formalScenarioPlanner.mjs", import.meta.url), "utf8");
  for (const name of ["混沌の黒魔術師", "滅びの黒魔術師", "深淵の相剣龍"]) assert.equal(source.includes(name), false);
});
