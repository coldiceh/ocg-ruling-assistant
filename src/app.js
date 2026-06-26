"use strict";

const baseCardIndex = [
  {
    name: "闪刀姬-零衣",
    aliases: ["闪刀姬-零衣", "零衣", "零一", "Raye", "閃刀姫－レイ"],
    note: "俗称可能写成零一，建议核对正式卡名。",
  },
  {
    name: "闪刀姬-露世",
    aliases: ["闪刀姬-露世", "露世", "Roze", "閃刀姫－ロゼ"],
  },
  {
    name: "闪刀姬-燎里",
    aliases: ["闪刀姬-燎里", "燎里", "火刀", "Kagari", "閃刀姫－カガリ"],
  },
  {
    name: "闪刀姬-飒天",
    id: "08491308",
    passcode: "08491308",
    aliases: ["闪刀姬-飒天", "闪刀姬飒天", "飒天", "风刀", "Hayate", "閃刀姫－ハヤテ", "閃刀姫-ハヤテ"],
  },
  {
    name: "闪刀姬-阿泽莉娅",
    aliases: ["闪刀姬-阿泽莉娅", "阿泽莉娅", "亚式", "亚泽莉娅", "Azalea"],
    note: "此俗称可能对应不同译名，最好用正式中文名或日文名确认。",
  },
  {
    name: "三战之才",
    aliases: ["三战之才", "三战", "Triple Tactics Talent"],
  },
  {
    name: "青眼混沌极龙",
    aliases: ["青眼混沌极龙", "混沌极龙", "Chaos MAX", "Blue-Eyes Chaos MAX Dragon"],
  },
  {
    name: "脆刃之剑",
    aliases: ["脆刃之剑", "脆刃", "Double-Edged Sword"],
  },
  {
    name: "大日女之御巫",
    aliases: ["大日女之御巫", "大日女", "御巫", "Ohime"],
  },
  {
    name: "破械 Link-4",
    aliases: ["破械新link4", "破械新 Link4", "破械link4", "破械 Link4", "新link4", "新 Link4"],
    note: "这是描述，不是正式卡名。需要确认具体是哪张破械连接怪兽。",
    vague: true,
  },
  {
    name: "阿不思的落胤",
    aliases: ["阿不思", "阿不思的落胤", "阿尔白斯之落胤", "落胤", "Fallen of Albaz"],
  },
  {
    name: "完美世界 卡通世界",
    id: "07293697",
    passcode: "07293697",
    aliases: ["完美世界 卡通世界", "完美世界卡通世界", "完美世界-卡通世界", "Perfect Toon World", "パーフェクト・トゥーン・ワールド"],
  },
];

const topicIndex = [
  { id: "activation", label: "能否发动", keywords: ["能否发动", "可以发动", "发动②", "发动2", "发动效果", "诱发"] },
  { id: "chain", label: "连锁处理", keywords: ["C1", "C2", "连锁", "处理完", "这时"] },
  { id: "control", label: "控制权变更", keywords: ["获得控制权", "控制权", "夺取"] },
  { id: "battle", label: "战斗伤害", keywords: ["攻击", "守备表示", "战斗伤害", "伤害计算", "攻击力"] },
  { id: "replacement", label: "代替破坏", keywords: ["代破", "代替破坏", "破坏代替"] },
  { id: "spelltrap", label: "魔法陷阱状态", keywords: ["表侧发动中", "魔法陷阱", "永续", "场地", "装备"] },
];

const builtInNotes = [
  {
    id: "template-chain-trigger-control",
    title: "连锁处理后检查诱发与发动条件",
    status: "needs-source",
    cards: ["闪刀姬-零衣", "闪刀姬-燎里", "闪刀姬-阿泽莉娅", "三战之才"],
    keywords: ["连锁", "控制权", "墓地", "能否发动", "诱发", "连接召唤"],
    conclusion:
      "当前资料库资料不足，不能给确定裁定。应在 C2 与 C1 全部处理完后，核对墓地效果的触发事件、发动位置、控制者要求和每回合次数。",
    steps: [
      "按逆顺处理连锁：先处理 C2，再处理 C1。",
      "记录连接召唤成功时的怪兽、召唤成功后的控制者，以及随后控制权变更的时点。",
      "连锁全部处理完后，只检查此时满足条件且可以发动的效果。",
      "比对墓地效果②的完整文本：触发事件、发动位置、是否要求自己场上或自己怪兽、是否错过时点。",
    ],
    questions: [
      "“亚式”具体是哪张卡的哪个译名？",
      "墓地效果②的完整文本是什么？这个回合是否已经使用过？",
      "连接召唤成功后是否还有其他效果进入同一触发窗口？",
    ],
    sources: [
      {
        label: "本地规则模板",
        detail: "用于拆解连锁和诱发窗口，需补官方数据库或事务局出处。",
      },
    ],
  },
  {
    id: "template-mikanko-chaos-max",
    title: "多重战斗伤害适用项需要逐项结算",
    status: "needs-source",
    cards: ["青眼混沌极龙", "脆刃之剑", "大日女之御巫"],
    keywords: ["攻击", "守备表示", "战斗伤害", "伤害计算", "双方受到", "御巫"],
    conclusion:
      "这是高风险伤害计算题。没有录入官方条目前，不应只凭口算给最终数值；需要先确认守备力、装备状态、伤害转移与双方承受伤害的适用顺序。",
    steps: [
      "确认被攻击怪兽的当前守备力，以及装备卡是否仍然适用。",
      "判断攻击守备表示怪兽时是否产生穿防战斗伤害，以及是否有倍化处理。",
      "确认“自己将受到的战斗伤害由对方受到”和“双方受到战斗伤害”是否同时适用。",
      "若没有官方同类裁定，应记录为待确认，并避免把推定结论写成确定裁定。",
    ],
    questions: [
      "大日女之御巫的守备力是多少？题目中 2000 是攻击力提升后的数值，还是误写为守备力？",
      "双方是否还有其他伤害变更、伤害归零、不能战破等效果适用？",
      "是否已有官方数据库 Q&A 或店内记录可引用？",
    ],
    sources: [
      {
        label: "本地规则模板",
        detail: "用于标记伤害计算风险，需补官方数据库 Q&A。",
      },
    ],
  },
  {
    id: "template-replacement-face-up-spelltrap",
    title: "代替破坏必须确认卡片状态和代破文本",
    status: "needs-source",
    cards: ["破械 Link-4"],
    keywords: ["代破", "表侧发动中", "魔法陷阱", "发动中的卡", "破坏"],
    conclusion:
      "仅凭“破械新 Link4”和“表侧发动中”无法下结论。需要确认代破效果的完整文本，以及那张魔法/陷阱是正在连锁上的卡，还是已经表侧存在的永续、场地、装备等卡。",
    steps: [
      "先确认破械连接怪兽的正式卡名和代替破坏效果原文。",
      "再确认被问到的魔法/陷阱当前是否仍在场上，是否会被某个效果破坏。",
      "若是正在连锁处理的通常魔法/陷阱，需额外确认该卡在处理时是否仍能作为代替破坏对象或适用范围。",
      "按代破文本判断：是否要求“场上的卡”“表侧表示卡”“自己场上的卡”或指定卡种。",
    ],
    questions: [
      "破械新 Link4 的正式卡名是什么？",
      "被代掉的是通常魔法/陷阱、速攻魔法，还是永续/场地/装备/表侧陷阱？",
      "这张魔法/陷阱是被什么效果破坏？是在同一连锁中还是已经表侧存在？",
    ],
    sources: [
      {
        label: "本地规则模板",
        detail: "用于拆分“发动中的卡”和“场上表侧卡”的歧义。",
      },
    ],
  },
];

