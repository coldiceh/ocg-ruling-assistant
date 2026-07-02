import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCardProfiles } from "./cardProfile.mjs";
import { classifyQaForSubQuestion } from "./engine.mjs";
import { detectIssueFrames, issueFrameIds } from "./issueFrameDetector.mjs";
import { runJudgeAnswerModel } from "./judgeAnswerModel.mjs";
import { buildSafeClarification, validateJudgeAnswer } from "./judgeAnswerValidator.mjs";
import { createLatencyBudget, isLatencyTimeout, runWithinLatencyBudget } from "./latencyBudget.mjs";
import { buildRulingContextPack, buildTemporaryCardProfiles, resolveCardsForFastJudge } from "./rulingContextPack.mjs";
import { checkStaleness } from "./stalenessGuard.mjs";
import { detectCurrentVerdictConflicts, filterCurrentEvidence } from "./currentEvidenceFilter.mjs";
import { evaluateEvidenceFreshness } from "./evidenceFreshness.mjs";
import { buildBlockerAnswer, evaluateRulingBlockers } from "./rulingBlockers.mjs";
import { buildDamageStepAnalysis, cardProfileRuleText } from "./damageStepRules.mjs";
import { buildDamageStepBlockerAnswer, evaluateDamageStepBlocker } from "./damageStepBlockers.mjs";
import { buildEventSequenceFromQuestion, buildTriggerTimingAnalysis, classifyTriggerWording, shouldAnalyzeTriggerTiming } from "./triggerTimingRules.mjs";
import { buildTimingMissBlockerAnswer, evaluateTimingMissBlocker } from "./timingMissBlockers.mjs";
import { resolveEntitiesFromOfficialQaMatch, searchOfficialQaEvidence } from "./officialQaMatcher.mjs";
import { buildGenericRuleEngineAnswer, routeAnswer, selectOfficialQaRoute } from "./answerRouter.mjs";
import { buildConditionalBranchAnswer } from "./conditionalAnswerBuilder.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fastSnapshotCache = new Map();

