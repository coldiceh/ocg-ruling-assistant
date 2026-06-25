import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDataHealth } from "./dataHealth.mjs";
import { buildConditionalAnswer } from "./conditionalAnswer.mjs";
import { buildCardAliasIndex, buildQaIndex } from "./dataIndex.mjs";
import { classifyEvidenceQuestionTypes } from "./evidenceQuestionTypeClassifier.mjs";
import { selectBranchForSubQuestion } from "./branchSelector.mjs";
import { extractConditionBranchesFromEvidence } from "./conditionBranches.mjs";
import { buildEventTimelineFromFormalQuery, deriveStateAtTiming } from "./eventTimeline.mjs";
import { buildGameStateFromFormalQuery } from "./gameState.mjs";
import { normalizeFormalRulingQuery, validateFormalRulingQuery } from "./formalQuery.mjs";
import { parseFormalRulingQueryDetailed, resolveCardNamesWithModel } from "./openai.mjs";
import { buildSubQuestionDependencyGraph } from "./subQuestionDependencies.mjs";
import { applyTransitionRules } from "./transitionRules.mjs";
import { detectActionVerdict } from "./verdictExtractor.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = join(projectRoot, "data");
const snapshotCache = new Map();
const liveIndexCache = new Map();
const liveCardCache = new Map();
const liveCardPayloadCache = new Map();
const baigeSearchCache = new Map();
const onDemandSyncCache = new Map();
const onDemandSyncLocks = new Map();
const ygoResourcesBaseUrl = "https://db.ygoresources.com";
const baigeApiBaseUrl = "https://ygocdb.com/api/v0/";

const topics = [
  { id: "activation", label: "能否发动", keywords: ["能否发动", "可以发动", "发动②", "发动2", "发动效果", "诱发", "発動", "発動できる"] },
  { id: "chain", label: "连锁处理", keywords: ["C1", "C2", "连锁", "处理完", "这时"] },
  { id: "control", label: "控制权变更", keywords: ["获得控制权", "控制权", "夺取", "转移控制权"] },
  { id: "battle", label: "战斗伤害", keywords: ["攻击", "守备表示", "战斗伤害", "伤害计算", "攻击力", "守备力", "戦闘", "ダメージ計算"] },
  { id: "replacement", label: "代替破坏", keywords: ["代破", "代替破坏", "破坏代替", "除外", "破壊"] },
  { id: "spelltrap", label: "魔法陷阱状态", keywords: ["表侧发动中", "魔法陷阱", "永续", "场地", "装备"] },
  { id: "summon", label: "召唤处理", keywords: ["召唤", "特殊召唤", "融合召唤", "连接召唤", "同调召唤", "超量召唤"] },
  { id: "graveyard", label: "墓地", keywords: ["墓地", "送去墓地", "从墓地"] },
];

const localCardAliasHints = [
  {
    aliases: ["阿尔戈群星荣冠的阿德拉", "荣冠的阿德拉", "阿德拉", "阿尔戈父"],
    candidates: ["ARG☆S－栄冠のアドラ", "ARG☆S - Adra of the Laurel", "ARG☆S Adra", "アドラ", "Adra"],
  },
  {
    aliases: ["苦纹样的土像", "苦纹样土像", "苦紋樣的土像", "苦紋樣土像", "土像"],
    candidates: ["苦紋様の土像", "Statue of Anguish Pattern"],
  },
  {
    aliases: ["小夜", "sp小夜", "s:p小夜"],
    candidates: ["S:P Little Knight", "S：Pリトルナイト"],
  },
  {
    aliases: ["ip", "ip加速"],
    candidates: ["I:P Masquerena", "I：Pマスカレーナ"],
  },
  {
    aliases: ["时空转生", "時空転生", "快子时空转生", "快子時空転生"],
    candidates: ["快子时空转生", "タキオン・トランスミグレイション", "Tachyon Transmigration"],
  },
  {
    aliases: ["完美世界 卡通世界", "完美世界卡通世界", "完全なる世界 トゥーン・ワールド", "完全なる世界トゥーンワールド"],
    candidates: ["完美世界-卡通世界", "完全なる世界 トゥーン・ワールド", "Perfect Toon World"],
    card: {
      name: "完美世界-卡通世界",
      cnName: "完美世界-卡通世界",
      jaName: "完全なる世界 トゥーン・ワールド",
      enName: "Perfect Toon World",
      aliases: ["完美世界 卡通世界", "完美世界卡通世界", "完全なる世界 トゥーン・ワールド", "Perfect Toon World"],
      cardType: "场地魔法",
      effectText:
        "这个卡名的②效果1回合可以使用最多3次。①：这张卡只要在场地区域存在，卡名当作「卡通世界」使用。②：1回合1次，自己主要阶段才能发动。把1张「卡通」卡或者有那个卡名记述的卡从卡组加入手卡。③：其他卡发动的效果适用之际，可以把自己场上1只卡通怪兽直到那个效果处理后除外（这个回合，这个卡名的这个效果不能把原本卡名相同的怪兽除外）。",
    },
  },
  {
    aliases: ["青眼暴君龙", "青眼暴君龍", "青眼暴君", "暴君龙", "暴君龍", "blue-eyes tyrant dragon"],
    candidates: ["青眼のタイラント・ドラゴン", "Blue-Eyes Tyrant Dragon", "青眼暴君龙"],
    card: {
      name: "青眼暴君龙",
      cnName: "青眼暴君龙",
      jaName: "青眼のタイラント・ドラゴン",
      enName: "Blue-Eyes Tyrant Dragon",
      aliases: ["青眼暴君龙", "青眼暴君龍", "青眼のタイラント・ドラゴン", "Blue-Eyes Tyrant Dragon", "暴君龙"],
      cardType: "融合怪兽",
      effectText:
        "这张卡不受陷阱卡的效果影响。这张卡可以向对方怪兽全部各作1次攻击。1回合1次，这张卡进行战斗的伤害步骤结束时，以自己墓地1张陷阱卡为对象才能发动。那张卡在自己的魔法与陷阱区域盖放。这个效果盖放的卡在盖放的回合也能发动。",
    },
  },
];

export async function answerQuestion(payload, options = {}) {
  const question = String(payload?.question || "").trim();
  if (!question) {
    return buildUnknownAnswer("没有输入问题", "请输入场面、连锁、卡名和想确认的点。", [], [], null);
  }

  const snapshot = await loadSnapshot(options.dataDir || defaultDataDir);
  if (!snapshot.dataHealth?.usable) {
    return {
      status: "data_source_missing",
      message: "数据源未初始化，请先运行 node scripts/sync-data.mjs",
      stats: snapshot.dataHealth,
    };
  }
  const env = options.env || globalThis.process?.env || {};
  const resolutionWarnings = [];
  const resolutionNotes = [];
  let detectedCards = mergeCards(
    detectCards(question, snapshot.cards),
    extractUserProvidedCards(question),
    buildPlaceholderCards(collectLocalAliasResolutions(question))
  );

  if (!detectedCards.length) {
    const extractedResolution = collectQuestionCardCandidates(question);
    try {
      const baigeCards = await resolveCardsFromBaige(extractedResolution, env);
      if (baigeCards.length) {
        resolutionNotes.push("部分卡片由百鸽卡查确认，静态快照尚未覆盖。");
        detectedCards = mergeCards(detectedCards, baigeCards);
      }
    } catch (error) {
      resolutionWarnings.push(`百鸽卡查解析失败，已继续使用本地资料：${formatError(error)}`);
    }

    const localResolution = collectLocalAliasResolutions(question);
    const localResolvedCards = matchModelResolvedCards(localResolution, snapshot.cards);
    if (localResolvedCards.length) {
      detectedCards = mergeCards(detectedCards, localResolvedCards);
    } else {
      detectedCards = mergeCards(detectedCards, buildPlaceholderCards(localResolution));
    }

    const combinedLocalResolution = mergeResolutions(extractedResolution, localResolution);
    try {
      const [liveLocalCards, baigeLocalCards] = await Promise.all([
        resolveCardsFromLiveSources(combinedLocalResolution, snapshot.cards, env),
        resolveCardsFromBaige(combinedLocalResolution, env),
      ]);
      if (liveLocalCards.length || baigeLocalCards.length) {
        resolutionNotes.push("部分卡片来自实时资料索引，静态快照尚未覆盖。");
        detectedCards = mergeCards(detectedCards, liveLocalCards, baigeLocalCards);
      }
    } catch (error) {
      resolutionWarnings.push(`实时资料索引查询失败，已使用本地快照：${formatError(error)}`);
    }

    if (
      !detectedCards.length &&
      options.useModel !== false &&
      !hasHighConfidenceLocalResolution(localResolution) &&
      shouldResolveCardNamesWithModel(env)
    ) {
      try {
        const resolved = await resolveCardNamesWithModel(question, env);
        const combinedResolution = mergeResolutions(extractedResolution, localResolution, resolved);
        const resolvedCards = matchModelResolvedCards(combinedResolution, snapshot.cards);
        const [liveCards, baigeCards] = await Promise.all([
          resolveCardsFromLiveSources(combinedResolution, snapshot.cards, env),
          resolveCardsFromBaige(combinedResolution, env),
        ]);
        if (liveCards.length || baigeCards.length) resolutionNotes.push("部分卡片来自实时资料索引，静态快照尚未覆盖。");
        if (resolvedCards.length) {
          detectedCards = mergeCards(detectedCards, resolvedCards, liveCards, baigeCards);
        } else if (liveCards.length || baigeCards.length) {
          detectedCards = mergeCards(detectedCards, liveCards, baigeCards);
        }
      } catch (error) {
        resolutionWarnings.push(`卡名解析失败，已使用本地匹配结果：${formatError(error)}`);
      }
    }
  }

  const onDemandSync = options.onDemandSync === false
    ? buildSkippedOnDemandSync()
    : await syncOnDemandData({
        detectedCards,
        snapshot,
        dataDir: options.dataDir || defaultDataDir,
        env,
      });
  detectedCards = mergeCards(detectedCards, onDemandSync.cards);
  const liveEvidence = onDemandSync.evidence;
  if (onDemandSync.persisted) resolutionNotes.push("缺失卡片与相关 Q&A/FAQ 已按需同步到本地数据目录。");
  resolutionWarnings.push(...onDemandSync.warnings);

  let parserResult;
  try {
    parserResult = await parseFormalRulingQueryDetailed(question, detectedCards, options.useModel === false ? {} : env);
  } catch (error) {
    resolutionWarnings.push(`形式化解析模型失败，已使用本地解析：${formatError(error)}`);
    parserResult = await parseFormalRulingQueryDetailed(question, detectedCards, {});
  }

  const formalQuery = normalizeFormalRulingQuery(parserResult.query);
  const validation = validateFormalRulingQuery(formalQuery);
  const gameState = buildGameStateFromFormalQuery({ ...formalQuery, resolvedCards: detectedCards });
  const eventTimeline = buildEventTimelineFromFormalQuery({ ...formalQuery, resolvedCards: detectedCards }, gameState);
  const evidenceSnapshot = { ...snapshot, records: normalizeRecords([...snapshot.records, ...liveEvidence]) };
  const evidence = parserResult.parseFailed
    ? buildEmptyFormalEvidence(formalQuery)
    : retrieveEvidenceByFormalQuery(formalQuery, detectedCards, evidenceSnapshot);
  const baseSubAnswers = answerEachSubQuestion(formalQuery, evidence, evidenceSnapshot, validation, {
    parseFailure: parserResult.parseFailed,
    parserWarnings: parserResult.parserWarnings,
    gameState,
    eventTimeline,
  });
  const dependencyGraph = buildSubQuestionDependencyGraph(formalQuery, eventTimeline);
  const transitionRules = applyTransitionRules({
    formalQuery,
    gameState,
    eventTimeline,
    dependencyGraph,
    subQuestionAnswers: baseSubAnswers,
  });
  const subAnswers = attachTransitionReasoning(baseSubAnswers, dependencyGraph, transitionRules);
  const parserDebug = {
    rawQuestion: question,
    contextLines: parserResult.preprocessing.contextLines,
    questionLines: parserResult.preprocessing.questionLines,
    rawFormalQuery: parserResult.rawFormalQuery,
    normalizedFormalQuery: formalQuery,
    parserWarnings: parserResult.parserWarnings,
    onDemandSync: summarizeOnDemandSync(onDemandSync),
    gameState,
    eventTimeline,
    timelineWarnings: eventTimeline.warnings,
    dependencyGraph,
    transitionRules,
    evidenceTrace: buildSubQuestionEvidenceTrace(formalQuery, evidence, subAnswers, onDemandSync, { gameState, eventTimeline }),
    finalStatusBeforeExplanation: buildFinalStatusTrace(subAnswers),
  };
  return mergeFormalAnswers({
    formalQuery,
    validation,
    detectedCards,
    evidence,
    subAnswers,
    snapshotMeta: snapshot.meta,
    warnings: resolutionWarnings,
    notes: resolutionNotes,
    parserWarnings: parserResult.parserWarnings,
    parserFailure: parserResult.parseFailed,
    parserDebug,
  });
}

function buildSubQuestionEvidenceTrace(formalQuery, evidence, subAnswers = [], onDemandSync = null, debugContext = {}) {
  return formalQuery.subQuestions.map((subQuestion) => {
    const bucket = evidence.bySubQuestion.find((item) => item.subQuestionId === subQuestion.id) || {
      rulingEvidence: [],
      similarRulingEvidence: [],
      rejectedEvidence: [],
    };
    const baseTrace = bucket.retrievalTrace || {
      questionId: subQuestion.id,
      sourceText: subQuestion.sourceText,
      type: subQuestion.type,
      card: subQuestion.card,
      resolvedCardIds: [],
      scenarioCardIds: [],
      searchQueries: [],
      rawCandidateEvidence: [],
      classifiedEvidence: {
        direct: bucket.rulingEvidence.map((item) => item.evidenceId || item.id).filter(Boolean),
        similar: bucket.similarRulingEvidence.map((item) => item.evidenceId || item.id).filter(Boolean),
        rejected: bucket.rejectedEvidence.map((item) => ({
          id: item.evidenceId || item.id || "unknown",
          rejectedReason: item.rejectedReason || "unknown",
        })),
      },
      evidenceCoverageReason: "retrieval_empty",
    };
    const rawById = new Map((baseTrace.rawCandidateEvidence || []).map((item) => [String(item.id), item]));
    const directEvidence = (bucket.rulingEvidence || []).map((item) => traceEvidenceDescriptor(item, rawById));
    const similarEvidence = (bucket.similarRulingEvidence || []).map((item) => traceEvidenceDescriptor(item, rawById));
    const rejectedEvidence = (bucket.rejectedEvidence || []).map((item) => ({
      ...traceEvidenceDescriptor(item, rawById),
      rejectedReason: item.rejectedReason || "unknown",
    }));
    const answer = subAnswers.find((item) => (item.questionId || item.id) === subQuestion.id) || {};
    const extracted = extractVerdictFromEvidence(subQuestion, bucket.rulingEvidence || [], {
      formalQuery,
      gameState: debugContext.gameState,
      eventTimeline: debugContext.eventTimeline,
    });
    let evidenceCoverageReason = baseTrace.evidenceCoverageReason;
    const syncWarnings = [];
    if (onDemandSync?.attempted && !(baseTrace.rawCandidateEvidence || []).length) {
      if (onDemandSync.status === "live_source_unavailable") {
        evidenceCoverageReason = "live_source_unavailable";
        syncWarnings.push("live_source_unavailable");
      } else if (onDemandSync.status === "retrieval_empty" && (baseTrace.resolvedCardIds || []).length) {
        evidenceCoverageReason = "retrieval_empty";
      }
    }
    return {
      ...baseTrace,
      directEvidence,
      similarEvidence,
      rejectedEvidence,
      conditionBranches: answer.conditionBranches || extracted.conditionBranches || [],
      branchSelector: answer.branchSelection || extracted.branchSelection || null,
      deriveStateAtTiming: answer.derivedStateAtTiming || extracted.derivedStateAtTiming || null,
      extractorInput: answer.extractorInput || extracted.extractorInput || [],
      extractorOutput: answer.extractorOutput || extracted.extractorOutput || [],
      extractorWarnings: answer.extractorWarnings || extracted.extractorWarnings || [],
      whyUnknown: answer.whyUnknown || extracted.whyUnknown || null,
      conditionalAnswer: answer.conditionalAnswer || null,
      dependencies: answer.dependencies || [],
      unresolvedDependencies: answer.unresolvedDependencies || [],
      transitionReasoning: answer.transitionReasoning || [],
      derivedState: answer.derivedState || null,
      extractedVerdict: answer.extractedVerdict || extracted.verdict,
      finalStatus: answer.status || "unknown",
      finalVerdict: answer.verdict || "unknown",
      reason: answer.reason || extracted.reason,
      warnings: [...new Set([...(answer.warnings || []), ...syncWarnings])],
      evidenceCoverageReason,
    };
  });
}

function traceEvidenceDescriptor(item, rawById) {
  const id = String(item?.evidenceId || item?.id || "unknown");
  const raw = rawById.get(id) || {};
  return {
    id,
    source: raw.source || item?.sources?.[0]?.label || item?.recordType || "unknown",
    title: raw.title || item?.title || "",
    textPreview: raw.textPreview || cleanText(`${item?.question || ""} ${item?.conclusion || ""}`).slice(0, 240),
    matchedBy: raw.matchedBy || [],
    score: Number(raw.score || item?.formalScore || 0),
    answeredAskedResult: item?.answeredAskedResult ?? false,
    askedResultCoverage: item?.askedResultCoverage || "unknown",
    classificationReason: item?.classificationReason || "unknown",
  };
}

function buildFinalStatusTrace(subAnswers) {
  const subQuestions = subAnswers.map((answer) => ({
    questionId: answer.questionId || answer.id,
    status: answer.status,
    verdict: answer.verdict,
    evidenceIds: answer.evidenceIds,
    reason: answer.reason,
    warnings: answer.warnings,
  }));
  const statuses = subQuestions.map((item) => item.status);
  let overallStatus = "unknown";
  if (statuses.length && statuses.every((status) => status === "parse_failed")) overallStatus = "parse_failed";
  else if (statuses.length && statuses.every((status) => status === "confirmed")) overallStatus = "confirmed";
  else if (statuses.length && statuses.every((status) => status === "confirmed" || status === "inferred")) overallStatus = "inferred";
  return { overallStatus, subQuestions };
}

function attachTransitionReasoning(subAnswers, dependencyGraph, transitionResult) {
  const unresolvedByQuestion = new Map();
  for (const item of transitionResult.unresolvedDependencies || []) {
    const list = unresolvedByQuestion.get(String(item.questionId)) || [];
    list.push(item);
    unresolvedByQuestion.set(String(item.questionId), list);
  }
  const derivedByQuestion = new Map((transitionResult.derivedStates || []).map((item) => [String(item.questionId), item]));
  return subAnswers.map((answer) => {
    const questionId = String(answer.questionId || answer.id);
    const dependencies = (dependencyGraph.edges || []).filter((edge) => String(edge.toQuestionId) === questionId);
    const unresolved = unresolvedByQuestion.get(questionId) || [];
    const transitionReasoning = (transitionResult.ruleApplications || []).filter((item) => String(item.appliedToQuestionId) === questionId);
    const derivedState = derivedByQuestion.get(questionId) || null;
    let result = {
      ...answer,
      dependencies,
      unresolvedDependencies: [...new Set(unresolved.map((item) => String(item.dependsOnQuestionId)))],
      transitionReasoning,
      derivedState,
      ruleSources: dedupeBy(transitionReasoning.map((item) => item.ruleSource).filter(Boolean), (item) => item.ruleId),
    };

    if (unresolved.length) {
      const reason = unresolved.map((item) => `${item.reason}。`).join("");
      result = {
        ...result,
        status: answer.verdict !== "unknown" && answer.evidenceIds?.length ? "inferred" : "unknown",
        verdict: answer.verdict !== "unknown" && answer.evidenceIds?.length ? answer.verdict : "unknown",
        reason,
        reasoning: reason,
        warnings: [...new Set([...(answer.warnings || []), ...unresolved.map((item) => `unresolved_dependency:${item.dependsOnQuestionId}`)])],
        dependencyMessage: reason,
      };
    }

    if (
      derivedState?.zoneStatus === "pending_send_to_graveyard"
      && answer.type === "location_change"
    ) {
      const reason = "当前只确认存在待送墓过渡，不能把 pending_send_to_graveyard 当作已经送墓。";
      result = {
        ...result,
        status: answer.status === "confirmed" ? "inferred" : result.status,
        reason,
        reasoning: reason,
        warnings: [...new Set([...(result.warnings || []), "pending_transition_not_completed"])],
      };
    }
    return result;
  });
}

function buildEmptyFormalEvidence(formalQuery) {
  const bySubQuestion = formalQuery.subQuestions.map((subQuestion) => ({
    subQuestionId: subQuestion.id,
    cardTextEvidence: [],
    rulingEvidence: [],
    similarRulingEvidence: [],
    rejectedEvidence: [],
    retrievalTrace: buildEmptyRetrievalTrace(subQuestion),
  }));
  return {
    bySubQuestion,
    cardTextEvidence: [],
    rulingEvidence: [],
    similarRulingEvidence: [],
    rejectedEvidence: [],
  };
}

