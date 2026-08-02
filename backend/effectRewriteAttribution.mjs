import { splitEffectTextBlocks } from "./cardEffectBlocks.mjs";

const EFFECT_MARKS = "①②③④⑤⑥⑦⑧⑨⑩";
const REWRITE_ACTION = /(?:改写(?:为|成)?|改寫(?:為|成)?|改(?:为|成)|替换(?:为|成)|替換(?:為|成)|置换(?:为|成)|置換(?:為|成)|变为|變為|変更(?:する)?|replace(?:d|s)?|becomes?)/iu;
const REWRITE_WORDING = /(?:把|将|將|使|该|該|此|这个|這個|その|that).{0,40}(?:效果|効果|effect).{0,20}(?:处理|處理|処理)?.{0,12}(?:改写(?:为|成)?|改寫(?:為|成)?|改(?:为|成)|替换(?:为|成)|替換(?:為|成)|置换(?:为|成)|置換(?:為|成)|变为|變為|変更(?:する)?|replace(?:d|s)?|becomes?)/isu;
const DESTROY_WORDING = /(?:破坏|破壊|destroy)/iu;
const DESTROYED_TRIGGER = /(?:被|が).{0,16}(?:破坏|破壊)|destroyed/iu;
const EXCEPT_WORDING = /(?:以外|之外|除外|other than|except)/iu;

/**
 * A chain link keeps the identity of the effect that was activated, while the
 * executable program is revisioned. Rewriting resolution never mutates the
 * activated-effect identity.
 */
export function createPendingResolutionFrame({
  frameId,
  sourceCardDefinitionId,
  sourceCardInstanceId,
  activatedEffectId,
  activatedEffectNo,
  operations = [],
} = {}) {
  const required = {
    sourceCardDefinitionId: clean(sourceCardDefinitionId),
    sourceCardInstanceId: clean(sourceCardInstanceId),
    activatedEffectId: clean(activatedEffectId),
    activatedEffectNo: normalizeEffectNo(activatedEffectNo),
  };
  if (Object.values(required).some((value) => !value || value === "unknown")) {
    return { complete: false, reason: "pending_resolution_identity_incomplete" };
  }
  const id = clean(frameId) || `resolution:${required.sourceCardInstanceId}:${required.activatedEffectId}`;
  return {
    complete: true,
    frameId: id,
    cardSource: {
      definitionId: required.sourceCardDefinitionId,
      instanceId: required.sourceCardInstanceId,
    },
    activatedEffect: {
      id: required.activatedEffectId,
      effectNo: required.activatedEffectNo,
    },
    activatedProgramId: `${id}:program:0`,
    effectiveProgram: {
      id: `${id}:program:0`,
      revision: 0,
      operations: cloneArray(operations),
    },
    rewrittenBy: [],
  };
}

export function rewritePendingResolution(frame = {}, {
  rewriterCardDefinitionId,
  rewriterCardInstanceId,
  rewriterEffectId,
  rewriterEffectNo,
  replacementOperations = [],
} = {}) {
  if (frame.complete !== true || !frame.effectiveProgram?.id) {
    return { complete: false, reason: "pending_resolution_frame_incomplete" };
  }
  const attribution = {
    cardDefinitionId: clean(rewriterCardDefinitionId),
    cardInstanceId: clean(rewriterCardInstanceId),
    effectId: clean(rewriterEffectId),
    effectNo: normalizeEffectNo(rewriterEffectNo),
  };
  if (Object.values(attribution).some((value) => !value || value === "unknown")) {
    return { complete: false, reason: "resolution_rewriter_identity_incomplete" };
  }
  if (!Array.isArray(replacementOperations) || !replacementOperations.length) {
    return { complete: false, reason: "replacement_program_operations_incomplete" };
  }
  const revision = Number(frame.effectiveProgram.revision || 0) + 1;
  return {
    ...deepClone(frame),
    complete: true,
    effectiveProgram: {
      id: `${frame.frameId}:program:${revision}`,
      revision,
      operations: cloneArray(replacementOperations),
    },
    rewrittenBy: [...(frame.rewrittenBy || []), attribution],
  };
}

