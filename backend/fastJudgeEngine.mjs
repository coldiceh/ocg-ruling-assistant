import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCardProfiles } from "./cardProfile.mjs";
import { detectIssueFrames, issueFrameIds } from "./issueFrameDetector.mjs";
import { buildProgramAnswerModel, runJudgeAnswerModel } from "./judgeAnswerModel.mjs";
import { buildSafeClarification, validateJudgeAnswer } from "./judgeAnswerValidator.mjs";
import { createLatencyBudget, isLatencyTimeout, runWithinLatencyBudget } from "./latencyBudget.mjs";
import { buildRulingContextPack, buildTemporaryCardProfiles, resolveCardsForFastJudge } from "./rulingContextPack.mjs";
import { checkStaleness } from "./stalenessGuard.mjs";
import { detectCurrentVerdictConflicts, filterCurrentEvidence } from "./currentEvidenceFilter.mjs";
import { evaluateEvidenceFreshness } from "./evidenceFreshness.mjs";
import { buildCardIdentityGateAnswer, evaluateCardIdentityGate } from "./cardIdentityGate.mjs";
import { applyProgramVerdictPolicy, evidenceGradeFor, statusForProgramVerdict } from "./verdictPolicy.mjs";
import { runSafeChainPipeline } from "./chainSafety.mjs";
import {
  defaultEffectTemplateDir,
  generateRestrictionsFromEffectTemplates,
  hydrateChainLinksFromTemplates,
  loadEffectTemplateRegistry,
} from "./effectTemplateRegistry.mjs";
import { buildDamageStepAnalysis, cardProfileRuleText } from "./damageStepRules.mjs";
import { buildDamageStepBlockerAnswer, evaluateDamageStepBlocker } from "./damageStepBlockers.mjs";
import { buildEventSequenceFromQuestion, buildTriggerTimingAnalysis, classifyTriggerWording, shouldAnalyzeTriggerTiming } from "./triggerTimingRules.mjs";
import { buildTimingMissBlockerAnswer, evaluateTimingMissBlocker } from "./timingMissBlockers.mjs";
import { resolveEntitiesFromOfficialQaMatch, searchOfficialQaEvidence } from "./officialQaMatcher.mjs";
import { buildGenericRuleEngineAnswer, routeAnswer, selectOfficialQaRoute } from "./answerRouter.mjs";
import { buildConditionalBranchAnswer } from "./conditionalAnswerBuilder.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fastSnapshotCache = new Map();

