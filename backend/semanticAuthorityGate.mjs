import { normalizeCardKey } from "./ragCardExtractor.mjs";

export const SEMANTIC_TRANSITION_SCHEMA = "ocg-semantic-state-transition";
export const SEMANTIC_TRANSITION_VERSION = 1;
export const SEMANTIC_QUERY_COVERAGE_SCHEMA = "ocg-semantic-query-coverage";
export const SEMANTIC_QUERY_COVERAGE_VERSION = 1;

const QUESTION_CUE = /(?:[？?]|吗\s*$|呢\s*$|是否|能否|可否|可以.{0,24}吗|能.{0,24}吗|会.{0,24}吗|算.{0,24}吗|如何|怎么|怎样|哪(?:个|些|张|只)?|多少|分别如何|还(?:会|能|可以|适用)|之后.{0,24}(?:吗|如何|怎么))/u;
const INDEPENDENT_FOLLOW_UP = /^(?:另外|另一个问题|此外|顺便|再问|还有(?:一个)?问题|以及另一个问题)/u;
const QUOTED_SURFACE = /[「『《【“"]([^」』》】”"]{1,80})[」』》】”"]/gu;
const DECISION_SENTENCE_SPLIT = /[。；;！!？?]+/u;
const DECISION_CLAUSE_SPLIT = /[，,]+/u;
const DECISION_CUE = /(?:可以|可(?:以)?|能够|能|不能|不可|不可以|合法|不合法|允许|允許|禁止|不会|不會|会|會|仍(?:然)?|立即|不再|正常|不进行|不進行|成功|失败|失敗|适用|適用|恢复|恢復|归还|歸還|必须|必須|应当|應當|先|之后|之後|结果|結果)/u;

const INTENT_DEFINITIONS = Object.freeze([
  ["chain_response", /(?:连锁|連鎖|チェーン|chain)/iu],
  ["activation", /(?:发动|發動|発動|activate)/iu],
  ["effect_resolution", /(?:效果处理|效果處理|效果.{0,12}(?:如何|怎么|怎样|生效|有效|执行|執行)|处理时|處理時|结算|結算|生效|resolve|后续怎么|後續怎麼|之后如何|之後如何)/iu],
  ["special_summon", /(?:特殊召唤|特殊召喚|特殊召喚|special summon)/iu],
  ["normal_summon", /(?:通常召唤|通常召喚|normal summon)/iu],
  ["summon", /(?:召唤|召喚|summon)/iu],
  ["destroy", /(?:破坏|破壞|破壊|destroy)/iu],
  ["effect_attribution", /(?:被.{0,20}(?:自身|自己|那个|那個|该|該).{0,20}效果|算被|原因|归因|歸因|attribut)/iu],
  ["restriction", /(?:限制|不能从|不能從|只能|只可|不得|不适用|不適用|适用|適用|restriction)/iu],
  ["control_change", /(?:控制权|控制權|control)/iu],
  ["restoration", /(?:恢复|恢復|归还|歸還|回到自己|returns?)/iu],
  ["printed_reference", /(?:卡名.{0,18}(?:记载|記載|记述|記述)|效果文本框|印刷文本|printed text)/iu],
  ["operation_order", /(?:先做什么|先做甚麼|先.{0,12}之后|先.{0,12}之後|顺序|順序|order)/iu],
  ["branch_outcome", /(?:(?:分别|分別).{0,40}(?:如何|怎么|怎样|怎樣|处理|處理)|(?:如果|若).{0,36}(?:或|否则|否則|另一).{0,36}(?:如何|怎么|怎样|怎樣|处理|處理|留下|送去)|(?:如果|若).{0,36}(?:与|與|和|以及)?\s*(?:如果|若).{0,48}(?:最后|最後|分别|分別|各自).{0,16}(?:如何|怎么|怎样|怎樣)|(?:最后|最後|最终|最終).{0,24}(?:分别|分別|各自)?(?:如何|怎么|怎样|怎樣))/iu],
  ["destination", /(?:送去墓地|进入墓地|進入墓地|除外|回到卡组|回到卡組|destination)/iu],
  // A destination mentioned as part of an activation cost is not, by itself,
  // a post-resolution field adjustment.  Adjustment is a separate decision
  // surface only when the question asks what must remain/be selected after
  // continuous restrictions are re-applied.
  ["field_adjustment", /(?:留在场上|留在場上|必须选|必須選|调整|調整|稳定化|穩定化)/iu],
  ["attack", /(?:攻击|攻擊|attack)/iu],
  ["life_points", /(?:基本分|生命值|LP|life points?)/iu],
]);

const OUTPUT_INTENT_PATTERNS = Object.freeze({
  chain_response: /(?:连锁|連鎖|チェーン|chain)/iu,
  activation: /(?:发动|發動|発動|activation|activate|legal|illegal)/iu,
  effect_resolution: /(?:效果处理|效果處理|处理时|處理時|处理|處理|结算|結算|生效|有效|执行|執行|resolution|resolve|不进行|不進行)/iu,
  special_summon: /(?:特殊召唤|特殊召喚|special summon|special_summon)/iu,
  normal_summon: /(?:通常召唤|通常召喚|normal summon|normal_summon)/iu,
  summon: /(?:召唤|召喚|summon)/iu,
  destroy: /(?:破坏|破壞|破壊|destroy)/iu,
  effect_attribution: /(?:被.{0,24}效果|原本的处理|原本的處理|改写后的程序|改寫後的程序|attribution|effectiveProgram|activatedProgram)/iu,
  restriction: /(?:限制|不能从|不能從|只能|只可|不得|不适用|不適用|适用|適用|restriction)/iu,
  control_change: /(?:控制权|控制權|control)/iu,
  restoration: /(?:恢复|恢復|归还|歸還|回到自己|不会恢复|不會恢復|restore|return)/iu,
  printed_reference: /(?:卡名.{0,18}(?:记载|記載|记述|記述)|效果文本框|印刷文本|printed|immutablePrinted)/iu,
  operation_order: /(?:先|之后|之後|顺序|順序|order|resolutionOrder)/iu,
  branch_outcome: /(?:如果|若|场合|場合|分支|branch|破坏其他|破壞其他|限制已不再适用|限制已不再適用)/iu,
  destination: /(?:送去墓地|进入墓地|進入墓地|除外|回到卡组|回到卡組|destination|graveyard|banished)/iu,
  field_adjustment: /(?:送去墓地|留在场上|留在場上|选择1只|選擇1只|调整|調整|稳定化|穩定化|adjustment)/iu,
  attack: /(?:攻击|攻擊|attack)/iu,
  life_points: /(?:基本分|生命值|LP|life points?)/iu,
});

/**
 * Adds the common, versioned envelope to every state-executor result. This
 * does not make a result authoritative: the executor must still explicitly
 * set authoritative=true, and the separate gate below verifies that claim.
 */
export function attachSemanticTransitionContract(transition, {
  userQuery = "",
  cardResolution = {},
} = {}) {
  if (!transition || typeof transition !== "object") return transition;
  const reasons = Array.isArray(transition.authorityReasons)
    ? cleanStrings(transition.authorityReasons)
    : transition.status === "resolved" && transition.authoritative === true
      ? []
      : cleanStrings([transition.authorityReason, transition.reason]);
  return {
    ...transition,
    schema: transition.schema || SEMANTIC_TRANSITION_SCHEMA,
    version: transition.version ?? SEMANTIC_TRANSITION_VERSION,
    authorityReasons: reasons,
    queryCoverage: buildSemanticQueryCoverage({
      userQuery,
      transition,
      cardResolution,
    }),
  };
}

/**
 * Sole authority boundary for the zero-model semantic fast path. A transition
 * is trusted only when its execution contract, claim coverage, and every card
 * identity that contributed to the decision are independently auditable.
 */
export function assessSemanticTransitionAuthority({
  semanticStateTransition,
  cardResolution = {},
  extraAmbiguousMentions = [],
} = {}) {
  const transition = semanticStateTransition;
  const reasons = [];
  if (!transition || typeof transition !== "object") {
    return authorityAssessment(false, ["semantic_transition_missing"]);
  }
  if (transition.schema !== SEMANTIC_TRANSITION_SCHEMA) reasons.push("semantic_transition_schema_missing_or_unsupported");
  if (transition.version !== SEMANTIC_TRANSITION_VERSION) reasons.push("semantic_transition_version_missing_or_unsupported");
  if (transition.status !== "resolved") reasons.push("semantic_transition_not_resolved");
  if (transition.complete !== true) reasons.push("semantic_transition_incomplete");
  if (transition.authoritative !== true) reasons.push("semantic_transition_not_explicitly_authoritative");
  if (!Array.isArray(transition.authorityReasons)) reasons.push("semantic_transition_authority_reasons_missing");
  else if (transition.authorityReasons.length) reasons.push("semantic_transition_has_authority_reasons");

  if ((cardResolution.unresolvedMentions || []).length) reasons.push("card_mentions_unresolved");
  if ((cardResolution.ambiguousMentions || []).length || (extraAmbiguousMentions || []).length) {
    reasons.push("card_mentions_ambiguous");
  }
  if ((cardResolution.omittedResolvedCards || []).length) reasons.push("resolved_card_limit_exceeded");

  const coverage = buildSemanticQueryCoverage({
    userQuery: transition.queryCoverage?.query || "",
    transition,
    cardResolution,
  });
  if (coverage.claims.length === 0) reasons.push("query_claims_not_identified");
  if (coverage.ambiguousClaimIds.length) reasons.push("query_claim_coverage_ambiguous");
  if (coverage.uncoveredClaimIds.length) reasons.push("query_claims_not_fully_covered");

  const identityBinding = assessParticipatingCardBindings({ transition, cardResolution, coverage });
  reasons.push(...identityBinding.reasons);

  const uniqueReasons = unique(reasons);
  return authorityAssessment(uniqueReasons.length === 0, uniqueReasons, {
    queryCoverage: coverage,
    identityBinding,
  });
}

export function buildSemanticQueryCoverage({ userQuery = "", transition = {}, cardResolution = {} } = {}) {
  const query = String(userQuery || transition?.queryCoverage?.query || "").trim();
  const claims = extractQuestionClaims(query);
  const decisionText = semanticDecisionText(transition);
  const decisionKey = normalizeComparable(decisionText);
  const resolvedCards = Array.isArray(cardResolution?.resolvedCards) ? cardResolution.resolvedCards : [];
  const decisionScopes = buildClaimDecisionScopes(transition, resolvedCards);
  const evaluated = claims.map((claim) => {
    const decisionPredicate = questionDecisionPredicate(claim.text);
    const intents = classifyIntents(decisionPredicate);
    const effectMarkers = unique([...claim.text.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩]/gu)].map((match) => match[0]));
    const quotedSurfaces = extractQuotedSurfaces(claim.text);
    const cardBindings = quotedSurfaces.map((surface) => bindSurface(surface, resolvedCards));
    const quantifiedFocalCardBindings = identifyQuantifiedDecisionBindings(
      claim.text,
      cardBindings,
      decisionPredicate,
    );
    const focalCardBindings = quantifiedFocalCardBindings.length > 1
      ? quantifiedFocalCardBindings
      : identifyFocalCardBindings(claim.text, cardBindings, decisionPredicate);
    const unresolvedCardSurfaces = cardBindings.filter((binding) => binding.status !== "bound").map((binding) => binding.surface);
    const absentCardSurfaces = cardBindings.filter((binding) => (
      binding.status === "bound"
      && !cardBindingAppearsInDecision(binding, decisionKey)
      && !transitionEvidenceReferencesCard(transition, binding.card)
    )).map((binding) => binding.surface);
    const decisionBinding = assessClaimDecisionBinding({
      intents,
      effectMarkers,
      focalCardBindings,
      decisionScopes,
      decisionText,
      cardBindings,
      transition,
      requireEveryFocalEntity: quantifiedFocalCardBindings.length > 1,
    });
    const uncoveredIntents = decisionBinding.uncoveredIntents;
    const uncoveredEffectMarkers = decisionBinding.uncoveredEffectMarkers;
    const independentPronounOnly = INDEPENDENT_FOLLOW_UP.test(claim.text)
      && quotedSurfaces.length === 0;
    const ambiguous = intents.length === 0 || independentPronounOnly || unresolvedCardSurfaces.length > 0;
    const covered = !ambiguous
      && decisionBinding.complete
      && uncoveredIntents.length === 0
      && uncoveredEffectMarkers.length === 0
      && absentCardSurfaces.length === 0;
    return {
      ...claim,
      decisionPredicate,
      intents,
      effectMarkers,
      quotedSurfaces,
      cardBindings,
      focalCardBindings,
      quantifiedFocalCardBindings,
      decisionBinding,
      uncoveredIntents,
      uncoveredEffectMarkers,
      absentCardSurfaces,
      unresolvedCardSurfaces,
      ambiguous,
      covered,
    };
  });
  return {
    schema: SEMANTIC_QUERY_COVERAGE_SCHEMA,
    version: SEMANTIC_QUERY_COVERAGE_VERSION,
    query,
    complete: evaluated.length > 0 && evaluated.every((claim) => claim.covered),
    claims: evaluated,
    uncoveredClaimIds: evaluated.filter((claim) => !claim.covered).map((claim) => claim.claimId),
    ambiguousClaimIds: evaluated.filter((claim) => claim.ambiguous).map((claim) => claim.claimId),
  };
}