export function createDestructionEventFromResolution(frame = {}, {
  targetCardDefinitionId,
  targetCardInstanceId,
} = {}) {
  const target = {
    definitionId: clean(targetCardDefinitionId),
    instanceId: clean(targetCardInstanceId),
  };
  if (
    frame.complete !== true
    || !frame.cardSource?.definitionId
    || !frame.activatedEffect?.id
    || !frame.effectiveProgram?.id
    || Object.values(target).some((value) => !value)
  ) {
    return { complete: false, reason: "destruction_event_attribution_incomplete" };
  }
  return {
    complete: true,
    type: "destroyed",
    target,
    cardSource: deepClone(frame.cardSource),
    activatedEffect: deepClone(frame.activatedEffect),
    effectiveProgram: {
      id: frame.effectiveProgram.id,
      revision: Number(frame.effectiveProgram.revision || 0),
    },
    rewrittenBy: deepClone(frame.rewrittenBy || []),
  };
}

export function evaluateDestroyedOtherThanExactEffect(event = {}, {
  excludedActivatedEffectId,
  excludedProgramId,
} = {}) {
  if (event.complete !== true || event.type !== "destroyed") {
    return { complete: false, reason: "destruction_event_incomplete" };
  }
  const effectId = clean(excludedActivatedEffectId);
  const programId = clean(excludedProgramId);
  if (!effectId || !programId || !event.activatedEffect?.id || !event.effectiveProgram?.id) {
    return { complete: false, reason: "exact_effect_exclusion_identity_incomplete" };
  }
  const isExactExcludedProgram = (
    clean(event.activatedEffect.id) === effectId
    && clean(event.effectiveProgram.id) === programId
  );
  return {
    complete: true,
    isExactExcludedProgram,
    triggerConditionSatisfied: !isExactExcludedProgram,
  };
}

/**
 * Compiles the generic scenario: an already activated effect is rewritten by
 * a chained effect, the revised program destroys a card, and a later trigger
 * excludes destruction by the exact original program.
 */