export async function answerRulingQuestionFast({ question, mode = "duel", maxLatencyMs = 6000, env = globalThis.process?.env || {}, dataDir = join(root, "data"), snapshot, modelInvoker, gameState = {}, chainLinks = [], effectTemplateRegistry = null, effectTemplateDir = defaultEffectTemplateDir, debug = false } = {}) {
  const input = String(question || "").trim();
  const budget = createLatencyBudget({ mode, maxLatencyMs });
  if (!input) return finalize(buildEmptyAnswer(), { mode, budget, issueFrames: emptyFrames(), contextPack: emptyContext(input), debug });

  try {
    const localSnapshot = snapshot || await runWithinLatencyBudget(() => loadFastJudgeSnapshot(dataDir), budget, "fast_context_load");
    const subsumptionCandidatePoolComplete = !snapshot
      || snapshot?.snapshotMeta?.subsumptionCandidatePoolComplete === true;
    const evidenceSelection = filterCurrentEvidence(localSnapshot.records || [], {
      evidenceIndex: localSnapshot.evidenceIndex || [],
      sourceFreshness: localSnapshot.snapshotMeta?.sourceFreshness || "unknown",
      detectConflicts: false,
    });
    const activeSnapshot = { ...localSnapshot, records: evidenceSelection.currentEvidence };
    const rawOfficialQaSearch = searchOfficialQaEvidence({
      question: input,
      records: activeSnapshot.records,
      subsumptionCandidatePoolComplete,
    });
    const initialResolution = resolveCardsForFastJudge(input, localSnapshot.cards || []);
    const entityResolution = resolveEntitiesFromOfficialQaMatch({
      resolution: initialResolution,
      matches: rawOfficialQaSearch,
      cards: localSnapshot.cards || [],
    });
    const resolution = {
      resolvedCards: entityResolution.resolvedCards,
      unresolvedCards: entityResolution.unresolvedMentions,
    };
    const officialQaSearch = searchOfficialQaEvidence({
      question: input,
      records: activeSnapshot.records,
      resolvedCards: resolution.resolvedCards,
      subsumptionCandidatePoolComplete,
    });
    const databaseProfiles = buildCardProfiles(resolution.resolvedCards);
    const temporaryProfiles = buildTemporaryCardProfiles(input, resolution.unresolvedCards);
    const cardProfiles = [...databaseProfiles, ...temporaryProfiles];
    const preliminaryFrames = detectIssueFrames({ question: input, cardProfiles });
    const contextPack = buildRulingContextPack({
      question: input,
      resolvedCards: resolution.resolvedCards,
      unresolvedCards: resolution.unresolvedCards,
      cardProfiles,
      issueFrames: preliminaryFrames,
      snapshot: activeSnapshot,
    });
    mergeOfficialSearchIntoContext(contextPack, officialQaSearch);
    contextPack.mode = mode;
    contextPack.snapshotMeta = localSnapshot.snapshotMeta || {};
    contextPack.entityResolution = entityResolution;
    const cardIdentityGate = evaluateCardIdentityGate({
      resolvedCards: resolution.resolvedCards,
      unresolvedCards: resolution.unresolvedCards,
    });
    contextPack.cardIdentityGate = cardIdentityGate;
    contextPack.officialQaSearch = officialQaSearch;
    const issueFrames = detectIssueFrames({
      question: input,
      cardProfiles,
      cardTexts: contextPack.relevantCardSections.map((item) => item.text),
    });
    contextPack.issueFrames = issueFrames;
    const matchedEvidence = [contextPack.officialQaCandidates, contextPack.faqCandidates, contextPack.ruleSnippets, contextPack.knownAnalogies].flat();
    const matchedConflicts = detectCurrentVerdictConflicts(matchedEvidence);
    const evidenceFreshness = evaluateEvidenceFreshness({
      snapshotMeta: localSnapshot.snapshotMeta || {},
      evidenceList: [
        ...matchedEvidence,
        ...matchedConflicts.flatMap((item) => item.evidenceIds.map((id) => ({ id, status: "conflict" }))),
      ],
    });
    evidenceSelection.conflicts = matchedConflicts;
    contextPack.evidenceSelection = evidenceSelection;
    contextPack.evidenceFreshness = evidenceFreshness;
    const staleness = checkStaleness({
      issueFrames,
      evidence: [
        contextPack.officialQaCandidates,
        contextPack.faqCandidates,
        contextPack.ruleSnippets,
        contextPack.knownAnalogies,
        contextPack.userProvidedCardText,
      ],
      targetFormat: "ocg",
    });
    contextPack.staleness = staleness;

    const officialQaRoute = selectOfficialQaRoute({
      matches: officialQaSearch,
      freshness: evidenceFreshness,
      staleEvidenceIds: staleness.staleEvidenceIds || [],
    });
    const directOfficial = cardIdentityGate.passed ? bindExactOfficialQaAnswer({
      route: officialQaRoute,
      matches: officialQaSearch,
      cardIdentityGate,
      resolvedCards: resolution.resolvedCards,
    }) : null;
    contextPack.answerRouter = {
      officialQaRoute: officialQaRoute.level,
      officialQaBinding: directOfficial ? "canonical_exact_bound" : "not_bound_for_direct_answer",
      conflicts: officialQaRoute.conflicts || [],
    };
    if (directOfficial) return finalize(directOfficial, { mode, budget, issueFrames, contextPack, debug });
    const officialEvidenceIds = directOfficial?.judgeReasoning?.flatMap((item) => item.refs || []) || [];
    const profileText = cardProfileRuleText(cardProfiles);
    const damageStepAnalysis = buildDamageStepAnalysis({
      question: input,
      phase: contextPack.scenario?.phase || "",
      effectText: profileText,
      cardType: resolution.resolvedCards?.[0]?.cardType || "",
      officialDirectEvidence: Boolean(directOfficial),
      officialVerdict: directOfficial?.verdict || "unknown",
      evidenceIds: officialEvidenceIds,
    });
    contextPack.damageStepAnalysis = damageStepAnalysis;
    const triggerProfile = cardProfiles.find((profile) => classifyTriggerWording(cardProfileRuleText([profile])) !== "unknown") || null;
    const triggerText = triggerProfile ? cardProfileRuleText([triggerProfile]) : "";
    const eventSequence = buildEventSequenceFromQuestion(input);
    const triggerTimingAnalysis = shouldAnalyzeTriggerTiming({ question: input, effectText: triggerText }) ? buildTriggerTimingAnalysis({
      triggerCandidate: {
        card: triggerProfile?.names?.zh || triggerProfile?.names?.ja || triggerProfile?.names?.en || "unknown",
        effectText: triggerText,
      },
      eventSequence,
      officialDirectEvidence: Boolean(directOfficial),
      evidenceIds: officialEvidenceIds,
    }) : null;
    contextPack.eventSequence = eventSequence;
    contextPack.triggerTimingAnalysis = triggerTimingAnalysis;

    if (chainLinks.length) {
      if (!cardIdentityGate.passed) {
        return finalize(buildCardIdentityGateAnswer(cardIdentityGate), { mode, budget, issueFrames, contextPack, debug });
      }
      const templateRegistry = effectTemplateRegistry || await loadEffectTemplateRegistry(effectTemplateDir);
      const hydratedChainLinks = hydrateChainLinksFromTemplates(chainLinks, templateRegistry);
      const generatedRestrictions = generateRestrictionsFromEffectTemplates(gameState.activeRestrictionTemplates || [], templateRegistry);
      const structuredGameState = {
        ...gameState,
        activeRestrictions: [...(gameState.activeRestrictions || []), ...generatedRestrictions],
      };
      contextPack.effectTemplateRegistry = {
        templateCount: templateRegistry.templateCount,
        restrictionTemplateCount: templateRegistry.restrictionTemplateCount,
        aliasCount: templateRegistry.aliasCount,
        hydratedChainLinks: hydratedChainLinks.map((link) => ({
          id: link.id,
          templateStatus: link.templateStatus,
          effectTemplateId: link.effectTemplateId || null,
        })),
      };
      const chainSafety = runSafeChainPipeline({ chainLinks: hydratedChainLinks, gameState: structuredGameState });
      contextPack.chainSafety = chainSafety;
      if (!chainSafety.canResolve) {
        if (chainSafety.status === "insufficient") {
          const conditionalAnswer = buildConditionalBranchAnswer({
            question: input,
            contextPack,
            officialMatches: officialQaSearch,
            damageStepAnalysis,
            triggerTimingAnalysis,
            reason: "Effect Template Fast Judge 无法安全执行；已保留可证明的条件分支。",
          });
          const answer = routeAnswer({
            conditionalAnswer,
            noEvidenceAnswer: buildTemplateInsufficientAnswer(chainSafety),
          });
          return finalize(answer, { mode, budget, issueFrames, contextPack, debug });
        } else {
          return finalize(buildIllegalChainAnswer(chainSafety), { mode, budget, issueFrames, contextPack, debug });
        }
      }
      if (chainSafety.resolutionResults?.length) {
        return finalize(buildPrimitiveResolutionAnswer(chainSafety), { mode, budget, issueFrames, contextPack, debug });
      }
    }

    if (!cardIdentityGate.passed && !temporaryProfiles.length) {
      return finalize(buildCardIdentityGateAnswer(cardIdentityGate), { mode, budget, issueFrames, contextPack, debug });
    }

    const damageStepBlocker = evaluateDamageStepBlocker(damageStepAnalysis);
    if (damageStepBlocker.hasBlocker) {
      return finalize(buildDamageStepBlockerAnswer(damageStepBlocker), { mode, budget, issueFrames, contextPack, debug });
    }
    const timingMissBlocker = evaluateTimingMissBlocker(triggerTimingAnalysis);
    if (timingMissBlocker.hasBlocker) {
      return finalize(buildTimingMissBlockerAnswer(timingMissBlocker), { mode, budget, issueFrames, contextPack, debug });
    }

    const requiredTextGap = hasRequiredTextGap(issueFrames, cardProfiles);
    const genericRuleAnswer = buildGenericRuleEngineAnswer({ question: input, issueFrames });
    if (genericRuleAnswer) {
      return finalize(routeAnswer({ ruleEngineAnswer: genericRuleAnswer }), { mode, budget, issueFrames, contextPack, debug });
    }

    if (!issueFrames.primaryIssueFrames.length) {
      const conditionalAnswer = buildConditionalBranchAnswer({ question: input, contextPack, officialMatches: officialQaSearch, damageStepAnalysis, triggerTimingAnalysis });
      const answer = routeAnswer({ conditionalAnswer, noEvidenceAnswer: buildFinalInsufficientAnswer(input, buildNoIssueClarification(input, contextPack).requiredFacts) });
      return finalize(answer, { mode, budget, issueFrames, contextPack, debug });
    }

    if (hasUnresolvedCardsWithoutText(resolution.unresolvedCards, temporaryProfiles) || requiredTextGap) {
      const conditionalAnswer = buildConditionalBranchAnswer({ question: input, contextPack, officialMatches: officialQaSearch, damageStepAnalysis, triggerTimingAnalysis, reason: "卡名或效果文本尚未完全确认，但仍可列出不依赖该歧义的条件分支。" });
      const answer = routeAnswer({ conditionalAnswer, noEvidenceAnswer: buildSafeClarification(input, issueFrames, contextPack, {}) });
      if (requiredTextGap) answer.statusChip = "CARD-TEXT-MISSING";
      return finalize(answer, { mode, budget, issueFrames, contextPack, debug });
    }

    const modelAnswer = await runJudgeAnswerModel({ contextPack, mode, budget, env, modelInvoker });
    if (!modelAnswer) {
      const conditionalAnswer = buildConditionalBranchAnswer({ question: input, contextPack, officialMatches: officialQaSearch, damageStepAnalysis, triggerTimingAnalysis, reason: "Fast Judge 未生成可验证的单一结论，已保留证据检索结果并转为条件回答。" });
      const answer = routeAnswer({ conditionalAnswer, noEvidenceAnswer: buildFinalInsufficientAnswer(input, buildSafeClarification(input, issueFrames, contextPack, {}).requiredFacts) });
      return finalize(answer, { mode, budget, issueFrames, contextPack, debug });
    }
    if (modelAnswer.explanationOnly) {
      const conditionalAnswer = buildConditionalBranchAnswer({ question: input, contextPack, officialMatches: officialQaSearch, damageStepAnalysis, triggerTimingAnalysis, reason: "规则引擎没有生成程序 verdict；模型草稿不能代替裁定，已降级为条件回答。" });
      const answer = routeAnswer({ conditionalAnswer, noEvidenceAnswer: buildFinalInsufficientAnswer(input, buildSafeClarification(input, issueFrames, contextPack, {}).requiredFacts) });
      answer.explanationDraft = modelAnswer.explanationDraft;
      if (modelAnswer.rejectedDecisiveDraft) answer.warnings = [...new Set([...(answer.warnings || []), "model_decisive_draft_rejected"] )];
      return finalize(answer, { mode, budget, issueFrames, contextPack, debug });
    }
    const validation = validateJudgeAnswer({ question: input, issueFrames, contextPack, modelAnswer });
    const conditionalAnswer = validation.ok ? null : buildConditionalBranchAnswer({ question: input, contextPack, officialMatches: officialQaSearch, damageStepAnalysis, triggerTimingAnalysis, reason: "规则模型输出未通过结构化验证，已降级为条件回答。" });
    const answer = routeAnswer({
      ruleEngineAnswer: validation.ok ? modelAnswer : null,
      conditionalAnswer,
      noEvidenceAnswer: buildFinalInsufficientAnswer(input, validation.fixedAnswer?.requiredFacts),
    });
    return finalize(answer, { mode, budget, issueFrames, contextPack, validation, debug });
  } catch (error) {
    if (isLatencyTimeout(error)) {
      const frames = error.issueFrames || emptyFrames();
      return finalize({
        answerType: "needs_clarification",
        verdict: "unknown",
        shortAnswer: `正在深度判断；已识别争点：${issueFrameIds(frames).join("、") || "待识别"}。暂不显示未经验证的结论。`,
        judgeReasoning: [],
        requiredFacts: ["该 legacy 判断仍在等待完整结果。"],
        assumptions: [],
        possibleCounterCases: [],
        confidence: "low",
        pending: true,
      }, { mode, budget, issueFrames: frames, contextPack: emptyContext(input), debug, error });
    }
    return finalize({
      answerType: "cannot_answer_safely",
      verdict: "unknown",
      shortAnswer: "当前无法安全完成规则判断，请确认卡名和场面后重试。",
      judgeReasoning: [],
      requiredFacts: ["相关卡的正式卡名与完整效果文本", "当前阶段、连锁与适用中的效果"],
      assumptions: [],
      possibleCounterCases: [],
      confidence: "low",
      warnings: ["规则分析未生成可验证结论。"],
    }, { mode, budget, issueFrames: emptyFrames(), contextPack: emptyContext(input), debug, error });
  }
}