/**
 * A keyword elsewhere in a transition is not evidence that this particular
 * question claim was decided.  Coverage therefore requires a decisive scope
 * which is bound to the claim's focal card/effect.  This deliberately does
 * not treat card-text evidence as a conclusion: evidence can mention every
 * participant while the executor has decided only one of them.
 */
function assessClaimDecisionBinding({
  intents,
  effectMarkers,
  focalCardBindings,
  decisionScopes,
  decisionText,
  cardBindings,
  transition,
  requireEveryFocalEntity = false,
}) {
  const focalDefinitionIds = new Set((focalCardBindings || [])
    .filter((binding) => binding.status === "bound" && binding.definitionId)
    .map((binding) => binding.definitionId));
  const isCardScoped = focalDefinitionIds.size > 0;
  const candidateScopes = isCardScoped
    ? decisionScopes.filter((scope) => scope.definitionIds.some((id) => focalDefinitionIds.has(id)))
    : decisionScopes;
  const uncoveredIntents = intents.filter((intent) => {
    if (!isCardScoped) return !OUTPUT_INTENT_PATTERNS[intent]?.test(decisionText);
    if (requireEveryFocalEntity) {
      return [...focalDefinitionIds].some((definitionId) => !candidateScopes.some((scope) => (
        scope.definitionIds.includes(definitionId) && scope.intents.includes(intent)
      )));
    }
    return !candidateScopes.some((scope) => scope.intents.includes(intent));
  });
  const uncoveredEffectMarkers = effectMarkers.filter((marker) => {
    if (!isCardScoped) {
      return !effectMarkerCovered({ marker, decisionText, cardBindings, transition });
    }
    const number = circledEffectNumber(marker);
    if (requireEveryFocalEntity) {
      return [...focalDefinitionIds].some((definitionId) => !candidateScopes.some((scope) => (
        scope.definitionIds.includes(definitionId)
        && (scope.effectMarkers.includes(marker) || (number && scope.effectNumbers.includes(number)))
      )));
    }
    return !candidateScopes.some((scope) => (
      scope.effectMarkers.includes(marker)
      || (number && scope.effectNumbers.includes(number))
    ));
  });
  return {
    complete: candidateScopes.length > 0
      && (!requireEveryFocalEntity || [...focalDefinitionIds].every((definitionId) => (
        candidateScopes.some((scope) => scope.definitionIds.includes(definitionId))
      )))
      && uncoveredIntents.length === 0
      && uncoveredEffectMarkers.length === 0,
    focalDefinitionIds: [...focalDefinitionIds],
    requireEveryFocalEntity,
    perEntityScopeIds: requireEveryFocalEntity
      ? Object.fromEntries([...focalDefinitionIds].map((definitionId) => [
          definitionId,
          candidateScopes
            .filter((scope) => scope.definitionIds.includes(definitionId))
            .map((scope) => scope.scopeId),
        ]))
      : {},
    matchedScopeIds: candidateScopes.map((scope) => scope.scopeId),
    uncoveredIntents,
    uncoveredEffectMarkers,
  };
}

