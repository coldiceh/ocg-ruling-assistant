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

test("final evidence readiness maps multiple compact card-text items through audit sidecars", () => {
  const cards = [
    resolvedCard("card-a", "匿名卡A", "匿名卡A完整卡文"),
    resolvedCard("card-b", "匿名卡B", "匿名卡B完整卡文"),
    resolvedCard("card-c", "匿名卡C", "匿名卡C完整卡文"),
  ];
  const snapshot = makeSnapshot({ resolvedCards: cards });
  const inspection = inspectAdminFinalEvidenceReadiness(snapshot);
  const visibleItems = snapshot.evidence.evidenceDecisionPacket.modelPacket.evidenceItems;

  assert.equal(inspection.ready, true);
  assert.equal(inspection.candidateCount, 3);
  assert.deepEqual(
    inspection.bindings.map((binding) => binding.visibleEvidenceId).sort(),
    ["card-a", "card-b", "card-c"],
  );
  assert.equal(
    visibleItems.every(
      (item) => !Object.hasOwn(item, "bodyHash") && !Object.hasOwn(item, "evidenceIds"),
    ),
    true,
  );
});

test("final evidence readiness resolves equivalent card texts from one compact item and full sidecar IDs", () => {
  const sharedText = "两张不同卡共用的完整印刷卡文。";
  const snapshot = makeSnapshot({
    resolvedCards: [
      resolvedCard("card-a", "同文卡A", sharedText),
      resolvedCard("card-b", "同文卡B", sharedText),
    ],
  });
  const inspection = inspectAdminFinalEvidenceReadiness(snapshot);
  const packet = snapshot.evidence.evidenceDecisionPacket;

  assert.equal(inspection.ready, true);
  assert.equal(packet.modelPacket.evidenceItems.length, 1);
  assert.equal(Object.hasOwn(packet.modelPacket.evidenceItems[0], "evidenceIds"), false);
  assert.deepEqual(
    packet.includedManifest[0].evidenceIds,
    ["card-a", "card-b"],
  );
  assert.deepEqual(
    inspection.bindings.map((binding) => binding.visibleEvidenceId).sort(),
    ["card-a", "card-b"],
  );
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

test("a closed operator candidate set ignores cheap-model nickname noise", () => {
  const card = resolvedCard("card-a", "规范卡A", "规范卡A完整卡文");
  const inspection = inspectAdminFinalEvidenceReadiness(makeSnapshot({
    resolvedCards: [card],
    unresolvedMentions: [{ input: "模型多猜的短语", reason: "not_found" }],
    ambiguousMentions: [{ input: "模型多猜的昵称", candidates: [{ id: "1" }, { id: "2" }] }],
    preparationCandidates: [{ name: "模型多猜的昵称", originalText: "模型多猜的昵称" }],
    candidateScope: "provided_closed",
    providedCardNameCandidates: ["规范卡A"],
  }));

  assert.equal(inspection.ready, true);
  assert.equal(inspection.candidateCount, 1);
  assert.equal(inspection.bindings[0].candidate, "规范卡A");
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

test("final evidence readiness rejects an explicitly unverified identity even when its input is in aliases", () => {
  const card = {
    ...resolvedCard("card-a", "规范卡名", "规范卡名完整卡文", ["规范卡名", "未验证输入"]),
    input: "未验证输入",
    identityVerificationStatus: "unverified",
  };
  const inspection = inspectAdminFinalEvidenceReadiness(makeSnapshot({
    resolvedCards: [card],
    preparationCandidates: [{ name: "未验证输入", originalText: "未验证输入" }],
  }));

  assert.equal(inspection.ready, false);
  assert.equal(
    inspection.bindings.find((item) => item.candidate === "未验证输入")?.bindingStatus,
    "UNRESOLVED",
  );
  assert.ok(inspection.unresolvedCandidates.some((item) => item.candidate === "未验证输入"));
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

test("final evidence readiness fails closed when compact item or audit mapping is tampered", async (t) => {
  const card = resolvedCard("card-a", "匿名卡A", "匿名卡A完整卡文");
  const cases = [{
    name: "visible body changed without matching the sidecar body hash",
    mutate(packet) {
      packet.modelPacket.evidenceItems[0].body = "被篡改的卡文";
    },
  }, {
    name: "packet item no longer maps to its manifest",
    mutate(packet) {
      packet.modelPacket.evidenceItems[0].packetItemId = "packet_item_tampered";
    },
  }, {
    name: "manifest equivalent IDs no longer contain the card",
    mutate(packet) {
      packet.includedManifest[0].evidenceIds = ["unrelated-card"];
    },
  }, {
    name: "duplicate packet item mappings are ambiguous",
    mutate(packet) {
      packet.includedManifest.push(structuredClone(packet.includedManifest[0]));
    },
  }];

  for (const definition of cases) {
    await t.test(definition.name, () => {
      const snapshot = makeSnapshot({
        resolvedCards: [card],
        mutateDecisionPacket: definition.mutate,
      });
      const inspection = inspectAdminFinalEvidenceReadiness(snapshot);
      assert.equal(inspection.ready, false);
      assert.deepEqual(
        inspection.missingVisibleCardTexts.map((item) => item.candidate),
        ["匿名卡A"],
      );
    });
  }
});

function makeSnapshot({
  resolvedCards = [],
  unresolvedMentions = [],
  ambiguousMentions = [],
  omittedResolvedCards = [],
  userProvidedCardTexts = [],
  preparationCandidates = [],
  candidateScope = null,
  providedCardNameCandidates = [],
  removeVisibleCardTexts = false,
  excerptVisibleCardTexts = false,
  mutateDecisionPacket = null,
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
  if (typeof mutateDecisionPacket === "function") {
    mutateDecisionPacket(evidenceDecisionPacket);
  }
  return createAdminEvidenceSnapshot({
    question: "匿名规则问题",
    evidence: {
      preparation: {
        extractedHints: { cardNameCandidates: preparationCandidates },
      },
      cardResolution: {
        candidateScope,
        providedCardNameCandidates,
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
