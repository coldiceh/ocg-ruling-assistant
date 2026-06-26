import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { answerQuestion, loadSnapshot } from "../backend/engine.mjs";

export const UNKNOWN_REASON_KEYS = [
  "parser_warning",
  "card_resolution_failed",
  "data_source_missing",
  "retrieval_empty",
  "matcher_rejected_all",
  "no_direct_evidence",
  "verdict_extraction_unknown",
  "condition_branch_missing_state",
  "condition_branch_ambiguous",
  "unresolved_dependency",
  "heuristic_limit",
  "unknown_other",
];

export const DIRECT_DOWNGRADE_REASON_KEYS = [
  "evidence_mentions_action_but_not_asked_result",
  "different_question",
  "different_card_or_context",
  "no_explicit_polarity",
  "conflicting_direct_evidence",
];

export const NO_DIRECT_REASON_KEYS = [
  "retrieval_empty",
  "data_missing_for_card",
  "query_missed",
  "all_candidates_different_question",
  "all_candidates_conflicting",
  "alias_or_card_resolution_issue",
  "ranking_issue",
  "unknown",
];

export const BENCHMARK_CASES = [
  {
    id: "toon-battle-destruction-chain",
    expectedSafety: "must_not_confirm",
    expectedPrimaryReason: "unresolved_dependency",
    expectedCards: ["完美世界-卡通世界", "青眼暴君龙", "referenced_toon_monster"],
    expectedQuestionTypes: ["temporary_banish", "send_to_gy", "activation_location", "location_change"],
    question: `被青眼暴君龙战破的卡通怪兽在伤害步骤结束阶段发动盖放墓地陷阱卡效果的时候：
能用完美世界-卡通世界的效果除外该卡通怪兽吗？
卡通怪兽还会被战破送墓吗？
如果青眼暴君龙被战破，这个效果是在墓地发动还是在场上发动？
这个时候青眼暴君龙是否已经送墓？`,
  },
  {
    id: "tyrant-remains-on-field",
    expectedSafety: "should_confirm",
    expectedCards: ["青眼暴君龙"],
    expectedQuestionTypes: ["activation_location"],
    question: "青眼暴君龙没有被战斗破坏，仍在怪兽区时，它的③效果是在场上发动还是在墓地发动？",
  },
  {
    id: "tyrant-sent-to-graveyard",
    expectedSafety: "should_confirm",
    expectedCards: ["青眼暴君龙"],
    expectedQuestionTypes: ["activation_location"],
    question: "青眼暴君龙被战斗破坏并送去墓地后，它的③效果是在墓地发动还是在场上发动？",
  },
  {
    id: "tyrant-banished-after-battle",
    expectedSafety: "should_confirm",
    expectedCards: ["青眼暴君龙"],
    expectedQuestionTypes: ["activation_location"],
    question: "青眼暴君龙被战斗破坏并被表侧除外后，它的③效果在哪里发动？",
  },
  {
    id: "perfect-toon-world-temporary-banish",
    expectedSafety: "should_confirm",
    expectedCards: ["完美世界-卡通世界"],
    expectedQuestionTypes: ["temporary_banish"],
    question: "伤害计算后已经确定会被战斗破坏的卡通怪兽，能用完美世界-卡通世界的③效果暂时除外到效果处理后吗？",
  },
  {
    id: "triple-tactics-talent-activation",
    expectedSafety: "may_confirm",
    expectedCards: ["三战之才"],
    expectedQuestionTypes: ["activation_condition"],
    question: "对方在我的主要阶段发动过怪兽效果后，我能否发动三战之才？",
  },
  {
    id: "ip-masquerena-link-summon",
    expectedSafety: "may_confirm",
    expectedCards: ["I：P百变莱娜", "S：P小夜骑士"],
    expectedQuestionTypes: ["activation_condition"],
    question: "对方主要阶段，能否发动I：P百变莱娜的效果，用它和另一只怪兽连接召唤S：P小夜骑士？",
  },
  {
    id: "chaos-max-double-edged-sword",
    expectedSafety: "must_not_confirm",
    expectedCards: ["青眼混沌极限龙", "脆刃之剑"],
    expectedQuestionTypes: ["resolution_handling"],
    question: "装备脆刃之剑的青眼混沌极限龙攻击守备表示怪兽时，双方受到的战斗伤害怎样处理？",
  },
  {
    id: "ohime-damage-step-activation",
    expectedSafety: "may_confirm",
    expectedCards: ["大日女之御巫"],
    expectedQuestionTypes: ["activation_condition"],
    question: "大日女之御巫的①效果能否在伤害步骤发动？",
  },
  {
    id: "branded-fusion-material-location",
    expectedSafety: "may_confirm",
    expectedCards: ["烙印融合", "阿尔白斯之落胤", "烙印龙 阿尔比昂"],
    expectedQuestionTypes: ["activation_condition"],
    question: "发动烙印融合时，能否用手卡的阿尔白斯之落胤和卡组中的怪兽作为素材融合召唤烙印龙 阿尔比昂？",
  },
  {
    id: "tyrant-unspecified-branch",
    expectedSafety: "must_not_confirm",
    expectedPrimaryReason: "condition_branch_missing_state",
    expectedCards: ["青眼暴君龙"],
    expectedQuestionTypes: ["activation_location"],
    question: "青眼暴君龙被战斗破坏的时候，这个效果是在墓地发动还是在场上发动？",
  },
  {
    id: "albaz-provisional-official-response",
    expectedSafety: "must_not_confirm",
    expectedPrimaryReason: "provisional_official_response",
    expectedCards: ["アルバスの落胤", "導きの聖女エクレシア", "聖痕喰らいし竜"],
    expectedQuestionTypes: ["activation_condition"],
    question: "自分のEXデッキに氷剣竜ミラジェイドが存在し、手札に導きの聖女エクレシアとアルバスの落胤があり、相手フィールドに表側表示の聖痕喰らいし竜のみ存在します。アルバスの落胤を召喚した時、導きの聖女エクレシアをコストとして墓地へ送り、アルバスの落胤①の効果を発動できますか？",
  },
  {
    id: "cyber-jar-battle-destruction",
    expectedSafety: "may_confirm",
    expectedCards: ["电子壶"],
    expectedQuestionTypes: ["send_to_gy", "resolution_handling"],
    question: "电子壶被攻击翻开并确定会被战斗破坏时，它自身效果处理后还会送去墓地吗？",
  },
  {
    id: "macro-cosmos-power-tool-replacement",
    expectedSafety: "must_not_confirm",
    expectedCards: ["大宇宙", "动力工具龙"],
    expectedQuestionTypes: ["resolution_handling"],
    question: "大宇宙适用中，动力工具龙被破坏的场合，能否把装备魔法送去墓地来代替破坏？",
  },
  {
    id: "ip-main-phase-link-summon",
    expectedSafety: "may_confirm",
    expectedCards: ["I：P百变莱娜"],
    expectedQuestionTypes: ["activation_condition"],
    question: "对方主要阶段，I：P百变莱娜能否发动①效果立即进行连接召唤？",
  },
  {
    id: "ecclesia-damage-step-quick-effect",
    expectedSafety: "may_confirm",
    expectedCards: ["白之圣女 艾克利西亚"],
    expectedQuestionTypes: ["activation_condition"],
    question: "白之圣女 艾克莉西娅的②效果能否在伤害步骤发动？",
  },
  {
    id: "sky-striker-kagari-link-summon",
    expectedSafety: "may_confirm",
    expectedCards: ["闪刀姬-燎里"],
    expectedQuestionTypes: ["activation_condition"],
    question: "闪刀姬-燎里连接召唤成功时，能否发动①效果把墓地的闪刀魔法加入手卡？",
  },
  {
    id: "evenly-matched-second-copy",
    expectedSafety: "must_not_confirm",
    expectedCards: ["颉颃胜负", "神之宣告"],
    expectedQuestionTypes: ["activation_condition"],
    question: "战斗阶段结束时发动颉颃胜负，对方连锁神之宣告无效并破坏后，我还能再发动另一张颉颃胜负吗？",
  },
  {
    id: "impermanence-gemini-target",
    expectedSafety: "may_confirm",
    expectedCards: ["无限泡影"],
    expectedQuestionTypes: ["target"],
    question: "场上表侧表示但还没有再一次召唤的二重怪兽，可以成为无限泡影的对象吗？",
  },
  {
    id: "toon-world-alias-resolution",
    expectedSafety: "must_not_confirm",
    expectedCards: ["Perfect Toon World"],
    expectedQuestionTypes: ["temporary_banish"],
    question: "Perfect Toon World 能把已经确定会被战斗破坏的 Toon monster 暂时 banish 吗？",
  },
];