/**
 * A quantified decision such as “A 和 B 是否都可以发动” contains two
 * independently answerable entities even though it is written as one question
 * clause.  Select every named decision subject here so that the authority gate
 * can require a role-local verdict for each one.  Merely resolving or citing a
 * card does not satisfy this requirement.
 */
function identifyQuantifiedDecisionBindings(claimText, cardBindings, decisionPredicate = claimText) {
  const semanticPredicate = maskQuotedContents(decisionPredicate);
  if (!/(?:都|分别|分別|各自|二者|两者|兩者|双方|雙方|both\b|each\b|respectively\b|all\b)/iu.test(semanticPredicate)) {
    return [];
  }
  const bound = (cardBindings || []).filter((binding) => binding.status === "bound");
  const predicateBound = bound.filter((binding) => isDecisionEntityMention(decisionPredicate, binding.surface));
  if (predicateBound.length > 1) return uniqueBy(predicateBound, (binding) => binding.definitionId);

  // The final predicate may use a collective pronoun (for example “二者分别
  // 如何处理”) after naming the entities earlier in the same claim.  In that
  // form, exclude cards introduced only as costs/materials/targets and bind the
  // remaining named subjects conservatively.  A false negative falls back to
  // the model; an incomplete deterministic answer must never be authorized.
  const claimBound = bound.filter((binding) => isDecisionEntityMention(claimText, binding.surface));
  return claimBound.length > 1 ? uniqueBy(claimBound, (binding) => binding.definitionId) : [];
}

function buildClaimDecisionScopes(transition, resolvedCards) {
  const scopes = [];
  addTextDecisionScopes(scopes, "short_answer", transition?.shortAnswer, resolvedCards);
  addTextDecisionScopes(scopes, "conclusion", transition?.conclusion, resolvedCards);
  for (const [index, step] of (Array.isArray(transition?.trace) ? transition.trace : []).entries()) {
    addTextDecisionScopes(scopes, `trace_${index + 1}_conclusion`, step?.conclusion, resolvedCards);
    addTextDecisionScopes(scopes, `trace_${index + 1}_proof_conclusion`, step?.proof?.conclusion, resolvedCards);
  }
  addStructuredProgramDecisionScopes(scopes, transition, resolvedCards);
  return scopes;
}