export async function answerRulingQuestionFast({ question, mode = "duel", maxLatencyMs = 6000, env = globalThis.process?.env || {}, dataDir = join(root, "data"), snapshot, modelInvoker, debug = false } = {}) {
  const input = String(question || "").trim();
  const budget = createLatencyBudget({ mode, maxLatencyMs });
  if (!input) return finalize(buildEmptyAnswer(), { mode, budget, issueFrames: emptyFrames(), contextPack: emptyContext(input), debug });

  try {
    const localSnapshot = snapshot || await runWithinLatencyBudget(() => loadFastJudgeSnapshot(dataDir), budget, "fast_context_load");
    const evidenceSelection = filterCurrentEvidence(localSnapshot.records || [], {
      evidenceIndex: localSnapshot.evidenceIndex || [],
      sourceFreshness: localSnapshot.snapshotMeta?.sourceFreshness || "unknown",
      detectConflicts: false,
    });
    const activeSnapshot = { ...localSnapshot, records: evidenceSelection.currentEvidence };
    const rawOfficialQaSearch = searchOfficialQaEvidence({ question: input, records: activeSnapshot.records });
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
    contextPack.answerRouter = { officialQaRoute: officialQaRoute.level, conflicts: officialQaRoute.conflicts || [] };
    const legacyDirectOfficial = officialQaRoute.answer ? null : findDirectOfficialAnswer(input, contextPack, issueFrames, staleness, evidenceFreshness);
    const directOfficial = officialQaRoute.answer?.answerType === "direct_official" ? officialQaRoute.answer : legacyDirectOfficial;
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

    if (officialQaRoute.answer) {
      return finalize(officialQaRoute.answer, { mode, budget, issueFrames, contextPack, debug });
    }

    if (legacyDirectOfficial) {
      const validation = validateJudgeAnswer({ question: input, issueFrames, contextPack, modelAnswer: legacyDirectOfficial });
      if (validation.ok) return finalize(legacyDirectOfficial, { mode, budget, issueFrames, contextPack, validation, debug });
    }

    const blockerCards = collectBlockerCards(resolution, localSnapshot.cards || []);
    const blockerResult = evaluateRulingBlockers({ question: input, cards: blockerCards });
    if (blockerResult.hasBlocker) {
      return finalize(buildBlockerAnswer(blockerResult), { mode, budget, issueFrames, contextPack, debug });
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
      const answer = routeAnswer({ conditionalAnswer, noEvidenceAnswer: buildNoIssueClarification(input, contextPack) });
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
      const answer = routeAnswer({ conditionalAnswer, noEvidenceAnswer: buildSafeClarification(input, issueFrames, contextPack, {}) });
      return finalize(answer, { mode, budget, issueFrames, contextPack, debug });
    }
    const validation = validateJudgeAnswer({ question: input, issueFrames, contextPack, modelAnswer });
    const conditionalAnswer = validation.ok ? null : buildConditionalBranchAnswer({ question: input, contextPack, officialMatches: officialQaSearch, damageStepAnalysis, triggerTimingAnalysis, reason: "规则模型输出未通过结构化验证，已降级为条件回答。" });
    const answer = routeAnswer({
      ruleEngineAnswer: validation.ok ? modelAnswer : null,
      conditionalAnswer,
      noEvidenceAnswer: validation.fixedAnswer,
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
        requiredFacts: ["可点击“深度解析”继续等待完整判断。"],
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

export function findDirectOfficialAnswer(question, contextPack, issueFrames, staleness = contextPack.staleness || {}, freshness = contextPack.evidenceFreshness || {}) {
  if (freshness.freshness !== "fresh" || freshness.safetyPenalty > 0) return null;
  const primaryCard = contextPack.resolvedCards?.[0];
  if (!primaryCard || !issueFrames.primaryIssueFrames?.length) return null;
  const subQuestion = buildLegacySubQuestion(question, primaryCard.name, issueFrames.primaryIssueFrames);
  const staleIds = new Set(staleness.staleEvidenceIds || []);
  const candidates = [...(contextPack.officialQaCandidates || []), ...(contextPack.faqCandidates || [])]
    .filter((candidate) => !staleIds.has(String(candidate.id)));
  const direct = candidates.map((candidate) => {
    const classification = classifyQaForSubQuestion(subQuestion, normalizeIndexedEvidence(candidate.record || candidate));
    return { candidate, classification };
  }).filter((item) => item.classification.match === "direct" && item.classification.extractedVerdict && item.classification.extractedVerdict !== "unknown");
  if (!direct.length) return null;
  const verdicts = new Set(direct.map((item) => normalizeFastVerdict(item.classification.extractedVerdict, subQuestion.type)));
  if (verdicts.size !== 1) return null;
  const verdict = [...verdicts][0];
  const selected = direct[0];
  const issueText = humanIssue(issueFrameIds(issueFrames));
  return {
    answerType: "direct_official",
    verdict,
    shortAnswer: directShortAnswer(primaryCard.name, verdict),
    judgeReasoning: [{
      text: `${selected.candidate.title || "官方问答"}直接覆盖${primaryCard.name}的${issueText}。`,
      basis: ["official_qa"],
      refs: [selected.candidate.id],
    }],
    requiredFacts: [],
    assumptions: [],
    possibleCounterCases: [],
    confidence: "high",
  };
}

function finalize(answer, { mode, budget, issueFrames, contextPack, validation = null, debug = false, error = null }) {
  const refs = (answer.judgeReasoning || []).flatMap((item) => item.refs || []);
  const qaIds = new Set((contextPack.officialQaCandidates || []).map((item) => item.id));
  const faqIds = new Set((contextPack.faqCandidates || []).map((item) => item.id));
  const ruleIds = new Set((contextPack.ruleSnippets || []).map((item) => item.id));
  const analogyIds = new Set((contextPack.knownAnalogies || []).map((item) => item.id));
  const result = {
    answerType: answer.answerType,
    verdict: answer.verdict || "unknown",
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

function buildLegacySubQuestion(question, cardName, frames) {
  const ids = frames.map((item) => item.id);
  let type = "unknown";
  let askedResult = "unknown";
  if (ids.includes("activation_legality") || ids.includes("damage_step_timing")) { type = "activation_condition"; askedResult = "can_activate"; }
  else if (ids.includes("piercing_battle_damage") || ids.includes("battle_damage_calculation")) { type = "resolution_handling"; askedResult = "battle_damage_result"; }
  else if (ids.includes("attack_target_legality")) { type = "resolution_handling"; askedResult = "attack_target_legality"; }
  else if (ids.includes("effect_resolution") || ids.includes("copy_or_gain_effect")) { type = "resolution_handling"; askedResult = "effect_resolution_result"; }
  return { id: "fast-q1", type, card: cardName, askedResult, sourceText: question };
}

function normalizeFastVerdict(verdict, type) {
  const mapping = {
    can: type === "activation_condition" ? "can_activate" : "yes",
    cannot: type === "activation_condition" ? "cannot_activate" : "no",
    yes: "yes",
    no: "no",
    sent_to_graveyard: "applies",
    not_sent_to_graveyard: "does_not_apply",
    banished_temporarily: "applies",
  };
  return mapping[verdict] || (String(verdict).startsWith("activates_") ? "applies" : "unknown");
}

function directShortAnswer(cardName, verdict) {
  const labels = { yes: "可以。", no: "不可以。", can_activate: "可以发动。", cannot_activate: "不能发动。", applies: "该处理适用。", does_not_apply: "该处理不适用。" };
  return `${cardName}：${labels[verdict] || "官方问答给出了直接处理。"}`;
}

function humanIssue(ids) {
  const labels = { activation_legality: "发动条件", damage_step_timing: "伤害步骤时点", effect_resolution: "效果处理", piercing_battle_damage: "贯穿伤害", battle_damage_calculation: "战斗伤害", attack_target_legality: "攻击对象", copy_or_gain_effect: "获得效果" };
  return ids.map((id) => labels[id] || id).join("、");
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

function collectBlockerCards(resolution, cards) {
  const ids = new Set((resolution.unresolvedCards || []).flatMap((item) => item.candidateCards || []).map((item) => String(item.cardId || item.id || "")).filter(Boolean));
  const candidates = cards.filter((card) => ids.has(String(card.id || card.cardId || "")));
  return [...(resolution.resolvedCards || []), ...candidates];
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
