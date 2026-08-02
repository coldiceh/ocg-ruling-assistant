import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRagData } from "../backend/ragEvidenceRetriever.mjs";
import { answerRagRulingQuestion } from "../backend/ragRulingPipeline.mjs";
import {
  buildBatchSummary,
  evaluateRulingAnswer,
  renderBatchMarkdownSummary,
  runRulingCorpusBatch,
  shouldFailBatchProcess,
} from "../scripts/batch-ruling-corpus.mjs";

test("batch evaluator reports card, direct QA, and simple verdict hits separately", () => {
  const evaluation = evaluateRulingAnswer({
    id: "simple-hit",
    question: "可以发动吗？",
    expectedCardIds: ["100", "200"],
    expectedQaId: "300",
    expectedAnswer: "発動できます。",
  }, {
    shortAnswer: "可以发动。",
    resolvedCards: [{ id: "100" }, { id: "200" }],
    usedEvidence: [{ id: "ygoresources-qa-300" }],
    debug: {
      retrievalCounts: { officialQaDirectCandidates: 1 },
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.overall, "pass");
  assert.equal(evaluation.cardResolution.status, "hit");
  assert.equal(evaluation.officialQa.status, "hit");
  assert.equal(evaluation.correctness.status, "pass");
});

test("batch evaluator fails independently on missing cards, missing QA, and a contradictory verdict", () => {
  const evaluation = evaluateRulingAnswer({
    id: "hard-miss",
    question: "可以发动吗？",
    expectedCardIds: ["100", "200"],
    expectedQaId: "300",
    expectedAnswer: "発動できません。",
  }, {
    shortAnswer: "可以发动。",
    resolvedCards: [{ id: "100" }],
    usedEvidence: [],
    debug: {
      retrievalCounts: { officialQaDirectCandidates: 0 },
      unresolvedMentions: [{ input: "未知卡" }],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.overall, "fail");
  assert.deepEqual(evaluation.cardResolution.missingCardIds, ["200"]);
  assert.equal(evaluation.officialQa.status, "miss");
  assert.equal(evaluation.correctness.reason, "verdict_contradiction");
});

test("an expected QA miss is diagnostic unless the corpus explicitly requires that citation", () => {
  const answer = {
    shortAnswer: "可以发动。",
    resolvedCards: [],
    usedEvidence: [],
    debug: {
      retrievalCounts: { officialQaDirectCandidates: 0 },
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  };
  const diagnostic = evaluateRulingAnswer({
    question: "可以发动吗？",
    expectedQaId: "300",
    expectedAnswer: "可以发动。",
  }, answer);
  assert.equal(diagnostic.officialQa.status, "miss");
  assert.equal(diagnostic.requireExpectedQaIds, false);
  assert.equal(diagnostic.overall, "needs_review");

  const required = evaluateRulingAnswer({
    question: "可以发动吗？",
    expectedQaId: "300",
    requireExpectedQaIds: true,
    expectedAnswer: "可以发动。",
  }, answer);
  assert.equal(required.requireExpectedQaIds, true);
  assert.equal(required.overall, "fail");
});

test("batch reports isolate model configuration and forward it to the deployed answer API", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "ocg-ruling-batch-model-config-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const inputPath = join(tempRoot, "corpus.json");
  const outputPath = join(tempRoot, "report.json");
  await writeFile(inputPath, JSON.stringify({
    cases: [{ id: "one", question: "可以发动吗？", expectedAnswer: "可以发动。" }],
  }), "utf8");
  const requestBodies = [];
  const fetchImpl = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          shortAnswer: "可以发动。",
          resolvedCards: [],
          usedEvidence: [],
          debug: {
            providerUsed: "deepseek",
            modelUsed: "deepseek-v4-flash",
            dryRun: false,
            retrievalCounts: {},
            unresolvedMentions: [],
            ambiguousMentions: [],
          },
        };
      },
    };
  };

  const first = await runRulingCorpusBatch({
    inputPath,
    outputPath,
    endpoint: "https://example.test/api/answer",
    runners: ["online"],
    modelTier: "flash",
    thinkingMode: "disabled",
    fetchImpl,
  });
  assert.deepEqual(first.modelConfiguration, {
    modelTier: "flash",
    thinkingMode: "disabled",
  });
  assert.deepEqual(requestBodies[0], {
    question: "可以发动吗？",
    mode: "rag",
    modelTier: "flash",
    thinkingMode: "disabled",
  });

  const second = await runRulingCorpusBatch({
    inputPath,
    outputPath,
    endpoint: "https://example.test/api/answer",
    runners: ["online"],
    modelTier: "flash",
    thinkingMode: "enabled",
    reasoningEffort: "max",
    fetchImpl,
  });
  assert.equal(requestBodies.length, 2, "a different model configuration must not reuse the previous answer");
  assert.deepEqual(second.modelConfiguration, {
    modelTier: "flash",
    thinkingMode: "enabled",
    reasoningEffort: "max",
  });

  await runRulingCorpusBatch({
    inputPath,
    outputPath,
    endpoint: "https://second.example.test/api/answer",
    runners: ["online"],
    modelTier: "flash",
    thinkingMode: "enabled",
    reasoningEffort: "max",
    fetchImpl,
  });
  assert.equal(requestBodies.length, 3, "a different endpoint must not reuse the previous answer");

  const differentVersion = await runRulingCorpusBatch({
    inputPath,
    outputPath,
    endpoint: "https://second.example.test/api/answer",
    runners: ["online"],
    rulingVersion: "previous",
    modelTier: "flash",
    thinkingMode: "enabled",
    reasoningEffort: "max",
    fetchImpl,
  });
  assert.equal(requestBodies.length, 4, "a different ruling version must not reuse the previous answer");
  assert.equal(differentVersion.rulingVersion, "previous");

  await assert.rejects(
    runRulingCorpusBatch({
      inputPath,
      outputPath,
      endpoint: "https://example.test/api/answer",
      runners: ["online"],
      modelTier: "flash",
      thinkingMode: "disabled",
      reasoningEffort: "high",
      fetchImpl,
    }),
    /reasoning effort cannot be set when thinking mode is disabled/u,
  );
});