function addTextDecisionScopes(scopes, sourceId, value, resolvedCards) {
  const text = clean(value);
  if (!text) return;
  let inheritedDefinitionIds = [];
  let scopeIndex = 0;
  for (const sentence of text.split(DECISION_SENTENCE_SPLIT).map(clean).filter(Boolean)) {
    let priorClauseEstablishedDecision = false;
    for (const clause of sentence.split(DECISION_CLAUSE_SPLIT).map(clean).filter(Boolean)) {
      scopeIndex += 1;
      const explicitDefinitionIds = cardIdsMentionedInText(clause, resolvedCards);
      if (explicitDefinitionIds.length) inheritedDefinitionIds = explicitDefinitionIds;
      const definitionIds = explicitDefinitionIds.length ? explicitDefinitionIds : inheritedDefinitionIds;
      const localDecisionCue = DECISION_CUE.test(clause);
      scopes.push({
        scopeId: `${sourceId}:${scopeIndex}`,
        source: sourceId,
        text: clause,
        definitionIds,
        explicitDefinitionIds,
        intents: classifyDecisionIntents(clause, {
          inheritedDecisionCue: priorClauseEstablishedDecision,
        }),
        effectMarkers: unique([...clause.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩]/gu)].map((match) => match[0])),
        effectNumbers: [],
      });
      if (localDecisionCue) priorClauseEstablishedDecision = true;
    }
  }
}

function addStructuredProgramDecisionScopes(scopes, transition, resolvedCards) {
  const program = transition?.program;
  if (!program || typeof program !== "object") return;
  const add = (scopeId, definitionId, effectCandidate, decisionCandidate, adjudicatedIntents = []) => {
    const id = clean(definitionId || inferDefinitionIdFromEffect(effectCandidate, resolvedCards));
    if (!id || !hasDecisiveStructuredOutcome(decisionCandidate)) return;
    const number = clean(effectCandidate?.effectNumber || effectCandidate?.effectNo || effectCandidate?.number || effectCandidate?.index);
    const decisionText = structuredDecisionText(decisionCandidate);
    scopes.push({
      scopeId,
      source: "structured_program",
      text: decisionText,
      definitionIds: [id],
      explicitDefinitionIds: [id],
      // A program can contain several cards, effects and decisions.  Only the
      // role-local outcome passed to this scope may authorize claim coverage;
      // global transition keywords would turn every participant into an
      // adjudicated entity.
      intents: unique([
        ...classifyDecisionIntents(decisionText, { structured: true }),
        ...adjudicatedIntents,
      ]),
      effectMarkers: number && Number(number) >= 1 && Number(number) <= 10
        ? ["①②③④⑤⑥⑦⑧⑨⑩"[Number(number) - 1]]
        : [],
      effectNumbers: number ? [String(Number(number))] : [],
    });
  };

  // These are the semantic *sources* whose verdict the executor returned.
  // Do not add every definitionId in the program: costs, targets and evidence
  // are participants, not automatically adjudicated claims.
  const responseDecisionIsExplicit = hasDecisiveStructuredOutcome(program.responseDecision);
  const sourceDecisionIsExplicit = hasDecisiveStructuredOutcome(program.sourceDecision);
  if (sourceDecisionIsExplicit) {
    add(
      "program:source",
      program.sourceDefinitionId,
      program.sourceEffect,
      program.sourceDecision,
      ["activation"],
    );
  } else if (!responseDecisionIsExplicit) {
    // Legacy executors expose one primary executed effect plus a top-level
    // activation/resolution outcome.  It is safe to bind that outcome only
    // when the program identifies exactly one primary source and contains no
    // different role-local decision.  Mere participants never enter this set.
    const primary = identifyPrimaryProgramDecisionSubject(program, transition, resolvedCards);
    add(
      "program:source",
      primary.definitionId,
      primary.effect,
      primary.decision,
      [],
    );
  }
  add(
    "program:response",
    program.responseDefinitionId,
    program.responseEffect,
    program.responseDecision,
    ["chain_response", "activation"],
  );
  for (const [index, link] of [
    ...(Array.isArray(program.preparedChainLinks) ? program.preparedChainLinks : []),
    ...(Array.isArray(program.compiledChainLinks) ? program.compiledChainLinks : []),
  ].entries()) {
    add(
      `program:chain_link:${index + 1}`,
      link?.sourceDefinitionId,
      link,
      link?.activationDecision || link?.decision,
      ["activation"],
    );
  }
  add(
    "program:summon_procedure",
    program.summonDefinitionId || program.summonCardDefinitionId,
    program.summonProcedure,
    program.summonDecision || program.summonResult,
    ["special_summon"],
  );
}

function identifyPrimaryProgramDecisionSubject(program, transition, resolvedCards) {
  const firstPreparedLink = (Array.isArray(program.preparedChainLinks) ? program.preparedChainLinks : [])[0];
  const firstCompiledLink = (Array.isArray(program.compiledChainLinks) ? program.compiledChainLinks : [])[0];
  const effect = program.sourceEffect || firstPreparedLink || firstCompiledLink || program.summonProcedure;
  const ids = unique([
    clean(program.sourceDefinitionId),
    inferDefinitionIdFromEffect(program.sourceEffect, resolvedCards),
    clean(firstPreparedLink?.sourceDefinitionId),
    clean(firstCompiledLink?.sourceDefinitionId),
    ...((Array.isArray(transition?.trace) ? transition.trace : [])
      .filter((step) => /(?:compile|activation|effect_instance)/iu.test(clean(step?.phase)))
      .map((step) => clean(step?.sourceDefinitionId))),
  ].filter(Boolean));
  const definitionId = ids.length === 1 ? ids[0] : "";
  const decision = definitionId ? {
    status: transition?.status,
    activation: transition?.activation,
    resolution: transition?.resolution,
    reason: transition?.reason,
    shortAnswer: transition?.shortAnswer,
    reasoning: transition?.reasoning,
  } : null;
  const mentionedDecisionIds = cardIdsMentionedInText(structuredDecisionText(decision), resolvedCards);
  const decisionNamesAnotherEntityOnly = mentionedDecisionIds.length > 0
    && !mentionedDecisionIds.includes(definitionId);
  return {
    definitionId: decisionNamesAnotherEntityOnly ? "" : definitionId,
    effect,
    decision: decisionNamesAnotherEntityOnly ? null : decision,
  };
}