export function retrieveEvidenceByFormalQuery(formalQuery, detectedCards, snapshot) {
  const query = normalizeFormalRulingQuery(formalQuery);
  const cards = mergeCards(Array.isArray(detectedCards) ? detectedCards : []);
  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  const qaRecords = records.filter(isRulingEvidence);
  const bySubQuestion = query.subQuestions.map((subQuestion) => {
    const questionCards = cardsForSubQuestion(subQuestion, cards);
    const scenarioCards = cardsForScenario(query.scenario, cards);
    const resolvedCardIds = subQuestion.card === "unknown" ? [] : collectResolvedCardIds(questionCards);
    const aliasWithoutCardId = questionCards.length > 0 && resolvedCardIds.length === 0;
    const scenarioCardIds = collectResolvedCardIds(scenarioCards);
    const searchQueries = buildFormalEvidenceSearchQueries(subQuestion, questionCards, scenarioCards);
    const cardTextEvidence = questionCards.filter((card) => card.effectText).map((card) => buildFormalCardTextEvidence(card, subQuestion.id));
    const rulingEvidence = [];
    const similarRulingEvidence = [];
    const rejectedEvidence = [];
    const downgradedDirectEvidence = [];
    const rawCandidateEvidence = [];
    const rawClassifications = { direct: [], similar: [], rejected: [] };

    for (const record of qaRecords) {
      if (resolvedCardIds.length === 0) break;
      const rawCandidate = describeRawCandidateEvidence(
        record,
        subQuestion,
        questionCards,
        scenarioCards,
        resolvedCardIds,
        scenarioCardIds,
        searchQueries
      );
      const classifiedSubQuestion = { ...subQuestion, scenarioRawContext: query.scenario.rawContext };
      const classification = classifyQaForSubQuestion(classifiedSubQuestion, record);
      const matchesAnyQueryCard = countEvidenceMatchedCards(record, cards) > 0;
      const matchesQuestionCard = qaMatchesSubQuestionCard(subQuestion, record);
      const base = {
        ...record,
        evidenceId: record.id,
        subQuestionId: subQuestion.id,
        evidenceTypes: classification.matchedQuestionType ? [classification.matchedQuestionType] : [],
        answeredAskedResult: classification.answeredAskedResult,
        askedResultCoverage: classification.askedResultCoverage,
        extractedVerdict: classification.extractedVerdict || "unknown",
        classificationReason: classification.reason,
      };

      if (classification.downgradedFromDirect && record.id) {
        downgradedDirectEvidence.push({
          id: record.id,
          reason: classification.reason,
          askedResultCoverage: classification.askedResultCoverage,
        });
      }

      if (rawCandidate) {
        rawCandidateEvidence.push({
          ...rawCandidate,
          classification: classification.match,
          rejectedReason: classification.match === "rejected" ? classification.reason : null,
          askedResultCoverage: classification.askedResultCoverage || "unknown",
        });
        const evidenceId = record.id || "unknown";
        if (classification.match === "direct" && record.id) rawClassifications.direct.push(evidenceId);
        else if (classification.match === "similar") rawClassifications.similar.push(evidenceId);
        else {
          rawClassifications.rejected.push({
            id: evidenceId,
            rejectedReason: record.id ? classification.reason : "missing_evidence_id",
          });
        }
      }

      if (classification.match === "direct") {
        if (!record.id) {
          rejectedEvidence.push({ ...base, matchKind: "rejected", rejectedReason: "missing_evidence_id" });
        } else {
          rulingEvidence.push({ ...base, matchKind: "direct" });
        }
        continue;
      }
      if (classification.match === "similar") {
        similarRulingEvidence.push({ ...base, matchKind: "similar" });
        continue;
      }
      if (matchesQuestionCard || matchesAnyQueryCard) {
        rejectedEvidence.push({
          ...base,
          matchKind: "rejected",
          rejectedReason: classification.reason,
        });
      }
    }

    const conflictExtraction = rulingEvidence.length > 1
      ? extractVerdictFromEvidence(subQuestion, rulingEvidence)
      : null;
    if (conflictExtraction?.whyUnknown === "conflicting_direct_evidence") {
      const conflicting = rulingEvidence.splice(0, rulingEvidence.length);
      for (const item of conflicting) {
        similarRulingEvidence.push({
          ...item,
          matchKind: "similar",
          answeredAskedResult: false,
          askedResultCoverage: "conflicting",
          classificationReason: "conflicting_direct_evidence",
        });
        downgradedDirectEvidence.push({
          id: item.evidenceId,
          reason: "conflicting_direct_evidence",
          askedResultCoverage: "conflicting",
        });
      }
      const conflictingIds = new Set(conflicting.map((item) => String(item.evidenceId)));
      rawClassifications.direct = rawClassifications.direct.filter((id) => !conflictingIds.has(String(id)));
      rawClassifications.similar.push(...conflicting.map((item) => item.evidenceId));
    }

    const normalizedCardText = dedupeBy(cardTextEvidence, (item) => item.evidenceId);
    const normalizedRuling = rankFormalEvidence(rulingEvidence, subQuestion).slice(0, 8);
    const normalizedSimilar = rankFormalEvidence(similarRulingEvidence, subQuestion).slice(0, 8);
    const normalizedRejected = dedupeBy(rejectedEvidence, (item) => `${item.evidenceId}:${item.rejectedReason}`).slice(0, 20);
    const classifiedEvidence = {
      direct: dedupeBy(rawClassifications.direct, (item) => item),
      similar: dedupeBy(rawClassifications.similar, (item) => item),
      rejected: dedupeBy(rawClassifications.rejected, (item) => `${item.id}:${item.rejectedReason}`),
    };
    const normalizedRawCandidates = dedupeBy(rawCandidateEvidence, (item) => item.id)
      .sort((left, right) => right.score - left.score)
      .map((item, index) => ({ ...item, rank: index + 1 }))
      .slice(0, 50);
    const retrievalTrace = {
      questionId: subQuestion.id,
      sourceText: subQuestion.sourceText,
      type: subQuestion.type,
      card: subQuestion.card,
      resolvedCardIds,
      scenarioCardIds,
      searchQueries,
      rawCandidateEvidence: normalizedRawCandidates,
      classifiedEvidence,
      downgradedDirectEvidence: dedupeBy(
        downgradedDirectEvidence,
        (item) => `${item.id}:${item.reason}`
      ),
      evidenceCoverageReason: determineEvidenceCoverageReason({
        subQuestion,
        resolvedCardIds,
        rawCandidateEvidence: normalizedRawCandidates,
        cardTextEvidence: normalizedCardText,
        directEvidence: classifiedEvidence.direct,
        aliasWithoutCardId,
      }),
    };

    return {
      subQuestionId: subQuestion.id,
      cardTextEvidence: normalizedCardText,
      rulingEvidence: normalizedRuling,
      similarRulingEvidence: normalizedSimilar,
      rejectedEvidence: normalizedRejected,
      retrievalTrace,
    };
  });

  return {
    bySubQuestion,
    cardTextEvidence: dedupeBy(bySubQuestion.flatMap((item) => item.cardTextEvidence), (item) => item.evidenceId),
    rulingEvidence: dedupeBy(bySubQuestion.flatMap((item) => item.rulingEvidence), (item) => `${item.subQuestionId}:${item.evidenceId}`),
    similarRulingEvidence: dedupeBy(
      bySubQuestion.flatMap((item) => item.similarRulingEvidence),
      (item) => `${item.subQuestionId}:${item.evidenceId}`
    ),
    rejectedEvidence: dedupeBy(
      bySubQuestion.flatMap((item) => item.rejectedEvidence),
      (item) => `${item.subQuestionId}:${item.evidenceId}:${item.rejectedReason}`
    ),
  };
}

function buildEmptyRetrievalTrace(subQuestion) {
  return {
    questionId: subQuestion.id,
    sourceText: subQuestion.sourceText,
    type: subQuestion.type,
    card: subQuestion.card,
    resolvedCardIds: [],
    scenarioCardIds: [],
    searchQueries: buildFormalEvidenceSearchQueries(subQuestion),
    rawCandidateEvidence: [],
    classifiedEvidence: { direct: [], similar: [], rejected: [] },
    downgradedDirectEvidence: [],
    evidenceCoverageReason: "retrieval_empty",
  };
}

function cardsForScenario(scenario, cards) {
  const context = [
    scenario?.rawContext,
    ...(Array.isArray(scenario?.events) ? scenario.events.map((event) => event?.card) : []),
  ].filter(Boolean).join(" ");
  const normalizedContext = normalizeKey(context);
  if (!normalizedContext) return [];
  return cards.filter((card) => cardAliases(card).some((alias) => {
    const key = normalizeKey(alias);
    return key.length >= 2 && normalizedContext.includes(key);
  }));
}