const ui = {
  questionInput: document.querySelector("#questionInput"),
  analyzeButton: document.querySelector("#analyzeButton"),
  clearButton: document.querySelector("#clearButton"),
  resultGrid: document.querySelector("#resultGrid"),
  confidenceText: document.querySelector("#confidenceText"),
  verdictBlock: document.querySelector(".verdict-block"),
  verdictTitle: document.querySelector("#verdictTitle"),
  rulingBasisText: document.querySelector("#rulingBasisText"),
  verdictBody: document.querySelector("#verdictBody"),
  subAnswersPanel: document.querySelector("#subAnswersPanel"),
  parserDebugPanel: document.querySelector("#parserDebugPanel"),
  parserDebugOutput: document.querySelector("#parserDebugOutput"),
  modelStatusText: document.querySelector("#modelStatusText"),
  stepsList: document.querySelector("#stepsList"),
  questionsList: document.querySelector("#questionsList"),
  sourcesList: document.querySelector("#sourcesList"),
  sourceStatus: document.querySelector("#sourceStatus"),
  statusDot: document.querySelector(".status-dot"),
  syncInfo: document.querySelector("#syncInfo"),
  cardPanel: document.querySelector("#cardPanel"),
  cardTabs: document.querySelector("#cardTabs"),
  cardStatus: document.querySelector("#cardStatus"),
  cardPreview: document.querySelector("#cardPreview"),
  cardImage: document.querySelector("#cardImage"),
  cardImagePlaceholder: document.querySelector("#cardImagePlaceholder"),
  cardName: document.querySelector("#cardName"),
  cardMeta: document.querySelector("#cardMeta"),
  cardEffect: document.querySelector("#cardEffect"),
  cardSourceLink: document.querySelector("#cardSourceLink"),
};

let appConfig = { answerApiUrl: "", modelLabel: "" };
let syncedCards = [];
let syncedNotes = [];
let sourceMeta = null;
let sourceLoadError = "";
let analysisRequestId = 0;
let analysisTimer = 0;
const backendAnswerCacheTtlMs = 6 * 60 * 60 * 1000;
const cardDetailsCache = new Map();
let visibleCards = [];
let selectedCardIndex = 0;
let lastRenderedBackendAnswer = null;