function hasDecisiveStructuredOutcome(value) {
  if (typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value === "string") {
    return /^(?:decided|legal|illegal|allowed|denied|matched|not_matched|activated|not_activated|resolved|performed|not_performed|summoned|not_summoned|success|failed|yes|no|true|false)$/iu.test(clean(value));
  }
  if (!value || typeof value !== "object") return false;
  if ([
    "matches",
    "allowed",
    "legal",
    "canActivate",
    "canRespond",
    "canSummon",
    "performed",
    "success",
  ].some((key) => typeof value[key] === "boolean")) return true;
  return [value.status, value.result, value.outcome, value.verdict]
    .some((candidate) => hasDecisiveStructuredOutcome(candidate));
}

function structuredDecisionText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function classifyDecisionIntents(text, { structured = false, inheritedDecisionCue = false } = {}) {
  const intents = [];
  // Structured decision text is serialized data, so JSON quotes delimit
  // values rather than card-name mentions. Masking quoted contents here would
  // erase the actual outcome (for example "restriction ... not applicable").
  const semanticText = structured ? String(text || "") : maskQuotedContents(text);
  const hasDecisionCue = structured || inheritedDecisionCue || DECISION_CUE.test(String(semanticText || ""));
  for (const [intent, pattern] of Object.entries(OUTPUT_INTENT_PATTERNS)) {
    if (!pattern.test(String(semanticText || ""))) continue;
    if (["activation", "chain_response", "special_summon", "normal_summon", "summon"].includes(intent)
      && !hasDecisionCue) continue;
    intents.push(intent);
  }
  return intents;
}

function cardIdsMentionedInText(text, resolvedCards) {
  const key = normalizeComparable(text);
  return unique((resolvedCards || []).flatMap((card) => {
    const mentioned = cardSurfaces(card)
      .map(normalizeComparable)
      .some((surface) => surface.length >= 2 && key.includes(surface));
    return mentioned ? [cardDefinitionId(card)] : [];
  }).filter(Boolean));
}

function inferDefinitionIdFromEffect(effect, resolvedCards) {
  if (!effect || typeof effect !== "object") return "";
  for (const value of [effect.sourceDefinitionId, effect.definitionId, effect.requiredDefinitionId]) {
    if (value !== null && value !== undefined && clean(value)) return clean(value);
  }
  const effectId = clean(effect.id || effect.effectId);
  if (!effectId) return "";
  const matches = (resolvedCards || []).filter((card) => {
    const id = cardDefinitionId(card);
    return id && (effectId === id || effectId.startsWith(`${id}:`) || effectId.startsWith(`${id}#`));
  });
  const ids = unique(matches.map(cardDefinitionId));
  return ids.length === 1 ? ids[0] : "";
}

function identifyFocalCardBindings(claimText, cardBindings, decisionPredicate = claimText) {
  const bound = (cardBindings || []).filter((binding) => binding.status === "bound");
  if (bound.length <= 1) return bound;
  const chainBound = bindQuestionedChainSource(claimText, decisionPredicate, bound);
  if (chainBound.length) return chainBound;
  const predicateBound = bound.filter((binding) => (
    isDecisionEntityMention(decisionPredicate, binding.surface)
  ));
  if (predicateBound.length === 1) return predicateBound;
  const text = String(claimText || "");
  const scored = bound.map((binding) => {
    const positions = quotedSurfacePositions(text, binding.surface);
    let score = 0;
    for (const { start, end } of positions) {
      const before = text.slice(Math.max(0, start - 28), start);
      const after = text.slice(end, Math.min(text.length, end + 32));
      if (/(?:发动|發動|连锁|連鎖|特殊召唤|特殊召喚|通常召唤|通常召喚|召唤|召喚)\s*$/u.test(before)) score = Math.max(score, 9);
      if (/^(?:的)?\s*[①②③④⑤⑥⑦⑧⑨⑩]/u.test(after)) score = Math.max(score, 8);
      if (/^(?:的)?\s*(?:效果)?\s*(?:能否|是否|可否|可以|能不能|会不会|會不會|还会|還會)/u.test(after)) score = Math.max(score, 8);
      if (/(?:能否|是否|可否|可以|能不能|会不会|會不會)\s*$/u.test(before)) score = Math.max(score, 7);
      if (/^[^，,。；;？?]{0,16}(?:吗|嗎|如何|怎么|怎麼|怎样|怎樣|能否|是否)/u.test(after)) score = Math.max(score, 4);
      if (/^(?:作为|作為)?\s*(?:COST|cost|代价|代價)/u.test(after)) score = Math.max(score, 1);
    }
    return { binding, score };
  });
  const max = Math.max(...scored.map((item) => item.score));
  return max > 0
    ? scored.filter((item) => item.score === max).map((item) => item.binding)
    : bound;
}