function collectResolvedCardIds(cards) {
  const ids = [];
  for (const card of cards) {
    for (const value of [card?.liveId, card?.passcode, card?.cardId, card?.id]) {
      const id = String(value || "").trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function buildFormalEvidenceSearchQueries(subQuestion, questionCards = [], scenarioCards = []) {
  const semanticQueries = {
    activation_condition: ["能否发动", "发动条件", "发动时点", "诱发条件"],
    activation_location: ["在哪里发动", "墓地发动", "场上发动", "除外状态发动"],
    temporary_banish: ["效果处理时除外", "暂时除外", "除外对象", "除外后返回"],
    send_to_gy: ["战斗破坏后送墓", "送墓时点", "是否送去墓地"],
    return_to_deck: ["效果处理后回卡组", "返回卡组"],
    location_change: ["区域变化", "已经送墓", "所在区域"],
    resolution_handling: ["效果处理", "结算时"],
  };
  const primaryName = String(subQuestion?.card || "").trim();
  const searchCardName = primaryName === "referenced_toon_monster" ? "卡通怪兽" : primaryName;
  const sourcePrimaryName = extractSearchCardName(subQuestion?.sourceText) || primaryName;
  const compactPrimaryName = searchCardName.replace(/[-－]/gu, " ").replace(/\s+/gu, " ").trim();
  const scenarioNames = scenarioCards.map((card) => card.name).filter((name) => name && normalizeKey(name) !== normalizeKey(searchCardName));
  const aliases = questionCards.flatMap(cardAliases);
  const combinedQueries = [];
  const typeKeywords = semanticQueries[subQuestion?.type] || [subQuestion?.type];
  if (searchCardName && searchCardName !== "unknown") {
    if (subQuestion?.askedResult && subQuestion.askedResult !== "unknown") {
      combinedQueries.push(`${searchCardName} ${subQuestion.askedResult}`);
    }
    for (const keyword of typeKeywords.slice(0, 4)) combinedQueries.push(`${searchCardName} ${keyword}`);
  }
  for (const alias of dedupeBy(aliases, (item) => normalizeKey(item)).slice(0, 12)) {
    const aliasKeyword = multilingualTypeKeyword(subQuestion?.type, alias);
    if (aliasKeyword) combinedQueries.push(`${alias} ${aliasKeyword}`);
  }
  if (subQuestion?.type === "temporary_banish") {
    if (sourcePrimaryName && sourcePrimaryName !== "unknown") combinedQueries.push(`${sourcePrimaryName} 除外 卡通怪兽`);
    if (compactPrimaryName && compactPrimaryName !== "unknown") combinedQueries.push(`${compactPrimaryName} 效果处理 除外`);
    const toonNames = normalizeKey(`${primaryName} ${aliases.join(" ")}`);
    if (/(卡通世界|toonworld|トゥーンワールド)/iu.test(toonNames)) {
      combinedQueries.push("Toon World banish toon monster", "トゥーン ワールド 除外 トゥーン");
    }
  }
  for (const scenarioName of scenarioNames.slice(0, 4)) {
    combinedQueries.push(`${scenarioName} ${searchCardName} ${typeKeywords[0] || ""}`.trim());
  }
  return dedupeBy([
    subQuestion?.sourceText,
    ...combinedQueries,
    searchCardName,
    subQuestion?.askedResult,
    ...scenarioNames,
    ...typeKeywords,
  ].map((item) => String(item || "").trim()).filter((item) => item && item !== "unknown"), (item) => normalizeKey(item));
}

function multilingualTypeKeyword(type, alias) {
  const text = String(alias || "");
  const english = /[a-z]/iu.test(text) && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(text);
  const japanese = /[\u3040-\u30ff]/u.test(text);
  const keywords = {
    activation_condition: english ? "can activate activation condition" : japanese ? "発動条件 発動できる" : "能否发动 发动条件",
    activation_location: english ? "Graveyard Monster Zone activated" : japanese ? "墓地 発動 モンスターゾーン" : "墓地发动 场上发动",
    temporary_banish: english ? "temporarily banish return" : japanese ? "一時的に除外 戻る" : "效果处理 除外 返回",
    send_to_gy: english ? "sent to the Graveyard after banished" : japanese ? "戦闘破壊 墓地へ送る" : "战斗破坏 送去墓地",
    return_to_deck: english ? "return to the Deck" : japanese ? "デッキに戻る" : "返回卡组",
    location_change: english ? "current location Graveyard banished" : japanese ? "現在の場所 墓地 除外" : "区域变化 已经送墓",
    resolution_handling: english ? "effect resolution handling" : japanese ? "効果処理 解決時" : "效果处理 结算时",
  };
  return keywords[type] || "";
}

function extractSearchCardName(sourceText) {
  const text = String(sourceText || "").trim();
  const match = text.match(/(?:能用|使用)\s*([^，。？！?]{2,40}?)\s*(?:的|之)\s*效果/iu);
  return match ? match[1].trim() : "";
}

function describeRawCandidateEvidence(
  record,
  subQuestion,
  questionCards,
  scenarioCards,
  resolvedCardIds,
  scenarioCardIds,
  searchQueries
) {
  const matchedBy = [];
  const recordCardIds = collectEvidenceCardIds(record, [...questionCards, ...scenarioCards]);
  if (setsOverlap(new Set(resolvedCardIds), new Set(recordCardIds))) matchedBy.push("resolved_card_id");
  if (qaMatchesSubQuestionCard(subQuestion, record)) matchedBy.push("card_name");
  if (scenarioCards.length && countEvidenceMatchedCards(record, scenarioCards) > 0) matchedBy.push("scenario_card");
  const matchedQuestionType = classifyQaQuestionType(record);
  if (qaTypeMatchesSubQuestion(subQuestion?.type, matchedQuestionType)) matchedBy.push("question_type");
  const evidenceText = formalEvidenceText(record);
  if (searchQueries.some((query) => {
    const key = normalizeKey(query);
    return key.length >= 2 && normalizeKey(evidenceText).includes(key);
  })) matchedBy.push("search_query");
  if (!matchedBy.length) return null;

  const score =
    (matchedBy.includes("resolved_card_id") ? 100 : 0) +
    (matchedBy.includes("card_name") ? 60 : 0) +
    (matchedBy.includes("question_type") ? 30 : 0) +
    (matchedBy.includes("scenario_card") ? 20 : 0) +
    (matchedBy.includes("search_query") ? 10 : 0);
  return {
    id: record.id || "unknown",
    source: record.sources?.[0]?.label || record.recordType || "unknown",
    cardIds: recordCardIds,
    title: record.title || "",
    textPreview: cleanText(`${record.question || record.questionText || ""} ${record.conclusion || ""}`).slice(0, 240),
    score,
    matchedBy,
  };
}

function collectEvidenceCardIds(record, knownCards) {
  const ids = [
    ...(Array.isArray(record?.cardIds) ? record.cardIds : []),
    record?.cardId,
  ].map((item) => String(item || "").trim()).filter(Boolean);
  const listedCards = Array.isArray(record?.cards) ? record.cards : [record?.cards].filter(Boolean);
  const recordText = normalizeKey(`${listedCards.join(" ")} ${formalEvidenceText(record)}`);
  for (const card of knownCards) {
    if (cardAliases(card).some((alias) => {
      const key = normalizeKey(alias);
      return key.length >= 2 && recordText.includes(key);
    })) ids.push(...collectResolvedCardIds([card]));
  }
  return dedupeBy(ids, (item) => item);
}

function determineEvidenceCoverageReason({
  subQuestion,
  resolvedCardIds,
  rawCandidateEvidence,
  cardTextEvidence,
  directEvidence,
  aliasWithoutCardId,
}) {
  if (aliasWithoutCardId) return "alias_without_card_id";
  if (resolvedCardIds.length === 0) return "card_resolution_failed";
  if (cardTextEvidence.length > 0 && rawCandidateEvidence.length === 0) return "card_text_only";
  if (rawCandidateEvidence.length === 0) return "retrieval_empty";
  if (directEvidence.length === 0) return "matcher_rejected_all";
  return "direct_evidence_found";
}

export function extractVerdictFromEvidence(subQuestion, evidenceList, context = {}) {
  const evidence = Array.isArray(evidenceList) ? evidenceList : [];
  const evidenceIds = dedupeBy(
    evidence.map((item) => String(item?.evidenceId || item?.id || "")).filter(Boolean),
    (item) => item
  );
  const gameState = context.gameState || (context.formalQuery ? buildGameStateFromFormalQuery(context.formalQuery) : null);
  const eventTimeline = context.eventTimeline
    || (context.formalQuery && gameState ? buildEventTimelineFromFormalQuery(context.formalQuery, gameState) : null);
  const derivedState = gameState && eventTimeline
    ? deriveStateAtTiming(gameState, eventTimeline, { card: subQuestion?.card, sourceText: subQuestion?.sourceText })
    : null;
  const conditionEvidence = evidence
    .map((item) => ({ evidence: item, extracted: extractConditionBranchesFromEvidence(item) }))
    .filter((item) => item.extracted.branches.length > 0);
  const branchSelections = conditionEvidence.map((item) => ({
    evidenceId: item.extracted.evidenceId,
    ...selectBranchForSubQuestion(
      subQuestion,
      item.extracted,
      gameState || { entities: [], contradictions: [], timing: {} },
      derivedState
    ),
  }));
  const conditionalIds = new Set(conditionEvidence.map((item) => String(item.extracted.evidenceId)));
  const phraseEvidence = evidence
    .filter((item) => !conditionalIds.has(String(item?.evidenceId || item?.id || "")))
    .map((item) => ({
      evidenceId: String(item?.evidenceId || item?.id || ""),
      ...extractSingleEvidenceVerdict(subQuestion, item),
    }));
  const extracted = [
    ...branchSelections
      .filter((item) => item.status === "selected" && item.verdict !== "unknown")
      .map((item) => ({ id: item.evidenceId, verdict: item.verdict, reason: item.reason })),
    ...phraseEvidence
      .map((item) => ({ id: item.evidenceId, verdict: item.verdict, reason: item.reason }))
      .filter((item) => item.verdict !== "unknown"),
  ];
  const conditionBranches = conditionEvidence.flatMap((item) => item.extracted.branches.map((branch) => ({
    evidenceId: item.extracted.evidenceId,
    ...branch,
  })));
  const warnings = [
    ...conditionEvidence.flatMap((item) => item.extracted.warnings),
    ...phraseEvidence.flatMap((item) => item.warnings || []),
  ];
  const extractorInput = phraseEvidence.map((item) => ({ evidenceId: item.evidenceId, text: item.extractorInput }));
  const extractorOutput = phraseEvidence.map((item) => ({
    evidenceId: item.evidenceId,
    verdict: item.verdict,
    reason: item.reason,
    whyUnknown: item.whyUnknown || null,
  }));

  if (!extracted.length) {
    if (branchSelections.length) {
      const selection = selectMostActionableBranchSelection(branchSelections);
      if (selection.status === "contradiction") warnings.push("condition_branch_contradiction");
      return {
        verdict: "unknown",
        reason: branchSelectionReason(selection, derivedState),
        evidenceIds,
        conditionBranches,
        branchSelections,
        branchSelection: selection,
        missingConditions: selection.missingConditions || [],
        warnings: [...new Set(warnings)],
        derivedStateAtTiming: derivedState,
        extractorInput,
        extractorOutput,
        extractorWarnings: [...new Set(warnings)],
        whyUnknown: selection.status === "missing_state"
          ? "conditional_branch_not_selected"
          : selection.status === "ambiguous"
            ? "conditional_branch_ambiguous"
            : `condition_branch_${selection.status}`,
      };
    }
    const unknownReasons = [...new Set(phraseEvidence.map((item) => item.whyUnknown || item.reason).filter(Boolean))];
    const whyUnknown = unknownReasons.length === 1
      ? unknownReasons[0]
      : unknownReasons.length > 1
        ? `multiple_unknown_reasons:${unknownReasons.join(",")}`
        : "no_explicit_polarity";
    return {
      verdict: "unknown",
      reason: `direct_evidence_has_no_explicit_answer:${whyUnknown}`,
      evidenceIds,
      conditionBranches: [],
      branchSelections: [],
      branchSelection: null,
      missingConditions: [],
      warnings: [...new Set(warnings)],
      derivedStateAtTiming: derivedState,
      extractorInput,
      extractorOutput,
      extractorWarnings: [...new Set(warnings)],
      whyUnknown,
    };
  }

  const merged = mergeExtractedVerdicts(subQuestion?.type, extracted.map((item) => item.verdict));
  if (merged === "unknown") {
    warnings.push("conflicting_direct_evidence");
    return {
      verdict: "unknown",
      reason: `conflicting_direct_evidence:${[...new Set(extracted.map((item) => item.verdict))].join(",")}`,
      evidenceIds,
      conditionBranches,
      branchSelections,
      branchSelection: selectMostActionableBranchSelection(branchSelections),
      missingConditions: [],
      warnings: [...new Set(warnings)],
      derivedStateAtTiming: derivedState,
      extractorInput,
      extractorOutput,
      extractorWarnings: [...new Set(warnings)],
      whyUnknown: "conflicting_direct_evidence",
    };
  }
  const selectedBranch = branchSelections.find((item) => item.status === "selected" && item.verdict === merged) || null;
  return {
    verdict: merged,
    reason: selectedBranch ? `condition_branch_selected:${merged}` : `explicit_evidence_answer:${merged}`,
    evidenceIds,
    conditionBranches,
    branchSelections,
    branchSelection: selectedBranch,
    missingConditions: [],
    warnings: [...new Set(warnings)],
    derivedStateAtTiming: derivedState,
    extractorInput,
    extractorOutput,
    extractorWarnings: [...new Set(warnings)],
    whyUnknown: null,
  };
}

function selectMostActionableBranchSelection(selections) {
  const priority = { contradiction: 4, missing_state: 3, ambiguous: 2, no_matching_branch: 1, selected: 0 };
  return selections.slice().sort((left, right) => (priority[right.status] || 0) - (priority[left.status] || 0))[0] || null;
}

function branchSelectionReason(selection, derivedState = null) {
  if (!selection) return "direct_evidence_has_no_explicit_answer";
  if (
    (selection.status === "missing_state" || selection.status === "ambiguous")
    && derivedState?.battleDestroyedStatus === "destroyed"
    && (derivedState.zoneStatus === "pending_send_to_graveyard" || derivedState.zoneStatus === "unknown")
  ) {
    return "condition_branch_missing_state:已识别战斗破坏，但未确认该时点是否已经完成送墓、是否被除外、或是否仍在场上。";
  }
  if (selection.status === "missing_state") return `condition_branch_missing_state:${(selection.missingConditions || []).join(",")}`;
  if (selection.status === "ambiguous") return `condition_branch_ambiguous:${(selection.missingConditions || []).join(",")}`;
  if (selection.status === "contradiction") return `condition_branch_contradiction:${(selection.conflictingConditions || []).join(",")}`;
  return `condition_branch_${selection.status}:${selection.reason}`;
}

export function answerEachSubQuestion(
  formalQuery,
  evidence,
  snapshot = null,
  validation = validateFormalRulingQuery(formalQuery),
  options = {}
) {
  const evidenceRecords = snapshot?.records || collectEvidenceRecords(evidence);
  const validEvidence = new Map(
    evidenceRecords.filter(isRulingEvidence).filter((record) => record.id).map((record) => [String(record.id), record])
  );
  const subQuestions = formalQuery.subQuestions.length
    ? formalQuery.subQuestions
    : [{ id: "q1", type: "unknown", card: "unknown", askedResult: "unknown", sourceText: "unknown" }];
  return subQuestions.map((subQuestion) => {
    const evidenceBuckets = Array.isArray(evidence) ? evidence : evidence?.bySubQuestion || [];
    const rawBucket = evidenceBuckets.find((item) => (item.subQuestionId || item.questionId) === subQuestion.id) || {};
    const bucket = {
      ...rawBucket,
      rulingEvidence: rawBucket.rulingEvidence || rawBucket.directEvidence || [],
      similarRulingEvidence: rawBucket.similarRulingEvidence || rawBucket.similarEvidence || [],
      cardTextEvidence: rawBucket.cardTextEvidence || [],
      rejectedEvidence: rawBucket.rejectedEvidence || [],
    };
    const parseFailure = options.parseFailure || null;
    if (parseFailure) {
      return buildProgramSubAnswer(subQuestion, "parse_failed", "unknown", [], `formal_query_parse_failed:${parseFailure}`, [], bucket);
    }

    const invalidDirect = bucket.rulingEvidence.filter((item) => {
      const source = validEvidence.get(String(item.evidenceId || ""));
      return !source || !isRulingEvidence(source) || classifyQaForSubQuestion(subQuestion, source).match !== "direct";
    });
    const direct = bucket.rulingEvidence.filter((item) => !invalidDirect.includes(item));
    if (invalidDirect.length) {
      return buildProgramSubAnswer(
        subQuestion,
        "unknown",
        "unknown",
        [],
        "direct_evidence_id_or_type_invalid",
        ["invalid_direct_evidence"],
        bucket
      );
    }
    if (direct.length) {
      const extracted = extractVerdictFromEvidence(subQuestion, direct, {
        formalQuery,
        gameState: options.gameState,
        eventTimeline: options.eventTimeline,
      });
      const warnings = [
        ...(extracted.reason.startsWith("conflicting_direct_evidence") ? ["conflicting_direct_evidence"] : []),
        ...(extracted.warnings || []),
      ];
      const candidate = attachExtractionMetadata(buildProgramSubAnswer(
        subQuestion,
        extracted.verdict === "unknown" ? "unknown" : "confirmed",
        extracted.verdict,
        extracted.evidenceIds,
        extracted.reason,
        warnings,
        bucket
      ), extracted, subQuestion, {
        evidence: direct,
        gameState: options.gameState,
        eventTimeline: options.eventTimeline,
      });
      return finalAnswerGate(candidate, bucket, {
        parserWarnings: options.parserWarnings || [],
        validEvidenceIds: new Set(validEvidence.keys()),
      });
    }
    const validSimilar = bucket.similarRulingEvidence.filter((item) => {
      const source = validEvidence.get(String(item.evidenceId || ""));
      return source && classifyQaForSubQuestion(subQuestion, source).match !== "rejected";
    });
    if (validSimilar.length) {
      const extracted = extractVerdictFromEvidence(subQuestion, validSimilar, {
        formalQuery,
        gameState: options.gameState,
        eventTimeline: options.eventTimeline,
      });
      const candidate = attachExtractionMetadata(buildProgramSubAnswer(
        subQuestion,
        extracted.verdict === "unknown" ? "unknown" : "inferred",
        extracted.verdict,
        extracted.evidenceIds,
        `similar_evidence:${extracted.reason}`,
        [
          ...(extracted.reason.startsWith("conflicting_direct_evidence") ? ["conflicting_similar_evidence"] : []),
          ...(extracted.warnings || []),
        ],
        bucket
      ), extracted, subQuestion, {
        evidence: validSimilar,
        gameState: options.gameState,
        eventTimeline: options.eventTimeline,
      });
      return finalAnswerGate(candidate, bucket, {
        parserWarnings: options.parserWarnings || [],
        validEvidenceIds: new Set(validEvidence.keys()),
      });
    }
    const reason = bucket.cardTextEvidence.length
      ? "card_text_only"
      : bucket.rejectedEvidence.length
        ? "rejected_evidence_only"
        : "no_evidence";
    return buildProgramSubAnswer(subQuestion, "unknown", "unknown", [], reason, [], bucket);
  });
}

function attachExtractionMetadata(answer, extracted, subQuestion, context = {}) {
  const conditionalAnswer = buildConditionalAnswer({
    subQuestion,
    evidence: context.evidence || [],
    conditionBranches: extracted.conditionBranches || [],
    branchSelectorResult: extracted.branchSelection || null,
    gameState: context.gameState,
    eventTimeline: context.eventTimeline,
  });
  return {
    ...answer,
    extractedVerdict: extracted.verdict,
    conditionBranches: extracted.conditionBranches || [],
    branchSelections: extracted.branchSelections || [],
    branchSelection: extracted.branchSelection || null,
    missingConditions: extracted.missingConditions || [],
    derivedStateAtTiming: extracted.derivedStateAtTiming || null,
    extractorInput: extracted.extractorInput || [],
    extractorOutput: extracted.extractorOutput || [],
    extractorWarnings: extracted.extractorWarnings || [],
    whyUnknown: extracted.whyUnknown || null,
    stateMessage: buildMissingStateMessage(subQuestion, extracted.branchSelection),
    ...(conditionalAnswer ? { conditionalAnswer } : {}),
  };
}

function buildMissingStateMessage(subQuestion, selection) {
  if (!selection || (selection.status !== "missing_state" && selection.status !== "ambiguous")) return "";
  const card = subQuestion?.card || "该卡";
  const conditions = new Set(selection.missingConditions || []);
  const labels = [];
  if (conditions.has("remains_on_field") || conditions.has("monster_zone")) labels.push(`${card}是否仍在怪兽区`);
  if (conditions.has("sent_to_graveyard") || conditions.has("graveyard")) labels.push(`${card}是否已经送去墓地`);
  if (conditions.has("banished") || conditions.has("banished_zone")) labels.push(`${card}是否被除外`);
  const details = labels.length ? labels.join("、") : [...conditions].join("、");
  return `已找到相关 FAQ，但该 FAQ 有多个条件分支。当前问题缺少以下状态，无法确定适用哪个分支：${details}`;
}

export function finalAnswerGate(programAnswer, evidenceBucket = {}, options = {}) {
  const result = {
    ...programAnswer,
    evidenceIds: [...new Set(programAnswer?.evidenceIds || [])],
    warnings: [...new Set(programAnswer?.warnings || [])],
  };
  if (result.status === "parse_failed") return result;
  if (result.verdict === "unknown") {
    result.status = "unknown";
    return result;
  }
  if (result.status === "inferred") return result;
  if (result.status !== "confirmed") return result;

  const directIds = new Set(
    (evidenceBucket.rulingEvidence || evidenceBucket.directEvidence || [])
      .map((item) => typeof item === "string" ? item : item?.evidenceId || item?.id)
      .filter(Boolean)
  );
  const validEvidenceIds = options.validEvidenceIds instanceof Set
    ? options.validEvidenceIds
    : new Set(options.validEvidenceIds || directIds);

  if (!result.evidenceIds.length || result.evidenceIds.some((id) => !validEvidenceIds.has(id))) {
    return downgradeProgramAnswer(result, "evidence_id_not_found");
  }
  if (result.evidenceIds.some((id) => !directIds.has(id))) {
    return downgradeProgramAnswer(result, "evidence_not_direct");
  }
  if ((options.parserWarnings || []).length) {
    result.status = "inferred";
    result.warnings = [...new Set([...result.warnings, "parser_warnings_cap_status"] )];
  }
  return result;
}

function extractSingleEvidenceVerdict(subQuestion, evidence) {
  const text = evidenceAnswerText(evidence);
  if (!text) {
    return {
      verdict: "unknown",
      reason: "evidence_answer_text_missing",
      whyUnknown: "evidence_answer_text_missing",
      warnings: [],
      extractorInput: "",
    };
  }
  if (/[？?]\s*$/u.test(text) && !/(?:答|回答|结论|因此|所以|可以[。！!]|不可以[。！!]|不能[。！!])/u.test(text)) {
    return {
      verdict: "unknown",
      reason: "evidence_repeats_question_without_answer",
      whyUnknown: "evidence_repeats_question_without_answer",
      warnings: [],
      extractorInput: text,
    };
  }
  const detected = detectActionVerdict(subQuestion, text);
  return { ...detected, extractorInput: text };
}

function evidenceAnswerText(evidence) {
  const parts = [
    evidence?.conclusion,
    evidence?.answer,
    evidence?.answerText,
    evidence?.text,
    ...(Array.isArray(evidence?.steps) ? evidence.steps : []),
  ];
  return cleanText(parts.filter(Boolean).join(" "));
}

function mergeExtractedVerdicts(type, verdicts) {
  const unique = [...new Set(verdicts.filter((verdict) => verdict && verdict !== "unknown"))];
  if (unique.length <= 1) return unique[0] || "unknown";

  if (type === "activation_condition" || type === "timing") {
    if (unique.every((verdict) => verdict === "can" || verdict === "yes")) return "can";
    if (unique.every((verdict) => verdict === "cannot" || verdict === "no")) return "cannot";
    return "unknown";
  }
  if (type === "temporary_banish") {
    const positive = new Set(["can", "yes", "banished_temporarily", "returns_to_original_zone"]);
    const negative = new Set(["cannot", "no"]);
    if (unique.every((verdict) => positive.has(verdict))) {
      if (unique.includes("banished_temporarily")) return "banished_temporarily";
      if (unique.includes("returns_to_original_zone")) return "returns_to_original_zone";
      return "can";
    }
    if (unique.every((verdict) => negative.has(verdict))) return "cannot";
    return "unknown";
  }
  if (type === "send_to_gy" || type === "location_change") {
    if (unique.every((verdict) => verdict === "sent_to_graveyard" || verdict === "yes")) return "sent_to_graveyard";
    if (unique.every((verdict) => verdict === "not_sent_to_graveyard" || verdict === "no")) return "not_sent_to_graveyard";
    return "unknown";
  }
  return unique.length === 1 ? unique[0] : "unknown";
}

function collectEvidenceRecords(evidence) {
  const buckets = Array.isArray(evidence) ? evidence : evidence?.bySubQuestion || [];
  return dedupeBy(
    buckets.flatMap((bucket) => [
      ...(bucket.rulingEvidence || bucket.directEvidence || []),
      ...(bucket.similarRulingEvidence || bucket.similarEvidence || []),
    ]).filter((item) => item && typeof item === "object").map((item) => ({ ...item, id: item.id || item.evidenceId })),
    (item) => item.id || item.evidenceId
  );
}

function downgradeProgramAnswer(answer, warning) {
  return {
    ...answer,
    status: "unknown",
    verdict: "unknown",
    evidenceIds: [],
    reason: warning,
    reasoning: warning,
    warnings: [...new Set([...(answer.warnings || []), warning])],
  };
}

function mergeFormalAnswers(context) {
  const {
    formalQuery,
    detectedCards,
    evidence,
    subAnswers,
    snapshotMeta,
    validation,
    warnings,
    notes,
    parserWarnings,
    parserFailure,
    parserDebug,
  } = context;
  const statuses = subAnswers.map((item) => item.status);
  let mode = "unknown";
  if (statuses.length && statuses.every((status) => status === "confirmed")) mode = "confirmed";
  else if (statuses.length && statuses.every((status) => status === "confirmed" || status === "inferred")) mode = "inferred";
  else if (statuses.length && statuses.every((status) => status === "parse_failed")) mode = "parse_failed";

  const counts = Object.fromEntries(["confirmed", "inferred", "unknown", "parse_failed"].map((status) => [status, statuses.filter((item) => item === status).length]));
  const labels = {
    confirmed: "有直接裁定依据",
    inferred: "只有相似裁定",
    unknown: "资料不足",
    parse_failed: "形式化解析失败",
  };
  const usedEvidence = [...evidence.rulingEvidence, ...evidence.similarRulingEvidence];
  const needsConfirmation = [];
  if (counts.unknown) needsConfirmation.push("部分子问题只有卡片文本或没有匹配 Q&A，不能标记为已确认。");
  if (counts.inferred) needsConfirmation.push("相似问答不是本题的直接裁定，仍需核对对应卡片 Q&A。");
  if (counts.parse_failed) needsConfirmation.push("请补充缺失的卡名、效果编号或问题类型后重新解析。");
  if (parserWarnings.length) needsConfirmation.push("形式化解析包含警告，结论不会提升为 confirmed。");
  needsConfirmation.push(...subAnswers.map((answer) => answer.stateMessage).filter(Boolean));
  needsConfirmation.push(...subAnswers.map((answer) => answer.conditionalAnswer?.clarificationQuestion).filter(Boolean));
  needsConfirmation.push(...subAnswers.map((answer) => answer.dependencyMessage).filter(Boolean));
  needsConfirmation.push(...notes);

  return {
    schemaVersion: 2,
    mode,
    verdictTitle: labels[mode],
    verdict: `共拆分 ${subAnswers.length} 个子问题：${counts.confirmed} 个 confirmed，${counts.inferred} 个 inferred，${counts.unknown} 个 unknown，${counts.parse_failed} 个 parse_failed。`,
    rulingBasis: mode === "confirmed" ? "直接 Q&A/FAQ" : mode === "inferred" ? "相似 Q&A/FAQ" : "没有可确认的直接问答",
    confidence: { status: mode, label: labels[mode], className: mode === "confirmed" ? "is-confirmed" : "is-risky" },
    formalQuery,
    validation,
    parserWarnings,
    parserFailure,
    parserDebug,
    subQuestions: formalQuery.subQuestions,
    subAnswers,
    evidence,
    rejectedEvidence: evidence.rejectedEvidence,
    evidenceIds: subAnswers.flatMap((answer) => answer.evidenceIds),
    steps: subAnswers.map((answer) => `${answer.id}：${answer.status} - ${answer.reasoning}`),
    needsConfirmation: [...new Set(needsConfirmation)],
    sources: collectSources(usedEvidence, snapshotMeta),
    cards: buildCardSummaries(detectedCards),
    snapshotAt: snapshotMeta?.generatedAt || null,
    evidenceCount: usedEvidence.length,
    warnings,
    modelUsed: false,
  };
}

function buildProgramSubAnswer(subQuestion, status, verdict, evidenceIds, reason, warnings, bucket) {
  const uniqueEvidenceIds = [...new Set(evidenceIds || [])];
  return {
    questionId: subQuestion.id,
    id: subQuestion.id,
    sourceText: subQuestion.sourceText || "unknown",
    type: subQuestion.type,
    card: subQuestion.card || "unknown",
    status,
    verdict,
    evidenceIds: uniqueEvidenceIds,
    reason,
    warnings: [...new Set(warnings || [])],
    question: subQuestion.sourceText || subQuestion.askedResult || "unknown",
    reasoning: reason,
    source: uniqueEvidenceIds.length ? uniqueEvidenceIds.join(", ") : "无直接 Q&A",
    cardTextEvidenceIds: (bucket.cardTextEvidence || []).map((item) => item.evidenceId).filter(Boolean),
    rejectedEvidence: (bucket.rejectedEvidence || []).map((item) => ({
      evidenceId: item.evidenceId,
      rejectedReason: item.rejectedReason,
    })),
  };
}

function buildFormalCardTextEvidence(card, subQuestionId) {
  return {
    evidenceId: `card-text:${card.id || card.passcode || card.name}`,
    subQuestionId,
    recordType: "card-text",
    evidenceClass: "cardTextEvidence",
    title: `${card.name} 的卡片文本`,
    cards: [card.name],
    conclusion: card.effectText,
    sources: card.sourceUrl ? [{ label: "卡片资料", detail: card.sourceUrl }] : [],
  };
}

function cardsForSubQuestion(subQuestion, cards) {
  if (!subQuestion.card || subQuestion.card === "unknown") return cards;
  const wanted = normalizeKey(subQuestion.card);
  const matched = cards.filter((card) => cardAliases(card).some((alias) => {
    const key = normalizeKey(alias);
    return key === wanted || key.includes(wanted) || wanted.includes(key);
  }));
  return matched.length ? matched : [];
}

function formalEvidenceText(record) {
  return normalizeRulingText(`${record.question || ""} ${record.title || ""} ${record.conclusion || ""} ${(record.keywords || []).join(" ")}`);
}

export function classifyQaForSubQuestion(subQuestion, qa) {
  const fullText = formalEvidenceText(qa);
  const evidenceTypeAudit = classifyEvidenceQuestionTypes(fullText);
  const matchedQuestionType = classifyQaQuestionTypeForSubQuestion(subQuestion?.type, qa, evidenceTypeAudit);
  const typeMatches = evidenceTypesMatchSubQuestion(subQuestion?.type, evidenceTypeAudit)
    || qaTypeMatchesSubQuestion(subQuestion?.type, matchedQuestionType);
  const cardMatches = qaMatchesSubQuestionCard(subQuestion, qa);
  const semanticCoverage = qaCoversAskedResult(subQuestion, matchedQuestionType, fullText);
  const askedResultAudit = auditQaAskedResultCoverage(subQuestion, qa, matchedQuestionType, semanticCoverage);
  const subEffectNumbers = extractEffectNumbers(`${subQuestion?.effectNo || ""} ${subQuestion?.sourceText || ""}`);
  const qaEffectNumbers = extractEffectNumbers(fullText);
  const effectConflict = subEffectNumbers.size > 0 && qaEffectNumbers.size > 0 && !setsOverlap(subEffectNumbers, qaEffectNumbers);
  const effectNotCovered = subEffectNumbers.size > 0 && qaEffectNumbers.size === 0;
  const subZones = extractSceneZones(`${subQuestion?.sourceText || ""} ${subQuestion?.scenarioRawContext || ""}`);
  const qaZones = extractSceneZones(fullText);
  const zoneConflict = subZones.size > 0 && qaZones.size > 0 && !setsOverlap(subZones, qaZones);

  const result = (match, reason, overrides = {}) => ({
    match,
    reason,
    ...(matchedQuestionType !== "unknown" ? { matchedQuestionType } : {}),
    answeredAskedResult: askedResultAudit.answeredAskedResult,
    askedResultCoverage: askedResultAudit.askedResultCoverage,
    extractedVerdict: askedResultAudit.extractedVerdict,
    ...overrides,
  });

  if (!typeMatches) {
    return result("rejected", cardMatches ? "question_type_mismatch" : "card_and_question_type_mismatch", {
      answeredAskedResult: false,
      askedResultCoverage: matchedQuestionType === "unknown" ? "unknown" : "different_question",
      extractedVerdict: "unknown",
    });
  }
  if (effectConflict) return result("rejected", "effect_number_mismatch", {
    answeredAskedResult: false,
    askedResultCoverage: "different_card_or_context",
    extractedVerdict: "unknown",
  });
  if (zoneConflict) return result("rejected", "scene_zone_conflict", {
    answeredAskedResult: false,
    askedResultCoverage: "different_card_or_context",
    extractedVerdict: "unknown",
  });
  if (!semanticCoverage) return result(cardMatches ? "similar" : "rejected", "asked_result_not_covered", {
    answeredAskedResult: false,
    askedResultCoverage: askedResultAudit.askedResultCoverage === "explicit" ? "partial" : askedResultAudit.askedResultCoverage,
  });
  if (!cardMatches) return result("similar", "different_card_or_context", {
    answeredAskedResult: false,
    askedResultCoverage: "different_card_or_context",
    extractedVerdict: "unknown",
  });
  if (effectNotCovered) return result("similar", "effect_number_not_covered", {
    answeredAskedResult: false,
    askedResultCoverage: "partial",
    extractedVerdict: "unknown",
  });
  if (askedResultAudit.askedResultCoverage !== "explicit" || !askedResultAudit.answeredAskedResult) {
    const rejected = askedResultAudit.askedResultCoverage === "different_question"
      || askedResultAudit.askedResultCoverage === "different_card_or_context";
    return result(rejected ? "rejected" : "similar", askedResultAudit.reason, {
      downgradedFromDirect: true,
    });
  }
  return result("direct", "card_type_effect_semantics_and_scene_match");
}

function classifyQaQuestionType(qa, evidenceTypeAudit = null) {
  const promptText = normalizeRulingText(`${qa?.question || qa?.questionText || ""} ${qa?.title || ""} ${(qa?.keywords || []).join(" ")}`);
  const promptType = inferQaQuestionType(promptText);
  if (promptType !== "unknown") return promptType;
  const evidenceTypes = evidenceTypeAudit?.questionTypes || classifyEvidenceQuestionTypes(formalEvidenceText(qa)).questionTypes;
  return normalizeEvidenceQuestionType(evidenceTypes[0]) || inferQaQuestionType(formalEvidenceText(qa));
}

function classifyQaQuestionTypeForSubQuestion(subQuestionType, qa, evidenceTypeAudit = null) {
  const promptText = normalizeRulingText(`${qa?.question || qa?.questionText || ""} ${qa?.title || ""} ${(qa?.keywords || []).join(" ")}`);
  const promptType = inferQaQuestionType(promptText);
  if (qaTypeMatchesSubQuestion(subQuestionType, promptType)) return promptType;
  const matchedAuditType = normalizeEvidenceQuestionTypeForSubQuestion(subQuestionType, evidenceTypeAudit);
  if (matchedAuditType) return matchedAuditType;
  return promptType !== "unknown" ? promptType : classifyQaQuestionType(qa, evidenceTypeAudit);
}

function inferQaQuestionType(value) {
  const text = normalizeRulingText(value);
  if (/(在哪里发动|哪里发动|墓地发动|场上发动|除外状态发动|除外中发动|从墓地发动|在墓地.{0,12}发动|在场上.{0,12}发动|activate.{0,20}(?:GY|graveyard|field|banished))/iu.test(text)) {
    return "activation_location";
  }
  if (/(能否|能不能|可以|可否|是否|(?:^|[^不])能).{0,18}(发动|發動|発動)|(?:发动条件|發動條件|発動条件|诱发条件|誘発条件|发动时点|发动时机|诱发时点)|条件.{0,18}(发动|発動)|can.{0,12}activate/iu.test(text)) {
    return "activation_condition";
  }
  if (/(暂时除外|临时除外|一时的に除外|(?:效果处理时|处理时|处理后|结算时|解決時).{0,36}除外|除外.{0,24}(?:对象|返回|回到|结束阶段|处理后)|banish.{0,24}(?:target|until|return))/iu.test(text)) {
    return "temporary_banish";
  }
  if (/(已经送墓|是否已经.{0,12}(?:送墓|送去墓地))/iu.test(text)) return "location_change";
  if (/(?:战斗破坏|战破|destroyed by battle).{0,30}(?:送墓|送去墓地|墓地|sent to the GY)|(?:送墓时点|是否送墓|是否送去墓地|送去墓地|sent to the GY)/iu.test(text)) {
    return "send_to_gy";
  }
  if (/(回卡组|回到卡组|返回卡组|洗回卡组|return.{0,12}deck|shuffle.{0,12}deck)/iu.test(text)) return "return_to_deck";
  if (/(取对象|作为对象|对象|対象|target)/iu.test(text)) return "target";
  if (/(cost|代价|支付|コスト)/iu.test(text)) return "cost";
  if (/(效果处理|处理时|处理后|结算|解決|适用|適用|resolve)/iu.test(text)) return "resolution_handling";
  return "unknown";
}

function qaTypeMatchesSubQuestion(subQuestionType, qaType) {
  if (!subQuestionType || subQuestionType === "unknown" || qaType === "unknown") return false;
  if (subQuestionType === "timing") return qaType === "activation_condition";
  return subQuestionType === qaType;
}

function evidenceTypesMatchSubQuestion(subQuestionType, evidenceTypeAudit) {
  if (!subQuestionType || subQuestionType === "unknown") return false;
  const rawTypes = new Set(evidenceTypeAudit?.questionTypes || []);
  const types = new Set((evidenceTypeAudit?.questionTypes || []).map(normalizeEvidenceQuestionType).filter(Boolean));
  const actions = new Set(evidenceTypeAudit?.actions || []);
  if (subQuestionType === "activation_condition") {
    return ["activation_condition", "activation_timing", "damage_step_activation"].some((type) => types.has(type));
  }
  if (subQuestionType === "temporary_banish") {
    return types.has("temporary_banish")
      || types.has("banish_applicability")
      || (rawTypes.has("effect_applicability") && actions.has("banish"));
  }
  if (subQuestionType === "resolution_handling") {
    return types.has("resolution_handling") || types.has("effect_applicability");
  }
  if (subQuestionType === "timing") {
    return types.has("activation_timing") || types.has("activation_condition");
  }
  return types.has(subQuestionType);
}

function normalizeEvidenceQuestionType(type) {
  if (type === "activation_timing" || type === "damage_step_activation") return "activation_condition";
  if (type === "banish_applicability") return "temporary_banish";
  if (type === "effect_applicability") return "resolution_handling";
  return type || "";
}

function normalizeEvidenceQuestionTypeForSubQuestion(subQuestionType, evidenceTypeAudit) {
  if (!subQuestionType || subQuestionType === "unknown") return "";
  const rawTypes = new Set(evidenceTypeAudit?.questionTypes || []);
  const actions = new Set(evidenceTypeAudit?.actions || []);
  const normalizedTypes = new Set([...rawTypes].map(normalizeEvidenceQuestionType).filter(Boolean));
  if (rawTypes.has(subQuestionType) || normalizedTypes.has(subQuestionType)) return subQuestionType;
  if (subQuestionType === "activation_condition"
    && ["activation_condition", "activation_timing", "damage_step_activation"].some((type) => rawTypes.has(type) || normalizedTypes.has(type))) {
    return "activation_condition";
  }
  if (subQuestionType === "temporary_banish"
    && (rawTypes.has("temporary_banish") || rawTypes.has("banish_applicability") || (rawTypes.has("effect_applicability") && actions.has("banish")))) {
    return "temporary_banish";
  }
  if (subQuestionType === "resolution_handling"
    && (rawTypes.has("resolution_handling") || rawTypes.has("effect_applicability") || normalizedTypes.has("resolution_handling"))) {
    return "resolution_handling";
  }
  if (subQuestionType === "timing"
    && (rawTypes.has("activation_timing") || rawTypes.has("damage_step_activation") || normalizedTypes.has("activation_condition"))) {
    return "activation_condition";
  }
  return "";
}

function qaMatchesSubQuestionCard(subQuestion, qa) {
  const card = String(subQuestion?.card || "").trim();
  if (!card || card === "unknown") return false;
  const qaText = formalEvidenceText(qa);
  if (card === "referenced_toon_monster") return /(卡通怪兽|トゥーンモンスター|toon monster)/iu.test(qaText);

  const wanted = normalizeKey(card);
  const listedCards = Array.isArray(qa?.cards) ? qa.cards.map(normalizeKey).filter(Boolean) : [];
  if (listedCards.length) {
    return listedCards.some((candidate) => candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate));
  }
  return wanted.length >= 2 && normalizeKey(qaText).includes(wanted);
}

function qaCoversAskedResult(subQuestion, matchedQuestionType, fullText) {
  const askedResult = String(subQuestion?.askedResult || "");
  if (!qaTypeMatchesSubQuestion(subQuestion?.type, matchedQuestionType)) return false;
  if (matchedQuestionType === "temporary_banish") {
    if (requiresBattleSpecificBanishEvidence(subQuestion, fullText)) return false;
    return /(除外|banish)/iu.test(fullText) && /(处理|结算|对象|暂时|临时|结束阶段|返回|回到|until|target|return)/iu.test(fullText);
  }
  if (matchedQuestionType === "activation_location") {
    return /(发动|発動|activate)/iu.test(fullText) && /(墓地|场上|除外状态|除外中|GY|graveyard|field|banished)/iu.test(fullText);
  }
  if (matchedQuestionType === "send_to_gy") {
    const coversSend = /(送墓|送去墓地|墓地へ送|sent to the GY)/iu.test(fullText);
    const needsBattle = /battle|战破|战斗破坏/iu.test(askedResult);
    return coversSend && (!needsBattle || /(战斗破坏|战破|destroyed by battle)/iu.test(fullText));
  }
  if (matchedQuestionType === "activation_condition") {
    return /(能否发动|能不能发动|可以发动|不能发动|不可以发动|发动条件|诱发条件|发动时点|发动时机|诱发时点|条件.{0,18}发动|発動でき|発動できる条件|条件.{0,12}満たされ|ダメージステップ.{0,12}発動でき|can.{0,12}activate|cannot.{0,12}activate)/iu.test(fullText);
  }
  if (matchedQuestionType === "return_to_deck") return /(回卡组|回到卡组|返回卡组|deck)/iu.test(fullText);
  if (matchedQuestionType === "location_change") return /(已经|所在|位置|区域|送墓|除外|场上|墓地)/iu.test(fullText);
  return matchedQuestionType === subQuestion?.type;
}

function requiresBattleSpecificBanishEvidence(subQuestion, fullText) {
  const source = normalizeRulingText(`${subQuestion?.sourceText || ""} ${subQuestion?.scenarioRawContext || ""}`);
  const asksBattleDestroyedMonster = /(战破|战斗破坏|傷害計算|伤害计算|battle|damage calculation)/iu.test(source);
  if (!asksBattleDestroyedMonster) return false;
  return !/(战破|战斗破坏|戦闘で破壊|傷害計算|伤害计算|damage calculation|destroyed by battle)/iu.test(fullText);
}

function auditQaAskedResultCoverage(subQuestion, qa, matchedQuestionType, semanticCoverage) {
  const answerText = evidenceAnswerText(qa);
  const branchExtraction = extractConditionBranchesFromEvidence(qa);
  if (branchesCoverSubQuestion(branchExtraction.branches, subQuestion?.type)) {
    return {
      answeredAskedResult: true,
      askedResultCoverage: "explicit",
      extractedVerdict: "unknown",
      reason: "conditional_answer_covers_asked_result",
      extractorWhyUnknown: "conditional_branch_not_selected",
    };
  }

  const extracted = extractSingleEvidenceVerdict(subQuestion, qa);
  const answerFocus = detectEvidenceAnswerFocus(answerText);
  if (answerFocus && !answerFocusMatchesSubQuestion(answerFocus, subQuestion?.type)) {
    return {
      answeredAskedResult: false,
      askedResultCoverage: "different_question",
      extractedVerdict: "unknown",
      reason: "different_question",
      extractorWhyUnknown: "evidence_mentions_action_but_not_asked_result",
    };
  }
  if (extracted.verdict !== "unknown") {
    return {
      answeredAskedResult: true,
      askedResultCoverage: "explicit",
      extractedVerdict: extracted.verdict,
      reason: extracted.reason,
      extractorWhyUnknown: null,
    };
  }

  const whyUnknown = extracted.whyUnknown || extracted.reason || "unknown";
  if (whyUnknown === "conditional_branch_not_selected") {
    return {
      answeredAskedResult: false,
      askedResultCoverage: "partial",
      extractedVerdict: "unknown",
      reason: "conditional_branch_not_selected",
      extractorWhyUnknown: whyUnknown,
    };
  }
  if (whyUnknown === "evidence_mentions_action_but_not_asked_result") {
    return {
      answeredAskedResult: false,
      askedResultCoverage: "mentions_action_only",
      extractedVerdict: "unknown",
      reason: whyUnknown,
      extractorWhyUnknown: whyUnknown,
    };
  }
  if (whyUnknown === "no_explicit_polarity" || whyUnknown === "evidence_repeats_question_without_answer") {
    return {
      answeredAskedResult: false,
      askedResultCoverage: semanticCoverage ? "mentions_action_only" : "partial",
      extractedVerdict: "unknown",
      reason: whyUnknown === "evidence_repeats_question_without_answer" ? "no_explicit_polarity" : whyUnknown,
      extractorWhyUnknown: whyUnknown,
    };
  }
  return {
    answeredAskedResult: false,
    askedResultCoverage: semanticCoverage ? "partial" : "unknown",
    extractedVerdict: "unknown",
    reason: whyUnknown,
    extractorWhyUnknown: whyUnknown,
  };
}

function branchesCoverSubQuestion(branches, type) {
  const verdicts = new Set((branches || []).map((branch) => branch.verdict));
  if (type === "activation_location") {
    return [...verdicts].some((verdict) => [
      "activates_on_field",
      "activates_in_graveyard",
      "activates_while_banished",
    ].includes(verdict));
  }
  if (type === "temporary_banish") return [...verdicts].some((verdict) => ["can_banish", "cannot_banish"].includes(verdict));
  if (type === "send_to_gy" || type === "location_change") {
    return [...verdicts].some((verdict) => ["sent_to_graveyard", "not_sent_to_graveyard"].includes(verdict));
  }
  return false;
}

function detectEvidenceAnswerFocus(value) {
  const text = normalizeRulingText(value);
  if (!text) return null;
  if (/(change|changed).{0,20}battle position|battle position.{0,20}(?:change|changed)|改变.{0,12}(?:表示形式|战斗位置)|表示形式.{0,12}变更/iu.test(text)) {
    return "battle_position_change";
  }
  if (/(?:ダメージステップ|damage step|伤害步骤|傷害步驟).{0,40}(?:発動でき|activate|发动)|(?:発動でき|activate|发动).{0,40}(?:ダメージステップ|damage step|伤害步骤|傷害步驟)/iu.test(text)) {
    return "activation_condition";
  }
  if (/(?:在|从)(?:墓地|场上|怪兽区|除外状态).{0,16}(?:发动|發動)|(?:墓地|モンスターゾーン|除外状態)で.{0,16}発動|activat.{0,24}(?:graveyard|monster zone|field|banished)/iu.test(text)) {
    return "activation_location";
  }
  if (/(?:可以|不能|不可以|能).{0,20}(?:发动|發動)|(?:発動|activate|activated)/iu.test(text)) return "activation_condition";
  if (/(?:送墓|送去墓地|送入墓地|墓地へ送|sent to (?:the )?(?:graveyard|gy))/iu.test(text)) return "send_to_gy";
  if (/(?:回到|返回).{0,12}卡组|デッキに戻|return.{0,12}(?:the )?deck/iu.test(text)) return "return_to_deck";
  if (/(?:可以|不能|不可以|能).{0,24}(?:除外|适用(?:这个|该|此)?效果)|(?:除外できます|除外できません)|(?:can|cannot|can't).{0,24}banish/iu.test(text)) {
    return "temporary_banish";
  }
  return null;
}

function answerFocusMatchesSubQuestion(focus, type) {
  if (focus === "activation_condition") return type === "activation_condition" || type === "timing";
  if (focus === "activation_location") return type === "activation_location";
  if (focus === "temporary_banish") return type === "temporary_banish";
  if (focus === "send_to_gy") return type === "send_to_gy" || type === "location_change";
  if (focus === "return_to_deck") return type === "return_to_deck" || type === "location_change";
  return false;
}

function extractEffectNumbers(value) {
  const text = normalizeRulingText(value);
  const numbers = new Set();
  const circled = { "①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5", "⑥": "6", "⑦": "7", "⑧": "8", "⑨": "9" };
  for (const mark of text.match(/[①②③④⑤⑥⑦⑧⑨]/gu) || []) numbers.add(circled[mark]);
  for (const match of text.matchAll(/(?:效果|効果|effect)\s*([1-9])/giu)) numbers.add(match[1]);
  return numbers;
}

function extractSceneZones(value) {
  const text = normalizeRulingText(value);
  const zones = new Set();
  if (/(墓地|送墓|送去墓地|graveyard|\bGY\b)/iu.test(text)) zones.add("graveyard");
  if (/(场上|怪兽区域|魔法与陷阱区域|フィールド|\bfield\b)/iu.test(text)) zones.add("field");
  if (/(除外状态|除外中|被除外|banished)/iu.test(text)) zones.add("banished");
  if (/(额外卡组|EXデッキ|extra deck)/iu.test(text)) zones.add("extra_deck");
  else if (/(卡组|デッキ|\bdeck\b)/iu.test(text)) zones.add("deck");
  if (/(手卡|手札|\bhand\b)/iu.test(text)) zones.add("hand");
  return zones;
}

function setsOverlap(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function formalActionOverlap(left, right) {
  const leftTags = handlingTags(left);
  const rightTags = handlingTags(right);
  let count = 0;
  for (const tag of leftTags) if (rightTags.has(tag) && tag !== "activation") count += 1;
  return count;
}

function rankFormalEvidence(items, subQuestion) {
  return items
    .map((item) => ({
      ...item,
      formalScore:
        countEvidenceMatchedCards(item, cardsForSubQuestion(subQuestion, [{ name: subQuestion.card, aliases: [subQuestion.card] }])) * 10 +
        formalActionOverlap(subQuestion.askedResult, formalEvidenceText(item)) * 4,
    }))
    .sort((left, right) => right.formalScore - left.formalScore);
}

export async function loadSnapshot(dataDir = defaultDataDir) {
  const cacheKey = dataDir;
  const cached = snapshotCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < 30_000) return cached.snapshot;

  const [cardsPayload, rulingsPayload, metaPayload, ruleCorpusPayload, ruleTestsPayload, aliasIndexPayload, qaIndexPayload, dataHealth] = await Promise.all([
    readJson(join(dataDir, "cards.json"), { records: [] }),
    readJson(join(dataDir, "rulings.json"), { records: [] }),
    readJson(join(dataDir, "snapshot-meta.json"), { generatedAt: null, sources: [] }),
    readJson(join(dataDir, "ocg-rule-corpus.json"), { records: [] }),
    readJson(join(dataDir, "ocg-rule-tests.json"), { records: [] }),
    readJson(join(dataDir, "card-alias-index.json"), { records: [] }),
    readJson(join(dataDir, "qa-index.json"), { records: [] }),
    checkDataHealth(dataDir),
  ]);

  const snapshot = {
    cards: normalizeCards(cardsPayload.records || cardsPayload.cards || []),
    records: normalizeRecords([
      ...(rulingsPayload.records || rulingsPayload.rulings || rulingsPayload.notes || []),
      ...(ruleCorpusPayload.records || []),
      ...(ruleTestsPayload.records || []),
    ]),
    meta: metaPayload,
    cardAliasIndex: aliasIndexPayload.records || aliasIndexPayload.aliases || [],
    qaIndex: qaIndexPayload.records || qaIndexPayload.entries || [],
    dataHealth,
  };

  snapshotCache.set(cacheKey, { loadedAt: Date.now(), snapshot });
  return snapshot;
}

export async function getDataHealth(dataDir = defaultDataDir) {
  return checkDataHealth(dataDir);
}

export async function auditRetrieval(question, options = {}) {
  const rawQuestion = String(question || "").trim();
  const dataDir = options.dataDir || defaultDataDir;
  const env = options.env || globalThis.process?.env || {};
  const snapshot = await loadSnapshot(dataDir);
  const resolutionWarnings = [];
  const extractedResolution = collectQuestionCardCandidates(rawQuestion);
  const localResolution = collectLocalAliasResolutions(rawQuestion);
  const combinedResolution = mergeResolutions(extractedResolution, localResolution);
  let detectedCards = mergeCards(
    detectCards(rawQuestion, snapshot.cards),
    extractUserProvidedCards(rawQuestion),
    matchModelResolvedCards(combinedResolution, snapshot.cards),
    buildPlaceholderCards(localResolution)
  );
  const onDemandSync = options.includeLive === false
    ? buildSkippedOnDemandSync()
    : await syncOnDemandData({ detectedCards, snapshot, dataDir, env });
  const liveCards = onDemandSync.cards;
  const liveEvidence = onDemandSync.evidence;
  detectedCards = mergeCards(detectedCards, liveCards);
  resolutionWarnings.push(...onDemandSync.warnings);

  const parserResult = await parseFormalRulingQueryDetailed(
    rawQuestion,
    detectedCards,
    options.useModel === true ? env : {}
  );
  const normalizedFormalQuery = normalizeFormalRulingQuery(parserResult.query);
  const gameState = buildGameStateFromFormalQuery({ ...normalizedFormalQuery, resolvedCards: detectedCards });
  const eventTimeline = buildEventTimelineFromFormalQuery({ ...normalizedFormalQuery, resolvedCards: detectedCards }, gameState);
  const records = normalizeRecords([...snapshot.records, ...liveEvidence]);
  const evidenceSnapshot = { ...snapshot, records };
  const evidence = parserResult.parseFailed
    ? buildEmptyFormalEvidence(normalizedFormalQuery)
    : retrieveEvidenceByFormalQuery(normalizedFormalQuery, detectedCards, evidenceSnapshot);
  const baseSubAnswers = answerEachSubQuestion(
    normalizedFormalQuery,
    evidence,
    evidenceSnapshot,
    validateFormalRulingQuery(normalizedFormalQuery),
    { parseFailure: parserResult.parseFailed, parserWarnings: parserResult.parserWarnings, gameState, eventTimeline }
  );
  const dependencyGraph = buildSubQuestionDependencyGraph(normalizedFormalQuery, eventTimeline);
  const transitionRules = applyTransitionRules({
    formalQuery: normalizedFormalQuery,
    gameState,
    eventTimeline,
    dependencyGraph,
    subQuestionAnswers: baseSubAnswers,
  });
  const subAnswers = attachTransitionReasoning(baseSubAnswers, dependencyGraph, transitionRules);
  const liveResolutionAttempted = onDemandSync.attempted;
  const dataSourceStats = {
    ...buildRetrievalDataSourceStats(snapshot, liveCards, liveEvidence, records, liveResolutionAttempted),
    healthStatus: snapshot.dataHealth?.status || "data_source_missing",
    readinessLevel: snapshot.dataHealth?.readinessLevel || "not_ready",
    missingFiles: snapshot.dataHealth?.missingFiles || [],
    expectedDataPaths: snapshot.dataHealth?.expectedDataPaths || {},
    suggestedCommand: "node scripts/sync-data.mjs",
  };
  if (!snapshot.dataHealth?.usable) dataSourceStats.status = "data_source_missing";
  const resolutionNames = dedupeBy([
    ...localResolution.cards.map((item) => item.input),
    ...normalizedFormalQuery.cards.map((card) => card.name),
    ...normalizedFormalQuery.subQuestions.map((item) => extractSearchCardName(item.sourceText)),
  ].filter((item) => item && item !== "unknown"), (item) => normalizeKey(item));
  const cardResolution = auditCardResolutionNames(
    resolutionNames,
    mergeCards(snapshot.cards, detectedCards),
    combinedResolution
  );
  const retrievalTrace = buildSubQuestionEvidenceTrace(
    normalizedFormalQuery,
    evidence,
    subAnswers,
    onDemandSync,
    { gameState, eventTimeline }
  ).map((trace) => ({
    ...trace,
    rawCandidateEvidence: trace.rawCandidateEvidence.slice(0, 50),
    evidenceCoverageReason: auditCoverageReason(trace, dataSourceStats),
  }));

  return {
    rawQuestion,
    dataSourceStats,
    parserResult: {
      contextLines: parserResult.preprocessing.contextLines,
      questionLines: parserResult.preprocessing.questionLines,
      normalizedFormalQuery,
      gameState,
      eventTimeline,
      timelineWarnings: eventTimeline.warnings,
      dependencyGraph,
      transitionRules,
      parserWarnings: parserResult.parserWarnings,
      parseFailed: parserResult.parseFailed,
    },
    cardResolution,
    retrievalTrace,
    onDemandSync: summarizeOnDemandSync(onDemandSync),
    resolutionWarnings,
  };
}

function buildRetrievalDataSourceStats(snapshot, liveCards, liveEvidence, records, liveResolutionAttempted) {
  const loadedCards = mergeCards(snapshot.cards, liveCards);
  const byRecordType = {
    card_text: records.filter((record) => record.recordType === "card-text").length,
    qa: records.filter((record) => record.recordType === "qa").length,
    faq: records.filter((record) => record.recordType === "card-faq").length,
    rule_doc: records.filter((record) => record.recordType === "rule-doc").length,
    rule_test: records.filter((record) => record.recordType === "rule-test").length,
    note: records.filter((record) => record.recordType === "note").length,
  };
  const bySource = {};
  for (const record of records) {
    const source = record.sources?.[0]?.label || record.recordType || "unknown";
    bySource[source] = (bySource[source] || 0) + 1;
  }
  const qaIndexCount = byRecordType.qa + byRecordType.faq;
  return {
    loadedCardCount: loadedCards.length,
    loadedQaCount: byRecordType.qa,
    loadedFaqCount: byRecordType.faq,
    qaIndexCount,
    staticCardCount: snapshot.cards.length,
    staticRecordCount: snapshot.records.length,
    liveCardCount: liveCards.length,
    liveEvidenceCount: liveEvidence.length,
    liveResolutionAttempted,
    byRecordType,
    bySource,
    status: loadedCards.length === 0 && qaIndexCount === 0
      ? "data_source_missing"
      : qaIndexCount === 0
        ? "qa_index_empty"
        : "ready",
  };
}

function auditCoverageReason(trace, stats) {
  if (trace.rawCandidateEvidence.length > 0) return trace.evidenceCoverageReason;
  if (trace.evidenceCoverageReason === "live_source_unavailable") return "live_source_unavailable";
  if (trace.evidenceCoverageReason === "alias_without_card_id") return "alias_without_card_id";
  if (stats.status === "data_source_missing") return "data_source_missing";
  if (trace.resolvedCardIds.length === 0) return "card_resolution_failed";
  if (stats.qaIndexCount === 0) return "qa_index_empty";
  return trace.evidenceCoverageReason;
}

export function auditCardResolutionNames(names, cards, resolution = { cards: [] }) {
  const catalog = mergeCards(Array.isArray(cards) ? cards : []);
  return (Array.isArray(names) ? names : []).map((name) => String(name || "").trim()).filter(Boolean)
    .map((originalName) => {
      const normalizedName = normalizeKey(originalName);
      const ranked = catalog
        .map((card) => {
          let score = 0;
          let matchedName = "";
          for (const alias of cardAliases(card)) {
            const aliasScore = scoreTextSimilarity(normalizedName, normalizeKey(alias));
            if (aliasScore > score) {
              score = aliasScore;
              matchedName = alias;
            }
          }
          return { card, score, matchedName };
        })
        .filter((item) => item.score >= 0.45)
        .sort((left, right) => right.score - left.score);
      const matched = ranked.find((item) => item.score >= 0.74) || null;
      const resolvedCardIds = matched ? collectResolvedCardIds([matched.card]) : [];
      const resolutionItem = resolution.cards?.find((item) => normalizeKey(item.input) === normalizedName);
      const exactName = matched && normalizeKey(matched.matchedName) === normalizedName;
      const nameSource = matched
        ? matched.card.resolvedBy || (exactName ? "exact_name" : matched.score >= 0.88 ? "alias" : "approximate")
        : resolutionItem
          ? "candidate_only"
          : "unmatched";
      return {
        originalName,
        normalizedName,
        resolvedCardIds,
        matchedNames: matched ? dedupeBy([matched.matchedName, ...cardAliases(matched.card)], normalizeKey).slice(0, 12) : [],
        language: detectCardNameLanguage(originalName),
        nameSource,
        status: resolvedCardIds.length
          ? "resolved"
          : matched
            ? "alias_without_card_id"
            : "card_resolution_failed",
        approximateMatches: ranked.slice(0, 5).map((item) => ({
          name: item.card.name,
          matchedName: item.matchedName,
          score: Number(item.score.toFixed(3)),
          resolvedCardIds: collectResolvedCardIds([item.card]),
        })),
        failureReason: resolvedCardIds.length
          ? null
          : matched
            ? "matched_name_without_card_id"
            : resolutionItem
              ? "candidate_names_not_found_in_loaded_card_index"
              : "no_card_name_match",
      };
    });
}

function detectCardNameLanguage(value) {
  const text = String(value || "");
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[A-Za-z]/u.test(text) && !/[\u3400-\u9fff]/u.test(text)) return "en";
  if (/[\u3400-\u9fff]/u.test(text)) return "zh";
  return "unknown";
}

function buildEvidenceAnswer(context) {
  const { detectedCards, evidence, snapshotMeta } = context;
  const sources = collectSources(evidence, snapshotMeta);

  if (!detectedCards.length) {
    return buildUnknownAnswer(
      "还没识别出卡片",
      "系统没有在已同步资料中识别到题目里的卡。可以继续用俗称，但需要再给一点线索，例如日文名、英文名、卡图上的关键词、效果原文或卡片种类。",
      [
        "不用强制改成官方全名；可以补充常用别名、日文/英文片段或效果原文。",
        "补充效果编号、所在区域、连锁顺序、控制者和当前表示形式。",
        "如果是新卡或冷门俗称，等同步资料覆盖或在别名表里补一条即可。",
      ],
      ["题目里的俗称可能还没有登记，或者当前快照没有同步到对应卡。"],
      snapshotMeta
    );
  }

  if (!evidence.length) {
    return buildUnknownAnswer(
      "没有命中可用资料",
      "已识别到相关卡片，但没有命中能回答该场面的 Q&A、FAQ 或效果文本。为保证正确性，暂不给确定裁定。",
      [
        "核对题目中的卡名别名是否对应同一张卡，以及效果编号是否正确。",
        "补充完整效果文本、连锁、区域、控制者、时点和适用中的其他效果。",
        "补充官方 Q&A、规则书条目或可信事务局记录后再回答。",
      ],
      ["当前资料快照可能没有覆盖这张卡的相关问答。"],
      snapshotMeta
    );
  }

  const usableRulings = evidence.filter((item) => isRulingEvidence(item) && !item.intentMismatch);
  const mismatchedRuling = evidence.find((item) => isRulingEvidence(item) && item.intentMismatch);
  const preemptiveRuleInference = inferPreemptiveRuleAnswer(context, sources, snapshotMeta, evidence.length);
  if (preemptiveRuleInference) return preemptiveRuleInference;

  const exactRuling = usableRulings.find((item) => item.matchKind === "direct");
  if (exactRuling) {
    const title = summarizeRulingConclusion(exactRuling.conclusion, "direct", `${context.question} ${exactRuling.question || exactRuling.title || ""}`);
    return {
      schemaVersion: 1,
      mode: "confirmed",
      verdictTitle: title,
      verdict: buildReadableRulingBody(exactRuling.conclusion, title, "direct", context),
      rulingBasis: "找到直接问答资料",
      confidence: buildEvidenceConfidence(context, evidence, "confirmed"),
      steps: buildRulingSteps(context, exactRuling, title),
      needsConfirmation: buildDirectNeedsConfirmation(context),
      sources,
      snapshotAt: snapshotMeta?.generatedAt || null,
      evidenceCount: evidence.length,
      warnings: [],
    };
  }

  const ruleInference = inferStructuredRuleAnswer(context, sources, snapshotMeta, evidence.length);
  if (ruleInference) return ruleInference;

  const analogousRuling = usableRulings.find((item) => isStrongAnalogousEvidence(item, context));
  if (analogousRuling) {
    const title = summarizeRulingConclusion(analogousRuling.conclusion, "analogous", `${context.question} ${analogousRuling.question || analogousRuling.title || ""}`);
    return {
      schemaVersion: 1,
      mode: "inferred",
      verdictTitle: title,
      verdict: `没有命中完全同场面的问答。可作为类推依据的资料结论是：${buildReadableRulingBody(analogousRuling.conclusion, title, "analogous", context)}`,
      rulingBasis: "找到相似问答资料",
      confidence: buildEvidenceConfidence(context, evidence, "inferred"),
      steps: [
        "先确认题目与相似问答的共通结构：触发事件、适用时点、效果处理期间、对象或适用范围。",
        "再核对差异点是否会改变裁定；差异未排除前不能标记为已确认裁定。",
        ...buildRulingSteps(context, analogousRuling, title).slice(0, 3),
      ],
      needsConfirmation: buildNeedsConfirmation(context, false, analogousRuling),
      sources,
      snapshotAt: snapshotMeta?.generatedAt || null,
      evidenceCount: evidence.length,
      warnings: [],
    };
  }

  if (mismatchedRuling) {
    return buildMismatchedEvidenceAnswer(context, mismatchedRuling, sources, snapshotMeta, evidence.length);
  }

  return {
    schemaVersion: 1,
    mode: "unknown",
    verdictTitle: "只找到相关卡片文本",
    rulingBasis: "缺少直接问答资料",
    verdict:
      "后端识别到了相关卡片和效果文本，但没有命中能直接回答这个场面的 Q&A 或 FAQ。不能把效果文本直接当作确定裁定。",
    confidence: buildEvidenceConfidence(context, evidence, "unknown"),
    steps: [
      "先核对题目里的俗称对应哪张卡，以及效果编号、所在区域、控制者和连锁顺序。",
      "再查该卡相关 Q&A、FAQ 或规则条目。",
      "如果需要模型/规则推理，回答必须标记为推定，不能显示为已确认裁定。",
    ],
    needsConfirmation: buildNeedsConfirmation(context, true),
    sources,
    snapshotAt: snapshotMeta?.generatedAt || null,
    evidenceCount: evidence.length,
    warnings: [],
  };
}

function buildMismatchedEvidenceAnswer(context, mismatchedRuling, sources, snapshotMeta, evidenceCount) {
  if (mismatchedRuling.mismatchReason === "answer-target") {
    return {
      schemaVersion: 1,
      mode: "unknown",
      verdictTitle: "命中的资料没有回答被问的效果",
      rulingBasis: "证据目标不匹配",
      verdict:
        "当前命中的资料回答的是另一项操作或处理，例如能否除外、破坏、回卡组等；但题目问的是指定卡片的效果能否发动。为保证正确性，不能把该资料直接当成答案。",
      confidence: buildEvidenceConfidence(context, [mismatchedRuling], "unknown"),
      steps: [
        "先确定真正被问的是哪张卡、哪个编号的效果，以及它在什么区域发动。",
        "再确认触发事件是否发生：例如是否是“表侧加入额外卡组”“特殊召唤成功”“送去墓地”等。",
        "只用回答同一被问效果能否发动的 Q&A/FAQ，或能覆盖该触发结构的规则资料下结论。",
      ],
      needsConfirmation: [
        "当前命中的资料没有回答被问效果本身，不能显示为已确认裁定。",
        ...buildNeedsConfirmation(context, true).filter((item) => !/当前没有命中直接/.test(item)).slice(0, 4),
      ],
      sources,
      snapshotAt: snapshotMeta?.generatedAt || null,
      evidenceCount,
      warnings: [],
    };
  }

  return {
    schemaVersion: 1,
    mode: "unknown",
    verdictTitle: "命中的资料没有回答处理问题",
    rulingBasis: "证据类型不匹配",
    verdict:
      "题目是在问效果处理结果，但当前命中的资料主要是发动条件或卡片文本，不能用它来回答会回卡组、留场、除外或回场等处理。",
    confidence: buildEvidenceConfidence(context, [mismatchedRuling], "unknown"),
    steps: [
      "先补全参与处理的所有卡，尤其是题目里提到的场地、永续、装备或适用中的效果。",
      "再确认原效果正在处理什么，以及被处理的卡在处理时是否仍在原位置。",
      "只有命中同处理结构的 Q&A/FAQ 或规则模块后，才给具体处理结论。",
    ],
    needsConfirmation: buildNeedsConfirmation(context, true),
    sources,
    snapshotAt: snapshotMeta?.generatedAt || null,
    evidenceCount,
    warnings: [],
  };
}

function inferPreemptiveRuleAnswer(context, sources, snapshotMeta, evidenceCount) {
  return inferDamageStepEndBattleDestroyedAnswer(context, sources, snapshotMeta, evidenceCount);
}

function inferDamageStepEndBattleDestroyedAnswer(context, sources, snapshotMeta, evidenceCount) {
  const question = normalizeRulingText(context.question);
  if (!asksToProtectBattleDestroyedMonsterAtEndOfDamageStep(question)) return null;

  const protector = context.detectedCards.find((card) => hasTemporaryBanishText(card.effectText || "") || /完美世界|卡通世界|トゥーン・ワールド|Perfect Toon World/i.test(cardAliases(card).join(" ")));
  if (!protector && !/(完美世界|卡通世界|トゥーン|Toon)/i.test(question)) return null;

  const protectorName = formatRulingCardName(protector) || "「完美世界 卡通世界」";
  const includesTyrantDestroyedQuestion = asksTyrantDragonBattleDestroyedQuestion(question);
  const tyrantVerdict = includesTyrantDestroyedQuestion
    ? "另一方面，如果被战斗破坏的是「青眼暴君龙」自身，伤害步骤结束时它也已经送去墓地；它的“这张卡进行战斗的伤害步骤结束时”效果可以在墓地发动，以自己墓地1张陷阱卡为对象并盖放。"
    : "";
  return {
    schemaVersion: 1,
    mode: "inferred",
    verdictTitle: includesTyrantDestroyedQuestion
      ? "卡通怪兽已送墓；青眼暴君龙可在墓地发动"
      : "伤害步骤结束时已送墓，不能用完美世界除外",
    verdict:
      `伤害步骤结束时，被战斗破坏确定的卡通怪兽已经按战斗破坏送去墓地，不再是自己场上的卡通怪兽。因此不能用${protectorName}的临时除外效果把那只卡通怪兽除外，卡通怪兽仍然留在墓地。${tyrantVerdict ? ` ${tyrantVerdict}` : ""}`,
    rulingBasis: "伤害步骤规则 + 效果文本推理",
    confidence: buildEvidenceConfidence(context, context.evidence || [], "inferred"),
    steps: [
      "先处理战斗破坏：到伤害步骤结束时，被战斗破坏确定的怪兽会送去墓地。",
      `${protectorName}③要求在其他卡效果适用之际，把自己场上1只卡通怪兽除外到那个效果处理后。`,
      "题目中的盖放墓地陷阱卡效果在伤害步骤结束阶段发动/适用时，那只被战破的卡通怪兽已经不在场上。",
      "因此不能适用该临时除外效果来避免这次战斗破坏；该卡通怪兽仍按战斗破坏送去墓地。",
      ...(includesTyrantDestroyedQuestion
        ? ["若「青眼暴君龙」自身被战斗破坏，到了伤害步骤结束时它已经在墓地；其进行过战斗的效果可以从墓地发动。"]
        : []),
    ],
    needsConfirmation: [
      ...new Set([
        ...(includesTyrantDestroyedQuestion ? [] : buildMultiQuestionNeeds(context.question)),
        ...(includesTyrantDestroyedQuestion ? [] : ["如果还要确认「青眼暴君龙」自身被战斗破坏时能否发动、在哪里发动，需要把该问题单独拆开，并以该卡官方 FAQ/规则条目核对。"]),
        ...buildNeedsConfirmation(context, false)
          .filter((item) => !/当前没有命中直接/.test(item))
          .filter((item) => !(includesTyrantDestroyedQuestion && /多个独立问题/.test(item)))
          .slice(0, 3),
      ]),
    ],
    sources: collectCardTextSources(context.detectedCards, sources),
    subAnswers: buildDamageStepEndBattleDestroyedSubAnswers(question, protectorName, includesTyrantDestroyedQuestion),
    snapshotAt: snapshotMeta?.generatedAt || null,
    evidenceCount,
    warnings: [],
    modelUsed: false,
  };
}

function buildDamageStepEndBattleDestroyedSubAnswers(question, protectorName, includesTyrantDestroyedQuestion) {
  const answers = [
    {
      question: "能用完美世界 卡通世界的效果除外该卡通怪兽吗？",
      verdict: "不能适用",
      reasoning: `伤害步骤结束时，被战斗破坏确定的卡通怪兽已经送去墓地，不再是自己场上的卡通怪兽；${protectorName}③要求除外自己场上的1只卡通怪兽，因此条件不满足。`,
      source: "[推理，需确认]",
    },
    {
      question: "卡通怪兽还会被战斗破坏送去墓地吗？",
      verdict: "已经按战斗破坏送去墓地",
      reasoning: "题目时点是伤害步骤结束时发动/适用其他效果；到这个时点，被战斗破坏确定的怪兽已经完成送去墓地的处理。",
      source: "[推理，需确认]",
    },
  ];

  if (includesTyrantDestroyedQuestion || /青眼暴君龙|青眼暴君龍|暴君龙|暴君龍|青眼のタイラント・ドラゴン|Blue-Eyes Tyrant Dragon/iu.test(question)) {
    answers.push(
      {
        question: "如果青眼暴君龙被战斗破坏，这个效果是在墓地发动还是在场上发动？",
        verdict: "在墓地发动",
        reasoning: "「青眼暴君龙」自身被战斗破坏的场合，到了伤害步骤结束时它已经送去墓地；其“这张卡进行战斗的伤害步骤结束时”效果可以从墓地发动。",
        source: "[推理，需确认]",
      },
      {
        question: "这个时候青眼暴君龙已经送去墓地了吗？",
        verdict: "已经送去墓地",
        reasoning: "与其他被战斗破坏确定的怪兽相同，伤害步骤结束时进行发动判断时，战斗破坏送去墓地的处理已经完成。",
        source: "[推理，需确认]",
      }
    );
  }

  return answers;
}

function asksToProtectBattleDestroyedMonsterAtEndOfDamageStep(value) {
  const text = normalizeRulingText(value);
  return /(伤害步骤结束|伤害阶段结束|伤害步结束|ダメージステップ終了|end of the Damage Step)/iu.test(text) &&
    /(战破|战斗破坏|被战斗破坏|戦闘で破壊|destroyed by battle)/iu.test(text) &&
    /(卡通怪兽|卡通怪|トゥーンモンスター|Toon monster|完美世界|卡通世界|トゥーン・ワールド|Perfect Toon World)/iu.test(text) &&
    /(除外|保护|避免|还会被|送墓|送去墓地|墓地)/iu.test(text);
}

function asksTyrantDragonBattleDestroyedQuestion(value) {
  const text = normalizeRulingText(value);
  return /(青眼暴君龙|青眼暴君龍|青眼のタイラント・ドラゴン|Blue-Eyes Tyrant Dragon|暴君龙|暴君龍)/iu.test(text) &&
    /(被战破|被战斗破坏|戦闘で破壊|destroyed by battle)/iu.test(text) &&
    /(墓地发动|墓地発動|在墓地|在场上|场上发动|哪里发动|送墓|已经送墓|送去墓地|sent to the GY|activate.*GY)/iu.test(text);
}

function inferStructuredRuleAnswer(context, sources, snapshotMeta, evidenceCount) {
  const providedCardInference = inferProvidedCardRuleAnswer(context, sources, snapshotMeta, evidenceCount);
  if (providedCardInference) return providedCardInference;

  const intent = detectQuestionIntent(context.question);
  if (intent !== "handling") return null;

  const protector = context.detectedCards.find((card) => hasTemporaryBanishText(card.effectText || ""));
  const resolver = context.detectedCards.find((card) => card !== protector && hasDeckReturnText(`${card.effectText || ""} ${card.name || ""} ${card.matched || ""}`));
  const otherEffect = resolver || context.detectedCards.find((card) => card !== protector);
  if (!protector || !otherEffect) return null;

  const title = resolver
    ? "可以适用临时除外效果，怪兽不回卡组"
    : hasPendingDestructionText(context.question)
      ? "可以适用临时除外效果，怪兽不按原预定破坏处理"
      : "可以适用临时除外效果";
  const ruleRuling = { steps: [] };
  return {
    schemaVersion: 1,
    mode: "inferred",
    verdictTitle: title,
    verdict: buildReadableRulingBody("", title, "analogous", context),
    rulingBasis: "效果文本 + 规则推理",
    confidence: buildEvidenceConfidence(context, context.evidence || [], "inferred"),
    steps: buildRulingSteps(context, ruleRuling, title),
    needsConfirmation: [
      "这是按已识别卡片效果文本和处理时点作出的规则推理，不是数据库原题；仍建议核对官方 Q&A。",
      ...buildNeedsConfirmation(context, false).filter((item) => !/当前没有命中直接/.test(item)).slice(0, 3),
    ],
    sources: collectCardTextSources(context.detectedCards, sources),
    snapshotAt: snapshotMeta?.generatedAt || null,
    evidenceCount,
    warnings: [],
    modelUsed: false,
  };
}

function inferProvidedCardRuleAnswer(context, sources, snapshotMeta, evidenceCount) {
  const providedCards = context.detectedCards.filter((card) => card.provisional || card.resolvedBy === "user-provided-card-text");
  if (!providedCards.length) return null;

  const text = normalizeRulingText(context.question);
  const card = providedCards.find((item) => hasActivationAndEffectNoNegateText(item.effectText || ""));
  if (!card) return null;

  const cardText = normalizeRulingText(card.effectText || "");
  const hasFiveFaceUpCondition = /(表侧表示卡\s*5\s*张以上|表側表示カードが\s*5\s*枚以上|face-up cards?.{0,12}5 or more)/iu.test(`${text} ${cardText}`);
  const asksCountChange = /(处理时|处理过程中|后续|结算时|適用|解決|resolve).{0,24}(不足\s*5|少于\s*5|不满\s*5|不够\s*5|4\s*张|减少|变少|变成\s*4|less than 5|fewer than 5)/iu.test(text) ||
    /(不足\s*5|少于\s*5|不满\s*5|不够\s*5|4\s*张|减少|变少|变成\s*4|less than 5|fewer than 5).{0,24}(还|仍|继续|会不会|是否).{0,24}(无效|無効|negate)/iu.test(text);
  const asksRewrite = /(改写|改成|改为|改變|改变为|变成.*效果|rewrite|change.*effect|effect.*becomes|黑玛丽|暗黑界龙神王|救祓|エクソシスター|グラファ)/iu.test(text);
  const hasDestroyActivationCondition = /(要让场上的卡破坏的怪兽的效果|场上的卡破坏的怪兽效果|フィールドのカードを破壊するモンスター効果|monster effect.{0,24}destroy.{0,24}card.{0,24}field)/iu.test(`${text} ${cardText}`);
  const asksActivationNegateDestroy = /(发动(?:被)?无效.{0,12}破坏|无效.{0,12}发动.{0,12}破坏|発動を無効.{0,12}破壊|negate.{0,24}activation.{0,24}destroy|鲜花女男爵|鲜花|バロネス|Baronne|神之宣告|神の宣告)/iu.test(text);

  if (hasFiveFaceUpCondition && asksCountChange) {
    return buildProvidedCardInferenceAnswer(context, sources, snapshotMeta, evidenceCount, {
      title: "发动时满足5张即可，后续减少不影响已适用保护",
      verdict:
        `按当前文本预览分析：如果发动${formatRulingCardName(card)}时对方场上有5张以上表侧表示卡，这次发动取得“发动和效果不会被无效化”的保护。之后效果处理中对方表侧表示卡减少到不足5张，也不会倒回去取消这次已经适用的保护。`,
      steps: [
        "先检查发动这一刻是否满足“对方场上有表侧表示卡5张以上存在”。",
        "满足时，“这张卡的发动和效果不会被无效化”适用于这次发动及这次效果处理。",
        "后续处理时场上数量变化，不会重新判断并失去这次已经取得的发动/效果不被无效化保护。",
      ],
    });
  }

  if (asksRewrite) {
    return buildProvidedCardInferenceAnswer(context, sources, snapshotMeta, evidenceCount, {
      title: "不被无效化不等于不能被改写效果",
      verdict:
        `按当前文本预览分析：${formatRulingCardName(card)}写的是“发动和效果不会被无效化”。这只阻止发动或效果被无效，不等于免疫“把效果改成其他处理”的效果。若对方的效果文本是改写/变更效果而不是无效化，仍可能适用。`,
      steps: [
        "先把“无效化”和“改写/变更效果”分开判断。",
        "该文本只保护发动和效果不被无效化，没有写“不会被改写”“不会受其他效果影响”。",
        "因此改写效果类资料需要按该改写效果自身的适用条件另行判断。",
      ],
    });
  }

  if (hasDestroyActivationCondition && asksActivationNegateDestroy) {
    return buildProvidedCardInferenceAnswer(context, sources, snapshotMeta, evidenceCount, {
      title: "无效发动并破坏不满足破坏场上卡的条件",
      verdict:
        `按当前文本预览分析：若对方发动的是“把魔法/陷阱卡的发动无效并破坏”的怪兽效果，被无效发动的那张魔法/陷阱通常不视为从场上被破坏。因此它不满足${formatRulingCardName(card)}中“要让场上的卡破坏的怪兽效果由对方发动时”这一发动条件。`,
      steps: [
        "先确认对方怪兽效果要破坏的对象是否是“场上的卡”。",
        "魔法/陷阱的发动被无效并破坏时，那张卡不按“在场上被破坏”处理。",
        "所以只有该怪兽效果还会破坏其他真正处于场上的卡时，才需要再判断是否满足这条发动条件。",
      ],
    });
  }

  return null;
}

function buildProvidedCardInferenceAnswer(context, sources, snapshotMeta, evidenceCount, inference) {
  return {
    schemaVersion: 1,
    mode: "inferred",
    verdictTitle: inference.title,
    verdict: inference.verdict,
    rulingBasis: "未发售卡文本 + 规则推理",
    confidence: buildEvidenceConfidence(context, context.evidence || [], "inferred"),
    steps: inference.steps,
    needsConfirmation: [
      "这是根据用户提供的新卡文本做的预览分析，不是已确认裁定。",
      "发售后若官方数据库、FAQ 或事务局回答与这里不同，应以发售后的官方资料为准。",
      ...buildNeedsConfirmation(context, false).filter((item) => !/可能尚未发售|当前没有命中直接/.test(item)).slice(0, 3),
    ],
    sources: collectCardTextSources(context.detectedCards, sources),
    snapshotAt: snapshotMeta?.generatedAt || null,
    evidenceCount,
    warnings: [],
    modelUsed: false,
  };
}

function hasActivationAndEffectNoNegateText(value) {
  const text = normalizeRulingText(value);
  return /(发动和效果不会被无效化|發動和效果不會被無效化|発動と効果は無効化されない|activation and effect cannot be negated)/iu.test(text);
}

function isStrongAnalogousEvidence(item, context) {
  if (!item || item.matchKind !== "analogous") return false;
  const intent = detectQuestionIntent(context.question);
  if (intent === "handling" && (item.matchedCardCount || 0) < Math.min(2, context.detectedCards.length)) return false;
  if (intent === "handling" && scoreHandlingOverlap(context.question, `${item.question || ""} ${item.conclusion || ""} ${(item.keywords || []).join(" ")}`) < 2) return false;
  return (item.matchScore || 0) >= 45;
}

function collectCardTextSources(cards, fallbackSources) {
  const cardSources = cards
    .filter((card) => card.provisional || card.sourceUrl || card.ygoResourcesUrl)
    .map((card) => ({
      label: `${card.name || card.cnName || card.jaName || "卡片"} 的效果文本`,
      detail: card.provisional ? "用户输入文本" : card.sourceUrl || card.ygoResourcesUrl,
    }));
  return cardSources.length ? dedupeBy(cardSources, (source) => `${source.label}:${source.detail}`) : fallbackSources;
}

export function mergeModelAnswer(modelAnswer, programAnswer) {
  const explanationText = cleanText(modelAnswer?.explanationText);
  const attemptedOverride = ["status", "verdict", "evidenceIds", "verdictTitle", "steps", "subAnswers", "conditionalAnswer"]
    .some((field) => modelAnswer?.[field] !== undefined);
  return {
    ...programAnswer,
    explanationText,
    warnings: [...new Set([
      ...(programAnswer?.warnings || []),
      ...(attemptedOverride ? ["model_status_or_verdict_ignored"] : []),
    ])],
    modelUsed: Boolean(explanationText),
    modelProvider: modelAnswer?.provider || null,
    modelName: modelAnswer?.model || null,
  };
}

function retrieveEvidence(question, detectedCards, detectedTopics, snapshot, questionTypes = []) {
  if (!detectedCards.length) return [];

  const uniqueCards = mergeCards(detectedCards);

  const textMatches = uniqueCards
    .filter((card) => card.effectText)
    .map((card) => ({
      id: `card-effect-${card.id || card.name}`,
      recordType: "card-text",
      title: `${card.name} 的效果文本`,
      status: card.provisional ? "provisional" : "confirmed",
      cards: [card.name],
      keywords: [],
      conclusion: card.effectText,
      steps: [
        card.provisional
          ? "这是用户输入的卡片文本。未发售或未同步时只能用于预览推理，发售后以官方数据库和 FAQ 为准。"
          : "这是同步到的卡片效果文本。若问题涉及具体裁定处理，仍应继续核对 Q&A 或规则条目。",
      ],
      sources: card.provisional
        ? [{ label: "用户提供的卡片文本", detail: card.name || "未命名卡" }]
        : card.sourceUrl
          ? [{ label: "YGOResources Card data", detail: card.sourceUrl }]
          : [],
      updatedAt: card.updatedAt || "",
      score: 6,
    }));

  return rankEvidenceRecords([...snapshot.records, ...textMatches], question, uniqueCards, detectedTopics, questionTypes)
    .sort((a, b) => b.score - a.score)
    .slice(0, 16);
}

function rankEvidenceRecords(records, question, detectedCards, detectedTopics, questionTypes = []) {
  if (!detectedCards.length) return [];

  const cardKeys = new Set(
    detectedCards.flatMap((card) => [card.id, card.passcode, card.liveId, card.name, card.cnName, card.jaName, card.enName, card.matched, ...(card.aliases || [])].filter(Boolean).map(normalizeKey))
  );
  const searchTerms = buildSearchTerms(detectedCards, questionTypes);
  const tokens = [...new Set([...tokenize(question), ...searchTerms.map(normalizeKey).filter((item) => item.length >= 2)])];

  return dedupeBy(
    records
      .map((record) => {
        const score = scoreRecord(record, cardKeys, detectedTopics, tokens, questionTypes);
        return score > 0 ? { ...record, score, ...classifyEvidenceMatch(record, question, detectedCards, tokens, questionTypes) } : null;
      })
      .filter(Boolean),
    (item) => item.id || `${item.title}:${item.conclusion}`
  ).sort((a, b) => b.score - a.score);
}

function classifyEvidenceMatch(record, question, detectedCards, tokens, questionTypes = []) {
  const questionIntent = detectQuestionIntent(question);
  if (!isRulingEvidence(record)) {
    return { matchKind: record.recordType === "card-text" ? "card-text" : "support", matchScore: 0, matchedCardCount: 0, questionIntent, intentMismatch: false };
  }

  const questionKey = normalizeKey(question);
  const evidenceQuestion = record.question || record.questionText || record.title || "";
  const evidenceKey = normalizeKey(
    `${evidenceQuestion} ${record.conclusion || ""} ${(record.keywords || []).join(" ")} ${(record.cards || []).join(" ")}`
  );
  const similarity = questionKey && evidenceKey ? scoreTextSimilarity(questionKey, evidenceKey) : 0;
  const tokenHits = tokens.filter((token) => token.length >= 2 && evidenceKey.includes(token)).length;
  const tokenRatio = tokens.length ? tokenHits / tokens.length : 0;
  const matchedCardCount = countEvidenceMatchedCards(record, detectedCards);
  const cardRatio = detectedCards.length ? matchedCardCount / detectedCards.length : 0;
  const handlingOverlap = scoreHandlingOverlap(question, `${evidenceQuestion} ${record.conclusion || ""} ${(record.keywords || []).join(" ")}`);
  const evidenceTags = handlingTags(`${evidenceQuestion} ${record.conclusion || ""} ${(record.keywords || []).join(" ")}`);
  const targetMismatch = isAnswerTargetMismatch(question, `${evidenceQuestion} ${record.conclusion || ""} ${(record.keywords || []).join(" ")}`);
  const intentMismatch = isIntentMismatch(questionIntent, evidenceTags, handlingOverlap) || targetMismatch;
  const typeOverlap = scoreQuestionTypeOverlap(questionTypes, `${evidenceQuestion} ${record.conclusion || ""} ${(record.keywords || []).join(" ")}`);
  const exactEnough =
    matchedCardCount > 0 &&
    !intentMismatch &&
      (similarity >= 0.58 ||
      (tokenHits >= 5 && tokenRatio >= 0.28) ||
      (cardRatio >= 0.8 && tokenHits >= 3 && tokenRatio >= 0.18) ||
      (cardRatio >= 0.8 && handlingOverlap >= 2 && typeOverlap >= Math.min(1, questionTypes.length)));

  return {
    matchKind: intentMismatch ? "support" : exactEnough ? "direct" : "analogous",
    matchScore: Math.round(Math.max(similarity, tokenRatio) * 100),
    matchedCardCount,
    questionIntent,
    questionTypes,
    typeOverlap,
    intentMismatch,
    mismatchReason: targetMismatch ? "answer-target" : intentMismatch ? "intent" : "",
  };
}

function classifyQuestion(question) {
  const text = normalizeRulingText(question);
  const patterns = {
    timing: /时机|时点|场合|结束时|之后|以前|之前|前|后|阶段|タイミング|場合|終了時/u,
    chain: /连锁|连锁状态|对应|优先权|不能对应|无法连锁|チェーン|対応/u,
    condition: /条件|需要|必须|才能|发动条件|適用条件|発動条件/u,
    covenant: /誓约|自身效果|本身效果|自身の効果|このカードの効果を発動するため|特殊召唤条件/u,
    multiPart: /[①②③④⑤⑥⑦⑧⑨]|还是|以及|另外|然后|那么|同时|并且|？.*？|\?.*\?/u,
    substitute: /替代|代替|当作|视为|扱う|みなす/u,
  };

  return Object.entries(patterns)
    .filter(([, regex]) => regex.test(text))
    .map(([type]) => type);
}

function buildSearchTerms(cards, questionTypes) {
  const terms = cards.flatMap((card) => [card.name, card.cnName, card.jaName, card.enName, card.matched, ...(card.aliases || [])].filter(Boolean));

  if (questionTypes.includes("chain")) terms.push("连锁封锁", "不能对应", "无法连锁", "不能连锁", "チェーンできない", "発動できない");
  if (questionTypes.includes("covenant")) terms.push("誓约", "自身效果", "本身效果", "自身の効果", "特殊召唤条件", "このカードの効果を発動するため");
  if (questionTypes.includes("timing")) terms.push("发动时机", "时点", "场合", "伤害步骤结束时", "処理後", "場合", "タイミング");
  if (questionTypes.includes("condition")) terms.push("发动条件", "适用条件", "必须", "才能", "発動条件", "適用条件");
  if (questionTypes.includes("substitute")) terms.push("替代", "代替", "当作", "视为", "扱う", "みなす");

  return [...new Set(terms)].filter(Boolean);
}

function extractSubQuestions(question) {
  const normalized = normalizeRulingText(question)
    .replace(/([？?])/g, "$1\n")
    .replace(/(吗|呢|么|嘛)(?=\s|$)/g, "$1\n");
  const parts = normalized
    .split(/\n+/)
    .map((part) => cleanText(part).replace(/^[，。；;、:：\s]+/, ""))
    .filter(Boolean)
    .filter((part) => isQuestionLike(part));

  const unique = dedupeBy(parts, normalizeKey).slice(0, 8);
  if (!unique.length) return [{ id: 1, question: normalizeRulingText(question), keyword: inferSubQuestionKeyword(question) }];
  return unique.map((part, index) => ({
    id: index + 1,
    question: part,
    keyword: inferSubQuestionKeyword(part),
  }));
}

function isQuestionLike(value) {
  return /(吗|呢|么|嘛|？|\?|能否|能不能|可以|可否|是否|会不会|怎么处理|哪里发动|在.*发动|已经.*吗|还是|如何)/u.test(value);
}

function inferSubQuestionKeyword(value) {
  const text = normalizeRulingText(value);
  const keywords = ["发动", "除外", "送墓", "送去墓地", "回卡组", "破坏", "连锁", "誓约", "时机", "墓地", "场上", "伤害步骤"];
  return keywords.find((keyword) => text.includes(keyword)) || tokenize(text)[0] || "";
}

function scoreQuestionTypeOverlap(questionTypes, evidenceText) {
  if (!questionTypes.length) return 0;
  const evidenceTypes = classifyQuestion(evidenceText);
  return questionTypes.filter((type) => evidenceTypes.includes(type)).length;
}

function detectQuestionIntent(question) {
  const text = normalizeRulingText(question);
  const tags = handlingTags(text);
  if (asksSpecificEffectActivation(text)) return "activation";
  if (/(怎么处理|如何处理|处理时|处理是|处理后|后续|结算|怎么结算|留场|场地躲|场地换|回卡组|回到卡组|洗回卡组|破坏|除外|伤害)/i.test(text)) {
    return "handling";
  }
  if (/(能否发动|能不能发动|可以发动|可否发动|发动吗|発動できますか|発動できる)/i.test(text)) return "activation";
  if (tags.has("battle")) return "battle";
  if (tags.has("control")) return "control";
  return "general";
}

function isIntentMismatch(questionIntent, evidenceTags, handlingOverlap) {
  if (questionIntent === "handling") {
    const handlingEvidenceTags = ["deck-return", "temporary-banish", "banish", "field-change", "destruction", "battle", "control"];
    const hasHandlingEvidence = handlingEvidenceTags.some((tag) => evidenceTags.has(tag));
    return !hasHandlingEvidence || handlingOverlap === 0;
  }
  if (questionIntent === "activation") return false;
  return false;
}

function isAnswerTargetMismatch(question, evidenceText) {
  const questionText = normalizeRulingText(question);
  const evidence = normalizeRulingText(evidenceText);
  if (!asksSpecificEffectActivation(questionText)) return false;
  if (asksSpecificEffectActivation(evidence)) return false;

  const evidenceTags = handlingTags(evidence);
  const answersOtherOperation = ["banish", "destruction", "deck-return", "field-change", "control"].some((tag) => evidenceTags.has(tag));
  if (!answersOtherOperation) return false;

  const asksOwnEffect = /(自己(?:的)?[①②③④⑤⑥⑦⑧⑨0-9一二三四五六七八九]+(?:效果|効果)?|[①②③④⑤⑥⑦⑧⑨]\s*(?:效果|効果).{0,16}(能否|能不能|可以|可否|是否|会不会).{0,8}(发动|發動|発動))/iu.test(questionText);
  return asksOwnEffect || /(能否|能不能|可以|可否|是否|会不会).{0,16}(发动|發動|発動)/iu.test(questionText);
}

function asksSpecificEffectActivation(value) {
  const text = normalizeRulingText(value);
  return /(能否|能不能|可以|可否|是否|会不会|能).{0,18}(发动|發動|発動).{0,18}(自己(?:的)?|自身(?:的)?|这张卡(?:的)?|此卡(?:的)?|[①②③④⑤⑥⑦⑧⑨0-9一二三四五六七八九]+(?:效果|効果)?)/iu.test(text) ||
    /[①②③④⑤⑥⑦⑧⑨]\s*(?:效果|効果).{0,18}(能否|能不能|可以|可否|是否|会不会|能).{0,8}(发动|發動|発動)/iu.test(text) ||
    /(発動できますか|発動できるか|can.{0,12}activate.{0,12}(?:its|this card|that card).{0,12}effect)/iu.test(text);
}

function isRulingEvidence(record) {
  return record?.recordType === "qa" || record?.recordType === "card-faq";
}

function countEvidenceMatchedCards(record, detectedCards) {
  const evidenceKey = normalizeKey(`${(record.cards || []).join(" ")} ${record.question || record.questionText || ""} ${record.title || ""} ${record.conclusion || ""}`);
  let count = 0;
  for (const card of detectedCards) {
    if (cardAliases(card).some((alias) => {
      const key = normalizeKey(alias);
      return key.length >= 2 && evidenceKey.includes(key);
    })) {
      count += 1;
    }
  }
  return count;
}

function scoreHandlingOverlap(question, evidenceText) {
  const left = handlingTags(question);
  const right = handlingTags(evidenceText);
  let count = 0;
  for (const tag of left) {
    if (right.has(tag)) count += 1;
  }
  return count;
}

function handlingTags(value) {
  const text = normalizeRulingText(value);
  const tags = new Set();
  const checks = [
    ["negate", /(无效|康|無効|negate)/i],
    ["deck-return", /(回卡组|回到卡组|返回卡组|洗回卡组|デッキ|戻|戻す|戻し|shuffle)/i],
    ["temporary-banish", /(除外到.*处理后|处理后.*回|処理後.*戻|除外.*戻|temporar(?:y|ily).*banish|banish.*until)/i],
    ["banish", /(除外|banish)/i],
    ["field-change", /(场地换|回到场|回场|特殊召唤|フィールド|特殊召喚)/i],
    ["destruction", /(破坏|破壊|destroy)/i],
    ["battle", /(战斗|戦闘|伤害|ダメージ|attack|battle)/i],
    ["activation", /(发动|発動|activate)/i],
    ["control", /(控制权|コントロール|control)/i],
  ];
  for (const [tag, pattern] of checks) {
    if (pattern.test(text)) tags.add(tag);
  }
  return tags;
}

function scoreRecord(record, cardKeys, detectedTopics, tokens, questionTypes = []) {
  const recordCardKeys = new Set((record.cards || []).map(normalizeKey));
  const hasCardMatch = [...recordCardKeys].some((key) => cardKeys.has(key));

  const keywordText = [...(record.keywords || []), record.title || ""].map(normalizeKey).join(" ");
  let topicHits = 0;
  for (const topic of detectedTopics) {
    if (topic.keywords.some((keyword) => keywordText.includes(normalizeKey(keyword)))) topicHits += 1;
  }

  const haystack = normalizeKey(`${record.title || ""} ${record.conclusion || ""} ${(record.keywords || []).join(" ")}`);
  const tokenHits = tokens.filter((token) => token.length >= 2 && haystack.includes(token)).length;
  const typeHits = scoreQuestionTypeOverlap(questionTypes, `${record.title || ""} ${record.question || ""} ${record.conclusion || ""} ${(record.keywords || []).join(" ")}`);

  if (!hasCardMatch) {
    if (record.recordType === "rule-doc" || record.recordType === "rule-test") {
      const handlingOverlap = scoreHandlingOverlap(tokens.join(" "), haystack);
      if (topicHits < 1 && tokenHits < 3 && handlingOverlap < 1 && typeHits < 1) return 0;
      return 6 + topicHits * 2 + Math.min(6, tokenHits) + handlingOverlap * 2 + typeHits * 3;
    }
    if (!isRulingEvidence(record)) return 0;
    if (topicHits < 2 && typeHits < 1) return 0;
    if (tokenHits < 4 && typeHits < 2) return 0;
    return 10 + topicHits * 2 + Math.min(8, tokenHits) + typeHits * 4;
  }

  let score = 20;
  if (record.recordType === "qa") score += 10;
  if (record.recordType === "card-faq") score += 8;
  if (record.recordType === "card-text") score += 1;
  if (record.status === "confirmed") score += 3;
  score += topicHits * 2;
  score += Math.min(8, tokenHits);
  score += typeHits * 4;
  return score;
}

function normalizeCards(records) {
  return records
    .map((record) => {
      const name = record.name || record.primaryName || record.cnName || record.jaName || record.enName || record.id;
      const aliases = [
        record.name,
        record.primaryName,
        record.cnName,
        record.jaName,
        record.enName,
        ...(record.aliases || []),
      ].filter(Boolean);
      return {
        ...record,
        name,
        aliases: [...new Set(aliases)],
        released: record.released !== false,
      };
    })
    .filter((record) => record.name);
}

function normalizeRecords(records) {
  return records
    .map((record) => ({
      id: record.id || record.sourceId || `${record.title}:${record.updatedAt}`,
      recordType: record.recordType || inferRecordType(record),
      title: record.title || "未命名资料",
      question: cleanText(record.question || record.questionText || ""),
      status: record.status || "confirmed",
      cards: record.cards || [],
      cardId: record.cardId || "",
      cardIds: Array.isArray(record.cardIds) ? record.cardIds : [],
      keywords: record.keywords || [],
      conclusion: cleanText(record.conclusion || record.answer || record.text || ""),
      steps: record.steps || [],
      questions: record.questions || [],
      sources: record.sources || sourceFromRecord(record),
      updatedAt: record.updatedAt || record.lastModified || "",
    }))
    .filter((record) => record.conclusion);
}

function inferRecordType(record) {
  if (record.recordType === "rule-doc" || record.recordType === "rule-test") return record.recordType;
  if (String(record.id || "").startsWith("ocg-rule:")) return "rule-doc";
  if (String(record.id || "").startsWith("card-text-") || /效果文本/.test(record.title || "")) return "card-text";
  if (String(record.id || "").startsWith("card-faq-") || /FAQ/i.test(record.title || "")) return "card-faq";
  if (String(record.id || "").includes("qa")) return "qa";
  return "note";
}

function detectCards(question, cards) {
  const text = normalizeKey(question);
  const matches = [];
  for (const card of cards) {
    const aliases = [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]
      .filter(Boolean)
      .filter((alias) => normalizeKey(alias).length >= 2)
      .sort((a, b) => normalizeKey(b).length - normalizeKey(a).length);
    const matched = aliases.find((alias) => text.includes(normalizeKey(alias)));
    if (matched) matches.push({ ...card, matched });
  }

  matches.push(...matchLocalAliasHints(question, cards));
  return mergeCards(...matches).sort((a, b) => normalizeKey(b.matched).length - normalizeKey(a.matched).length);
}

function extractUserProvidedCards(question) {
  const raw = String(question || "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!raw) return [];

  const blocks = extractProvidedCardBlocks(raw);
  return blocks
    .map(buildProvidedCardFromBlock)
    .filter(Boolean);
}

function extractProvidedCardBlocks(raw) {
  const blocks = [];
  const marker = raw.match(/(?:新卡效果|卡片文本|效果文本|未发售(?:新卡)?|预览文本)\s*[:：]\s*/u);
  if (marker) blocks.push(raw.slice(marker.index + marker[0].length).trim());

  if (hasStandaloneCardTypeLine(raw) && /[①②③④⑤⑥⑦⑧⑨●]/u.test(raw)) {
    blocks.push(raw);
  }

  return dedupeBy(blocks.filter(Boolean), (block) => normalizeKey(block).slice(0, 120));
}

function buildProvidedCardFromBlock(block) {
  const lines = block
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean);
  const typeIndex = lines.findIndex(isCardTypeLine);
  if (typeIndex < 0) return null;

  const name = findProvidedCardName(lines, typeIndex);
  if (!name) return null;

  const headerAliases = lines
    .slice(0, typeIndex)
    .filter((line) => !isLikelySetCode(line))
    .filter((line) => isLikelyProvidedCardAlias(line));
  const aliases = [
    name,
    ...headerAliases,
    ...extractBracketContents(block),
    ...extractProvidedNameFragments(name),
  ].filter(Boolean);

  return {
    id: "",
    passcode: "",
    name,
    cnName: /[\u3400-\u9fff]/u.test(name) ? name : "",
    jaName: /[\u3040-\u30ff]/u.test(name) ? name : "",
    enName: /[A-Za-z]/u.test(name) && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(name) ? name : "",
    matched: name,
    cardType: lines[typeIndex],
    effectText: cleanText(lines.slice(typeIndex).join("\n")),
    aliases: [...new Set(aliases)],
    released: false,
    provisional: true,
    resolvedBy: "user-provided-card-text",
  };
}

function hasStandaloneCardTypeLine(value) {
  return String(value || "")
    .split(/\r?\n/)
    .some((line) => isCardTypeLine(cleanText(line)));
}

function isCardTypeLine(value) {
  const text = cleanText(value);
  return /^(通常|永续|永続|速攻|装备|装備|场地|フィールド|反击|カウンター)?\s*(魔法|陷阱|罠|Spell|Trap)(卡|カード)?$/iu.test(text) ||
    /^(通常|效果|融合|同调|同步|超量|XYZ|连接|リンク|仪式|灵摆|ペンデュラム).{0,10}(怪兽|モンスター)$/iu.test(text);
}

function findProvidedCardName(lines, typeIndex) {
  for (let index = typeIndex - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (isLikelySetCode(line)) continue;
    if (isLikelyProvidedCardAlias(line)) return line;
  }
  return "";
}

function isLikelyProvidedCardAlias(value) {
  const text = cleanText(value);
  const key = normalizeKey(text);
  if (key.length < 2 || key.length > 48) return false;
  if (/[①②③④⑤⑥⑦⑧⑨●]/u.test(text)) return false;
  if (isCardTypeLine(text) || isLikelySetCode(text)) return false;
  if (/(发动|發動|效果|効果|对方|相手|自己|自分|场上|フィールド|墓地|卡组|デッキ|破坏|破壊|无效|無効)/iu.test(text)) return false;
  return /[\p{L}\p{N}]/u.test(text);
}

function isLikelySetCode(value) {
  return /^[A-Z]{2,}[0-9]{1,4}(?:[- ][A-Z0-9]+)?$/u.test(cleanText(value));
}

function extractProvidedNameFragments(name) {
  const fragments = [];
  const compact = cleanText(name);
  if (compact.includes("-")) fragments.push(...compact.split("-").map((item) => item.trim()).filter((item) => normalizeKey(item).length >= 2));
  if (compact.includes("ー")) fragments.push(...compact.split("ー").map((item) => item.trim()).filter((item) => normalizeKey(item).length >= 2));
  return fragments;
}

function matchLocalAliasHints(question, cards) {
  const text = normalizeKey(question);
  const matches = [];

  for (const hint of localCardAliasHints) {
    const matchedAlias = hint.aliases.find((alias) => text.includes(normalizeKey(alias)));
    if (!matchedAlias) continue;

    const card = findBestCardForCandidates([...hint.candidates, matchedAlias], cards);
    if (card) {
      matches.push({
        ...card,
        matched: matchedAlias,
        resolvedBy: "local-alias",
      });
    }
  }

  return matches;
}

function collectLocalAliasResolutions(question) {
  const text = normalizeKey(question);
  const cards = [];

  for (const hint of localCardAliasHints) {
    const matchedAlias = hint.aliases.find((alias) => text.includes(normalizeKey(alias)));
    if (!matchedAlias) continue;
    cards.push({
      input: matchedAlias,
      candidates: [...new Set([matchedAlias, ...hint.candidates])],
      confidence: "high",
      card: hint.card || null,
    });
  }

  return { cards };
}

function collectQuestionCardCandidates(question) {
  const normalized = normalizeText(question);
  const candidates = [];

  for (const content of extractBracketContents(normalized)) addCandidate(candidates, content, "quoted-name");

  for (const match of normalized.matchAll(/([^\s「『《」』》，。；;:：]{2,30}(?:\s+[^\s「『《」』》，。；;:：]{2,20}){0,2})\s*[」』》]?\s*(?:的|の)\s*[「『《]?[①②③④⑤⑥⑦⑧⑨0-9]/gu)) {
    addCandidate(candidates, match[1], "effect-owner");
  }

  for (const match of normalized.matchAll(/(?:^|[，。；;\n\s])([A-Za-z0-9\u3040-\u30ff\u3400-\u9fff・･☆★－ー\-\s]{2,34}?)(?=把|將|将|对|對|康|无效|無効|发动|發動)/gu)) {
    addCandidate(candidates, match[1], "action-subject");
  }

  for (const match of normalized.matchAll(/(?:有|存在|装备|裝備|适用|適用)([A-Za-z0-9\u3040-\u30ff\u3400-\u9fff・･☆★－ー\-\s]{2,34}?)(?:的|の|效果|効果|在|时|時|，|。|；|;)/gu)) {
    addCandidate(candidates, match[1], "state-card");
  }

  for (const match of normalized.matchAll(/([A-Za-z0-9\u3040-\u30ff\u3400-\u9fff・･☆★－ー\-\s]{2,34}(?:世界|姬|姫|龙|龍|王国|王國|御巫|土像|落胤|小夜|アドラ|ハヤテ|カガリ|ロゼ|レイ))/gu)) {
    addCandidate(candidates, match[1], "card-like-phrase");
  }

  return {
    cards: pruneContainedCardCandidates(dedupeBy(candidates, (item) => normalizeKey(item.input)))
      .sort((left, right) => cardCandidatePriority(right) - cardCandidatePriority(left))
      .slice(0, 8),
  };
}

function pruneContainedCardCandidates(candidates) {
  const sorted = candidates
    .slice()
    .sort((left, right) => cardCandidatePriority(right) - cardCandidatePriority(left));
  const result = [];

  for (const candidate of sorted) {
    const key = normalizeKey(candidate.input);
    if (!key) continue;
    const containedByLonger = result.some((existing) => {
      const existingKey = normalizeKey(existing.input);
      return existingKey.length >= key.length + 2 && existingKey.includes(key);
    });
    if (!containedByLonger) result.push(candidate);
  }

  return result;
}

function extractBracketContents(text) {
  const pairs = [
    ["「", "」"],
    ["『", "』"],
    ["《", "》"],
  ];
  const result = [];

  for (const [open, close] of pairs) {
    let start = text.indexOf(open);
    while (start >= 0) {
      const end = text.indexOf(close, start + open.length);
      if (end < 0) break;
      result.push(text.slice(start + open.length, end));
      start = text.indexOf(open, end + close.length);
    }
  }

  return result;
}

function addCandidate(candidates, value, source) {
  const input = cleanCandidateName(value);
  if (!input || !isLikelyCardNameCandidate(input, source)) return;
  candidates.push({
    input,
    candidates: [input],
    confidence: source === "quoted-name" || source === "effect-owner" ? "high" : "medium",
    source,
  });
}

function cardCandidatePriority(item) {
  const sourceScore = item.source === "quoted-name" ? 100 : item.source === "effect-owner" ? 80 : item.source === "state-card" ? 72 : item.source === "action-subject" ? 68 : 40;
  return sourceScore + Math.min(30, normalizeKey(item.input).length);
}

function cleanCandidateName(value) {
  return normalizeText(value)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[，。；;、]+$/g, "")
    .trim();
}

function isLikelyCardNameCandidate(value, source = "") {
  const text = cleanCandidateName(value);
  const key = normalizeKey(text);
  const minimumLength = source === "quoted-name" ? 2 : 3;
  if (key.length < minimumLength || key.length > 42) return false;
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  if (/[①②③④⑤⑥⑦⑧⑨]/u.test(text)) return false;
  if (/[：:]/u.test(text)) return false;
  if (/^(闪刀姬|閃刀姫|闪刀|閃刀|卡通|トゥーン)$/iu.test(text)) return false;
  if (/(発動|发动|効果|效果|デッキ|墓地|除外|相手|自分|フィールド|モンスター|できますか|できる|できない|このカード)/iu.test(text)) return false;
  return true;
}

function buildPlaceholderCards(resolution) {
  return (resolution?.cards || [])
    .filter((item) => item.card)
    .map((item) => ({
      ...item.card,
      aliases: [...new Set([item.card.name, item.card.cnName, item.card.jaName, item.card.enName, item.input, ...(item.candidates || [])].filter(Boolean))],
      matched: item.input || item.card.name,
      released: true,
      resolvedBy: "local-alias",
      placeholder: true,
    }));
}

function hasHighConfidenceLocalResolution(resolution) {
  return (resolution?.cards || []).some((item) => item.confidence === "high");
}

async function resolveCardsFromBaige(resolution, env) {
  if (!resolution?.cards?.length) return [];
  if (String(env.CARD_RESOLUTION_BAIGE || "true").toLowerCase() === "false") return [];

  const cards = [];
  for (const item of resolution.cards.slice(0, 8)) {
    const candidates = [item.input, ...(item.candidates || [])].filter(Boolean);
    const card = await findBaigeCard(candidates).catch(() => null);
    if (!card) continue;
    cards.push({
      ...card,
      matched: item.input || card.name,
      resolvedBy: "baige-card-search",
      resolutionConfidence: item.confidence,
    });
  }

  return mergeCards(...cards);
}

async function findBaigeCard(candidates) {
  for (const candidate of candidates) {
    const query = cleanCandidateName(candidate);
    if (!isLikelyCardNameCandidate(query) && normalizeKey(query).length < 2) continue;

    const payload = await fetchBaigeSearch(query);
    const cards = collectBaigeCards(payload);
    const card = pickBaigeCard(cards, query);
    if (card) return normalizeBaigeCard(card, query);
  }
  return null;
}

async function fetchBaigeSearch(query) {
  const key = normalizeKey(query);
  const cached = baigeSearchCache.get(key);
  if (cached && Date.now() - cached.loadedAt < 60 * 60 * 1000) return cached.payload;

  const url = new URL(baigeApiBaseUrl);
  url.searchParams.set("search", query);
  const payload = await fetchJson(url.toString(), 10_000);
  baigeSearchCache.set(key, { loadedAt: Date.now(), payload });
  return payload;
}

function collectBaigeCards(payload) {
  const result = [];
  const seen = new Set();

  function visit(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;

    const id = normalizeId(value.id || value.cid || value.cardId || value.password || value.passcode || value.ot);
    const names = collectBaigeNames(value);
    const effectText = extractBaigeEffectText(value);
    if (id && (names.length || effectText)) {
      const key = `${id}:${names[0] || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(value);
      }
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") visit(child);
    }
  }

  visit(payload?.result || payload?.data || payload?.cards || payload);
  return result;
}

function pickBaigeCard(cards, query) {
  if (!cards.length) return null;
  const queryKey = normalizeKey(query);
  let best = null;

  for (const card of cards) {
    const names = collectBaigeNames(card);
    let score = 0;
    for (const name of names) {
      const nameKey = normalizeKey(name);
      if (!nameKey || !queryKey) continue;
      if (nameKey === queryKey) score = Math.max(score, 100);
      else if (nameKey.includes(queryKey) && queryKey.length >= 4) score = Math.max(score, 88);
      else if (queryKey.includes(nameKey) && nameKey.length >= 4) score = Math.max(score, 82);
      else score = Math.max(score, Math.round(diceCoefficient(nameKey, queryKey) * 100));
    }
    if (!best || score > best.score) best = { card, score };
  }

  return best && best.score >= 78 ? best.card : null;
}

function normalizeBaigeCard(card, query) {
  const id = normalizeId(card.id || card.cid || card.cardId || card.password || card.passcode || card.ot);
  const names = collectBaigeNames(card);
  const name = names[0] || query || id;
  const cnName = names.find((item) => /[\u3400-\u9fff]/.test(item)) || name;
  const jaName = names.find((item) => /[\u3040-\u30ff]/.test(item)) || "";
  const enName = names.find((item) => /[A-Za-z]/.test(item) && !/[\u3400-\u9fff\u3040-\u30ff]/.test(item)) || "";

  return {
    id,
    passcode: id,
    name,
    cnName,
    jaName,
    enName,
    cardType: cleanText(card.type || card.cardType || card.race || ""),
    effectText: extractBaigeEffectText(card),
    released: true,
    aliases: [...new Set([name, cnName, jaName, enName, ...names, query].filter(Boolean))],
    sourceUrl: id ? `https://ygocdb.com/card/${id}` : "https://ygocdb.com/",
    updatedAt: new Date().toISOString(),
  };
}

function collectBaigeNames(card) {
  return [
    card.name,
    card.cn_name,
    card.cnName,
    card.sc_name,
    card.zh_name,
    card.ja_name,
    card.jaName,
    card.jp_name,
    card.en_name,
    card.enName,
    card.nwbbs_n,
  ]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function extractBaigeEffectText(card) {
  const direct = [card.desc, card.effect, card.effectText, card.text, card.cn_desc, card.zh_desc, card.sc_desc, card.nwbbs_text].find(
    (value) => typeof value === "string" && value.trim()
  );
  if (direct) return cleanText(direct);

  const texts = [];
  function visit(value, key = "") {
    if (!value) return;
    if (typeof value === "string") {
      if (/desc|effect|text/i.test(key) && value.trim().length > 8) texts.push(cleanText(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  }
  visit(card);
  return texts.sort((a, b) => b.length - a.length)[0] || "";
}

function mergeResolutions(...payloads) {
  const map = new Map();

  for (const payload of payloads) {
    for (const item of payload?.cards || []) {
      const key = normalizeKey(item.input || item.candidates?.[0] || "");
      if (!key) continue;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          input: item.input || "",
          candidates: [...new Set(item.candidates || [])],
          confidence: item.confidence || "low",
          card: item.card || null,
        });
        continue;
      }
      existing.candidates = [...new Set([...existing.candidates, ...(item.candidates || [])])];
      existing.confidence = strongerConfidence(existing.confidence, item.confidence);
      existing.card = existing.card || item.card || null;
    }
  }

  return { cards: [...map.values()] };
}

export async function syncOnDemandData({ detectedCards, snapshot, dataDir = defaultDataDir, env = {} }) {
  const cards = mergeCards(Array.isArray(detectedCards) ? detectedCards : []);
  const candidates = cards.filter((card) => {
    const hasId = collectResolvedCardIds([card]).length > 0;
    const hasRuling = (snapshot?.records || []).some((record) => isRulingEvidence(record) && countEvidenceMatchedCards(record, [card]) > 0);
    return !hasId || !hasRuling;
  });
  if (!candidates.length) return buildSkippedOnDemandSync();

  const cacheKey = `${dataDir}:${candidates.map((card) => normalizeKey(card.matched || card.name)).sort().join("|")}`;
  const cached = onDemandSyncCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < 60 * 60 * 1000) {
    return { ...cached.result, cacheHit: true };
  }
  if (onDemandSyncLocks.has(cacheKey)) return onDemandSyncLocks.get(cacheKey);

  const operation = performOnDemandSync({ candidates, snapshot, dataDir, env })
    .then((result) => {
      onDemandSyncCache.set(cacheKey, { cachedAt: Date.now(), result });
      return result;
    })
    .finally(() => onDemandSyncLocks.delete(cacheKey));
  onDemandSyncLocks.set(cacheKey, operation);
  return operation;
}

async function performOnDemandSync({ candidates, snapshot, dataDir, env }) {
  const attemptedCardNames = candidates.map((card) => card.matched || card.name).filter(Boolean);
  const warnings = [];
  let detail;
  try {
    detail = await resolveCardsFromDetectedCardsDetailed(candidates, snapshot.cards, env);
  } catch (error) {
    return buildOnDemandFailure("live_source_unavailable", attemptedCardNames, error);
  }

  const resolvedCards = mergeCards(
    candidates.filter((card) => collectResolvedCardIds([card]).length > 0),
    detail.cards
  );
  const unresolvedCards = candidates.filter((candidate) => {
    const wanted = normalizeKey(candidate.matched || candidate.name);
    return !resolvedCards.some((card) => cardAliases(card).some((alias) => {
      const key = normalizeKey(alias);
      return key === wanted || key.includes(wanted) || wanted.includes(key);
    }));
  });
  if (!detail.indexAvailable && unresolvedCards.length) {
    return {
      ...buildOnDemandFailure("live_source_unavailable", attemptedCardNames),
      warnings: ["live_source_unavailable", ...detail.warnings],
    };
  }

  let evidence = [];
  try {
    evidence = await loadLiveEvidenceForCards(resolvedCards, env);
  } catch (error) {
    return buildOnDemandFailure("live_source_unavailable", attemptedCardNames, error, detail.cards);
  }

  if (unresolvedCards.length) warnings.push(`on_demand_card_not_found:${unresolvedCards.map((card) => card.matched || card.name).join(",")}`);
  if (!evidence.length) warnings.push("on_demand_no_related_qa");
  let persisted = false;
  if (detail.cards.length || evidence.length) {
    try {
      await persistOnDemandData(dataDir, detail.cards, evidence);
      persisted = true;
      snapshotCache.delete(dataDir);
    } catch (error) {
      warnings.push(`on_demand_persist_failed:${formatError(error)}`);
    }
  }

  return {
    attempted: true,
    cacheHit: false,
    persisted,
    status: evidence.length ? "synced" : unresolvedCards.length ? "card_not_found" : "retrieval_empty",
    cards: detail.cards,
    evidence,
    attemptedCardNames,
    syncedCardIds: collectResolvedCardIds(detail.cards),
    syncedEvidenceIds: evidence.map((record) => record.id).filter(Boolean),
    warnings,
  };
}

function buildSkippedOnDemandSync() {
  return {
    attempted: false,
    cacheHit: false,
    persisted: false,
    status: "not_needed",
    cards: [],
    evidence: [],
    attemptedCardNames: [],
    syncedCardIds: [],
    syncedEvidenceIds: [],
    warnings: [],
  };
}

function buildOnDemandFailure(status, attemptedCardNames, error = null, cards = []) {
  return {
    attempted: true,
    cacheHit: false,
    persisted: false,
    status,
    cards,
    evidence: [],
    attemptedCardNames,
    syncedCardIds: collectResolvedCardIds(cards),
    syncedEvidenceIds: [],
    warnings: [status, ...(error ? [`${status}:${formatError(error)}`] : [])],
  };
}

function summarizeOnDemandSync(result) {
  return {
    attempted: result.attempted,
    cacheHit: result.cacheHit,
    persisted: result.persisted,
    status: result.status,
    attemptedCardNames: result.attemptedCardNames,
    syncedCardIds: result.syncedCardIds,
    syncedEvidenceIds: result.syncedEvidenceIds,
    warnings: result.warnings,
  };
}

async function persistOnDemandData(dataDir, cards, evidence) {
  const [cardsPayload, rulingsPayload] = await Promise.all([
    readJson(join(dataDir, "cards.json"), { schemaVersion: 1, records: [] }),
    readJson(join(dataDir, "rulings.json"), { schemaVersion: 1, records: [] }),
  ]);
  const mergedCards = mergeCards(cardsPayload.records || cardsPayload.cards || [], cards)
    .filter((card) => collectResolvedCardIds([card]).length > 0);
  const rulingMap = new Map();
  for (const record of [...(rulingsPayload.records || rulingsPayload.rulings || []), ...evidence]) {
    if (record?.id) rulingMap.set(String(record.id), record);
  }
  const mergedRulings = [...rulingMap.values()];
  const generatedAt = new Date().toISOString();
  const aliasIndex = buildCardAliasIndex(mergedCards);
  const qaIndex = buildQaIndex(mergedRulings, mergedCards);
  await Promise.all([
    writeJsonData(join(dataDir, "cards.json"), { schemaVersion: 1, generatedAt, records: mergedCards }),
    writeJsonData(join(dataDir, "cards-lite.json"), {
      schemaVersion: 1,
      generatedAt,
      records: mergedCards.map((card) => ({
        id: card.id,
        name: card.name,
        cnName: card.cnName,
        jaName: card.jaName,
        enName: card.enName,
        aliases: card.aliases,
        released: card.released,
      })),
    }),
    writeJsonData(join(dataDir, "rulings.json"), { schemaVersion: 1, generatedAt, records: mergedRulings }),
    writeJsonData(join(dataDir, "card-alias-index.json"), { schemaVersion: 1, generatedAt, records: aliasIndex }),
    writeJsonData(join(dataDir, "qa-index.json"), { schemaVersion: 1, generatedAt, records: qaIndex }),
  ]);
}

async function writeJsonData(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function resolveCardsFromLiveSources(resolution, existingCards, env) {
  const detail = await resolveCardsFromLiveSourcesDetailed(resolution, existingCards, env);
  return detail.cards;
}

async function resolveCardsFromLiveSourcesDetailed(resolution, existingCards, env) {
  if (!resolution?.cards?.length) return { cards: [], indexAvailable: false, warnings: [] };
  const languages = String(env.CARD_RESOLUTION_LANGUAGES || "ja,en")
    .split(",")
    .map((language) => language.trim())
    .filter(Boolean);

  const indexResults = await Promise.allSettled(languages.map((language) => loadLiveNameIndex(language)));
  const indexes = indexResults.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const warnings = indexResults
    .filter((result) => result.status === "rejected")
    .map((result) => `live_card_index_failed:${formatError(result.reason)}`);
  if (!indexes.length) return { cards: [], indexAvailable: false, warnings };
  const cards = [];
  const existingIds = new Set(existingCards.map((card) => String(card.id || "")));

  for (const item of resolution.cards) {
    const id = findLiveCardId([item.input, ...(item.candidates || [])], indexes);
    if (!id || existingIds.has(String(id))) continue;
    const card = await loadLiveCard(id, [item.input, ...(item.candidates || [])]).catch(() => null);
    if (card) cards.push({ ...card, matched: item.input || card.name, resolvedBy: "live-ygoresources" });
  }

  return { cards: mergeCards(...cards), indexAvailable: true, warnings };
}

async function resolveCardsFromDetectedCards(detectedCards, existingCards, env) {
  const detail = await resolveCardsFromDetectedCardsDetailed(detectedCards, existingCards, env);
  return detail.cards;
}

async function resolveCardsFromDetectedCardsDetailed(detectedCards, existingCards, env) {
  const resolution = {
    cards: detectedCards.map((card) => ({
      input: card.matched || card.name,
      candidates: cardAliases(card),
      confidence: "high",
    })),
  };
  return resolveCardsFromLiveSourcesDetailed(resolution, existingCards, env);
}

async function loadLiveNameIndex(language) {
  const cached = liveIndexCache.get(language);
  if (cached && Date.now() - cached.loadedAt < 60 * 60 * 1000) return cached.index;

  const payload = await fetchJson(`${ygoResourcesBaseUrl}/data/idx/card/name/${language}`);
  const index = collectNameIndex(payload);
  liveIndexCache.set(language, { loadedAt: Date.now(), index });
  return index;
}

async function loadLiveCard(id, candidates) {
  const key = String(id);
  const cached = liveCardCache.get(key);
  if (cached) return cached;

  const payload = await loadLiveCardPayload(id);
  const card = normalizeLiveCard(payload, id, candidates);
  if (card) liveCardCache.set(key, card);
  return card;
}

async function loadLiveCardPayload(id) {
  const key = String(id);
  const cached = liveCardPayloadCache.get(key);
  if (cached) return cached;

  const payload = await fetchJson(`${ygoResourcesBaseUrl}/data/card/${id}`);
  liveCardPayloadCache.set(key, payload);
  return payload;
}

async function loadLiveEvidenceForCards(cards, env) {
  const maxQaPerCard = Number(env.LIVE_QA_PER_CARD || 40);
  const maxQaTotal = Number(env.LIVE_QA_TOTAL || 80);
  const cardEntries = dedupeBy(
    cards
      .map((card) => {
        const id = card.liveId || extractYgoResourcesCardId(card.ygoResourcesUrl || card.sourceUrl);
        return id ? { id, card } : null;
      })
      .filter(Boolean),
    (entry) => entry.id
  );

  if (!cardEntries.length) return [];

  const records = [];
  const qaIds = new Set();

  for (const entry of cardEntries) {
    const payload = await loadLiveCardPayload(entry.id);
    const liveCard = normalizeLiveCard(payload, entry.id, cardAliases(entry.card));
    records.push(...buildLiveFaqRecords(liveCard, payload));
    for (const qaId of collectQaIds(payload?.qaIndex || []).slice(0, maxQaPerCard)) qaIds.add(qaId);
  }

  const qaPayloads = await mapLimit([...qaIds].slice(0, maxQaTotal), 8, async (qaId) => {
    try {
      return { qaId, payload: await fetchJson(`${ygoResourcesBaseUrl}/data/qa/${qaId}`) };
    } catch {
      return null;
    }
  });

  for (const item of qaPayloads.filter(Boolean)) {
    const record = normalizeLiveQa(item.payload, item.qaId, cards);
    if (record) records.push(record);
  }

  return records;
}

function buildLiveFaqRecords(card, payload) {
  const records = [];
  const entries = payload?.faqData?.entries || {};

  for (const [effectNo, blocks] of Object.entries(entries)) {
    const lines = [];
    for (const block of blocks || []) {
      const text = block.cn || block["zh-CN"] || block.ja || block.en;
      if (text) lines.push(cleanText(text));
    }
    if (!lines.length) continue;

    records.push({
      id: `card-faq-${card.liveId || card.id}-${effectNo}`,
      recordType: "card-faq",
      title: `${card.name} FAQ ${effectNo}`,
      question: "",
      status: "confirmed",
      cards: cardAliases(card),
      cardIds: collectResolvedCardIds([card]),
      keywords: extractKeywords(lines.join("\n")),
      conclusion: lines.join("\n"),
      steps: ["按命中的卡片 FAQ 处理。", "若场面条件不同，继续核对对应官方 Q&A。"],
      questions: [],
      sources: [{ label: "YGOResources Card FAQ", detail: card.ygoResourcesUrl || card.sourceUrl }],
      updatedAt: payload?.faqData?.meta?.cn?.date || payload?.faqData?.meta?.ja?.date || payload?.faqData?.meta?.en?.date || card.updatedAt,
    });
  }

  return records;
}

function normalizeLiveQa(payload, id, detectedCards) {
  const question = firstText(payload, ["question", "q", "title"]);
  const answer = firstText(payload, ["answer", "a", "content"]);
  if (!question || !answer) return null;

  const text = cleanText(`${question}\n${answer}`);
  const involvedCards = detectCardsInText(text, detectedCards);
  const cards = involvedCards.length ? involvedCards.flatMap(cardAliases) : detectedCards.flatMap(cardAliases);

  return {
    id: `ygoresources-qa-${id}`,
    recordType: "qa",
    title: truncate(cleanText(question).replace(/\s+/g, " "), 90),
    question: cleanText(question),
    status: "confirmed",
    cards: [...new Set(cards)],
    cardIds: collectResolvedCardIds(involvedCards.length ? involvedCards : detectedCards),
    keywords: extractKeywords(text),
    conclusion: cleanText(answer),
    steps: ["按命中的 Q&A 结论处理。", "若对局条件与问答不同，先回到来源核对完整原文。"],
    questions: [],
    sources: [{ label: "YGOResources Q&A", detail: `${ygoResourcesBaseUrl}/data/qa/${id}` }],
    sourceId: String(id),
    sourceName: "YGOResources DB",
    sourceUrl: `${ygoResourcesBaseUrl}/data/qa/${id}`,
    updatedAt: new Date().toISOString(),
  };
}

function collectQaIds(payload) {
  const ids = [];

  function visit(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") {
      if (looksLikeId(value)) ids.push(String(value));
      return;
    }
    const id = value.id || value.qaId || value.qid;
    if (looksLikeId(id)) ids.push(String(id));
    for (const child of Object.values(value)) visit(child);
  }

  visit(payload);
  return [...new Set(ids)];
}

function firstText(payload, targetKeys) {
  const candidates = [];

  function visit(value, key = "") {
    if (!value) return;
    if (typeof value === "string") {
      if (targetKeys.includes(key) && value.trim().length > 1) candidates.push(cleanText(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) {
        if (targetKeys.includes(childKey)) {
          if (typeof child === "string" && child.trim()) candidates.push(cleanText(child));
          if (child && typeof child === "object") {
            const localized = child["zh-CN"] || child.cn || child.ja || child.en || child.value || child.text;
            if (typeof localized === "string" && localized.trim()) candidates.push(cleanText(localized));
          }
        }
        visit(child, childKey);
      }
    }
  }

  visit(payload);
  return candidates.sort((a, b) => b.length - a.length)[0] || "";
}

function detectCardsInText(text, cards) {
  const normalized = normalizeKey(text);
  return cards.filter((card) => cardAliases(card).some((alias) => normalized.includes(normalizeKey(alias))));
}

function extractYgoResourcesCardId(url) {
  const match = String(url || "").match(/\/data\/card\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function extractCardSourceId(url) {
  const match = String(url || "").match(/\/(?:data\/card|card)\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function findLiveCardId(candidates, indexes) {
  let best = null;
  for (const candidate of candidates.filter(Boolean)) {
    const candidateKey = normalizeKey(candidate);
    if (candidateKey.length < 2) continue;

    for (const index of indexes) {
      const exact = index.get(candidateKey);
      if (exact) return exact;

      for (const [nameKey, id] of index.entries()) {
        const score = scoreTextSimilarity(candidateKey, nameKey);
        if (!best || score > best.score) best = { id, score };
      }
    }
  }

  return best && best.score >= 0.82 ? best.id : null;
}

function normalizeLiveCard(payload, id, candidates) {
  const cardData = payload?.cardData || {};
  const passcode = normalizeId(cardData.passcode || cardData.password || payload?.passcode || payload?.password || "");
  const cnName = cardData.cn?.name || "";
  const jaName = cardData.ja?.name || "";
  const enName = cardData.en?.name || "";
  const primaryName = cnName || jaName || enName || candidates.find(Boolean) || String(id);
  const effectText = cardData.cn?.effectText || cardData.ja?.effectText || cardData.en?.effectText || "";
  const sourceUrl = `${ygoResourcesBaseUrl}/data/card/${id}`;

  return {
    id: String(id),
    liveId: String(id),
    passcode,
    name: cleanText(primaryName),
    cnName: cleanText(cnName),
    jaName: cleanText(jaName),
    enName: cleanText(enName),
    effectText: cleanText(effectText),
    released: isReleased(cardData),
    aliases: [...new Set([primaryName, cnName, jaName, enName, ...candidates].filter(Boolean))],
    sourceUrl,
    ygoResourcesUrl: sourceUrl,
    updatedAt: new Date().toISOString(),
  };
}

function collectNameIndex(payload) {
  const index = new Map();

  function visit(value, possibleName = "") {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, possibleName);
      return;
    }
    if (typeof value !== "object") {
      if (possibleName && (typeof value === "string" || typeof value === "number")) {
        index.set(normalizeKey(possibleName), String(value));
      }
      return;
    }

    const name = value.name || value.cardName || value.label || value.en || value.ja || possibleName;
    const id = value.id || value.cardId || value.cid || value.passcode || value.konamiId;
    if (name && id) index.set(normalizeKey(name), String(id));

    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" || typeof child === "number") {
        if (looksLikeCardName(key) && looksLikeId(child)) index.set(normalizeKey(key), String(child));
      } else {
        visit(child, looksLikeCardName(key) ? key : name);
      }
    }
  }

  visit(payload);
  return index;
}

function matchModelResolvedCards(resolution, cards) {
  const matches = [];
  for (const item of resolution?.cards || []) {
    const card = findBestCardForCandidates([item.input, ...(item.candidates || [])], cards);
    if (!card) continue;
    matches.push({
      ...card,
      matched: item.input || item.candidates?.[0] || card.name,
      resolvedBy: "model-card-resolution",
      resolutionConfidence: item.confidence,
    });
  }
  return mergeCards(...matches);
}

function findBestCardForCandidates(candidates, cards) {
  let best = null;
  for (const candidate of candidates.filter(Boolean)) {
    const candidateKey = normalizeKey(candidate);
    if (candidateKey.length < 2) continue;

    for (const card of cards) {
      const score = scoreCandidateAgainstCard(candidateKey, card);
      if (!best || score > best.score) best = { card, score };
    }
  }
  return best && best.score >= 0.74 ? best.card : null;
}

function scoreCandidateAgainstCard(candidateKey, card) {
  let best = 0;
  for (const alias of cardAliases(card)) {
    const aliasKey = normalizeKey(alias);
    if (aliasKey.length < 2) continue;
    best = Math.max(best, scoreTextSimilarity(candidateKey, aliasKey));
  }
  return best;
}

function scoreTextSimilarity(left, right) {
  if (left === right) return 1;
  if (left.length >= 3 && right.includes(left)) return 0.92;
  if (right.length >= 4 && left.includes(right)) return 0.88;
  return diceCoefficient(left, right);
}

function cardAliases(card) {
  return [card.name, card.cnName, card.jaName, card.enName, card.matched, ...(card.aliases || [])].filter(Boolean);
}

function mergeCards(...groups) {
  const flat = groups.flat().filter(Boolean);
  const map = new Map();
  for (const card of flat) {
    const key = findMergeCardKey(map, card) || canonicalCardKey(card);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...card });
      continue;
    }
    existing.matched = longerText(existing.matched, card.matched);
    existing.resolvedBy = existing.resolvedBy || card.resolvedBy;
    existing.resolutionConfidence = existing.resolutionConfidence || card.resolutionConfidence;
    existing.effectText = preferChineseText(existing.effectText, card.effectText);
    existing.passcode = mergeCardId(existing.passcode, card.passcode || card.id || card.cardId);
    existing.liveId = existing.liveId || card.liveId || (card.resolvedBy === "live-ygoresources" ? card.id : "");
    existing.cnName = existing.cnName || card.cnName;
    existing.jaName = existing.jaName || card.jaName;
    existing.enName = existing.enName || card.enName;
    existing.name = preferDisplayName(existing, card);
    existing.cardType = existing.cardType || card.cardType;
    existing.ygoResourcesUrl = existing.ygoResourcesUrl || card.ygoResourcesUrl || (/db\.ygoresources\.com\/data\/card\//.test(card.sourceUrl || "") ? card.sourceUrl : "");
    existing.sourceUrl = existing.sourceUrl || card.sourceUrl;
    existing.released = existing.released !== false || card.released !== false;
    existing.provisional = Boolean(existing.provisional && card.provisional);
    existing.aliases = [...new Set([...(existing.aliases || []), ...(card.aliases || []), card.matched].filter(Boolean))];
  }
  return [...map.values()];
}

function mergeCardId(left, right) {
  const leftId = normalizeId(left);
  const rightId = normalizeId(right);
  if (!leftId) return rightId || cleanText(right);
  if (!rightId) return leftId || cleanText(left);
  if (leftId === rightId) return leftId;
  return leftId;
}

function preferDisplayName(existing, card) {
  const candidates = [existing.cnName, card.cnName, existing.name, card.name, existing.jaName, card.jaName, existing.enName, card.enName]
    .map(cleanText)
    .filter(Boolean);
  return candidates.find((item) => /[\u3400-\u9fff]/.test(item)) || candidates[0] || "";
}

function preferChineseText(left, right) {
  const current = cleanText(left);
  const next = cleanText(right);
  if (!current) return next;
  if (next && /[\u3400-\u9fff]/.test(next) && !/[\u3400-\u9fff]/.test(current)) return next;
  return current;
}

function findMergeCardKey(map, card) {
  const key = canonicalCardKey(card);
  if (map.has(key)) return key;

  const keys = cardIdentityKeys(card);
  for (const [existingKey, existing] of map.entries()) {
    const existingKeys = cardIdentityKeys(existing);
    if ([...keys].some((item) => existingKeys.has(item))) return existingKey;
  }
  return "";
}

function canonicalCardKey(card) {
  const numeric = normalizeId(card.passcode || card.id || card.cardId || "");
  if (numeric) return `id:${numeric}`;
  const sourceId = extractCardSourceId(card.ygoResourcesUrl || card.sourceUrl);
  const normalizedSourceId = normalizeId(sourceId);
  if (normalizedSourceId) return `id:${normalizedSourceId}`;
  return `name:${normalizeKey(card.name || card.cnName || card.jaName || card.enName || "")}`;
}

function cardIdentityKeys(card) {
  const keys = new Set();
  const numeric = normalizeId(card.passcode || card.id || card.cardId || "");
  if (numeric) keys.add(`id:${numeric}`);
  const sourceId = extractCardSourceId(card.ygoResourcesUrl || card.sourceUrl);
  const normalizedSourceId = normalizeId(sourceId);
  if (normalizedSourceId) keys.add(`id:${normalizedSourceId}`);

  for (const alias of cardAliases(card)) {
    const key = normalizeKey(alias);
    if (key.length >= 3 && !isGenericCardAliasKey(key)) keys.add(`alias:${key}`);
  }
  return keys;
}

function isGenericCardAliasKey(key) {
  return /^(卡通世界|toonworld|トゥーンワールド|闪刀姬|閃刀姫|闪刀|閃刀|时空)$/.test(key);
}

function buildCardSummaries(cards) {
  return mergeCards(cards).map((card) => ({
    id: cleanText(card.id),
    passcode: cleanText(card.passcode),
    name: cleanText(card.name),
    cnName: cleanText(card.cnName),
    jaName: cleanText(card.jaName),
    enName: cleanText(card.enName),
    matched: cleanText(card.matched),
    cardType: cleanText(card.cardType),
    effectText: cleanText(card.effectText),
    sourceUrl: cleanText(card.sourceUrl),
    ygoResourcesUrl: cleanText(card.ygoResourcesUrl),
    liveId: cleanText(card.liveId),
    resolvedBy: cleanText(card.resolvedBy),
    released: card.released !== false,
    provisional: Boolean(card.provisional),
    aliases: cleanList(card.aliases || cardAliases(card), []),
  }));
}

function diceCoefficient(left, right) {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  let intersection = 0;
  const counts = new Map();
  for (const item of leftBigrams) counts.set(item, (counts.get(item) || 0) + 1);
  for (const item of rightBigrams) {
    const count = counts.get(item) || 0;
    if (!count) continue;
    counts.set(item, count - 1);
    intersection += 1;
  }
  return (2 * intersection) / (leftBigrams.length + rightBigrams.length);
}

function bigrams(value) {
  const result = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    result.push(value.slice(index, index + 2));
  }
  return result;
}

