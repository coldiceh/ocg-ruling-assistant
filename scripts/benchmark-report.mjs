import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { answerQuestion } from "../backend/engine.mjs";

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
  if (["heuristic", "manual_rule"].includes(ruleSourceType)) return "heuristic_limit";
  return "unknown_other";
}

export function buildBenchmarkReport(caseResults) {
  const results = Array.isArray(caseResults) ? caseResults : [];
  const unknownReasons = Object.fromEntries(UNKNOWN_REASON_KEYS.map((key) => [key, 0]));
  const downgradeReasons = Object.fromEntries(DIRECT_DOWNGRADE_REASON_KEYS.map((key) => [key, 0]));
  const unsafeConfirmed = new Set();
  let totalSubQuestions = 0;
  let missingReasonCount = 0;
  let confirmedCount = 0;
  let inferredCount = 0;
  let unknownCount = 0;
  let directEvidenceCount = 0;
  let downgradedDirectCount = 0;
  const verdictExtractionDiagnostics = [];

  const perCase = results.map(({ benchmarkCase, answer }) => {
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
      };
    });

    for (const application of answer?.parserDebug?.transitionRules?.ruleApplications || []) {
      if (["heuristic", "manual_rule"].includes(application.ruleSource?.sourceType) && application.outputStatus === "confirmed") {
        unsafeConfirmed.add(`${benchmarkCase.id}:${application.appliedToQuestionId}:unsafe_rule_source`);
      }
    }
    for (const state of answer?.parserDebug?.transitionRules?.derivedStates || []) {
      if (["heuristic", "manual_rule"].includes(state.ruleSource?.sourceType) && state.status === "confirmed") {
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
    directEvidenceCount,
    downgradedDirectCount,
    downgradeReasons,
    unknownReasons,
    perCase,
    verdictExtractionDiagnostics,
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
  for (const benchmarkCase of BENCHMARK_CASES) {
    const answer = await answerQuestion(
      { question: benchmarkCase.question },
      { useModel: false, onDemandSync: false }
    );
    caseResults.push({ benchmarkCase, answer });
  }
  return buildBenchmarkReport(caseResults);
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
    heuristic_limit: "为状态转移补充 official Q&A、card FAQ 或已验证 manual rule 来源。",
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