export function classifyPrimaryUnknownReason({ answer = {}, subAnswer = {}, trace = {} } = {}) {
  const parserWarnings = answer.parserWarnings || answer.parserDebug?.parserWarnings || [];
  if (parserWarnings.length) return "parser_warning";
  if (answer.status === "data_source_missing" || answer.parserDebug?.dataSourceStats?.status === "data_source_missing") {
    return "data_source_missing";
  }

  if ((subAnswer.unresolvedDependencies || trace.unresolvedDependencies || []).length) return "unresolved_dependency";
  if (trace.branchSelector?.status === "missing_state") return "condition_branch_missing_state";
  if (trace.branchSelector?.status === "ambiguous") return "condition_branch_ambiguous";

  const resolvedCardIds = trace.resolvedCardIds || [];
  const isSymbolicReference = subAnswer.card === "referenced_toon_monster";
  if (!isSymbolicReference && (
    trace.evidenceCoverageReason === "card_resolution_failed"
    || trace.evidenceCoverageReason === "alias_without_card_id"
    || (Array.isArray(resolvedCardIds) && resolvedCardIds.length === 0 && subAnswer.card && subAnswer.card !== "unknown")
  )) {
    return "card_resolution_failed";
  }

  const rawCandidates = trace.rawCandidateEvidence;
  const directEvidence = trace.directEvidence || [];
  const similarEvidence = trace.similarEvidence || [];
  if (Array.isArray(rawCandidates) && rawCandidates.length === 0) return "retrieval_empty";
  if (Array.isArray(rawCandidates) && rawCandidates.length > 0 && directEvidence.length === 0 && similarEvidence.length === 0) {
    return "matcher_rejected_all";
  }
  if (directEvidence.length === 0 && similarEvidence.length > 0) return "no_direct_evidence";
  if (directEvidence.length > 0 && (!trace.extractedVerdict || trace.extractedVerdict === "unknown")) {
    return "verdict_extraction_unknown";
  }
  const ruleSourceType = subAnswer.derivedState?.ruleSource?.sourceType || trace.derivedState?.ruleSource?.sourceType;
  if (["heuristic", "official_database_card_page", "official_response_screenshot", "official_response_unverified", "pending_adjustment"].includes(ruleSourceType)) return "heuristic_limit";
  return "unknown_other";
}