function isDecisionEntityMention(text, surface) {
  const source = String(text || "");
  let from = 0;
  while (from < source.length) {
    const index = source.indexOf(surface, from);
    if (index < 0) break;
    const after = source.slice(index + surface.length, index + surface.length + 36)
      .replace(/^[」』》】”"'\s]+/u, "");
    if (!/^(?:作为|作為)?\s*(?:COST|cost|代价|代價|融合素材|素材)|^(?:为|為)对象/iu.test(after)) {
      return true;
    }
    from = index + surface.length;
  }
  return false;
}

function bindQuestionedChainSource(claimText, decisionPredicate, bindings) {
  const questionedLinks = unique([...String(decisionPredicate || "").matchAll(/(?:c|cl|连锁|連鎖)\s*([1-9]\d*)/giu)]
    .map((match) => String(Number(match[1]))));
  if (!questionedLinks.length) return [];
  const assignments = new Map();
  const text = String(claimText || "");
  for (const match of text.matchAll(/(?:c|cl|连锁|連鎖)\s*([1-9]\d*)/giu)) {
    const link = String(Number(match[1]));
    if (!questionedLinks.includes(link) || assignments.has(link)) continue;
    const start = Math.max(0, Number(match.index || 0) - 36);
    const tail = text.slice(Number(match.index || 0), Number(match.index || 0) + 120);
    const boundary = tail.search(/[，,。；;？?\n]/u);
    const end = Number(match.index || 0) + (boundary >= 0 ? boundary : tail.length);
    const window = text.slice(start, end);
    if (!/(?:发动|發動|発動|activate)/iu.test(window)) continue;
    const candidates = bindings.filter((binding) => (
      normalizeComparable(window).includes(normalizeComparable(binding.surface))
    ));
    if (candidates.length === 1) assignments.set(link, candidates[0]);
  }
  return uniqueBy(questionedLinks.map((link) => assignments.get(link)).filter(Boolean), (binding) => binding.definitionId);
}

function quotedSurfacePositions(text, surface) {
  const positions = [];
  for (const opener of ["「", "『", "《", "【", "“", "\""]) {
    const needle = `${opener}${surface}`;
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(needle, from);
      if (index < 0) break;
      positions.push({ start: index, end: index + needle.length + 1 });
      from = index + needle.length;
    }
  }
  return positions;
}

function effectMarkerCovered({ marker, decisionText, cardBindings, transition }) {
  if (decisionText.includes(marker)) return true;
  const markerNumber = circledEffectNumber(marker);
  const declaredNumbers = collectDeclaredEffectNumbers(transition);
  if (markerNumber && declaredNumbers.has(markerNumber)) return true;
  const sourceDefinitionIds = collectExplicitDefinitionIds(transition);
  const sourceBinding = (cardBindings || []).find((binding) => (
    binding.status === "bound"
    && binding.definitionId
    && sourceDefinitionIds.has(binding.definitionId)
    && String(binding.card?.effectText || "").includes(marker)
  ));
  if (sourceBinding) return true;
  const boundCards = uniqueBy(
    (cardBindings || []).filter((binding) => binding.status === "bound" && binding.card).map((binding) => binding.card),
    cardDefinitionId,
  );
  if (boundCards.length !== 1 || !transitionEvidenceReferencesCard(transition, boundCards[0])) return false;
  const printedMarkers = unique([...String(boundCards[0]?.effectText || "").matchAll(/[①②③④⑤⑥⑦⑧⑨⑩]/gu)]
    .map((match) => match[0]));
  return printedMarkers.length === 1 && printedMarkers[0] === marker;
}

function collectDeclaredEffectNumbers(transition) {
  const numbers = new Set();
  const candidates = [
    transition?.program?.responseEffect,
    transition?.program?.sourceEffect,
    transition?.program?.summonProcedure,
    ...(Array.isArray(transition?.program?.preparedChainLinks) ? transition.program.preparedChainLinks : []),
    ...(Array.isArray(transition?.program?.compiledChainLinks) ? transition.program.compiledChainLinks : []),
  ];
  for (const candidate of candidates) {
    for (const value of [candidate?.effectNumber, candidate?.number, candidate?.index]) {
      if (Number.isFinite(Number(value))) numbers.add(String(Number(value)));
    }
    const idMatch = String(candidate?.id || "").match(/(?:effect|block|:)(?:-|:)?(\d{1,2})(?:\D|$)/iu);
    if (idMatch) numbers.add(String(Number(idMatch[1])));
  }
  return numbers;
}

function circledEffectNumber(marker) {
  const index = "①②③④⑤⑥⑦⑧⑨⑩".indexOf(String(marker || ""));
  return index >= 0 ? String(index + 1) : "";
}

function extractQuestionClaims(query) {
  const text = String(query || "").replace(/\r/gu, "").trim();
  if (!text) return [];
  const questionUnits = [];
  const matcher = /[^？?]+[？?]/gu;
  for (const match of text.matchAll(matcher)) questionUnits.push(match[0]);
  if (!questionUnits.length && QUESTION_CUE.test(text)) questionUnits.push(text);
  const clauses = [];
  for (const unit of questionUnits) {
    for (const semicolonPart of unit.split(/[。；;\n]+/u)) {
      const commaParts = semicolonPart.split(/[，,]+/u).map(clean).filter(Boolean);
      let pending = "";
      for (const part of commaParts) {
        pending = pending ? `${pending}，${part}` : part;
        if (QUESTION_CUE.test(part)) {
          clauses.push(pending);
          pending = "";
        }
      }
      if (pending && QUESTION_CUE.test(pending)) clauses.push(pending);
    }
  }
  return uniqueBy(clauses.map((textValue, index) => ({
    claimId: `query-claim-${index + 1}`,
    text: clean(textValue).replace(/[？?]+$/u, ""),
  })).filter((item) => item.text), (item) => normalizeComparable(item.text))
    .map((item, index) => ({ ...item, claimId: `query-claim-${index + 1}` }));
}

function questionDecisionPredicate(claimText) {
  const text = clean(claimText);
  const parts = text.split(/[，,。；;\n]+/u).map(clean).filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (QUESTION_CUE.test(parts[index])) return parts[index];
  }
  return text;
}