function normalizeText(value) {
  return String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[－ー]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function allNotes() {
  return [...syncedNotes, ...builtInNotes];
}

function allCards() {
  const merged = new Map();
  for (const card of [...syncedCards, ...baseCardIndex]) {
    const existing = merged.get(card.name);
    if (!existing) {
      merged.set(card.name, { ...card, aliases: [...new Set(card.aliases || [card.name])] });
    } else {
      existing.aliases = [...new Set([...(existing.aliases || []), ...(card.aliases || [])])];
      existing.note = existing.note || card.note;
      existing.vague = existing.vague || card.vague;
      existing.id = existing.id || card.id;
      existing.passcode = existing.passcode || card.passcode;
      existing.effectText = existing.effectText || card.effectText;
      existing.cardType = existing.cardType || card.cardType;
    }
  }
  return [...merged.values()];
}

async function loadSyncedData() {
  try {
    const cardsUrl = appConfig.answerApiUrl ? "data/cards-lite.json" : "data/cards.json";
    const [cardsPayload, rulingsPayload, metaPayload] = await Promise.all([
      readJson(cardsUrl).catch(() => ({ records: [] })),
      appConfig.answerApiUrl ? Promise.resolve({ records: [] }) : readJson("data/rulings.json"),
      readJson("data/snapshot-meta.json"),
    ]);

    syncedCards = normalizeCardRecords(cardsPayload);
    syncedNotes = normalizeRulingRecords(rulingsPayload);
    sourceMeta = normalizeSourceMeta(metaPayload);
  } catch (error) {
    sourceLoadError = error instanceof Error ? error.message : String(error);
    syncedCards = [];
    syncedNotes = [];
    sourceMeta = {
      status: "unavailable",
      generatedAt: null,
      freshnessDays: 0,
      sources: [],
    };
  }
}

async function loadAppConfig() {
  const payload = await readOptionalJson("config.json");
  if (!payload) return;
  appConfig = {
    answerApiUrl: String(payload.answerApiUrl || "").trim(),
    modelLabel: "",
  };
}

async function loadBackendModelInfo() {
  if (!appConfig.answerApiUrl) return;
  try {
    const response = await fetch(appConfig.answerApiUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`model info ${response.status}`);
    const info = await response.json();
    appConfig.modelLabel = formatModelInfo(info);
  } catch {
    appConfig.modelLabel = "后端自动选择";
  }
}

function formatModelInfo(info) {
  if (!info?.enabled) return "资料检索";
  const provider = modelProviderLabel(info.provider);
  const models = Array.isArray(info.models) ? info.models.filter(Boolean) : [];
  if (!models.length) return provider;
  if (models.length === 1) return `${provider} · ${models[0]}`;
  return `${provider} · ${models[0]} 等 ${models.length} 个`;
}

async function readJson(url) {
  const response = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

async function readOptionalJson(url) {
  try {
    return await readJson(url);
  } catch {
    return null;
  }
}

function normalizeCardRecords(payload) {
  const records = payload?.records || payload?.cards || [];
  return records
    .map((record) => ({
      id: record.id || record.passcode || "",
      passcode: record.passcode || "",
      name: record.name || record.primaryName || record.cnName || record.jaName || record.enName,
      cnName: record.cnName || "",
      jaName: record.jaName || "",
      enName: record.enName || "",
      aliases: [
        record.name,
        record.primaryName,
        record.cnName,
        record.jaName,
        record.enName,
        ...(record.aliases || []),
      ].filter(Boolean),
      note: record.note || "",
      vague: Boolean(record.vague),
      cardType: record.cardType || "",
      effectText: record.effectText || "",
      sourceUrl: record.sourceUrl || "",
    }))
    .filter((record) => record.name);
}

function normalizeRulingRecords(payload) {
  const records = payload?.records || payload?.rulings || payload?.notes || [];
  return records
    .map((record) => ({
      id: record.id || record.sourceId || `synced-${Math.random().toString(36).slice(2)}`,
      title: record.title || "未命名裁定",
      status: record.status || "confirmed",
      cards: record.cards || [],
      keywords: record.keywords || [],
      conclusion: record.conclusion || record.answer || "该条目缺少结论文本。",
      steps: record.steps || [],
      questions: record.questions || [],
      sources: Array.isArray(record.sources) && record.sources.length ? record.sources : sourceFromSyncedRecord(record),
      updatedAt: record.updatedAt || record.lastModified || "",
      recordType: record.recordType || inferRecordType(record),
    }))
    .filter((record) => record.title && record.conclusion);
}

function inferRecordType(record) {
  if (String(record.id || "").startsWith("card-text-") || /效果文本/.test(record.title || "")) return "card-text";
  if (String(record.id || "").startsWith("card-faq-") || /FAQ/.test(record.title || "")) return "card-faq";
  if (String(record.id || "").includes("qa")) return "qa";
  return "note";
}

function sourceFromSyncedRecord(record) {
  const sources = [];
  if (record.officialUrl) sources.push({ label: "官方数据库", detail: record.officialUrl });
  if (record.sourceUrl) sources.push({ label: record.sourceName || "同步来源", detail: record.sourceUrl });
  if (!sources.length) sources.push({ label: "同步资料", detail: "缺少来源链接，不能视作最终裁定。" });
  return sources;
}

function normalizeSourceMeta(payload) {
  return {
    status: payload?.status || "seed",
    generatedAt: payload?.generatedAt || null,
    freshnessDays: Number(payload?.freshnessDays || 7),
    sourceRevision: payload?.sourceRevision || null,
    sources: payload?.sources || [],
    warnings: payload?.warnings || [],
  };
}

function updateSourceStatus() {
  const freshness = getFreshness();
  ui.statusDot.className = `status-dot ${freshness.className}`.trim();
  if (appConfig.answerApiUrl && sourceMeta?.generatedAt) {
    ui.sourceStatus.textContent = `后端模式 · ${formatDateTime(sourceMeta.generatedAt)}`;
  } else if (appConfig.answerApiUrl) {
    ui.sourceStatus.textContent = "后端模式";
  } else if (sourceMeta?.generatedAt) {
    ui.sourceStatus.textContent = `资料库已同步 · ${formatDateTime(sourceMeta.generatedAt)}`;
  } else {
    ui.sourceStatus.textContent = "资料库准备中";
  }
  renderSyncInfo(freshness);
}

function getFreshness() {
  if (sourceLoadError) {
    return {
      label: "读取失败",
      className: "is-error",
      detail: "没有读取到同步快照，当前只使用保守模板。",
    };
  }

  if (!sourceMeta?.generatedAt) {
    return {
      label: "种子资料",
      className: "is-stale",
      detail: "还没有自动同步时间戳。上线后请启用 GitHub Actions 定时同步。",
    };
  }

  const generatedAt = new Date(sourceMeta.generatedAt);
  const ageMs = Date.now() - generatedAt.getTime();
  const freshnessMs = sourceMeta.freshnessDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(generatedAt.getTime())) {
    return {
      label: "时间异常",
      className: "is-error",
      detail: "快照时间戳无法解析，不能视作新资料。",
    };
  }

  if (ageMs > freshnessMs) {
    return {
      label: "已过期",
      className: "is-stale",
      detail: `快照超过 ${sourceMeta.freshnessDays} 天未更新，高风险裁定需要重新查官方资料。`,
    };
  }

  return {
    label: "已同步",
    className: "is-fresh",
    detail: `快照生成于 ${formatDateTime(sourceMeta.generatedAt)}。`,
  };
}

function renderSyncInfo(freshness) {
  if (!ui.syncInfo) return;
  clearElement(ui.syncInfo);
  ui.syncInfo.className = "sync-info";

  const summary = document.createElement("div");
  summary.className = "sync-card";
  appendText(summary, "strong", freshness.label);
  appendText(summary, "p", freshness.detail);
  if (sourceMeta?.sourceRevision) appendText(summary, "p", `来源 revision：${sourceMeta.sourceRevision}`);
  if (sourceLoadError) appendText(summary, "p", sourceLoadError);
  ui.syncInfo.appendChild(summary);

  for (const source of sourceMeta?.sources || []) {
    const node = document.createElement("div");
    node.className = "sync-card";
    appendText(node, "strong", source.name || source.id || "资料来源");
    if (source.url) {
      const link = document.createElement("a");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = source.url;
      node.appendChild(link);
    }
    if (source.role) appendText(node, "p", source.role);
    ui.syncInfo.appendChild(node);
  }

  for (const warning of sourceMeta?.warnings || []) {
    const node = document.createElement("div");
    node.className = "sync-card";
    appendText(node, "strong", "提醒");
    appendText(node, "p", warning);
    ui.syncInfo.appendChild(node);
  }
}

function formatDateTime(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getDetectedCards(text) {
  const normalized = normalizeText(text).toLowerCase();
  return allCards()
    .map((card) => {
      const alias = card.aliases
        .slice()
        .sort((a, b) => b.length - a.length)
        .find((item) => normalized.includes(normalizeText(item).toLowerCase()));
      return alias ? { ...card, matched: alias } : null;
    })
    .filter(Boolean);
}

function getDetectedTopics(text) {
  const normalized = normalizeText(text).toLowerCase();
  return topicIndex.filter((topic) =>
    topic.keywords.some((keyword) => normalized.includes(normalizeText(keyword).toLowerCase()))
  );
}

function getChainItems(text) {
  const normalized = normalizeText(text);
  const matches = [...normalized.matchAll(/\bC\s*([0-9]+)\s*(?:发动|连锁发动)?([^，。；;\n]*)/gi)];
  return matches
    .map((match) => ({
      number: Number(match[1]),
      content: match[2].trim() || "未识别动作",
    }))
    .sort((a, b) => a.number - b.number);
}

function tokenize(text) {
  return normalizeText(text)
    .toLowerCase()
    .split(/[\s,，.。;；:：、"「」『』()（）/]+/)
    .filter((part) => part.length >= 2);
}

function scoreNote(note, detectedCards, detectedTopics, textTokens) {
  let score = 0;
  const cardNames = new Set(detectedCards.map((card) => card.name));
  const topicLabels = new Set(detectedTopics.map((topic) => topic.label));

  for (const card of note.cards || []) {
    if (cardNames.has(card)) score += 4;
  }

  for (const keyword of note.keywords || []) {
    const normalizedKeyword = normalizeText(keyword).toLowerCase();
    if (textTokens.some((token) => token.includes(normalizedKeyword) || normalizedKeyword.includes(token))) {
      score += 1;
    }
  }

  for (const tag of note.tags || []) {
    if (topicLabels.has(tag)) score += 1;
  }

  if (note.status === "confirmed") score += 2;
  if (note.status === "needs-source") score -= 1;
  return score;
}

function findMatches(text, detectedCards, detectedTopics) {
  const tokens = tokenize(text);
  return allNotes()
    .map((note) => ({ note, score: scoreNote(note, detectedCards, detectedTopics, tokens) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function filterRelevantMatches(matches, detectedCards) {
  if (!detectedCards.length) return [];

  const detectedNames = new Set(detectedCards.map((card) => normalizeText(card.name)));
  const detectedAliases = new Set(
    detectedCards.flatMap((card) => [card.name, card.matched, ...(card.aliases || [])].filter(Boolean).map(normalizeText))
  );

  return matches.filter((match) => {
    const cards = match.note.cards || [];
    if (!cards.length) return false;
    return cards.some((cardName) => {
      const normalizedCardName = normalizeText(cardName);
      return detectedNames.has(normalizedCardName) || detectedAliases.has(normalizedCardName);
    });
  });
}

function buildGeneratedQuestions(text, detectedCards, detectedTopics, chainItems, matches) {
  const questions = [];
  const hasVagueCard = detectedCards.some((card) => card.vague);
  const hasActivation = detectedTopics.some((topic) => topic.id === "activation");
  const hasBattle = detectedTopics.some((topic) => topic.id === "battle");
  const hasReplacement = detectedTopics.some((topic) => topic.id === "replacement");
  const bestStatus = matches[0]?.note.status;

  if (hasVagueCard) questions.push("有俗称或描述性卡名，系统会尝试解析；解析不到时再补日文、英文或效果原文。");
  if (hasActivation && chainItems.length === 0) questions.push("如果涉及发动时点，请补充连锁顺序或触发事件。");
  if (hasActivation && /②|2/.test(text)) questions.push("请补充被问效果②的完整文本或官方数据库截图。");
  if (hasBattle) questions.push("请确认攻击目标的守备力，以及所有已经适用的伤害变更效果。");
  if (hasReplacement) questions.push("请确认被破坏的卡在那个时点是否仍在场上，以及代破文本指定的范围。");
  if (!bestStatus || bestStatus === "needs-source") {
    questions.push("资料库没有已确认出处，建议补官方 Q&A、规则书条目或可信记录。");
  }

  return [...new Set(questions)];
}

function confidenceFor(match, generatedQuestions) {
  if (!match) return { label: "无Q&A支持", className: "is-risky" };
  if (match.note.recordType === "card-text") return { label: "仅命中效果文本", className: "is-risky" };
  const freshness = getFreshness();
  if (match.note.status === "confirmed" && match.score >= 7 && generatedQuestions.length <= 1) {
    return {
      label: freshness.className === "is-fresh" ? "高置信" : "需复核",
      className: freshness.className === "is-fresh" ? "is-confirmed" : "is-risky",
    };
  }
  if (match.note.status === "confirmed") {
    return {
      label: freshness.className === "is-fresh" ? "中高置信" : "需复核",
      className: freshness.className === "is-fresh" ? "is-confirmed" : "is-risky",
    };
  }
  return { label: "需要Q&A确认", className: "is-risky" };
}

async function analyzeQuestion() {
  const text = ui.questionInput.value.trim();
  const requestId = ++analysisRequestId;
  if (!text) {
    resetAnalysis();
    return;
  }

  if (appConfig.answerApiUrl) {
    renderPending();
    try {
      const answer = await requestBackendAnswer(text);
      if (requestId !== analysisRequestId) return;
      renderBackendAnswer(answer);
      return;
    } catch (error) {
      if (requestId !== analysisRequestId) return;
      console.warn("Backend answer failed, using static fallback.", error);
    }
  }

  const detectedCards = getDetectedCards(text);
  const detectedTopics = getDetectedTopics(text);
  const chainItems = getChainItems(text);
  const matches = findMatches(text, detectedCards, detectedTopics);
  const relevantMatches = filterRelevantMatches(matches, detectedCards);
  const generatedQuestions = buildGeneratedQuestions(text, detectedCards, detectedTopics, chainItems, relevantMatches);
  const bestMatch = relevantMatches[0];
  const confidence = confidenceFor(bestMatch, generatedQuestions);

  renderResult(text, bestMatch, confidence, generatedQuestions, detectedCards);
}

async function requestBackendAnswer(text) {
  const cacheKey = buildBackendCacheKey(text);
  const cached = readCachedBackendAnswer(cacheKey);
  if (cached) return cached;

  const response = await fetch(appConfig.answerApiUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: text }),
  });
  if (!response.ok) throw new Error(`后端返回 ${response.status}`);
  const answer = await response.json();
  writeCachedBackendAnswer(cacheKey, answer);
  return answer;
}

function buildBackendCacheKey(text) {
  return `ocg-ruling-answer:v11:${appConfig.answerApiUrl}:${normalizeText(text).slice(0, 2000)}`;
}

function readCachedBackendAnswer(key) {
  try {
    const payload = JSON.parse(localStorage.getItem(key) || "null");
    if (!payload || Date.now() - Number(payload.savedAt || 0) > backendAnswerCacheTtlMs) return null;
    return payload.answer || null;
  } catch {
    return null;
  }
}

function writeCachedBackendAnswer(key, answer) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), answer }));
  } catch {
    // Browser storage can be unavailable in private mode; caching is only an optimization.
  }
}

