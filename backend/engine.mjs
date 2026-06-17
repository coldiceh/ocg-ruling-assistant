import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelAnswer, resolveCardNamesWithModel } from "./openai.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = join(projectRoot, "data");
const snapshotCache = new Map();
const liveIndexCache = new Map();
const liveCardCache = new Map();
const liveCardPayloadCache = new Map();
const baigeSearchCache = new Map();
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
];

export async function answerQuestion(payload, options = {}) {
  const question = String(payload?.question || "").trim();
  if (!question) {
    return buildUnknownAnswer("没有输入问题", "请输入场面、连锁、卡名和想确认的点。", [], [], null);
  }

  const snapshot = await loadSnapshot(options.dataDir || defaultDataDir);
  const env = options.env || globalThis.process?.env || {};
  const resolutionWarnings = [];
  const resolutionNotes = [];
  let detectedCards = detectCards(question, snapshot.cards);
  const detectedTopics = detectTopics(question);
  const chainItems = parseChain(question);
  let evidence = retrieveEvidence(question, detectedCards, detectedTopics, snapshot).slice(0, 10);

  if (!detectedCards.length || !evidence.length) {
    const extractedResolution = collectQuestionCardCandidates(question);
    try {
      const baigeCards = await resolveCardsFromBaige(extractedResolution, env);
      if (baigeCards.length) {
        resolutionNotes.push("部分卡片由百鸽卡查确认，静态快照尚未覆盖。");
        detectedCards = mergeCards(detectedCards, baigeCards);
        evidence = retrieveEvidence(question, detectedCards, detectedTopics, snapshot).slice(0, 10);
      }
    } catch (error) {
      resolutionWarnings.push(`百鸽卡查解析失败，已继续使用本地资料：${formatError(error)}`);
    }

    const localResolution = collectLocalAliasResolutions(question);
    const localResolvedCards = matchModelResolvedCards(localResolution, snapshot.cards);
    if (localResolvedCards.length) {
      detectedCards = mergeCards(detectedCards, localResolvedCards);
      evidence = retrieveEvidence(question, detectedCards, detectedTopics, snapshot).slice(0, 10);
    } else {
      detectedCards = mergeCards(detectedCards, buildPlaceholderCards(localResolution));
      evidence = retrieveEvidence(question, detectedCards, detectedTopics, snapshot).slice(0, 10);
    }

    try {
      const liveLocalCards = await resolveCardsFromLiveSources(mergeResolutions(extractedResolution, localResolution), snapshot.cards, env);
      if (liveLocalCards.length) {
        resolutionNotes.push("部分卡片来自实时资料索引，静态快照尚未覆盖。");
        detectedCards = mergeCards(detectedCards, liveLocalCards);
        evidence = retrieveEvidence(question, detectedCards, detectedTopics, snapshot).slice(0, 10);
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
          evidence = retrieveEvidence(question, detectedCards, detectedTopics, snapshot).slice(0, 10);
        } else if (liveCards.length || baigeCards.length) {
          detectedCards = mergeCards(detectedCards, liveCards, baigeCards);
          evidence = retrieveEvidence(question, detectedCards, detectedTopics, snapshot).slice(0, 10);
        }
      } catch (error) {
        resolutionWarnings.push(`卡名解析失败，已使用本地匹配结果：${formatError(error)}`);
      }
    }
  }

  if (detectedCards.length) {
    try {
      const liveCards = await resolveCardsFromDetectedCards(detectedCards, snapshot.cards, env);
      if (liveCards.length) {
        resolutionNotes.push("部分卡片已补充实时 FAQ 索引。");
        detectedCards = mergeCards(detectedCards, liveCards);
      }
      const liveEvidence = await loadLiveEvidenceForCards(detectedCards, env);
      if (liveEvidence.length) {
        evidence = rankEvidenceRecords([...evidence, ...liveEvidence], question, detectedCards, detectedTopics).slice(0, 10);
      }
    } catch (error) {
      resolutionWarnings.push(`实时 FAQ 查询失败，已使用当前资料：${formatError(error)}`);
    }
  }

  const baseAnswer = buildEvidenceAnswer({
    question,
    detectedCards,
    topics: detectedTopics,
    chainItems,
    evidence,
    snapshotMeta: snapshot.meta,
  });
  baseAnswer.cards = buildCardSummaries(detectedCards);
  if (resolutionWarnings.length) baseAnswer.warnings = [...(baseAnswer.warnings || []), ...resolutionWarnings];
  if (resolutionNotes.length && baseAnswer.mode !== "confirmed") {
    baseAnswer.needsConfirmation = [...new Set([...(baseAnswer.needsConfirmation || []), ...resolutionNotes])];
  }

  const hasExactRuling = evidence.some((item) => isRulingEvidence(item) && item.matchKind === "direct");
  if (!evidence.length || options.useModel === false || (hasExactRuling && env.MODEL_ON_DIRECT_RULINGS !== "true")) return baseAnswer;

  try {
    const modelAnswer = await buildModelAnswer(
      {
        question,
        detectedCards,
        topics: detectedTopics,
        chainItems,
        evidence,
        snapshotMeta: snapshot.meta,
      },
      env
    );

    if (!modelAnswer) return baseAnswer;
    return mergeModelAnswer(modelAnswer, baseAnswer, evidence, snapshot.meta);
  } catch (error) {
    return {
      ...baseAnswer,
      warnings: [...(baseAnswer.warnings || []), `模型回答失败，已使用资料检索结果：${formatError(error)}`],
    };
  }
}