function longerText(left, right) {
  return String(right || "").length > String(left || "").length ? right : left;
}

function detectTopics(question) {
  const text = normalizeKey(question);
  return topics.filter((topic) => topic.keywords.some((keyword) => text.includes(normalizeKey(keyword))));
}

function parseChain(question) {
  const normalized = normalizeText(question);
  return [...normalized.matchAll(/\bC\s*([0-9]+)\s*(?:发动|连锁发动)?([^，。；;\n]*)/gi)]
    .map((match) => ({
      number: Number(match[1]),
      content: match[2].trim() || "未识别动作",
    }))
    .sort((a, b) => a.number - b.number);
}

function buildNeedsConfirmation(context, cardTextOnly, analogousRuling = null) {
  const items = [];
  items.push(...buildMultiQuestionNeeds(context.question));
  items.push(...detectMissingSceneFacts(context));
  const releasedUnknown = context.detectedCards.filter((card) => card.released === false).map((card) => card.name);
  if (releasedUnknown.length) items.push(`${releasedUnknown.join("、")} 可能尚未发售或同步来源缺少发售日期。`);
  if (analogousRuling) {
    items.push("当前是相似问答类推，不是完全同场面原题；需要核对相同结构和差异点。");
    if (analogousRuling.matchedCardCount < context.detectedCards.length) {
      items.push("相似资料没有覆盖题目中的全部卡片，需要确认未覆盖卡片不会改变处理。");
    }
  }
  if (context.chainItems.length) items.push("若连锁处理途中有控制权、区域或表示形式变化，需要逐步核对处理后的公开状态。");
  if (context.topics.some((topic) => topic.id === "activation")) items.push("需要确认被问效果的完整文本、发动位置、每回合次数和是否已满足触发事件。");
  if (context.topics.some((topic) => topic.id === "battle")) items.push("需要确认攻击目标的当前守备力以及所有伤害变更效果。");
  if (context.topics.some((topic) => topic.id === "replacement")) items.push("需要确认代替破坏文本指定的范围，以及被代替的卡在该时点是否仍在场上。");
  if (cardTextOnly) items.push("当前没有命中直接 Q&A/FAQ，结论不能标记为已确认裁定。");
  return [...new Set(items)];
}