function renderPending() {
  ui.resultGrid.hidden = false;
  renderCards([]);
  updateModelStatus("分析中");
  ui.verdictBlock.className = "result-block verdict-block";
  ui.confidenceText.textContent = "分析中";
  ui.verdictTitle.textContent = "正在检索资料";
  ui.rulingBasisText.textContent = "";
  ui.verdictBody.textContent = "后端正在匹配卡片、问答资料和处理条件。";
  renderSubAnswers([]);
  renderParserDebug(null);
  renderList(ui.stepsList, ["等待后端返回。"]);
  renderList(ui.questionsList, []);
  renderSources([]);
}

function renderBackendAnswer(answer) {
  lastRenderedBackendAnswer = answer || null;
  if (answer?.status === "data_source_missing") {
    ui.resultGrid.hidden = false;
    renderCards([]);
    updateModelStatus("数据源未初始化");
    ui.verdictBlock.className = "result-block verdict-block is-risky";
    ui.confidenceText.textContent = "不可用";
    ui.verdictTitle.textContent = "数据源未初始化";
    ui.rulingBasisText.textContent = "数据加载失败";
    ui.verdictBody.textContent = answer.message || "数据源未初始化，请先运行 node scripts/sync-data.mjs";
    renderSubAnswers([]);
    renderParserDebug({ dataHealth: answer.stats || {} });
    renderList(ui.stepsList, ["运行 node scripts/sync-data.mjs 后重新分析。"]);
    renderList(ui.questionsList, []);
    renderSources([]);
    renderFeedbackPanel(null);
    return;
  }
  const confidence = answer?.confidence || { label: "不能确定", className: "is-risky" };
  ui.resultGrid.hidden = false;
  renderCards(answer?.cards || []);
  updateModelStatus(modelStatusFromAnswer(answer));
  ui.verdictBlock.className = `result-block verdict-block ${confidence.className || ""}`.trim();
  ui.confidenceText.textContent = confidence.label || "不能确定";
  ui.verdictTitle.textContent = answer?.verdictTitle || "后端没有返回结论";
  ui.rulingBasisText.textContent = answer?.rulingBasis || basisFromBackendMode(answer?.mode);
  ui.verdictBody.textContent = answer?.verdict || "暂时不能给确定裁定。";
  renderSubAnswers(answer?.subAnswers || []);
  renderParserDebug(answer?.parserDebug || null);
  renderList(ui.stepsList, answer?.steps || []);
  renderList(ui.questionsList, [...(answer?.needsConfirmation || []), ...(answer?.warnings || [])]);
  renderSources(answer?.sources || []);
  renderFeedbackPanel(answer);
}

function resetAnalysis() {
  lastRenderedBackendAnswer = null;
  ui.resultGrid.hidden = true;
  renderCards([]);
  renderParserDebug(null);
  renderFeedbackPanel(null);
  updateModelStatus(appConfig.answerApiUrl ? appConfig.modelLabel || "后端自动选择" : "本地模板");
}

function renderParserDebug(debug) {
  if (!ui.parserDebugPanel || !ui.parserDebugOutput) return;
  if (!debug) {
    ui.parserDebugPanel.hidden = true;
    ui.parserDebugOutput.textContent = "";
    return;
  }
  ui.parserDebugPanel.hidden = false;
  ui.parserDebugOutput.textContent = JSON.stringify(debug, null, 2);
  console.debug("[Formal Query Trace]", debug);
}

function renderResult(text, bestMatch, confidence, generatedQuestions, detectedCards = []) {
  ui.resultGrid.hidden = false;
  renderCards(detectedCards);
  renderParserDebug(null);
  updateModelStatus("本地模板");
  ui.verdictBlock.className = `result-block verdict-block ${confidence.className}`.trim();

  if (!bestMatch) {
    ui.confidenceText.textContent = confidence.label;
    ui.verdictTitle.textContent = "资料库没有命中";
    ui.rulingBasisText.textContent = "资料不足";
    ui.verdictBody.textContent = "暂时不能给确定裁定。可以继续使用俗称，但需要补一点能帮助识别的线索，例如日文、英文、效果原文或卡片种类。";
    renderSubAnswers([]);
    renderList(ui.stepsList, [
      "补充常用别名、日文/英文片段或效果原文，不必强制输入完整官方卡名。",
      "补全连锁、阶段、表示形式、控制者和效果编号。",
      "用官方数据库、规则书或已确认记录补出处。",
    ]);
    renderList(ui.questionsList, generatedQuestions);
    renderSources([]);
    return;
  }

  const note = bestMatch.note;
  const questions = [...new Set([...(note.questions || []), ...generatedQuestions])];
  ui.confidenceText.textContent = confidence.label;
  if (note.recordType === "card-text") {
    ui.verdictTitle.textContent = "只找到相关卡片文本";
    ui.rulingBasisText.textContent = "缺少直接问答资料";
    ui.verdictBody.textContent =
      "资料库识别到了相关卡片，但没有命中能直接回答这个场面的官方 Q&A 或已确认裁定。不能把效果文本直接当作具体处理结论。";
    renderSubAnswers([]);
    renderList(ui.stepsList, [
      "先核对题目里的俗称对应哪张卡，以及效果编号、连锁和控制者。",
      "再查该卡相关 Q&A 或规则条目。",
      "若没有命中 Q&A，需要进入后端规则推理或人工确认，不能用无关卡片文本套答案。",
    ]);
  } else {
    ui.verdictTitle.textContent = note.status === "confirmed" ? "可以按已确认资料处理" : "按以下方式处理";
    ui.rulingBasisText.textContent = note.status === "confirmed" ? "本地已确认资料" : "本地资料";
    ui.verdictBody.textContent = note.conclusion;
    renderSubAnswers([]);
    renderList(ui.stepsList, note.steps || []);
  }
  renderList(ui.questionsList, questions);
  renderSources(note.sources || []);
}

function renderCards(cards) {
  visibleCards = normalizeVisibleCards(cards);
  selectedCardIndex = 0;
  clearElement(ui.cardTabs);

  if (!visibleCards.length) {
    ui.cardPanel.hidden = true;
    ui.cardPreview.hidden = true;
    ui.cardStatus.textContent = "";
    return;
  }

  ui.cardPanel.hidden = false;
  ui.cardStatus.textContent = `${visibleCards.length} 张`;

  visibleCards.forEach((card, index) => {
    const button = document.createElement("button");
    button.className = `card-tab ${index === selectedCardIndex ? "is-active" : ""}`.trim();
    button.type = "button";
    button.textContent = cardDisplayName(card);
    button.title = card.matched ? `匹配到：${card.matched}` : cardDisplayName(card);
    button.addEventListener("click", () => selectCard(index));
    ui.cardTabs.appendChild(button);
  });

  selectCard(0);
}