export function buildBenchmarkReport(caseResults) {
  const results = Array.isArray(caseResults) ? caseResults : [];
  const unknownReasons = Object.fromEntries(UNKNOWN_REASON_KEYS.map((key) => [key, 0]));
  const downgradeReasons = Object.fromEntries(DIRECT_DOWNGRADE_REASON_KEYS.map((key) => [key, 0]));
  const noDirectReasons = Object.fromEntries(NO_DIRECT_REASON_KEYS.map((key) => [key, 0]));
  const unsafeConfirmed = new Set();
  let totalSubQuestions = 0;
  let missingReasonCount = 0;
  let confirmedCount = 0;
  let inferredCount = 0;
  let unknownCount = 0;
  let directEvidenceCount = 0;
  let downgradedDirectCount = 0;
  let conditionalAnswerCount = 0;
  let clarificationQuestionCount = 0;
  const verdictExtractionDiagnostics = [];
  const noDirectEvidenceDiagnostics = [];

  const perCase = results.map(({ benchmarkCase, answer, snapshot }) => {
    if (answer?.mode === "confirmed") confirmedCount += 1;
    else if (answer?.mode === "inferred") inferredCount += 1;
    else unknownCount += 1;
    const traces = new Map((answer?.parserDebug?.evidenceTrace || []).map((item) => [String(item.questionId), item]));
    const formalQuestions = new Map((answer?.formalQuery?.subQuestions || []).map((item) => [String(item.id), item]));
    const evidenceBuckets = new Map((answer?.evidence?.bySubQuestion || []).map((item) => [String(item.subQuestionId), item]));
    const parserWarnings = answer?.parserWarnings || answer?.parserDebug?.parserWarnings || [];
    const subQuestions = (answer?.subAnswers || []).map((subAnswer) => {
      totalSubQuestions += 1;
      const questionId = String(subAnswer.questionId || subAnswer.id);
      const trace = traces.get(questionId) || {};
      const formalQuestion = formalQuestions.get(questionId) || {};
      if (subAnswer.conditionalAnswer) conditionalAnswerCount += 1;
      if (subAnswer.conditionalAnswer?.clarificationQuestion) clarificationQuestionCount += 1;
      const downgradedDirectEvidence = trace.downgradedDirectEvidence || [];
      directEvidenceCount += (trace.directEvidence || []).length;
      downgradedDirectCount += downgradedDirectEvidence.length;
      for (const item of downgradedDirectEvidence) {
        const reason = normalizeDowngradeReason(item.reason);
        if (reason) downgradeReasons[reason] += 1;
      }
      const key = `${benchmarkCase.id}:${questionId}`;
      if (subAnswer.status === "confirmed") {
        if (!(trace.directEvidence || []).length) unsafeConfirmed.add(`${key}:directEvidence_missing`);
        if (!(subAnswer.evidenceIds || []).length) unsafeConfirmed.add(`${key}:evidenceIds_missing`);
        if (!trace.extractedVerdict || trace.extractedVerdict === "unknown") unsafeConfirmed.add(`${key}:verdict_unknown`);
        if (parserWarnings.length) unsafeConfirmed.add(`${key}:parser_warning_present`);
        if ((subAnswer.unresolvedDependencies || []).length) unsafeConfirmed.add(`${key}:unresolved_dependency_present`);
      }
      if (subAnswer.status === "unknown" && !String(subAnswer.reason || "").trim()) missingReasonCount += 1;
      const primaryUnknownReason = subAnswer.status === "unknown"
        ? classifyPrimaryUnknownReason({ answer, subAnswer, trace })
        : null;
      if (primaryUnknownReason) unknownReasons[primaryUnknownReason] += 1;

      if (primaryUnknownReason === "no_direct_evidence") {
        const dataCoverage = buildDataCoverageAudit({
          snapshot,
          trace,
          card: subAnswer.card || trace.card,
          onDemandSync: answer?.parserDebug?.onDemandSync,
        });
        const primaryNoDirectReason = classifyPrimaryNoDirectReason({ trace, dataCoverage });
        noDirectReasons[primaryNoDirectReason] += 1;
        noDirectEvidenceDiagnostics.push({
          caseId: benchmarkCase.id,
          questionId,
          sourceText: subAnswer.sourceText || trace.sourceText || "unknown",
          type: subAnswer.type || trace.type || "unknown",
          card: subAnswer.card || trace.card || "unknown",
          askedResult: formalQuestion.askedResult || "unknown",
          resolvedCardIds: trace.resolvedCardIds || [],
          searchQueries: trace.searchQueries || [],
          rawCandidateEvidenceTop50: (trace.rawCandidateEvidence || []).slice(0, 50).map((item) => ({
            id: item.id,
            source: item.source,
            title: item.title,
            cardIds: item.cardIds || [],
            score: item.score || 0,
            matchedBy: item.matchedBy || [],
            textPreview: item.textPreview || "",
            classification: item.classification || "unknown",
            rejectedReason: item.rejectedReason || null,
            askedResultCoverage: item.askedResultCoverage || "unknown",
          })),
          similarEvidence: trace.similarEvidence || [],
          rejectedEvidence: trace.rejectedEvidence || [],
          dataCoverage,
          primaryNoDirectReason,
          diagnosticFlags: buildNoDirectDiagnosticFlags(trace),
        });
      }

      if (primaryUnknownReason === "verdict_extraction_unknown") {
        const bucket = evidenceBuckets.get(questionId) || {};
        const rawById = new Map((trace.directEvidence || []).map((item) => [String(item.id), item]));
        const directEvidence = (bucket.rulingEvidence || bucket.directEvidence || []).map((item) => {
          const id = String(item.evidenceId || item.id || "unknown");
          const raw = rawById.get(id) || {};
          return {
            id,
            source: raw.source || item.sources?.[0]?.label || item.recordType || "unknown",
            title: raw.title || item.title || "",
            textPreview: raw.textPreview || evidenceFullText(item).slice(0, 320),
            fullText: evidenceFullText(item),
            matchedBy: raw.matchedBy || [],
            score: Number(raw.score || item.formalScore || 0),
          };
        });
        verdictExtractionDiagnostics.push({
          caseId: benchmarkCase.id,
          questionId,
          sourceText: subAnswer.sourceText || trace.sourceText || "unknown",
          type: subAnswer.type || trace.type || "unknown",
          card: subAnswer.card || trace.card || "unknown",
          askedResult: formalQuestion.askedResult || "unknown",
          directEvidence,
          extractorInput: trace.extractorInput || [],
          extractorOutput: trace.extractorOutput || [],
          extractorWarnings: trace.extractorWarnings || [],
          whyUnknown: trace.whyUnknown || subAnswer.whyUnknown || "unknown",
        });
      }

      return {
        questionId,
        sourceText: subAnswer.sourceText || trace.sourceText || "unknown",
        type: subAnswer.type || trace.type || "unknown",
        card: subAnswer.card || trace.card || "unknown",
        askedResult: formalQuestion.askedResult || "unknown",
        finalStatus: subAnswer.status || trace.finalStatus || "unknown",
        finalVerdict: subAnswer.verdict || trace.finalVerdict || "unknown",
        primaryUnknownReason,
        resolvedCardIds: trace.resolvedCardIds || [],
        directEvidenceCount: (trace.directEvidence || []).length,
        similarEvidenceCount: (trace.similarEvidence || []).length,
        rejectedEvidenceCount: (trace.rejectedEvidence || []).length,
        downgradedDirectCount: downgradedDirectEvidence.length,
        downgradeReasons: downgradedDirectEvidence.map((item) => item.reason),
        extractedVerdict: trace.extractedVerdict || "unknown",
        dependencies: subAnswer.dependencies || trace.dependencies || [],
        unresolvedDependencies: subAnswer.unresolvedDependencies || trace.unresolvedDependencies || [],
        missingConditions: subAnswer.missingConditions || trace.branchSelector?.missingConditions || [],
        reason: subAnswer.reason || trace.reason || "",
        whyUnknown: trace.whyUnknown || subAnswer.whyUnknown || null,
        hasConditionalAnswer: Boolean(subAnswer.conditionalAnswer),
        clarificationQuestion: subAnswer.conditionalAnswer?.clarificationQuestion || null,
      };
    });

    for (const application of answer?.parserDebug?.transitionRules?.ruleApplications || []) {
      if (["heuristic", "official_database_card_page", "official_response_screenshot", "official_response_unverified", "pending_adjustment"].includes(application.ruleSource?.sourceType) && application.outputStatus === "confirmed") {
        unsafeConfirmed.add(`${benchmarkCase.id}:${application.appliedToQuestionId}:unsafe_rule_source`);
      }
    }
    for (const state of answer?.parserDebug?.transitionRules?.derivedStates || []) {
      if (["heuristic", "official_database_card_page", "official_response_screenshot", "official_response_unverified", "pending_adjustment"].includes(state.ruleSource?.sourceType) && state.status === "confirmed") {
        unsafeConfirmed.add(`${benchmarkCase.id}:${state.questionId}:unsafe_derived_state`);
      }
    }
    return {
      caseId: benchmarkCase.id,
      inputPreview: preview(benchmarkCase.question),
      expectedSafety: benchmarkCase.expectedSafety,
      expectedPrimaryReason: benchmarkCase.expectedPrimaryReason || null,
      expectedCards: benchmarkCase.expectedCards || [],
      expectedQuestionTypes: benchmarkCase.expectedQuestionTypes || [],
      subQuestions,
    };
  });

  const topUnknownReasons = Object.entries(unknownReasons)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count, suggestion: suggestionFor(reason) }));

  return {
    totalCases: results.length,
    totalSubQuestions,
    confirmedCount,
    inferredCount,
    unknownCount,
    unsafeConfirmedCount: unsafeConfirmed.size,
    missingReasonCount,
    conditionalAnswerCount,
    clarificationQuestionCount,
    directEvidenceCount,
    downgradedDirectCount,
    downgradeReasons,
    noDirectReasons,
    unknownReasons,
    perCase,
    verdictExtractionDiagnostics,
    noDirectEvidenceDiagnostics,
    topUnknownReasons,
    recommendations: topUnknownReasons.map((item) => `${item.reason}: ${item.suggestion}`),
  };
}