function classifyIntents(text) {
  const semanticText = maskQuotedContents(text);
  const intents = [];
  for (const [intent, pattern] of INTENT_DEFINITIONS) {
    const candidateText = intent === "printed_reference" ? text : semanticText;
    if (pattern.test(candidateText)) intents.push(intent);
  }
  const chainResponseIndex = intents.indexOf("chain_response");
  if (chainResponseIndex >= 0 && !/(?:能否|是否|可否|可以|能不能)[^？?]{0,32}(?:连锁|連鎖|チェーン|chain)|(?:连锁|連鎖|チェーン|chain)[^？?]{0,24}(?:发动|發動|発動|吗|嗎|能否|是否|可否|可以|能不能|如何|怎么|怎样|怎樣|组成|組成|顺序|順序|activate|order)/iu.test(semanticText)) {
    intents.splice(chainResponseIndex, 1);
  }
  const attackIndex = intents.indexOf("attack");
  if (attackIndex >= 0) {
    const withoutPosition = semanticText.replace(/(?:攻击|攻擊)表示/gu, "");
    if (!/(?:攻击|攻擊|attack)/iu.test(withoutPosition)) intents.splice(attackIndex, 1);
  }
  if (intents.includes("special_summon")
    && /(?:除外|送去墓地|送墓|回到卡组|回到卡組)[^？?]{0,48}(?:能否|是否|可否|可以|能不能)[^？?]{0,48}(?:特殊召唤|特殊召喚)/u.test(semanticText)) {
    const destinationIndex = intents.indexOf("destination");
    if (destinationIndex >= 0) intents.splice(destinationIndex, 1);
  }
  // In "when X is summoned, may I discard Y to activate Z?", summon and
  // destination are premises/cost descriptions rather than separate claims.
  // Keep them when they occur after the questioned activation (for example
  // "after activation, can I summon?"), but do not demand verdicts for words
  // that only establish the activation window.
  const activationQuestion = /(?:可以|可否|能否|能不能|是否(?:可以|能够|能)?)[^？?]{0,80}(?:发动|發動|発動)|(?:发动|發動|発動)[^？?]{0,24}(?:吗|嗎|可否|能否|能不能|是否)/u.test(semanticText);
  if (activationQuestion) {
    const activationIndex = Math.max(
      semanticText.lastIndexOf("发动"),
      semanticText.lastIndexOf("發動"),
      semanticText.lastIndexOf("発動"),
    );
    const summonIndex = Math.max(semanticText.lastIndexOf("召唤"), semanticText.lastIndexOf("召喚"));
    if (summonIndex >= 0 && summonIndex < activationIndex) {
      const summonIntent = intents.indexOf("summon");
      if (summonIntent >= 0) intents.splice(summonIntent, 1);
      const specialSummonIntent = intents.indexOf("special_summon");
      if (specialSummonIntent >= 0) intents.splice(specialSummonIntent, 1);
    }
    const destinationIndex = intents.indexOf("destination");
    const destinationWordIndex = Math.max(
      semanticText.lastIndexOf("送去墓地"),
      semanticText.lastIndexOf("进入墓地"),
      semanticText.lastIndexOf("進入墓地"),
      semanticText.lastIndexOf("除外"),
      semanticText.lastIndexOf("回到卡组"),
      semanticText.lastIndexOf("回到卡組"),
    );
    if (destinationIndex >= 0 && destinationWordIndex >= 0 && destinationWordIndex < activationIndex) {
      intents.splice(destinationIndex, 1);
    }
  }
  // Special Summon is a more precise subtype; do not demand a second generic
  // wording token merely because the same surface also contains "summon".
  return intents.includes("special_summon")
    ? intents.filter((intent) => intent !== "summon")
    : intents;
}