function buildDirectNeedsConfirmation(context) {
  const items = [];
  items.push(...buildMultiQuestionNeeds(context.question));
  items.push(...detectMissingSceneFacts(context));
  const releasedUnknown = context.detectedCards.filter((card) => card.released === false).map((card) => card.name);
  if (releasedUnknown.length) items.push(`${releasedUnknown.join("、")} 可能尚未发售或同步来源缺少发售日期。`);
  items.push("若题目条件与命中的问答原文不同，需要回到出处核对完整原文。");
  return [...new Set(items)];
}

function buildMultiQuestionNeeds(question) {
  return countIndependentQuestions(question) >= 2
    ? ["题目里包含多个独立问题；当前回答优先处理主问题，其他问题建议拆开单独问，避免资料命中互相串题。"]
    : [];
}

function countIndependentQuestions(question) {
  const text = normalizeRulingText(question)
    .replace(/[？?]/g, "?\n")
    .replace(/(吗|呢|么|嘛)(?=\s|$)/g, "$1\n");
  return text
    .split(/\n+/)
    .map((part) => part.trim())
    .filter((part) => /(吗|呢|么|嘛|？|\?|能否|能不能|可以|是否|会不会|怎么处理|哪里发动|在.*发动|已经.*吗)/u.test(part))
    .length;
}

