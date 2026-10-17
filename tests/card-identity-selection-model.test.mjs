import assert from "node:assert/strict";
import test from "node:test";

import { callCardIdentitySelectionModel } from "../backend/ragModelClient.mjs";
import { startCardNameExtraction } from "../backend/ragRulingPipeline.mjs";
import { clearBaigeSearchCache } from "../backend/baigeCardProvider.mjs";

const ENV = Object.freeze({
  RAG_CARD_MODEL_PROVIDER: "deepseek",
  DEEPSEEK_API_KEY: "synthetic-key",
  DEEPSEEK_CARD_MODEL: "identity-selector-test",
  API_DAILY_BUDGET_CNY: "10",
  API_BUDGET_TIMEZONE: "UTC",
});

const candidateSets = [{
  mentionId: "mention-a",
  surface: "测试称呼",
  candidates: [
    { candidateId: "candidate-a", cid: 101, passcode: "10000001", name: "候选甲", aliases: ["甲"], typeLine: "[怪兽]", effectText: "甲的完整卡文。", pendulumEffectText: "甲的完整灵摆卡文。", attribute: 4, race: 2, level: 4, rank: null, link: null, atk: 1800, def: 1200 },
    { candidateId: "candidate-b", cid: 102, passcode: "10000002", name: "候选乙", aliases: ["乙"], typeLine: "[怪兽]", effectText: "乙的完整卡文。" },
  ],
}];