export function analyzeEffectRewriteAttribution({
  userQuery = "",
  resolvedCards = [],
  cardTexts = [],
} = {}) {
  const query = String(userQuery || "");
  if (!looksLikeRewriteAttributionQuestion(query)) return null;

  const mentions = extractEffectMentions(query);
  const sourceMention = mentions.find((item) => item.role === "activated");
  const rewriterMention = mentions.find((item) => item.role === "rewriter");
  const triggerNo = extractAskedTriggerNo(query);
  if (!sourceMention || !rewriterMention || !triggerNo) {
    return insufficient("rewrite_chain_roles_or_trigger_unknown");
  }

  const cards = mergeCards(resolvedCards, cardTexts);
  const sourceCard = resolveMentionedCard(cards, sourceMention.name);
  const rewriterCard = resolveMentionedCard(cards, rewriterMention.name);
  if (!sourceCard || !rewriterCard || sourceCard.ambiguous || rewriterCard.ambiguous) {
    return insufficient("rewrite_source_or_rewriter_card_unresolved");
  }
  const sourceBlock = findEffectBlock(sourceCard, sourceMention.effectNo);
  const rewriterBlock = findEffectBlock(rewriterCard, rewriterMention.effectNo);
  const triggerBlock = findEffectBlock(sourceCard, triggerNo);
  if (!sourceBlock || !rewriterBlock || !triggerBlock) {
    return insufficient("rewrite_effect_blocks_incomplete");
  }
  if (!REWRITE_WORDING.test(rewriterBlock.text) || !DESTROY_WORDING.test(rewriterBlock.text)) {
    return insufficient("verified_replacement_program_missing");
  }
  if (!DESTROYED_TRIGGER.test(triggerBlock.text) || !EXCEPT_WORDING.test(triggerBlock.text)) {
    return insufficient("exact_effect_exclusion_trigger_missing");
  }
  if (!triggerReferencesEffect(triggerBlock.text, sourceMention.effectNo)) {
    return insufficient("excluded_effect_reference_not_bound");
  }
  if (!queryDeclaresSourceDestroyed(query, sourceMention.name, sourceMention.effectNo)) {
    return insufficient("destroyed_target_instance_not_bound");
  }

  const sourceDefinitionId = cardDefinitionId(sourceCard);
  const rewriterDefinitionId = cardDefinitionId(rewriterCard);
  const sourceEffectId = `${sourceDefinitionId}:effect:${sourceMention.effectNo}`;
  const rewriterEffectId = `${rewriterDefinitionId}:effect:${rewriterMention.effectNo}`;
  const sourceInstanceId = `${sourceDefinitionId}:scenario-source`;
  const rewriterInstanceId = `${rewriterDefinitionId}:scenario-rewriter`;
  const original = createPendingResolutionFrame({
    frameId: "chain-link-questioned-effect",
    sourceCardDefinitionId: sourceDefinitionId,
    sourceCardInstanceId: sourceInstanceId,
    activatedEffectId: sourceEffectId,
    activatedEffectNo: sourceMention.effectNo,
    operations: [{ type: "original_printed_resolution", text: sourceBlock.text }],
  });
  const rewritten = rewritePendingResolution(original, {
    rewriterCardDefinitionId: rewriterDefinitionId,
    rewriterCardInstanceId: rewriterInstanceId,
    rewriterEffectId,
    rewriterEffectNo: rewriterMention.effectNo,
    replacementOperations: [{ type: "destroy", text: replacementProgramText(rewriterBlock.text) }],
  });
  const destruction = createDestructionEventFromResolution(rewritten, {
    targetCardDefinitionId: sourceDefinitionId,
    targetCardInstanceId: sourceInstanceId,
  });
  const triggerCheck = evaluateDestroyedOtherThanExactEffect(destruction, {
    excludedActivatedEffectId: sourceEffectId,
    excludedProgramId: original.activatedProgramId,
  });
  if (!triggerCheck.complete) return insufficient(triggerCheck.reason);

  const sourceName = displayName(sourceCard, sourceMention.name);
  const rewriterName = displayName(rewriterCard, rewriterMention.name);
  const shortAnswer = triggerCheck.triggerConditionSatisfied
    ? `不算被「${sourceName}」自身的${circled(sourceMention.effectNo)}效果原本的处理破坏，可以发动${circled(triggerNo)}效果。`
    : `算被「${sourceName}」自身的${circled(sourceMention.effectNo)}效果原本的处理破坏，不能以“该效果以外被破坏”为由发动${circled(triggerNo)}效果。`;
  const evidenceIds = unique([
    evidenceId(sourceCard),
    evidenceId(rewriterCard),
  ]);
  return {
    status: "resolved",
    complete: true,
    authoritative: true,
    activation: "assumed_legal",
    activationBasis: "declared_legal",
    resolution: "resolved",
    shortAnswer,
    reasoning: [
      `连锁中发动的是「${sourceName}」的${circled(sourceMention.effectNo)}效果；这个发动身份在处理被改写后仍保留。`,
      `「${rewriterName}」的${circled(rewriterMention.effectNo)}效果把待处理程序替换为新的第${rewritten.effectiveProgram.revision}版程序，破坏由这个改写后的程序执行。`,
      `改写后的实际程序实例与原${circled(sourceMention.effectNo)}效果的原始程序实例不是同一个精确处理，因此满足${circled(triggerNo)}效果所要求的“原${circled(sourceMention.effectNo)}效果以外被破坏”。`,
    ],
    trace: [{
      phase: "rewrite_pending_resolution",
      status: "applied",
      proof: {
        originalFrame: original,
        rewrittenFrame: rewritten,
        destructionEvent: destruction,
        exactEffectCheck: triggerCheck,
      },
      conclusion: shortAnswer,
    }],
    evidenceIds,
    activationEvidenceType: "effect_program",
    program: {
      semanticSource: "card_text_ir",
      originalFrame: original,
      rewrittenFrame: rewritten,
      destructionEvent: destruction,
      exactEffectCheck: triggerCheck,
    },
  };
}