function detectMissingSceneFacts(context) {
  const question = normalizeRulingText(context?.question || "");
  const cards = context?.detectedCards || [];
  const items = [];
  if (/场地|フィールド魔法|Field Spell/i.test(question) && !cards.some((card) => /场地魔法|场地卡|场地区域|フィールド魔法|Field Spell/i.test(`${card.name || ""} ${card.cnName || ""} ${card.jaName || ""} ${card.enName || ""} ${card.cardType || ""} ${card.effectText || ""}`))) {
    items.push("题目提到场地卡，但当前没有识别到具体是哪张场地卡；需要补卡名或效果文本。");
  }
  if (/卡通怪|トゥーンモンスター|Toon monster/i.test(question) && !cards.some((card) => /卡通|トゥーン|Toon/i.test(`${card.name || ""} ${card.cnName || ""} ${card.jaName || ""} ${card.enName || ""} ${card.effectText || ""}`))) {
    items.push("题目提到卡通怪兽，但当前没有识别到那只怪兽或其适用中的相关效果。");
  }
  return items;
}

function summarizeRulingConclusion(value, matchKind, contextText = "") {
  const text = normalizeRulingText(`${contextText} ${value}`);
  const negative = /(できません|不能|不可以|不可|cannot|can't)/i.test(text);
  const positive = /(できます|できる|可以|能|may|can\b)/i.test(text);
  const notDestroyed = /(破壊されません|不会被破坏|不被破坏|不会破坏)/i.test(text);
  const destroyed = /(破壊されます|被破坏|会被破坏)/i.test(text);
  const banish = /(除外|banish)/i.test(text);
  const activate = /(発動|发动|activate)/i.test(text);
  const apply = /(適用|适用|apply)/i.test(text);
  const deckReturn = hasDeckReturnText(text);
  const temporaryBanish = hasTemporaryBanishText(text);

  if (negative) {
    if (activate) return "不能发动";
    if (apply) return "不能适用该效果";
    if (banish) return "不能除外";
    return "不能按该处理进行";
  }

  if ((positive || banish || apply || temporaryBanish) && deckReturn && temporaryBanish) {
    return "可以适用临时除外效果，怪兽不回卡组";
  }

  if ((positive || banish || apply || temporaryBanish) && hasPendingDestructionText(text) && temporaryBanish) {
    return "可以适用临时除外效果，怪兽不按原预定破坏处理";
  }

  if (notDestroyed) {
    if (banish) return "可以除外，怪兽不被破坏";
    return "不会被破坏";
  }

  if (positive) {
    if (banish && /破壊|破坏/.test(text)) return "可以除外，怪兽不被破坏";
    if (banish) return "可以除外";
    if (activate) return "可以发动";
    if (apply) return "可以适用该效果";
    return "可以按该处理进行";
  }

  if (destroyed) return "会被破坏";
  return matchKind === "analogous" ? "可参考相似裁定，需复核差异" : "按问答结论处理";
}

function buildReadableRulingBody(value, title, matchKind, context = null) {
  const text = normalizeRulingText(value);
  const contextText = normalizeRulingText(`${context?.question || ""} ${text}`);
  if (title === "可以适用临时除外效果，怪兽不回卡组") {
    const names = inferInteractionCardNames(context);
    return `可以适用${names.protector}的临时除外效果，把被处理的怪兽除外到该效果处理后。因此${names.resolver}处理时，那只怪兽已经不在原本要处理的位置，不能被洗回卡组；处理后再回到场上。`;
  }
  if (title === "可以适用临时除外效果，怪兽不按原预定破坏处理") {
    const names = inferInteractionCardNames(context);
    return `可以适用${names.protector}的临时除外效果。适用后那只怪兽会暂时离开场上，直到${names.resolver}处理后再回到场上；由于原本预定被破坏的时点它已经不在原位置，不能按原预定破坏处理。`;
  }
  if (title === "可以适用临时除外效果") {
    const names = inferInteractionCardNames(context);
    return `可以适用${names.protector}的临时除外效果，把满足条件的怪兽除外到${names.resolver}处理后，再让其回到场上。`;
  }
  if (title === "可以除外，怪兽不被破坏") {
    return "可以适用相关除外效果，把战斗破坏预定的卡通怪兽除外；因此该怪兽不会被这次战斗破坏。";
  }
  if (title === "可以除外") return "可以适用相关效果，将满足条件的卡除外。";
  if (title === "不能除外") return "不能适用相关效果将其除外。";
  if (title === "可以发动") return "满足问答所示条件时，可以发动该效果。";
  if (title === "不能发动") return "该场面不满足问答所示条件，不能发动该效果。";
  if (title === "可以适用该效果") return "可以按问答结论适用该效果。";
  if (title === "不能适用该效果") return "不能按该方式适用该效果。";

  if (text && !hasBrokenCardMarkup(text)) {
    if (hasDeckReturnText(contextText) && hasTemporaryBanishText(contextText)) {
      const names = inferInteractionCardNames(context);
      return `可以适用${names.protector}的临时除外效果；被除外的怪兽不会被${names.resolver}洗回卡组。`;
    }
    return text;
  }
  return matchKind === "analogous"
    ? "相似问答的原文含有卡名标记或未本地化文本，需要结合出处核对后类推。"
    : "命中的问答原文含有卡名标记或未本地化文本；已按结论关键词提炼，完整原文请打开下方出处核对。";
}

function buildRulingSteps(context, ruling, title) {
  if (title === "可以适用临时除外效果，怪兽不回卡组") {
    const names = inferInteractionCardNames(context);
    return [
      `${names.resolver}的效果开始适用时，会处理“把被无效或被处理的那张卡洗回卡组”。`,
      `在这个“其他卡发动的效果适用之际”，可以适用${names.protector}的临时除外效果，把那只怪兽除外到该效果处理后。`,
      `除外后，那只怪兽已经不在${names.resolver}要处理的原位置，不能被该效果洗回卡组。`,
      `${names.resolver}处理完后，再按${names.protector}的临时除外效果让被除外的怪兽回到场上。`,
    ];
  }

  if (title === "可以适用临时除外效果，怪兽不按原预定破坏处理") {
    const names = inferInteractionCardNames(context);
    return [
      `${names.resolver}的效果正在适用，进入“其他卡发动的效果适用之际”。`,
      `此时可以适用${names.protector}的临时除外效果，把那只怪兽除外到该效果处理后。`,
      "除外期间那只怪兽不在原本会被战斗或效果破坏的位置，因此不能按原预定破坏处理。",
      `${names.resolver}处理完后，再按${names.protector}的临时除外效果让被除外的怪兽回到场上。`,
    ];
  }

  if (title === "可以适用临时除外效果") {
    const names = inferInteractionCardNames(context);
    return [
      `${names.resolver}的效果正在适用，检查是否满足“其他卡发动的效果适用之际”。`,
      `满足时，可以适用${names.protector}的临时除外效果，把对应怪兽除外到该效果处理后。`,
      `${names.resolver}继续处理；处理完后，被除外的怪兽按临时除外效果回到场上。`,
    ];
  }

  if (title === "可以除外，怪兽不被破坏") {
    const names = inferInteractionCardNames(context);
    return [
      "先确认有其他卡发动的效果正在适用，且该处理会影响自己场上的卡通怪兽。",
      `在该效果适用之际，可以适用${names.protector}的临时除外效果，把那只怪兽除外到该效果处理后。`,
      "除外期间该怪兽不在会被处理的位置，因此不会被该效果破坏。",
      `该效果处理完后，再按${names.protector}的临时除外效果让其回到相应位置。`,
    ];
  }

  if (ruling.steps?.length) return ruling.steps;
  return ["按命中的问答资料处理。", "若场面条件不同，继续核对原文和相关 Q&A。"];
}

function hasDeckReturnText(value) {
  return /(回卡组|回到卡组|返回卡组|洗回卡组|放回卡组|回入卡组|戻.*デッキ|デッキ.*戻|デッキに加え|shuffle(?:d)?\s+(?:it|that card|them|those cards)?\s*(?:into|to)\s+the\s+deck|return(?:ed)?\s+(?:it|that card|them|those cards)?\s*(?:into|to)\s+the\s+deck)/i.test(
    normalizeRulingText(value)
  );
}

function hasTemporaryBanishText(value) {
  const text = normalizeRulingText(value);
  return /(除外.*(处理后|處理後|戻|戻す|戻る|return)|(?:处理后|處理後|処理後).*(除外|回到|返回|特殊召唤|戻)|temporar(?:y|ily).*banish|banish.*until.*(?:resolv|after))/i.test(text);
}

function hasPendingDestructionText(value) {
  return /(战斗.*破坏|破坏.*决定|破坏.*确定|破壊されることが決定|戦闘で破壊|破壊予定|would be destroyed|determined to be destroyed)/i.test(normalizeRulingText(value));
}

function inferInteractionCardNames(context) {
  const cards = context?.detectedCards || [];
  const protector = cards.find((card) => hasTemporaryBanishText(card.effectText || ""));
  const resolver =
    cards.find((card) => card !== protector && hasDeckReturnText(`${card.effectText || ""} ${card.name || ""} ${card.matched || ""}`)) ||
    cards.find((card) => card !== protector);
  return {
    protector: formatRulingCardName(protector) || "该临时除外效果",
    resolver: formatRulingCardName(resolver) || "原本正在处理的效果",
  };
}

function formatRulingCardName(card) {
  const name = cleanText(card?.cnName || card?.name || card?.matched || card?.jaName || card?.enName || "");
  return name ? `「${name}」` : "";
}

function normalizeRulingText(value) {
  return cleanText(value)
    .replace(/「\s*>\s*」/g, "该卡")
    .replace(/『\s*>\s*』/g, "该卡")
    .replace(/\s+/g, " ")
    .trim();
}

function hasBrokenCardMarkup(value) {
  return /「\s*>\s*」|『\s*>\s*』|>\s*>/.test(value);
}

function basisFromMode(mode) {
  if (mode === "confirmed") return "找到直接问答资料";
  if (mode === "inferred") return "类推/规则推理";
  return "资料不足";
}

function buildUnknownAnswer(verdictTitle, verdict, steps, needsConfirmation, snapshotMeta) {
  return {
    schemaVersion: 1,
    mode: "unknown",
    verdictTitle,
    verdict,
    rulingBasis: "资料不足",
    confidence: { status: "unknown", label: "不能确定", className: "is-risky" },
    steps,
    needsConfirmation,
    sources: [],
    snapshotAt: snapshotMeta?.generatedAt || null,
    evidenceCount: 0,
    warnings: [],
  };
}

function enrichAnswer(answer, context) {
  if (!answer || !context) return answer;
  answer.questionTypes = context.questionTypes || classifyQuestion(context.question || "");
  answer.subQuestions = context.subQuestions || extractSubQuestions(context.question || "");
  if (!answer.subAnswers?.length) answer.subAnswers = buildDefaultSubAnswers(answer, context);
  if (!answer.confidence || typeof answer.confidence.value !== "number") {
    answer.confidence = buildEvidenceConfidence(context, context.evidence || [], answer.mode || "unknown");
  }
  return answer;
}

function buildDefaultSubAnswers(answer, context) {
  const subQuestions = context.subQuestions?.length ? context.subQuestions : extractSubQuestions(context.question || "");
  if (subQuestions.length <= 1) {
    return [
      {
        question: subQuestions[0]?.question || context.question || "",
        verdict: answer.verdictTitle || "需要确认",
        reasoning: answer.verdict || "",
        source: sourceLabelForAnswer(answer),
      },
    ];
  }

  return subQuestions.map((subQuestion, index) => {
    if (index === 0) {
      return {
        question: subQuestion.question,
        verdict: answer.verdictTitle || "需要确认",
        reasoning: answer.verdict || "当前回答优先覆盖主问题。",
        source: sourceLabelForAnswer(answer),
      };
    }
    return {
      question: subQuestion.question,
      verdict: "需要Q&A确认",
      reasoning: "该子问题未被当前命中的资料直接覆盖，不能把主问题结论套用过去。",
      source: "[推理，需确认]",
    };
  });
}

function sourceLabelForAnswer(answer) {
  const firstSource = answer.sources?.[0];
  if (firstSource) return cleanText([firstSource.label, firstSource.detail || firstSource.url].filter(Boolean).join("："));
  if (answer.mode === "confirmed") return answer.rulingBasis || "直接Q&A/FAQ";
  if (answer.mode === "inferred") return "[推理，需确认]";
  return "需要Q&A确认";
}

function buildEvidenceConfidence(context, evidence, preferredMode = "unknown") {
  const value = calculateConfidence(evidence, context?.questionTypes || [], context?.subQuestions || [], context?.detectedCards || []);
  if (value >= 70 && preferredMode === "confirmed") {
    return { label: freshnessLabel(context?.snapshotMeta, "已确认资料"), value, className: "is-confirmed" };
  }
  if (value >= 40) {
    return { label: preferredMode === "confirmed" ? "资料需复核" : "类推需复核", value, className: "" };
  }
  if (value === 0) return { label: "无Q&A支持", value: 0, className: "is-risky" };
  return { label: "需要Q&A确认", value, className: "is-risky" };
}

function calculateConfidence(evidence, questionTypes, subQuestions, detectedCards) {
  const qaMatches = (evidence || []).filter((item) => isRulingEvidence(item) && !item.intentMismatch);
  if (!qaMatches.length) return 0;

  let score = 0;
  const questionCardKeys = new Set(
    (detectedCards || []).flatMap((card) => cardAliases(card).map(normalizeKey)).filter((key) => key.length >= 2)
  );
  const exactMatches = qaMatches.filter((qa) => {
    const qaText = normalizeKey(`${(qa.cards || []).join(" ")} ${qa.question || ""} ${qa.title || ""} ${qa.conclusion || ""}`);
    const hasCards = !questionCardKeys.size || [...questionCardKeys].some((key) => qaText.includes(key));
    const coversTypes = !questionTypes.length || scoreQuestionTypeOverlap(questionTypes, `${qa.question || ""} ${qa.title || ""} ${qa.conclusion || ""} ${(qa.keywords || []).join(" ")}`) >= Math.min(1, questionTypes.length);
    return qa.matchKind === "direct" && hasCards && coversTypes;
  });

  score += Math.min(60, exactMatches.length * 30);
  if (qaMatches.some((qa) => qa.matchKind === "analogous")) score += 10;

  const questions = subQuestions?.length ? subQuestions : [];
  if (questions.length) {
    const coveredSubQuestions = questions.filter((subQuestion) =>
      qaMatches.some((qa) => {
        const text = normalizeRulingText(`${qa.question || ""} ${qa.title || ""} ${qa.conclusion || ""} ${(qa.keywords || []).join(" ")}`);
        const keyword = normalizeRulingText(subQuestion.keyword || "");
        return keyword ? text.includes(keyword) : scoreTextSimilarity(normalizeKey(subQuestion.question), normalizeKey(text)) >= 0.45;
      })
    ).length;
    score += (coveredSubQuestions / questions.length) * 40;
  } else {
    score += 20;
  }

  if (qaMatches.some((qa) => qa.matchKind !== "direct" || qa.intentMismatch || qa.mismatchReason)) score -= 25;
  if (questionTypes.includes("covenant") || questionTypes.includes("chain")) score -= 10;
  if (questionTypes.includes("multiPart") && (subQuestions?.length || 0) > 1) score -= 10;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function shouldResolveCardNamesWithModel(env) {
  const mode = String(env.MODEL_CARD_RESOLUTION || "auto").toLowerCase();
  return !["0", "false", "off", "none", "disabled"].includes(mode);
}

function confidenceFromMode(mode, snapshotMeta) {
  if (mode === "confirmed") {
    return { label: freshnessLabel(snapshotMeta, "已确认资料"), value: freshnessValue(snapshotMeta, 78), className: "is-confirmed" };
  }
  if (mode === "inferred") {
    return { label: "推理需确认", value: 35, className: "is-risky" };
  }
  return { label: "不能确定", value: 0, className: "is-risky" };
}

function freshnessLabel(snapshotMeta, freshLabel) {
  return isFresh(snapshotMeta) ? freshLabel : "资料需复核";
}

function freshnessValue(snapshotMeta, base) {
  return isFresh(snapshotMeta) ? base : Math.max(35, base - 18);
}

function isFresh(snapshotMeta) {
  if (!snapshotMeta?.generatedAt) return false;
  const date = new Date(snapshotMeta.generatedAt);
  if (!Number.isFinite(date.getTime())) return false;
  const freshnessDays = Number(snapshotMeta.freshnessDays || 7);
  return Date.now() - date.getTime() <= freshnessDays * 24 * 60 * 60 * 1000;
}

function downgradeConfidence(value) {
  return value === "confirmed" ? "inferred" : value || "unknown";
}

function collectSources(evidence, snapshotMeta) {
  const sources = [];
  for (const item of evidence) {
    for (const source of item.sources || []) sources.push(source);
  }
  if (snapshotMeta?.generatedAt) {
    sources.push({ label: "资料快照", detail: `生成时间：${snapshotMeta.generatedAt}` });
  }
  return dedupeBy(sources, (source) => `${source.label}:${source.detail || source.url || ""}`);
}

function sourceFromRecord(record) {
  const sources = [];
  if (record.officialUrl) sources.push({ label: "官方数据库", detail: record.officialUrl });
  if (record.sourceUrl) sources.push({ label: record.sourceName || "同步来源", detail: record.sourceUrl });
  return sources;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchJson(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "accept": "application/json",
        "user-agent": "ocg-ruling-assistant/0.2",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function isReleased(cardData) {
  const today = new Date();
  const dates = [];
  for (const locale of Object.values(cardData || {})) {
    for (const product of locale?.products || []) {
      const date = new Date(product.date);
      if (Number.isFinite(date.getTime())) dates.push(date);
    }
  }
  return !dates.length || dates.some((date) => date <= today);
}

function tokenize(value) {
  return normalizeText(value)
    .toLowerCase()
    .split(/[\s,，.。;；:：、"「」『』()（）/]+/)
    .filter((part) => part.length >= 2)
    .map(normalizeKey);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[－ー]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}②③④⑤⑥⑦⑧⑨①]+/gu, "");
}

function normalizeId(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (!digits) return "";
  return digits.length <= 8 ? digits.padStart(8, "0") : digits;
}

function looksLikeCardName(value) {
  const text = String(value || "");
  return text.length >= 2 && /[a-zA-Z\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

function looksLikeId(value) {
  return /^[0-9]{3,12}$/.test(String(value || ""));
}

function strongerConfidence(left = "low", right = "low") {
  const rank = { low: 0, medium: 1, high: 2 };
  return rank[right] > rank[left] ? right : left;
}

function extractKeywords(text) {
  const groups = [
    ["发动", "能否发动", "可以发动", "発動", "発動できる"],
    ["连锁", "C1", "C2", "チェーン"],
    ["控制权", "获得控制权", "コントロール"],
    ["战斗伤害", "伤害计算", "攻击", "戦闘", "ダメージ計算"],
    ["代替破坏", "代破", "破坏", "除外", "破壊", "除外できる"],
    ["魔法", "陷阱", "魔法・罠"],
  ];
  const result = [];
  for (const group of groups) {
    if (group.some((keyword) => String(text || "").includes(keyword))) result.push(group[0]);
  }
  return result;
}

function cleanText(value) {
  return decodeHtmlEntities(stripHtml(String(value || "")))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripHtml(value) {
  return value
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|section|article)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = String(entity).toLowerCase();
    if (lower[0] === "#") {
      const isHex = lower[1] === "x";
      const codePoint = Number.parseInt(lower.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
  });
}

function cleanList(value, fallback = []) {
  const items = Array.isArray(value) ? value : fallback;
  return [...new Set(items.map(cleanText).filter(Boolean))].slice(0, 8);
}

function cleanSubAnswers(value, fallback = []) {
  const items = Array.isArray(value) && value.length ? value : fallback;
  return items
    .map((item) => ({
      question: cleanText(item?.question || ""),
      verdict: cleanText(item?.verdict || ""),
      reasoning: cleanText(item?.reasoning || item?.reason || ""),
      source: cleanText(item?.source || ""),
    }))
    .filter((item) => item.question || item.verdict || item.reasoning)
    .slice(0, 8);
}

function truncate(value, length) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function dedupeBy(items, getKey) {
  const map = new Map();
  for (const item of items) map.set(getKey(item), item);
  return [...map.values()];
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/RESOURCE_EXHAUSTED|prepayment credits are depleted|No credits|429/i.test(message)) {
    return "Gemini API 额度或预付费余额不足，模型解析暂时不可用。可以在 Google AI Studio 的 Billing 页面充值，或换一个有额度的 API key。";
  }
  if (/API key not valid|INVALID_ARGUMENT|permission|PERMISSION_DENIED|403|401/i.test(message)) {
    return "模型 API key 或权限配置异常，请检查 Vercel 环境变量里的 API key、模型名和项目权限。";
  }
  if (/timeout|aborted|fetch failed|ENOTFOUND|ECONNRESET/i.test(message)) {
    return "外部资料或模型服务暂时连接失败，请稍后重试。";
  }
  if (/Unterminated string|Unexpected end of JSON|JSON/i.test(message)) {
    return "模型返回内容不完整或格式异常，已回退为资料检索结果。可以稍后重试，或把 GEMINI_MAX_OUTPUT_TOKENS 调到 4096。";
  }
  return message.length > 180 ? `${message.slice(0, 180)}...` : message;
}