function normalizeDowngradeReason(reason) {
  const value = String(reason || "");
  if (DIRECT_DOWNGRADE_REASON_KEYS.includes(value)) return value;
  if (value === "asked_result_not_covered") return "evidence_mentions_action_but_not_asked_result";
  return null;
}

export async function runBenchmarkReport() {
  const caseResults = [];
  const snapshot = await loadSnapshot();
  for (const benchmarkCase of BENCHMARK_CASES) {
    const answer = await answerQuestion(
      { question: benchmarkCase.question },
      { useModel: false, onDemandSync: false }
    );
    caseResults.push({ benchmarkCase, answer, snapshot });
  }
  return buildBenchmarkReport(caseResults);
}

export function classifyPrimaryNoDirectReason({ trace = {}, dataCoverage = {}, topN = 50 } = {}) {
  if (trace.evidenceCoverageReason === "alias_without_card_id"
    || trace.evidenceCoverageReason === "card_resolution_failed"
    || ((trace.resolvedCardIds || []).length === 0 && trace.card !== "referenced_toon_monster")) {
    return "alias_or_card_resolution_issue";
  }

  const rawCandidates = trace.rawCandidateEvidence || [];
  const rawDirectCandidates = rawCandidates.filter((item) => item.classification === "direct");
  if (rawDirectCandidates.length > 1 && (trace.directEvidence || []).length === 0) {
    return "all_candidates_conflicting";
  }
  const belowTopN = rawCandidates.some((item) => Number(item.rank || 0) > topN
    && (item.classification === "direct" || item.askedResultCoverage === "explicit"));
  if (belowTopN) return "ranking_issue";

  if (rawCandidates.length === 0) {
    return dataCoverage.hasAnyQaForCard ? "query_missed" : "data_missing_for_card";
  }

  const downgraded = trace.downgradedDirectEvidence || [];
  if (downgraded.length && downgraded.every((item) => item.reason === "conflicting_direct_evidence")) {
    return "all_candidates_conflicting";
  }
  const classifiedCandidates = rawCandidates.filter((item) => item.classification === "similar" || item.classification === "rejected");
  if (classifiedCandidates.length && classifiedCandidates.every((item) => item.askedResultCoverage === "different_question")) {
    return "all_candidates_different_question";
  }
  const sameCardCandidates = rawCandidates.filter((item) => (item.matchedBy || [])
    .some((value) => value === "resolved_card_id" || value === "card_name"));
  if (!sameCardCandidates.length && dataCoverage.hasAnyQaForCard) return "ranking_issue";
  if (sameCardCandidates.length && sameCardCandidates.every((item) => item.askedResultCoverage === "different_question")) {
    return "all_candidates_different_question";
  }
  if (buildNoDirectDiagnosticFlags(trace).includes("same_card_candidate_rejected_by_question_type")) {
    return "all_candidates_different_question";
  }
  return "unknown";
}