function normalizeVisibleCards(cards) {
  const map = new Map();
  for (const card of cards || []) {
    const normalized = {
      id: String(card.id || "").trim(),
      passcode: String(card.passcode || "").trim(),
      name: String(card.name || card.cnName || card.jaName || card.enName || "").trim(),
      cnName: String(card.cnName || "").trim(),
      jaName: String(card.jaName || "").trim(),
      enName: String(card.enName || "").trim(),
      matched: String(card.matched || "").trim(),
      cardType: String(card.cardType || "").trim(),
      effectText: String(card.effectText || "").trim(),
      sourceUrl: String(card.sourceUrl || "").trim(),
      ygoResourcesUrl: String(card.ygoResourcesUrl || "").trim(),
      liveId: String(card.liveId || "").trim(),
      aliases: Array.isArray(card.aliases) ? card.aliases.map((alias) => String(alias || "").trim()).filter(Boolean) : [],
    };
    if (!normalized.name) continue;
    const key = findVisibleMergeKey(map, normalized) || canonicalVisibleCardKey(normalized);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, normalized);
      continue;
    }
    existing.effectText = preferChineseDisplayText(existing.effectText, normalized.effectText);
    existing.matched = existing.matched || normalized.matched;
    existing.cnName = existing.cnName || normalized.cnName;
    existing.jaName = existing.jaName || normalized.jaName;
    existing.enName = existing.enName || normalized.enName;
    existing.name = preferVisibleDisplayName(existing, normalized);
    existing.passcode = existing.passcode || normalized.passcode;
    existing.sourceUrl = existing.sourceUrl || normalized.sourceUrl;
    existing.ygoResourcesUrl = existing.ygoResourcesUrl || normalized.ygoResourcesUrl;
    existing.liveId = existing.liveId || normalized.liveId;
    existing.aliases = [...new Set([...(existing.aliases || []), ...(normalized.aliases || [])])];
  }
  return [...map.values()];
}

function findVisibleMergeKey(map, card) {
  const key = canonicalVisibleCardKey(card);
  if (map.has(key)) return key;
  const keys = visibleCardIdentityKeys(card);
  for (const [existingKey, existing] of map.entries()) {
    const existingKeys = visibleCardIdentityKeys(existing);
    if ([...keys].some((item) => existingKeys.has(item))) return existingKey;
  }
  return "";
}

function canonicalVisibleCardKey(card) {
  const numeric = normalizeCardId(card.passcode || card.id || card.liveId);
  if (numeric) return `id:${numeric}`;
  const sourceId = extractCardIdFromUrl(card.ygoResourcesUrl || card.sourceUrl);
  const normalizedSourceId = normalizeCardId(sourceId);
  if (normalizedSourceId) return `id:${normalizedSourceId}`;
  return `name:${normalizeText(card.name).toLowerCase()}`;
}

function visibleCardIdentityKeys(card) {
  const keys = new Set();
  const numeric = normalizeCardId(card.passcode || card.id || card.liveId);
  if (numeric) keys.add(`id:${numeric}`);
  const sourceId = extractCardIdFromUrl(card.ygoResourcesUrl || card.sourceUrl);
  const normalizedSourceId = normalizeCardId(sourceId);
  if (normalizedSourceId) keys.add(`id:${normalizedSourceId}`);
  for (const alias of [card.name, card.cnName, card.jaName, card.enName, card.matched, ...(card.aliases || [])]) {
    const key = normalizeText(alias).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (key.length >= 3 && !isGenericVisibleAliasKey(key)) keys.add(`alias:${key}`);
  }
  return keys;
}

function preferVisibleDisplayName(existing, card) {
  const candidates = [existing.cnName, card.cnName, existing.name, card.name, existing.jaName, card.jaName, existing.enName, card.enName]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return candidates.find((item) => /[\u3400-\u9fff]/.test(item)) || candidates[0] || "";
}

function preferChineseDisplayText(left, right) {
  const current = String(left || "").trim();
  const next = String(right || "").trim();
  if (!current) return next;
  if (next && /[\u3400-\u9fff]/.test(next) && !/[\u3400-\u9fff]/.test(current)) return next;
  return current;
}

function isGenericVisibleAliasKey(key) {
  return /^(卡通世界|toonworld|トゥーンワールド|闪刀姬|閃刀姫|闪刀|閃刀|时空)$/.test(key);
}

function normalizeCardId(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (!digits) return "";
  return digits.length <= 8 ? digits.padStart(8, "0") : digits;
}