export async function loadFastJudgeSnapshot(dataDir = join(root, "data")) {
  const cached = fastSnapshotCache.get(dataDir);
  if (cached) return cached;
  const promise = Promise.all([
    readJson(join(dataDir, "cards.json"), { records: [] }),
    readJson(join(dataDir, "qa-index.json"), { records: [] }),
    readJson(join(dataDir, "ocg-rule-corpus.json"), { records: [] }),
    readJson(join(dataDir, "snapshot-meta.json"), {}),
    readJson(join(dataDir, "evidence-index.json"), { records: [] }),
  ]).then(([cards, qa, rules, snapshotMeta, evidenceIndex]) => ({
    cards: cards.records || cards.cards || [],
    snapshotMeta,
    evidenceIndex: evidenceIndex.records || [],
    records: [
      ...(qa.records || []).map((record) => normalizeIndexedEvidence(record, qa.generatedAt)),
      ...(rules.records || []).map((record) => normalizeRuleRecord(record, rules.generatedAt)),
    ],
  })).catch((error) => {
    fastSnapshotCache.delete(dataDir);
    throw error;
  });
  fastSnapshotCache.set(dataDir, promise);
  return promise;
}

function bindExactOfficialQaAnswer({ route, matches, cardIdentityGate, resolvedCards }) {
  if (route?.level !== "official_qa_exact_match" || route.answer?.answerType !== "direct_official") return null;
  if (!cardIdentityGate?.passed) return null;
  const canonicalIds = new Set((resolvedCards || []).map((card) => String(card.id || card.cardId || "")).filter(Boolean));
  if (!canonicalIds.size) return null;

  const refs = new Set((route.answer.judgeReasoning || []).flatMap((item) => item.refs || []).map(String));
  const candidates = (matches?.exact || []).filter((match) => refs.has(String(match.id)));
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  const matchedIds = new Set((candidate.matchedCardIds || []).map(String));
  const identitiesBound = candidate.identityCompatibleForExact === true
    && Number(candidate.cardIdCoverage) === 1
    && [...canonicalIds].every((id) => matchedIds.has(id));
  return identitiesBound ? route.answer : null;
}