function buildNoDirectDiagnosticFlags(trace) {
  const candidates = trace.rawCandidateEvidence || [];
  const sameCardTypeMismatches = candidates.filter((item) => ["question_type_mismatch", "card_and_question_type_mismatch"].includes(item.rejectedReason)
    && (item.matchedBy || []).some((value) => value === "resolved_card_id" || value === "card_name"));
  const flags = [];
  if (sameCardTypeMismatches.length) flags.push("same_card_candidate_rejected_by_question_type");
  if (sameCardTypeMismatches.some((item) => /[\u3040-\u30ff]|\b(?:can|cannot|graveyard|banish|activate)\b/iu.test(`${item.title || ""} ${item.textPreview || ""}`))) {
    flags.push("multilingual_candidate_type_detection_issue");
  }
  if (candidates.some((item) => Number(item.rank || 0) <= 20
    && (item.matchedBy || []).includes("resolved_card_id"))) {
    flags.push("same_card_candidate_present_in_top20");
  }
  return flags;
}

function buildDataCoverageAudit({ snapshot, trace, card, onDemandSync }) {
  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  const resolvedCardIds = trace.resolvedCardIds || [];
  const scenarioCardIds = trace.scenarioCardIds || [];
  const cardRecords = records.filter((record) => isAuditRuling(record)
    && auditRecordMatchesCard(record, resolvedCardIds, card));
  const relatedRecords = records.filter((record) => isAuditRuling(record)
    && auditRecordMatchesCard(record, scenarioCardIds, ""));
  const byCardId = resolvedCardIds.map((cardId) => {
    const matches = records.filter((record) => isAuditRuling(record)
      && auditRecordMatchesCard(record, [cardId], card));
    return {
      cardId,
      cardFaqCount: matches.filter((record) => record.recordType === "card-faq").length,
      cardQaCount: matches.filter((record) => record.recordType === "qa").length,
    };
  });
  const beforeIds = new Set((snapshot?.qaIndex || []).map((item) => String(item?.id || "")).filter(Boolean));
  const syncedEvidenceIds = onDemandSync?.syncedEvidenceIds || [];
  const qaIndexIncrease = syncedEvidenceIds.filter((id) => !beforeIds.has(String(id))).length;
  const cardFaqCount = cardRecords.filter((record) => record.recordType === "card-faq").length;
  const cardQaCount = cardRecords.filter((record) => record.recordType === "qa").length;
  return {
    cardFaqCount,
    cardQaCount,
    relatedQaCount: relatedRecords.length,
    hasAnyQaForCard: cardFaqCount + cardQaCount > 0,
    byCardId,
    onDemandSyncAttempted: Boolean(onDemandSync?.attempted),
    liveSourceStatus: onDemandSync?.status || "not_attempted",
    liveSourceAvailable: onDemandSync?.status === "live_source_unavailable" ? false : null,
    qaIndexCountBefore: beforeIds.size,
    qaIndexCountAfter: beforeIds.size + qaIndexIncrease,
    qaIndexIncrease,
  };
}