function looksLikeRewriteAttributionQuestion(query) {
  return /(?:连锁|連鎖|チェーン|chain)/iu.test(query)
    && REWRITE_ACTION.test(query)
    && DESTROY_WORDING.test(query)
    && /(?:自身|自己|本身|它|其|那只|那张|該隻|该只|該張|该张|itself|that (?:card|monster))/iu.test(query);
}

function extractEffectMentions(query) {
  const mentions = [];
  const matcher = /「([^」]{1,60})」(?:的|之|の)?\s*([①②③④⑤⑥⑦⑧⑨⑩]|\d{1,2})(?:\s*(?:的|号|號|番|の))?\s*(?:效果|効果|effect)?/giu;
  for (const match of query.matchAll(matcher)) {
    const before = currentClauseTail(query.slice(Math.max(0, (match.index || 0) - 48), match.index || 0));
    const afterStart = (match.index || 0) + match[0].length;
    const after = currentClauseHead(query.slice(afterStart, afterStart + 24));
    const roleContext = `${before} ${after}`;
    const role = /(?:连锁|連鎖|チェーン|chain)/iu.test(roleContext) ? "rewriter"
      : /(?:发动|發動|発動|activate)/iu.test(roleContext) ? "activated"
        : "mentioned";
    mentions.push({ role, name: match[1], effectNo: normalizeEffectNo(match[2]), index: match.index || 0 });
  }
  if (!mentions.some((item) => item.role === "activated")) {
    const first = mentions.find((item) => item.role === "mentioned");
    if (first) first.role = "activated";
  }
  return mentions;
}

function extractAskedTriggerNo(query) {
  const candidates = [];
  for (const pattern of [
    /(?:发动|發動|発動|activate)\s*(?:(?:它|其|该卡|該卡|这张卡|這張卡|此卡|its?)(?:的|の)?\s*)?([①②③④⑤⑥⑦⑧⑨⑩]|\d{1,2})(?:的|の)?(?:效果|効果|effect)?/giu,
    /([①②③④⑤⑥⑦⑧⑨⑩]|\d{1,2})(?:的|の)?(?:效果|効果|effect)?\s*(?:还|還|仍|仍然|之后|之後|那么|那麼)?\s*(?:能否|是否|可否|可以|能够|能不能|还能|還能|仍能|may|can)?\s*(?:发动|發動|発動|activate)/giu,
  ]) {
    for (const match of query.matchAll(pattern)) {
      candidates.push({ index: match.index || 0, effectNo: normalizeEffectNo(match[1]) });
    }
  }
  return candidates.sort((left, right) => left.index - right.index).at(-1)?.effectNo || "";
}

function mergeCards(resolvedCards, cardTexts) {
  const byId = new Map();
  for (const card of [...(resolvedCards || []), ...(cardTexts || [])]) {
    const id = cardDefinitionId(card);
    if (!id) continue;
    const prior = byId.get(id) || {};
    byId.set(id, { ...prior, ...card, effectText: card.effectText || card.text || prior.effectText || prior.text || "" });
  }
  return [...byId.values()];
}

function resolveMentionedCard(cards, name) {
  const key = normalizeName(name);
  const matches = cards.filter((card) => cardNames(card).some((candidate) => normalizeName(candidate) === key));
  if (matches.length !== 1) return matches.length ? { ambiguous: true } : null;
  return matches[0];
}

function cardNames(card) {
  return unique([card.name, card.cnName, card.jaName, card.enName, card.input, card.matchedQuery, ...(card.names || []), ...(card.aliases || [])]);
}

