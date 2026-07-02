export function classifyTriggerWording(effectText = "") {
  const text = normalize(effectText);
  if (!text) return "unknown";
  const optional = /可以发动|可发动|できる|you can (?:activate|use)/iu.test(text);
  const ifWording = /如果.{0,80}(?:场合|場合)|.{0,80}的场合|場合|\bif\b/iu.test(text);
  const whenWording = /当.{0,80}时|.{1,80}时[,，、]?|時[,、]?|\bwhen\b/iu.test(text);
  if (optional && ifWording) return "optional_if";
  if (optional && whenWording) return "optional_when";
  if (!optional && ifWording && /发动|発動|activate/iu.test(text)) return "mandatory_if";
  if (!optional && whenWording && /发动|発動|activate/iu.test(text)) return "mandatory_when";
  return "unknown";
}

export function getLastEvent(eventSequence = []) {
  if (!eventSequence.length) return null;
  const maxOrder = Math.max(...eventSequence.map((event) => Number(event.order) || 0));
  const events = eventSequence.filter((event) => (Number(event.order) || 0) === maxOrder);
  const event = events.at(-1);
  return { eventId: event.id, type: event.type, order: maxOrder, simultaneousGroupId: event.simultaneousGroupId || null, events };
}

export function isEventLastThing(triggerEvent, eventSequence = []) {
  const last = getLastEvent(eventSequence);
  if (!last || !triggerEvent) return "unknown";
  const candidates = eventSequence.filter((event) => event.id === triggerEvent || event.type === triggerEvent || event.id === triggerEvent.id || event.type === triggerEvent.type);
  if (!candidates.length) return "unknown";
  return candidates.some((event) => (Number(event.order) || 0) === last.order
    || (event.simultaneousGroupId && event.simultaneousGroupId === last.simultaneousGroupId));
}

export function buildEventSequenceFromQuestion(question = "") {
  const text = String(question || "").normalize("NFKC");
  const ordered = text.match(/(?:先|首先)(.+?)(?:，|,)?(?:然后|那之后|之后再)(.+?)(?:[。？?]|$)/u);
  if (ordered) return [eventFromClause(ordered[1], 1), eventFromClause(ordered[2], 2)];
  const simultaneous = text.match(/(.{2,60}?)(?:同时|同時)(.{2,60}?)(?:[。？?]|$)/u);
  if (simultaneous) return [
    { ...eventFromClause(simultaneous[1], 1), timing: "simultaneous", simultaneousGroupId: "simultaneous_1" },
    { ...eventFromClause(simultaneous[2], 1), timing: "simultaneous", simultaneousGroupId: "simultaneous_1" },
  ];
  return collectMentionedEvents(text);
}

export function inferTriggerEventType(effectText = "") {
  return classifyEventType(effectText);
}

