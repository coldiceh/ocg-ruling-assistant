import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAdminFinalEvidenceReady,
  inspectAdminFinalEvidenceReadiness,
} from "../backend/adminFinalEvidenceReadiness.mjs";
import {
  buildAdminEvidenceDecisionPacket,
  createAdminEvidenceArchive,
} from "../backend/adminEvidenceArchive.mjs";
import { createAdminEvidenceSnapshot } from "../backend/adminEvidenceSnapshot.mjs";
import { normalizeCardKey } from "../backend/ragCardExtractor.mjs";

test("final evidence readiness allows a pure-rule question with zero card candidates", () => {
  const inspection = inspectAdminFinalEvidenceReadiness(makeSnapshot());

  assert.equal(inspection.ready, true);
  assert.equal(inspection.candidateCount, 0);
  assert.deepEqual(inspection.bindings, []);
});

test("final evidence readiness accepts uniquely bound cards with complete visible card text", () => {
  const inspection = inspectAdminFinalEvidenceReadiness(makeSnapshot({
    resolvedCards: [resolvedCard("card-a", "匿名卡A", "匿名卡A完整卡文")],
    preparationCandidates: [{ name: "匿名卡A", originalText: "匿名卡A" }],
  }));

  assert.equal(inspection.ready, true);
  assert.equal(inspection.candidateCount, 1);
  assert.equal(inspection.bindings[0].bindingStatus, "RESOLVED");
  assert.equal(inspection.bindings[0].visibleCardText, true);
  assert.equal(inspection.bindings[0].visibleEvidenceId, "card-a");
});

test("final evidence readiness accepts a user-supplied unknown card with complete visible text", () => {
  const supplied = { name: "尚未收录的新卡", text: "①：可以发动。进行通用处理。" };
  const inspection = inspectAdminFinalEvidenceReadiness(makeSnapshot({
    unresolvedMentions: [{
      input: supplied.name,
      reason: "user_provided_text_name_not_found",
      source: "user_provided_text",
    }],
    userProvidedCardTexts: [supplied],
    preparationCandidates: [{ name: supplied.name, originalText: supplied.name }],
  }));

  assert.equal(inspection.ready, true);
  assert.equal(inspection.bindings[0].source, "user_provided_card_text");
  assert.equal(inspection.bindings[0].visibleCardText, true);
});

test("final evidence readiness rejects unresolved, ambiguous, omitted, and cheap-only candidates", async (t) => {
  const cases = [{
    name: "unresolved parser mention",
    options: { unresolvedMentions: [{ input: "未知卡A", reason: "not_found" }] },
    field: "unresolvedCandidates",
  }, {
    name: "ambiguous parser mention",
    options: { ambiguousMentions: [{ input: "简称A", candidates: [{ id: "1" }, { id: "2" }] }] },
    field: "ambiguousCandidates",
  }, {
    name: "omitted resolved card",
    options: { omittedResolvedCards: [{ input: "被上限省略的卡", reason: "resolved_card_limit_exceeded" }] },
    field: "omittedCandidates",
  }, {
    name: "unbound preparation-model candidate",
    options: { preparationCandidates: [{ name: "模型猜测卡", originalText: "模型猜测卡" }] },
    field: "unresolvedCandidates",
  }];

  for (const definition of cases) {
    await t.test(definition.name, () => {
      const snapshot = makeSnapshot(definition.options);
      const inspection = inspectAdminFinalEvidenceReadiness(snapshot);
      assert.equal(inspection.ready, false);
      assert.equal(inspection[definition.field].length > 0, true);
      assert.throws(
        () => assertAdminFinalEvidenceReady(snapshot),
        (error) => (
          error?.code === "admin_final_evidence_not_ready"
          && error?.status === 409
          && Array.isArray(error?.details?.[definition.field])
        ),
      );
    });
  }
});