function isAuditRuling(record) {
  return record?.recordType === "qa" || record?.recordType === "card-faq";
}

function auditRecordMatchesCard(record, cardIds, cardName) {
  const wantedIds = new Set((cardIds || []).map(normalizeAuditCardId).filter(Boolean));
  const recordIds = [
    ...(Array.isArray(record?.cardIds) ? record.cardIds : []),
    record?.cardId,
  ].map(normalizeAuditCardId).filter(Boolean);
  if (recordIds.some((id) => wantedIds.has(id))) return true;
  const wantedName = normalizeAuditKey(cardName);
  if (!wantedName) return false;
  return (Array.isArray(record?.cards) ? record.cards : [record?.cards])
    .filter(Boolean)
    .some((name) => {
      const key = normalizeAuditKey(name);
      return key === wantedName || key.includes(wantedName) || wantedName.includes(key);
    });
}

function normalizeAuditCardId(value) {
  const text = String(value || "").trim();
  return /^\d+$/u.test(text) ? String(Number(text)) : text.toLowerCase();
}

function normalizeAuditKey(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function suggestionFor(reason) {
  const suggestions = {
    retrieval_empty: "扩大数据覆盖、改进 search query，或检查 on-demand sync。",
    matcher_rejected_all: "检查 rejectedReason，并核对问题类型与分类器约束。",
    verdict_extraction_unknown: "增强 verdict extractor 对证据正文结论的抽取。",
    condition_branch_missing_state: "根据 missingConditions 生成 clarification question。",
    condition_branch_ambiguous: "请求用户补充能排除分支的游戏状态。",
    unresolved_dependency: "先回答依赖问题，或提示用户补充依赖问题所需信息。",
    card_resolution_failed: "补充卡名别名、译名和 card ID 索引。",
    parser_warning: "检查形式化解析警告并补强对应解析样例。",
    data_source_missing: "初始化或同步卡片与 Q&A 数据源。",
    no_direct_evidence: "补充当前问题类型的直接 Q&A，避免仅依赖相似裁定。",
    heuristic_limit: "为状态转移补充 official Q&A、card FAQ、official database 或可追溯 official response 来源。",
    unknown_other: "检查该 case 的完整 trace，补充更具体的诊断标签。",
  };
  return suggestions[reason] || suggestions.unknown_other;
}

function preview(value) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function evidenceFullText(evidence) {
  return [
    evidence?.title,
    evidence?.question,
    evidence?.questionText,
    evidence?.conclusion,
    evidence?.answer,
    evidence?.answerText,
    evidence?.text,
    ...(Array.isArray(evidence?.steps) ? evidence.steps : []),
  ].filter(Boolean).join("\n\n").trim();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const report = await runBenchmarkReport();
  console.log(JSON.stringify(report, null, 2));
  if (report.unsafeConfirmedCount > 0 || report.missingReasonCount > 0) process.exitCode = 1;
}