export async function loadSnapshot(dataDir = defaultDataDir) {
  const cacheKey = dataDir;
  const cached = snapshotCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < 30_000) return cached.snapshot;

  const [cardsPayload, rulingsPayload, metaPayload] = await Promise.all([
    readJson(join(dataDir, "cards.json"), { records: [] }),
    readJson(join(dataDir, "rulings.json"), { records: [] }),
    readJson(join(dataDir, "snapshot-meta.json"), { generatedAt: null, sources: [] }),
  ]);

  const snapshot = {
    cards: normalizeCards(cardsPayload.records || cardsPayload.cards || []),
    records: normalizeRecords(rulingsPayload.records || rulingsPayload.rulings || rulingsPayload.notes || []),
    meta: metaPayload,
  };

  snapshotCache.set(cacheKey, { loadedAt: Date.now(), snapshot });
  return snapshot;
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

  const exactRuling = evidence.find((item) => isRulingEvidence(item) && item.matchKind === "direct");
  if (exactRuling) {
    return {
      schemaVersion: 1,
      mode: "confirmed",
      verdictTitle: "找到直接问答资料",
      verdict: exactRuling.conclusion,
      confidence: { label: freshnessLabel(snapshotMeta, "已确认资料"), value: freshnessValue(snapshotMeta, 84), className: "is-confirmed" },
      steps: exactRuling.steps?.length ? exactRuling.steps : ["按命中的问答资料处理。", "若场面条件不同，继续核对原文和相关 Q&A。"],
      needsConfirmation: buildNeedsConfirmation(context, false),
      sources,
      snapshotAt: snapshotMeta?.generatedAt || null,
      evidenceCount: evidence.length,
      warnings: [],
    };
  }

  const analogousRuling = evidence.find((item) => isRulingEvidence(item));
  if (analogousRuling) {
    return {
      schemaVersion: 1,
      mode: "inferred",
      verdictTitle: "找到相似问答资料",
      verdict:
        `没有命中完全同场面的问答。可作为类推依据的资料结论是：${analogousRuling.conclusion}`,
      confidence: { label: "类推依据", value: freshnessValue(snapshotMeta, 62), className: "" },
      steps: [
        "先确认题目与相似问答的共通结构：触发事件、适用时点、效果处理期间、对象或适用范围。",
        "再核对差异点是否会改变裁定；差异未排除前不能标记为已确认裁定。",
        ...(analogousRuling.steps?.length ? analogousRuling.steps.slice(0, 2) : ["需要模型或人工把相似问答迁移到当前场面。"]),
      ],
      needsConfirmation: buildNeedsConfirmation(context, false, analogousRuling),
      sources,
      snapshotAt: snapshotMeta?.generatedAt || null,
      evidenceCount: evidence.length,
      warnings: [],
    };
  }

  return {
    schemaVersion: 1,
    mode: "unknown",
    verdictTitle: "只找到相关卡片文本",
    verdict:
      "后端识别到了相关卡片和效果文本，但没有命中能直接回答这个场面的 Q&A 或 FAQ。不能把效果文本直接当作确定裁定。",
    confidence: { label: "缺少问答出处", value: 45, className: "is-risky" },
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

function mergeModelAnswer(modelAnswer, baseAnswer, evidence, snapshotMeta) {
  const hasExactRuling = evidence.some((item) => isRulingEvidence(item) && item.matchKind === "direct");
  const confidenceMode = hasExactRuling ? modelAnswer.confidence : downgradeConfidence(modelAnswer.confidence);
  const confidence = confidenceFromMode(confidenceMode, snapshotMeta);

  return {
    ...baseAnswer,
    mode: confidenceMode,
    verdictTitle: cleanText(modelAnswer.verdictTitle) || baseAnswer.verdictTitle,
    verdict: cleanText(modelAnswer.verdict) || baseAnswer.verdict,
    confidence,
    steps: cleanList(modelAnswer.steps, baseAnswer.steps),
    needsConfirmation: cleanList(modelAnswer.needsConfirmation, baseAnswer.needsConfirmation),
    modelUsed: true,
    modelProvider: modelAnswer.provider || "unknown",
    modelName: modelAnswer.model || null,
  };
}

function retrieveEvidence(question, detectedCards, detectedTopics, snapshot) {
  if (!detectedCards.length) return [];

  const textMatches = detectedCards
    .filter((card) => card.effectText)
    .map((card) => ({
      id: `card-effect-${card.id || card.name}`,
      recordType: "card-text",
      title: `${card.name} 的效果文本`,
      status: "confirmed",
      cards: [card.name],
      keywords: [],
      conclusion: card.effectText,
      steps: ["这是同步到的卡片效果文本。若问题涉及具体裁定处理，仍应继续核对 Q&A 或规则条目。"],
      sources: card.sourceUrl ? [{ label: "YGOResources Card data", detail: card.sourceUrl }] : [],
      updatedAt: card.updatedAt || "",
      score: 6,
    }));

  return rankEvidenceRecords([...snapshot.records, ...textMatches], question, detectedCards, detectedTopics)
    .sort((a, b) => b.score - a.score)
    .slice(0, 16);
}

function rankEvidenceRecords(records, question, detectedCards, detectedTopics) {
  if (!detectedCards.length) return [];

  const cardKeys = new Set(
    detectedCards.flatMap((card) => [card.id, card.passcode, card.liveId, card.name, card.cnName, card.jaName, card.enName, card.matched, ...(card.aliases || [])].filter(Boolean).map(normalizeKey))
  );
  const tokens = tokenize(question);

  return dedupeBy(
    records
      .map((record) => {
        const score = scoreRecord(record, cardKeys, detectedTopics, tokens);
        return score > 0 ? { ...record, score, ...classifyEvidenceMatch(record, question, detectedCards, tokens) } : null;
      })
      .filter(Boolean),
    (item) => item.id || `${item.title}:${item.conclusion}`
  ).sort((a, b) => b.score - a.score);
}

function classifyEvidenceMatch(record, question, detectedCards, tokens) {
  if (!isRulingEvidence(record)) {
    return { matchKind: record.recordType === "card-text" ? "card-text" : "support", matchScore: 0, matchedCardCount: 0 };
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
  const exactEnough =
    matchedCardCount > 0 &&
    (similarity >= 0.58 ||
      (tokenHits >= 5 && tokenRatio >= 0.28) ||
      (cardRatio >= 0.8 && tokenHits >= 3 && tokenRatio >= 0.18));

  return {
    matchKind: exactEnough ? "direct" : "analogous",
    matchScore: Math.round(Math.max(similarity, tokenRatio) * 100),
    matchedCardCount,
  };
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

function scoreRecord(record, cardKeys, detectedTopics, tokens) {
  const recordCardKeys = new Set((record.cards || []).map(normalizeKey));
  const hasCardMatch = [...recordCardKeys].some((key) => cardKeys.has(key));

  const keywordText = [...(record.keywords || []), record.title || ""].map(normalizeKey).join(" ");
  let topicHits = 0;
  for (const topic of detectedTopics) {
    if (topic.keywords.some((keyword) => keywordText.includes(normalizeKey(keyword)))) topicHits += 1;
  }

  const haystack = normalizeKey(`${record.title || ""} ${record.conclusion || ""} ${(record.keywords || []).join(" ")}`);
  const tokenHits = tokens.filter((token) => token.length >= 2 && haystack.includes(token)).length;

  if (!hasCardMatch) {
    if (!isRulingEvidence(record)) return 0;
    if (topicHits < 2 || tokenHits < 4) return 0;
    return 10 + topicHits * 2 + Math.min(6, tokenHits);
  }

  let score = 20;
  if (record.recordType === "qa") score += 10;
  if (record.recordType === "card-faq") score += 8;
  if (record.recordType === "card-text") score += 1;
  if (record.status === "confirmed") score += 3;
  score += topicHits * 2;
  score += Math.min(8, tokenHits);
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
      keywords: record.keywords || [],
      conclusion: record.conclusion || record.answer || "",
      steps: record.steps || [],
      questions: record.questions || [],
      sources: record.sources || sourceFromRecord(record),
      updatedAt: record.updatedAt || record.lastModified || "",
    }))
    .filter((record) => record.conclusion);
}