test("final evidence readiness rejects a candidate surface shared by two card identities", () => {
  const snapshot = makeSnapshot({
    resolvedCards: [
      resolvedCard("card-a", "匿名卡A", "匿名卡A完整卡文", ["共享简称"]),
      resolvedCard("card-b", "匿名卡B", "匿名卡B完整卡文", ["共享简称"]),
    ],
    preparationCandidates: [{ name: "共享简称", originalText: "共享简称" }],
  });
  const inspection = inspectAdminFinalEvidenceReadiness(snapshot);

  assert.equal(inspection.ready, false);
  assert.equal(
    inspection.bindings.find((item) => item.candidate === "共享简称")?.bindingStatus,
    "AMBIGUOUS",
  );
  assert.deepEqual(
    inspection.ambiguousCandidates.map((item) => item.candidate),
    ["共享简称"],
  );
});

test("final evidence readiness rejects missing or excerpted model-visible card text", async (t) => {
  const card = resolvedCard("card-a", "匿名卡A", "匿名卡A完整卡文");

  await t.test("missing", () => {
    const inspection = inspectAdminFinalEvidenceReadiness(makeSnapshot({
      resolvedCards: [card],
      removeVisibleCardTexts: true,
    }));
    assert.equal(inspection.ready, false);
    assert.deepEqual(
      inspection.missingVisibleCardTexts.map((item) => item.candidate),
      ["匿名卡A"],
    );
  });

  await t.test("excerpted", () => {
    const inspection = inspectAdminFinalEvidenceReadiness(makeSnapshot({
      resolvedCards: [card],
      excerptVisibleCardTexts: true,
    }));
    assert.equal(inspection.ready, false);
    assert.deepEqual(
      inspection.excerptedVisibleCardTexts.map((item) => item.candidate),
      ["匿名卡A"],
    );
  });
});

function makeSnapshot({
  resolvedCards = [],
  unresolvedMentions = [],
  ambiguousMentions = [],
  omittedResolvedCards = [],
  userProvidedCardTexts = [],
  preparationCandidates = [],
  removeVisibleCardTexts = false,
  excerptVisibleCardTexts = false,
} = {}) {
  const cardTextCandidates = {
    resolved: resolvedCards.map((card) => ({
      resolution: card,
      rawCardRecord: card,
    })),
    userProvidedCardTexts,
    unresolvedMentions,
    ambiguousMentions,
    omittedResolvedCards,
  };
  const evidenceBuckets = {
    userProvidedCardTexts: userProvidedCardTexts.map((item) => ({
      id: `user-card-text-${normalizeCardKey(item.name)}`,
      type: "user_provided_text",
      cards: [item.name],
      text: item.text,
      source: "user_provided_text",
      official: false,
    })),
  };
  const evidenceArchive = createAdminEvidenceArchive({
    cardTextCandidates,
    evidenceBuckets,
  });
  const evidenceDecisionPacket = structuredClone(buildAdminEvidenceDecisionPacket({
    archive: evidenceArchive,
  }));
  if (removeVisibleCardTexts) {
    evidenceDecisionPacket.modelPacket.evidenceItems = evidenceDecisionPacket
      .modelPacket.evidenceItems.filter((item) => item.category !== "parsed_card_text");
  }
  if (excerptVisibleCardTexts) {
    for (const item of evidenceDecisionPacket.modelPacket.evidenceItems) {
      if (item.category === "parsed_card_text") item.bodyExcerpted = true;
    }
  }
  return createAdminEvidenceSnapshot({
    question: "匿名规则问题",
    evidence: {
      preparation: {
        extractedHints: { cardNameCandidates: preparationCandidates },
      },
      cardResolution: {
        resolvedCards,
        unresolvedMentions,
        ambiguousMentions,
        omittedResolvedCards,
        userProvidedCardTexts,
        modelCardNameCandidates: preparationCandidates,
      },
      evidenceArchive,
      evidenceDecisionPacket,
    },
    createdAt: "2027-01-01T00:00:00.000Z",
  });
}

function resolvedCard(id, name, effectText, aliases = [name]) {
  return {
    id,
    cardId: id,
    input: name,
    name,
    aliases,
    effectText,
  };
}
