import assert from "node:assert/strict";
import test from "node:test";

import { compileResolvedCardPrograms } from "../backend/duelStateReasoner.mjs";
import { extractRagCards } from "../backend/ragCardExtractor.mjs";
import { loadRagData, retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";

const nibiruQuery = [
  "自己或对方的怪兽区域存在表侧表示的岩石族怪兽，并且「千查万别」的效果正在适用。",
  "对方在这个回合中已经成功召唤或特殊召唤了5只以上的怪兽。",
  "那么此时，自己可以发动手牌中的「原始生命态 尼比鲁」的怪兽效果吗？",
].join("");

const darkLawQuery = [
  "当对方场上存在「M·HERO 暗爪（M・HERO ダーク・ロウ）」时，自己可以发动「超融合」吗？",
  "如果可以发动，那么「M·HERO 暗爪」的送墓改除外效果会如何适用？",
].join("");

test("the two reported wordings resolve every named card before QA retrieval", async () => {
  const data = await loadRagData();
  const nibiru = extractRagCards(nibiruQuery, { cards: data.cards, maxCards: 6 });
  const darkLaw = extractRagCards(darkLawQuery, { cards: data.cards, maxCards: 6 });

  assert.deepEqual(
    new Set(nibiru.resolvedCards.map((card) => String(card.id))),
    new Set(["13447", "14741"]),
    JSON.stringify(nibiru.unresolvedMentions),
  );
  assert.deepEqual(
    new Set(darkLaw.resolvedCards.map((card) => String(card.id))),
    new Set(["7445", "11313"]),
    JSON.stringify(darkLaw.unresolvedMentions),
  );
});

test("card text compilation recognizes destination replacement and spell Fusion activation generically", () => {
  const programs = compileResolvedCardPrograms([
    {
      id: "carrier",
      name: "墓界守卫",
      cardType: "monster",
      effectText: "①：只要此卡存在于怪兽区域，被送往对手墓地的卡不去墓地而直接被除外。",
    },
    {
      id: "fusion-spell",
      name: "交汇融合",
      cardType: "spell",
      effectText: "①：舍弃1张手牌可以发动。以自己・对手场上的怪兽作为融合素材，将1只融合怪兽融合召唤。",
    },
  ]);
  const carrier = programs.find((program) => program.definitionId === "carrier");
  const fusionSpell = programs.find((program) => program.definitionId === "fusion-spell");
  const replacement = carrier.continuousEffects[0]?.destinationReplacements?.[0];
  const fusionEffect = fusionSpell.activatedEffects.find((effect) => effect.fusionSpec);

  assert.equal(replacement?.intendedToZone, "graveyard");
  assert.equal(replacement?.replacementToZone, "banished");
  assert.equal(replacement?.destinationPlayerRelation, "opponent_of_source_controller");
  assert.deepEqual(fusionEffect?.activationZones, ["hand", "spell_trap_zone"]);
  assert.equal(fusionEffect?.costSpec?.type, "discard_from_hand");
  assert.equal(fusionEffect?.compileIncompleteReason, undefined);
});

test("the reported card pairs retrieve their exact official QA through the live fallback", async () => {
  const data = await loadRagData();
  const cases = [
    {
      query: nibiruQuery,
      cardIds: ["13447", "14741"],
      qaId: "22803",
      question: "「<<13447>>」の適用中、手札の「<<14741>>」のモンスター効果を発動する事はできますか？",
      answer: "新たな岩石族モンスターを特殊召喚する効果となるため、発動できません。",
      answerPattern: /発動できません/u,
    },
    {
      query: darkLawQuery,
      cardIds: ["7445", "11313"],
      qaId: "13330",
      question: "相手フィールドに「<<11313>>」が存在する場合、自分は「<<7445>>」を発動する事はできますか？",
      answer: "発動できます。コストの手札は除外され、そのモンスター自身を融合素材とする場合、素材は通常通り墓地へ送られます。",
      answerPattern: /コスト.*除外.*素材.*墓地/u,
    },
  ];

  for (const item of cases) {
    const cardResolution = extractRagCards(item.query, { cards: data.cards, maxCards: 6 });
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.endsWith("/data/meta/mprop")) {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      const cardMatch = href.match(/\/data\/card\/(\d+)$/u);
      if (cardMatch) {
        const id = cardMatch[1];
        const offset = id === item.cardIds[0] ? 1 : 2;
        return Response.json({
          cardData: { en: { id: Number(id), cardType: "monster", properties: [] } },
          qaIndex: [Number(item.qaId), Number(item.qaId) + offset],
        });
      }
      if (href.endsWith("/data/qa/" + item.qaId)) {
        return Response.json({
          cards: item.cardIds.map(Number),
          qaData: { ja: { title: item.question, question: item.question, answer: item.answer } },
        });
      }
      throw new Error("unexpected fixture URL: " + href);
    };
    const evidence = await retrieveRagEvidence({
      userQuery: item.query,
      cardResolution,
      cards: data.cards,
      records: data.records,
      qaRecords: data.qaRecords,
      enableLiveOfficialQa: true,
      fetchImpl,
    });
    const direct = evidence.officialQaDirectCandidates[0];
    assert.equal(direct?.id, "ygoresources-qa-" + item.qaId, JSON.stringify(evidence.debug));
    assert.match(direct?.sourceUrl || "", new RegExp("fid=" + item.qaId, "u"));
    assert.match(direct?.text || "", item.answerPattern);
  }
});

test("the production pipeline enables the live official QA fallback by default", async () => {
  const data = await loadRagData();
  const cards = data.cards.filter((card) => ["13447", "14741"].includes(String(card.id)));
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith("/data/meta/mprop")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    const cardMatch = href.match(/\/data\/card\/(\d+)$/u);
    if (cardMatch) {
      const id = cardMatch[1];
      return Response.json({
        cardData: { en: { id: Number(id), cardType: "monster", properties: [] } },
        qaIndex: [22803, id === "13447" ? 22804 : 22805],
      });
    }
    if (href.endsWith("/data/qa/22803")) {
      const question = "「<<13447>>」の適用中、手札の「<<14741>>」のモンスター効果を発動する事はできますか？";
      return Response.json({
        cards: [13447, 14741],
        qaData: { ja: { title: question, question, answer: "発動できません。" } },
      });
    }
    throw new Error("unexpected fixture URL: " + href);
  };
  const answer = await answerRagRulingQuestion({
    question: nibiruQuery,
    cards,
    records: [],
    qaRecords: [],
    fetchImpl,
    dryRun: true,
    cardModelInvoker: async () => JSON.stringify({ candidates: [] }),
    ruleModelInvoker: async () => JSON.stringify({ queries: [] }),
    rulebookModelInvoker: async () => JSON.stringify({ operationChecks: [], constraintReviews: [] }),
  });

  assert.ok(calls.some((href) => /\/data\/card\/(?:13447|14741)$/u.test(href)));
  assert.ok(answer.usedEvidence.some((item) => item.id === "ygoresources-qa-22803"));
});

export {
  darkLawQuery,
  nibiruQuery,
};
