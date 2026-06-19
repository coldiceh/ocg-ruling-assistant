import { deriveStateAtTiming } from "./eventTimeline.mjs";

export const TRANSITION_RULE_SOURCES = Object.freeze({
  timeline_projection: ruleSource("timeline_projection", "将已识别事件投影为问题时点状态", "heuristic", [], "unknown"),
  pending_not_completed: ruleSource("pending_not_completed", "待送墓不等同于已经送去墓地", "heuristic", [], "unknown"),
  unresolved_question_dependency: ruleSource("unresolved_question_dependency", "依赖问题未确认时停止后续状态推理", "heuristic", [], "unknown"),
  no_banish_preserves_pending: ruleSource("no_banish_preserves_pending", "无法暂时除外时保留原有待送墓过渡", "heuristic", [], "inferred"),
});

export function applyTransitionRules({
  formalQuery,
  gameState,
  eventTimeline,
  dependencyGraph,
  subQuestionAnswers,
  transitionRuleSources = [],
} = {}) {
  const questions = Array.isArray(formalQuery?.subQuestions) ? formalQuery.subQuestions : [];
  const answers = new Map((subQuestionAnswers || []).map((item) => [String(item.questionId || item.id), item]));
  const graph = dependencyGraph || { edges: [], warnings: [] };
  const ruleApplications = [];
  const unresolvedDependencies = [];
  const derivedStates = questions.map((question) => {
    const state = deriveStateAtTiming(gameState || {}, eventTimeline || {}, {
      card: question.card,
      sourceText: question.sourceText,
    });
    const source = state.zoneStatus === "pending_send_to_graveyard"
      ? TRANSITION_RULE_SOURCES.pending_not_completed
      : TRANSITION_RULE_SOURCES.timeline_projection;
    const relevantEvents = (eventTimeline?.events || [])
      .filter((event) => cardsMatch(event.card, question.card))
      .map((event) => event.id);
    const derived = {
      questionId: question.id,
      card: question.card,
      zoneStatus: state.zoneStatus,
      transitionStatus: state.transitionStatus,
      derivedFrom: relevantEvents,
      ruleId: source.ruleId,
      ruleSource: source,
      status: "unknown",
      reason: state.reason,
      evidenceIds: [],
      warnings: [],
    };
    if (state.zoneStatus === "pending_send_to_graveyard") {
      const application = buildApplication({
        source,
        questionId: question.id,
        inputState: state,
        outputState: { zoneStatus: "pending_send_to_graveyard", transitionStatus: "pending" },
        requestedStatus: "unknown",
        reason: question.type === "location_change"
          ? "仅确认存在待送墓过渡，不能据此认定该卡已经送墓"
          : "战斗破坏后的送墓仍处于待定过渡，尚未完成",
      });
      ruleApplications.push(application);
      derived.reason = application.reason;
    }
    return derived;
  });
  const stateByQuestion = new Map(derivedStates.map((item) => [item.questionId, item]));

  for (const edge of graph.edges || []) {
    if (edge.relation !== "depends_on_verdict") continue;
    const dependencyAnswer = answers.get(String(edge.fromQuestionId));
    const dependentAnswer = answers.get(String(edge.toQuestionId));
    const dependentState = stateByQuestion.get(String(edge.toQuestionId));
    if (!dependencyAnswer || !dependentState) continue;

    if (!isResolvedAnswer(dependencyAnswer)) {
      const unresolved = {
        questionId: edge.toQuestionId,
        dependsOnQuestionId: edge.fromQuestionId,
        relation: edge.relation,
        reason: `该问题依赖 ${edge.fromQuestionId} 的结果，而 ${edge.fromQuestionId} 当前无法确认`,
      };
      unresolvedDependencies.push(unresolved);
      dependentState.derivedFrom.push(edge.fromQuestionId);
      dependentState.ruleId = TRANSITION_RULE_SOURCES.unresolved_question_dependency.ruleId;
      dependentState.ruleSource = TRANSITION_RULE_SOURCES.unresolved_question_dependency;
      dependentState.status = "unknown";
      dependentState.reason = unresolved.reason;
      dependentState.warnings.push(`unresolved_dependency:${edge.fromQuestionId}`);
      ruleApplications.push(buildApplication({
        source: TRANSITION_RULE_SOURCES.unresolved_question_dependency,
        questionId: edge.toQuestionId,
        inputState: { dependencyStatus: dependencyAnswer.status, dependencyVerdict: dependencyAnswer.verdict },
        outputState: { zoneStatus: dependentState.zoneStatus, transitionStatus: dependentState.transitionStatus },
        requestedStatus: "unknown",
        reason: unresolved.reason,
      }));
      continue;
    }

    if (isPositiveBanishAnswer(dependencyAnswer)) {
      const temporaryReturnEstablished = hasTemporaryReturnFact(dependencyAnswer);
      const source = sourceFromAnswer(dependencyAnswer, "temporary_banish_until_after_resolution");
      if (temporaryReturnEstablished && source.sourceIds.length) {
        ruleApplications.push(buildApplication({
          source,
          questionId: edge.toQuestionId,
          inputState: { zoneStatus: dependentState.zoneStatus, transitionStatus: dependentState.transitionStatus },
          outputState: {
            hypotheticalTransitions: [
              "pending_send_to_graveyard",
              "temporarily_banished",
              "returned_to_previous_zone",
            ],
            finalSendToGraveyardOutcome: "unknown",
          },
          requestedStatus: "confirmed",
          reason: "可建立暂时除外并在处理后返回的假设路径，但没有规则来源说明其后待送墓过渡如何处理",
        }));
        dependentState.derivedFrom.push(edge.fromQuestionId, ...source.sourceIds);
        dependentState.ruleId = source.ruleId;
        dependentState.ruleSource = source;
        dependentState.status = "unknown";
        dependentState.reason = "暂时除外路径成立，但其是否中断或替代待送墓过渡仍无直接规则依据";
        dependentState.evidenceIds = [...source.sourceIds];
        dependentState.warnings.push("pending_send_after_temporary_banish_unresolved");
      } else {
        const unresolved = {
          questionId: edge.toQuestionId,
          dependsOnQuestionId: edge.fromQuestionId,
          relation: "depends_on_transition",
          reason: `${edge.fromQuestionId} 虽允许除外，但没有直接证据说明暂时除外如何影响待送墓过渡`,
        };
        unresolvedDependencies.push(unresolved);
        dependentState.status = "unknown";
        dependentState.reason = unresolved.reason;
        dependentState.warnings.push("temporary_banish_transition_rule_missing");
      }
      continue;
    }

    if (isNegativeBanishAnswer(dependencyAnswer)) {
      const source = TRANSITION_RULE_SOURCES.no_banish_preserves_pending;
      const application = buildApplication({
        source,
        questionId: edge.toQuestionId,
        inputState: { dependencyVerdict: dependencyAnswer.verdict },
        outputState: { zoneStatus: "pending_send_to_graveyard", transitionStatus: "pending" },
        requestedStatus: "inferred",
        reason: "暂时除外不成立，保留原始待送墓过渡；是否已经送墓仍取决于问题时点",
      });
      ruleApplications.push(application);
      dependentState.zoneStatus = "pending_send_to_graveyard";
      dependentState.transitionStatus = "pending";
      dependentState.derivedFrom.push(edge.fromQuestionId);
      dependentState.ruleId = source.ruleId;
      dependentState.ruleSource = source;
      dependentState.status = application.outputStatus;
      dependentState.reason = application.reason;
      dependentState.evidenceIds = [...new Set(dependencyAnswer.evidenceIds || [])];
    }

    if (!dependentAnswer) dependentState.warnings.push("dependent_answer_missing");
  }

  for (const suppliedSource of transitionRuleSources || []) {
    const source = normalizeRuleSource(suppliedSource);
    const questionId = String(suppliedSource.appliesToQuestionId || "");
    const target = stateByQuestion.get(questionId);
    if (!target || !suppliedSource.outputState) continue;
    const application = buildApplication({
      source,
      questionId,
      inputState: { zoneStatus: target.zoneStatus, transitionStatus: target.transitionStatus },
      outputState: suppliedSource.outputState,
      requestedStatus: suppliedSource.requestedStatus || source.maxStatus,
      reason: suppliedSource.reason || source.description,
    });
    ruleApplications.push(application);
    target.zoneStatus = suppliedSource.outputState.zoneStatus || target.zoneStatus;
    target.transitionStatus = suppliedSource.outputState.transitionStatus || target.transitionStatus;
    target.ruleId = source.ruleId;
    target.ruleSource = source;
    target.status = application.outputStatus;
    target.reason = application.reason;
    target.evidenceIds = [...source.sourceIds];
  }

  for (const state of derivedStates) {
    state.derivedFrom = [...new Set(state.derivedFrom)];
    state.evidenceIds = [...new Set(state.evidenceIds)];
    state.warnings = [...new Set(state.warnings)];
  }

  return { derivedStates, ruleApplications, unresolvedDependencies };
}