function finalize(answer, { mode, budget, issueFrames, contextPack, validation = null, debug = false, error = null }) {
  const refs = (answer.judgeReasoning || []).flatMap((item) => item.refs || []);
  const qaIds = new Set((contextPack.officialQaCandidates || []).map((item) => item.id));
  const faqIds = new Set((contextPack.faqCandidates || []).map((item) => item.id));
  const ruleIds = new Set((contextPack.ruleSnippets || []).map((item) => item.id));
  const analogyIds = new Set((contextPack.knownAnalogies || []).map((item) => item.id));
  const result = {
    answerType: answer.answerType,
    status: statusForProgramVerdict(answer),
    verdict: answer.verdict || "unknown",
    evidenceGrade: evidenceGradeFor(answer, { hasSimilarEvidence: Boolean(contextPack.knownAnalogies?.length) }),
    shortAnswer: trim(answer.shortAnswer || "目前无法判断。", mode === "duel" && !["direct_official", "official_case_based"].includes(answer.answerType) ? 120 : 600),
    judgeReasoning: (answer.judgeReasoning || []).slice(0, 3),
    requiredFacts: answer.requiredFacts || [],
    assumptions: answer.assumptions || [],
    sourceSummary: {
      cardTextRefs: refs.filter((ref) => !qaIds.has(ref) && !faqIds.has(ref) && !ruleIds.has(ref) && !analogyIds.has(ref)),
      officialQaRefs: refs.filter((ref) => qaIds.has(ref) || faqIds.has(ref)),
      ruleRefs: refs.filter((ref) => ruleIds.has(ref)),
      analogyRefs: refs.filter((ref) => analogyIds.has(ref)),
    },
    warnings: [...new Set([...(answer.warnings || []), contextPack.staleness?.userFacingWarning, ...(contextPack.evidenceFreshness?.warnings || [])].filter(Boolean))],
    confidence: answer.confidence || "low",
    possibleCounterCases: answer.possibleCounterCases || [],
    pending: Boolean(answer.pending),
    cards: (contextPack.resolvedCards || []).map((item) => ({ id: item.cardId, name: item.name, cnName: item.names?.zh, jaName: item.names?.ja, enName: item.names?.en })),
    unresolvedCardPrompts: contextPack.unresolvedCards || [],
    pipeline: "fast_judge",
    latencyMs: budget.elapsedMs(),
    ruleEraChecked: true,
    staleRisk: contextPack.staleness?.staleRisk || "none",
    ruleEraNote: contextPack.staleness?.userFacingWarning || "已检查当前规则版本。",
    statusChip: answer.statusChip || statusChipFor(answer, contextPack.staleness, contextPack.evidenceFreshness),
    sourceFreshness: contextPack.evidenceFreshness?.freshness || "unknown",
    sourceRevision: contextPack.snapshotMeta?.sourceRevision || contextPack.evidenceSelection?.currentEvidence?.[0]?.sourceRevision || "",
    evidenceStatus: "current",
    safetyPenalty: contextPack.evidenceFreshness?.safetyPenalty ?? 2,
    dataQualityWarnings: contextPack.snapshotMeta?.dataQualityWarnings || [],
    blockers: answer.blockers || [],
    ruleTrace: answer.ruleTrace || contextPack.chainSafety?.ruleTrace || [],
    userFacingAnswer: answer.userFacingAnswer || answer.shortAnswer || "目前无法判断。",
    uncertainCards: answer.uncertainCards || contextPack.cardIdentityGate?.uncertainCards || [],
    cardIdentity: {
      status: contextPack.cardIdentityGate?.status || "resolved",
      resolvedCards: (contextPack.resolvedCards || []).map((card) => ({ cardId: card.cardId, name: card.name })),
      uncertainCards: answer.uncertainCards || contextPack.cardIdentityGate?.uncertainCards || [],
    },
    explanationDraft: answer.explanationDraft || "",
    confirmationLevel: confirmationLevelFor(answer, contextPack),
    normalRuling: answer.normalRuling || null,
    primaryVerdict: answer.primaryVerdict || null,
    hypotheticalBranch: answer.hypotheticalBranch || null,
    resolutionSteps: answer.resolutionSteps || [],
    finalJudgeSummary: answer.finalJudgeSummary || [],
    afterResolutionCheckpoints: answer.afterResolutionCheckpoints || [],
    finalGameState: answer.finalGameState || null,
    terminalVerdict: answer.terminalVerdict || null,
    damageStepAnalysis: contextPack.damageStepAnalysis || null,
    triggerTimingAnalysis: contextPack.triggerTimingAnalysis || null,
    eventSequence: contextPack.eventSequence || [],
    answerRoute: answer.answerRoute || routeFromLegacyAnswer(answer),
    answerSource: answer.answerSource || "fast_judge",
    officialQaMatch: answer.officialQaMatch || null,
    entityResolution: contextPack.entityResolution || null,
    conditionalBranches: answer.conditionalBranches || [],
    failedParts: answer.failedParts || [],
    continuedParts: answer.continuedParts || [],
    stateChanges: answer.stateChanges || [],
  };
  const policyResult = applyProgramVerdictPolicy(result, answer.explanationDraft || "");
  Object.assign(result, policyResult);
  result.answerModel = buildProgramAnswerModel(result);
  result.answer = {
    conclusion: result.answerModel.conclusion,
    evidenceGrade: result.answerModel.evidenceGrade,
    keyReasoning: result.answerModel.keyActions.join("；"),
    process: result.answerModel.process.join("；"),
    notes: result.answerModel.notes.join("；"),
  };
  if (debug || mode === "analysis") {
    result.debug = {
      issueFrames,
      contextPack,
      validation,
      latency: { mode, budgetMs: budget.budgetMs, elapsedMs: budget.elapsedMs() },
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    };
  }
  return result;
}

