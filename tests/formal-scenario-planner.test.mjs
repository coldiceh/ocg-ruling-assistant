import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { planFormalScenario } from "../backend/formalScenarioPlanner.mjs";
import { materializeFixture, sourceSpanFor } from "./helpers/formal-engine-mock.mjs";

const realFixture = JSON.parse(await readFile(new URL("./fixtures/formal-engine/real-three-card.json", import.meta.url), "utf8"));
const anonymousFixture = JSON.parse(await readFile(new URL("./fixtures/formal-engine/anonymous-equivalent.json", import.meta.url), "utf8"));

function planFixture(fixture) {
  const input = materializePlannerFixture(fixture);
  return planFormalScenario({ scenarioDraft: input.draft, userQuery: input.question, resolvedCards: input.resolvedCards });
}

function materializePlannerFixture(fixture) {
  const input = materializeFixture(fixture);
  const wrappers = new Map([["「", "」"], ["『", "』"], ["“", "”"], ["‘", "’"], ["\"", "\""], ["《", "》"], ["〈", "〉"], ["【", "】"], ["[", "]"]]);
  for (const instance of input.draft.cardInstances) {
    const card = input.resolvedCards.find((candidate) => String(candidate.cardId ?? candidate.id) === String(instance.cardId));
    if (!card) continue;
    const mention = instance.sourceSpan.text;
    const exactInput = wrappers.get(mention[0]) === mention.at(-1) ? mention.slice(1, -1) : mention;
    card.input = exactInput;
    card.name = exactInput;
    card.aliases = [...new Set([...(card.aliases || []), exactInput])];
  }
  return input;
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

test("the original under-specified wording remains STRICT UNKNOWN instead of inheriting fixture defaults", () => {
  for (const sourceFixture of [realFixture, anonymousFixture]) {
    const underSpecified = structuredClone(sourceFixture);
    underSpecified.question = underSpecified.originalQuestion;
    underSpecified.draft.stateFacts = underSpecified.draft.stateFacts.filter(
      (fact) => fact.factId !== "self-monster-zone-capacity",
    );
    underSpecified.draft.stateFacts[0].mention = "本回合自己已经发动过魔法卡的效果";
    underSpecified.draft.eventHistory[0].mention = "已经发动过魔法卡的效果";
    underSpecified.draft.missingStateFacts = [
      "active-turn-and-open-action-window",
      "exact-face-up-position-or-complete-position-branch",
      "available-monster-zone",
      "relevant-effect-usage-and-other-applicable-effects",
    ];

    const result = planFixture(underSpecified);
    assert.equal(result.kind, "UNKNOWN");
    assert.equal(result.unknownReasons[0].code, "MISSING_STATE_FACT");
    assert.deepEqual(
      result.unknownReasons[0].details.missingStateFacts,
      underSpecified.draft.missingStateFacts,
    );
  }
});

test("ambiguous card binding remains UNKNOWN instead of guessing a definition", () => {
  const input = materializePlannerFixture(anonymousFixture);
  input.resolvedCards.push(structuredClone(input.resolvedCards[0]));
  const result = planFormalScenario({ scenarioDraft: input.draft, userQuery: input.question, resolvedCards: input.resolvedCards });
  assert.equal(result.kind, "UNKNOWN");
  assert.equal(result.unknownReasons[0].code, "AMBIGUOUS_CARD_BINDING");
});

test("card instance ids cannot be detached from their exact resolved-card mentions", () => {
  const swappedIds = materializePlannerFixture(anonymousFixture);
  const firstCardId = swappedIds.draft.cardInstances[0].cardId;
  swappedIds.draft.cardInstances[0].cardId = swappedIds.draft.cardInstances[1].cardId;
  swappedIds.draft.cardInstances[1].cardId = firstCardId;
  const swappedIdsResult = planFormalScenario({
    scenarioDraft: swappedIds.draft,
    userQuery: swappedIds.question,
    resolvedCards: swappedIds.resolvedCards,
  });
  assert.equal(swappedIdsResult.kind, "UNKNOWN");
  assert.equal(swappedIdsResult.unknownReasons[0].code, "FORMAL_CARD_MENTION_MISMATCH");

  const swappedSpans = materializePlannerFixture(anonymousFixture);
  const firstSpan = swappedSpans.draft.cardInstances[0].sourceSpan;
  swappedSpans.draft.cardInstances[0].sourceSpan = swappedSpans.draft.cardInstances[1].sourceSpan;
  swappedSpans.draft.cardInstances[1].sourceSpan = firstSpan;
  const swappedSpansResult = planFormalScenario({
    scenarioDraft: swappedSpans.draft,
    userQuery: swappedSpans.question,
    resolvedCards: swappedSpans.resolvedCards,
  });
  assert.equal(swappedSpansResult.kind, "UNKNOWN");
  assert.equal(swappedSpansResult.unknownReasons[0].code, "FORMAL_CARD_MENTION_MISMATCH");

  const collidingAlias = materializePlannerFixture(anonymousFixture);
  collidingAlias.resolvedCards[1].aliases.push(collidingAlias.resolvedCards[0].name);
  const collidingAliasResult = planFormalScenario({
    scenarioDraft: collidingAlias.draft,
    userQuery: collidingAlias.question,
    resolvedCards: collidingAlias.resolvedCards,
  });
  assert.equal(collidingAliasResult.kind, "UNKNOWN");
  assert.equal(collidingAliasResult.unknownReasons[0].code, "AMBIGUOUS_CARD_MENTION");
});

test("immutable definitions bind every printed effect even when the draft omits ids", () => {
  const input = materializePlannerFixture(anonymousFixture);
  input.draft.cardInstances[1].effectIds = [];
  const result = planFormalScenario({
    scenarioDraft: input.draft,
    userQuery: input.question,
    resolvedCards: input.resolvedCards,
  });
  assert.equal(result.kind, "READY");
  const instance = result.scenario.cardInstances.find((item) => item.instanceId === "card-b@0");
  assert.deepEqual(
    instance.effectBindings.map((item) => item.effectId),
    input.resolvedCards[1].formalEffects.map((item) => item.effectId).sort(),
  );
});

test("explicit numbered effects bind to the named card instead of draft-reported effect ids", () => {
  const swappedEffect = materializePlannerFixture(anonymousFixture);
  addFixtureEffect(swappedEffect, "card-c@0", "effect-2", "8");
  swappedEffect.draft.queries[1].effectId = "effect-2";
  const swappedEffectResult = planFormalScenario({
    scenarioDraft: swappedEffect.draft,
    userQuery: swappedEffect.question,
    resolvedCards: swappedEffect.resolvedCards,
  });
  assert.equal(swappedEffectResult.kind, "UNKNOWN");
  assert.equal(swappedEffectResult.unknownReasons[0].code, "FORMAL_EFFECT_MENTION_MISMATCH");

  const swappedSubject = materializePlannerFixture(anonymousFixture);
  addFixtureEffect(swappedSubject, "card-b@0", "effect-1", "9");
  swappedSubject.draft.queries[1].subjectInstanceId = "card-b@0";
  const swappedSubjectResult = planFormalScenario({
    scenarioDraft: swappedSubject.draft,
    userQuery: swappedSubject.question,
    resolvedCards: swappedSubject.resolvedCards,
  });
  assert.equal(swappedSubjectResult.kind, "UNKNOWN");
  assert.equal(swappedSubjectResult.unknownReasons[0].code, "FORMAL_EFFECT_MENTION_MISMATCH");

  const eventMismatch = materializePlannerFixture(anonymousFixture);
  addFixtureEffect(eventMismatch, "card-c@0", "effect-2", "a");
  const eventText = "随后「怪兽丙」的②效果发动";
  appendQuestionText(eventMismatch, `，${eventText}。`);
  eventMismatch.draft.eventHistory[0] = {
    eventId: "numbered-effect-event",
    type: "CARD_ACTIVATED",
    provenance: "USER_OBSERVED",
    player: "SELF",
    subjectInstanceId: "card-c@0",
    effectId: "effect-1",
    sourceSpan: sourceSpanFor(eventMismatch.question, eventText),
  };
  const eventMismatchResult = planFormalScenario({
    scenarioDraft: eventMismatch.draft,
    userQuery: eventMismatch.question,
    resolvedCards: eventMismatch.resolvedCards,
  });
  assert.equal(eventMismatchResult.kind, "UNKNOWN");
  assert.equal(eventMismatchResult.unknownReasons[0].code, "FORMAL_EFFECT_MENTION_MISMATCH");

  const intentMismatch = materializePlannerFixture(anonymousFixture);
  addFixtureEffect(intentMismatch, "card-b@0", "effect-1", "b");
  const intentText = "尝试发动「怪兽乙」的②效果";
  appendQuestionText(intentMismatch, `，${intentText}。`);
  intentMismatch.draft.intents[0].procedureId = "effect-1";
  intentMismatch.draft.intents[0].sourceSpan = sourceSpanFor(intentMismatch.question, intentText);
  const intentMismatchResult = planFormalScenario({
    scenarioDraft: intentMismatch.draft,
    userQuery: intentMismatch.question,
    resolvedCards: intentMismatch.resolvedCards,
  });
  assert.equal(intentMismatchResult.kind, "UNKNOWN");
  assert.equal(intentMismatchResult.unknownReasons[0].code, "FORMAL_EFFECT_MENTION_MISMATCH");
});

test("anaphoric effect references remain UNKNOWN when no exact numbered mention can bind them", () => {
  const input = materializePlannerFixture(anonymousFixture);
  const anaphoricText = "之后可以发动该效果吗";
  appendQuestionText(input, `，${anaphoricText}？`);
  input.draft.queries[1].sourceSpan = sourceSpanFor(input.question, anaphoricText);
  const result = planFormalScenario({
    scenarioDraft: input.draft,
    userQuery: input.question,
    resolvedCards: input.resolvedCards,
  });
  assert.equal(result.kind, "UNKNOWN");
  assert.equal(result.unknownReasons[0].code, "FORMAL_EFFECT_MENTION_UNVERIFIED");
});

test("chain-order effect bindings preserve textual order and duplicate occurrences", () => {
  const ordered = materializePlannerFixture(anonymousFixture);
  const orderedText = "「怪兽乙」的②效果连锁「怪兽丙」的①效果";
  appendQuestionText(ordered, `，${orderedText}。`);
  ordered.draft.queries[1] = {
    queryId: "q2-chain-order",
    predicate: "CHAIN_ORDER_VALID",
    chainCandidates: [
      { instanceId: "card-b@0", effectId: "effect-2" },
      { instanceId: "card-c@0", effectId: "effect-1" },
    ],
    dependsOn: ["q1-summon-procedure"],
    sourceSpan: sourceSpanFor(ordered.question, orderedText),
  };
  const orderedResult = planFormalScenario({
    scenarioDraft: ordered.draft,
    userQuery: ordered.question,
    resolvedCards: ordered.resolvedCards,
  });
  assert.equal(orderedResult.kind, "READY");

  const reversed = structuredClone(ordered);
  reversed.draft.queries[1].chainCandidates.reverse();
  const reversedResult = planFormalScenario({
    scenarioDraft: reversed.draft,
    userQuery: reversed.question,
    resolvedCards: reversed.resolvedCards,
  });
  assert.equal(reversedResult.kind, "UNKNOWN");
  assert.equal(reversedResult.unknownReasons[0].code, "FORMAL_EFFECT_MENTION_MISMATCH");

  const duplicated = materializePlannerFixture(anonymousFixture);
  const duplicatedText = "「怪兽乙」的②效果连锁「怪兽乙」的②效果";
  appendQuestionText(duplicated, `，${duplicatedText}。`);
  duplicated.draft.queries[1] = {
    queryId: "q2-chain-order",
    predicate: "CHAIN_ORDER_VALID",
    chainCandidates: [{ instanceId: "card-b@0", effectId: "effect-2" }],
    dependsOn: ["q1-summon-procedure"],
    sourceSpan: sourceSpanFor(duplicated.question, duplicatedText),
  };
  const duplicatedResult = planFormalScenario({
    scenarioDraft: duplicated.draft,
    userQuery: duplicated.question,
    resolvedCards: duplicated.resolvedCards,
  });
  assert.equal(duplicatedResult.kind, "UNKNOWN");
  assert.equal(duplicatedResult.unknownReasons[0].code, "FORMAL_EFFECT_MENTION_MISMATCH");
});

test("an unquoted short alias cannot bind inside a longer resolved card name", () => {
  const embedded = materializePlannerFixture(anonymousFixture);
  embedded.resolvedCards[1].aliases.push("怪兽");
  appendQuestionText(embedded, "，怪兽甲。");
  const embeddedStart = embedded.question.lastIndexOf("怪兽甲");
  embedded.draft.cardInstances[1].sourceSpan = {
    encoding: embedded.draft.cardInstances[1].sourceSpan.encoding,
    start: embeddedStart,
    end: embeddedStart + "怪兽".length,
    text: "怪兽",
  };
  const embeddedResult = planFormalScenario({
    scenarioDraft: embedded.draft,
    userQuery: embedded.question,
    resolvedCards: embedded.resolvedCards,
  });
  assert.equal(embeddedResult.kind, "UNKNOWN");
  assert.equal(embeddedResult.unknownReasons[0].code, "FORMAL_CARD_MENTION_UNVERIFIED");

  const standalone = materializePlannerFixture(anonymousFixture);
  standalone.resolvedCards[1].aliases.push("怪兽");
  appendQuestionText(standalone, "，怪兽。");
  const standaloneStart = standalone.question.lastIndexOf("怪兽");
  standalone.draft.cardInstances[1].sourceSpan = {
    encoding: standalone.draft.cardInstances[1].sourceSpan.encoding,
    start: standaloneStart,
    end: standaloneStart + "怪兽".length,
    text: "怪兽",
  };
  const standaloneResult = planFormalScenario({
    scenarioDraft: standalone.draft,
    userQuery: standalone.question,
    resolvedCards: standalone.resolvedCards,
  });
  assert.equal(standaloneResult.kind, "READY");
});

test("entity references bind to an exact card mention inside their own source span", () => {
  const multiMention = materializePlannerFixture(anonymousFixture);
  const multiMentionResult = planFormalScenario({
    scenarioDraft: multiMention.draft,
    userQuery: multiMention.question,
    resolvedCards: multiMention.resolvedCards,
  });
  assert.equal(multiMentionResult.kind, "READY");

  const cases = [
    {
      mutate(input) {
        input.draft.stateFacts[0] = {
          factId: "card-present",
          type: "CARD_PRESENT",
          provenance: "USER_OBSERVED",
          subjectInstanceId: "card-a@0",
          value: true,
          sourceSpan: structuredClone(input.draft.eventHistory[0].sourceSpan),
        };
      },
      code: "FORMAL_CARD_MENTION_UNVERIFIED",
    },
    {
      mutate(input) {
        input.draft.eventHistory[0].subjectInstanceId = "card-a@0";
      },
      code: "FORMAL_CARD_MENTION_UNVERIFIED",
    },
    {
      mutate(input) {
        input.draft.intents[0].sourceSpan = structuredClone(input.draft.cardInstances[0].sourceSpan);
      },
      code: "FORMAL_CARD_MENTION_MISMATCH",
    },
    {
      mutate(input) {
        input.draft.queries[0].sourceSpan = structuredClone(input.draft.cardInstances[0].sourceSpan);
      },
      code: "FORMAL_CARD_MENTION_MISMATCH",
    },
  ];
  for (const item of cases) {
    const input = materializePlannerFixture(anonymousFixture);
    item.mutate(input);
    const result = planFormalScenario({
      scenarioDraft: input.draft,
      userQuery: input.question,
      resolvedCards: input.resolvedCards,
    });
    assert.equal(result.kind, "UNKNOWN");
    assert.equal(result.unknownReasons[0].code, item.code);
  }
});

test("missingStateFacts is a required array of non-empty strings", () => {
  const valid = materializePlannerFixture(anonymousFixture);
  valid.draft.missingStateFacts = [];
  assert.equal(planFormalScenario({
    scenarioDraft: valid.draft,
    userQuery: valid.question,
    resolvedCards: valid.resolvedCards,
  }).kind, "READY");

  const invalidValues = [
    undefined,
    "missing-state",
    {},
    [""],
    ["   "],
    [null],
    [1],
    [{}],
  ];
  for (const invalidValue of invalidValues) {
    const input = materializePlannerFixture(anonymousFixture);
    if (invalidValue === undefined) delete input.draft.missingStateFacts;
    else input.draft.missingStateFacts = invalidValue;
    const result = planFormalScenario({
      scenarioDraft: input.draft,
      userQuery: input.question,
      resolvedCards: input.resolvedCards,
    });
    assert.equal(result.kind, "UNKNOWN");
    assert.equal(result.unknownReasons[0].code, "FORMAL_SCENARIO_SCHEMA_INVALID");
  }
});

test("missing strict state and authored engine conclusions remain UNKNOWN", () => {
  const missing = materializePlannerFixture(anonymousFixture);
  missing.draft.missingStateFacts = ["opponent response policy"];
  const missingResult = planFormalScenario({ scenarioDraft: missing.draft, userQuery: missing.question, resolvedCards: missing.resolvedCards });
  assert.equal(missingResult.kind, "UNKNOWN");
  assert.equal(missingResult.unknownReasons[0].code, "MISSING_STATE_FACT");

  const authored = materializePlannerFixture(anonymousFixture);
  authored.draft.stateFacts[0].banishedByCardEffect = true;
  const authoredResult = planFormalScenario({ scenarioDraft: authored.draft, userQuery: authored.question, resolvedCards: authored.resolvedCards });
  assert.equal(authoredResult.kind, "UNKNOWN");
  assert.equal(authoredResult.unknownReasons[0].code, "UNTRUSTED_DERIVED_FACT");

  const authoredType = materializePlannerFixture(anonymousFixture);
  authoredType.draft.stateFacts[0].type = "BANISHED_BY_CARD_EFFECT";
  const authoredTypeResult = planFormalScenario({ scenarioDraft: authoredType.draft, userQuery: authoredType.question, resolvedCards: authoredType.resolvedCards });
  assert.equal(authoredTypeResult.kind, "UNKNOWN");
  assert.equal(authoredTypeResult.unknownReasons[0].code, "UNTRUSTED_DERIVED_FACT");

  for (const mutate of [
    (draft) => { draft.intents[0].opaqueOperationPlan = { value: true }; },
    (draft) => { draft.queries[0].predictedAnswer = "TRUE"; },
    (draft) => { draft.turn.priorityPassed = true; },
    (draft) => { draft.branchPolicy.selectedBranch = "yes"; },
  ]) {
    const closedSchema = materializePlannerFixture(anonymousFixture);
    mutate(closedSchema.draft);
    const closedSchemaResult = planFormalScenario({
      scenarioDraft: closedSchema.draft,
      userQuery: closedSchema.question,
      resolvedCards: closedSchema.resolvedCards,
    });
    assert.equal(closedSchemaResult.kind, "UNKNOWN");
    assert.equal(closedSchemaResult.unknownReasons[0].code, "UNTRUSTED_DERIVED_FACT");
  }
});

test("input provenance, references, and immutable definition snapshots fail closed", () => {
  const missingProvenance = materializePlannerFixture(anonymousFixture);
  delete missingProvenance.draft.stateFacts[0].provenance;
  const missingProvenanceResult = planFormalScenario({
    scenarioDraft: missingProvenance.draft,
    userQuery: missingProvenance.question,
    resolvedCards: missingProvenance.resolvedCards,
  });
  assert.equal(missingProvenanceResult.kind, "UNKNOWN");

  const injectedConclusion = materializePlannerFixture(anonymousFixture);
  injectedConclusion.draft.stateFacts[0].legal = true;
  const injectedConclusionResult = planFormalScenario({
    scenarioDraft: injectedConclusion.draft,
    userQuery: injectedConclusion.question,
    resolvedCards: injectedConclusion.resolvedCards,
  });
  assert.equal(injectedConclusionResult.kind, "UNKNOWN");
  assert.equal(injectedConclusionResult.unknownReasons[0].code, "UNTRUSTED_DERIVED_FACT");

  const wrongProvenance = materializePlannerFixture(anonymousFixture);
  wrongProvenance.draft.stateFacts[0].provenance = "PRINTED_TEXT";
  const wrongProvenanceResult = planFormalScenario({
    scenarioDraft: wrongProvenance.draft,
    userQuery: wrongProvenance.question,
    resolvedCards: wrongProvenance.resolvedCards,
  });
  assert.equal(wrongProvenanceResult.kind, "UNKNOWN");
  assert.equal(wrongProvenanceResult.unknownReasons[0].code, "UNTRUSTED_DERIVED_FACT");

  const unknownEvent = materializePlannerFixture(anonymousFixture);
  unknownEvent.draft.eventHistory[0].type = "DERIVED_CHAIN_RESULT";
  const unknownEventResult = planFormalScenario({
    scenarioDraft: unknownEvent.draft,
    userQuery: unknownEvent.question,
    resolvedCards: unknownEvent.resolvedCards,
  });
  assert.equal(unknownEventResult.kind, "UNKNOWN");
  assert.equal(unknownEventResult.unknownReasons[0].code, "UNTRUSTED_DERIVED_FACT");

  const badReference = materializePlannerFixture(anonymousFixture);
  badReference.draft.intents[0].actorInstanceId = "missing@0";
  const badReferenceResult = planFormalScenario({
    scenarioDraft: badReference.draft,
    userQuery: badReference.question,
    resolvedCards: badReference.resolvedCards,
  });
  assert.equal(badReferenceResult.kind, "UNKNOWN");
  assert.equal(badReferenceResult.unknownReasons[0].code, "FORMAL_REFERENCE_INVALID");

  const cyclicQueries = materializePlannerFixture(anonymousFixture);
  cyclicQueries.draft.queries[0].dependsOn = ["q2-hand-trigger"];
  const cyclicQueriesResult = planFormalScenario({
    scenarioDraft: cyclicQueries.draft,
    userQuery: cyclicQueries.question,
    resolvedCards: cyclicQueries.resolvedCards,
  });
  assert.equal(cyclicQueriesResult.kind, "UNKNOWN");
  assert.equal(cyclicQueriesResult.unknownReasons[0].code, "FORMAL_REFERENCE_INVALID");

  const printedReference = materializePlannerFixture(anonymousFixture);
  printedReference.draft.stateFacts[0] = {
    factId: "printed-effect-reference",
    type: "PRINTED_EFFECT_REFERENCE",
    provenance: "PRINTED_TEXT",
    definitionRef: { cardId: "card-c", effectId: "effect-1" },
    sourceSpan: structuredClone(printedReference.draft.cardInstances[2].sourceSpan),
  };
  const printedReferenceResult = planFormalScenario({
    scenarioDraft: printedReference.draft,
    userQuery: printedReference.question,
    resolvedCards: printedReference.resolvedCards,
  });
  assert.equal(printedReferenceResult.kind, "READY");
  const swappedPrintedReference = structuredClone(printedReference);
  swappedPrintedReference.draft.stateFacts[0].definitionRef.cardId = "card-b";
  swappedPrintedReference.draft.stateFacts[0].definitionRef.effectId = "effect-2";
  const swappedPrintedReferenceResult = planFormalScenario({
    scenarioDraft: swappedPrintedReference.draft,
    userQuery: swappedPrintedReference.question,
    resolvedCards: swappedPrintedReference.resolvedCards,
  });
  assert.equal(swappedPrintedReferenceResult.kind, "UNKNOWN");
  assert.equal(swappedPrintedReferenceResult.unknownReasons[0].code, "FORMAL_CARD_MENTION_MISMATCH");
  printedReference.draft.stateFacts[0].definitionRef.effectId = "missing-effect";
  const badPrintedReferenceResult = planFormalScenario({
    scenarioDraft: printedReference.draft,
    userQuery: printedReference.question,
    resolvedCards: printedReference.resolvedCards,
  });
  assert.equal(badPrintedReferenceResult.kind, "UNKNOWN");
  assert.equal(badPrintedReferenceResult.unknownReasons[0].code, "FORMAL_REFERENCE_INVALID");

  const mixedSnapshot = materializePlannerFixture(anonymousFixture);
  mixedSnapshot.resolvedCards[1].formalDefinitionSnapshotId = "fixture:other-snapshot:v1";
  const mixedSnapshotResult = planFormalScenario({
    scenarioDraft: mixedSnapshot.draft,
    userQuery: mixedSnapshot.question,
    resolvedCards: mixedSnapshot.resolvedCards,
  });
  assert.equal(mixedSnapshotResult.kind, "UNKNOWN");
  assert.equal(mixedSnapshotResult.unknownReasons[0].code, "FORMAL_DEFINITION_SNAPSHOT_INVALID");
});

test("formal input facts require domain-typed values and enumerated zones and positions", () => {
  const planWithFacts = (facts, mutateDraft) => {
    const input = materializePlannerFixture(anonymousFixture);
    const sourceSpan = structuredClone(input.draft.stateFacts[0].sourceSpan);
    const subjectSourceSpan = structuredClone(input.draft.cardInstances[0].sourceSpan);
    input.draft.stateFacts = facts.map((fact, index) => ({
      factId: `typed-fact-${index}`,
      provenance: "USER_OBSERVED",
      sourceSpan: structuredClone(fact.subjectInstanceId === undefined ? sourceSpan : subjectSourceSpan),
      ...fact,
    }));
    mutateDraft?.(input.draft);
    return planFormalScenario({
      scenarioDraft: input.draft,
      userQuery: input.question,
      resolvedCards: input.resolvedCards,
    });
  };

  const valid = planWithFacts([
    { type: "CARD_PRESENT", subjectInstanceId: "card-a@0", value: true },
    { type: "CARD_POSITION", subjectInstanceId: "card-a@0", position: "FACE_UP_ATTACK", value: true },
    { type: "LIFE_POINTS", player: "SELF", value: 8000 },
    { type: "ZONE_CAPACITY", player: "SELF", zone: "MONSTER_ZONE", value: 4 },
    { type: "PUBLIC_COUNTER_VALUE", subjectInstanceId: "card-a@0", counterName: "TEST", value: 2 },
    { type: "PUBLIC_CONTINUOUS_EFFECT_ACTIVE", subjectInstanceId: "card-a@0", effectId: "effect-3", value: false },
    { type: "SPELL_EFFECT_ACTIVATED_THIS_TURN", player: "SELF", value: true },
  ]);
  assert.equal(valid.kind, "READY");

  for (const facts of [
    [{ type: "CARD_PRESENT", subjectInstanceId: "card-a@0" }],
    [{ type: "CARD_POSITION", subjectInstanceId: "card-a@0", position: "FACE_UP_ATTACK" }],
    [{ type: "CARD_PRESENT", subjectInstanceId: "card-a@0", value: "false" }],
    [{ type: "CARD_POSITION", subjectInstanceId: "card-a@0", position: "FACE_UP_ATTACK", value: 1 }],
    [{ type: "PUBLIC_CONTINUOUS_EFFECT_ACTIVE", subjectInstanceId: "card-a@0", effectId: "effect-3", value: "true" }],
    [{ type: "SPELL_EFFECT_ACTIVATED_THIS_TURN", player: "SELF", value: 1 }],
    [{ type: "LIFE_POINTS", player: "SELF", value: "8000" }],
    [{ type: "ZONE_CAPACITY", player: "SELF", zone: "MONSTER_ZONE", value: 1.5 }],
    [{ type: "PUBLIC_COUNTER_VALUE", subjectInstanceId: "card-a@0", counterName: "TEST", value: -1 }],
    [{ type: "ZONE_CAPACITY", player: "SELF", zone: "UNKNOWN_ZONE", value: 1 }],
    [{ type: "CARD_POSITION", subjectInstanceId: "card-a@0", position: "ATTACK", value: true }],
  ]) {
    const result = planWithFacts(facts);
    assert.equal(result.kind, "UNKNOWN");
    assert.equal(result.unknownReasons[0].code, "FORMAL_SCENARIO_SCHEMA_INVALID");
  }

  for (const mutateDraft of [
    (draft) => { draft.cardInstances[0].zone = "UNKNOWN_ZONE"; },
    (draft) => { draft.cardInstances[0].position = "ATTACK"; },
  ]) {
    const result = planWithFacts([
      { type: "CARD_PRESENT", subjectInstanceId: "card-a@0", value: true },
    ], mutateDraft);
    assert.equal(result.kind, "UNKNOWN");
    assert.equal(result.unknownReasons[0].code, "FORMAL_SCENARIO_SCHEMA_INVALID");
  }
});

test("production formal path contains no real-fixture card names", async () => {
  const sources = await Promise.all([
    "../backend/formalScenarioPlanner.mjs",
    "../backend/formalScenarioDraftModel.mjs",
    "../backend/formalEngineShadow.mjs",
    "../backend/ragRulingPipeline.mjs",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of sources) {
    for (const name of ["混沌の黒魔術師", "滅びの黒魔術師", "深淵の相剣龍"]) assert.equal(source.includes(name), false);
  }
});

function addFixtureEffect(input, instanceId, effectId, digestCharacter) {
  const instance = input.draft.cardInstances.find((candidate) => candidate.instanceId === instanceId);
  assert.ok(instance);
  const card = input.resolvedCards.find((candidate) => String(candidate.cardId ?? candidate.id) === String(instance.cardId));
  assert.ok(card);
  if (!instance.effectIds.includes(effectId)) instance.effectIds.push(effectId);
  card.formalEffects.push({
    effectId,
    definitionEffectId: `fixture:${card.cardId}:${effectId}`,
    definitionEffectSha256: String(digestCharacter).repeat(64),
  });
}

function appendQuestionText(input, suffix) {
  input.question += suffix;
  input.draft.question.text = input.question;
}