export function buildTriggerTimingAnalysis({ triggerCandidate = {}, eventSequence = [], officialDirectEvidence = false, evidenceIds = [] } = {}) {
  const triggerType = classifyTriggerWording(triggerCandidate.effectText || triggerCandidate.triggerWording || "");
  const triggerEvent = triggerCandidate.triggerEventType || inferTriggerEventType(triggerCandidate.effectText || "");
  const lastEvent = getLastEvent(eventSequence);
  const isLast = isEventLastThing(triggerEvent, eventSequence);
  const base = {
    triggerType,
    triggerEvent,
    lastEvent,
    eventSequence,
    isTriggerEventLastThing: isLast,
    canActivate: "unknown",
    verdict: "continue_activation_check",
    reasonCode: "timing_analysis_pending",
    missingInfo: [],
    confirmationLevel: officialDirectEvidence ? "official_confirmed" : "conditional",
    evidenceIds: officialDirectEvidence ? [...new Set(evidenceIds.map(String))] : [],
  };
  if (officialDirectEvidence) return { ...base, reasonCode: "official_direct_evidence_controls_timing_result" };
  if (triggerType === "unknown") return {
    ...base,
    verdict: "insufficient_info",
    reasonCode: "unknown_trigger_wording",
    missingInfo: ["请提供官方效果文本。", "请确认诱发措辞是“当……时”还是“如果……的场合”。"],
    confirmationLevel: "insufficient_info",
  };
  if (!eventSequence.length || triggerEvent === "unknown" || isLast === "unknown") return {
    ...base,
    verdict: "insufficient_info",
    reasonCode: "insufficient_event_sequence",
    missingInfo: ["请说明诱发条件事件。", "请说明哪个事件最后发生。", "请说明多个处理是同时发生还是先后发生。"],
    confirmationLevel: "insufficient_info",
  };
  if (triggerType === "optional_when") {
    if (isLast === false) return { ...base, canActivate: false, verdict: "cannot_activate", reasonCode: "optional_when_trigger_missed_timing", confirmationLevel: "rule_derived" };
    return { ...base, canActivate: true, reasonCode: "optional_when_trigger_event_is_last", confirmationLevel: "rule_derived" };
  }
  if (triggerType === "optional_if") return { ...base, reasonCode: "optional_if_not_limited_by_last_event_same_way", confirmationLevel: "conditional" };
  const simultaneous = eventSequence.some((event) => event.simultaneousGroupId) || lastEvent?.events?.length > 1;
  return {
    ...base,
    canActivate: simultaneous ? "unknown" : true,
    verdict: simultaneous ? "insufficient_info" : "continue_activation_check",
    reasonCode: simultaneous ? "requires_segoc_analysis" : "mandatory_trigger_not_optional_timing_miss",
    missingInfo: simultaneous ? ["需要确认同时诱发效果的 SEGOC 排序。"] : [],
    confirmationLevel: simultaneous ? "conditional" : "rule_derived",
  };
}

export function shouldAnalyzeTriggerTiming({ question = "", effectText = "" } = {}) {
  const text = normalize(question);
  return Boolean(effectText) && /错过时点|最后发生|最后一件事|不是最后|先.+然后|同时发生|同时处理|诱发时点/iu.test(text);
}

function eventFromClause(clause, order) {
  return { id: `event_${order}`, type: classifyEventType(clause), subject: clean(clause), timing: "during_resolution", order };
}

function collectMentionedEvents(text) {
  const patterns = [
    ["sent_to_graveyard", /送去墓地|送入墓地|送墓|墓地へ送/giu],
    ["destroyed", /破坏|破壊/giu],
    ["special_summoned", /特殊召唤|特殊召喚/giu],
    ["damage_inflicted", /给予.{0,12}伤害|给与.{0,12}伤害|ダメージを与/giu],
    ["lp_changed", /LP.{0,12}(?:下降|减少|变成)|基本分.{0,12}(?:下降|减少|变成)/giu],
    ["card_left_field", /离场|从场上离开|フィールドから離/giu],
    ["effect_resolved", /效果处理完毕|效果处理后|効果処理後/giu],
  ];
  const found = [];
  for (const [type, pattern] of patterns) for (const match of text.matchAll(pattern)) found.push({ type, index: match.index, subject: match[0] });
  return found.sort((a, b) => a.index - b.index).map((item, index) => ({ id: `event_${index + 1}`, type: item.type, subject: item.subject, timing: "during_resolution", order: index + 1 }));
}

function classifyEventType(value) {
  const text = normalize(value);
  if (/送去墓地|送入墓地|送墓|墓地へ送/iu.test(text)) return "sent_to_graveyard";
  if (/破坏|破壊/iu.test(text)) return "destroyed";
  if (/特殊召唤|特殊召喚/iu.test(text)) return "special_summoned";
  if (/伤害|ダメージ/iu.test(text)) return "damage_inflicted";
  if (/LP|基本分/iu.test(text)) return "lp_changed";
  if (/离场|从场上离开|フィールドから離/iu.test(text)) return "card_left_field";
  if (/处理|resolve|処理/iu.test(text)) return "effect_resolved";
  return "unknown";
}

function normalize(value) { return String(value || "").normalize("NFKC").toLowerCase(); }
function clean(value) { return String(value || "").replace(/\s+/gu, " ").trim(); }