export function capTransitionRuleStatus(requestedStatus, source) {
  if (!source || typeof source !== "object") return "unknown";
  const normalized = normalizeRuleSource(source);
  const rank = { unknown: 0, inferred: 1, confirmed: 2 };
  let sourceCap = normalized.maxStatus;
  if (!normalized.sourceIds.length && sourceCap === "confirmed") sourceCap = "inferred";
  else if (normalized.sourceType === "heuristic") sourceCap = sourceCap === "unknown" ? "unknown" : "inferred";
  else if (normalized.sourceType === "manual_rule" && !normalized.verified) sourceCap = "inferred";
  const requested = rank[requestedStatus] === undefined ? "unknown" : requestedStatus;
  return rank[requested] <= rank[sourceCap] ? requested : sourceCap;
}

function buildApplication({ source, questionId, inputState, outputState, requestedStatus, reason }) {
  const normalizedSource = normalizeRuleSource(source);
  const outputStatus = capTransitionRuleStatus(requestedStatus, normalizedSource);
  return {
    ruleId: normalizedSource.ruleId,
    ruleName: normalizedSource.description,
    ruleSource: normalizedSource,
    appliedToQuestionId: questionId,
    inputState,
    outputState,
    status: outputStatus === "unknown" ? "unresolved" : "applied",
    outputStatus,
    reason,
    evidenceIds: [...normalizedSource.sourceIds],
  };
}