function buildPrimitiveResolutionAnswer(chainSafety) {
  const results = chainSafety.resolutionResults || [];
  const steps = results.flatMap((item) => item.steps || []);
  const failedParts = results.flatMap((item) => item.failedParts || []);
  const continuedParts = results.flatMap((item) => item.continuedParts || []);
  const stateChanges = results.flatMap((item) => item.stateChanges || []);
  const status = chainSafety.status;
  const labels = {
    resolved: "合法连锁已按 primitive 全部处理。",
    partially_resolved: "合法连锁仅部分处理；失败部分已跳过。",
    failed: "合法发动后，没有 primitive 能成功处理。",
    insufficient: "当前状态不足以可靠执行 primitive，已停止处理。",
  };
  return {
    answerType: status === "insufficient" ? "needs_clarification" : "rule_judgment",
    status,
    verdict: status,
    evidenceGrade: status === "insufficient" ? "insufficient" : "rule_derived",
    shortAnswer: labels[status] || "primitive 处理完成。",
    userFacingAnswer: labels[status] || "primitive 处理完成。",
    judgeReasoning: [],
    requiredFacts: status === "insufficient" ? ["补充 primitive 所需的对象、来源区域、手卡、卡组或基本分状态"] : [],
    assumptions: chainSafety.assumptions || [],
    possibleCounterCases: [],
    confidence: status === "insufficient" ? "low" : "medium",
    blockers: [],
    ruleTrace: chainSafety.ruleTrace || [],
    resolutionSteps: steps,
    failedParts,
    continuedParts,
    stateChanges,
    finalGameState: chainSafety.gameState || null,
  };
}