function inferRecordType(record) {
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

  for (const match of normalized.matchAll(/([A-Za-z0-9\u3040-\u30ff\u3400-\u9fff・･☆★－ー\-\s]{2,34}(?:世界|姬|姫|龙|龍|王国|王國|御巫|土像|落胤|小夜|アドラ|ハヤテ|カガリ|ロゼ|レイ))/gu)) {
    addCandidate(candidates, match[1], "card-like-phrase");
  }

  return {
    cards: dedupeBy(candidates, (item) => normalizeKey(item.input))
      .sort((left, right) => cardCandidatePriority(right) - cardCandidatePriority(left))
      .slice(0, 8),
  };
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
  const sourceScore = item.source === "quoted-name" ? 100 : item.source === "effect-owner" ? 80 : 40;
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

async function resolveCardsFromLiveSources(resolution, existingCards, env) {
  if (!resolution?.cards?.length) return [];
  const languages = String(env.CARD_RESOLUTION_LANGUAGES || "ja,en")
    .split(",")
    .map((language) => language.trim())
    .filter(Boolean);

  const indexResults = await Promise.allSettled(languages.map((language) => loadLiveNameIndex(language)));
  const indexes = indexResults.filter((result) => result.status === "fulfilled").map((result) => result.value);
  if (!indexes.length) return [];
  const cards = [];
  const existingIds = new Set(existingCards.map((card) => String(card.id || "")));

  for (const item of resolution.cards) {
    const id = findLiveCardId([item.input, ...(item.candidates || [])], indexes);
    if (!id || existingIds.has(String(id))) continue;
    const card = await loadLiveCard(id, [item.input, ...(item.candidates || [])]).catch(() => null);
    if (card) cards.push({ ...card, matched: item.input || card.name, resolvedBy: "live-ygoresources" });
  }

  return mergeCards(...cards);
}

async function resolveCardsFromDetectedCards(detectedCards, existingCards, env) {
  const resolution = {
    cards: detectedCards.map((card) => ({
      input: card.matched || card.name,
      candidates: cardAliases(card),
      confidence: "high",
    })),
  };
  return resolveCardsFromLiveSources(resolution, existingCards, env);
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
      id: `live-card-faq-${card.liveId || card.id}-${effectNo}`,
      recordType: "card-faq",
      title: `${card.name} FAQ ${effectNo}`,
      question: "",
      status: "confirmed",
      cards: cardAliases(card),
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
    id: `live-ygoresources-qa-${id}`,
    recordType: "qa",
    title: truncate(cleanText(question).replace(/\s+/g, " "), 90),
    question: cleanText(question),
    status: "confirmed",
    cards: [...new Set(cards)],
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
  return [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].filter(Boolean);
}

function mergeCards(...groups) {
  const flat = groups.flat().filter(Boolean);
  const map = new Map();
  for (const card of flat) {
    const key = card.passcode || card.id || card.name;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, card);
      continue;
    }
    existing.matched = longerText(existing.matched, card.matched);
    existing.resolvedBy = existing.resolvedBy || card.resolvedBy;
    existing.resolutionConfidence = existing.resolutionConfidence || card.resolutionConfidence;
    existing.effectText = existing.effectText || card.effectText;
    existing.passcode = existing.passcode || card.passcode;
    existing.liveId = existing.liveId || card.liveId || (card.resolvedBy === "live-ygoresources" ? card.id : "");
    existing.cnName = existing.cnName || card.cnName;
    existing.jaName = existing.jaName || card.jaName;
    existing.enName = existing.enName || card.enName;
    existing.cardType = existing.cardType || card.cardType;
    existing.ygoResourcesUrl = existing.ygoResourcesUrl || card.ygoResourcesUrl || (/db\.ygoresources\.com\/data\/card\//.test(card.sourceUrl || "") ? card.sourceUrl : "");
    existing.sourceUrl = existing.sourceUrl || card.sourceUrl;
    existing.aliases = [...new Set([...(existing.aliases || []), ...(card.aliases || [])].filter(Boolean))];
  }
  return [...map.values()];
}

function buildCardSummaries(cards) {
  return cards.map((card) => ({
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

function buildUnknownAnswer(verdictTitle, verdict, steps, needsConfirmation, snapshotMeta) {
  return {
    schemaVersion: 1,
    mode: "unknown",
    verdictTitle,
    verdict,
    confidence: { label: "不能确定", value: 18, className: "is-risky" },
    steps,
    needsConfirmation,
    sources: [],
    snapshotAt: snapshotMeta?.generatedAt || null,
    evidenceCount: 0,
    warnings: [],
  };
}

function shouldResolveCardNamesWithModel(env) {
  const mode = String(env.MODEL_CARD_RESOLUTION || "auto").toLowerCase();
  return !["0", "false", "off", "none", "disabled"].includes(mode);
}

function confidenceFromMode(mode, snapshotMeta) {
  if (mode === "confirmed") {
    return { label: freshnessLabel(snapshotMeta, "已确认资料"), value: freshnessValue(snapshotMeta, 86), className: "is-confirmed" };
  }
  if (mode === "inferred") {
    return { label: "类推/规则推理", value: freshnessValue(snapshotMeta, 62), className: "" };
  }
  return { label: "不能确定", value: 30, className: "is-risky" };
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