function extractCardIdFromUrl(url) {
  const match = String(url || "").match(/\/(?:card|data\/card)\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function selectCard(index) {
  selectedCardIndex = index;
  const card = visibleCards[index];
  if (!card) return;

  [...ui.cardTabs.querySelectorAll(".card-tab")].forEach((button, buttonIndex) => {
    button.classList.toggle("is-active", buttonIndex === index);
  });

  ui.cardPreview.hidden = false;
  renderCardDetail(card, null, "loading");
  loadCardDetail(card).then((detail) => {
    if (visibleCards[selectedCardIndex] !== card) return;
    renderCardDetail(card, detail, detail ? "ready" : "fallback");
  });
}

async function loadCardDetail(card) {
  const key = card.passcode || card.id || card.name;
  if (cardDetailsCache.has(key)) return cardDetailsCache.get(key);

  const endpoint = getCardApiUrl();
  if (!endpoint) {
    cardDetailsCache.set(key, null);
    return null;
  }

  const url = new URL(endpoint);
  const numericId = card.passcode || (/^\d{7,12}$/.test(card.id) ? card.id : "");
  if (numericId) url.searchParams.set("id", numericId);
  url.searchParams.set("name", card.cnName || card.name);
  if (card.jaName) url.searchParams.set("jaName", card.jaName);
  if (card.enName) url.searchParams.set("enName", card.enName);

  try {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`card api ${response.status}`);
    const detail = await response.json();
    cardDetailsCache.set(key, detail);
    return detail;
  } catch {
    cardDetailsCache.set(key, null);
    return null;
  }
}

function getCardApiUrl() {
  if (!appConfig.answerApiUrl) return "";
  try {
    const url = new URL(appConfig.answerApiUrl);
    url.pathname = url.pathname.replace(/\/api\/answer\/?$/, "/api/card");
    url.search = "";
    return url.toString();
  } catch {
    return appConfig.answerApiUrl.replace(/\/api\/answer\/?$/, "/api/card");
  }
}

function renderCardDetail(card, detail, status) {
  const name = detail?.name || cardDisplayName(card);
  const aliases = detail?.names?.filter((item) => item && item !== name).slice(0, 3) || [card.jaName, card.enName].filter(Boolean);
  const effect = cleanDisplayText(detail?.effectText || card.effectText || "暂未读取到效果文本。");
  const sourceUrl = detail?.sourceUrl || card.sourceUrl || "";

  ui.cardName.textContent = name;
  ui.cardMeta.textContent = [detail?.meta || card.cardType, aliases.length ? aliases.join(" / ") : ""].filter(Boolean).join(" · ");
  ui.cardEffect.textContent = effect;
  ui.cardSourceLink.href = sourceUrl || "#";
  ui.cardSourceLink.hidden = !sourceUrl;
  ui.cardStatus.textContent = status === "loading" ? "读取百鸽中" : `${visibleCards.length} 张`;

  const imageCandidates = detail?.imageCandidates || buildLocalImageCandidates(card);
  setCardImage(imageCandidates, name);
}

function setCardImage(candidates, altText) {
  const uniqueCandidates = [...new Set((candidates || []).filter(Boolean))];
  ui.cardImage.alt = altText ? `${altText} 卡图` : "卡图";
  ui.cardImagePlaceholder.hidden = false;

  if (!uniqueCandidates.length) {
    ui.cardImage.removeAttribute("src");
    ui.cardImage.hidden = true;
    return;
  }

  let index = 0;
  ui.cardImage.hidden = true;
  ui.cardImage.onload = () => {
    ui.cardImage.hidden = false;
    ui.cardImagePlaceholder.hidden = true;
  };
  ui.cardImage.onerror = () => {
    index += 1;
    if (index >= uniqueCandidates.length) {
      ui.cardImage.hidden = true;
      ui.cardImagePlaceholder.hidden = false;
      return;
    }
    ui.cardImage.hidden = true;
    ui.cardImagePlaceholder.hidden = false;
    ui.cardImage.src = uniqueCandidates[index];
  };
  ui.cardImage.src = uniqueCandidates[index];
}

function buildLocalImageCandidates(card) {
  const id = (card.passcode || card.id || "").replace(/\D+/g, "");
  if (!id) return [];
  const normalizedId = id.length <= 8 ? id.padStart(8, "0") : id;
  const compactId = normalizedId.replace(/^0+/, "") || normalizedId;
  return [
    getCardImageApiUrl(normalizedId),
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg!half`,
    `https://cdn.233.momobako.com/ygopro/pics/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${compactId}.webp!half`,
    `https://images.ygoprodeck.com/images/cards/${compactId}.jpg`,
    `https://images.ygoprodeck.com/images/cards_cropped/${compactId}.jpg`,
    `https://images.ygoprodeck.com/images/cards_small/${compactId}.jpg`,
    `https://cdn.233.momobako.com/ygopro/pics/${normalizedId}.jpg`,
    `https://cdn.233.momobako.com/ygopro/pics/${normalizedId}.jpg!half`,
    `https://cdn.233.momobako.com/ygopro/pics/${normalizedId}.jpg!thumb`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${normalizedId}.jpg`,
    `https://cdn.233.momobako.com/ygoimg/ygopro/${normalizedId}.webp!half`,
  ];
}

function getCardImageApiUrl(id) {
  if (!appConfig.answerApiUrl || !id) return "";
  try {
    const url = new URL(appConfig.answerApiUrl);
    url.pathname = url.pathname.replace(/\/api\/answer\/?$/, "/api/card-image");
    url.search = "";
    url.searchParams.set("id", id);
    return url.toString();
  } catch {
    return "";
  }
}

function cleanDisplayText(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\/\s*(p|div|li|tr|section|article)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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

function cardDisplayName(card) {
  return card.cnName || card.name || card.jaName || card.enName || "未命名卡片";
}

function modelStatusFromAnswer(answer) {
  if (answer?.modelUsed) {
    const provider = modelProviderLabel(answer.modelProvider);
    return answer.modelName ? `${provider} · ${answer.modelName}` : provider;
  }
  if (answer?.warnings?.some((item) => /模型回答失败|模型.*不可用/.test(item))) return "资料检索";
  return "资料检索";
}

function modelProviderLabel(provider) {
  const value = String(provider || "").toLowerCase();
  if (value === "gemini") return "Gemini";
  if (value === "openai") return "OpenAI";
  if (value === "ollama") return "Ollama";
  return "模型";
}

function basisFromBackendMode(mode) {
  if (mode === "confirmed") return "找到直接问答资料";
  if (mode === "inferred") return "类推/规则推理";
  return "资料不足";
}

function updateModelStatus(text) {
  if (!ui.modelStatusText) return;
  ui.modelStatusText.textContent = text;
}

function renderSubAnswers(subAnswers) {
  if (!ui.subAnswersPanel) return;
  clearElement(ui.subAnswersPanel);
  const items = Array.isArray(subAnswers)
    ? subAnswers.filter((item) => item?.question || item?.verdict || item?.reasoning || item?.reason || item?.conditionalAnswer || item?.provisionalAnswer)
    : [];
  const shouldShowPanel = items.length > 1 || items.some(hasDetailedSubAnswerDisplay);
  if (!items.length || !shouldShowPanel) {
    ui.subAnswersPanel.hidden = true;
    return;
  }

  ui.subAnswersPanel.hidden = false;
  items.forEach((item, index) => {
    const block = document.createElement("div");
    block.className = "sub-answer";

    const question = document.createElement("div");
    question.className = "sub-q";
    question.textContent = `问题${index + 1}：${item.question || "未命名子问题"}`;
    block.appendChild(question);

    const status = document.createElement("div");
    status.className = "sub-status";
    status.textContent = subAnswerStatusLabel(item);
    block.appendChild(status);

    const verdict = document.createElement("div");
    verdict.className = "sub-verdict";
    verdict.textContent = formatSubAnswerVerdict(item.verdict);
    block.appendChild(verdict);

    const official = document.createElement("p");
    official.className = "sub-reasoning";
    official.textContent = formatOfficialAnswerLine(item);
    block.appendChild(official);

    if (item.reasoning) {
      const reasoning = document.createElement("p");
      reasoning.className = "sub-reasoning";
      reasoning.textContent = publicReasonForSubAnswer(item);
      block.appendChild(reasoning);
    }

    if (!item.reasoning && item.reason) {
      const reason = document.createElement("p");
      reason.className = "sub-reasoning";
      reason.textContent = publicReasonForSubAnswer(item);
      block.appendChild(reason);
    }

    if (item.stateMessage) {
      const stateMessage = document.createElement("p");
      stateMessage.className = "sub-reasoning";
      stateMessage.textContent = item.stateMessage;
      block.appendChild(stateMessage);
    }

    if (item.conditionalAnswer) {
      renderConditionalAnswer(block, item.conditionalAnswer);
    }

    if (item.provisionalAnswer) {
      renderProvisionalAnswer(block, item.provisionalAnswer);
    }

    if (item.likelyAnswer && item.likelyAnswer.status !== "not_available" && !item.provisionalAnswer) {
      renderLikelyAnswer(block, item.likelyAnswer, item);
    }

    if (item.clarification?.question && !item.conditionalAnswer) {
      renderClarification(block, item.clarification);
    } else if (shouldRenderFallbackClarification(item)) {
      renderClarification(block, {
        question: "需要确认：请补充正式卡名、效果编号、具体时点，或提供能直接覆盖该场景的官方 Q&A / FAQ。",
        options: ["补充正式卡名", "补充效果编号", "补充具体时点", "提供官方 Q&A / FAQ"],
      });
    }

    if (Array.isArray(item.dependencies) && item.dependencies.length) {
      const dependencies = document.createElement("p");
      dependencies.className = "sub-reasoning";
      dependencies.textContent = `依赖的问题：${item.dependencies.map((edge) => `${edge.fromQuestionId}（${edge.relation}）`).join("、")}`;
      block.appendChild(dependencies);
    }

    if (Array.isArray(item.unresolvedDependencies) && item.unresolvedDependencies.length) {
      const unresolved = document.createElement("p");
      unresolved.className = "sub-reasoning";
      unresolved.textContent = `未解决依赖：${item.unresolvedDependencies.join("、")}`;
      block.appendChild(unresolved);
    }

    if (Array.isArray(item.transitionReasoning) && item.transitionReasoning.length) {
      const transition = document.createElement("p");
      transition.className = "sub-reasoning";
      transition.textContent = `状态转移推理：${item.transitionReasoning.map((rule) => rule.reason).join("；")}`;
      block.appendChild(transition);
    }

    if (Array.isArray(item.ruleSources) && item.ruleSources.length) {
      const ruleSources = document.createElement("p");
      ruleSources.className = "sub-source";
      ruleSources.textContent = `规则来源：${item.ruleSources.map((sourceItem) => {
        const ids = sourceItem.sourceIds?.length ? ` ${sourceItem.sourceIds.join(", ")}` : " 无证据 ID";
        return `${sourceItem.sourceType}${ids}`;
      }).join("；")}`;
      block.appendChild(ruleSources);
    }

    if (Array.isArray(item.evidenceIds) && item.evidenceIds.length) {
      const evidenceIds = document.createElement("p");
      evidenceIds.className = "sub-source";
      evidenceIds.textContent = `依据 ID：${item.evidenceIds.join("、")}`;
      block.appendChild(evidenceIds);
    }

    const source = document.createElement("p");
    source.className = "sub-source";
    source.textContent = item.source ? `来源：${item.source}` : "来源：[推理，需确认]";
    block.appendChild(source);

    ui.subAnswersPanel.appendChild(block);
  });
}

function hasDetailedSubAnswerDisplay(item) {
  return Boolean(
    item?.conditionalAnswer ||
    item?.provisionalAnswer ||
    item?.likelyAnswer ||
    item?.clarification ||
    item?.reasoning ||
    item?.reason ||
    item?.stateMessage ||
    item?.dependencies?.length ||
    item?.unresolvedDependencies?.length ||
    item?.transitionReasoning?.length ||
    item?.ruleSources?.length ||
    item?.evidenceIds?.length
  );
}

function subAnswerStatusLabel(item) {
  if (item?.officialAnswer?.status === "confirmed" || item?.status === "confirmed") return "已确认";
  if (item?.provisionalAnswer) return "未确认处理方式";
  if (item?.conditionalAnswer) return "条件不足";
  if (item?.likelyAnswer && item.likelyAnswer.status !== "not_available") return "可能处理（未确认）";
  if (item?.status === "inferred") return "可能处理（未确认）";
  if (item?.status === "parse_failed") return "解析失败";
  return "资料不足";
}

function formatSubAnswerVerdict(verdict) {
  if (!verdict) return "需要确认";
  if (typeof verdict === "object") return JSON.stringify(verdict);
  return String(verdict);
}

function renderConditionalAnswer(parent, conditionalAnswer) {
  const wrapper = document.createElement("div");
  wrapper.className = "sub-reasoning";

  const intro = document.createElement("p");
  intro.textContent = "当前无法确定唯一结论。已找到相关 FAQ/Q&A，但需要确认适用哪个条件分支。";
  wrapper.appendChild(intro);

  if (Array.isArray(conditionalAnswer.branches) && conditionalAnswer.branches.length) {
    const title = document.createElement("p");
    title.textContent = "可能分支：";
    wrapper.appendChild(title);

    const list = document.createElement("ul");
    conditionalAnswer.branches.forEach((branch) => {
      const item = document.createElement("li");
      item.textContent = `${branch.label || "如果满足该分支条件"}：${branch.explanation || branch.verdict || "unknown"}`;
      list.appendChild(item);
    });
    wrapper.appendChild(list);
  }

  if (conditionalAnswer.clarificationQuestion) {
    const clarify = document.createElement("p");
    clarify.textContent = conditionalAnswer.clarificationQuestion;
    wrapper.appendChild(clarify);
  }

  parent.appendChild(wrapper);
}

function renderProvisionalAnswer(parent, provisionalAnswer) {
  const wrapper = document.createElement("div");
  wrapper.className = "sub-reasoning";

  const title = document.createElement("p");
  title.textContent = "未确认处理方式（事务局回答截图，官方数据库未收录）：";
  wrapper.appendChild(title);

  const verdict = document.createElement("p");
  verdict.textContent = formatProvisionalVerdict(provisionalAnswer.verdict, provisionalAnswer.explanation);
  wrapper.appendChild(verdict);

  const note = document.createElement("p");
  note.textContent = "注意：该回答目前未在官方数据库中找到直接 Q&A。后续如果数据库更新，系统会优先改用官方数据库裁定。";
  wrapper.appendChild(note);

  parent.appendChild(wrapper);
}

function renderLikelyAnswer(parent, likelyAnswer, context = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "sub-reasoning";

  const title = document.createElement("p");
  title.textContent = "未确认分析：";
  wrapper.appendChild(title);

  const body = document.createElement("div");
  const verdict = likelyAnswer.verdict && likelyAnswer.verdict !== "unknown"
    ? `倾向：${formatSubAnswerVerdict(likelyAnswer.verdict)}。`
    : "";
  const structured = [
    likelyAnswer.issueSummary ? `问题核心：${likelyAnswer.issueSummary}` : "",
    likelyAnswer.possibleHandling ? `未确认分析：${likelyAnswer.possibleHandling}` : "",
    likelyAnswer.whyNotConfirmed ? `为什么不能确认：${likelyAnswer.whyNotConfirmed}` : "",
    likelyAnswer.neededEvidence ? `需要确认：${likelyAnswer.neededEvidence}` : "",
  ].filter(Boolean);
  const fallbackStructured = [
    context.sourceText ? `问题核心：${context.sourceText}` : "",
    "未确认分析：",
    likelyAnswer.reasoning || "只能给出未确认处理参考。",
    "为什么不能确认：目前没有能直接回答当前问题的官方 Q&A / FAQ。",
    "需要确认：需要能覆盖该场景的官方 Q&A / FAQ / 事务局回答。",
  ].filter(Boolean).join(" ");
  body.textContent = `${verdict}${structured.length ? structured.join(" ") : fallbackStructured} ${likelyAnswer.disclaimer || "未确认裁定，不能替代官方 Q&A"}`.trim();
  wrapper.appendChild(body);

  if (Array.isArray(likelyAnswer.riskFlags) && likelyAnswer.riskFlags.length) {
    const risk = document.createElement("p");
    risk.textContent = `风险提示：${likelyAnswer.riskFlags.map(formatRiskFlag).join("、")}`;
    wrapper.appendChild(risk);
  }

  parent.appendChild(wrapper);
}

function renderClarification(parent, clarification) {
  const wrapper = document.createElement("div");
  wrapper.className = "sub-reasoning";
  const question = document.createElement("p");
  question.textContent = clarification.question;
  wrapper.appendChild(question);
  if (Array.isArray(clarification.options) && clarification.options.length) {
    const options = document.createElement("p");
    options.textContent = `可选项：${clarification.options.join("、")}`;
    wrapper.appendChild(options);
  }
  parent.appendChild(wrapper);
}

function shouldRenderFallbackClarification(item) {
  if (!item || item.status !== "unknown") return false;
  if ((item.likelyAnswer && item.likelyAnswer.status !== "not_available") || item.conditionalAnswer || item.provisionalAnswer || item.clarification?.question) return false;
  return true;
}

function formatOfficialAnswerLine(item) {
  const official = item?.officialAnswer || {};
  if (official.status === "confirmed") {
    return `官方确认：已确认。依据 ID：${(official.evidenceIds || item.evidenceIds || []).join("、") || "未列出"}`;
  }
  if (official.status === "parse_failed") return "官方确认：形式化解析失败，无法进入裁定判断。";
  return "官方确认：暂无直接 Q&A / FAQ 可以确认该问题。";
}

function publicReasonForSubAnswer(item) {
  if (item?.displayReason) return item.displayReason;
  if (item?.cardResolutionIssue) return "卡名没有 exact match，不能自动套用较短候选卡。";
  if (item?.provisionalAnswer) return "官方数据库暂无直接裁定；存在事务局回答截图，需要后续复核。";
  if (item?.conditionalAnswer) return "已找到相关 FAQ，但当前问题缺少必要状态，无法确定适用哪个分支。";
  if (item?.unresolvedDependencies?.length) return "该问题依赖另一个子问题的结果，当前不能确认。";
  const reason = String(item?.reason || item?.reasoning || "");
  if (/conflicting_direct_evidence|conflicting_similar_evidence|冲突/u.test(reason)) return "候选资料结论冲突，不能确认。";
  if (/condition_branch_missing_state|condition_branch_ambiguous/u.test(reason)) return "已找到条件分支证据，但当前场景不足以选择唯一分支。";
  if (/no_direct_evidence|similar_evidence|evidence_mentions_action_but_not_asked_result|no_explicit_polarity/u.test(reason)) return "找到的资料与本题相关，但没有直接回答当前问题。";
  if (/card_text_only/u.test(reason)) return "目前只有卡片文本，没有直接 Q&A。";
  if (/rejected_evidence_only|matcher_rejected_all|different_question|question_type_mismatch/u.test(reason)) return "候选资料回答的是不同问题或场景不一致。";
  if (/parse_failed|formal_query_parse_failed/u.test(reason)) return "形式化解析失败，需要补充卡名、效果编号或问题类型。";
  if (/parser_warning/u.test(reason)) return "形式化解析存在不确定项，不能确认裁定。";
  return "暂时不能确认，需要官方 Q&A 或补充场景。";
}

function formatRiskFlag(flag) {
  const labels = {
    card_name_unresolved: "卡名未确认",
    question_type_unknown: "问题类型未确认",
    official_database_not_found: "官方数据库未收录",
    condition_branch_requires_state: "缺少条件分支状态",
    similar_evidence_only: "只有相似资料",
    unresolved_dependency: "依赖子问题未解决",
    conflicting_evidence: "候选资料冲突",
    different_question_evidence: "候选资料回答不同问题",
    no_direct_evidence: "没有 direct evidence",
    insufficient_context: "上下文不足",
  };
  return labels[flag] || flag;
}

function formatProvisionalVerdict(verdict, fallback) {
  if (verdict && typeof verdict === "object") {
    const activation = verdict.activation === "can_activate" ? "可以发动" : "";
    const cost = verdict.cost === "can_pay_cost" ? "并支付 cost" : "";
    const resolution = verdict.resolution === "does_not_perform_fusion_material_processing"
      ? "但后续处理不进行"
      : "";
    const text = [activation + cost, resolution].filter(Boolean).join("，");
    if (text) return `${text}。`;
  }
  return fallback || "存在事务局回答截图，但当前不作为 confirmed。";
}

function renderList(container, items) {
  clearElement(container);
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "暂无";
    container.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    container.appendChild(li);
  }
}

function renderSources(sources) {
  clearElement(ui.sourcesList);
  if (!sources.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无出处";
    ui.sourcesList.appendChild(empty);
    return;
  }

  for (const source of sources) {
    const normalizedSource = typeof source === "string" ? { label: "资料来源", detail: source } : source;
    const detail = normalizedSource.detail || normalizedSource.url || "";
    const node = document.createElement("div");
    node.className = "source-item";
    appendText(node, "strong", normalizedSource.label || normalizedSource.name || "资料来源");
    if (/^https?:\/\//i.test(detail)) {
      const link = document.createElement("a");
      link.href = detail;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = detail;
      node.appendChild(link);
    } else {
      appendText(node, "p", detail || "未提供链接");
    }
    ui.sourcesList.appendChild(node);
  }
}

function renderFeedbackPanel(answer) {
  if (!ui.verdictBlock) return;
  const existing = ui.verdictBlock.querySelector(".feedback-panel");
  if (existing) existing.remove();
  if (!answer || answer.status === "data_source_missing") return;

  const panel = document.createElement("details");
  panel.className = "feedback-panel";
  const summary = document.createElement("summary");
  summary.textContent = "反馈这个回答";
  panel.appendChild(summary);

  const hint = document.createElement("p");
  hint.textContent = "反馈不会立即改变裁定结论；确认来源后才会转成回归测试。";
  panel.appendChild(hint);

  const buttons = document.createElement("div");
  buttons.className = "feedback-buttons";
  const selectedType = { value: "other" };
  const choices = [
    ["wrong_verdict", "回答错了"],
    ["missing_evidence", "资料不对"],
    ["missing_evidence", "需要补充来源"],
  ];
  const form = document.createElement("div");
  const textarea = document.createElement("textarea");
  const message = document.createElement("p");
  for (const [type, label] of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      selectedType.value = type;
      form.hidden = false;
      message.textContent = "";
      textarea.focus();
    });
    buttons.appendChild(button);
  }
  panel.appendChild(buttons);

  form.className = "feedback-form";
  form.hidden = true;
  textarea.rows = 4;
  textarea.placeholder = "请说明哪里错了，或贴上来源链接 / 原文。";
  form.appendChild(textarea);

  const submit = document.createElement("button");
  submit.type = "button";
  submit.textContent = "提交反馈";
  form.appendChild(submit);

  message.className = "feedback-message";
  form.appendChild(message);

  submit.addEventListener("click", async () => {
    const comment = textarea.value.trim();
    if (!comment) {
      message.textContent = "请先填写反馈内容。";
      return;
    }
    submit.disabled = true;
    try {
      await submitFeedbackCase(answer, {
        type: selectedType.value,
        comment,
        ...extractFeedbackSource(comment),
      });
      message.textContent = "反馈已记录。它不会立即改变裁定结论；确认后会转成回归测试。";
      textarea.value = "";
    } catch (error) {
      message.textContent = `反馈保存失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      submit.disabled = false;
    }
  });
  panel.appendChild(form);
  ui.verdictBlock.appendChild(panel);
}

async function submitFeedbackCase(answer, userFeedback) {
  const payload = {
    originalQuestion: answer?.formalQuery?.originalText || ui.questionInput.value.trim(),
    formalQuery: answer?.formalQuery || null,
    currentAnswer: buildFeedbackCurrentAnswer(answer || lastRenderedBackendAnswer || {}),
    userFeedback,
  };
  const endpoint = feedbackApiUrl();
  if (endpoint) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.ok) return response.json();
  }
  return saveFeedbackCaseLocally(payload);
}

function buildFeedbackCurrentAnswer(answer) {
  const subAnswer = Array.isArray(answer.subAnswers) && answer.subAnswers.length === 1 ? answer.subAnswers[0] : null;
  return {
    finalStatus: answer.mode || answer.confidence?.status || subAnswer?.status || "unknown",
    finalVerdict: subAnswer?.verdict ?? answer.verdict ?? "unknown",
    reason: subAnswer?.reason || answer.needsConfirmation?.[0] || "",
    evidenceIds: answer.evidenceIds || subAnswer?.evidenceIds || [],
    ...(subAnswer?.conditionalAnswer ? { conditionalAnswer: subAnswer.conditionalAnswer } : {}),
    ...(subAnswer?.provisionalAnswer ? { provisionalAnswer: subAnswer.provisionalAnswer } : {}),
  };
}

function feedbackApiUrl() {
  if (!appConfig.answerApiUrl) return "";
  try {
    const url = new URL(appConfig.answerApiUrl);
    url.pathname = url.pathname.replace(/\/api\/answer\/?$/u, "/api/feedback");
    return url.href;
  } catch {
    return appConfig.answerApiUrl.replace(/\/api\/answer\/?$/u, "/api/feedback");
  }
}

function saveFeedbackCaseLocally(payload) {
  const key = "ocg-ruling-feedback-cases:v1";
  const stored = JSON.parse(localStorage.getItem(key) || "[]");
  const item = {
    ...payload,
    id: `local-feedback-${Date.now()}`,
    createdAt: new Date().toISOString(),
    status: "new",
  };
  stored.push(item);
  localStorage.setItem(key, JSON.stringify(stored));
  return { ok: true, feedbackCase: item, localOnly: true };
}

function extractFeedbackSource(comment) {
  const url = String(comment || "").match(/https?:\/\/\S+/iu)?.[0];
  return url ? { supportingSourceUrl: url, supportingSourceText: comment } : { supportingSourceText: comment };
}

function appendText(parent, tagName, text) {
  const node = document.createElement(tagName);
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

function clearElement(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

async function init() {
  await loadAppConfig();
  await loadBackendModelInfo();
  await loadSyncedData();
  updateSourceStatus();
  resetAnalysis();

  ui.analyzeButton.addEventListener("click", analyzeQuestion);
  ui.questionInput.addEventListener("input", scheduleAnalysis);
  ui.clearButton.addEventListener("click", () => {
    clearTimeout(analysisTimer);
    ui.questionInput.value = "";
    analyzeQuestion();
    ui.questionInput.focus();
  });
}

function scheduleAnalysis() {
  clearTimeout(analysisTimer);
  if (!ui.questionInput.value.trim()) {
    analyzeQuestion();
    return;
  }
  if (appConfig.answerApiUrl) {
    resetAnalysis();
    return;
  }
  analysisTimer = setTimeout(analyzeQuestion, appConfig.answerApiUrl ? 650 : 250);
}

init();