function findEffectBlock(card, effectNo) {
  return splitEffectTextBlocks(card.effectText || card.text || "")
    .find((block) => normalizeEffectNo(block.marker) === normalizeEffectNo(effectNo)) || null;
}

function triggerReferencesEffect(text, effectNo) {
  const mark = circled(effectNo);
  return new RegExp(`(?:${escapeRegExp(mark)}|${escapeRegExp(effectNo)})(?:的|の)?(?:效果|効果)?[^。；;]{0,12}(?:以外|之外|除く|other than)|(?:以外|之外|除く|other than)[^。；;]{0,12}(?:${escapeRegExp(mark)}|${escapeRegExp(effectNo)})`, "iu").test(text);
}

function queryDeclaresSourceDestroyed(query, sourceName, sourceEffectNo) {
  const key = escapeRegExp(sourceName);
  const selection = /(?:选择|選擇|选中|選中|选|選|指定|choose|select)/iu;
  const reflexive = /(?:自己|自身|本身|那只|那张|该只|該隻|该张|該張|这只|這隻|此卡|itself|that (?:card|monster))/iu;
  const effectNo = normalizeEffectNo(sourceEffectNo);
  const effectReference = effectNo === "unknown"
    ? null
    : new RegExp(`(?:发动|發動|発動|activate)[^。；;]{0,8}(?:${escapeRegExp(circled(effectNo))}|${escapeRegExp(effectNo)})|(?:${escapeRegExp(circled(effectNo))}|${escapeRegExp(effectNo)})[^。；;]{0,8}(?:发动|發動|発動|activate)`, "iu");
  return String(query || "").split(/[。；;\n]/u).some((clause) => (
    selection.test(clause)
    && DESTROY_WORDING.test(clause)
    && new RegExp(`「${key}」`, "iu").test(clause)
    && (reflexive.test(clause) || effectReference?.test(clause))
  ));
}

function currentClauseTail(value) {
  return String(value || "").split(/[，。；;、\n]/u).at(-1) || "";
}

function currentClauseHead(value) {
  return String(value || "").split(/[，。；;、\n]/u)[0] || "";
}

function replacementProgramText(text) {
  return String(text || "").match(/[『「](.*?(?:破坏|破壊|destroy).*?)[』」]/isu)?.[1] || String(text || "");
}

function insufficient(reason) {
  return {
    status: "insufficient",
    complete: false,
    authoritative: false,
    reason,
    shortAnswer: "改写效果的来源、实际执行程序或后续触发条件尚未完整绑定，不能由状态执行器生成确定结论。",
    reasoning: [reason],
    trace: [],
    evidenceIds: [],
  };
}

function cardDefinitionId(card) {
  const listedIds = unique(card?.cardIds || []);
  return clean(
    card?.definitionId
    || card?.cardDefinitionId
    || card?.cardId
    || (listedIds.length === 1 ? listedIds[0] : "")
    || card?.id,
  );
}
function evidenceId(card) { return clean(card?.evidenceId || card?.textEvidenceId || card?.sourceId); }
function displayName(card, fallback) { return clean(card?.name || card?.cnName || card?.jaName || card?.enName || fallback); }
function clean(value) { return String(value || "").normalize("NFKC").trim(); }
function normalizeName(value) { return clean(value).toLowerCase().replace(/[「」『』・·･\s_\-－—–]/gu, ""); }
function normalizeEffectNo(value) {
  const text = clean(value).replace(/[().:：]/gu, "");
  const index = EFFECT_MARKS.indexOf(text);
  return index >= 0 ? String(index + 1) : /^\d{1,2}$/u.test(text) ? String(Number(text)) : "unknown";
}
function circled(value) { const number = Number(normalizeEffectNo(value)); return number >= 1 && number <= 10 ? EFFECT_MARKS[number - 1] : String(value); }
function unique(values) { return [...new Set((values || []).map(clean).filter(Boolean))]; }
function cloneArray(value) { return Array.isArray(value) ? deepClone(value) : []; }
function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
function escapeRegExp(value) { return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