test("complex official answers remain manual review even when the expected QA is cited", () => {
  const evaluation = evaluateRulingAnswer({
    id: "complex",
    question: "处理如何进行？",
    expectedQaId: "300",
    expectedAnswer: "発動できます。\n\nその後、素材を墓地へ送り、特別な処理を行います。処理時の状態によって一部を適用しません。",
  }, {
    shortAnswer: "可以发动，之后进行处理。",
    resolvedCards: [{ id: "100" }],
    usedEvidence: [{ id: "ygoresources-qa-300" }],
    debug: {
      retrievalCounts: { officialQaDirectCandidates: 1 },
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.overall, "needs_review");
  assert.equal(evaluation.correctness.status, "needs_review");
  assert.equal(evaluation.correctness.reason, "official_qa_grounded_but_completeness_requires_review");
});

test("batch summary exposes retrieval failures without conflating them with request failures", () => {
  const summary = buildBatchSummary([
    {
      runs: {
        online: {
          ok: true,
          evaluation: {
            overall: "fail",
            cardResolution: { status: "miss" },
            officialQa: { status: "not_found" },
          },
        },
        local: {
          ok: true,
          evaluation: {
            overall: "pass",
            cardResolution: { status: "hit" },
            officialQa: { status: "hit" },
          },
        },
      },
      comparison: { status: "diverged" },
    },
    {
      runs: {
        online: {
          ok: false,
          evaluation: { overall: "request_failed" },
        },
      },
      comparison: { status: "not_available" },
    },
  ]);

  assert.equal(summary.runs.online.completed, 2);
  assert.equal(summary.runs.online.requestFailed, 1);
  assert.equal(summary.runs.online.cardMiss, 1);
  assert.equal(summary.runs.online.officialQaNotFound, 1);
  assert.equal(summary.runs.local.pass, 1);
  assert.equal(summary.onlineLocalDiverged, 1);
});

test("transport failure policy keeps review and retrieval regressions neutral but rejects request failures", () => {
  const reviewOnly = {
    summary: {
      runs: {
        online: {
          completed: 3,
          requestFailed: 0,
          fail: 2,
          needsReview: 1,
        },
      },
    },
  };
  assert.equal(shouldFailBatchProcess(reviewOnly, "strict"), true);
  assert.equal(shouldFailBatchProcess(reviewOnly, "transport"), false);

  const requestFailure = structuredClone(reviewOnly);
  requestFailure.summary.runs.online.requestFailed = 1;
  assert.equal(shouldFailBatchProcess(requestFailure, "transport"), true);
  assert.throws(
    () => shouldFailBatchProcess(reviewOnly, "unknown"),
    /unsupported failure policy/u,
  );
  assert.match(renderBatchMarkdownSummary({
    inputPath: "data/test/example.json",
    summary: reviewOnly.summary,
  }), /Soft fail and needs review are report findings/u);
});

test("a local mock dry run cannot be reported as a real passing answer", () => {
  const evaluation = evaluateRulingAnswer({
    question: "可以发动吗？",
    expectedAnswer: "発動できます。",
  }, {
    shortAnswer: "可以发动。",
    resolvedCards: [],
    usedEvidence: [],
    debug: {
      dryRun: true,
      providerUsed: "mock",
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.overall, "dry_run");
  assert.equal(evaluation.execution.dryRun, true);
});

test("a deterministic local ruling is evaluated as a real answer even when no model was called", () => {
  const evaluation = evaluateRulingAnswer({
    question: "可以发动吗？",
    expectedAnswer: "不能发动。",
  }, {
    shortAnswer: "不能发动。",
    resolvedCards: [],
    usedEvidence: [],
    debug: {
      dryRun: true,
      providerUsed: "local",
      modelUsed: "deterministic-ruling-reasoner",
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.overall, "pass");
  assert.equal(evaluation.execution.rawDryRun, true);
  assert.equal(evaluation.execution.dryRun, false);
});

test("corpus execution gates reject dry runs and forbidden deterministic answerers", () => {
  const corpusCase = {
    question: "可以发动吗？",
    expectedAnswer: "可以发动。",
    requireNonDryRun: true,
    requireModelUsed: true,
    requireLiveModel: true,
    forbiddenModelUsed: ["deterministic-ruling-reasoner"],
  };
  const dryRun = evaluateRulingAnswer(corpusCase, {
    shortAnswer: "可以发动。",
    debug: {
      dryRun: true,
      providerUsed: "local",
      modelUsed: "deterministic-ruling-reasoner",
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });
  assert.equal(dryRun.overall, "fail");
  assert.deepEqual(dryRun.execution.policyViolations, [
    "explicit_non_dry_run_required",
    "non_live_model_forbidden",
    "forbidden_model_used:deterministic-ruling-reasoner",
  ]);

  const missingModelMarker = evaluateRulingAnswer(corpusCase, {
    shortAnswer: "可以发动。",
    debug: {
      dryRun: false,
      providerUsed: "openai",
      modelUsed: "",
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });
  assert.equal(missingModelMarker.overall, "fail");
  assert.deepEqual(missingModelMarker.execution.policyViolations, ["model_used_marker_required"]);

  const missingExecutionMarkers = evaluateRulingAnswer(corpusCase, {
    shortAnswer: "可以发动。",
    debug: {
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });
  assert.equal(missingExecutionMarkers.overall, "fail");
  assert.deepEqual(missingExecutionMarkers.execution.policyViolations, [
    "explicit_non_dry_run_required",
    "provider_used_marker_required",
    "model_used_marker_required",
  ]);

  const mockAnswer = evaluateRulingAnswer(corpusCase, {
    shortAnswer: "可以发动。",
    debug: {
      dryRun: false,
      providerUsed: "mock",
      modelUsed: "mock-ruling-model",
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });
  assert.equal(mockAnswer.overall, "fail");
  assert.deepEqual(mockAnswer.execution.policyViolations, ["non_live_model_forbidden"]);

  const finalModel = evaluateRulingAnswer(corpusCase, {
    shortAnswer: "可以发动。",
    debug: {
      dryRun: false,
      providerUsed: "openai",
      modelUsed: "gpt-5.6",
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });
  assert.equal(finalModel.execution.policyStatus, "pass");
  assert.equal(finalModel.overall, "pass");
});

test("twitter fixture card names and officialFaqId are accepted with normalized aliases", () => {
  const evaluation = evaluateRulingAnswer({
    question: "この場合は発動できますか？",
    expectedCardNames: ["M・HERO ダーク・ロウ"],
    officialFaqId: "13330",
    expectedAnswerKeyPoints: ["可以发动", "作为融合素材"],
  }, {
    shortAnswer: "可以发动。处理时也可以将其作为融合素材。",
    resolvedCards: [{
      id: "11313",
      name: "假面－英雄 暗法",
      jaName: "M・HERO ダーク・ロウ",
    }],
    usedEvidence: [{ id: "ygoresources-qa-13330" }],
    debug: {
      retrievalCounts: { officialQaDirectCandidates: 1 },
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.cardResolution.status, "hit");
  assert.deepEqual(evaluation.cardResolution.missingCardNames, []);
  assert.equal(evaluation.officialQa.status, "hit");
  assert.equal(evaluation.correctness.status, "pass");
});

test("untranslated or omitted twitter answer key points request review instead of a false failure", () => {
  const evaluation = evaluateRulingAnswer({
    question: "処理はどうなりますか？",
    expectedAnswerKeyPoints: ["墓地へ送らず除外する"],
  }, {
    shortAnswer: "The card is banished instead of being sent to the Graveyard.",
    resolvedCards: [{ id: "1", name: "テストカード" }],
    usedEvidence: [],
    debug: {
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.equal(evaluation.correctness.status, "needs_review");
  assert.equal(evaluation.correctness.reason, "answer_key_points_need_cross_language_or_completeness_review");
  assert.equal(evaluation.overall, "needs_review");
});

test("negative activation and application phrases are not double-counted as positive verdicts", () => {
  const evaluation = evaluateRulingAnswer({
    question: "発動できますか？",
    expectedAnswer: "不可以发动，也不会适用。",
  }, {
    shortAnswer: "不可以发动，也不会适用。",
    resolvedCards: [],
    usedEvidence: [],
    debug: {
      retrievalCounts: {},
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
  });

  assert.deepEqual(evaluation.correctness.expectedVerdicts, ["cannot_activate", "does_not_apply"]);
  assert.deepEqual(evaluation.correctness.actualVerdicts, ["cannot_activate", "does_not_apply"]);
});

const fiveCaseCorpus = JSON.parse(readFileSync(
  new URL("../data/test/five-state-transition-regressions.json", import.meta.url),
  "utf8",
));

const finalReasonerEvidenceSpecs = {
  "albaz-cost-enables-opponent-immunity": {
    cardNames: [
      ["阿尔白斯之落胤", "阿不思的落胤"],
      ["教导之圣女 艾克利西亚", "教导的圣女 艾克莉西亚"],
      ["吞喰圣痕之龙", "吞食圣痕之龙"],
      ["冰剑龙 镜翠幻种", "冰剑龙 幻冰龙"],
    ],
    evidenceIds: ["card-faq-15245-0", "card-faq-15245-1", "card-faq-22090-2"],
    promptSnippets: [
      "舍弃1张手牌可以发动",
      "只要自己或对手的、场上或墓地存在“艾克利西亚”怪兽",
      "“阿尔白斯之落胤”＋融合・同步・超量・连接怪兽",
      "Discarding 1 card from your hand is the cost",
      "モンスターゾーンで適用する永続効果",
    ],
  },
  "evenly-from-hand-is-field-card-activation": {
    cardNames: [
      ["颉颃胜负", "颉颃胜负"],
      ["天下独歩の大義賊", "天下独步的大义贼"],
    ],
    evidenceIds: ["card-faq-13293-0.5", "card-faq-23349-1"],
    ruleSearchQueries: ["从手牌发动陷阱卡属于场上的卡的发动"],
    ruleEvidence: [{
      id: "ocg-rule:c02/卡片·效果的发动#evenly-gallant-thief",
      recordType: "rule-doc",
      sourceId: "ocg-rule",
      title: "从手牌进行魔法・陷阱卡的发动",
      text: "对方从手卡把「颉颃胜负」以『自己场上没有卡存在的场合，这张卡的发动从手卡也能用』的方法发动的场合，不能连锁发动「天下独步的大义贼」的①效果。对方从手卡把魔法・陷阱卡放置在场上并发动的状况，不属于『对方把手卡・墓地・除外状态的卡的效果发动时』。",
    }],
    promptSnippets: [
      "相手が手札・墓地・除外状態のカードの効果を発動した時",
      "不能连锁发动「天下独步的大义贼」的①效果",
    ],
  },
  "lotus-changes-yubel-effect-destruction-source": {
    cardNames: [
      ["尤贝尔之精灵", "于贝尔精灵"],
      ["纳祭魔鬼莲", "献祭魔界莲"],
      ["尤贝尔", "于贝尔"],
    ],
    evidenceIds: ["card-faq-19458-2", "card-faq-7409-3", "card-faq-7409-4"],
    promptSnippets: [
      "该效果变为“将场上的１只“尤贝尔”怪兽破坏”",
      "モンスターに適用する効果ではありません",
      "此卡因此③效果以外的方式被破坏时可以发动",
    ],
  },
  "zero-resolves-before-tcboo-cleanup": {
    cardNames: [
      ["千察万别", "千查万别"],
      ["闪刀姬＝零萝", "闪刀姬＝零露"],
      ["闪刀姬－零", "闪刀姬－零"],
      ["闪刀姬－萝杰", "闪刀姬－萝杰"],
    ],
    evidenceIds: ["card-faq-21460-2", "card-faq-13447-1"],
    ruleSearchQueries: ["效果处理途中出现只能有一种族限制冲突时何时送墓"],
    ruleEvidence: [{
      id: "ocg-rule:c03/只能有○○存在#after-resolution-cleanup",
      recordType: "rule-doc",
      sourceId: "ocg-rule",
      title: "只能有○○存在的效果处理途中检查",
      text: "效果处理途中出现了不符合条件的怪兽的场合，在这个效果处理完毕时，再把不符合条件的怪兽送去墓地。多只怪兽同时特殊召唤而出现同种族怪兽两只以上的场合，在效果处理完毕时选一部分或全部送去墓地，直到只剩一只。",
    }],
    promptSnippets: [
      "“闪刀姬－零”“闪刀姬－萝杰”各1只特殊召唤。然后，可将场上的1张卡破坏",
      "特殊召喚する処理と破壊する処理を両方行う場合、それらは同時に行われません",
      "效果处理途中出现了不符合条件的怪兽的场合",
    ],
  },
  "silver-hound-control-condition-does-not-restart": {
    cardNames: [["月光银狗", "月光银狗"]],
    evidenceIds: ["card-faq-21417-1"],
    promptSnippets: [
      "只要以此效果特殊召唤的怪兽以表侧表示存在于自己场上",
      "この効果で特殊召喚したモンスターが自分のモンスターゾーンに表側表示で存在する限り",
    ],
  },
};

test("five reported state-transition cases reach the final model with complete card and rule evidence", async () => {
  assert.equal(fiveCaseCorpus.cases.length, 5);
  const data = await loadRagData();
  const cardsById = new Map(data.cards.map((card) => [String(card.id || card.cardId), card]));
  const qaById = new Map(data.qaRecords.map((record) => [String(record.id), record]));

  for (const corpusCase of fiveCaseCorpus.cases) {
    const spec = finalReasonerEvidenceSpecs[corpusCase.id];
    assert.ok(spec, `missing evidence spec for ${corpusCase.id}`);
    const cards = corpusCase.expectedCardIds.map((id) => cardsById.get(String(id)));
    assert.ok(cards.every(Boolean), `missing local card snapshot for ${corpusCase.id}`);
    const relatedFaqs = spec.evidenceIds.map((id) => qaById.get(id));
    assert.ok(relatedFaqs.every(Boolean), `missing local FAQ snapshot for ${corpusCase.id}`);
    const records = [
      ...relatedFaqs.map((record) => ({
        ...record,
        originalRecordType: record.recordType,
        recordType: "related",
        sourceType: "faq_related",
      })),
      ...(spec.ruleEvidence || []),
    ];
    let finalModelCalls = 0;
    const marker = `FINAL_MODEL_GENERATED:${corpusCase.id}`;
    const answer = await answerRagRulingQuestion({
      question: corpusCase.question,
      cards,
      records,
      qaRecords: [],
      env: {
        MODEL_PROVIDER: "mock",
        RAG_LIVE_OFFICIAL_QA: "false",
        RAG_AUTO_ENGINE_SIMULATION: "false",
        RAG_FORMAL_ENGINE_MODE: "off",
      },
      cardModelInvoker: async () => JSON.stringify({
        cardNames: spec.cardNames.map(([name, originalText]) => ({ name, originalText, confidence: "high" })),
      }),
      ruleModelInvoker: async () => JSON.stringify({
        ruleQueries: (spec.ruleSearchQueries || []).map((query) => ({ query, confidence: "high" })),
      }),
      rulebookModelInvoker: async () => JSON.stringify({
        operationChecks: [],
        constraintReviews: [],
        overallConclusion: "最终裁定由最终模型根据原始证据生成。",
      }),
      modelInvoker: async ({ prompt }) => {
        finalModelCalls += 1;
        for (const id of spec.evidenceIds) assert.match(prompt, new RegExp(escapeRegExp(id), "u"));
        for (const snippet of spec.promptSnippets) assert.ok(prompt.includes(snippet), `${corpusCase.id} prompt missing: ${snippet}`);
        return JSON.stringify({
          answerLevel: "rule_analysis",
          shortAnswer: `【${marker}】${corpusCase.expectedAnswer || corpusCase.expectedAnswerKeyPoints.join("；")} `,
          reasoning: corpusCase.expectedAnswerKeyPoints || [],
          usedCards: cards.map((card) => card.name),
          usedEvidence: spec.evidenceIds.map((id) => ({ id, type: "faq", title: id })),
          missingInfo: [],
          riskFlags: ["no_official_direct_qa"],
          confidenceSelfEstimate: "medium",
        });
      },
    });

    assert.equal(finalModelCalls, 1, `${corpusCase.id} did not use exactly one final model generation`);
    assert.match(answer.shortAnswer, new RegExp(escapeRegExp(marker), "u"));
    const resolvedIds = new Set(answer.resolvedCards.map((card) => String(card.id)));
    assert.ok(corpusCase.expectedCardIds.every((id) => resolvedIds.has(String(id))));
    assert.equal(answer.debug.deterministicDecision, null);
  }
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