test("identity selection sends one non-thinking JSON request and caches a bound candidate handle", async () => {
  const calls = [];
  const options = {
    userQuery: "这是一个公开测试问题。",
    candidateSets,
    dataRevision: "identity-selection-test-v1",
    env: ENV,
    now: new Date("2051-02-03T00:00:00.000Z"),
    fetchImpl: async (url, request) => {
      calls.push({ url: String(url), body: JSON.parse(request.body) });
      return jsonResponse({
        id: "identity-selection-response",
        model: "identity-selector-test",
        choices: [{ finish_reason: "stop", message: { content: '{"selections":[{"mentionId":"mention-a","candidateId":"candidate-b"}]}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    },
  };

  const first = await callCardIdentitySelectionModel(options);
  const second = await callCardIdentitySelectionModel(options);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(calls[0].body.thinking, { type: "disabled" });
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.match(JSON.stringify(calls[0].body), /甲的完整灵摆卡文/u);
  assert.deepEqual(first.selections, [{ mentionId: "mention-a", candidateId: "candidate-b" }]);
  assert.equal(second.cacheHit, true);
});

test("identity selection accepts null and numeric handles, and drops unknown or conflicting handles independently", async () => {
  const result = await callCardIdentitySelectionModel({
    userQuery: "另一个公开测试问题。",
    candidateSets: [{
      ...candidateSets[0],
      mentionId: "mention-numeric",
      candidates: [{ ...candidateSets[0].candidates[0], candidateId: "7" }],
    }, {
      ...candidateSets[0],
      mentionId: "mention-null",
    }, {
      ...candidateSets[0],
      mentionId: "mention-unknown",
    }, {
      ...candidateSets[0],
      mentionId: "mention-conflict",
    }],
    dataRevision: "identity-selection-normalization-v1",
    env: ENV,
    now: new Date("2051-02-04T00:00:00.000Z"),
    modelInvoker: async () => ({
      selections: [
        { mentionId: "mention-numeric", candidateId: 7 },
        { mentionId: "mention-numeric", candidateId: "7" },
        { mentionId: "mention-null", candidateId: null },
        { mentionId: "mention-unknown", candidateId: "not-in-request" },
        { mentionId: "mention-unknown", candidateId: "candidate-a" },
        { mentionId: "mention-conflict", candidateId: "candidate-a" },
        { mentionId: "mention-conflict", candidateId: "candidate-b" },
      ],
    }),
  });

  assert.deepEqual(result.selections, [
    { mentionId: "mention-numeric", candidateId: "7" },
    { mentionId: "mention-null", candidateId: null },
  ]);
  assert.equal(result.cacheHit, undefined);
  assert.ok(result.warnings.includes("card_identity_selection_unknown_candidate_handle:mention-unknown"));
  assert.ok(result.warnings.includes("card_identity_selection_conflicting_selection:mention-conflict"));
});

test("identity selection accepts an empty selection list without inventing a candidate", async () => {
  const result = await callCardIdentitySelectionModel({
    userQuery: "第三个公开测试问题。",
    candidateSets,
    dataRevision: "identity-selection-empty-v1",
    env: ENV,
    now: new Date("2051-02-05T00:00:00.000Z"),
    modelInvoker: async () => "```json\n{\"selections\":[]}\n```",
  });

  assert.deepEqual(result.selections, []);
  assert.equal(result.warnings.some((warning) => warning.startsWith("card_identity_selection_not_cached:")), false);
});

const selectionRulesOf = (prompt) => prompt.slice(0, prompt.indexOf("\n玩家问题："));

// 2026-10-16 规则变更: a partial name no longer forces null when exactly one
// candidate's text contains the treatment the question asks about.
test("identity selection rules accept a partial name when one candidate's text has the asked treatment, without card names", async () => {
  const prompts = [];
  const inputs = [
    { userQuery: "第四个公开测试问题。", sets: candidateSets },
    { userQuery: "第五个公开测试问题，提到另一个称呼。", sets: [{ ...candidateSets[0], surface: "另一个称呼" }] },
  ];
  for (const [index, { userQuery, sets }] of inputs.entries()) {
    await callCardIdentitySelectionModel({
      userQuery,
      candidateSets: sets,
      dataRevision: `identity-selection-rules-v${index}`,
      env: ENV,
      now: new Date("2051-02-06T00:00:00.000Z"),
      modelInvoker: async (request) => {
        prompts.push(request.prompt);
        return { selections: [] };
      },
    });
  }

  assert.equal(prompts.length, 2);
  const [rules, otherRules] = prompts.map(selectionRulesOf);
  assert.equal(rules, otherRules, "the rules must not depend on the question or the candidates");
  for (const sentence of [
    "玩家写的常常只是卡名的一部分（省略前缀、后缀或系列名）或俗称，题面也通常不会复述卡文。",
    "与每个候选的类型行和卡文逐一对照",
    "若恰有一个候选的卡文含有题面所问的那类处理，而其余候选的卡文与该处理无关，就选择该候选，即使题面没有写出完整卡名、也没有复述卡文。",
    "若题面描述与每个候选都不符，或有两个以上候选都符合且无法区分，该 mentionId 必须返回 null。",
    "名称相近本身不足以选择，但也不是返回 null 的理由；不得依据名称以外的猜测改写候选身份。",
    // Unchanged rules: handles only from the same set, JSON output, JSON null.
    "每个 mentionId 只能返回该组提供的 candidateId，或返回 null 表示无法确定。不得创造候选、不得使用别组候选、不得依据编号以外的信息改写候选身份。",
    "只输出 JSON，例如：",
    "无法确定时 candidateId 必须是 JSON null，不是字符串。",
  ]) assert.ok(rules.includes(sentence), sentence);
  assert.equal(rules.includes("只有当候选的类型行和卡文与玩家对这张卡的描述相符时才选择它"), false);
  assert.doesNotMatch(rules, /[「」『』《》]/u);
  const inputNames = inputs.flatMap(({ sets }) => sets.flatMap((set) => [set.surface,
    ...set.candidates.flatMap((candidate) => [candidate.name, ...(candidate.aliases || [])])]));
  for (const forbidden of [...inputNames, "至天", "月女神", "对极", "超越召唤兽", "超融合", "凤凰", "计数", "无效"]) {
    assert.equal(rules.includes(forbidden), false, forbidden);
  }
});

// Routing replay with scripted selections on a synthetic catalog: the player
// writes only the end of a card name, the extractor files it under cardNames,
// the local name index returns several records containing that fragment, and
// the selector picks one. This checks routing and binding only; it does not
// show which candidate a real model selects.
const fragmentCatalog = [
  { id: "990101", cid: 990101, name: "匿名月影之星冠", enName: "Anon Moonshade Starcrown", cardType: "monster",
    effectText: "这张卡的攻击力上升对方场上的表侧表示怪兽数量×300。" },
  { id: "990102", cid: 990102, name: "星冠的叛逆", enName: "Starcrown Rebel", cardType: "monster",
    effectText: "这张卡不会被战斗破坏。" },
  { id: "990103", cid: 990103, name: "星冠魔王 匿名", enName: "Starcrown Overlord Anon", cardType: "monster",
    effectText: "这张卡召唤成功时，自己从卡组抽1张。" },
  { id: "990104", cid: 990104, name: "无关的卡", enName: "Unrelated Card", cardType: "spell",
    effectText: "自己回复1000基本分。" },
];
const fragmentQuestion = "怪兽被放到魔法与陷阱区域，算不算入星冠的数量？";
const fragmentEnv = { RAG_CARD_MODEL_PROVIDER: "bai", BAI_CARD_ENABLED: "true", BAI_CARD_API_KEY: "fixture",
  RAG_LIVE_OFFICIAL_QA: "false", API_BUDGET_MODE: "off" };
const candidateSetsOf = (prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf("候选集：") + "候选集：".length));

async function runFragmentReplay(choose) {
  clearBaigeSearchCache();
  const tasks = [], requests = [];
  const result = await startCardNameExtraction({
    question: fragmentQuestion,
    cards: fragmentCatalog,
    env: fragmentEnv,
    cardModelInvoker: async (request) => {
      tasks.push(request);
      if (request.task === "card_name_extraction") {
        return { cardNames: [{ name: "星冠", enName: "", originalText: "星冠" }], groupMentions: [], describedCards: [] };
      }
      return { selections: candidateSetsOf(request.prompt).map((set) => ({ mentionId: set.mentionId,
        candidateId: set.candidates.find((candidate) => candidate.cid === choose(set.surface))?.candidateId ?? null })) };
    },
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ result: [], next: 0 }), { headers: { "content-type": "application/json" } });
    },
  });
  return { result, tasks: tasks.map((task) => task.task), prompts: tasks.map((task) => task.prompt), requests };
}

test("a card name written without its prefix reaches the one selection call with every fragment owner and binds only through it", async () => {
  const { result, tasks, prompts, requests } = await runFragmentReplay((surface) => surface === "星冠" ? "990101" : null);
  assert.deepEqual(tasks, ["card_name_extraction", "card_identity_selection"]);
  assert.ok(requests.length <= 1);
  assert.ok(prompts[1].includes("若恰有一个候选的卡文含有题面所问的那类处理"));
  const [set, ...rest] = candidateSetsOf(prompts[1]);
  assert.deepEqual(rest, []);
  assert.equal(set.surface, "星冠");
  const offered = set.candidates.map((candidate) => candidate.cid);
  for (const cid of ["990101", "990102", "990103"]) assert.ok(offered.includes(cid), JSON.stringify(offered));
  assert.deepEqual(result.cardResolution.resolvedCards.map((card) => [String(card.id), card.input, card.resolutionSource]),
    [["990101", "星冠", "model_candidate_selection"]]);
  assert.equal(result.cardResolution.resolvedCards[0].effectText, fragmentCatalog[0].effectText);
  assert.deepEqual(result.cardResolution.unresolvedMentions, []);
  assert.equal(result.candidateConfirmation.modelCallCount, 1);

  const declined = await runFragmentReplay(() => null);
  assert.deepEqual(declined.tasks, ["card_name_extraction", "card_identity_selection"]);
  assert.deepEqual(declined.result.cardResolution.resolvedCards, []);
  assert.deepEqual(declined.result.cardResolution.unresolvedMentions.map((mention) =>
    [mention.input, mention.reason, mention.identitySelectionOwner]),
  [["星冠", "model_candidate_not_found", "model_candidate_confirmation"]]);
  assert.equal(declined.result.candidateConfirmation.modelCallCount, 1);
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