function buildIllegalChainAnswer(chainSafety) {
  const link = chainSafety.invalidChainLink || "该连锁点";
  return {
    answerType: "rule_judgment",
    status: "illegal_question",
    verdict: "cannot_activate",
    evidenceGrade: "illegal_question",
    shortAnswer: `${link}不能合法发动，题设连锁不成立；未进入后续效果处理。`,
    userFacingAnswer: `${link}不能合法发动，后续连锁处理不成立。`,
    judgeReasoning: (chainSafety.blockers || []).slice(0, 3).map((item) => ({ text: item.explanation, basis: ["rule_blocker"], refs: [] })),
    requiredFacts: [],
    assumptions: chainSafety.assumptions || [],
    possibleCounterCases: [],
    confidence: "medium",
    blockers: chainSafety.blockers || [],
    ruleTrace: chainSafety.ruleTrace || [],
    resolutionSteps: [],
  };
}

function buildTemplateInsufficientAnswer(chainSafety) {
  return {
    answerType: "needs_clarification",
    status: "insufficient",
    verdict: "insufficient",
    evidenceGrade: "insufficient",
    shortAnswer: "没有找到对应效果模板，且现有证据不能安全执行该效果。",
    userFacingAnswer: "当前没有对应效果模板，无法安全模拟处理。",
    judgeReasoning: [],
    requiredFacts: (chainSafety.missingTemplates || []).map((item) => `补充 ${item.cardId || "unknown"} 的效果 ${item.effectNo || "unknown"} 模板`),
    assumptions: [],
    possibleCounterCases: [],
    confidence: "low",
    blockers: [],
    ruleTrace: chainSafety.ruleTrace || [],
    resolutionSteps: [],
    warnings: ["effect_template_missing"],
  };
}