function sourceFromAnswer(answer, ruleId) {
  const sourceIds = [...new Set(answer?.evidenceIds || [])];
  const sourceType = sourceIds.some((id) => String(id).startsWith("card-faq-")) ? "card_faq" : "official_qa";
  return ruleSource(ruleId, "直接证据支持暂时除外直到效果处理后返回", sourceType, sourceIds, "confirmed");
}

function normalizeRuleSource(source) {
  if (!source || typeof source !== "object") return ruleSource("missing_rule_source", "规则来源缺失", "heuristic", [], "unknown");
  return {
    ruleId: String(source.ruleId || "unknown_rule"),
    description: String(source.description || source.ruleName || "未说明规则"),
    sourceType: ["official_qa", "card_faq", "manual_rule", "heuristic"].includes(source.sourceType) ? source.sourceType : "heuristic",
    sourceIds: [...new Set(Array.isArray(source.sourceIds) ? source.sourceIds.map(String).filter(Boolean) : [])],
    maxStatus: ["confirmed", "inferred", "unknown"].includes(source.maxStatus) ? source.maxStatus : "unknown",
    verified: source.verified === true,
  };
}

function ruleSource(ruleId, description, sourceType, sourceIds, maxStatus, verified = false) {
  return { ruleId, description, sourceType, sourceIds, maxStatus, verified };
}

function isResolvedAnswer(answer) {
  return answer?.status === "confirmed" && answer?.verdict && answer.verdict !== "unknown";
}

function isPositiveBanishAnswer(answer) {
  return ["can", "yes", "banished_temporarily", "returns_to_original_zone"].includes(answer?.verdict);
}

function isNegativeBanishAnswer(answer) {
  return ["cannot", "no"].includes(answer?.verdict);
}

function hasTemporaryReturnFact(answer) {
  return ["banished_temporarily", "returns_to_original_zone"].includes(answer?.verdict)
    || (answer?.transitionFacts || []).includes("temporary_banish_until_after_resolution");
}

function cardsMatch(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