function maskQuotedContents(value) {
  return String(value || "").replace(/[「『《【“"]([^」』》】”"]{1,120})[」』》】”"]/gu, " ");
}

function extractQuotedSurfaces(text) {
  const surfaces = [];
  QUOTED_SURFACE.lastIndex = 0;
  for (const match of String(text || "").matchAll(QUOTED_SURFACE)) {
    const surface = clean(match[1]);
    if (surface && !/^[①②③④⑤⑥⑦⑧⑨⑩\d]+$/u.test(surface) && !looksLikeEffectClause(surface)) surfaces.push(surface);
  }
  return unique(surfaces);
}

function looksLikeEffectClause(surface) {
  return /[「『《【“"]/u.test(surface)
    || (surface.length >= 6
      && /(?:发动|發動|破坏|破壞|特殊召唤|特殊召喚|不能|不可以|适用|適用|送去墓地)/u.test(surface));
}

function bindSurface(surface, cards) {
  const key = normalizeCardKey(surface);
  if (!key || !cards.length) return { surface, status: cards.length ? "unresolved" : "not_evaluated", definitionId: "", candidateCount: 0 };
  const matches = cards.filter((card) => cardSurfaceKeys(card).includes(key));
  const ids = unique(matches.map(cardDefinitionId));
  if (ids.length === 1) return { surface, status: "bound", definitionId: ids[0], candidateCount: matches.length, card: matches[0] };
  return { surface, status: ids.length > 1 ? "ambiguous" : "unresolved", definitionId: "", candidateCount: ids.length };
}

function cardBindingAppearsInDecision(binding, decisionKey) {
  const card = binding.card || {};
  return cardSurfaces(card)
    .map(normalizeComparable)
    .some((key) => key.length >= 2 && decisionKey.includes(key));
}

function assessParticipatingCardBindings({ transition, cardResolution, coverage }) {
  const resolvedCards = Array.isArray(cardResolution?.resolvedCards) ? cardResolution.resolvedCards : [];
  const participatingIds = new Set();
  for (const claim of coverage.claims || []) {
    for (const binding of claim.cardBindings || []) {
      if (binding.status === "bound" && binding.definitionId) participatingIds.add(binding.definitionId);
    }
  }
  for (const card of resolvedCards) {
    const id = cardDefinitionId(card);
    if (id && transitionEvidenceReferencesCard(transition, card)) participatingIds.add(id);
  }
  const bindings = [...participatingIds].map((definitionId) => {
    const candidates = resolvedCards.filter((card) => cardDefinitionId(card) === definitionId);
    if (candidates.length !== 1) {
      return { definitionId, status: candidates.length ? "ambiguous" : "missing", trusted: false };
    }
    return assessResolvedCardProvenance(candidates[0]);
  });
  const reasons = [];
  if (participatingIds.size === 0) reasons.push("semantic_participating_card_bindings_missing");
  if (bindings.some((binding) => binding.status === "ambiguous")) reasons.push("semantic_participating_card_binding_ambiguous");
  if (bindings.some((binding) => binding.status === "missing")) reasons.push("semantic_participating_card_binding_missing");
  if (bindings.some((binding) => !binding.trusted)) reasons.push("semantic_participating_card_provenance_untrusted");
  return {
    complete: reasons.length === 0,
    participatingDefinitionIds: [...participatingIds],
    bindings,
    reasons: unique(reasons),
  };
}

function assessResolvedCardProvenance(card) {
  const definitionId = cardDefinitionId(card);
  const confidence = Number(card?.confidence);
  const resolutionSource = clean(card?.resolutionSource || card?.identityProvenance?.source || "");
  const inputKey = normalizeCardKey(card?.input || card?.matchedQuery || "");
  const declaredNameKeys = unique([
    card?.name,
    card?.cnName,
    card?.jaName,
    card?.jpName,
    card?.enName,
    ...(Array.isArray(card?.aliases) ? card.aliases : []),
  ].map(normalizeCardKey).filter(Boolean));
  const exactSurfaceBinding = Boolean(inputKey && declaredNameKeys.includes(inputKey));
  const stableIdentity = Boolean(definitionId && !/^resolved-|^card-text-/u.test(definitionId));
  const highConfidenceQueryBinding = Number.isFinite(confidence)
    && confidence >= 0.9
    && resolutionSource === "query"
    && exactSurfaceBinding;
  const reliableCardTextReference = Number.isFinite(confidence)
    && confidence >= 0.85
    && resolutionSource === "card_text_reference"
    && exactSurfaceBinding;
  const reliableOfficialDatabaseBinding = Number.isFinite(confidence)
    && confidence >= 0.88
    && resolutionSource === "query"
    && /^https:\/\/(?:www\.)?(?:db\.ygoresources\.com|db\.yugioh-card\.com)\//iu.test(String(card?.sourceUrl || ""));
  const explicitVerifiedProvenance = card?.identityProvenance?.verified === true
    && card?.identityProvenance?.unique === true
    && Number(card?.identityProvenance?.confidence) >= 0.9;
  const trusted = stableIdentity
    && (highConfidenceQueryBinding || reliableCardTextReference || reliableOfficialDatabaseBinding || explicitVerifiedProvenance);
  return {
    definitionId,
    status: "bound",
    trusted,
    confidence: Number.isFinite(confidence) ? confidence : null,
    resolutionSource: resolutionSource || "missing",
    exactSurfaceBinding,
    stableIdentity,
    proofKind: explicitVerifiedProvenance
      ? "verified_identity_provenance"
      : reliableCardTextReference
        ? "unique_exact_card_text_reference"
        : reliableOfficialDatabaseBinding
          ? "unique_official_database_binding"
        : highConfidenceQueryBinding
          ? "unique_high_confidence_query_binding"
          : "untrusted",
  };
}

function transitionEvidenceReferencesCard(transition, card) {
  const id = cardDefinitionId(card);
  const evidenceIds = new Set(cleanStrings(transition?.evidenceIds || []));
  if (evidenceIds.has(`card-text-${id}`)) return true;
  const cardEvidenceIds = cleanStrings([
    card?.evidenceId,
    card?.sourceEvidenceId,
    card?.cardTextEvidenceId,
  ]);
  if (cardEvidenceIds.some((evidenceId) => evidenceIds.has(evidenceId))) return true;
  return collectExplicitDefinitionIds(transition).has(id);
}

function collectExplicitDefinitionIds(value, output = new Set(), path = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectExplicitDefinitionIds(item, output, path);
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:source|receiver|required|target|acquiredFrom|modifierSource)DefinitionId$/u.test(key)) {
      if (item !== null && item !== undefined) output.add(String(item));
      continue;
    }
    if (/^(?:output|referenced)DefinitionIds$/u.test(key) && Array.isArray(item)) {
      for (const id of item) output.add(String(id));
      continue;
    }
    if (["queryCoverage", "immutablePrintedDefinitions", "initialState", "finalState"].includes(key)) continue;
    collectExplicitDefinitionIds(item, output, [...path, key]);
  }
  return output;
}

function semanticDecisionText(transition) {
  const traceSummary = (transition?.trace || []).flatMap((step) => [
    step?.phase,
    step?.status,
    step?.conclusion,
    step?.proof?.conclusion,
    step?.proof?.reason,
  ]);
  return [
    transition?.shortAnswer,
    ...(Array.isArray(transition?.reasoning) ? transition.reasoning : []),
    transition?.activation,
    transition?.resolution,
    transition?.condition,
    transition?.reason,
    ...traceSummary,
    transition?.program?.type,
    transition?.program?.semanticSource,
    JSON.stringify({
      sourceEffect: transition?.program?.sourceEffect,
      responseEffect: transition?.program?.responseEffect,
      responsePredicate: transition?.program?.responsePredicate,
      activationEvent: transition?.program?.activationEvent,
      responseDecision: transition?.program?.responseDecision,
      verdict: transition?.program?.verdict,
      resolutionOrder: transition?.program?.resolutionOrder,
      branches: transition?.program?.branches,
      exactEffectCheck: transition?.program?.exactEffectCheck,
      simultaneousTriggerChain: transition?.simultaneousTriggerChain,
    }),
  ].filter(Boolean).join("\n");
}

function authorityAssessment(trusted, reasons, extra = {}) {
  return {
    trusted,
    reasons: unique(reasons),
    ...extra,
  };
}

function cardSurfaceKeys(card) {
  return unique(cardSurfaces(card).map(normalizeCardKey).filter(Boolean));
}

function cardSurfaces(card) {
  return unique([
    card?.input,
    card?.matchedQuery,
    card?.name,
    card?.cnName,
    card?.jaName,
    card?.jpName,
    card?.enName,
    ...(Array.isArray(card?.aliases) ? card.aliases : []),
  ].filter(Boolean));
}

function cardDefinitionId(card) {
  return clean(card?.definitionId || card?.cardId || card?.id);
}

function normalizeComparable(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s「」『』《》【】“”"'：:・·･．.－—–_\-，,。.!！?？;；、()（）\[\]{}]/gu, "");
}

function clean(value) {
  return String(value || "").trim();
}

function cleanStrings(values) {
  return unique((Array.isArray(values) ? values : [values]).map(clean).filter(Boolean));
}

function unique(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function uniqueBy(values, getKey) {
  const map = new Map();
  for (const value of values || []) {
    const key = getKey(value);
    if (key && !map.has(key)) map.set(key, value);
  }
  return [...map.values()];
}