function hasRequiredTextGap(issueFrames, profiles) {
  const required = new Set((issueFrames.primaryIssueFrames || []).flatMap((frame) => frame.requiredCardSections || []));
  if (required.has("pendulumEffects") && !profiles.some((profile) => profile.sections?.pendulumEffects?.length)) return true;
  return profiles.some((profile) => (profile.missingSections || []).some((section) => required.has(section)));
}

function hasUnresolvedCardsWithoutText(unresolvedCards, temporaryProfiles) {
  const covered = new Set(temporaryProfiles.map((profile) => profile.names.zh || profile.names.ja || profile.names.en));
  return unresolvedCards.some((item) => !covered.has(item.unresolvedCardName));
}

function buildNoIssueClarification(question, contextPack) {
  const card = contextPack.resolvedCards?.[0]?.name || contextPack.unresolvedCards?.[0]?.unresolvedCardName || "相关卡片";
  return {
    answerType: "needs_clarification",
    verdict: "unknown",
    shortAnswer: `请补充想确认的裁定点：${card}是要确认能否发动、效果如何处理，还是战斗伤害？`,
    judgeReasoning: [],
    requiredFacts: ["明确要判断的动作或结果", "当前阶段、连锁和相关卡片状态"],
    assumptions: [],
    possibleCounterCases: [],
    confidence: "low",
  };
}

function buildFinalInsufficientAnswer(question, requiredFacts = []) {
  return {
    answerType: "needs_clarification",
    answerRoute: "insufficient",
    answerSource: "official_qa_first_router",
    status: "insufficient",
    verdict: "insufficient",
    evidenceGrade: "insufficient",
    shortAnswer: "现有官方 Q&A、效果模板和条件信息均不足以安全形成结论。",
    judgeReasoning: [],
    requiredFacts: [...new Set([...(requiredFacts || []), "补充正式卡名、效果编号、当前区域、对象和连锁状态"])],
    assumptions: [],
    possibleCounterCases: [],
    confidence: "low",
    warnings: ["official_qa_template_and_conditional_routes_exhausted"],
    originalQuestion: String(question || ""),
  };
}

function buildEmptyAnswer() {
  return { answerType: "needs_clarification", verdict: "unknown", shortAnswer: "请输入要裁定的对局问题。", judgeReasoning: [], requiredFacts: ["卡名、场面和要确认的结果"], assumptions: [], confidence: "low" };
}

function emptyFrames() {
  return { primaryIssueFrames: [], secondaryIssueFrames: [], rejectedIssueFrames: [] };
}

function emptyContext(question) {
  return { question, resolvedCards: [], unresolvedCards: [], relevantCardSections: [], officialQaCandidates: [], faqCandidates: [], ruleSnippets: [], knownAnalogies: [], cardProfiles: [] };
}

function normalizeIndexedEvidence(record = {}, generatedAt = null) {
  return {
    ...record,
    recordType: record.recordType || (String(record.id || "").startsWith("card-faq-") ? "card-faq" : "qa"),
    question: record.question || "",
    conclusion: record.conclusion || record.text || "",
    sources: record.sources || [{ label: record.recordType === "qa" ? "YGOResources Q&A" : "YGOResources Card FAQ", detail: record.sourceUrl || "" }],
    lastCheckedAt: record.lastCheckedAt || generatedAt || null,
    sourceType: record.sourceType || (record.recordType === "qa" ? "official_qa" : "card_faq"),
    format: record.format || "ocg",
    ruleEra: record.ruleEra || "current",
  };
}

function normalizeRuleRecord(record = {}, generatedAt = null) {
  return { ...record, conclusion: record.conclusion || record.text || "", sources: record.sources || [{ label: record.sourceName || "OCG Rule", detail: record.sourceUrl || "" }], lastCheckedAt: record.lastCheckedAt || generatedAt || null };
}

function statusChipFor(answer, staleness = {}, freshness = {}) {
  if (freshness.freshness && freshness.freshness !== "fresh") return "OUTDATED-RISK";
  if (staleness.matchedRuleChanges?.length && !(staleness.currentEvidenceIds || []).length) return "OUTDATED-RISK";
  if (answer.answerType === "direct_official") return "OFFICIAL";
  if (answer.answerType === "official_case_based") return "OFFICIAL-CASE";
  if (answer.answerType === "rule_judgment") return "RULE-JUDGED";
  return "NEEDS-INFO";
}

function confirmationLevelFor(answer = {}, contextPack = {}) {
  if (answer.answerType === "direct_official" && answer.answerRoute === "official_qa_exact_match") return "official_confirmed";
  if (answer.answerType === "direct_official") return "confirmed";
  if (answer.answerType === "official_case_based") return "conditional_official_case";
  if (answer.answerType === "rule_judgment") return "rule_derived";
  if (contextPack.damageStepAnalysis?.confirmationLevel === "insufficient_info"
    || contextPack.triggerTimingAnalysis?.confirmationLevel === "insufficient_info") return "insufficient_info";
  return "conditional";
}

function mergeOfficialSearchIntoContext(contextPack, search) {
  const qa = [];
  const faq = [];
  for (const match of search.all || []) {
    const candidate = {
      id: match.id,
      source: match.record.sources?.[0]?.label || match.record.recordType,
      recordType: match.record.recordType,
      title: match.record.title || "",
      cardIds: match.record.cardIds || [],
      cards: match.record.cards || [],
      score: Math.round(match.score * 1000),
      matchedBy: match.matchedBy,
      text: match.record.text || match.record.answer || "",
      sourceUrl: match.record.sourceUrl || "",
      metadata: match.record,
      record: match.record,
    };
    (match.record.recordType === "card-faq" ? faq : qa).push(candidate);
  }
  contextPack.officialQaCandidates = mergeCandidates(qa, contextPack.officialQaCandidates || []).slice(0, 20);
  contextPack.faqCandidates = mergeCandidates(faq, contextPack.faqCandidates || []).slice(0, 20);
}

function mergeCandidates(primary, secondary) {
  const map = new Map();
  for (const item of [...primary, ...secondary]) if (!map.has(String(item.id))) map.set(String(item.id), item);
  return [...map.values()];
}

function routeFromLegacyAnswer(answer = {}) {
  if (answer.answerType === "direct_official") return "official_qa_exact_match";
  if (answer.answerType === "rule_judgment") return "rule_engine_answer";
  if (answer.answerType === "needs_clarification") return "conditional_branch_answer";
  return "needs_more_info";
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

function trim(value, max) {
  const text = String(value || "");
  return text.length <= max ? text : text.slice(0, max);
}
