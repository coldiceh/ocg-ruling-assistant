import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchCards } from "./baigeCardProvider.mjs";
import { createLocalCardDataProvider } from "./cardDataProvider.mjs";
import { normalizeCardKey } from "./ragCardExtractor.mjs";
import {
  classifyOfficialQaQuestionType,
  extractOfficialQaEffectPhrases,
  extractOfficialQaSemanticConcepts,
  searchOfficialQaEvidence,
} from "./officialQaMatcher.mjs";
import { normalizeOfficialResponses } from "./officialResponses.mjs";
import { isRulebookRecord, retrieveRulebookPassages } from "./rulebookPassageRetriever.mjs";
import { extractNumberedCardIdentities, hasNumberedCardIdentityConflict } from "./numberedCardIdentity.mjs";
import { retrieveLiveOfficialQa } from "./liveOfficialQaProvider.mjs";
import { normalizeCardPasscode } from "./cardPasscode.mjs";
import { projectOfficialQaQuestion } from "./officialQaQuestionProjection.mjs";
import {
  bindTrustedRagDataRevision,
  createRagDataSourceDescriptor,
  RAG_DATA_REVISION_MANIFEST_FILE,
  validateRagDataRevisionManifest,
} from "./ragDataRevisionManifest.mjs";
import { loadRagRuntimeBundle } from "./ragRuntimeBundle.mjs";
import {
  isCanonicalNormalizedRagArray,
  registerCanonicalNormalizedRagData,
} from "./ragNormalizedDataRegistry.mjs";
import {
  isRagRuntimeBundleRequired,
  RagDataUnavailableError,
} from "./ragDataAvailability.mjs";
import {
  normalizeRuleSearchQueryText,
  selectOfficialQaSearchBranch,
} from "./ruleSearchQueryText.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = join(projectRoot, "data");
const dataCache = new Map();
const rawDataCache = new Map();
const emptyDataArray = Object.freeze([]);
const normalizedCardArrayCache = new WeakMap();
const normalizedRecordArrayCache = new WeakMap();
const normalizedDataCache = new WeakMap();
const evidenceRecordBucketsCache = new WeakMap();
const evidenceListCache = new WeakMap();
const retrievalRecordFeatureCache = new WeakMap();
const retrievalQuestionFeatureCache = new WeakMap();
const recordIdentityIndexCache = new WeakMap();
const canonicalCardIdentityIndexCache = new WeakMap();

// These are atomic, card-agnostic facts used by every mechanism query. They
// describe timing, sequence, visibility, zones, actors and activation kinds;
// no entry names a card, a Q&A, or a finished ruling.
const RULE_MECHANISM_FEATURE_PATTERNS = Object.freeze([
  ["timing:same", /(?:同じタイミング|同一时点|同一時點|同一タイミング|same (?:timing|time|activation window)|at the same time)/iu],
  ["quantity:multiple", /(?:複数|多个|多個|multiple|several)/iu],
  ["sequence:order", /(?:順番|顺序|順序|優先度|优先级|priority|in what order|which.{0,40}(?:chain|activate))/isu],
  ["sequence:chain-link-1", /(?:チェーン|连锁|連鎖|\bchain(?:\s+link)?\b|[cＣ])\s*1/iu],
  ["sequence:chain-link-2", /(?:チェーン|连锁|連鎖|\bchain(?:\s+link)?\b|[cＣ])\s*2/iu],
  ["sequence:chain-link-3", /(?:チェーン|连锁|連鎖|\bchain(?:\s+link)?\b|[cＣ])\s*3/iu],
  ["activation:trigger", /(?:誘発|诱发|誘發|trigger)/iu],
  ["activation:mandatory", /(?:必ず発動|必须发动|必須發動|必发|必發|must (?:be )?activat(?:e|ed))/iu],
  ["activation:optional", /(?:任意|选发|選發|optional|発動できる|可以发动)/iu],
  ["activation:card", /(?:カード(?:の発動|を発動)|卡的发动|卡片发动|card activation|(?:spell|trap) card is activated)/iu],
  ["activation:effect", /(?:効果(?:の発動|が発動)|效果发动|效果發動|effect activation|effect is activated)/iu],
  ["visibility:public", /(?:(?<!非)公開|(?<!不)公开|已公開|已公开|\brevealed\b|\bpublic\b|face[ -]?up)/iu],
  ["visibility:private", /(?:非公開|不公开|未公开|private|face[ -]?down|set card)/iu],
  ["zone:hand", /(?:手札|手牌|手卡|\bhand\b)/iu],
  ["zone:field", /(?:フィールド|场上|場上|\bfield\b)/iu],
  ["player:turn", /(?:ターンを進めているプレイヤー|回合玩家|turn player|player whose turn)/iu],
  ["player:opponent", /(?:相手|对方|對方|opponent)/iu],
  ["relation:treated-as", /(?:扱い|视为|視為|作为.{0,12}处理|作為.{0,12}處理|treated as)/iu],
]);

const RULE_MECHANISM_GENERIC_CONCEPTS = new Set([
  "activation",
  "resolution",
  "chain",
  "effect",
  "monster_effect",
]);

const RULE_MECHANISM_CONCEPT_FAMILIES = new Map([
  ["negate", "operation:negate"],
  ["negate_activation", "operation:negate"],
  ["effect_negation", "operation:negate"],
  ["temporary_banish", "operation:banish"],
  ["banish", "operation:banish"],
  ["destroy", "operation:destroy"],
  ["special_summon", "operation:special-summon"],
  ["fusion_summon", "operation:fusion-summon"],
  ["return_hand", "operation:return-hand"],
  ["return_deck", "operation:return-deck"],
  ["send_graveyard", "operation:send-graveyard"],
  ["discard", "operation:discard"],
  ["replacement", "operation:replacement"],
  ["field_presence", "zone:field"],
]);

export async function retrieveRagEvidence({
  userQuery,
  cardResolution = {},
  dataDir = defaultDataDir,
  cards,
  records,
  qaRecords,
  ruleSearchQueries = [],
  ruleSearchQueryProvider,
  enableLiveOfficialQa = false,
  subsumptionCandidatePoolComplete = false,
  maxPerBucket = 5,
  env = {},
  fetchImpl = globalThis.fetch,
  signal,
  onProgressStage,
} = {}) {
  throwIfAborted(signal);
  if (enableLiveOfficialQa && !isDisabled(env.RAG_LIVE_OFFICIAL_QA)) {
    env = { ...env, RAG_LIVE_OFFICIAL_QA: "true" };
  }
  const retrievalStartedAt = Date.now();
  const timingsMs = {};
  let stageStartedAt = Date.now();
  const limits = readRetrievalLimits(env, maxPerBucket);
  const data = cards || records || qaRecords
    ? normalizeInjectedData({ cards, records, qaRecords })
    : await loadRagData(dataDir);
  timingsMs.data = Date.now() - stageStartedAt;
  stageStartedAt = Date.now();
  const cardProvider = createLocalCardDataProvider(data);
  const resolvedCards = cardResolution.resolvedCards || [];
  const providedTexts = normalizeUserProvidedCardTexts(cardResolution.userProvidedCardTexts || [], limits);
  let supplementalRuleQueries = normalizeRuleSearchQueries(ruleSearchQueries, limits);
  let deterministicRuleQueries = normalizeRuleSearchQueries(
    deriveRuleSearchQueries(userQuery),
    limits,
  );
  const retrievalWarnings = [];
  const baigeDebug = { searchCount: 0, cacheHitCount: 0, warnings: [], ambiguousMentions: [] };
  const unresolvedMentions = cardResolution.unresolvedMentions || [];
  const parentheticalAliasKeys = collectParentheticalAliasMentionKeys(unresolvedMentions, resolvedCards);
  const unresolvedResolutionCandidates = unresolvedMentions
    .filter((mention) => !parentheticalAliasKeys.has(normalizeCardKey(mention?.input)));
  const fuzzyCards = resolveUnresolvedMentionCards(unresolvedResolutionCandidates, cardProvider, limits, retrievalWarnings);
  const providedNameKeys = new Set(providedTexts.map((item) => normalizeCardKey(item.name)).filter(Boolean));
  const unresolvedForBaige = unresolvedResolutionCandidates
    .filter((mention) => !providedNameKeys.has(normalizeCardKey(mention.input)));
  // A local short-name or locale gap can produce several fragment candidates
  // even though an external card index has one exact primary-name match. Keep
  // the local ambiguity fail-closed, but let the identity provider try to
  // resolve the user surface instead of silently skipping it.
  const ambiguousForBaige = (cardResolution.ambiguousMentions || [])
    .filter((mention) => !providedNameKeys.has(normalizeCardKey(mention.input)))
    .map((mention) => ({
      ...mention,
      reason: mention.reason || "local_card_identity_ambiguous",
      source: mention.source || "local_identity_candidates",
    }));
  const externalResolutionCandidates = dedupeMentions([
    ...unresolvedForBaige,
    ...ambiguousForBaige,
  ]);
  const [enrichedLocalCards, baigeResolvedCards] = await Promise.all([
    enrichCardsWithBaige(dedupeCards([...resolvedCards, ...fuzzyCards]), {
      fetchImpl,
      env,
      limits,
      canonicalCards: data.cards,
      warnings: retrievalWarnings,
      debug: baigeDebug,
      signal,
    }),
    resolveUnresolvedMentionCardsWithBaige(externalResolutionCandidates, {
      fetchImpl,
      env,
      limits,
      canonicalCards: data.cards,
      warnings: retrievalWarnings,
      debug: baigeDebug,
      signal,
    }),
  ]);
  throwIfAborted(signal);
  const identityVerificationFailures = enrichedLocalCards
    .filter((card) => card.identityVerificationStatus === "unverified")
    .map((card) => ({
      input: card.input || card.matchedQuery || card.name,
      reason: "external_identity_verification_failed",
      source: "retrieval_identity_verification",
      candidateCards: [{
        id: card.id || card.cardId || "",
        name: card.name || "",
        confidence: Number(card.confidence || 0),
      }],
    }));
  const canonicalBaigeCandidates = baigeResolvedCards.map((card) => canonicalizeRetrievedCardIdentity(
    card,
    data.cards,
    retrievalWarnings,
  ));
  const canonicalBaigeCards = canonicalBaigeCandidates.filter((card) => {
    if (card.identityCanonicalizationConflict === true) return false;
    if (card.modelExpansionPendingIdentityReconciliation !== true) return true;
    const surfaceCompatible = card.externalSurfaceCompatible === true;
    const identityUniquelyConverged = card.externalIdentityUniqueConvergence === true;
    const stableLocalIdentity = hasStableLocalIdentityCanonicalization(card);
    if (!surfaceCompatible || !identityUniquelyConverged || !stableLocalIdentity) {
      retrievalWarnings.push(
        `baige_model_expansion_identity_invariant_unverified:${card.matchedQuery || card.name}->${card.name}`,
      );
      if (!stableLocalIdentity) {
        retrievalWarnings.push(
          `baige_model_expansion_stable_identity_unverified:${card.matchedQuery || card.name}->${card.name}`,
        );
      }
      return false;
    }
    return true;
  });
  for (const conflict of canonicalBaigeCandidates.filter((card) => card.identityCanonicalizationConflict === true)) {
    baigeDebug.ambiguousMentions.push(identityConflictMention(conflict));
  }
  const identityVerifiedLocalCards = enrichedLocalCards.filter((card) => (
    card.identityVerificationStatus !== "unverified"
  ));
  if (identityVerifiedLocalCards.length !== enrichedLocalCards.length) {
    retrievalWarnings.push(
      `unverified_local_identities_excluded_before_evidence:${enrichedLocalCards.length - identityVerifiedLocalCards.length}`,
    );
  }
  const verifiedLocalCards = suppressModelExpansionConflicts(
    identityVerifiedLocalCards,
    canonicalBaigeCards,
    retrievalWarnings,
  );
  const canonicalLocalCandidates = verifiedLocalCards.map((card) => canonicalizeRetrievedCardIdentity(
    card,
    data.cards,
    retrievalWarnings,
  ));
  for (const conflict of canonicalLocalCandidates.filter((card) => card.identityCanonicalizationConflict === true)) {
    baigeDebug.ambiguousMentions.push(identityConflictMention(conflict));
  }
  let retrievalCards = mergeCardsByStableIdentity([
    ...canonicalLocalCandidates.filter((card) => card.identityCanonicalizationConflict !== true),
    ...canonicalBaigeCards,
  ]).slice(0, limits.maxCards);
  // Resolve identity conflicts before any card text, scoped FAQ or live-QA
  // lookup is built. A model-supplied canonical expansion may remain useful
  // debug information, but it must not leak evidence into the prompt while the
  // user's original surface is still ambiguous.
  const preEvidenceCardResolution = reconcileRetrievedCardResolution({
    cardResolution,
    retrievedCards: retrievalCards,
    baigeAmbiguousMentions: baigeDebug.ambiguousMentions,
  });
  if (preEvidenceCardResolution.resolvedCards.length !== retrievalCards.length) {
    retrievalWarnings.push(
      `ambiguous_card_identities_excluded_before_evidence:${retrievalCards.length - preEvidenceCardResolution.resolvedCards.length}`,
    );
  }
  retrievalCards = preEvidenceCardResolution.resolvedCards;
  const qaIdentityCards = retrievalCards.filter((card) => card.resolutionSource !== "card_text_reference");
  if (qaIdentityCards.length !== retrievalCards.length) {
    retrievalWarnings.push(`qa_identity_excludes_card_text_references:${retrievalCards.length - qaIdentityCards.length}`);
  }
  let effectiveQaIdentityCards = canonicalizeQaIdentityCards(
    qaIdentityCards.length ? qaIdentityCards : retrievalCards,
    data.cards,
    retrievalWarnings,
  );
  timingsMs.cardResolution = Date.now() - stageStartedAt;
  const remainingUnresolvedMentions = dedupeMentions([
    ...unresolvedMentionsAfterRetrieval(unresolvedResolutionCandidates, retrievalCards),
    ...identityVerificationFailures,
  ]);
  if (parentheticalAliasKeys.size) retrievalWarnings.push(`parenthetical_alias_mentions_collapsed:${parentheticalAliasKeys.size}`);
  if (fuzzyCards.length) retrievalWarnings.push(`unresolved_mentions_fuzzy_matched:${fuzzyCards.map((card) => card.name).join(",")}`);
  if (baigeResolvedCards.length) retrievalWarnings.push(`unresolved_mentions_baige_matched:${baigeResolvedCards.map((card) => card.name).join(",")}`);
  if (providedTexts.length) retrievalWarnings.push("user_provided_text_not_official");
  const recordBuckets = evidenceRecordBuckets(data);
  const allEvidenceRecords = recordBuckets.all;
  const scopedRecordBuckets = scopeRecordBuckets(
    recordBuckets,
    dedupeCards([...effectiveQaIdentityCards, ...retrievalCards]),
  );

  const cardTexts = retrievalCards
    .map((card) => mergeCanonicalCardEvidenceProfile(
      card,
      findCardRecord(card, data.cards) || cardProvider.getCardProfile(card.id || card.cardId),
    ))
    .filter(Boolean)
    .map((card) => cardTextEvidence(card, limits.maxCardTextChars, retrievalWarnings));
  const primaryRuleQueryCardTexts = cardTexts.filter(
    (item) => item.resolutionSource !== "card_text_reference",
  );
  const referenceRuleQueryCardTexts = cardTexts.filter(
    (item) => item.resolutionSource === "card_text_reference",
  );
  const userProvidedCardTextEvidence = dedupeEvidence(providedTexts.map((item, index) => userProvidedTextEvidence(item, index, limits.maxCardTextChars, retrievalWarnings)));
  onProgressStage?.("retrieve_rulings");
  // Card text is already available before the auxiliary query planner runs.
  // Fold its deterministic operation clauses into the first discovery pass so
  // the question-only candidate set covers mandatory branches even when the
  // player's wording mentions only the card name or the final yes/no question.
  deterministicRuleQueries = mergeRuleSearchQueries(
    deterministicRuleQueries,
    [
      ...deriveRuleSearchQueriesFromCardTexts(userQuery, primaryRuleQueryCardTexts),
      ...deriveRuleSearchQueriesFromCardTexts(userQuery, referenceRuleQueryCardTexts, {
        perCardLimit: 2,
        totalLimit: 4,
        source: "card_text_reference_derived_rule_search_query",
      }),
    ],
    limits,
  );
  // Build a broad, question-only candidate set before asking the auxiliary
  // model for query expansions. The model may softly rank these questions and
  // explain premise differences, but it never receives their answers and its
  // output is never an authority or a hard deletion gate.
  const localOfficialMatches = searchOfficialQaEvidence({
    question: userQuery,
    records: scopedRecordBuckets.officialQa,
    resolvedCards: effectiveQaIdentityCards,
    limit: effectiveQaIdentityCards.length
      ? Math.max(256, limits.maxRelatedEvidence * 24)
      : Math.max(20, limits.maxOfficialQa * 4),
    subsumptionCandidatePoolComplete: subsumptionCandidatePoolComplete === true
      || !(cards || records || qaRecords),
  });
  // The pre-planner pass only needs a small question-only sample. Keep this as
  // one aggregate scan; independent branch heads are built after the planner,
  // where they can use both deterministic and model-supplied queries.
  const initialCrossCardOfficialQuestions = rankRecords({
    userQuery,
    records: dedupeBy([
      ...recordBuckets.officialQa,
      ...recordBuckets.faq,
    ], stableRecordKey).filter(hasOfficialQuestionSurface),
    resolvedCards: [],
    mentionQueries: [],
    ruleSearchQueries: deterministicRuleQueries,
    allowNoCardMatch: true,
  })
    .filter((record) => (
      !effectiveQaIdentityCards.length
      || !recordSharesResolvedIdentity(record, effectiveQaIdentityCards)
    ))
    .slice(0, 4);
  const ruleQueryCandidateQuestions = buildRuleQueryCandidateQuestions({
    scopedMatches: localOfficialMatches.all,
    crossCardRecords: initialCrossCardOfficialQuestions,
    resolvedCards: effectiveQaIdentityCards,
    limit: 12,
  });
  let modelCandidateAssessments = [];
  if (typeof ruleSearchQueryProvider === "function") {
    const providedRulePlan = await ruleSearchQueryProvider({
      resolvedCards: retrievalCards,
      userProvidedCardTexts: providedTexts,
      candidateQuestions: ruleQueryCandidateQuestions,
    });
    throwIfAborted(signal);
    const providedRuleQueries = Array.isArray(providedRulePlan)
      ? providedRulePlan
      : providedRulePlan?.queries;
    modelCandidateAssessments = normalizeModelCandidateAssessments(
      Array.isArray(providedRulePlan) ? [] : providedRulePlan?.candidateAssessments,
      ruleQueryCandidateQuestions,
    );
    supplementalRuleQueries = normalizeRuleSearchQueries([
      ...supplementalRuleQueries,
      ...(Array.isArray(providedRuleQueries) ? providedRuleQueries : []),
    ], limits);
  }
  const normalizedRuleQueries = appendSupplementalRuleSearchQueries(
    deterministicRuleQueries,
    supplementalRuleQueries,
    limits,
  );
  const deterministicRuleQueryKeys = new Set(
    deterministicRuleQueries.map(ruleSearchQueryIdentity).filter(Boolean),
  );
  const effectiveSupplementalRuleQueries = normalizedRuleQueries.filter(
    (item) => !deterministicRuleQueryKeys.has(ruleSearchQueryIdentity(item)),
  );
  const independentRuleQueryKeys = effectiveSupplementalRuleQueries
    .map(ruleSearchQueryIdentity)
    .filter(Boolean);
  const crossCardQuestionBranchQueries = selectIndependentRuleQueries({
    deterministicRuleQueries,
    supplementalRuleQueries: effectiveSupplementalRuleQueries,
    limit: 4,
  });
  const crossCardQuestionBranchKeys = crossCardQuestionBranchQueries
    .map(ruleSearchQueryIdentity)
    .filter(Boolean);
  if (normalizedRuleQueries.length) retrievalWarnings.push(`rule_search_queries_used:${normalizedRuleQueries.length}`);
  const mentionQueries = [
    ...remainingUnresolvedMentions.map((item) => item.input),
    ...providedTexts.map((item) => item.name),
  ].filter(Boolean);
  stageStartedAt = Date.now();
  const deterministicRulebookCandidates = retrieveRulebookPassages({
    records: allEvidenceRecords,
    userQuery,
    ruleSearchQueries: deterministicRuleQueries,
    maxPassages: limits.maxRulebookCandidates,
    maxPassageChars: limits.maxRulebookPassageChars,
  });
  const supplementalRulebookCandidates = effectiveSupplementalRuleQueries.length
    ? retrieveRulebookPassages({
      records: allEvidenceRecords,
      userQuery,
      ruleSearchQueries: effectiveSupplementalRuleQueries,
      maxPassages: limits.maxRulebookCandidates,
      maxPassageChars: limits.maxRulebookPassageChars,
    })
    : [];
  const rulebookCandidates = dedupeBy(
    [...deterministicRulebookCandidates, ...supplementalRulebookCandidates],
    stableRecordKey,
  ).slice(0, limits.maxRulebookCandidates);
  timingsMs.rulebook = Date.now() - stageStartedAt;
  if (rulebookCandidates.length) retrievalWarnings.push(`rulebook_passages_retrieved:${rulebookCandidates.length}`);

  stageStartedAt = Date.now();
  const liveQaEvidenceLimit = readPositiveNumber(env.RAG_LIVE_QA_MAX_CANDIDATES, 8);
  // The final prompt remains tightly bounded, but a multi-card question needs
  // a wider discovery pass before semantic ranking.  Otherwise a popular card
  // with a long QA index can crowd out a decisive single-card ruling that is
  // only a few positions deeper in another card's index.  This is still a
  // bounded, on-demand lookup; retrieved records are ranked and trimmed below.
  const liveQaDiscoveryLimit = readPositiveNumber(
    env.RAG_LIVE_QA_DISCOVERY_MAX_CANDIDATES,
    Math.max(liveQaEvidenceLimit, 48),
  );
  const semanticCandidateQaIds = localOfficialMatches.all
    .map((match) => officialQaNumericId(match.record))
    .filter(Boolean);
  // A local snapshot can preserve the full Q&A body while losing the short
  // official heading used by the source page.  This matters most for broad,
  // card-name-free questions: semantic scene scoring may rank the correct long
  // conditional record below the live-hydration budget even when ordinary text
  // retrieval ranks it first.  Feed both independently ranked candidate sets
  // into the bounded live lookup so the fresh source can restore its heading.
  // Neither ranking is allowed to certify the record as direct evidence; the
  // hydrated record still passes through the normal exact/applicability gates.
  const lexicalCandidateQaIds = rankRecordsWithSupplementalQueries({
    userQuery,
    // Scoped and mechanism retrieval must use the same canonical QA pool.
    // Letting QA records re-enter through the generic related bucket bypasses
    // the applicability and multi-card-scene filters below.
    records: scopedRecordBuckets.qa,
    resolvedCards: effectiveQaIdentityCards,
    mentionQueries,
    deterministicRuleQueries,
    supplementalRuleQueries: effectiveSupplementalRuleQueries,
    independentQueryLimit: 4,
    allowNoCardMatch: effectiveQaIdentityCards.length === 0,
  }).map((record) => officialQaNumericId(record)).filter(Boolean);
  const localCandidateQaIds = dedupeBy(
    effectiveQaIdentityCards.length
      ? [...semanticCandidateQaIds, ...lexicalCandidateQaIds]
      : [...lexicalCandidateQaIds, ...semanticCandidateQaIds],
    (value) => String(value),
  ).slice(0, liveQaEvidenceLimit);
  let liveOfficialQa = { records: [], cardMetadata: [], warnings: [], debug: {} };
  const liveQaEnabled = !isDisabled(env.RAG_LIVE_OFFICIAL_QA)
    && (!cards && !records && !qaRecords || isEnabled(env.RAG_LIVE_OFFICIAL_QA));
  if (
    !localOfficialMatches.exact.length
    && liveQaEnabled
    && (effectiveQaIdentityCards.length >= 1 || localCandidateQaIds.length)
  ) {
    liveOfficialQa = await retrieveLiveOfficialQa({
      resolvedCards: effectiveQaIdentityCards,
      candidateQaIds: localCandidateQaIds,
      fetchImpl,
      baseUrl: env.YGORESOURCES_BASE_URL || "https://db.ygoresources.com",
      timeoutMs: readPositiveNumber(env.RAG_LIVE_QA_TIMEOUT_MS, 1800),
      cacheTtlMs: readPositiveNumber(env.RAG_LIVE_QA_CACHE_TTL_MS, 10 * 60 * 1000),
      maxCandidates: liveQaDiscoveryLimit,
      maxConcurrentQaFetches: readPositiveNumber(env.RAG_LIVE_QA_MAX_CONCURRENCY, 6),
      signal,
    });
    retrievalWarnings.push(...(liveOfficialQa.warnings || []));
    if (liveOfficialQa.records?.length) retrievalWarnings.push(`live_official_qa_retrieved:${liveOfficialQa.records.length}`);
    const metadataById = new Map((liveOfficialQa.cardMetadata || []).map((item) => [String(item.id), item]));
    retrievalCards = retrievalCards.map((card) => ({ ...card, ...(metadataById.get(String(card.id || card.cardId)) || {}) }));
    const hydratedQaIdentityCards = retrievalCards.filter(
      (card) => card.resolutionSource !== "card_text_reference",
    );
    effectiveQaIdentityCards = canonicalizeQaIdentityCards(
      hydratedQaIdentityCards.length ? hydratedQaIdentityCards : retrievalCards,
      data.cards,
      retrievalWarnings,
    );
  }
  const modelAssessmentById = new Map(
    modelCandidateAssessments.map((item) => [item.id, item]),
  );
  const unrankedOfficialMatches = liveOfficialQa.records?.length
    ? searchOfficialQaEvidence({
      question: userQuery,
      // Prefer the freshly hydrated locale over a stale/local record with the
      // same stable id. Otherwise the Japanese live question is silently
      // discarded in favour of an older English-only snapshot.
      records: dedupeBy([...liveOfficialQa.records, ...scopedRecordBuckets.officialQa], stableRecordKey),
      resolvedCards: effectiveQaIdentityCards,
      limit: effectiveQaIdentityCards.length
        ? Math.max(256, limits.maxRelatedEvidence * 24)
        : Math.max(20, limits.maxOfficialQa * 4),
      })
    : localOfficialMatches;
  const officialMatches = applyModelAssessmentsToOfficialMatches(
    unrankedOfficialMatches,
    modelAssessmentById,
  );
  timingsMs.officialQa = Date.now() - stageStartedAt;
  const officialQaDirectCandidates = officialMatches.exact
    .filter((match) => (
      isOfficialQaRecord(match.record)
      && match.rawSceneMatch === true
      && !hasSevereQuestionIdentityMismatch(match, effectiveQaIdentityCards.length)
    ))
    .map((match) => evidenceFromOfficialMatch(match, "official_qa", limits.maxEvidenceTextChars, retrievalWarnings))
    .slice(0, limits.maxOfficialQa);
  const playerRoleMismatchCount = officialMatches.all.filter(
    (match) => match.playerRoleCompatibility === "mismatch",
  ).length;
  if (playerRoleMismatchCount) {
    retrievalWarnings.push(`official_qa_player_role_mismatch:${playerRoleMismatchCount}`);
  }
  const directIds = new Set(officialQaDirectCandidates.map((item) => item.id));

  stageStartedAt = Date.now();
  // Related evidence remains broad. Handwritten question-type, player-role or
  // scenario classifiers may contribute diagnostic scores, but must not erase
  // an official candidate before the final model can compare its premises.
  const usefulScopedOfficialMatches = officialMatches.all.filter((match) => (
    isOfficialQaRecord(match.record)
  ));
  const scopedSupplementalOfficialRecords = rankRecordsWithSupplementalQueries({
    userQuery,
    records: applyModelAssessmentsToRecords(scopedRecordBuckets.qa, modelAssessmentById),
    resolvedCards: effectiveQaIdentityCards,
    mentionQueries,
    deterministicRuleQueries,
    supplementalRuleQueries: effectiveSupplementalRuleQueries,
    independentQueryLimit: 4,
    allowNoCardMatch: effectiveQaIdentityCards.length === 0 && normalizedRuleQueries.length > 0,
  });
  const scopedOfficialQaRelatedSource = mergeOfficialRelatedSourceItems([
    ...usefulScopedOfficialMatches,
    ...scopedSupplementalOfficialRecords,
  ]).filter((item) => (
    !effectiveQaIdentityCards.length
    || relatedMatchedQuestionCardIds(item).length > 0
    || recordSharesResolvedIdentity(item?.record || item, effectiveQaIdentityCards)
  ));
  // Card-scoped lookup is the highest-signal path, but a general OCG mechanism
  // is often documented on a different card. Search the complete official QA
  // pool with the same rule-query plan and keep a small, bounded related-only
  // reserve. This never upgrades an analogy to a direct ruling and never uses
  // the answer text to resolve card identity.
  const crossCardOfficialPool = applyModelAssessmentsToRecords(dedupeBy([
    ...recordBuckets.officialQa,
    ...recordBuckets.faq,
  ], stableRecordKey).filter(hasOfficialQuestionSurface), modelAssessmentById);
  const eligibleCrossCardOfficialPool = effectiveQaIdentityCards.length
    ? crossCardOfficialPool.filter(
      (record) => !recordSharesResolvedIdentity(record, effectiveQaIdentityCards),
    )
    : [];
  const crossCardOfficialCandidateLimit = Math.max(16, limits.maxRelatedEvidence * 4);
  const modelAssessedCrossCardCandidates = eligibleCrossCardOfficialPool
    .filter(hasEligibleModelCandidateAssessment)
    .sort(compareRetrievedRecords);
  const strictMechanismCrossCardCandidates = eligibleCrossCardOfficialPool.length
    ? rankRecordsWithSupplementalQueries({
        userQuery,
        // Remove same-card records before the independently ranked query heads
        // are bounded. Otherwise scoped records can consume a query's discovery
        // head and hide the first usable cross-card mechanism analogue.
        records: eligibleCrossCardOfficialPool,
        resolvedCards: [],
        mentionQueries: [],
        // Deterministic user/card-text queries stay within card-scoped
        // retrieval. Cross-card analogues require an explicit planner branch.
        deterministicRuleQueries: [],
        supplementalRuleQueries: effectiveSupplementalRuleQueries,
        independentQueryLimit: 4,
        allowNoCardMatch: true,
      })
        .filter((record) => !recordSharesResolvedIdentity(record, effectiveQaIdentityCards))
        .filter((record) => supplementalQueryKeysForItem(record, { strictOnly: true }).length > 0)
    : [];
  const questionBranchCrossCardCandidates = rankOfficialQaQuestionBranches({
    records: eligibleCrossCardOfficialPool,
    // Spend the fixed four-branch budget on model subclaims first, then fill
    // only unused slots with deterministic user/card-text branches. The ranker
    // projects every candidate to its official question before comparison.
    ruleSearchQueries: crossCardQuestionBranchQueries,
    supplementalRuleQueryKeys: independentRuleQueryKeys,
    candidateLimit: crossCardOfficialCandidateLimit,
  });
  const mergedLexicalCrossCardCandidates = mergeOfficialRelatedSourceItems([
    ...strictMechanismCrossCardCandidates,
    ...questionBranchCrossCardCandidates,
  ]).map((item) => item.record || item);
  const lexicallyRankedCrossCardCandidates = eligibleCrossCardOfficialPool.length
    ? reserveSupplementalQueryCoverage(mergedLexicalCrossCardCandidates, crossCardOfficialCandidateLimit, {
          queryKeys: independentRuleQueryKeys,
          strictOnly: false,
        })
        .slice(0, crossCardOfficialCandidateLimit)
    : [];
  // Merge model-assessed and independently ranked candidates, but keep the
  // evidence-derived comparator authoritative. The question-only model may
  // break a genuine tie; it cannot jump ahead of stronger mechanism evidence.
  const crossCardOfficialQaSource = dedupeBy([
    ...lexicallyRankedCrossCardCandidates,
    ...modelAssessedCrossCardCandidates,
  ], stableRecordKey)
    .sort(compareRetrievedRecords)
    .slice(0, crossCardOfficialCandidateLimit);
  const scopedOfficialQaRelatedCandidates = scopedOfficialQaRelatedSource
    .map((item) => item.record
      ? evidenceFromOfficialMatch(item, "related", limits.maxEvidenceTextChars, retrievalWarnings)
      : evidenceFromRecord(item, "related", limits.maxEvidenceTextChars, retrievalWarnings))
    .filter((item) => !directIds.has(item.id));
  const crossCardOfficialQaRelatedCandidates = crossCardOfficialQaSource
    .map((record) => evidenceFromRecord({
      ...record,
      retrievalContext: {
        ...(record.retrievalContext || {}),
        scope: "cross_card_official_mechanism",
        relatedOnly: true,
      },
    }, "related", limits.maxEvidenceTextChars, retrievalWarnings))
    .filter((item) => !directIds.has(item.id));
  const officialQaRelated = allocateOfficialRelatedEvidence({
    scopedCandidates: scopedOfficialQaRelatedCandidates,
    crossCardCandidates: crossCardOfficialQaRelatedCandidates,
    limit: limits.maxRelatedEvidence,
    resolvedCards: effectiveQaIdentityCards,
    supplementalRuleQueryKeys: crossCardQuestionBranchKeys,
  }).map((item) => ({
    ...item,
    retrievalContext: {
      ...(item.retrievalContext || {}),
      relatedOnly: true,
    },
  }));
  const officialQaRelatedCandidateCount = dedupeEvidence([
    ...scopedOfficialQaRelatedCandidates,
    ...crossCardOfficialQaRelatedCandidates,
  ]).length;
  if (crossCardOfficialQaRelatedCandidates.length) {
    retrievalWarnings.push(`cross_card_official_related_retrieved:${crossCardOfficialQaRelatedCandidates.length}`);
  }
  if (officialQaRelatedCandidateCount > limits.maxRelatedEvidence) retrievalWarnings.push(`official_related_limited:${officialQaRelatedCandidateCount}->${limits.maxRelatedEvidence}`);

  const provisionalOfficialResponseSource = rankRecordsWithSupplementalQueries({
    userQuery,
    records: scopedRecordBuckets.provisionalOfficialResponses,
    resolvedCards: retrievalCards,
    mentionQueries,
    deterministicRuleQueries,
    supplementalRuleQueries: effectiveSupplementalRuleQueries,
    allowNoCardMatch: retrievalCards.length === 0,
  });
  const provisionalOfficialResponses = reserveIdentitySourceCoverage(
    provisionalOfficialResponseSource,
    limits.maxOfficialQa,
    retrievalCards,
  )
    .slice(0, limits.maxOfficialQa)
    .map((record) => evidenceFromRecord(record, "official_response_screenshot", limits.maxEvidenceTextChars, retrievalWarnings));
  if (provisionalOfficialResponses.length) {
    retrievalWarnings.push(`provisional_official_responses_retrieved:${provisionalOfficialResponses.length}`);
  }

  const rankedFaqRelatedSource = rankRecordsWithSupplementalQueries({
    userQuery,
    records: applyModelAssessmentsToRecords(scopedRecordBuckets.faq, modelAssessmentById),
    resolvedCards: retrievalCards,
    mentionQueries,
    deterministicRuleQueries,
    supplementalRuleQueries: effectiveSupplementalRuleQueries,
    independentQueryLimit: 4,
    allowNoCardMatch: retrievalCards.length === 0 && normalizedRuleQueries.length > 0,
  });
  const faqRelatedSource = reserveRankedHeadAndSupplementalCoverage(
    rankedFaqRelatedSource,
    limits.maxRelatedEvidence,
    {
      queryKeys: independentRuleQueryKeys,
      strictOnly: true,
    },
  );
  const officialMatchByRecordKey = new Map(
    officialMatches.all.map((match) => [stableRecordKey(match.record), match]),
  );
  if (faqRelatedSource.length > limits.maxRelatedEvidence) retrievalWarnings.push(`faq_related_limited:${faqRelatedSource.length}->${limits.maxRelatedEvidence}`);
  const faqRelated = faqRelatedSource
    .slice(0, limits.maxRelatedEvidence)
    .map((record) => {
      const officialMatch = officialMatchByRecordKey.get(stableRecordKey(record));
      return officialMatch
        ? evidenceFromOfficialMatch(officialMatch, "faq", limits.maxEvidenceTextChars, retrievalWarnings)
        : evidenceFromRecord(record, "faq", limits.maxEvidenceTextChars, retrievalWarnings);
    })
    .filter((item) => !directIds.has(item.id));

  const rawRelatedSource = rankRecordsWithSupplementalQueries({
    userQuery,
    records: applyModelAssessmentsToRecords(scopedRecordBuckets.rawRelated, modelAssessmentById),
    resolvedCards: retrievalCards,
    mentionQueries,
    deterministicRuleQueries,
    supplementalRuleQueries: effectiveSupplementalRuleQueries,
    allowNoCardMatch: retrievalCards.length === 0,
  });
  if (rawRelatedSource.length > limits.maxRelatedEvidence) retrievalWarnings.push(`raw_related_limited:${rawRelatedSource.length}->${limits.maxRelatedEvidence}`);
  const rawRelatedEvidence = rawRelatedSource
    .slice(0, limits.maxRelatedEvidence)
    .map((record) => evidenceFromRecord(record, evidenceTypeForRecord(record, "related"), limits.maxEvidenceTextChars, retrievalWarnings))
    .filter((item) => !directIds.has(item.id));
  const allocatedOfficialRelatedIdSet = new Set(diagnosticCandidateIds(officialQaRelated));
  timingsMs.relatedEvidence = Date.now() - stageStartedAt;
  timingsMs.total = Date.now() - retrievalStartedAt;

  if (!retrievalCards.length) retrievalWarnings.push("card_name_not_resolved_raw_query_fallback_used");
  if (!cardTexts.length && retrievalCards.length) retrievalWarnings.push("resolved_card_text_not_found");
  if (!officialQaDirectCandidates.length) retrievalWarnings.push("official_direct_qa_not_found");

  const reconciledCardResolution = reconcileRetrievedCardResolution({
    cardResolution,
    // Card-text dependency cards remain part of the frozen resolution/Lua
    // input even though they are intentionally excluded from direct-QA
    // identity matching above.
    retrievedCards: retrievalCards,
    remainingUnresolvedMentions,
    baigeAmbiguousMentions: baigeDebug.ambiguousMentions,
  });

  return {
    cardTexts: dedupeEvidence(cardTexts),
    userProvidedCardTexts: userProvidedCardTextEvidence,
    officialQaDirectCandidates: dedupeEvidence(officialQaDirectCandidates),
    officialQaRelated: dedupeEvidence(officialQaRelated),
    provisionalOfficialResponses: dedupeEvidence(provisionalOfficialResponses),
    faqRelated: dedupeEvidence(faqRelated),
    rawRelatedEvidence: dedupeEvidence([...rulebookCandidates.slice(0, limits.maxRelatedEvidence), ...rawRelatedEvidence]),
    rulebookCandidates,
    // Keep the canonical local card id on the answer path even when the card
    // was first found through a Baige passcode or another external id.
    retrievedCards: reconciledCardResolution.resolvedCards,
    cardResolution: reconciledCardResolution,
    remainingUnresolvedMentions,
    fuzzyResolvedCards: fuzzyCards,
    baigeResolvedCards,
    baigeAmbiguousMentions: baigeDebug.ambiguousMentions,
    ruleSearchQueries: normalizedRuleQueries,
    retrievalWarnings,
    debug: {
      searchPaths: officialMatches.searchPaths || [],
      recordCount: allEvidenceRecords.length,
      cardCount: data.cards.length,
      userProvidedCardTextCount: providedTexts.length,
      rulebookCandidateCount: rulebookCandidates.length,
      officialMechanismAnalogueCount: crossCardOfficialQaRelatedCandidates.length,
      scopedRecordCounts: {
        officialQa: scopedRecordBuckets.officialQa.length,
        qa: scopedRecordBuckets.qa.length,
        provisionalOfficialResponses: scopedRecordBuckets.provisionalOfficialResponses.length,
        faq: scopedRecordBuckets.faq.length,
        rawRelated: scopedRecordBuckets.rawRelated.length,
      },
      timingsMs,
      ruleSearchQueryCount: normalizedRuleQueries.length,
      ruleSearchQueries: normalizedRuleQueries,
      deterministicRuleSearchQueryCount: deterministicRuleQueries.length,
      supplementalRuleSearchQueryCount: effectiveSupplementalRuleQueries.length,
      candidateStages: {
        initialCrossCardQuestionIds: diagnosticCandidateIds(initialCrossCardOfficialQuestions),
        rulePlannerCandidateIds: diagnosticCandidateIds(ruleQueryCandidateQuestions),
        ruleQueryQuestionBranchCandidateIds: diagnosticCandidateIds(questionBranchCrossCardCandidates),
        scopedOfficialMatchIds: diagnosticCandidateIds(usefulScopedOfficialMatches),
        scopedSupplementalOfficialIds: diagnosticCandidateIds(scopedSupplementalOfficialRecords),
        scopedOfficialRelatedCandidateIds: diagnosticCandidateIds(scopedOfficialQaRelatedCandidates),
        crossCardRankedPoolIds: diagnosticCandidateIds(crossCardOfficialQaSource),
        crossCardEvidenceCandidateIds: diagnosticCandidateIds(crossCardOfficialQaRelatedCandidates),
        allocatedOfficialRelatedIds: diagnosticCandidateIds(officialQaRelated),
        allocatedCrossCardIds: diagnosticCandidateIds(
          officialQaRelated.filter((item) => (
            item?.retrievalContext?.scope === "cross_card_official_mechanism"
          )),
        ),
        notAllocatedScopedIds: diagnosticCandidateIds(scopedOfficialQaRelatedCandidates)
          .filter((id) => !allocatedOfficialRelatedIdSet.has(id)),
        notAllocatedCrossCardIds: diagnosticCandidateIds(crossCardOfficialQaRelatedCandidates)
          .filter((id) => !allocatedOfficialRelatedIdSet.has(id)),
      },
      baigeSearchCount: baigeDebug.searchCount,
      baigeCacheHitCount: baigeDebug.cacheHitCount,
      baigeWarnings: baigeDebug.warnings,
      liveOfficialQa: liveOfficialQa.debug || {},
    },
  };
}

function rulebookSourceIdentity(record = {}) {
  return String(record.stableId || record.sourceRecordId || record.id || record.evidenceId || "")
    .replace(/@[a-f0-9]{8,}$/iu, "");
}

export async function loadRagData(dataDir = defaultDataDir, {
  requireRuntimeBundle = isRagRuntimeBundleRequired(),
} = {}) {
  const key = `${requireRuntimeBundle ? "bundle-required" : "raw-fallback-allowed"}:${dataDir}`;
  if (dataCache.has(key)) return await dataCache.get(key);
  const pending = (async () => {
    const runtimeBundle = await loadRagRuntimeBundle({ dataDir });
    if (runtimeBundle.ok) return runtimeBundle.data;
    if (requireRuntimeBundle) {
      throw unavailableRagDataError({
        phase: "runtime_bundle",
        reason: "runtime_bundle_required",
        bundleReason: runtimeBundle.reason,
        bundleReasons: runtimeBundle.reasons,
      });
    }
    try {
      return await loadRawRagData(dataDir);
    } catch (error) {
      throw unavailableRagDataError({
        phase: "runtime_bundle_and_raw_fallback",
        reason: "no_verified_rag_snapshot_available",
        bundleReason: runtimeBundle.reason,
        bundleReasons: runtimeBundle.reasons,
        rawReason: error?.details?.reason || error?.code || "raw_fallback_failed",
        rawSource: error?.details?.source || "",
      }, error);
    }
  })();
  dataCache.set(key, pending);
  try {
    const data = await pending;
    dataCache.set(key, data);
    return data;
  } catch (error) {
    if (dataCache.get(key) === pending) dataCache.delete(key);
    throw error;
  }
}

// This explicit raw-only entry point is used by the synchronization compiler
// and by the all-or-nothing runtime-bundle fallback. It must never consult a
// previously generated bundle, otherwise stale artifacts could compile
// themselves and falsely pass the source-equivalence gate.
export async function loadRawRagData(dataDir = defaultDataDir) {
  const key = dataDir;
  if (rawDataCache.has(key)) return await rawDataCache.get(key);
  const pending = (async () => {
    const [cardsSource, rulingsSource, qaSource, evidenceSource, rulebookSource, officialResponsesSource, revisionManifest] = await Promise.all([
      readRequiredJsonSource(dataDir, "cards.json", ["records", "cards"]),
      readRequiredJsonSource(dataDir, "rulings.json", ["records"]),
      readRequiredJsonSource(dataDir, "qa-index.json", ["records"]),
      readRequiredJsonSource(dataDir, "evidence-index.json", ["records"]),
      readRequiredJsonSource(dataDir, "ocg-rule-corpus.json", ["records"]),
      readRequiredJsonSource(dataDir, "official-responses.json", ["records", "officialResponses"]),
      readJson(join(dataDir, RAG_DATA_REVISION_MANIFEST_FILE), null),
    ]);
    const cardsPayload = cardsSource.payload;
    const rulingsPayload = rulingsSource.payload;
    const qaPayload = qaSource.payload;
    const evidencePayload = evidenceSource.payload;
    const rulebookPayload = rulebookSource.payload;
    const officialResponsesPayload = officialResponsesSource.payload;
    const bundledRulebookRecords = rulebookPayload.records || [];
    const hasBundledRulebook = bundledRulebookRecords.length > 0;
    const evidenceRecords = (evidencePayload.records || []).filter((record) => (
      !hasBundledRulebook
      || (record.sourceId !== "ocg-rule" && !rulebookSourceIdentity(record).startsWith("ocg-rule:"))
    ));
    const data = normalizeInjectedData({
      cards: cardsPayload.records || cardsPayload.cards || [],
      records: [
        ...(rulingsPayload.records || []),
        ...bundledRulebookRecords,
        ...evidenceRecords,
        ...normalizeOfficialResponses(officialResponsesPayload),
      ],
      qaRecords: qaPayload.records || [],
    });
    if (data.cards.length === 0 || data.records.length + data.qaRecords.length === 0) {
      throw unavailableRagDataError({
        phase: "raw_fallback",
        reason: "raw_corpus_empty",
        cards: data.cards.length,
        evidenceRecords: data.records.length + data.qaRecords.length,
      });
    }
    const sourceDescriptors = [
      cardsSource,
      rulingsSource,
      qaSource,
      evidenceSource,
      rulebookSource,
      officialResponsesSource,
    ].map((source) => source.descriptor).filter(Boolean);
    const manifestValidation = validateRagDataRevisionManifest(revisionManifest, {
      data,
      sources: sourceDescriptors,
      // The manifest digest is generated from this normalized corpus during
      // synchronization. At runtime the byte-exact source digests bind that
      // digest without repeating the expensive full canonical serialization.
      verifyCanonicalCorpus: false,
    });
    bindTrustedRagDataRevision(data, manifestValidation);
    return data;
  })();
  rawDataCache.set(key, pending);
  try {
    const data = await pending;
    rawDataCache.set(key, data);
    return data;
  } catch (error) {
    if (rawDataCache.get(key) === pending) rawDataCache.delete(key);
    throw error;
  }
}

export function evidenceBucketsToList(evidence = {}) {
  if (evidence && typeof evidence === "object") {
    const cached = evidenceListCache.get(evidence);
    if (cached) return cached;
  }
  const records = [
    ...(evidence.cardTexts || []),
    ...(evidence.userProvidedCardTexts || []),
    ...(evidence.officialQaDirectCandidates || []),
    ...(evidence.officialQaRelated || []),
    ...(evidence.provisionalOfficialResponses || []),
    ...(evidence.faqRelated || []),
    ...(evidence.rawRelatedEvidence || []),
  ];
  if (evidence && typeof evidence === "object") evidenceListCache.set(evidence, records);
  return records;
}

export function normalizeInjectedData({ cards = [], records = [], qaRecords = [] } = {}) {
  const sourceCards = Array.isArray(cards) ? cards : emptyDataArray;
  const sourceRecords = Array.isArray(records) ? records : emptyDataArray;
  const sourceQaRecords = Array.isArray(qaRecords) ? qaRecords : emptyDataArray;
  const cached = cachedNormalizedData(sourceCards, sourceRecords, sourceQaRecords);
  if (cached) return cached;

  const normalizedCards = normalizeDataArray(
    sourceCards,
    normalizedCardArrayCache,
    normalizeCard,
    (card) => card.name,
    "cards",
  );
  const normalizedRecords = normalizeDataArray(
    sourceRecords,
    normalizedRecordArrayCache,
    normalizeRecord,
    (record) => record.id && record.text,
    "records",
  );
  const normalizedQaRecords = normalizeDataArray(
    sourceQaRecords,
    normalizedRecordArrayCache,
    normalizeRecord,
    (record) => record.id && record.text,
    "qaRecords",
  );
  const canonical = cachedNormalizedData(normalizedCards, normalizedRecords, normalizedQaRecords);
  if (canonical) {
    cacheNormalizedData(sourceCards, sourceRecords, sourceQaRecords, canonical);
    return canonical;
  }

  const data = registerCanonicalNormalizedRagData({
    cards: normalizedCards,
    records: normalizedRecords,
    qaRecords: normalizedQaRecords,
  });
  cacheNormalizedData(sourceCards, sourceRecords, sourceQaRecords, data);
  cacheNormalizedData(normalizedCards, normalizedRecords, normalizedQaRecords, data);
  return data;
}

function normalizeDataArray(source, cache, normalizer, predicate, role) {
  const cached = cache.get(source);
  if (cached) return cached;
  if (isCanonicalNormalizedRagArray(source, role)) {
    cache.set(source, source);
    return source;
  }
  const normalized = source.map(normalizer).filter(predicate);
  cache.set(source, normalized);
  cache.set(normalized, normalized);
  return normalized;
}

function cachedNormalizedData(cards, records, qaRecords) {
  return normalizedDataCache.get(records)?.get(cards)?.get(qaRecords) || null;
}

function cacheNormalizedData(cards, records, qaRecords, data) {
  let byCards = normalizedDataCache.get(records);
  if (!byCards) {
    byCards = new WeakMap();
    normalizedDataCache.set(records, byCards);
  }
  let byQaRecords = byCards.get(cards);
  if (!byQaRecords) {
    byQaRecords = new WeakMap();
    byCards.set(cards, byQaRecords);
  }
  byQaRecords.set(qaRecords, data);
}

function evidenceRecordBuckets(data) {
  const cached = evidenceRecordBucketsCache.get(data);
  if (cached) return cached;
  const all = [...data.records, ...data.qaRecords];
  // Rich ruling records and the cumulative QA index can contain different
  // snapshots of the same official item. Select the structurally most complete
  // version instead of relying on which source array happens to come first:
  // either source can be the fresher one after an incremental synchronization.
  // Every official path consumes this one canonical pool.
  const canonicalOfficial = selectBestOfficialRecordVersions(
    all.filter((record) => (
      ["qa", "card-faq", "official-database"].includes(record.recordType)
      && isAuthoritativeQaOrFaqRecord(record)
      && !["removed", "superseded", "conflict", "parse_failed"].includes(record.status)
    )),
  );
  const buckets = {
    all,
    officialQa: canonicalOfficial.filter(isOfficialQaRecord),
    qa: canonicalOfficial.filter(isOfficialQaRecord),
    provisionalOfficialResponses: all.filter(isProvisionalOfficialResponseRecord),
    faq: canonicalOfficial.filter((record) => record.recordType === "card-faq"),
    rawRelated: all.filter((record) => (
      !isAuthoritativeQaOrFaqRecord(record)
      && record.recordType !== "card-text"
      && !isRulebookRecord(record)
      && !isProvisionalOfficialResponseRecord(record)
    )),
  };
  evidenceRecordBucketsCache.set(data, buckets);
  return buckets;
}

function selectBestOfficialRecordVersions(records = []) {
  const selected = new Map();
  for (const record of records || []) {
    const key = stableRecordKey(record);
    if (!key) continue;
    const previous = selected.get(key);
    if (!previous || compareOfficialRecordCompleteness(record, previous) < 0) {
      selected.set(key, record);
    }
  }
  return [...selected.values()];
}

function compareOfficialRecordCompleteness(left = {}, right = {}) {
  const leftQuality = officialRecordCompleteness(left);
  const rightQuality = officialRecordCompleteness(right);
  for (let index = 0; index < leftQuality.length; index += 1) {
    if (leftQuality[index] !== rightQuality[index]) {
      return rightQuality[index] - leftQuality[index];
    }
  }
  // Equal-quality mirrors retain their original corpus order. The order is
  // deterministic, and a source label never changes evidence authority.
  return 0;
}

function officialRecordCompleteness(record = {}) {
  const question = String(record.question || "").trim();
  const detailedQuestion = String(record.rawDetailedQuestion || "").trim();
  const answer = String(record.answer || record.conclusion || "").trim();
  const officialText = String(record.officialText || "").trim();
  const body = String(record.text || "").trim();
  const questionIds = new Set((record.questionCardIds || []).map(normalizeCardIdentityId).filter(Boolean));
  const cardIds = new Set((record.cardIds || []).map(normalizeCardIdentityId).filter(Boolean));
  return [
    Number(Boolean(question && answer)),
    Number(Boolean(answer)),
    Number(Boolean(detailedQuestion)),
    Number(Boolean(question)),
    Number(Boolean(record.sourceUrl || record.officialUrl)),
    questionIds.size,
    cardIds.size,
    Math.min(answer.length, 16_000),
    Math.min(detailedQuestion.length, 16_000),
    Math.min(Math.max(body.length, officialText.length), 32_000),
  ];
}

function scopeRecordBuckets(buckets, resolvedCards) {
  return {
    officialQa: recordsForResolvedCards(buckets.officialQa, resolvedCards),
    qa: recordsForResolvedCards(buckets.qa, resolvedCards),
    provisionalOfficialResponses: recordsForResolvedCards(buckets.provisionalOfficialResponses, resolvedCards),
    faq: recordsForResolvedCards(buckets.faq, resolvedCards),
    rawRelated: recordsForResolvedCards(buckets.rawRelated, resolvedCards),
  };
}

function recordsForResolvedCards(records, resolvedCards) {
  const identities = cardIdentityKeys(resolvedCards);
  if (!identities.length || !(records || []).length) return records || [];
  const index = recordIdentityIndex(records);
  const matched = new Set();
  for (const identity of identities) {
    for (const record of index.get(identity) || []) matched.add(record);
  }
  return matched.size ? [...matched] : records;
}

function cardIdentityKeys(cards) {
  const keys = [];
  const seen = new Set();
  for (const card of cards || []) {
    const id = normalizeCardIdentityId(card.id || card.cardId);
    if (id && !seen.has("id:" + id)) {
      seen.add("id:" + id);
      keys.push("id:" + id);
    }
    for (const name of [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]) {
      const key = normalizeCardKey(name);
      if (!key || seen.has("name:" + key)) continue;
      seen.add("name:" + key);
      keys.push("name:" + key);
    }
  }
  return keys;
}

function canonicalizeQaIdentityCards(cards, canonicalCards, warnings) {
  return (cards || []).map((card) => canonicalizeRetrievedCardIdentity(
    card,
    canonicalCards,
    warnings,
  ));
}

function canonicalCardIdentityIndex(cards) {
  const cached = canonicalCardIdentityIndexCache.get(cards);
  if (cached) return cached;
  const byId = new Map();
  const byCid = new Map();
  const byPasscode = new Map();
  const byAlias = new Map();
  for (const card of cards || []) {
    const id = normalizeCardIdentityId(card.id || card.cardId);
    if (id) byId.set(id, card);
    const cid = verifiedLocalCardCid(card);
    if (cid) addIdentityIndexCandidate(byCid, cid, card);
    const passcode = verifiedEnginePasscode(card);
    if (passcode) addIdentityIndexCandidate(byPasscode, passcode, card);
    for (const name of [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]) {
      const key = normalizeCardKey(name);
      if (!key) continue;
      const matches = byAlias.get(key) || [];
      matches.push(card);
      byAlias.set(key, matches);
    }
  }
  const index = { byId, byCid, byPasscode, byAlias };
  canonicalCardIdentityIndexCache.set(cards, index);
  return index;
}

function addIdentityIndexCandidate(index, key, card) {
  const candidates = index.get(key) || [];
  if (!candidates.includes(card)) candidates.push(card);
  index.set(key, candidates);
}

function canonicalizeRetrievedCardIdentity(card, canonicalCards, warnings = []) {
  if (!card || typeof card !== "object") return card;
  const index = canonicalCardIdentityIndex(canonicalCards);
  const currentId = normalizeCardIdentityId(card.id || card.cardId);
  const strongCandidates = new Set();
  const direct = currentId ? index.byId.get(currentId) : null;
  if (direct) strongCandidates.add(direct);

  const cid = verifiedExternalCardCid(card);
  if (cid) {
    for (const candidate of index.byCid.get(cid) || []) strongCandidates.add(candidate);
  }
  const passcode = verifiedEnginePasscode(card)
    || (/^[1-9]\d{4,9}$/u.test(currentId) ? currentId : "");
  if (passcode) {
    for (const candidate of index.byPasscode.get(passcode) || []) strongCandidates.add(candidate);
  }

  if (strongCandidates.size > 1) {
    warnings.push(`qa_identity_canonicalization_conflict:${card.input || card.name || currentId}`);
    return {
      ...card,
      identityCanonicalizationConflict: true,
      identityCanonicalizationCandidates: [...strongCandidates].map(summarizeIdentityCandidate),
    };
  }

  let canonical = strongCandidates.size === 1 ? [...strongCandidates][0] : null;
  if (!canonical) {
    const aliasCandidates = new Set();
    for (const name of cardIdentityNames(card)) {
      const key = normalizeCardKey(name);
      if (!key) continue;
      for (const candidate of index.byAlias.get(key) || []) aliasCandidates.add(candidate);
    }
    if (aliasCandidates.size > 1) {
      warnings.push(`qa_identity_canonicalization_ambiguous:${card.name || card.input || currentId}`);
      return {
        ...card,
        identityCanonicalizationConflict: true,
        identityCanonicalizationCandidates: [...aliasCandidates].map(summarizeIdentityCandidate),
      };
    }
    canonical = aliasCandidates.size === 1 ? [...aliasCandidates][0] : null;
  }
  if (!canonical) return ensureCardMentionAlias(card);

  const canonicalId = normalizeCardIdentityId(canonical.id || canonical.cardId);
  if (canonicalId && canonicalId !== currentId) {
    warnings.push(`qa_identity_canonicalized:${currentId || cid || passcode || "name"}->${canonicalId}`);
  }
  return mergeCanonicalIdentityCard(card, canonical, canonicalId);
}

function mergeCanonicalIdentityCard(card, canonical, canonicalId) {
  const externalPasscode = verifiedEnginePasscode(card);
  const inputKey = normalizeCardKey(card.input);
  const externalSurfaceExact = inputKey && [
    card.name,
    card.cnName,
    card.jaName,
    card.jpName,
    card.enName,
    ...(card.aliases || []),
  ].map(normalizeCardKey).includes(inputKey);
  return ensureCardMentionAlias({
    ...card,
    id: canonicalId || String(card.id || card.cardId || ""),
    cardId: canonicalId || String(card.cardId || card.id || ""),
    passcode: externalPasscode || verifiedEnginePasscode(canonical),
    cid: verifiedLocalCardCid(canonical) || verifiedExternalCardCid(card) || null,
    name: externalSurfaceExact
      ? card.name || card.cnName || canonical.name
      : canonical.name || canonical.cnName || card.name,
    cnName: externalSurfaceExact
      ? card.cnName || canonical.cnName
      : canonical.cnName || card.cnName,
    jaName: canonical.jaName || card.jaName || card.jpName,
    jpName: canonical.jpName || canonical.jaName || card.jpName || card.jaName,
    enName: canonical.enName || card.enName,
    type: canonical.type || canonical.cardType || card.type || card.cardType,
    cardType: canonical.cardType || canonical.type || card.cardType || card.type,
    attribute: hasValue(canonical.attribute) ? canonical.attribute : card.attribute,
    race: hasValue(canonical.race) ? canonical.race : card.race,
    atk: canonical.atk ?? canonical.attack ?? card.atk ?? card.attack,
    def: canonical.def ?? canonical.defense ?? card.def ?? card.defense,
    level: canonical.level ?? card.level,
    rank: canonical.rank ?? card.rank,
    link: canonical.link ?? canonical.linkRating ?? card.link ?? card.linkRating,
    effectText: canonical.effectText || card.effectText || card.text,
    text: canonical.text || canonical.effectText || card.text || card.effectText,
    sourceUrl: canonical.sourceUrl || card.sourceUrl,
    aliases: cardIdentityNames(card, canonical),
    qaIdentityOriginalId: canonicalId && canonicalId !== String(card.id || card.cardId || "")
      ? String(card.id || card.cardId || "")
      : card.qaIdentityOriginalId,
    identityCanonicalizationSource: verifiedExternalCardCid(card)
      ? "cid"
      : externalPasscode
        ? "passcode"
        : "exact_alias",
  });
}

function summarizeIdentityCandidate(card = {}) {
  return {
    id: String(card.id || card.cardId || ""),
    passcode: verifiedEnginePasscode(card),
    name: card.name || card.cnName || card.jaName || card.enName || "",
  };
}

function identityConflictMention(card = {}) {
  return {
    input: card.input || card.matchedQuery || card.name || "",
    reason: "conflicting_external_card_identity",
    source: "retrieval_identity_canonicalization",
    candidateCards: card.identityCanonicalizationCandidates || [],
  };
}

function recordIdentityIndex(records) {
  const cached = recordIdentityIndexCache.get(records);
  if (cached) return cached;
  const index = new Map();
  for (const record of records || []) {
    const rankingIdentity = retrievalRankingIdentity(record);
    const keys = new Set([
      ...rankingIdentity.cardIds
        .map((id) => "id:" + normalizeCardIdentityId(id))
        .filter((key) => key !== "id:"),
      ...rankingIdentity.cardNames
        .map((name) => "name:" + normalizeCardKey(name))
        .filter((key) => key !== "name:"),
    ]);
    for (const key of keys) {
      const matches = index.get(key) || [];
      matches.push(record);
      index.set(key, matches);
    }
  }
  recordIdentityIndexCache.set(records, index);
  return index;
}

function normalizeCard(card = {}) {
  return {
    ...card,
    id: String(card.id || card.cardId || ""),
    cardId: String(card.cardId || card.id || ""),
    name: card.name || card.cnName || card.jaName || card.enName || "",
    aliases: [
      card.name,
      card.cnName,
      card.jaName,
      card.enName,
      ...(Array.isArray(card.aliases) ? card.aliases : []),
    ].filter(Boolean),
  };
}

function normalizeRecord(record = {}) {
  const id = String(record.id || record.evidenceId || record.stableId || record.sourceId || "");
  const recordType = record.recordType || inferRecordType(record, id);
  const answer = record.answer || record.conclusion || "";
  const questionProjection = projectOfficialQaQuestion(record);
  const structuredQaText = record.question && answer
    ? [
        record.question,
        record.rawDetailedQuestion && record.rawDetailedQuestion !== record.question
          ? record.rawDetailedQuestion
          : "",
        answer,
      ].filter(Boolean).join("\n").trim()
    : "";
  const text = structuredQaText || String(record.text || record.officialText || record.question || answer || record.title || "").trim();
  const metadataCardIds = structuredRecordOwnershipCardIds(record);
  const cardIds = [...new Set([
    ...metadataCardIds,
    ...(recordType === "card-faq" ? [] : extractInlineCardIds(text)),
  ].map((item) => String(item || "")).filter(Boolean))];
  const questionCardIds = [...new Set((recordType === "card-faq"
    ? metadataCardIds
    : questionProjection.principalCardIds)
    .map((item) => String(item || ""))
    .filter(Boolean))];
  const cards = [record.cardName, ...(record.cards || []), ...(record.cardNames || [])].filter(Boolean);
  return {
    ...record,
    id,
    recordType,
    title: record.title || record.question || id,
    question: record.question || questionProjection.scenarioText || "",
    answer: record.answer || record.conclusion || questionProjection.answerText || "",
    text,
    cardIds,
    metadataCardIds,
    questionCardIds,
    cards,
    sourceUrl: evidenceSourceUrl({ ...record, cardIds }),
    status: record.status || "current",
  };
}

function structuredRecordOwnershipCardIds(record = {}) {
  const declaredIds = Array.isArray(record.metadataCardIds)
    ? record.metadataCardIds
    : record.metadataCardIds || record.cardIds;
  const cardValues = Array.isArray(record.cards) ? record.cards : [];
  return [...new Set([
    record.cardId,
    ...(Array.isArray(declaredIds) ? declaredIds : [declaredIds]),
    ...cardValues.map((value) => (
      value && typeof value === "object"
        ? value.cardId || value.id
        : /^\d+$/u.test(String(value || "").trim()) ? value : ""
    )),
  ].map((item) => String(item || "").trim()).filter(Boolean))];
}

function structuredRecordOwnershipCardNames(record = {}) {
  const cardValues = Array.isArray(record.cards) ? record.cards : [];
  return [...new Set([
    record.cardName,
    ...cardValues.flatMap((value) => (
      value && typeof value === "object"
        ? [value.name, value.cnName, value.jaName, value.jpName, value.enName]
        : /^\d+$/u.test(String(value || "").trim()) ? [] : [value]
    )),
    ...(Array.isArray(record.cardNames) ? record.cardNames : [record.cardNames]),
  ].map((item) => String(item || "").trim()).filter(Boolean))];
}

function inferRecordType(record, id) {
  if (String(id).startsWith("card-text-")) return "card-text";
  if (String(id).startsWith("card-faq-")) return "card-faq";
  if (record.question || String(id).includes("qa")) return "qa";
  return "related";
}

function findCardRecord(card, cards) {
  const wantedId = normalizeCardIdentityId(card.id || card.cardId);
  const wantedNames = new Set([card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].map(normalizeCardKey).filter(Boolean));
  return cards.find((item) => wantedId && normalizeCardIdentityId(item.id || item.cardId) === wantedId)
    || cards.find((item) => item.aliases.some((alias) => wantedNames.has(normalizeCardKey(alias))))
    || null;
}

function cardTextEvidence(card, maxTextChars, warnings) {
  const text = String(card.effectText || card.text || "");
  const truncated = text.length > maxTextChars;
  if (truncated) warnings.push(`card_text_truncated:${card.id || normalizeCardKey(card.name)}`);
  const isBaige = card.source === "baige" || card.provider === "baige";
  const identityNames = cardIdentityNames(card);
  return {
    id: `card-text-${card.id || normalizeCardKey(card.name)}`,
    type: isBaige ? "baige_card_text" : "card_text",
    title: `${card.name} 的卡片文本`,
    cardIds: [card.id || card.cardId].filter(Boolean).map(String),
    cards: identityNames,
    identityKeys: identityNames.map(normalizeCardKey).filter(Boolean),
    input: card.input || "",
    matchedQuery: card.matchedQuery || "",
    name: card.name || "",
    cnName: card.cnName || "",
    jaName: card.jaName || card.jpName || "",
    enName: card.enName || "",
    aliases: card.aliases || [],
    text: truncated ? `${text.slice(0, Math.max(0, maxTextChars - 1))}…` : text,
    sourceUrl: card.sourceUrl || "",
    source: isBaige ? "baige" : card.source || "",
    resolutionSource: card.resolutionSource || "",
    cardType: card.cardType || card.type || "",
    attribute: card.attribute ?? "",
    race: card.race ?? "",
    atk: card.atk ?? null,
    def: card.def ?? null,
    level: card.level ?? card.rank ?? card.link ?? null,
    official: false,
    isDirect: false,
  };
}

function mergeCanonicalCardEvidenceProfile(resolvedCard = {}, canonicalCard = null) {
  if (!canonicalCard) return resolvedCard;
  return {
    ...resolvedCard,
    ...canonicalCard,
    input: resolvedCard.input || canonicalCard.input || "",
    matchedQuery: resolvedCard.matchedQuery || canonicalCard.matchedQuery || "",
    aliases: cardIdentityNames(resolvedCard, canonicalCard),
    confidence: resolvedCard.confidence ?? canonicalCard.confidence,
  };
}

function cardIdentityNames(...cards) {
  const seen = new Set();
  const result = [];
  for (const card of cards.filter(Boolean)) {
    for (const value of [
      card.input,
      card.matchedQuery,
      card.name,
      card.cnName,
      card.jaName,
      card.jpName,
      card.enName,
      ...(card.aliases || []),
    ]) {
      const text = String(value || "").trim();
      const key = normalizeCardKey(text);
      if (!text || !key || seen.has(key)) continue;
      seen.add(key);
      result.push(text);
    }
  }
  return result;
}

function userProvidedTextEvidence(item, index, maxTextChars, warnings) {
  const text = String(item.text || "");
  const key = normalizeCardKey(item.name) || `card-${index + 1}`;
  const truncated = text.length > maxTextChars;
  if (truncated) warnings.push(`user_provided_text_truncated:${key}`);
  return {
    id: `user-card-text-${key}`,
    type: "user_provided_text",
    title: `${item.name} 的用户提供文本`,
    cardIds: [],
    cards: [item.name].filter(Boolean),
    text: truncated ? `${text.slice(0, Math.max(0, maxTextChars - 1))}…` : text,
    sourceUrl: "",
    source: "user_provided_text",
    official: false,
    isDirect: false,
  };
}

function evidenceFromOfficialMatch(match, type, maxTextChars, warnings) {
  const record = match.record || {};
  const isDirectEvidence = type === "official_qa"
    && match.matchLevel === "official_qa_exact";
  const retrievalScore = normalizeEvidenceRelevanceScore(
    match.retrievalScore
      ?? record.retrievalScore
      ?? match.score
      ?? record.score,
  );
  return {
    ...evidenceFromRecord(record, type, maxTextChars, warnings),
    score: match.score,
    retrievalScore,
    matchLevel: !isDirectEvidence && match.matchLevel === "official_qa_exact"
      ? "official_qa_near"
      : match.matchLevel,
    questionType: match.questionType || "unknown",
    identityScopedMatch: true,
    matchedBy: match.matchedBy || [],
    matchedQuestionCardIds: match.matchedQuestionCardIds || [],
    matchedRelatedQuestionCardIds: match.matchedRelatedQuestionCardIds || [],
    matchedRelatedMetadataCardIds: match.matchedRelatedMetadataCardIds || [],
    matchedRelatedCardIds: match.matchedRelatedCardIds || [],
    branchRelevant: match.branchRelevant === true,
    branchMatchedCardIds: match.branchMatchedCardIds || [],
    supportingQuestionBranchIndex: match.supportingQuestionBranchIndex ?? null,
    supportingQuestionBranchCardIds: match.supportingQuestionBranchCardIds || [],
    supportingQuestionBranchUnmatchedCardIds: match.supportingQuestionBranchUnmatchedCardIds || [],
    supportingQuestionBranchIdentityComplete:
      match.supportingQuestionBranchIdentityComplete === true,
    supportingQuestionBranchTypeCompatible:
      match.supportingQuestionBranchTypeCompatible === true,
    supportingQuestionBranchPlayerRoleCompatibility:
      match.supportingQuestionBranchPlayerRoleCompatibility || "unknown",
    supportingQuestionBranchScenarioPremiseCompatibility:
      match.supportingQuestionBranchScenarioPremiseCompatibility || "unknown",
    questionCardIdCoverage: Number(match.questionCardIdCoverage || 0),
    relatedQuestionCardIdCoverage: Number(match.relatedQuestionCardIdCoverage || 0),
    relatedCardIdCoverage: Number(match.relatedCardIdCoverage || 0),
    questionCardIdCount: Number(match.questionCardIdCount || 0),
    relatedQuestionCardIdCount: Number(match.relatedQuestionCardIdCount || 0),
    authoritativeSceneMatch: isDirectEvidence && match.authoritativeSceneMatch === true,
    authoritativeSceneMatchReason: isDirectEvidence
      ? match.authoritativeSceneMatchReason || ""
      : "",
    candidatePoolComplete: match.candidatePoolComplete === true,
    subsumptionCandidatePoolComplete: match.subsumptionCandidatePoolComplete === true,
    semanticSubsumptionCertified: match.semanticSubsumptionCertified === true,
    semanticSubsumptionScoreMargin: Number(match.semanticSubsumptionScoreMargin || 0),
    semanticSubsumptionRunnerUpId: match.semanticSubsumptionRunnerUpId || "",
    semanticSubsumptionMetrics: match.semanticSubsumptionMetrics || null,
    questionCardSubsumptionCertified: match.questionCardSubsumptionCertified === true,
    questionCardSubsumptionMetrics: match.questionCardSubsumptionMetrics || null,
    semanticQueryCoverage: Number(match.semanticQueryCoverage || 0),
    distinctiveSemanticQueryCoverage: Number(match.distinctiveSemanticQueryCoverage || 0),
    semanticScore: Number(match.semanticScore || 0),
    distinctiveSemanticHits: match.distinctiveSemanticHits || [],
    effectNumberCompatible: match.effectNumberCompatible !== false,
    sceneQualifiersCompatible: match.sceneQualifiersCompatible !== false,
    playerRoleCompatibility: match.playerRoleCompatibility || "unknown",
    playerRoleMismatches: match.playerRoleMismatches || [],
    playerRoleComparableDimensions: match.playerRoleComparableDimensions || [],
    scenarioPremiseCompatibility: match.scenarioPremiseCompatibility || "unknown",
    scenarioPremiseConflicts: match.scenarioPremiseConflicts || [],
    queryScenarioPremises: match.queryScenarioPremises || [],
    evidenceScenarioPremises: match.evidenceScenarioPremises || [],
    queryOnlyScenarioPremises: match.queryOnlyScenarioPremises || [],
    evidenceOnlyScenarioPremises: match.evidenceOnlyScenarioPremises || [],
    queryApplicabilityFrame: match.queryApplicabilityFrame || null,
    evidenceApplicabilityFrame: match.evidenceApplicabilityFrame || null,
    requestedTargetCoverage: match.requestedTargetCoverage || null,
    scenarioFactCoverage: match.scenarioFactCoverage || null,
    isDirect: isDirectEvidence,
  };
}

function evidenceFromRecord(record, type, maxTextChars = 1600, warnings = []) {
  const text = String(record.text || record.answer || record.conclusion || "");
  const truncated = text.length > maxTextChars;
  const retrievalScore = normalizeEvidenceRelevanceScore(record.retrievalScore ?? record.score);
  const provenance = evidenceProvenance(record);
  if (truncated) warnings.push(`${type}_text_truncated:${record.id || record.evidenceId || record.stableId}`);
  return {
    id: String(record.id || record.evidenceId || record.stableId || ""),
    type,
    recordType: record.recordType || "",
    title: record.title || record.question || String(record.id || "资料"),
    cardIds: record.cardIds || [],
    questionCardIds: record.questionCardIds || [],
    cards: record.cards || record.cardNames || [],
    question: record.question || "",
    rawQuestion: record.rawQuestion || "",
    rawDetailedQuestion: record.rawDetailedQuestion || "",
    answer: record.answer || record.conclusion || "",
    retrievalContext: record.retrievalContext || {},
    fullText: text,
    text: truncated ? `${text.slice(0, Math.max(0, maxTextChars - 1))}…` : text,
    sourceUrl: record.sourceUrl || record.officialUrl || "",
    source: provenance.source,
    sourceName: provenance.sourceName,
    sourceTier: provenance.sourceTier,
    sourceAuthority: provenance.sourceAuthority,
    sourceType: record.sourceType || "",
    displayStatus: record.displayStatus || "",
    maxStatus: record.maxStatus || "",
    officialVerdict: record.officialVerdict ?? record.verdict ?? "unknown",
    officialText: record.officialText || "",
    explanation: record.explanation || "",
    scenario: record.scenario || record.question || "",
    score: retrievalScore,
    retrievalScore,
    retrievalSignals: record.retrievalSignals || null,
    official: provenance.official,
    isDirect: false,
  };
}

function evidenceSourceUrl(record = {}) {
  const cardId = (record.cardIds || [])
    .map(normalizeCardIdentityId)
    .find((id) => /^\d+$/u.test(id));
  if (record.recordType === "card-faq" && cardId) {
    return `https://www.db.yugioh-card.com/yugiohdb/faq_search.action?ope=4&cid=${encodeURIComponent(cardId)}&request_locale=ja`;
  }
  const existing = record.sourceUrl || record.officialUrl || "";
  if (existing) return existing;
  const qaId = String(record.sourceId || record.id || "").match(/(?:ygoresources-qa-)?(\d{3,})$/u)?.[1];
  if (record.recordType === "qa" && qaId) {
    return `https://www.db.yugioh-card.com/yugiohdb/faq_search.action?ope=5&fid=${encodeURIComponent(qaId)}&keyword=&tag=-1&request_locale=ja`;
  }
  return "";
}

function isOfficialQaRecord(record = {}) {
  return ["qa", "official-database"].includes(record.recordType)
    && evidenceProvenance(record).official;
}

function isOfficialQaOrFaqRecord(record = {}) {
  return ["qa", "official-database", "card-faq"].includes(record.recordType)
    && evidenceProvenance(record).official;
}

function hasOfficialQuestionSurface(record = {}) {
  if (!isOfficialQaOrFaqRecord(record)) return false;
  const sourceQuestion = String(
    record.rawDetailedQuestion || record.rawQuestion || "",
  ).trim();
  if (record.recordType === "card-faq") {
    const explicitQuestion = String(record.question || "").trim();
    return Boolean(sourceQuestion || /[?？]/u.test(explicitQuestion));
  }
  return Boolean(sourceQuestion || String(record.question || "").trim());
}

function isAuthoritativeQaOrFaqRecord(record = {}) {
  return evidenceProvenance(record).official;
}

function evidenceProvenance(record = {}) {
  const source = String(record.source || record.sourceName || record.sourceType || "").trim();
  const sourceName = String(record.sourceName || record.source || "").trim();
  const declaredTier = String(record.sourceTier || "").trim();
  const declaredAuthority = String(record.sourceAuthority || "").trim();
  const identity = [
    source,
    sourceName,
    record.sourceType,
    record.sourceId,
    record.id,
    declaredTier,
    declaredAuthority,
  ].filter(Boolean).join(" ");
  const community = declaredAuthority === "community_reference"
    || /^S2_/u.test(declaredTier)
    || /(?:^|[^a-z])ocg[-_ ]?rule(?:[^a-z]|$)|community|社区|社群/iu.test(identity)
    || ["rule-doc", "rule-test"].includes(String(record.recordType || ""));
  const explicitlyNonOfficial = record.official === false;
  const officialDatabase = !community
    && !explicitlyNonOfficial
    && (
      declaredAuthority === "official_database"
      || declaredTier === "S0_OFFICIAL_DB_MIRROR"
      || ["qa", "card-faq", "official-database"].includes(record.recordType)
    );
  const officialReference = !community
    && !explicitlyNonOfficial
    && !officialDatabase
    && (
      declaredAuthority === "official_reference"
      || /^S0_OFFICIAL/u.test(declaredTier)
      || record.official === true
    );
  const sourceAuthority = community
    ? "community_reference"
    : officialDatabase
      ? "official_database"
      : officialReference
        ? "official_reference"
        : declaredAuthority || "other_reference";
  const sourceTier = declaredTier || (
    sourceAuthority === "community_reference"
      ? "S2_COMMUNITY_REFERENCE"
      : sourceAuthority === "official_database"
        ? "S0_OFFICIAL_DB_MIRROR"
        : sourceAuthority === "official_reference"
          ? "S0_OFFICIAL_REFERENCE"
          : "S3_OTHER_REFERENCE"
  );
  return {
    source,
    sourceName,
    sourceTier,
    sourceAuthority,
    official: sourceAuthority === "official_database" || sourceAuthority === "official_reference",
  };
}

function officialQaNumericId(record = {}) {
  const direct = String(record.sourceRecordId || record.sourceId || "").match(/^\d+$/u)?.[0];
  if (direct) return direct;
  return String(record.stableId || record.id || "").match(/(?:ygoresources-qa-|official-qa-)(\d+)$/u)?.[1] || "";
}

function evidenceMechanismAnalogues(item = {}) {
  const record = item?.record || item;
  const signals = record?.retrievalSignals || {};
  return [...new Set([
    ...(Array.isArray(signals.mechanismAnalogues) ? signals.mechanismAnalogues : []),
    signals.mechanismAnalogue,
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function relatedMatchedQuestionCardIds(item = {}) {
  const values = [
    ...(Array.isArray(item?.matchedQuestionCardIds) ? item.matchedQuestionCardIds : []),
    ...(Array.isArray(item?.matchedRelatedQuestionCardIds)
      ? item.matchedRelatedQuestionCardIds
      : []),
    ...(Array.isArray(item?.matchedRelatedMetadataCardIds)
      ? item.matchedRelatedMetadataCardIds
      : []),
    ...(Array.isArray(item?.matchedRelatedCardIds) ? item.matchedRelatedCardIds : []),
    ...(Array.isArray(item?.retrievalSignals?.matchedQuestionCardIds)
      ? item.retrievalSignals.matchedQuestionCardIds
      : []),
  ];
  return [...new Set(values.map(normalizeCardIdentityId).filter(Boolean))];
}

function mergeOfficialRelatedSourceItems(items = []) {
  const merged = new Map();
  for (const item of items || []) {
    const record = item?.record || item;
    const key = stableRecordKey(record);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, item);
      continue;
    }
    const previousRecord = previous?.record || previous;
    const mergedRecord = mergeRelatedRecordMetadata(previousRecord, record);
    const match = previous?.record ? previous : item?.record ? item : null;
    merged.set(key, match ? { ...match, record: mergedRecord } : mergedRecord);
  }
  return [...merged.values()];
}

function mergeSupplementalRuleQueryRanks(...rankMaps) {
  const merged = new Map();
  for (const rankMap of rankMaps) {
    for (const [key, rawRank] of Object.entries(rankMap || {})) {
      const rank = Number(rawRank || 0);
      if (!key || rank <= 0) continue;
      merged.set(key, Math.min(rank, merged.get(key) || Number.POSITIVE_INFINITY));
    }
  }
  return Object.fromEntries([...merged.entries()].sort(([left], [right]) => (
    left.localeCompare(right)
  )));
}

function mergeRelatedRecordMetadata(left = {}, right = {}) {
  const leftSignals = left.retrievalSignals || {};
  const rightSignals = right.retrievalSignals || {};
  const independentQueryRanks = [
    Number(leftSignals.ruleQueryBestRank || 0),
    Number(rightSignals.ruleQueryBestRank || 0),
  ].filter((value) => value > 0);
  const supplementalQueryRanks = [
    Number(leftSignals.supplementalRuleQueryBestRank || 0),
    Number(rightSignals.supplementalRuleQueryBestRank || 0),
  ].filter((value) => value > 0);
  const mechanismMetrics = mergeMechanismAnalogueMetrics(
    collectMechanismAnalogueMetrics(left),
    collectMechanismAnalogueMetrics(right),
  );
  const primaryMechanism = selectPrimaryMechanismAnalogue(mechanismMetrics);
  const primaryMetrics = mechanismMetrics[primaryMechanism] || {};
  const mechanisms = Object.keys(mechanismMetrics);
  return {
    ...left,
    ...right,
    retrievalScore: Math.max(
      Number(left.retrievalScore || 0),
      Number(right.retrievalScore || 0),
    ),
    retrievalSignals: {
      ...leftSignals,
      ...rightSignals,
      ruleQueryBestRank: independentQueryRanks.length
        ? Math.min(...independentQueryRanks)
        : undefined,
      ruleQueryKeys: [...new Set([
        ...(leftSignals.ruleQueryKeys || []),
        ...(rightSignals.ruleQueryKeys || []),
      ])],
      strictRuleQueryKeys: [...new Set([
        ...(leftSignals.strictRuleQueryKeys || []),
        ...(rightSignals.strictRuleQueryKeys || []),
      ])],
      ruleQueryRanks: mergeSupplementalRuleQueryRanks(
        leftSignals.ruleQueryRanks,
        rightSignals.ruleQueryRanks,
      ),
      ruleQueryMechanisms: [...new Set([
        ...(leftSignals.ruleQueryMechanisms || []),
        ...(rightSignals.ruleQueryMechanisms || []),
      ])],
      supplementalRuleQueryBestRank: supplementalQueryRanks.length
        ? Math.min(...supplementalQueryRanks)
        : undefined,
      supplementalRuleQueryKeys: [...new Set([
        ...(leftSignals.supplementalRuleQueryKeys || []),
        ...(rightSignals.supplementalRuleQueryKeys || []),
      ])],
      strictSupplementalRuleQueryKeys: [...new Set([
        ...(leftSignals.strictSupplementalRuleQueryKeys || []),
        ...(rightSignals.strictSupplementalRuleQueryKeys || []),
      ])],
      groundedQuestionBranchRuleQueryKeys: [...new Set([
        ...(leftSignals.groundedQuestionBranchRuleQueryKeys || []),
        ...(rightSignals.groundedQuestionBranchRuleQueryKeys || []),
      ])],
      supplementalRuleQueryRanks: mergeSupplementalRuleQueryRanks(
        leftSignals.supplementalRuleQueryRanks,
        rightSignals.supplementalRuleQueryRanks,
      ),
      questionBranchSearch: Boolean(
        leftSignals.questionBranchSearch || rightSignals.questionBranchSearch,
      ),
      questionBranchMultilingualMechanismFallback: Boolean(
        leftSignals.questionBranchMultilingualMechanismFallback
          || rightSignals.questionBranchMultilingualMechanismFallback,
      ),
      questionBranchFourGramHitCount: Math.max(
        Number(leftSignals.questionBranchFourGramHitCount || 0),
        Number(rightSignals.questionBranchFourGramHitCount || 0),
      ),
      questionBranchThreeGramHitCount: Math.max(
        Number(leftSignals.questionBranchThreeGramHitCount || 0),
        Number(rightSignals.questionBranchThreeGramHitCount || 0),
      ),
      questionBranchHeadlineAnchored: Boolean(
        leftSignals.questionBranchHeadlineAnchored
        || rightSignals.questionBranchHeadlineAnchored,
      ),
      questionBranchHeadlineThreeGramHitCount: Math.max(
        Number(leftSignals.questionBranchHeadlineThreeGramHitCount || 0),
        Number(rightSignals.questionBranchHeadlineThreeGramHitCount || 0),
      ),
      questionBranchHeadlineFourGramHitCount: Math.max(
        Number(leftSignals.questionBranchHeadlineFourGramHitCount || 0),
        Number(rightSignals.questionBranchHeadlineFourGramHitCount || 0),
      ),
      questionBranchHeadlineCanonicalFourGramHitCount: Math.max(
        Number(leftSignals.questionBranchHeadlineCanonicalFourGramHitCount || 0),
        Number(rightSignals.questionBranchHeadlineCanonicalFourGramHitCount || 0),
      ),
      questionBranchHeadlineLongestRun: Math.max(
        Number(leftSignals.questionBranchHeadlineLongestRun || 0),
        Number(rightSignals.questionBranchHeadlineLongestRun || 0),
      ),
      questionBranchHeadlineDistinctiveSemanticHitCount: Math.max(
        Number(leftSignals.questionBranchHeadlineDistinctiveSemanticHitCount || 0),
        Number(rightSignals.questionBranchHeadlineDistinctiveSemanticHitCount || 0),
      ),
      questionBranchHeadlineEffectPhraseHitCount: Math.max(
        Number(leftSignals.questionBranchHeadlineEffectPhraseHitCount || 0),
        Number(rightSignals.questionBranchHeadlineEffectPhraseHitCount || 0),
      ),
      questionBranchFourGramCoverage: Math.max(
        Number(leftSignals.questionBranchFourGramCoverage || 0),
        Number(rightSignals.questionBranchFourGramCoverage || 0),
      ),
      questionBranchLongestRun: Math.max(
        Number(leftSignals.questionBranchLongestRun || 0),
        Number(rightSignals.questionBranchLongestRun || 0),
      ),
      matchedStrongMechanismFeatures: [...new Set([
        ...(leftSignals.matchedStrongMechanismFeatures || []),
        ...(rightSignals.matchedStrongMechanismFeatures || []),
      ])],
      strongMechanismQueryCoverage: Math.max(
        Number(leftSignals.strongMechanismQueryCoverage || 0),
        Number(rightSignals.strongMechanismQueryCoverage || 0),
      ),
      supplementalRuleQueryMechanisms: [...new Set([
        ...(leftSignals.supplementalRuleQueryMechanisms || []),
        ...(rightSignals.supplementalRuleQueryMechanisms || []),
      ])],
      mechanismAnalogue: primaryMechanism,
      mechanismAnalogues: mechanisms,
      mechanismAnalogueScore: Number(primaryMetrics.score || 0),
      mechanismAnalogueScores: Object.fromEntries(
        mechanisms.map((mechanism) => [mechanism, Number(mechanismMetrics[mechanism].score || 0)]),
      ),
      mechanismAnalogueMetrics: mechanismMetrics,
      mechanismQueryCoverage: Number(primaryMetrics.queryCoverage || 0),
      mechanismQuestionCoverage: Number(primaryMetrics.questionCoverage || 0),
      mechanismSignatureFeatures: primaryMetrics.features || [],
      mechanismSignatureProfile: primaryMetrics.profile || "",
      mechanismFullScore: Number(primaryMetrics.fullScore || 0),
      mechanismFullQueryCoverage: Number(primaryMetrics.fullQueryCoverage || 0),
      mechanismFullQuestionCoverage: Number(primaryMetrics.fullQuestionCoverage || 0),
      mechanismCoreScore: Number(primaryMetrics.coreScore || 0),
      mechanismCoreQueryCoverage: Number(primaryMetrics.coreQueryCoverage || 0),
      mechanismCoreQuestionCoverage: Number(primaryMetrics.coreQuestionCoverage || 0),
    },
  };
}

function collectMechanismAnalogueMetrics(item = {}) {
  const signals = (item?.record || item)?.retrievalSignals || {};
  const existing = signals.mechanismAnalogueMetrics || {};
  const scores = signals.mechanismAnalogueScores || {};
  const primary = String(signals.mechanismAnalogue || "");
  const result = {};
  for (const mechanism of evidenceMechanismAnalogues(item)) {
    const metric = existing[mechanism] || {};
    result[mechanism] = {
      score: Number(metric.score ?? scores[mechanism]
        ?? (mechanism === primary ? signals.mechanismAnalogueScore : 0) ?? 0),
      queryCoverage: Number(metric.queryCoverage
        ?? (mechanism === primary ? signals.mechanismQueryCoverage : 0) ?? 0),
      questionCoverage: Number(metric.questionCoverage
        ?? (mechanism === primary ? signals.mechanismQuestionCoverage : 0) ?? 0),
      features: [...new Set(metric.features
        || (mechanism === primary ? signals.mechanismSignatureFeatures : [])
        || [])],
      profile: String(metric.profile
        ?? (mechanism === primary ? signals.mechanismSignatureProfile : "")
        ?? ""),
      fullScore: Number(metric.fullScore
        ?? (mechanism === primary ? signals.mechanismFullScore : 0) ?? 0),
      fullQueryCoverage: Number(metric.fullQueryCoverage
        ?? (mechanism === primary ? signals.mechanismFullQueryCoverage : 0) ?? 0),
      fullQuestionCoverage: Number(metric.fullQuestionCoverage
        ?? (mechanism === primary ? signals.mechanismFullQuestionCoverage : 0) ?? 0),
      coreScore: Number(metric.coreScore
        ?? (mechanism === primary ? signals.mechanismCoreScore : 0) ?? 0),
      coreQueryCoverage: Number(metric.coreQueryCoverage
        ?? (mechanism === primary ? signals.mechanismCoreQueryCoverage : 0) ?? 0),
      coreQuestionCoverage: Number(metric.coreQuestionCoverage
        ?? (mechanism === primary ? signals.mechanismCoreQuestionCoverage : 0) ?? 0),
    };
  }
  return result;
}

function mergeMechanismAnalogueMetrics(...sources) {
  const result = {};
  for (const source of sources) {
    for (const [mechanism, metric] of Object.entries(source || {})) {
      const previous = result[mechanism];
      if (!previous || compareMechanismMetricProfiles(metric, previous) < 0) {
        result[mechanism] = { ...metric, features: [...new Set(metric.features || [])] };
        continue;
      }
      if (compareMechanismMetricProfiles(metric, previous) > 0) continue;
      result[mechanism] = {
        ...previous,
        queryCoverage: Math.max(
          Number(previous.queryCoverage || 0),
          Number(metric.queryCoverage || 0),
        ),
        questionCoverage: Math.max(
          Number(previous.questionCoverage || 0),
          Number(metric.questionCoverage || 0),
        ),
        features: [...new Set([...(previous.features || []), ...(metric.features || [])])],
      };
    }
  }
  return result;
}

function compareMechanismMetricProfiles(left = {}, right = {}) {
  return Number(right.fullQueryCoverage || 0) - Number(left.fullQueryCoverage || 0)
    || Number(right.fullScore || 0) - Number(left.fullScore || 0)
    || Number(right.fullQuestionCoverage || 0) - Number(left.fullQuestionCoverage || 0)
    || Number(right.coreScore || 0) - Number(left.coreScore || 0)
    || Number(right.coreQueryCoverage || 0) - Number(left.coreQueryCoverage || 0)
    || Number(right.coreQuestionCoverage || 0) - Number(left.coreQuestionCoverage || 0)
    || Number(right.score || 0) - Number(left.score || 0)
    || Number(right.queryCoverage || 0) - Number(left.queryCoverage || 0)
    || Number(right.questionCoverage || 0) - Number(left.questionCoverage || 0);
}

function selectPrimaryMechanismAnalogue(metrics = {}) {
  return Object.entries(metrics)
    .sort((left, right) => (
      Number(right[1]?.score || 0) - Number(left[1]?.score || 0)
      || left[0].localeCompare(right[0])
    ))[0]?.[0] || "";
}

function isProvisionalOfficialResponseRecord(record = {}) {
  return record.sourceType === "official_response_screenshot"
    || record.recordType === "official-response-screenshot";
}

function evidenceTypeForRecord(record = {}, fallback = "related") {
  const id = String(record.id || record.evidenceId || record.stableId || "");
  if (record.recordType === "rule-doc" || record.recordType === "rule-test" || record.sourceId === "ocg-rule" || id.startsWith("ocg-rule:")) {
    return "rulebook";
  }
  return fallback;
}

function rankRecords({ userQuery, records, resolvedCards, mentionQueries = [], ruleSearchQueries = [], allowNoCardMatch = false }) {
  const queryTerms = tokenize([userQuery, ...mentionQueries].join(" "));
  // Callers already bound the aggregate planner input to sixteen queries. Do
  // not silently cut its tail in half here: the tail is where independently
  // generated model subclaims are appended on aggregate-only retrieval paths.
  const ruleQueries = normalizeRuleSearchQueries(ruleSearchQueries, { maxRuleSearchQueries: 16 });
  const ruleTerms = tokenize(ruleQueries.map((item) => item.query).join(" "));
  const rulePhrases = ruleQueries.map((item) => normalizeCardKey(item.query)).filter(Boolean);
  const queryKey = normalizeCardKey(userQuery);
  const resolvedIds = new Set((resolvedCards || []).map((card) => normalizeCardIdentityId(card.id || card.cardId)).filter(Boolean));
  const resolvedNames = new Set((resolvedCards || []).flatMap((card) => [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]).map(normalizeCardKey).filter(Boolean));
  const unresolvedNames = new Set((mentionQueries || []).map(normalizeCardKey).filter(Boolean));
  const queryEffectNumbers = extractEffectNumbers(userQuery);
  const queryQuestionType = classifyOfficialQaQuestionType(userQuery);
  const queryEffectPhrases = extractOfficialQaEffectPhrases(userQuery);
  const querySemanticConcepts = extractOfficialQaSemanticConcepts(userQuery);
  const queryMechanismSignatures = [userQuery, ...ruleQueries.map((item) => item.query)]
    .map(buildRuleMechanismSignature)
    .filter(isUsableRuleMechanismSignature);
  const contextTerms = buildContextTerms({ userQuery, mentionQueries, ruleQueries, resolvedCards });
  const ranked = (records || [])
    .filter((record) => record.status !== "removed" && record.status !== "superseded")
    .map((record) => {
      const scored = scoreRecord(record, {
        queryTerms,
        ruleTerms,
        rulePhrases,
        queryKey,
        resolvedIds,
        resolvedNames,
        unresolvedNames,
        allowNoCardMatch,
        queryEffectNumbers,
        queryQuestionType,
        queryEffectPhrases,
        querySemanticConcepts,
        queryMechanismSignatures,
      });
      return { record, ...scored };
    })
    .filter((item) => item.rawScore > 0)
    .sort(compareRankedRecords)
    .map((item) => {
      const contextual = attachContextSnippet(item.record, contextTerms);
      return {
        ...contextual,
        retrievalScore: item.relevanceScore,
        retrievalSignals: {
          ...(contextual.retrievalSignals || {}),
          ...item.signals,
        },
      };
    });
  return dedupeBy(ranked, stableRecordKey);
}

function rankRecordsWithSupplementalQueries({
  userQuery,
  records,
  resolvedCards,
  mentionQueries = [],
  deterministicRuleQueries = [],
  supplementalRuleQueries = [],
  independentQueryLimit = 0,
  allowNoCardMatch = false,
}) {
  // Deterministic queries provide one broad fallback rank. Model-supplied
  // subclaims are ranked independently below, so they do not receive the same
  // signal twice or force broad card-text clauses into reserved branch slots.
  const aggregateRuleQueries = normalizeRuleSearchQueries(
    [
      ...(deterministicRuleQueries || []),
      ...(independentQueryLimit > 0 ? [] : (supplementalRuleQueries || [])),
    ],
    { maxRuleSearchQueries: 16 },
  );
  const deterministic = rankRecords({
    userQuery,
    records,
    resolvedCards,
    mentionQueries,
    ruleSearchQueries: aggregateRuleQueries,
    allowNoCardMatch,
  });
  const supplementalKeys = new Set(
    (supplementalRuleQueries || []).map(ruleSearchQueryIdentity).filter(Boolean),
  );
  const independentQueries = selectIndependentRuleQueries({
    deterministicRuleQueries,
    supplementalRuleQueries,
    limit: independentQueryLimit,
  });
  if (!independentQueries.length) return deterministic;
  // Independently rank only a small mechanism-diverse query set. This preserves
  // branch coverage without multiplying a large official corpus by the full
  // 16-query planner limit. Other callers retain the one-pass aggregate rank.
  const independent = independentQueries.flatMap((query) => {
    const queryIdentity = ruleSearchQueryIdentity(query);
    const queryMechanism = inferRuleSearchMechanism(query);
    const isSupplemental = supplementalKeys.has(queryIdentity);
    const supplementalUserQuery = [query?.subclaim, query?.reason]
      .filter(Boolean)
      .join(" ");
    const independentlyRanked = rankRecords({
      userQuery: supplementalUserQuery || userQuery,
      records,
      resolvedCards,
      mentionQueries,
      ruleSearchQueries: [query],
      allowNoCardMatch,
    }).map((record, index) => ({ record, index }));
    // Keep a small lexical head, but independently scan the already-ranked
    // in-memory result for the first four records that pass the strict official-
    // mechanism gate. A useful analogue can be the second strict candidate,
    // while a four-record union remains small and deterministic.
    const strictHeadCandidates = [];
    for (const candidate of independentlyRanked) {
      if (!isStrictSupplementalOfficialMechanismMatch(candidate.record, query)) continue;
      strictHeadCandidates.push(candidate);
      if (strictHeadCandidates.length >= 4) break;
    }
    const boundedCandidates = dedupeBy([
      ...strictHeadCandidates,
      ...independentlyRanked.slice(0, 4),
    ], ({ record }) => stableRecordKey(record)).slice(0, 4);
    return boundedCandidates.map(({ record, index }) => {
      // Evaluate the strict gate while this record still carries the signals
      // from exactly one supplemental query. After records from several query
      // heads are merged, aggregate scores can no longer prove which query a
      // candidate actually matched.
      const strictQueryMatch = queryIdentity
        && isStrictSupplementalOfficialMechanismMatch(record, query);
      return {
        ...record,
        retrievalSignals: {
          ...(record.retrievalSignals || {}),
          ruleQueryBestRank: index + 1,
          ruleQueryKeys: queryIdentity ? [queryIdentity] : [],
          strictRuleQueryKeys: strictQueryMatch ? [queryIdentity] : [],
          ruleQueryRanks: queryIdentity ? { [queryIdentity]: index + 1 } : {},
          ruleQueryMechanisms: queryMechanism ? [queryMechanism] : [],
          // Preserve the existing supplemental-only diagnostics for callers
          // that distinguish model expansions from deterministic query heads.
          ...(isSupplemental ? {
          supplementalRuleQueryBestRank: index + 1,
          supplementalRuleQueryKeys: queryIdentity ? [queryIdentity] : [],
          strictSupplementalRuleQueryKeys: strictQueryMatch ? [queryIdentity] : [],
          supplementalRuleQueryRanks: queryIdentity ? { [queryIdentity]: index + 1 } : {},
          supplementalRuleQueryMechanisms: queryMechanism ? [queryMechanism] : [],
          } : {}),
        },
      };
    });
  });
  const merged = new Map();
  for (const record of [...deterministic, ...independent]) {
    const key = stableRecordKey(record);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, record);
      continue;
    }
    const [lower, higher] = compareRetrievedRecords(previous, record) <= 0
      ? [record, previous]
      : [previous, record];
    merged.set(key, mergeRelatedRecordMetadata(lower, higher));
  }
  return [...merged.values()].sort(compareRetrievedRecords);
}

function rankOfficialQaQuestionBranches({
  records = [],
  ruleSearchQueries = [],
  supplementalRuleQueryKeys = [],
  candidateLimit = 16,
} = {}) {
  if (!(records || []).length) return [];
  const queries = normalizeRuleSearchQueries(ruleSearchQueries, {
    maxRuleSearchQueries: 4,
  }).slice(0, 4);
  if (!queries.length) return [];

  const queryPlans = queries.map((query) => ({
    query,
    question: selectOfficialQaSearchBranch(query.query),
    queryKey: ruleSearchQueryIdentity(query),
  })).filter(({ question, queryKey }) => question && queryKey);
  if (!queryPlans.length) return [];
  const supplementalKeys = new Set((supplementalRuleQueryKeys || []).filter(Boolean));
  const safeCandidateLimit = Math.max(1, Math.floor(Number(candidateLimit) || 16));
  const perQueryLimit = Math.max(2, Math.min(6, Math.ceil(safeCandidateLimit / queryPlans.length)));
  const questionProfiles = prepareOfficialQaQuestionTextProfiles(records);
  const merged = new Map();
  for (const { query, question, queryKey } of queryPlans) {
    const searchResult = searchOfficialQaEvidence({
      question,
      records,
      resolvedCards: [],
      limit: perQueryLimit,
      subsumptionCandidatePoolComplete: false,
    });
    // The ordinary matcher deliberately demotes many cross-card questions by
    // identity, role and scenario classifiers. Those signals are useful for
    // direct-answer certification, but they must not hide a source whose
    // official question text closely matches the complete Japanese question
    // written by the Relay planner. Add a bounded question-only phrase head;
    // it never reads the answer and every result remains related-only.
    const phraseMatches = rankOfficialQaQuestionTextProfiles({
      question,
      // The complete CJK question branch supplies lexical anchors for the
      // synchronized corpus, while the complete planner item supplies
      // language-independent mechanism signals. Both are question-side inputs;
      // official answers never participate in discovery.
      contextText: [query.subclaim, query.query]
        .filter(Boolean)
        .join(" "),
      profiles: questionProfiles,
      limit: Math.min(4, perQueryLimit),
    });
    // Full-question retrieval is the higher-precision path, but even a weak
    // same-language phrase hit must not suppress the bounded cross-language
    // mechanism head for this same Planner branch. Both paths inspect only the
    // official question surface, remain related-only and share the existing
    // fixed candidate budget below.
    const phraseMatchKeys = new Set(
      phraseMatches.slice(0, 2).map((match) => stableRecordKey(match.record)),
    );
    const multilingualMechanismMatches = rankOfficialQaMultilingualMechanismProfiles({
      contextText: [query.subclaim, query.query]
        .filter(Boolean)
        .join(" "),
      // Apply the multilingual bound after removing records already supplied
      // by the phrase head. Otherwise two same-language mechanism matches can
      // consume both companion slots before a cross-language record is seen.
      profiles: questionProfiles.filter(
        (profile) => !phraseMatchKeys.has(stableRecordKey(profile.record)),
      ),
      limit: Math.min(2, perQueryLimit),
    });
    const questionOnlyMatches = dedupeBy([
      ...phraseMatches.slice(0, 2),
      ...multilingualMechanismMatches,
    ], (match) => stableRecordKey(match.record));
    const strongQuestionMatches = [
      ...searchResult.exact,
      ...searchResult.near,
      ...questionOnlyMatches,
    ];
    // If the ordinary matcher and the CJK full-question rescue both find
    // nothing stronger, retain a tiny related-only head from this explicit
    // planner query. This keeps broad but potentially useful context visible
    // without adding unrelated tails beside an already decisive candidate.
    const relatedFallback = strongQuestionMatches.length
      ? []
      : (searchResult.related || [])
          .filter((match) => Number(match.semanticScore || 0) > 0)
          .slice(0, 2);
    const matches = dedupeBy([
      // Reserve at most two slots inside the existing per-query bound for the
      // question-only rescue. Otherwise ordinary classifier heads can consume
      // every slot before these candidates reach the shared comparator.
      ...questionOnlyMatches,
      ...searchResult.exact,
      ...searchResult.near,
      ...relatedFallback,
    ], (match) => stableRecordKey(match.record)).slice(0, perQueryLimit * 2);
    const questionOnlyMatchByRecord = new Map(
      questionOnlyMatches.map((match) => [stableRecordKey(match.record), match]),
    );
    matches.forEach((match, index) => {
      const record = match.record || {};
      // A record may also appear in the ordinary near/exact head. Keep that
      // stronger candidate, but do not discard independently measured
      // question/headline metrics merely because deduplication saw it first.
      const questionOnlyMatch = questionOnlyMatchByRecord.get(stableRecordKey(record));
      const phraseMetrics = questionOnlyMatch?.questionTextMetrics
        || match.questionTextMetrics
        || {};
      const questionBranchScore = Math.max(
        Number(match.score || 0),
        Number(questionOnlyMatch?.score || 0),
      );
      const groundedQueryKeys = phraseMetrics.headlineAnchored === true
        ? [queryKey]
        : [];
      const isSupplemental = supplementalKeys.has(queryKey);
      const candidate = {
        ...record,
        retrievalScore: Math.max(
          normalizeEvidenceRelevanceScore(record.retrievalScore ?? record.score),
          normalizeEvidenceRelevanceScore(questionBranchScore),
        ),
        retrievalContext: {
          ...(record.retrievalContext || {}),
          scope: "model_rule_query_question_search",
          relatedOnly: true,
        },
        retrievalSignals: {
          ...(record.retrievalSignals || {}),
          ruleQueryBestRank: index + 1,
          ruleQueryKeys: [queryKey],
          strictRuleQueryKeys: groundedQueryKeys,
          ruleQueryRanks: { [queryKey]: index + 1 },
          ...(isSupplemental ? {
            supplementalRuleQueryBestRank: index + 1,
            supplementalRuleQueryKeys: [queryKey],
            strictSupplementalRuleQueryKeys: groundedQueryKeys,
            supplementalRuleQueryRanks: { [queryKey]: index + 1 },
          } : {}),
          questionBranchSearch: true,
          questionBranchMultilingualMechanismFallback: Boolean(
            questionOnlyMatch?.multilingualMechanismFallback,
          ),
          questionBranchSearchScore: questionBranchScore,
          questionBranchFourGramHitCount: Number(phraseMetrics.fourGramHitCount || 0),
          questionBranchThreeGramHitCount: Number(phraseMetrics.threeGramHitCount || 0),
          questionBranchFourGramCoverage: Number(phraseMetrics.fourGramCoverage || 0),
          questionBranchLongestRun: Number(phraseMetrics.longestRun || 0),
          questionBranchHeadlineAnchored: phraseMetrics.headlineAnchored === true,
          questionBranchHeadlineThreeGramHitCount: Number(
            phraseMetrics.headlineThreeGramHitCount || 0,
          ),
          questionBranchHeadlineFourGramHitCount: Number(
            phraseMetrics.headlineFourGramHitCount || 0,
          ),
          questionBranchHeadlineCanonicalFourGramHitCount: Number(
            phraseMetrics.headlineCanonicalFourGramHitCount || 0,
          ),
          questionBranchHeadlineLongestRun: Number(phraseMetrics.headlineLongestRun || 0),
          questionBranchHeadlineDistinctiveSemanticHitCount: Number(
            phraseMetrics.headlineDistinctiveSemanticHitCount || 0,
          ),
          questionBranchHeadlineEffectPhraseHitCount: Number(
            phraseMetrics.headlineEffectPhraseHitCount || 0,
          ),
          groundedQuestionBranchRuleQueryKeys: groundedQueryKeys,
          matchedStrongMechanismFeatures: [
            ...(record.retrievalSignals?.matchedStrongMechanismFeatures || []),
            ...(phraseMetrics.matchedStrongMechanismFeatures || []),
          ],
          strongMechanismQueryCoverage: Math.max(
            Number(record.retrievalSignals?.strongMechanismQueryCoverage || 0),
            Number(phraseMetrics.strongMechanismQueryCoverage || 0),
          ),
        },
      };
      const key = stableRecordKey(candidate);
      const previous = merged.get(key);
      if (!previous) {
        merged.set(key, candidate);
        return;
      }
      const [lower, higher] = compareRetrievedRecords(previous, candidate) <= 0
        ? [candidate, previous]
        : [previous, candidate];
      merged.set(key, mergeRelatedRecordMetadata(lower, higher));
    });
  }
  return [...merged.values()].sort(compareRetrievedRecords).slice(0, safeCandidateLimit);
}

function rankOfficialQaMultilingualMechanismProfiles({
  contextText = "",
  profiles = [],
  limit = 2,
} = {}) {
  const queryMechanismSignature = buildRuleMechanismSignature(contextText);
  if (!isUsableRuleMechanismSignature(queryMechanismSignature)) return [];
  const strongQueryFeatures = [...queryMechanismSignature].filter(isStrongRuleMechanismFeature);
  if (!strongQueryFeatures.length) return [];

  return (profiles || []).map((profile) => {
    const mechanismMatch = bestRuleMechanismMatch(
      [queryMechanismSignature],
      profile.evidenceMechanismSignature,
    );
    const qualifies = mechanismMatch.matchedStrongFeatures.length >= 1
      && Number(mechanismMatch.strongQueryCoverage || 0) >= 0.5
      && (
        mechanismMatch.matchedStrongFeatures.length >= 2
        || mechanismMatch.matchedContextFeatures.length >= 1
      );
    return qualifies ? { profile, mechanismMatch } : null;
  }).filter(Boolean)
    .sort((left, right) => (
      Number(right.mechanismMatch.strongQueryCoverage || 0)
        - Number(left.mechanismMatch.strongQueryCoverage || 0)
      || right.mechanismMatch.matchedStrongFeatures.length
        - left.mechanismMatch.matchedStrongFeatures.length
      || right.mechanismMatch.matchedContextFeatures.length
        - left.mechanismMatch.matchedContextFeatures.length
      || stableRecordKey(left.profile.record).localeCompare(stableRecordKey(right.profile.record))
    ))
    .slice(0, Math.max(1, Math.min(2, Math.floor(Number(limit) || 2))))
    .map(({ profile, mechanismMatch }) => ({
      record: profile.record,
      score: normalizeEvidenceRelevanceScore(
        0.35
          + Number(mechanismMatch.strongQueryCoverage || 0) * 0.35
          + Math.min(2, mechanismMatch.matchedStrongFeatures.length) * 0.1
          + Math.min(2, mechanismMatch.matchedContextFeatures.length) * 0.05,
      ),
      multilingualMechanismFallback: true,
      questionTextMetrics: {
        matchedStrongMechanismFeatures: mechanismMatch.matchedStrongFeatures,
        strongMechanismQueryCoverage: Number(
          Number(mechanismMatch.strongQueryCoverage || 0).toFixed(4),
        ),
      },
    }));
}

function prepareOfficialQaQuestionTextProfiles(records = []) {
  return (records || []).map((record) => {
    const questionProjection = projectOfficialQaQuestion(record);
    const question = questionProjection.scenarioText || record.title || "";
    // `title` is the concise official question when the synchronized source
    // exposes one.  Older compact records may contain only a truncated title;
    // that is still safe as a positive ranking signal because eligibility is
    // established by the complete question projection below.  It is never a
    // deletion gate and no answer text participates.
    const headline = extractPrincipalQuestionHeadline(questionProjection.scenarioText)
      || String(
        record.question
          || record.rawQuestion
          || record.title
          || questionProjection.principalText
          || "",
      ).trim();
    const cjkSegments = normalizeCjkQuestionSegments(question);
    return cjkSegments.some((segment) => segment.length >= 4)
      ? {
          record,
          cjkSegments,
          headlineCjkSegments: normalizeCjkQuestionSegments(headline),
          headlineCanonicalCjkSegments: normalizeCanonicalCjkQuestionSegments(headline),
          headlineEffectPhrases: extractOfficialQaEffectPhrases(headline),
          headlineSemanticConcepts: extractOfficialQaSemanticConcepts(headline),
          evidenceMechanismSignature: retrievalQuestionFeatures(record).evidenceMechanismSignature,
        }
      : null;
  }).filter(Boolean);
}

function rankOfficialQaQuestionTextProfiles({
  question = "",
  contextText = question,
  profiles = [],
  limit = 6,
} = {}) {
  const querySegments = normalizeCjkQuestionSegments(question);
  const queryGrams = uniqueCjkNgrams(querySegments, 4);
  const queryThreeGrams = uniqueCjkNgrams(querySegments, 3);
  const queryCanonicalFourGrams = uniqueCjkNgrams(
    normalizeCanonicalCjkQuestionSegments(question),
    4,
  );
  const queryMechanismSignature = buildRuleMechanismSignature(contextText);
  const queryEffectPhrases = extractOfficialQaEffectPhrases(contextText);
  const queryDistinctiveSemanticConcepts = extractOfficialQaSemanticConcepts(contextText)
    .filter((concept) => !RULE_MECHANISM_GENERIC_CONCEPTS.has(concept));
  const hasStrongMechanismAnchor = [...queryMechanismSignature]
    .some(isStrongRuleMechanismFeature);
  // The synchronized corpus is mainly Japanese, but deterministic card-text
  // branches can be Chinese. Requiring kana here silently discarded those
  // branches before the existing absolute CJK n-gram and mechanism thresholds
  // could judge them. Keep the same strict thresholds, but make eligibility
  // depend on a real CJK question surface instead of one particular language.
  const cjkQuestionLength = querySegments.reduce((sum, segment) => sum + segment.length, 0);
  if (cjkQuestionLength < 4) return [];
  if (queryGrams.length < 8 && (!hasStrongMechanismAnchor || queryThreeGrams.length < 4)) {
    return [];
  }

  const minimumHits = Math.max(3, Math.ceil(queryGrams.length * 0.12));
  const preliminary = [];
  for (const profile of profiles || []) {
    let fourGramHitCount = 0;
    for (const gram of queryGrams) {
      if (profile.cjkSegments.some((segment) => segment.includes(gram))) {
        fourGramHitCount += 1;
      }
    }
    let threeGramHitCount = 0;
    for (const gram of queryThreeGrams) {
      if (profile.cjkSegments.some((segment) => segment.includes(gram))) {
        threeGramHitCount += 1;
      }
    }
    const mechanismMatch = bestRuleMechanismMatch(
      [queryMechanismSignature],
      profile.evidenceMechanismSignature,
    );
    let headlineThreeGramHitCount = 0;
    for (const gram of queryThreeGrams) {
      if (profile.headlineCjkSegments.some((segment) => segment.includes(gram))) {
        headlineThreeGramHitCount += 1;
      }
    }
    let headlineFourGramHitCount = 0;
    for (const gram of queryGrams) {
      if (profile.headlineCjkSegments.some((segment) => segment.includes(gram))) {
        headlineFourGramHitCount += 1;
      }
    }
    let headlineCanonicalFourGramHitCount = 0;
    for (const gram of queryCanonicalFourGrams) {
      if (profile.headlineCanonicalCjkSegments.some((segment) => segment.includes(gram))) {
        headlineCanonicalFourGramHitCount += 1;
      }
    }
    const headlineEffectPhraseHitCount = queryEffectPhrases
      .filter((phrase) => profile.headlineEffectPhrases.includes(phrase)).length;
    const headlineDistinctiveSemanticHitCount = queryDistinctiveSemanticConcepts
      .filter((concept) => profile.headlineSemanticConcepts.includes(concept)).length;
    const mechanismAnchoredShortMatch = mechanismMatch.matchedStrongFeatures.length >= 1
      && Number(mechanismMatch.strongQueryCoverage || 0) >= 0.5
      && threeGramHitCount >= 2;
    if (fourGramHitCount < minimumHits && !mechanismAnchoredShortMatch) continue;
    preliminary.push({
      ...profile,
      fourGramHitCount,
      fourGramCoverage: fourGramHitCount / Math.max(1, queryGrams.length),
      threeGramHitCount,
      threeGramCoverage: queryThreeGrams.length
        ? threeGramHitCount / queryThreeGrams.length
        : 0,
      mechanismAnchoredShortMatch,
      matchedStrongMechanismFeatures: mechanismMatch.matchedStrongFeatures,
      strongMechanismQueryCoverage: Number(mechanismMatch.strongQueryCoverage || 0),
      headlineThreeGramHitCount,
      headlineFourGramHitCount,
      headlineCanonicalFourGramHitCount,
      headlineEffectPhraseHitCount,
      headlineDistinctiveSemanticHitCount,
    });
  }
  const semanticHead = [...preliminary].sort((left, right) => (
    right.headlineDistinctiveSemanticHitCount - left.headlineDistinctiveSemanticHitCount
      || right.headlineEffectPhraseHitCount - left.headlineEffectPhraseHitCount
      || right.headlineCanonicalFourGramHitCount - left.headlineCanonicalFourGramHitCount
      || right.headlineFourGramHitCount - left.headlineFourGramHitCount
      || right.headlineThreeGramHitCount - left.headlineThreeGramHitCount
      || Number(right.mechanismAnchoredShortMatch) - Number(left.mechanismAnchoredShortMatch)
      || right.fourGramHitCount - left.fourGramHitCount
      || right.threeGramHitCount - left.threeGramHitCount
      || right.fourGramCoverage - left.fourGramCoverage
      || stableRecordKey(left.record).localeCompare(stableRecordKey(right.record))
  ));

  // Keep one independent whole-question lexical head. Semantic labels are
  // useful for ranking analogues, but they must not prevent a near-verbatim
  // official question from ever reaching the more precise longest-run check.
  // This reserves no extra final evidence slots: the lexical head is merged
  // back into the existing fixed `limit` below.
  const lexicalHead = [...preliminary].sort((left, right) => (
    right.fourGramCoverage - left.fourGramCoverage
      || right.fourGramHitCount - left.fourGramHitCount
      || right.threeGramCoverage - left.threeGramCoverage
      || right.threeGramHitCount - left.threeGramHitCount
      || right.headlineCanonicalFourGramHitCount - left.headlineCanonicalFourGramHitCount
      || right.headlineFourGramHitCount - left.headlineFourGramHitCount
      || stableRecordKey(left.record).localeCompare(stableRecordKey(right.record))
  ));

  // Longest common-substring comparison is more expensive than the initial
  // four-gram scan. It is only a tie-breaker, so calculate it for a generous
  // bounded head rather than multiplying it by the full synchronized corpus.
  const runCandidateLimit = Math.max(64, Math.min(256, Math.floor(Number(limit) || 6) * 32));
  const enrichedByRecord = new Map(dedupeBy([
    ...semanticHead.slice(0, runCandidateLimit),
    ...lexicalHead.slice(0, runCandidateLimit),
  ], (item) => stableRecordKey(item.record))
    .map((item) => ({
      ...item,
      longestRun: longestCommonCjkRun(querySegments, item.cjkSegments),
      headlineLongestRun: longestCommonCjkRun(querySegments, item.headlineCjkSegments),
    }))
    .map((item) => ({
      ...item,
      // This bonus distinguishes a question whose concise official headline
      // itself contains the queried operation from a long scenario where the
      // same words appear only incidentally inside quoted/background effects.
      // It can improve ordering only after the complete question qualified.
      headlineAnchored: item.mechanismAnchoredShortMatch && (
        (
          item.headlineThreeGramHitCount >= 2
          && item.headlineLongestRun >= 4
        ) || item.headlineCanonicalFourGramHitCount >= 3
      ),
    }))
    .map((item) => [stableRecordKey(item.record), item]));
  const isQualified = (item) => (
    item.longestRun >= 5
      || (item.mechanismAnchoredShortMatch && item.longestRun >= 4)
  );
  const ranked = semanticHead.slice(0, runCandidateLimit)
    .map((item) => enrichedByRecord.get(stableRecordKey(item.record)))
    .filter(Boolean)
    .filter(isQualified)
    .sort((left, right) => (
      Number(right.headlineAnchored) - Number(left.headlineAnchored)
        || right.headlineDistinctiveSemanticHitCount - left.headlineDistinctiveSemanticHitCount
        || right.headlineEffectPhraseHitCount - left.headlineEffectPhraseHitCount
        || right.headlineCanonicalFourGramHitCount - left.headlineCanonicalFourGramHitCount
        || right.headlineFourGramHitCount - left.headlineFourGramHitCount
        || right.headlineThreeGramHitCount - left.headlineThreeGramHitCount
        || Number(right.mechanismAnchoredShortMatch) - Number(left.mechanismAnchoredShortMatch)
        || right.fourGramHitCount - left.fourGramHitCount
        || right.threeGramHitCount - left.threeGramHitCount
        || right.longestRun - left.longestRun
        || right.fourGramCoverage - left.fourGramCoverage
        || stableRecordKey(left.record).localeCompare(stableRecordKey(right.record))
    ));
  const lexicalRanked = lexicalHead.slice(0, runCandidateLimit)
    .map((item) => enrichedByRecord.get(stableRecordKey(item.record)))
    .filter(Boolean)
    .filter(isQualified)
    .sort((left, right) => (
      right.fourGramCoverage - left.fourGramCoverage
        || right.longestRun - left.longestRun
        || right.fourGramHitCount - left.fourGramHitCount
        || right.threeGramCoverage - left.threeGramCoverage
        || right.headlineCanonicalFourGramHitCount - left.headlineCanonicalFourGramHitCount
        || right.headlineLongestRun - left.headlineLongestRun
        || stableRecordKey(left.record).localeCompare(stableRecordKey(right.record))
    ));
  // Use absolute relevance requirements only.  A relative threshold tied to
  // the single best question made recall depend on unrelated corpus contents:
  // one near-verbatim candidate could erase another independently decisive
  // question from the bounded post-planner pool.
  return dedupeBy([
    ...lexicalRanked.slice(0, 1),
    ...ranked,
  ], (item) => stableRecordKey(item.record))
    .filter((item) => (
      (item.fourGramHitCount >= minimumHits
        && item.fourGramCoverage >= 0.12
        && item.longestRun >= 5)
      || (item.mechanismAnchoredShortMatch && item.longestRun >= 4)
    ))
    .slice(0, Math.max(1, Math.floor(Number(limit) || 6)))
    .map((item) => ({
      record: item.record,
      score: normalizeEvidenceRelevanceScore(
        0.45
          + item.fourGramCoverage * 0.35
          + item.threeGramCoverage * 0.1
          + item.strongMechanismQueryCoverage * 0.1
          + Math.min(1, item.longestRun / 24) * 0.2,
      ),
      questionTextMetrics: {
        fourGramHitCount: item.fourGramHitCount,
        fourGramCoverage: Number(item.fourGramCoverage.toFixed(4)),
        threeGramHitCount: item.threeGramHitCount,
        threeGramCoverage: Number(item.threeGramCoverage.toFixed(4)),
        longestRun: item.longestRun,
        headlineAnchored: item.headlineAnchored,
        headlineThreeGramHitCount: item.headlineThreeGramHitCount,
        headlineFourGramHitCount: item.headlineFourGramHitCount,
        headlineCanonicalFourGramHitCount: item.headlineCanonicalFourGramHitCount,
        headlineEffectPhraseHitCount: item.headlineEffectPhraseHitCount,
        headlineDistinctiveSemanticHitCount: item.headlineDistinctiveSemanticHitCount,
        headlineLongestRun: item.headlineLongestRun,
        matchedStrongMechanismFeatures: item.matchedStrongMechanismFeatures,
        strongMechanismQueryCoverage: Number(item.strongMechanismQueryCoverage.toFixed(4)),
      },
    }));
}

function normalizeCjkQuestionSegments(value) {
  return [...String(value || "").normalize("NFKC").toLowerCase()
    .matchAll(/[\u3040-\u30ff\u3400-\u9fff]+/gu)]
    .map((match) => match[0])
    .filter(Boolean);
}

function extractPrincipalQuestionHeadline(value) {
  const paragraphs = String(value || "")
    .split(/\n+/u)
    .map((item) => item.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const questions = paragraphs.filter((item) => /[?？]/u.test(item));
  return questions.at(-1) || "";
}

function normalizeCanonicalCjkQuestionSegments(value) {
  const expanded = String(value || "")
    .normalize("NFKC")
    .replace(/P\s*ゾーン/giu, "ペンデュラムゾーン");
  return normalizeCjkQuestionSegments(expanded);
}

function uniqueCjkNgrams(segments = [], size = 4) {
  const grams = new Set();
  for (const text of segments || []) {
    for (let index = 0; index <= text.length - size; index += 1) {
      grams.add(text.slice(index, index + size));
    }
  }
  return [...grams];
}

function longestCommonCjkRun(leftSegments = [], rightSegments = []) {
  let best = 0;
  for (const left of leftSegments || []) {
    for (const right of rightSegments || []) {
      best = Math.max(best, longestCommonTextRun(left, right));
    }
  }
  return best;
}

function longestCommonTextRun(left, right) {
  if (!left || !right) return 0;
  const previous = new Uint16Array(right.length + 1);
  let best = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const saved = previous[rightIndex];
      previous[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? diagonal + 1
        : 0;
      if (previous[rightIndex] > best) best = previous[rightIndex];
      diagonal = saved;
    }
  }
  return best;
}

function selectIndependentRuleQueries({
  deterministicRuleQueries = [],
  supplementalRuleQueries = [],
  limit = 0,
} = {}) {
  const safeLimit = Math.max(0, Math.min(4, Math.floor(Number(limit) || 0)));
  if (!safeLimit) return [];
  // Prefer model-generated unresolved subclaims, then use deterministic user
  // and card-text branches to fill only the unused part of the same four-slot
  // budget. A partial model plan must not disable deterministic discovery, and
  // adding the fallback must never enlarge the global query or evidence caps.
  const supplemental = normalizeRuleSearchQueries(supplementalRuleQueries, {
    maxRuleSearchQueries: safeLimit,
  });
  const supplementalKeys = new Set(
    supplemental.map(ruleSearchQueryIdentity).filter(Boolean),
  );
  const deterministic = normalizeRuleSearchQueries(deterministicRuleQueries, {
    maxRuleSearchQueries: safeLimit,
  }).filter((query) => !supplementalKeys.has(ruleSearchQueryIdentity(query)));
  // Keep strict-mechanism ranking and full-question ranking on the same
  // bounded query plan. Otherwise each path can silently preserve a different
  // set of four branches and lose a later decision checkpoint.
  return normalizeRuleSearchQueries([
    ...supplemental,
    ...deterministic,
  ], {
    maxRuleSearchQueries: safeLimit,
  });
}

function relatedMatchedQuestionSideCardIds(item = {}) {
  const values = [
    ...(Array.isArray(item?.matchedQuestionCardIds) ? item.matchedQuestionCardIds : []),
    ...(Array.isArray(item?.matchedRelatedQuestionCardIds)
      ? item.matchedRelatedQuestionCardIds
      : []),
    ...(Array.isArray(item?.retrievalSignals?.matchedQuestionCardIds)
      ? item.retrievalSignals.matchedQuestionCardIds
      : []),
  ];
  return [...new Set(values.map(normalizeCardIdentityId).filter(Boolean))];
}

function compareRetrievedRecords(left = {}, right = {}) {
  const leftSignals = comparableRetrievalSignals(left);
  const rightSignals = comparableRetrievalSignals(right);
  return Number(rightSignals.questionCardIdCoverage || 0) - Number(leftSignals.questionCardIdCoverage || 0)
    || Number(rightSignals.matchedQuestionCardIdCount || 0) - Number(leftSignals.matchedQuestionCardIdCount || 0)
    || Number(rightSignals.questionBranchHeadlineAnchored === true)
      - Number(leftSignals.questionBranchHeadlineAnchored === true)
    || Number(rightSignals.questionBranchHeadlineDistinctiveSemanticHitCount || 0)
      - Number(leftSignals.questionBranchHeadlineDistinctiveSemanticHitCount || 0)
    || Number(rightSignals.questionBranchHeadlineEffectPhraseHitCount || 0)
      - Number(leftSignals.questionBranchHeadlineEffectPhraseHitCount || 0)
    || Number(rightSignals.questionBranchHeadlineCanonicalFourGramHitCount || 0)
      - Number(leftSignals.questionBranchHeadlineCanonicalFourGramHitCount || 0)
    || Number(rightSignals.questionBranchHeadlineFourGramHitCount || 0)
      - Number(leftSignals.questionBranchHeadlineFourGramHitCount || 0)
    || Number(rightSignals.questionBranchHeadlineThreeGramHitCount || 0)
      - Number(leftSignals.questionBranchHeadlineThreeGramHitCount || 0)
    || Number(rightSignals.questionBranchHeadlineLongestRun || 0)
      - Number(leftSignals.questionBranchHeadlineLongestRun || 0)
    || Number(rightSignals.questionBranchFourGramHitCount || 0)
      - Number(leftSignals.questionBranchFourGramHitCount || 0)
    || Number(rightSignals.questionBranchThreeGramHitCount || 0)
      - Number(leftSignals.questionBranchThreeGramHitCount || 0)
    || Number(rightSignals.questionBranchLongestRun || 0)
      - Number(leftSignals.questionBranchLongestRun || 0)
    || Number(rightSignals.questionBranchFourGramCoverage || 0)
      - Number(leftSignals.questionBranchFourGramCoverage || 0)
    || Number(rightSignals.strongMechanismQueryCoverage || 0) - Number(leftSignals.strongMechanismQueryCoverage || 0)
    || (rightSignals.matchedStrongMechanismFeatures || []).length - (leftSignals.matchedStrongMechanismFeatures || []).length
    || Number(rightSignals.effectNumberCompatible === true) - Number(leftSignals.effectNumberCompatible === true)
    || Number(rightSignals.typeCompatible === true) - Number(leftSignals.typeCompatible === true)
    || Number(right.retrievalScore || 0) - Number(left.retrievalScore || 0)
    || Number(rightSignals.lexicalHitCount || 0) - Number(leftSignals.lexicalHitCount || 0)
    // The model sees only candidate questions. Its assessment can resolve a
    // tie, but it must never override stronger mechanism or lexical evidence.
    || modelAssessmentRank(rightSignals.modelCandidateAssessment)
      - modelAssessmentRank(leftSignals.modelCandidateAssessment)
    || stableRecordKey(left).localeCompare(stableRecordKey(right));
}

function comparableRetrievalSignals(item = {}) {
  const nested = item.retrievalSignals || {};
  const topLevelMatchedQuestionCardIdCount = Array.isArray(item.matchedQuestionCardIds)
    ? item.matchedQuestionCardIds.length
    : 0;
  const hasTopLevelEffectCompatibility = Object.prototype.hasOwnProperty.call(
    item,
    "effectNumberCompatible",
  );
  return {
    ...nested,
    // Official matcher results carry these values at the top level, whereas
    // independently ranked records carry them inside retrievalSignals. Merge
    // both shapes before applying the one canonical comparator.
    questionCardIdCoverage: Math.max(
      Number(nested.questionCardIdCoverage || 0),
      Number(item.questionCardIdCoverage || 0),
    ),
    matchedQuestionCardIdCount: Math.max(
      Number(nested.matchedQuestionCardIdCount || 0),
      topLevelMatchedQuestionCardIdCount,
    ),
    effectNumberCompatible: hasTopLevelEffectCompatibility
      ? item.effectNumberCompatible !== false
      : nested.effectNumberCompatible,
  };
}

function modelAssessmentRank(assessment = null) {
  if (!assessment || typeof assessment !== "object") return 0;
  const premise = String(assessment.premise || "unknown");
  const relevance = String(assessment.relevance || "low");
  if (premise === "different") return -3;
  if (premise === "unknown") return 0;
  if (premise === "partial") {
    // A low-confidence partial analogy is not evidence that it outranks an
    // unassessed candidate; keep it neutral instead of awarding a bonus.
    return relevance === "high" ? 3 : relevance === "medium" ? 2 : 0;
  }
  if (premise === "same") {
    return relevance === "high" ? 6 : relevance === "medium" ? 5 : 1;
  }
  return 0;
}

function hasEligibleModelCandidateAssessment(item = {}) {
  const record = item?.record || item;
  const assessment = record?.retrievalSignals?.modelCandidateAssessment
    || record?.retrievalContext?.modelCandidateAssessment
    || item?.modelCandidateAssessment;
  if (!assessment || typeof assessment !== "object") return false;
  return assessment.source === "model_rule_query_soft_ranker"
    && ["high", "medium"].includes(String(assessment.relevance || ""))
    && ["same", "partial"].includes(String(assessment.premise || ""));
}

function attachModelCandidateAssessment(record = {}, assessment = null) {
  if (!assessment) return record;
  return {
    ...record,
    retrievalContext: {
      ...(record.retrievalContext || {}),
      modelCandidateAssessment: {
        relevance: assessment.relevance,
        premise: assessment.premise,
        difference: assessment.difference || "",
        source: assessment.source || "model_rule_query_soft_ranker",
      },
    },
    retrievalSignals: {
      ...(record.retrievalSignals || {}),
      modelCandidateAssessment: assessment,
    },
  };
}

function applyModelAssessmentsToRecords(records = [], assessmentById = new Map()) {
  if (!assessmentById.size) return records;
  return (records || []).map((record) => attachModelCandidateAssessment(
    record,
    assessmentById.get(stableRecordKey(record)),
  ));
}

function applyModelAssessmentsToOfficialMatches(matches = {}, assessmentById = new Map()) {
  if (!assessmentById.size) return matches;
  const annotate = (items = []) => items
    .map((match) => {
      const assessment = assessmentById.get(stableRecordKey(match?.record || match));
      return assessment ? {
          ...match,
          modelCandidateAssessment: assessment,
          record: attachModelCandidateAssessment(match.record, assessment),
        } : match;
    });
  return {
    ...matches,
    // Preserve the matcher's evidence-derived order. The assessment is attached
    // for later tie-breaking and diagnostics only.
    all: annotate(matches.all),
    exact: annotate(matches.exact),
    near: annotate(matches.near),
  };
}

function hasSevereQuestionIdentityMismatch(match = {}, resolvedCardCount = 0) {
  const record = match.record || {};
  const selectedBranchCardIds = new Set(
    (match.supportingQuestionBranchCardIds || []).map(normalizeCardIdentityId).filter(Boolean),
  );
  const selectedBranchMatchedCardIds = new Set(
    (match.branchMatchedCardIds || []).map(normalizeCardIdentityId).filter(Boolean),
  );
  const useSelectedBranch = match.branchRelevant === true
    && selectedBranchCardIds.size > 0
    && selectedBranchMatchedCardIds.size > 0;
  const questionCardIdCount = useSelectedBranch
    ? selectedBranchCardIds.size
    : principalQuestionCardIds(record).size;
  const matchedQuestionCardIdCount = useSelectedBranch
    ? selectedBranchMatchedCardIds.size
    : Array.isArray(match.matchedQuestionCardIds)
      ? match.matchedQuestionCardIds.length
    : Number(match.matchedQuestionCardIdCount || 0);
  const unmatchedQuestionCardIdCount = Math.max(
    0,
    questionCardIdCount - matchedQuestionCardIdCount,
  );
  const questionCoverage = useSelectedBranch
    ? matchedQuestionCardIdCount / questionCardIdCount
    : Number(match.questionCardIdCoverage ?? (
      resolvedCardCount ? matchedQuestionCardIdCount / resolvedCardCount : 0
    ));
  return resolvedCardCount >= 2
    && matchedQuestionCardIdCount >= 1
    && questionCardIdCount > matchedQuestionCardIdCount
    && unmatchedQuestionCardIdCount >= 1
    && questionCoverage <= 0.5;
}

function principalQuestionCardIds(record = {}) {
  if (record.recordType === "card-faq") {
    return new Set(structuredRecordOwnershipCardIds(record)
      .map(normalizeCardIdentityId)
      .filter(Boolean));
  }
  return new Set(projectOfficialQaQuestion(record).principalCardIds
    .map(normalizeCardIdentityId)
    .filter(Boolean));
}

function buildRuleMechanismSignature(value) {
  const text = String(value || "").normalize("NFKC");
  const features = new Set();
  for (const [feature, pattern] of RULE_MECHANISM_FEATURE_PATTERNS) {
    if (pattern.test(text)) features.add(feature);
  }
  for (const concept of extractOfficialQaSemanticConcepts(text)) {
    if (RULE_MECHANISM_GENERIC_CONCEPTS.has(concept)) continue;
    features.add(
      RULE_MECHANISM_CONCEPT_FAMILIES.get(concept) || `concept:${concept}`,
    );
  }
  addPredicatePolarityFeatures(text, features);
  return features;
}

function addPredicatePolarityFeatures(text, features) {
  const clauses = String(text || "").split(/[。！？!?;；\n\r]+/u);
  for (const clause of clauses) {
    if (!/(?:扱い|视为|視為|作为.{0,12}处理|作為.{0,12}處理|treated as)/iu.test(clause)) continue;
    const negative = /(?:扱い(?:に)?(?:は)?ならない|扱わない|不(?:被)?(?:视为|視為|当作|當作|作为.{0,12}处理|作為.{0,12}處理)|(?:not|never)\s+(?:be\s+)?treated as)/iu.test(clause);
    const interrogative = /(?:是否|能否|可否|吗|嗎|でしょうか|できますか|できるか|whether|\bcan\b|\bmay\b)/iu.test(clause);
    if (negative) features.add("relation:treated-as:negative");
    else if (!interrogative) features.add("relation:treated-as:positive");
  }
}

function isUsableRuleMechanismSignature(signature = new Set()) {
  const eligibilityDimensions = ruleMechanismSignatureDimensions(signature)
    .filter((dimension) => dimension !== "relation");
  const hasMechanismAnchor = eligibilityDimensions.some((dimension) => (
    dimension === "operation"
    || dimension === "activation"
    || dimension === "sequence"
    || dimension.startsWith("concept:")
  ));
  // This is broad candidate discovery, not a verdict validator. One genuine
  // question-side mechanism anchor is sufficient; the auxiliary model checks
  // all material conditions afterwards.
  return hasMechanismAnchor;
}

function ruleMechanismFeatureDimension(feature) {
  const value = String(feature || "");
  if (value.startsWith("concept:")) return value;
  return value.split(":", 1)[0] || value;
}

function ruleMechanismSignatureDimensions(signature = []) {
  return [...new Set([...signature]
    .map(ruleMechanismFeatureDimension)
    .filter(Boolean))]
    .sort();
}

function ruleMechanismFeatureWeight(feature) {
  const value = String(feature || "");
  if (value.startsWith("concept:")) return 1.25;
  if (value.startsWith("operation:")) return 1.5;
  return 1;
}

function isStrongRuleMechanismFeature(feature) {
  const value = String(feature || "");
  return value.startsWith("operation:")
    || value.startsWith("concept:")
    || value.startsWith("relation:treated-as:");
}

function bestRuleMechanismMatch(querySignatures = [], evidenceSignature = new Set()) {
  const candidates = querySignatures.map((signature) => {
    const matchedFeatures = [...signature].filter((feature) => evidenceSignature.has(feature));
    const strongQueryFeatures = [...signature].filter(isStrongRuleMechanismFeature);
    const matchedStrongFeatures = matchedFeatures.filter(isStrongRuleMechanismFeature);
    const matchedContextFeatures = matchedFeatures.filter((feature) => !isStrongRuleMechanismFeature(feature));
    return {
      matchedFeatures,
      matchedStrongFeatures,
      matchedContextFeatures,
      strongQueryCoverage: strongQueryFeatures.length
        ? matchedStrongFeatures.length / strongQueryFeatures.length
        : 0,
    };
  });
  return candidates.sort((left, right) => (
    right.strongQueryCoverage - left.strongQueryCoverage
    || right.matchedStrongFeatures.length - left.matchedStrongFeatures.length
    || right.matchedContextFeatures.length - left.matchedContextFeatures.length
  ))[0] || {
    matchedFeatures: [],
    matchedStrongFeatures: [],
    matchedContextFeatures: [],
    strongQueryCoverage: 0,
  };
}

function scoreRecord(record, {
  queryTerms,
  ruleTerms,
  rulePhrases,
  queryKey,
  resolvedIds,
  resolvedNames,
  unresolvedNames,
  allowNoCardMatch,
  queryEffectNumbers,
  queryQuestionType,
  queryEffectPhrases,
  querySemanticConcepts,
  queryMechanismSignatures = [],
}) {
  const questionFeatures = retrievalQuestionFeatures(record);
  const {
    rankingIdentity,
    questionText,
    questionCardIds,
    evidenceEffectNumbers,
    evidenceQuestionType,
    evidenceEffectPhrases,
    evidenceSemanticConcepts,
    evidenceMechanismSignature,
  } = questionFeatures;
  const text = rankingIdentity.text;
  const { textKey, normalizedCardIds, normalizedCardNames } = retrievalRecordFeatures(
    record,
    rankingIdentity,
  );
  const matchedRecordCardIds = normalizedCardIds.filter((id) => resolvedIds.has(id));
  const matchedQuestionCardIds = [...resolvedIds].filter((id) => questionCardIds.has(id));
  const matchedCardIds = [...new Set([
    ...matchedRecordCardIds,
    ...matchedQuestionCardIds,
  ])];
  const cardIdMatch = matchedCardIds.length > 0;
  const questionCardIdCoverage = resolvedIds.size
    ? matchedQuestionCardIds.length / resolvedIds.size
    : 0;
  const allowUnstructuredCardNameMatch = record.recordType !== "card-faq";
  const cardNameMatch = normalizedCardNames.some((name) => resolvedNames.has(name))
    || (
      allowUnstructuredCardNameMatch
      && [...resolvedNames].some((name) => name.length >= 3 && !hasNumberedCardIdentityConflict(name, text) && textKey.includes(name))
    );
  const unresolvedNameMatch = allowUnstructuredCardNameMatch
    && [...unresolvedNames].some((name) => name.length >= 3 && !hasNumberedCardIdentityConflict(name, text) && textKey.includes(name));
  const cardScore = cardIdMatch ? 5 : cardNameMatch ? 4 : unresolvedNameMatch ? 2 : 0;
  if (!allowNoCardMatch && resolvedIds.size + resolvedNames.size > 0 && !cardScore) {
    return emptyRecordScore();
  }
  let score = cardScore;
  const lexicalHits = new Set();
  for (const term of queryTerms) {
    if (textKey.includes(term)) {
      score += 1;
      lexicalHits.add(term);
    }
  }
  for (const term of ruleTerms || []) {
    if (textKey.includes(term)) {
      score += 2;
      lexicalHits.add(term);
    }
  }
  let phraseMatched = false;
  for (const phrase of rulePhrases || []) {
    if (phrase.length >= 4 && textKey.includes(phrase.slice(0, Math.min(phrase.length, 80)))) {
      score += 4;
      phraseMatched = true;
    }
  }
  const fullQueryMatched = queryKey.length >= 8 && textKey.includes(queryKey.slice(0, Math.min(queryKey.length, 80)));
  if (fullQueryMatched) score += 5;
  const effectNumberCompatible = !queryEffectNumbers.length
    || !evidenceEffectNumbers.length
    || queryEffectNumbers.some((number) => evidenceEffectNumbers.includes(number));
  const typeCompatible = questionTypeCompatibleForRanking(queryQuestionType, evidenceQuestionType);
  const matchedEffectPhrases = queryEffectPhrases.filter((phrase) => evidenceEffectPhrases.includes(phrase));
  const matchedSemanticConcepts = querySemanticConcepts.filter((concept) => evidenceSemanticConcepts.includes(concept));
  const semanticQueryCoverage = querySemanticConcepts.length
    ? matchedSemanticConcepts.length / querySemanticConcepts.length
    : 0;
  const mechanismMatch = bestRuleMechanismMatch(
    queryMechanismSignatures,
    evidenceMechanismSignature,
  );
  // Lexical overlap is normally required, but it cannot be the sole gateway
  // for multilingual official Q&A. Admit an official record that shares at
  // least two distinctive mechanism features with strong query coverage.
  // Handwritten question-type classification may still affect ranking, but it
  // is not a deletion gate. Cross-card evidence remains related-only below.
  const strictOfficialMechanismMatch = isOfficialQaOrFaqRecord(record)
    && mechanismMatch.matchedStrongFeatures.length >= 2
    && Number(mechanismMatch.strongQueryCoverage || 0) >= 0.66;
  if (
    !cardScore
    && !phraseMatched
    && !fullQueryMatched
    && lexicalHits.size < 3
    && !strictOfficialMechanismMatch
  ) {
    return emptyRecordScore();
  }
  score += questionCardIdCoverage * 5;
  score += matchedQuestionCardIds.length * 1.5;
  if (effectNumberCompatible && queryEffectNumbers.length && evidenceEffectNumbers.length) score += 2;
  if (typeCompatible && queryQuestionType !== "unknown") score += 1.5;
  score += matchedEffectPhrases.length;
  score += semanticQueryCoverage * 3;
  if (score <= 0) return emptyRecordScore();
  if (record.recordType === "qa") score += 0.5;
  if (record.recordType === "card-faq") score += 0.4;
  return {
    rawScore: score,
    relevanceScore: normalizeEvidenceRelevanceScore(1 - Math.exp(-score / 10)),
    signals: {
      matchedCardIdCount: matchedCardIds.length,
      matchedQuestionCardIdCount: matchedQuestionCardIds.length,
      questionCardIdCoverage: Number(questionCardIdCoverage.toFixed(4)),
      effectNumberCompatible,
      typeCompatible,
      matchedEffectPhrases,
      matchedSemanticConcepts,
      semanticQueryCoverage: Number(semanticQueryCoverage.toFixed(4)),
      lexicalHitCount: lexicalHits.size,
      fullQueryMatched,
      rulePhraseMatched: phraseMatched,
      matchedMechanismFeatures: mechanismMatch.matchedFeatures,
      matchedStrongMechanismFeatures: mechanismMatch.matchedStrongFeatures,
      matchedContextMechanismFeatures: mechanismMatch.matchedContextFeatures,
      strongMechanismQueryCoverage: Number(mechanismMatch.strongQueryCoverage.toFixed(4)),
    },
  };
}

function emptyRecordScore() {
  return {
    rawScore: 0,
    relevanceScore: 0,
    signals: {},
  };
}

function compareRankedRecords(left, right) {
  return right.signals.questionCardIdCoverage - left.signals.questionCardIdCoverage
    || right.signals.matchedQuestionCardIdCount - left.signals.matchedQuestionCardIdCount
    || Number(right.signals.effectNumberCompatible) - Number(left.signals.effectNumberCompatible)
    || Number(right.signals.typeCompatible) - Number(left.signals.typeCompatible)
    || right.relevanceScore - left.relevanceScore
    || right.rawScore - left.rawScore
    || String(left.record.id).localeCompare(String(right.record.id));
}

function questionTypeCompatibleForRanking(queryType, evidenceType) {
  if (queryType === "unknown" || evidenceType === "unknown") return queryType === evidenceType;
  if (queryType === evidenceType) return true;
  const activation = new Set([
    "can_activate",
    "timing_window",
    "card_activation_vs_effect_activation",
  ]);
  if (activation.has(queryType) && activation.has(evidenceType)) return true;
  const legality = new Set(["action_legality", "can_activate", "target_legality", "timing_window"]);
  return legality.has(queryType) && legality.has(evidenceType);
}

function extractEffectNumbers(value) {
  const text = String(value || "").normalize("NFKC");
  return [...new Set([
    ...[...text.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩]/gu)]
      .map((match) => String("①②③④⑤⑥⑦⑧⑨⑩".indexOf(match[0]) + 1)),
    ...[...text.matchAll(/(?:第\s*)?([1-9]|10)\s*(?:个|個|つ目)?(?:的|の)?\s*(?:効果|效果|effect)/giu)]
      .map((match) => String(Number(match[1]))),
  ].filter(Boolean))];
}

function normalizeEvidenceRelevanceScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, Number(number.toFixed(4))));
}

function retrievalRecordFeatures(record = {}, preparedIdentity) {
  if (record && typeof record === "object") {
    const cached = retrievalRecordFeatureCache.get(record);
    if (cached) return cached;
  }
  const identity = preparedIdentity && typeof preparedIdentity === "object"
    ? preparedIdentity
    : retrievalRankingIdentity(record);
  const features = {
    textKey: normalizeCardKey(identity.text),
    normalizedCardIds: identity.cardIds.map(normalizeCardIdentityId).filter(Boolean),
    normalizedCardNames: identity.cardNames.map(normalizeCardKey).filter(Boolean),
  };
  if (record && typeof record === "object") retrievalRecordFeatureCache.set(record, features);
  return features;
}

function retrievalQuestionFeatures(record = {}) {
  const cacheable = record && typeof record === "object";
  if (cacheable) {
    const cached = retrievalQuestionFeatureCache.get(record);
    if (cached) return cached;
  }

  const questionProjection = projectOfficialQaQuestion(record);
  const rankingIdentity = retrievalRankingIdentity(record, questionProjection);
  const questionText = questionProjection.scenarioText || record.title || "";
  const evidenceText = questionText || rankingIdentity.text;
  const features = {
    rankingIdentity,
    questionProjection,
    questionText,
    questionCardIds: new Set((record.recordType === "card-faq"
      ? structuredRecordOwnershipCardIds(record)
      : questionProjection.principalCardIds)
      .map(normalizeCardIdentityId)
      .filter(Boolean)),
    evidenceEffectNumbers: extractEffectNumbers(evidenceText),
    evidenceQuestionType: classifyOfficialQaQuestionType(evidenceText),
    evidenceEffectPhrases: extractOfficialQaEffectPhrases(evidenceText),
    evidenceSemanticConcepts: extractOfficialQaSemanticConcepts(evidenceText),
    evidenceMechanismSignature: buildRuleMechanismSignature(evidenceText),
  };
  if (cacheable) retrievalQuestionFeatureCache.set(record, features);
  return features;
}

function isScenarioOfficialQaRecord(record = {}) {
  return record.recordType === "qa" || record.recordType === "official-database";
}

function retrievalRankingIdentity(record = {}, preparedProjection) {
  if (record.recordType === "card-faq") {
    const projection = preparedProjection && typeof preparedProjection === "object"
      ? preparedProjection
      : projectOfficialQaQuestion(record);
    const text = hasOfficialQuestionSurface(record)
      ? [...new Set([
          projection.principalText,
          projection.scenarioText,
          ...(projection.surfaces || []),
        ].map((value) => String(value || "").trim()).filter(Boolean))].join("\n")
      : [record.title || "", record.text || ""].join("\n");
    return {
      text,
      cardIds: structuredRecordOwnershipCardIds(record),
      cardNames: structuredRecordOwnershipCardNames(record),
    };
  }
  // card-faq has its own ownership-only branch above.  Do not broaden the
  // question-bound identity rules of unrelated record types merely because
  // they happen to expose a question-shaped field.
  const hasQuestionBoundIdentity = isScenarioOfficialQaRecord(record);
  if (!hasQuestionBoundIdentity) {
    return {
      text: [record.title || "", record.text || ""].join("\n"),
      cardIds: [record.cardId, ...(record.cardIds || []), ...extractInlineCardIds([
        record.question,
        record.rawQuestion,
        record.rawDetailedQuestion,
        record.title,
        record.text,
        record.answer,
        record.conclusion,
      ].filter(Boolean).join("\n"))].filter(Boolean),
      cardNames: [record.cardName, ...(record.cards || []), ...(record.cardNames || [])]
        .filter(Boolean),
    };
  }

  const projection = preparedProjection && typeof preparedProjection === "object"
    ? preparedProjection
    : projectOfficialQaQuestion(record);
  const text = [...new Set([
    projection.principalText,
    projection.scenarioText,
    ...(projection.surfaces || []),
  ].map((value) => String(value || "").trim()).filter(Boolean))].join("\n");
  const textKey = normalizeCardKey(text);
  const cardNames = [record.cardName, ...(record.cards || []), ...(record.cardNames || [])]
    .map((value) => String(value || "").trim())
    .filter((value) => {
      const key = normalizeCardKey(value);
      return key && key.length >= 2 && textKey.includes(key);
    });
  return {
    text,
    cardIds: [...new Set((projection.principalCardIds || []).map(normalizeCardIdentityId).filter(Boolean))],
    cardNames: [...new Set(cardNames)],
  };
}

function inferRuleSearchMechanism(item = {}) {
  const signature = buildRuleMechanismSignature(item?.query);
  if (!isUsableRuleMechanismSignature(signature)) return "";
  return ruleMechanismSignatureIdentity(signature);
}

function ruleMechanismSignatureIdentity(signature = new Set()) {
  const canonicalFeatures = [...signature]
    .sort((left, right) => (
      ruleMechanismFeatureWeight(right) - ruleMechanismFeatureWeight(left)
      || left.localeCompare(right)
    ));
  return `semantic:${canonicalFeatures.join("|")}`;
}

function ruleSearchQueryIdentity(item = {}) {
  const queryKey = normalizeCardKey(item?.query);
  if (!queryKey) return "";
  return `${queryKey}|${inferRuleSearchMechanism(item)}`;
}

function normalizeRuleSearchQueries(items, limits = {}) {
  const max = readPositiveNumber(limits.maxRuleSearchQueries || limits.maxRelatedEvidence, 8);
  const source = Array.isArray(items) ? items : [];
  const normalized = source
    .map((item) => typeof item === "string"
      ? {
          subclaim: "",
          checkpoint: "",
          query: item,
          reason: "",
          confidence: "medium",
          source: "rule_search_query",
          declaredMechanism: "",
        }
      : {
          subclaim: String(item?.subclaim || item?.factToVerify || item?.ruleQuestion || "").trim(),
          checkpoint: String(item?.checkpoint || item?.stage || "").trim(),
          query: String(item?.query || item?.searchQuery || item?.keyword || item?.topic || "").trim(),
          reason: String(item?.reason || "").trim(),
          confidence: item?.confidence || "medium",
          source: item?.source || "rule_search_query",
          declaredMechanism: String(item?.declaredMechanism || item?.mechanism || "").trim(),
        })
    .map((item) => ({
      ...item,
      subclaim: item.subclaim.replace(/\s+/gu, " ").slice(0, 160),
      checkpoint: item.checkpoint.replace(/\s+/gu, " ").toLowerCase().slice(0, 64),
      query: normalizeRuleSearchQueryText(item.query),
      reason: item.reason.replace(/\s+/gu, " ").slice(0, 120),
      mechanism: inferRuleSearchMechanism(item),
    }))
    .filter((item) => item.query && /[A-Za-z\u3040-\u30ff\u3400-\u9fff0-9]/u.test(item.query));
  const groupedByQuery = new Map();
  for (const item of normalized) {
    const key = normalizeCardKey(item.query);
    const group = groupedByQuery.get(key) || [];
    group.push(item);
    groupedByQuery.set(key, group);
  }
  const deduped = [];
  for (const group of groupedByQuery.values()) {
    const withMechanism = dedupeBy(
      group.filter((item) => item.mechanism),
      (item) => item.mechanism,
    );
    deduped.push(...(withMechanism.length ? withMechanism : group.slice(0, 1)));
  }
  if (deduped.length <= max) return deduped;

  const reservedIndexes = new Set();
  const representedCheckpoints = new Set();
  deduped.forEach((item, index) => {
    if (!item.checkpoint || representedCheckpoints.has(item.checkpoint)) return;
    if (reservedIndexes.size >= max) return;
    representedCheckpoints.add(item.checkpoint);
    reservedIndexes.add(index);
  });
  const representedMechanisms = new Set();
  for (const index of reservedIndexes) {
    const mechanism = deduped[index]?.mechanism;
    if (mechanism) representedMechanisms.add(mechanism);
  }
  deduped.forEach((item, index) => {
    if (!item.mechanism || representedMechanisms.has(item.mechanism)) return;
    if (reservedIndexes.size >= max) return;
    representedMechanisms.add(item.mechanism);
    reservedIndexes.add(index);
  });
  for (let index = 0; index < deduped.length && reservedIndexes.size < max; index += 1) {
    reservedIndexes.add(index);
  }
  return [...reservedIndexes]
    .sort((left, right) => left - right)
    .map((index) => deduped[index]);
}

function deriveRuleSearchQueries(userQuery) {
  const query = buildGenericRuleQuery(userQuery);
  return query ? [{
    query,
    reason: "从题目中的操作、时点、位置和连锁描述生成通用规则检索词。",
    confidence: "medium",
    source: "derived_rule_search_query",
  }] : [];
}

function buildRuleQueryCandidateQuestions({
  scopedMatches = [],
  crossCardRecords = [],
  resolvedCards = [],
  limit = 12,
} = {}) {
  const safeLimit = Math.max(1, Math.min(12, Math.floor(Number(limit) || 12)));
  // Preserve distinct structured question premises before taking the small
  // question-only sample shown to the query model. A raw top-N prefix can hide
  // the only candidate that combines several resolved card identities even
  // though its official question is already in the scoped pool.
  const scopedCandidates = reserveIdentitySourceCoverage(
    scopedMatches || [],
    Math.min(8, safeLimit),
    resolvedCards,
  ).slice(0, Math.min(8, safeLimit)).map((match) => ({
    ...(match.record || {}),
    questionType: match.questionType || match.record?.questionType || "unknown",
  }));
  const crossCardLimit = Math.min(4, Math.max(0, safeLimit - scopedCandidates.length));
  const candidates = [
    ...scopedCandidates,
    ...(crossCardRecords || []).slice(0, crossCardLimit),
  ];
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const id = stableRecordKey(candidate);
    const question = String(
      candidate.rawDetailedQuestion
        || candidate.rawQuestion
        || candidate.question
        || candidate.title
        || "",
    ).replace(/\s+/gu, " ").trim();
    if (!id || !question || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      question: question.slice(0, 280),
      questionType: String(candidate.questionType || "unknown").slice(0, 80),
    });
    if (result.length >= safeLimit) break;
  }
  return result;
}

function diagnosticCandidateIds(items = []) {
  return [...new Set((items || [])
    .map((item) => stableRecordKey(item?.record || item))
    .filter(Boolean))];
}

function normalizeModelCandidateAssessments(assessments = [], candidateQuestions = []) {
  const allowedIds = new Set((candidateQuestions || []).map((item) => String(item.id || "")));
  const seen = new Set();
  const result = [];
  for (const assessment of Array.isArray(assessments) ? assessments : []) {
    const id = String(assessment?.id || "").trim();
    const relevance = String(assessment?.relevance || "").trim().toLowerCase();
    const premise = String(assessment?.premise || "").trim().toLowerCase();
    if (!allowedIds.has(id) || seen.has(id)) continue;
    if (!["high", "medium", "low"].includes(relevance)) continue;
    if (!["same", "partial", "different", "unknown"].includes(premise)) continue;
    seen.add(id);
    result.push({
      id,
      relevance,
      premise,
      difference: String(assessment?.difference || "").replace(/\s+/gu, " ").trim().slice(0, 240),
      source: "model_rule_query_soft_ranker",
    });
    if (result.length >= 12) break;
  }
  return result;
}

function isStrictSupplementalOfficialMechanismMatch(record = {}, query = {}) {
  if (!isOfficialQaOrFaqRecord(record)) return false;
  // Mechanism coverage is recomputed against this one supplemental query. The
  // ordinary ranked record carries aggregate signals, and a handwritten
  // question-type label is intentionally not a hard deletion gate here.
  const queryText = typeof query === "string" ? query : query?.query;
  const querySignature = buildRuleMechanismSignature(queryText);
  if (!isUsableRuleMechanismSignature(querySignature)) return false;
  const evidenceSignature = retrievalQuestionFeatures(record).evidenceMechanismSignature;
  const mechanismMatch = bestRuleMechanismMatch([querySignature], evidenceSignature);
  return mechanismMatch.matchedStrongFeatures.length >= 1
    && Number(mechanismMatch.strongQueryCoverage || 0) >= 0.5
    && (
      mechanismMatch.matchedStrongFeatures.length >= 2
      || mechanismMatch.matchedContextFeatures.length >= 1
    );
}

function recordSharesResolvedIdentity(record = {}, resolvedCards = []) {
  if (!(resolvedCards || []).length) return false;
  const identity = retrievalRankingIdentity(record);
  const resolvedIds = new Set((resolvedCards || [])
    .map((card) => normalizeCardIdentityId(card?.id || card?.cardId))
    .filter(Boolean));
  if (identity.cardIds.some((id) => resolvedIds.has(normalizeCardIdentityId(id)))) return true;
  const resolvedNames = new Set((resolvedCards || [])
    .flatMap((card) => [
      card?.name,
      card?.cnName,
      card?.jaName,
      card?.enName,
      ...(card?.aliases || []),
    ])
    .map(normalizeCardKey)
    .filter(Boolean));
  return identity.cardNames.some((name) => resolvedNames.has(normalizeCardKey(name)));
}

function deriveRuleSearchQueriesFromCardTexts(userQuery, cardTexts = [], {
  perCardLimit = 4,
  totalLimit = 12,
  source = "card_text_derived_rule_search_query",
} = {}) {
  const questionContext = buildGenericRuleQuery(userQuery).slice(0, 56);
  const perCardQueries = (cardTexts || []).map((item) => {
    const cardLabel = [...(item.cards || []), item.cardType].filter(Boolean).join(" ");
    return selectRuleSearchCardTextClauses(item.text, perCardLimit, userQuery)
      .map((clause) => ({
        query: normalizeRuleSearchQueryText(expandRetrievalVocabulary(
          [clause, questionContext, cardLabel].filter(Boolean).join(" "),
        )),
        reason: `根据${(item.cards || [item.title || "卡片"]).join("、")}的处理句检索对应规则。`,
        confidence: "medium",
        source,
      }))
      .filter((entry) => entry.query);
  });
  const safeTotalLimit = Math.max(1, Math.floor(Number(totalLimit) || 1));
  const interleaved = roundRobin(perCardQueries, safeTotalLimit);
  return dedupeBy(interleaved, (item) => normalizeCardKey(item.query)).slice(0, safeTotalLimit);
}

function selectRuleSearchCardTextClauses(value, limit = 4, userQuery = "") {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const clauses = splitCardTextClauseEntries(value)
    .filter(({ text }) => text.length >= 4 && containsOperationLanguage(text));
  if (clauses.length <= safeLimit) return clauses.map(({ text }) => text);

  const selected = [];
  const selectedIndexes = new Set();
  const representedFeatures = new Set();
  const questionTerms = new Set(tokenize(userQuery));
  const questionMechanisms = buildRuleMechanismSignature(userQuery);
  const add = (entry) => {
    if (!entry || selectedIndexes.has(entry.index) || selected.length >= safeLimit) return;
    selected.push(entry);
    selectedIndexes.add(entry.index);
    for (const feature of buildRuleMechanismSignature(entry.text)) representedFeatures.add(feature);
  };

  // Keep the first operative clause for its activation/sequence context, then
  // preserve the explicit bullet branches that best match the user's wording,
  // even when they occur late in a long card text. Remaining slots maximize
  // mechanism diversity rather than source order.
  add(clauses[0]);
  const rankedBulletClauses = clauses
    .filter(({ marker }) => marker === "●")
    .map((entry) => ({
      entry,
      lexicalOverlap: tokenize(entry.text)
        .filter((term) => questionTerms.has(term)).length,
      mechanismOverlap: [...buildRuleMechanismSignature(entry.text)]
        .filter((feature) => questionMechanisms.has(feature)).length,
    }))
    .sort((left, right) => (
      right.lexicalOverlap - left.lexicalOverlap
      || right.mechanismOverlap - left.mechanismOverlap
      || left.entry.index - right.entry.index
    ));
  for (const { entry } of rankedBulletClauses) add(entry);
  while (selected.length < safeLimit) {
    const candidates = clauses
      .filter((entry) => !selectedIndexes.has(entry.index))
      .map((entry) => {
        const features = buildRuleMechanismSignature(entry.text);
        const novelFeatureCount = [...features]
          .filter((feature) => !representedFeatures.has(feature)).length;
        return { entry, novelFeatureCount };
      })
      .sort((left, right) => (
        right.novelFeatureCount - left.novelFeatureCount
        || left.entry.index - right.entry.index
      ));
    if (!candidates.length) break;
    add(candidates[0].entry);
  }
  return selected
    .sort((left, right) => left.index - right.index)
    .map(({ text }) => text);
}

function splitCardTextClauseEntries(value) {
  return String(value || "")
    .replace(/(?=[①②③④⑤⑥⑦⑧⑨●])/gu, "\n")
    .split(/[。；;\n]+/u)
    .map((item, index) => {
      const raw = item.trim();
      const marker = raw.match(/^([①②③④⑤⑥⑦⑧⑨●]|\d+)[：:.、]?/u)?.[1] || "";
      return {
        index,
        marker,
        text: raw.replace(/^[①②③④⑤⑥⑦⑧⑨\d●]+[：:.、]?/u, "").trim(),
      };
    })
    .filter(({ text }) => text);
}

function roundRobin(groups, limit) {
  const result = [];
  const source = (groups || []).filter((group) => Array.isArray(group) && group.length);
  for (let index = 0; result.length < limit; index += 1) {
    let added = false;
    for (const group of source) {
      if (group[index]) {
        result.push(group[index]);
        added = true;
        if (result.length >= limit) break;
      }
    }
    if (!added) break;
  }
  return result;
}

function mergeRuleSearchQueries(baseQueries, cardQueries, limits) {
  const max = readPositiveNumber(limits.maxRuleSearchQueries, 12);
  const base = normalizeRuleSearchQueries(baseQueries, { maxRuleSearchQueries: max });
  const card = normalizeRuleSearchQueries(cardQueries, { maxRuleSearchQueries: max });
  const cardQuota = Math.min(card.length, Math.max(3, Math.floor(max / 2)));
  const baseQuota = Math.max(0, max - cardQuota);
  return normalizeRuleSearchQueries([
    ...base.slice(0, baseQuota),
    ...card.slice(0, cardQuota),
    ...base.slice(baseQuota),
    ...card.slice(cardQuota),
  ], { maxRuleSearchQueries: max });
}

function appendSupplementalRuleSearchQueries(deterministicQueries, supplementalQueries, limits) {
  const max = readPositiveNumber(limits.maxRuleSearchQueries, 12);
  const deterministic = normalizeRuleSearchQueries(
    deterministicQueries,
    { maxRuleSearchQueries: max },
  );
  const supplemental = normalizeRuleSearchQueries(
    supplementalQueries,
    { maxRuleSearchQueries: max },
  );
  const deterministicKeys = new Set(
    deterministic.map(ruleSearchQueryIdentity).filter(Boolean),
  );
  const independentSupplemental = supplemental.filter((query) => (
    !deterministicKeys.has(ruleSearchQueryIdentity(query))
  ));
  const deterministicCapacity = Math.max(0, max - independentSupplemental.length);
  // Caller/model-generated queries are retained after the local reproducible
  // query plan. Reserve their actual capacity before trimming the deterministic
  // tail; otherwise a full local plan silently discards every model-discovered
  // subclaim. Retrieval still keeps the deterministic prefix in its original
  // order, and duplicate supplemental queries do not consume another slot.
  return normalizeRuleSearchQueries([
    ...deterministic.slice(0, deterministicCapacity),
    ...independentSupplemental,
  ], { maxRuleSearchQueries: max });
}

function buildGenericRuleQuery(value) {
  const withoutCardNames = String(value || "")
    .normalize("NFKC")
    .replace(/[「『《【\[].*?[」』》】\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalizeCardKey(withoutCardNames).length < 4) return "";
  return expandRetrievalVocabulary(withoutCardNames).slice(0, 120);
}

function containsOperationLanguage(value) {
  return /(发动|發動|発動|处理|處理|适用|適用|选择|選擇|对象|對象|支付|cost|连锁|連鎖|チェーン|召唤|召喚|破坏|破壊|除外|送去|送墓|回到|返回|回去|放回|戻|攻击|攻擊|攻撃|无效|無效|抽|加入手|特殊召唤|特殊召喚)/iu.test(String(value || ""));
}

function expandRetrievalVocabulary(value) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  const additions = [];
  if (/(发动|發動|発動)/u.test(text)) additions.push("发动 発動");
  if (/(连锁|連鎖|チェーン|chain)/iu.test(text)) additions.push("连锁 チェーン chain");
  if (/(处理|處理|适用|適用|解決|resolve)/iu.test(text)) additions.push("处理 適用 解決 resolve");
  if (/(手卡|手牌|手札|hand)/iu.test(text)) additions.push("手卡 手牌 手札 hand");
  if (/(回到|返回|回去|放回|弹回|彈回|戻|return)/iu.test(text)) additions.push("回到 返回 回去 戻 return");
  if (/(?:手札|ハンド)(?:へ|に)戻|(?:回到|返回|放回|弹回|彈回)[^，,。.!！?？;；\n]{0,12}(?:手札|手牌|手卡)|return(?:ed|ing)?[^.。;；\n]{0,30}\bto (?:the )?hand\b|put[^.。;；\n]{0,30}\b(?:back )?into (?:the )?hand\b/iu.test(text)) {
    additions.push("放回手牌 手札に戻す return to hand");
  }
  if (/(墓地|送墓|graveyard)/iu.test(text)) additions.push("墓地 送去墓地 graveyard");
  if (/(除外|banish)/iu.test(text)) additions.push("除外 banish");
  if (/(破坏|破壊|destroy)/iu.test(text)) additions.push("破坏 破壊 destroy");
  if (/(攻击|攻擊|攻撃|attack)/iu.test(text)) additions.push("攻击 攻撃 attack 战斗 バトル");
  if (/(次数|回数|多次|两次|兩次|[一二三四五六七八九十\d]+次|twice)/iu.test(text)) additions.push("次数 回数 多次 twice");
  if (/(不受.{0,12}(?:效果|効果).{0,6}影响|効果を受けない|unaffected)/iu.test(text)) additions.push("不受效果影响 効果を受けない unaffected by card effects");
  if (/(攻击|攻擊|攻撃|attack).{0,12}(?:无效|無效|negat)|(?:无效|無效|negat).{0,12}(?:攻击|攻擊|攻撃|attack)/iu.test(text)) additions.push("攻击无效 攻撃を無効 negate the attack");
  if (/(代替.{0,8}破坏|代替.{0,8}破壊|破壊.{0,8}代わり|replacement)/iu.test(text)) additions.push("代替破坏 破壊の代わり replacement destruction");
  if (/(伤害步骤结束|傷害步驟結束|ダメージステップ終了|end of (?:the )?damage step)/iu.test(text)) additions.push("伤害步骤结束时 ダメージステップ終了時 end of the damage step");
  if (/(伤害计算后|傷害計算後|ダメージ計算後|after damage calculation)/iu.test(text)) additions.push("伤害计算后 ダメージ計算後 after damage calculation");
  return [...new Set([text, ...additions].filter(Boolean))].join(" ");
}

function buildContextTerms({ userQuery, mentionQueries = [], ruleQueries = [], resolvedCards = [] } = {}) {
  return [...new Set([
    ...String(userQuery || "").split(/[，,。.!！?？;；、\s]+/u),
    ...mentionQueries,
    ...ruleQueries.flatMap((item) => [item.query, item.reason]),
    ...(resolvedCards || []).flatMap((card) => [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]),
  ]
    .map((item) => String(item || "").trim())
    .filter((item) => normalizeCardKey(item).length >= 2))]
    .slice(0, 80);
}

function attachContextSnippet(record, terms = []) {
  const text = String(record?.text || "");
  const isRulebook = evidenceTypeForRecord(record, "") === "rulebook";
  if (!isRulebook && text.length <= 2200) return record;
  if (!isRulebook && !/^contents\s+menu/iu.test(text)) return record;
  const snippet = selectContextSnippet(text, terms, 2200);
  return snippet && snippet !== text ? { ...record, text: snippet, contextSnippet: true } : record;
}

function selectContextSnippet(text, terms = [], maxChars = 2200) {
  const paragraphs = String(text || "")
    .split(/\n{2,}/u)
    .map((item) => item.trim())
    .filter((item) => item && !isNavigationParagraph(item));
  if (!paragraphs.length) return "";
  const normalizedTerms = terms.map(normalizeCardKey).filter((item) => item.length >= 2);
  let bestIndex = -1;
  let bestScore = 0;
  paragraphs.forEach((paragraph, index) => {
    const key = normalizeCardKey(paragraph);
    let score = 0;
    for (const term of normalizedTerms) {
      if (!term) continue;
      if (key.includes(term)) score += Math.min(8, Math.max(1, term.length / 2));
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  if (bestIndex < 0 || bestScore <= 0) return joinParagraphsToLimit(paragraphs, maxChars);

  const selected = [];
  for (let index = Math.max(0, bestIndex - 1); index < paragraphs.length; index += 1) {
    if (index > bestIndex + 10 && selected.join("\n\n").length > maxChars * 0.65) break;
    selected.push(paragraphs[index]);
    if (selected.join("\n\n").length >= maxChars) break;
  }
  const snippet = selected.join("\n\n");
  return snippet.length > maxChars ? `${snippet.slice(0, maxChars - 1)}…` : snippet;
}

function isNavigationParagraph(value) {
  const text = String(value || "").trim();
  if (/^(?:contents|menu|skip to content|toggle .*|expand|light mode|dark mode|auto light.*|hide navigation.*|hide table.*|back to top|view this page|ocg rule)$/iu.test(text)) return true;
  if (text.length < 120 && /(toggle|navigation sidebar|table of contents|规则修订|toggle navigation)/iu.test(text)) return true;
  return false;
}

function joinParagraphsToLimit(paragraphs, maxChars) {
  const selected = [];
  for (const paragraph of paragraphs) {
    selected.push(paragraph);
    if (selected.join("\n\n").length >= maxChars) break;
  }
  const text = selected.join("\n\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function tokenize(value) {
  const base = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}①②③④⑤⑥⑦⑧⑨]+/u)
    .map(normalizeCardKey)
    .filter((item) => item.length >= 2)
    .slice(0, 30);
  const grams = [];
  for (const item of base) {
    if (/[\u3400-\u9fff]/u.test(item) && item.length > 4) {
      for (let index = 0; index < item.length - 1; index += 1) grams.push(item.slice(index, index + 2));
    }
  }
  return [...new Set([...base, ...grams])].slice(0, 60);
}

function normalizeCardIdentityId(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return /^\d+$/u.test(text) ? text.replace(/^0+(?=\d)/u, "") : text;
}

function extractInlineCardIds(value) {
  return [...String(value || "").matchAll(/<<\s*(\d{1,10})\s*>>/gu)]
    .map((match) => match[1]);
}

function collectParentheticalAliasMentionKeys(unresolvedMentions, resolvedCards) {
  const reliableIdentityKeys = new Set();
  for (const card of resolvedCards || []) {
    const confidence = card?.confidence === undefined ? 1 : Number(card.confidence);
    if (!Number.isFinite(confidence) || confidence < 0.9) continue;
    for (const value of [card.input, card.name, card.cnName, card.jaName, card.jpName, card.enName, ...(card.aliases || [])]) {
      const key = normalizeCardKey(value);
      if (key) reliableIdentityKeys.add(key);
    }
  }
  const coveredKeys = new Set();
  for (const mention of unresolvedMentions || []) {
    const input = String(mention?.input || "").trim();
    const match = input.match(/^(.+?)[（(]([^（）()]+)[）)]$/u);
    if (!match) continue;
    const innerKey = normalizeCardKey(match[2]);
    if (!innerKey || !reliableIdentityKeys.has(innerKey)) continue;
    coveredKeys.add(normalizeCardKey(input));
    coveredKeys.add(normalizeCardKey(match[1]));
  }
  return coveredKeys;
}

function resolveUnresolvedMentionCards(unresolvedMentions, cardProvider, limits, warnings) {
  const result = [];
  const minConfidence = readPositiveDecimal(limits.localFuzzyMinConfidence, 0.74);
  for (const mention of unresolvedMentions || []) {
    if (result.length >= limits.maxCards) break;
    // An unresolved explicit No./CNo. identity may have several forms sharing
    // the same number. A generic local fuzzy match must not pick one of them;
    // leave the surface unresolved for exact external identity lookup instead.
    if (extractNumberedCardIdentities(mention?.input).length) continue;
    for (const query of mentionSearchQueries(mention)) {
      const matches = cardProvider.searchCardByName(query, 2);
      if (!matches.length) continue;
      const best = matches[0];
      if (best.confidence < minConfidence) {
        warnings.push(`unresolved_mention_fuzzy_low_confidence:${query}->${best.name}:${best.confidence}`);
        continue;
      }
      const queryMatchesUserSurface = normalizeCardKey(query) === normalizeCardKey(mention.input);
      if (!queryMatchesUserSurface && !providerPrimaryNameMechanicallyMatchesSurface(best, mention.input)) {
        warnings.push(`unresolved_mention_fuzzy_unanchored_expansion:${query}->${best.name}`);
        continue;
      }
      warnings.push(`unresolved_mention_fuzzy_match:${query}->${best.name}`);
      result.push({
        ...best,
        input: mention.input,
        matchedQuery: query,
        confidence: Math.min(best.confidence, 0.7),
        retrievalIdentityMatchKind: "local_fuzzy",
      });
      break;
    }
  }
  return dedupeCards(result);
}

async function resolveUnresolvedMentionCardsWithBaige(unresolvedMentions, {
  fetchImpl,
  env,
  limits,
  canonicalCards = [],
  warnings,
  debug,
  signal,
}) {
  throwIfAborted(signal);
  const mentions = (unresolvedMentions || []).slice(0, limits.maxCards);
  const minConfidence = readPositiveDecimal(env.RAG_BAIGE_MIN_CONFIDENCE, 0.72);
  const result = await Promise.all(mentions.map(async (mention) => {
    const modelExpansionQueries = modelIdentityExpansionQueries(mention);
    if (modelExpansionQueries.length) {
      const intersection = await resolveModelExpansionByStableCidIntersection({
        surface: mention.input,
        expansionQueries: modelExpansionQueries,
        fetchImpl,
        env,
        limits,
        warnings,
        debug,
        signal,
      });
      if (!intersection.card) {
        if (intersection.candidates.length > 1) {
          debug.ambiguousMentions.push({
            input: mention.input,
            reason: "conflicting_model_expansion_cid_intersection",
            source: "retrieval_identity_reconciliation",
            candidateCards: intersection.candidates.slice(0, 3).map((card) => ({
              id: card.id || card.cardId || "",
              cid: card.cid ?? null,
              name: card.name || card.cnName || card.jpName || card.enName || "",
              source: "baige_model_expansion_cid_intersection",
              confidence: card.confidence || 0,
            })),
          });
        }
        return null;
      }
      warnings.push(`baige_match:${intersection.matchedQuery}->${intersection.card.name}`);
      return {
        ...toRagCard(intersection.card, mention.input, Number(intersection.card.confidence || minConfidence)),
        matchedQuery: intersection.matchedQuery,
        externalSurfaceResolution: intersection.resolutionKind,
        externalSurfaceCompatible: true,
        externalIdentityUniqueConvergence: true,
        ...(intersection.usedExpansion ? { modelExpansionCidIntersectionVerified: true } : {}),
        originalSurfaceStableCids: intersection.originalSurfaceCids,
        modelExpansionExactCids: intersection.expansionCids,
      };
    }
    let bestLowConfidence = null;
    let bestLowConfidenceCandidates = [];
    let bestLowConfidenceQuery = "";
    let bestAmbiguousSelection = null;
    let bestAmbiguousQuery = "";
    for (const query of mentionSearchQueries(mention)) {
      const searchResult = await searchBaige(query, { fetchImpl, env, limits, debug, signal });
      warnings.push(...searchResult.warnings);
      const candidates = searchResult.results || [];
      if (!candidates.length) {
        warnings.push(`baige_no_result:${query}`);
        continue;
      }
      // Canonicalize every eligible external mirror before deciding whether
      // the user's surface converges to one identity. A model-generated search
      // expansion is never itself a surface anchor.
      const selection = selectUniqueBaigeCandidate(candidates, minConfidence, {
        canonicalCards,
        surface: mention.input,
        query,
      });
      const best = selection.card;
      const confidence = Number(best?.confidence || 0);
      if (best) {
        const queryMatchesUserSurface = normalizeCardKey(query) === normalizeCardKey(mention.input);
        const resolutionKind = selection.resolutionKind === "unique_exact_primary_name"
          && !queryMatchesUserSurface
          ? "canonical_expansion_exact_primary_name"
          : selection.resolutionKind || "confidence_margin";
        const externalSurfaceCompatible = selection.surfaceCompatible === true;
        const externalExpansionPrimaryNameAnchored = resolutionKind === "canonical_expansion_exact_primary_name"
          && externalSurfaceCompatible;
        const modelExpansionPendingIdentityReconciliation = resolutionKind === "canonical_expansion_exact_primary_name"
          && mention.source === "model_card_name_extractor"
          && mention.reason === "model_candidate_not_found";
        if (resolutionKind === "canonical_expansion_exact_primary_name"
            && !externalExpansionPrimaryNameAnchored
            && !modelExpansionPendingIdentityReconciliation) {
          warnings.push(`baige_unanchored_canonical_expansion:${query}->${best.name}`);
          continue;
        }
        if (modelExpansionPendingIdentityReconciliation && !externalExpansionPrimaryNameAnchored) {
          // The provider proves that the expanded canonical name exists, not
          // that the model mapped the user's surface correctly. Preserve it as
          // a candidate for the final admission gate, which still requires
          // original-surface compatibility, unique external identity
          // convergence and CID/passcode-backed local canonicalization before
          // any local evidence can be unlocked.
          warnings.push(`baige_model_expansion_pending_identity_reconciliation:${query}->${best.name}`);
        }
        warnings.push(`baige_match:${query}->${best.name}`);
        return {
          ...toRagCard(best, mention.input, confidence),
          matchedQuery: query,
          externalSurfaceResolution: resolutionKind,
          externalSurfaceCompatible,
          externalIdentityUniqueConvergence: selection.canonicalIdentityUniqueConvergence === true,
          externalExpansionPrimaryNameAnchored,
          modelExpansionPendingIdentityReconciliation,
        };
      }
      if (selection.incompatibleCandidates?.length) {
        const isModelExpansion = normalizeCardKey(query) !== normalizeCardKey(mention.input)
          && mention.source === "model_card_name_extractor"
          && mention.reason === "model_candidate_not_found";
        if (isModelExpansion) {
          warnings.push(`baige_model_expansion_pending_identity_reconciliation:${query}->${selection.incompatibleCandidates[0]?.name || "candidate"}`);
          warnings.push(`baige_model_expansion_stable_identity_unverified:${query}->${selection.incompatibleCandidates[0]?.name || "candidate"}`);
        }
        warnings.push(`baige_unanchored_canonical_expansion:${query}->${selection.incompatibleCandidates[0]?.name || "candidate"}`);
      }
      if (selection.ambiguous) {
        const ambiguousConfidence = Number(selection.candidates[0]?.confidence || 0);
        if (!bestAmbiguousSelection
            || ambiguousConfidence > Number(bestAmbiguousSelection.candidates[0]?.confidence || 0)) {
          bestAmbiguousSelection = selection;
          bestAmbiguousQuery = query;
        }
        // A model-supplied canonical spelling may be less ambiguous than the
        // user's nickname. Try every bounded search expansion before failing.
        continue;
      }
      const lowConfidenceBest = candidates[0];
      const lowConfidence = Number(lowConfidenceBest?.confidence || 0);
      if (!bestLowConfidence || lowConfidence > Number(bestLowConfidence.confidence || 0)) {
        bestLowConfidence = lowConfidenceBest;
        bestLowConfidenceCandidates = candidates.slice(0, 3);
        bestLowConfidenceQuery = query;
      }
    }
    if (bestAmbiguousSelection) {
      debug.ambiguousMentions.push({
        input: mention.input,
        reason: "conflicting_baige_card_identity",
        candidateCards: bestAmbiguousSelection.candidates.slice(0, 3).map((card) => ({
          id: card.id || card.cardId || "",
          cid: card.cid ?? null,
          name: card.name || card.cnName || card.jpName || card.enName || "",
          source: "baige",
          confidence: card.confidence || 0,
          matchedQuery: bestAmbiguousQuery,
        })),
      });
      warnings.push(`baige_ambiguous:${mention.input}`);
    } else if (bestLowConfidence) {
      debug.ambiguousMentions.push({
        input: mention.input,
        candidateCards: bestLowConfidenceCandidates.map((card) => ({
          id: card.id || card.cardId || "",
          name: card.name || card.cnName || card.jpName || card.enName || "",
          source: "baige",
          confidence: card.confidence || 0,
          matchedQuery: bestLowConfidenceQuery,
        })),
      });
      warnings.push(`baige_ambiguous:${mention.input}`);
    }
    return null;
  }));
  return dedupeCards(result.filter(Boolean)).slice(0, limits.maxCards);
}

function mentionSearchQueries(mention) {
  const queries = [
    mention?.input,
    ...(Array.isArray(mention?.searchTexts) ? mention.searchTexts : []),
    ...(Array.isArray(mention?.alternatives) ? mention.alternatives : []),
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return dedupeBy(queries, normalizeCardKey).slice(0, 3);
}

function modelIdentityExpansionQueries(value = {}) {
  const explicitlyModelDerived = value.reason === "model_candidate_not_found";
  const supplied = Array.isArray(value.identityVerificationSearchTexts)
    ? value.identityVerificationSearchTexts
    : explicitlyModelDerived && Array.isArray(value.searchTexts)
      ? value.searchTexts
      : [];
  const surfaceKey = normalizeCardKey(value.input);
  return dedupeBy(supplied
    .map((item) => String(item || "").trim())
    .filter((item) => item && normalizeCardKey(item) !== surfaceKey), normalizeCardKey)
    .slice(0, 3);
}

async function resolveModelExpansionByStableCidIntersection({
  surface,
  expansionQueries,
  fetchImpl,
  env,
  limits,
  warnings,
  debug,
  signal,
}) {
  const originalSearch = await searchBaige(surface, { fetchImpl, env, limits, debug, signal });
  warnings.push(...originalSearch.warnings);
  const originalResults = originalSearch.results || [];
  const originalEligibleResults = originalResults.filter((candidate) => (
    Number(candidate?.confidence || 0) >= 0.72
      && providerPrimaryNameMechanicallyMatchesSurface(candidate, surface)
  ));
  const originalCandidatesByCid = stableExternalCidCandidates(originalEligibleResults);
  const originalSelection = selectUniqueBaigeCandidate(originalResults, 0.72, {
    surface,
    query: surface,
  });
  const originalSurfaceCids = [...originalCandidatesByCid.keys()].sort();
  if (originalSelection.card) {
    return {
      card: originalSelection.card,
      matchedQuery: surface,
      resolutionKind: originalSelection.resolutionKind || "single_eligible_identity",
      usedExpansion: false,
      originalSurfaceCids,
      expansionCids: [],
      candidates: originalSelection.candidates || [originalSelection.card],
    };
  }

  // A canonical/model expansion may confirm or disambiguate identities already
  // returned for the user's original surface, but it must never create an
  // identity when that surface produced no stable CID at all.
  if (!originalCandidatesByCid.size) {
    warnings.push(`baige_model_expansion_stable_identity_unverified:${surface}->${expansionQueries[0] || "candidate"}`);
    warnings.push(`baige_model_expansion_original_surface_has_no_stable_identity:${surface}`);
    return {
      card: null,
      matchedQuery: "",
      resolutionKind: "",
      usedExpansion: false,
      originalSurfaceCids,
      expansionCids: [],
      candidates: originalSelection.candidates || [],
    };
  }

  // A model expansion may confirm one mechanically compatible identity, but it
  // must not choose between multiple identities returned for the user's own
  // surface. Otherwise the model-generated name would become the deciding
  // identity fact and could unlock the wrong card text and card-scoped Q&A.
  if (originalCandidatesByCid.size > 1) {
    warnings.push(`baige_model_expansion_stable_identity_unverified:${surface}->${expansionQueries[0] || "candidate"}`);
    warnings.push(
      `baige_model_expansion_original_surface_identity_ambiguous:${surface}:${originalSurfaceCids.join(",")}`,
    );
    return {
      card: null,
      matchedQuery: "",
      resolutionKind: "",
      usedExpansion: false,
      originalSurfaceCids,
      expansionCids: [],
      candidates: originalSelection.candidates || originalEligibleResults,
    };
  }

  const expansionCandidatesByCid = new Map();
  const matchedQueryByCid = new Map();

  for (const query of expansionQueries) {
    const searchResult = await searchBaige(query, { fetchImpl, env, limits, debug, signal });
    warnings.push(...searchResult.warnings);
    for (const candidate of searchResult.results || []) {
      if (!providerPrimaryNameExactlyMatches(candidate, query)) continue;
      const cid = verifiedExternalCardCid(candidate);
      if (!cid) continue;
      const previous = expansionCandidatesByCid.get(cid);
      if (!previous || Number(candidate.confidence || 0) > Number(previous.confidence || 0)) {
        expansionCandidatesByCid.set(cid, candidate);
        matchedQueryByCid.set(cid, query);
      }
    }
  }

  const expansionCids = [...expansionCandidatesByCid.keys()].sort();
  const intersectingCids = expansionCids.filter((cid) => originalCandidatesByCid.has(cid));
  if (intersectingCids.length !== 1) {
    warnings.push(`baige_model_expansion_stable_identity_unverified:${surface}->${expansionQueries[0] || "candidate"}`);
    warnings.push(
      intersectingCids.length
        ? `baige_model_expansion_cid_intersection_ambiguous:${surface}:${intersectingCids.join(",")}`
        : `baige_model_expansion_cid_intersection_empty:${surface}`,
    );
    return {
      card: null,
      matchedQuery: "",
      resolutionKind: "",
      usedExpansion: true,
      originalSurfaceCids,
      expansionCids,
      candidates: intersectingCids.map((cid) => expansionCandidatesByCid.get(cid)).filter(Boolean),
    };
  }

  const cid = intersectingCids[0];
  warnings.push(`baige_model_expansion_cid_intersection_verified:${surface}:${cid}`);
  return {
    card: expansionCandidatesByCid.get(cid),
    matchedQuery: matchedQueryByCid.get(cid) || expansionQueries[0],
    resolutionKind: "model_expansion_exact_cid_intersection",
    usedExpansion: true,
    originalSurfaceCids,
    expansionCids,
    candidates: [expansionCandidatesByCid.get(cid)].filter(Boolean),
  };
}

function stableExternalCidCandidates(candidates) {
  const byCid = new Map();
  for (const candidate of candidates || []) {
    const cid = verifiedExternalCardCid(candidate);
    if (!cid) continue;
    const previous = byCid.get(cid);
    if (!previous || Number(candidate.confidence || 0) > Number(previous.confidence || 0)) {
      byCid.set(cid, candidate);
    }
  }
  return byCid;
}

function uniqueOriginalSurfaceCidMatchingLocalIdentity(candidates, localCard) {
  const candidatesByCid = stableExternalCidCandidates(candidates);
  if (candidatesByCid.size !== 1) return null;
  const candidate = [...candidatesByCid.values()][0];
  return sameStableCardIdentity(localCard, candidate) ? candidate : null;
}

function providerPrimaryNameExactlyMatches(card = {}, query = "") {
  const queryKey = normalizeCardKey(query);
  return Boolean(queryKey) && (card.providerPrimaryNames || [])
    .some((name) => normalizeCardKey(name) === queryKey);
}

async function enrichCardsWithBaige(cards, {
  fetchImpl,
  env,
  limits,
  canonicalCards = [],
  warnings,
  debug,
  signal,
}) {
  throwIfAborted(signal);
  const sourceCards = (cards || []).slice(0, limits.maxCards);
  const result = await Promise.all(sourceCards.map(async (card) => {
    const needsNumberedIdentityEnrichment = card.numberedIdentityNameMismatch === true;
    const needsSurfaceIdentityVerification = !needsNumberedIdentityEnrichment
      && cardInputNeedsIdentityVerification(card);
    if (!needsNumberedIdentityEnrichment && !needsSurfaceIdentityVerification
      && hasUsableCardText(card) && (card.id || card.cardId)) {
      return card;
    }
    const nameQuery = needsNumberedIdentityEnrichment || needsSurfaceIdentityVerification
      ? card.numberedIdentityInput || card.input || card.name
      : card.name || card.cnName || card.jaName || card.enName || card.input;
    if (!nameQuery) {
      return card;
    }
    const modelExpansionQueries = needsSurfaceIdentityVerification
      ? modelIdentityExpansionQueries(card)
      : [];
    let selection = { card: null, ambiguous: false, candidates: [] };
    let best = null;
    let matchedQuery = nameQuery;
    let externalSurfaceResolution = "";
    let verifiedByCanonicalLookup = false;
    let verifiedByModelCidIntersection = false;
    if (modelExpansionQueries.length) {
      const intersection = await resolveModelExpansionByStableCidIntersection({
        surface: card.input || nameQuery,
        expansionQueries: modelExpansionQueries,
        fetchImpl,
        env,
        limits,
        warnings,
        debug,
        signal,
      });
      if (!intersection.card) {
        return { ...card, identityVerificationStatus: "unverified" };
      }
      best = intersection.card;
      matchedQuery = intersection.matchedQuery || modelExpansionQueries[0];
      externalSurfaceResolution = intersection.resolutionKind;
      verifiedByModelCidIntersection = intersection.usedExpansion === true;
    } else {
      const searchResult = await searchBaige(nameQuery, { fetchImpl, env, limits, debug, signal });
      warnings.push(...searchResult.warnings);
      selection = selectUniqueBaigeCandidate(searchResult.results || [], 0.72, {
        canonicalCards,
        surface: card.input || nameQuery,
        query: nameQuery,
      });
      best = selection.card;
      if (!best && !selection.ambiguous && needsSurfaceIdentityVerification) {
        const stableIdentityMatch = uniqueOriginalSurfaceCidMatchingLocalIdentity(
          searchResult.results || [],
          card,
        );
        if (stableIdentityMatch) {
          best = stableIdentityMatch;
          externalSurfaceResolution = "unique_original_surface_cid_matches_local_identity";
          warnings.push(
            `local_approximate_identity_verified_via_original_surface_cid:${card.input}:${verifiedExternalCardCid(best)}`,
          );
        }
      }
    }
    if (!best && !selection.ambiguous && needsSurfaceIdentityVerification) {
      const canonicalLookup = await verifySurfaceIdentityThroughCanonicalBaigeLookup(card, {
        primaryQuery: nameQuery,
        fetchImpl,
        env,
        limits,
        canonicalCards,
        warnings,
        debug,
        signal,
      });
      best = canonicalLookup.card;
      matchedQuery = canonicalLookup.matchedQuery || nameQuery;
      verifiedByCanonicalLookup = Boolean(best);
      if (canonicalLookup.ambiguous) {
        debug.ambiguousMentions.push({
          input: card.input || nameQuery,
          reason: "conflicting_baige_card_identity",
          candidateCards: canonicalLookup.candidates.slice(0, 3).map((candidate) => ({
            id: candidate.id || candidate.cardId || "",
            cid: candidate.cid ?? null,
            name: candidate.name || candidate.cnName || candidate.jpName || candidate.enName || "",
            source: "baige_canonical_identity_lookup",
            confidence: candidate.confidence || 0,
            matchedQuery: canonicalLookup.matchedQuery || "",
          })),
        });
      }
    }
    if (!best) {
      if (selection.ambiguous) {
        debug.ambiguousMentions.push({
          input: card.input || nameQuery,
          reason: "conflicting_baige_card_identity",
          candidateCards: selection.candidates.slice(0, 3).map((candidate) => ({
            id: candidate.id || candidate.cardId || "",
            cid: candidate.cid ?? null,
            name: candidate.name || candidate.cnName || candidate.jpName || candidate.enName || "",
            source: "baige",
            confidence: candidate.confidence || 0,
            matchedQuery: nameQuery,
          })),
        });
      }
      return needsSurfaceIdentityVerification
        ? { ...card, identityVerificationStatus: "unverified" }
        : card;
    }
    if (needsNumberedIdentityEnrichment) {
      warnings.push(`numbered_identity_baige_enriched:${nameQuery}->${best.name}`);
    }
    const externalCard = {
      ...toRagCard(best, card.input || nameQuery, Number(best.confidence || 0)),
      matchedQuery,
      ...(externalSurfaceResolution ? {
        externalSurfaceResolution,
        externalSurfaceCompatible: true,
        externalIdentityUniqueConvergence: true,
      } : {}),
      ...(verifiedByModelCidIntersection ? {
        modelExpansionCidIntersectionVerified: true,
      } : {}),
    };
    if (verifiedByCanonicalLookup) {
      warnings.push(`local_approximate_identity_verified_via_canonical_lookup:${card.input}:${matchedQuery}`);
      return {
        ...mergeCard(card, externalCard),
        identityVerificationStatus: "verified_same_identity",
        identityVerificationSource: "canonical_external_lookup",
      };
    }
    if (needsSurfaceIdentityVerification && !sameStableCardIdentity(card, externalCard)) {
      warnings.push(`local_approximate_identity_replaced:${card.input}:${card.name}->${externalCard.name}`);
      return ensureCardMentionAlias({
        ...externalCard,
        resolutionSource: card.resolutionSource || "external_identity_verification",
        identityVerificationStatus: "verified_external_replacement",
        identityVerificationSource: verifiedByModelCidIntersection
          ? "model_expansion_cid_intersection"
          : card.identityVerificationSource,
        replacedLocalCandidate: summarizeIdentityCandidate(card),
      });
    }
    return {
      ...mergeCard(card, externalCard),
      identityVerificationStatus: needsSurfaceIdentityVerification
        ? "verified_same_identity"
        : card.identityVerificationStatus,
      ...(verifiedByModelCidIntersection
        ? { identityVerificationSource: "model_expansion_cid_intersection" }
        : {}),
    };
  }));
  return result.filter(Boolean);
}

async function verifySurfaceIdentityThroughCanonicalBaigeLookup(card, {
  primaryQuery,
  fetchImpl,
  env,
  limits,
  canonicalCards = [],
  warnings,
  debug,
  signal,
}) {
  throwIfAborted(signal);
  for (const query of canonicalIdentityVerificationQueries(card, primaryQuery)) {
    const searchResult = await searchBaige(query, { fetchImpl, env, limits, debug, signal });
    warnings.push(...searchResult.warnings);
    const selection = selectUniqueBaigeCandidate(searchResult.results || [], 0.72, {
      canonicalCards,
      surface: card.input || primaryQuery,
    });
    if (selection.ambiguous) {
      warnings.push(`baige_canonical_identity_ambiguous:${card.input || primaryQuery}:${query}`);
      return {
        card: null,
        matchedQuery: query,
        ambiguous: true,
        candidates: selection.candidates,
      };
    }
    if (!selection.card) continue;

    if (!canonicalLookupVerifiesUserSurface(card, selection.card)) {
      warnings.push(`baige_canonical_identity_mismatch:${card.input || primaryQuery}:${query}`);
      continue;
    }
    return {
      card: selection.card,
      matchedQuery: query,
      ambiguous: false,
      candidates: selection.candidates,
    };
  }
  return { card: null, matchedQuery: "", ambiguous: false, candidates: [] };
}

function canonicalIdentityVerificationQueries(card = {}, primaryQuery = "") {
  const excludedKeys = new Set([
    normalizeCardKey(primaryQuery),
    normalizeCardKey(card.input),
    normalizeCardKey(card.matchedQuery),
  ].filter(Boolean));
  return dedupeBy([
    card.jaName,
    card.jpName,
    card.enName,
    card.name,
    card.cnName,
  ].map((value) => String(value || "").trim()).filter((value) => (
    value && !excludedKeys.has(normalizeCardKey(value))
  )), normalizeCardKey).slice(0, 3);
}

function canonicalLookupVerifiesUserSurface(localCard = {}, externalCard = {}) {
  const inputKey = normalizeCardKey(localCard.input || localCard.matchedQuery);
  if (!inputKey) return false;
  // This check must use only identity surfaces returned by the provider.
  // `toRagCard()` deliberately adds the user's mention as a display alias, so
  // validating after that conversion would make every lookup self-confirming.
  const explicitExternalNames = [
    externalCard.cnName,
    externalCard.jaName,
    externalCard.jpName,
    externalCard.enName,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (!explicitExternalNames.length) return false;
  const externalKeys = new Set([
    ...explicitExternalNames,
    ...(externalCard.aliases || []),
  ].map(normalizeCardKey).filter(Boolean));
  if (!externalKeys.has(inputKey)) return false;

  if (sameStableCardIdentity(localCard, externalCard)) return true;
  const localCanonicalKeys = new Set([
    localCard.name,
    localCard.cnName,
    localCard.jaName,
    localCard.jpName,
    localCard.enName,
  ].map(normalizeCardKey).filter(Boolean));
  return [...localCanonicalKeys].some((key) => externalKeys.has(key));
}

function cardInputNeedsIdentityVerification(card = {}) {
  const inputKey = normalizeCardKey(card.input);
  if (!inputKey || card.resolutionSource === "card_text_reference") return false;
  if (card.retrievalIdentityMatchKind === "local_fuzzy") return true;
  // Edit-distance candidates are hypotheses, even when a display alias has
  // already copied the user's surface. They must never self-verify through
  // that derived alias or through a confidence threshold.
  if (card.requiresExternalIdentityVerification === true || card.identityMatchKind === "edit_distance") {
    return true;
  }
  const canonicalKeys = [
    card.name,
    card.cnName,
    card.jaName,
    card.jpName,
    card.enName,
    ...(card.aliases || []),
  ].map(normalizeCardKey).filter(Boolean);
  if (canonicalKeys.some((key) => (
    key === inputKey
    || (Math.min(key.length, inputKey.length) >= 3 && (key.includes(inputKey) || inputKey.includes(key)))
  ))) return false;
  // The risky local path is an edit-distance correction: it can turn a valid
  // new/community name into a different existing card. Locale translations
  // and contextual nicknames are not edit corrections and remain offline.
  return Number(card.confidence || 0) >= 0.92
    && canonicalKeys.some((key) => boundedIdentityEditDistance(inputKey, key, 2) <= 2);
}

function boundedIdentityEditDistance(left, right, limit) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const value = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost,
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

function selectUniqueBaigeCandidate(candidates, minConfidence, {
  canonicalCards = [],
  surface = "",
  query = "",
} = {}) {
  const eligible = (candidates || [])
    .filter((candidate) => Number(candidate?.confidence || 0) >= minConfidence);
  if (!eligible.length) return { card: null, ambiguous: false, candidates: [] };
  // External providers can emit multiple localized mirrors for one card. Form
  // connected identity groups from every verified CID/passcode token, including
  // a unique local-card bridge when one mirror carries the CID and another only
  // carries the engine passcode. Names are fallback identities only when the
  // provider supplied no strong numeric identity at all.
  const identityGroups = [];
  for (const candidate of eligible) {
    const tokens = new Set(externalCardIdentityTokens(candidate, canonicalCards));
    const matches = identityGroups.filter((group) => (
      [...tokens].some((token) => group.tokens.has(token))
    ));
    if (!matches.length) {
      identityGroups.push({ candidates: [candidate], tokens });
      continue;
    }
    const target = matches[0];
    target.candidates.push(candidate);
    for (const token of tokens) target.tokens.add(token);
    for (const merged of matches.slice(1)) {
      target.candidates.push(...merged.candidates);
      for (const token of merged.tokens) target.tokens.add(token);
      identityGroups.splice(identityGroups.indexOf(merged), 1);
    }
  }
  const surfaceKey = normalizeCardKey(surface);
  const rawSurfaceQuery = Boolean(surfaceKey)
    && normalizeCardKey(query) === surfaceKey;
  const primaryExactGroups = surfaceKey
    ? identityGroups.filter((group) => group.candidates.some((candidate) => (
        (candidate.providerPrimaryNames || []).some((primaryName) => (
          normalizeCardKey(primaryName) === surfaceKey
        ))
      )))
    : [];
  const compatibleGroups = primaryExactGroups.length
    ? primaryExactGroups
    : rawSurfaceQuery
      // The provider scored the user's original surface itself. Admit that
      // result only through identity convergence: one canonical group passes,
      // while two eligible groups remain ambiguous regardless of score order.
      ? identityGroups
    : surface
      ? identityGroups.filter((group) => group.candidates.some((candidate) => (
          providerPrimaryNameMechanicallyMatchesSurface(candidate, surface)
        )))
      : identityGroups;
  const representative = (group) => [...group.candidates].sort((left, right) => (
    Number(right.confidence || 0) - Number(left.confidence || 0)
    || externalCardIdentityTokens(left).join("|").localeCompare(
      externalCardIdentityTokens(right).join("|"),
    )
    || normalizeCardKey(left.name).localeCompare(normalizeCardKey(right.name))
  ))[0];
  const incompatibleCandidates = identityGroups
    .filter((group) => !compatibleGroups.includes(group))
    .map(representative);
  const uniqueCandidates = compatibleGroups
    .map(representative)
    .sort((left, right) => (
      Number(right.confidence || 0) - Number(left.confidence || 0)
      || externalCardIdentityTokens(left).join("|").localeCompare(
        externalCardIdentityTokens(right).join("|"),
      )
    ));
  if (!uniqueCandidates.length) {
    return {
      card: null,
      ambiguous: false,
      candidates: [],
      incompatibleCandidates,
    };
  }
  if (uniqueCandidates.length === 1) {
    const convergedGroup = compatibleGroups[0];
    return {
      card: uniqueCandidates[0],
      ambiguous: false,
      candidates: uniqueCandidates,
      incompatibleCandidates,
      surfaceCompatible: true,
      canonicalIdentityUniqueConvergence: true,
      resolutionKind: convergedGroup.candidates.length > 1
        ? "canonical_identity_unique_surface_match"
        : String(uniqueCandidates[0].confidenceSource || "").includes("unique_exact_primary_name")
          ? "unique_exact_primary_name"
          : "single_eligible_identity",
    };
  }
  // A score margin is ranking evidence, not identity evidence. If two distinct
  // canonical identities remain compatible with the user's original surface,
  // fail closed regardless of provider order or confidence wording.
  return {
    card: null,
    ambiguous: true,
    candidates: uniqueCandidates,
    incompatibleCandidates,
    surfaceCompatible: true,
    canonicalIdentityUniqueConvergence: false,
  };
}

function externalCardIdentityTokens(card = {}, canonicalCards = []) {
  const localIdentityId = normalizeCardIdentityId(card.id || card.cardId);
  const passcode = verifiedEnginePasscode(card)
    || (/^[1-9]\d{4,9}$/u.test(localIdentityId)
      ? localIdentityId
      : "");
  const cid = verifiedExternalCardCid(card);
  const tokens = new Set([
    cid ? `cid:${cid}` : "",
    passcode ? `passcode:${passcode}` : "",
  ].filter(Boolean));
  if ((canonicalCards || []).length && (cid || passcode)) {
    const index = canonicalCardIdentityIndex(canonicalCards);
    const localCandidates = new Set([
      ...(cid ? index.byCid.get(cid) || [] : []),
      ...(passcode ? index.byPasscode.get(passcode) || [] : []),
    ]);
    if (localCandidates.size === 1) {
      const local = [...localCandidates][0];
      const localId = normalizeCardIdentityId(local.id || local.cardId);
      if (localId) tokens.add(`local:${localId}`);
    }
  }
  if (!tokens.size) {
    const nameKey = normalizeCardKey(card.name || card.cnName || card.jaName || card.enName);
    if (nameKey) tokens.add(`name:${nameKey}`);
  }
  return [...tokens].sort();
}

function providerPrimaryNameMechanicallyMatchesSurface(card = {}, input = "") {
  const inputKey = normalizeCardKey(input);
  if (!inputKey) return false;
  const stripNumberedPrefix = (value) => normalizeCardKey(value)
    .replace(/^(?:cno|no)\d{1,4}/u, "");
  return [
    ...(card.providerPrimaryNames || []),
    card.name,
    card.cnName,
    card.jaName,
    card.jpName,
    card.enName,
    ...(card.aliases || []),
  ]
    .filter(Boolean)
    .some((surfaceName) => {
      if (hasNumberedCardIdentityConflict(input, surfaceName)) return false;
      const surfaceKey = normalizeCardKey(surfaceName);
      if (!surfaceKey) return false;
      if (surfaceKey === inputKey) return true;
      if (inputKey.length >= 4
          && stripNumberedPrefix(surfaceName) === stripNumberedPrefix(input)) {
        return true;
      }
      // Permit a long provider surface wrapped in a small amount of extractor
      // context, but never let a short family fragment certify one card.
      const shorterLength = Math.min(surfaceKey.length, inputKey.length);
      const longerLength = Math.max(surfaceKey.length, inputKey.length);
      if (shorterLength >= 6
        && shorterLength / longerLength >= 0.6
        && (surfaceKey.includes(inputKey) || inputKey.includes(surfaceKey))) {
        return true;
      }
      // For long surfaces only, compare equal-length leading/trailing windows.
      // This admits a little extractor context plus a bounded translation edit
      // without turning a short family fragment into an identity anchor.
      const lengthGap = longerLength - shorterLength;
      if (shorterLength < 8 || lengthGap > 3 || shorterLength / longerLength < 0.75) {
        return false;
      }
      const shorter = surfaceKey.length <= inputKey.length ? surfaceKey : inputKey;
      const longer = surfaceKey.length > inputKey.length ? surfaceKey : inputKey;
      const editLimit = Math.min(3, Math.floor(shorterLength / 4));
      return [...new Set([
        longer.slice(0, shorterLength),
        longer.slice(-shorterLength),
      ])].some((window) => (
        boundedIdentityEditDistance(shorter, window, editLimit) <= editLimit
      ));
    });
}

function isAnchoredCanonicalExpansion(card = {}) {
  const cid = verifiedLocalCardCid(card);
  const surfaceAnchorVerified = (
    card.externalSurfaceResolution === "canonical_expansion_exact_primary_name"
      && card.externalExpansionPrimaryNameAnchored === true
  ) || (
    card.externalSurfaceResolution === "model_expansion_exact_cid_intersection"
      && card.modelExpansionCidIntersectionVerified === true
  );
  return surfaceAnchorVerified
    && card.identityCanonicalizationConflict !== true
    && Boolean(card.identityCanonicalizationSource)
    && Boolean(cid)
    && normalizeCardIdentityId(card.id || card.cardId) === cid;
}

function hasStableLocalIdentityCanonicalization(card = {}) {
  return ["cid", "passcode"].includes(String(card.identityCanonicalizationSource || ""))
    && Boolean(normalizeCardIdentityId(card.id || card.cardId));
}

function isLowConfidenceLocalFuzzy(card = {}) {
  const confidence = Number(card.confidence);
  return card.retrievalIdentityMatchKind === "local_fuzzy"
    && Number.isFinite(confidence)
    && confidence <= 0.7;
}

function suppressModelExpansionConflicts(localCards, baigeCards, warnings) {
  const surfaceVerified = (baigeCards || []).filter((card) => (
    Number(card.confidence || 0) >= 0.72
    && (
      normalizeCardKey(card.matchedQuery) === normalizeCardKey(card.input)
      || isAnchoredCanonicalExpansion(card)
    )
  ));
  if (!surfaceVerified.length) return localCards || [];
  return (localCards || []).filter((localCard) => {
    const conflict = surfaceVerified.find((verifiedCard) => (
      normalizeCardKey(verifiedCard.input) === normalizeCardKey(localCard.input)
      && !sameStableCardIdentity(verifiedCard, localCard)
      && (
        isAnchoredCanonicalExpansion(verifiedCard)
          ? isLowConfidenceLocalFuzzy(localCard)
          : normalizeCardKey(localCard.matchedQuery) !== normalizeCardKey(localCard.input)
            || Number(verifiedCard.confidence || 0) >= Number(localCard.confidence || 0) + 0.02
      )
    ));
    if (!conflict) return true;
    warnings.push(`model_expansion_conflict_suppressed:${localCard.input}:${localCard.name}->${conflict.name}`);
    return false;
  });
}

async function searchBaige(query, { fetchImpl, env, limits, debug, signal }) {
  const result = await searchCards(query, {
    fetchImpl,
    env,
    limit: Math.max(3, limits.maxCards),
    signal,
  });
  debug.searchCount += 1;
  if (result.cacheHit) debug.cacheHitCount += 1;
  debug.warnings.push(...(result.warnings || []));
  return result;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("request_aborted");
  error.name = "AbortError";
  error.code = "request_aborted";
  throw error;
}

function toRagCard(card, input, confidence) {
  return ensureCardMentionAlias({
    input,
    id: String(card.id || card.cardId || ""),
    cardId: String(card.cardId || card.id || ""),
    passcode: String(card.passcode || card.id || ""),
    cid: card.cid ?? null,
    name: card.name || card.cnName || card.jpName || card.enName || String(input || ""),
    cnName: card.cnName || "",
    jaName: card.jaName || card.jpName || "",
    jpName: card.jpName || card.jaName || "",
    enName: card.enName || "",
    cardType: card.cardType || card.type || "",
    type: card.type || card.cardType || "",
    attribute: card.attribute ?? "",
    race: card.race ?? "",
    atk: card.atk ?? null,
    def: card.def ?? null,
    level: card.level ?? null,
    rank: card.rank ?? null,
    link: card.link ?? null,
    effectText: card.effectText || card.text || "",
    text: card.text || card.effectText || "",
    source: "baige",
    sourceLabel: "百鸽",
    sourceUrl: card.sourceUrl || "",
    imageUrl: card.imageUrl || "",
    imageCandidates: card.imageCandidates || [],
    official: false,
    aliases: card.aliases || [card.name, card.cnName, card.jpName, card.enName].filter(Boolean),
    raw: card.raw || card,
    confidence,
  });
}

function mergeCard(localCard, baigeCard) {
  return {
    ...baigeCard,
    ...localCard,
    id: localCard.id || baigeCard.id,
    cardId: localCard.cardId || baigeCard.cardId,
    // Local card ids are KONAMI CIDs and some older normalization paths also
    // copied them into `passcode`. Only an explicit non-zero uint32 password
    // may cross the Legacy Lua boundary; otherwise prefer the Baige password.
    passcode: verifiedEnginePasscode(localCard) || verifiedEnginePasscode(baigeCard),
    cid: localCard.cid ?? baigeCard.cid ?? null,
    name: localCard.name || baigeCard.name,
    cnName: localCard.cnName || baigeCard.cnName,
    jaName: localCard.jaName || baigeCard.jaName,
    jpName: localCard.jpName || baigeCard.jpName,
    enName: localCard.enName || baigeCard.enName,
    cardType: localCard.cardType || baigeCard.cardType,
    type: localCard.type || baigeCard.type,
    attribute: hasValue(localCard.attribute) ? localCard.attribute : baigeCard.attribute,
    race: hasValue(localCard.race) ? localCard.race : baigeCard.race,
    atk: localCard.atk ?? baigeCard.atk,
    def: localCard.def ?? baigeCard.def,
    level: localCard.level ?? baigeCard.level,
    rank: localCard.rank ?? baigeCard.rank,
    link: localCard.link ?? baigeCard.link,
    effectText: localCard.effectText || baigeCard.effectText,
    text: localCard.text || localCard.effectText || baigeCard.text,
    source: localCard.source || baigeCard.source,
    sourceLabel: localCard.sourceLabel || baigeCard.sourceLabel,
    sourceUrl: localCard.sourceUrl || baigeCard.sourceUrl,
    imageUrl: localCard.imageUrl || baigeCard.imageUrl,
    imageCandidates: [...new Set([...(localCard.imageCandidates || []), ...(baigeCard.imageCandidates || [])])],
    aliases: [...new Set([...(localCard.aliases || []), ...(baigeCard.aliases || [])])],
    raw: localCard.raw || baigeCard.raw,
    official: localCard.official ?? baigeCard.official ?? false,
    confidence: Math.max(Number(localCard.confidence || 0), Number(baigeCard.confidence || 0)),
  };
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function unresolvedMentionsAfterRetrieval(mentions, cards) {
  return (mentions || [])
    .filter((mention) => !retrievedCardMatchesMention(mention, cards))
    .map((mention) => Object.fromEntries(
      Object.entries(mention || {}).filter(([, value]) => value !== undefined),
    ));
}

function retrievedCardMatchesMention(mention, cards) {
  const mentionKey = normalizeCardKey(mention?.input);
  if (!mentionKey) return false;
  return (cards || []).some((card) => {
    const identityText = [card.name, card.cnName, card.jaName, card.jpName, card.enName, ...(card.aliases || [])].filter(Boolean).join(" ");
    if (hasNumberedCardIdentityConflict(mention?.input, identityText)) return false;
    const inputKey = normalizeCardKey(card.input || card.matchedQuery);
    if (inputKey && inputKey === mentionKey) return true;
    const names = [card.name, card.cnName, card.jaName, card.jpName, card.enName, ...(card.aliases || [])]
      .map(normalizeCardKey)
      .filter(Boolean);
    return names.some((name) => name === mentionKey || (mentionKey.length >= 3 && (name.includes(mentionKey) || mentionKey.includes(name))));
  });
}

function hasUsableCardText(card) {
  return Boolean(String(card.effectText || card.text || "").trim());
}

function verifiedEnginePasscode(card = {}) {
  const cid = verifiedLocalCardCid(card);
  for (const value of [card.passcode, card.password]) {
    const passcode = normalizeCardPasscode(value);
    if (passcode !== null &&
        (!cid || BigInt(passcode) !== BigInt(cid))) return passcode;
  }
  return "";
}

function verifiedExternalCardCid(card = {}) {
  const normalized = normalizedDecimal(card.cid);
  return /^[1-9]\d{2,6}$/u.test(normalized) ? normalized : "";
}

function sameStableCardIdentity(left = {}, right = {}) {
  const leftId = normalizeCardIdentityId(left.id || left.cardId);
  const rightId = normalizeCardIdentityId(right.id || right.cardId);
  if (leftId && rightId && leftId === rightId) return true;

  const leftPasscode = verifiedEnginePasscode(left)
    || (/^[1-9]\d{4,9}$/u.test(leftId) ? leftId : "");
  const rightPasscode = verifiedEnginePasscode(right)
    || (/^[1-9]\d{4,9}$/u.test(rightId) ? rightId : "");
  if (leftPasscode && rightPasscode && leftPasscode === rightPasscode) return true;

  const leftCid = verifiedExternalCardCid(left) || verifiedLocalCardCid(left);
  const rightCid = verifiedExternalCardCid(right) || verifiedLocalCardCid(right);
  if (leftCid && rightCid && leftCid === rightCid) return true;
  return Boolean(
    (leftCid && rightId === leftCid)
    || (rightCid && leftId === rightCid),
  );
}

function stableCardIdentityKey(card = {}) {
  const id = normalizeCardIdentityId(card.id || card.cardId);
  const passcode = verifiedEnginePasscode(card);
  const cid = verifiedExternalCardCid(card) || verifiedLocalCardCid(card);
  return cid ? `cid:${cid}`
    : passcode ? `passcode:${passcode}`
      : id ? `id:${id}`
        : `name:${normalizeCardKey(card.name || card.cnName || card.jaName || card.enName || card.input)}`;
}

function mergeCardsByStableIdentity(cards) {
  const merged = [];
  for (const candidate of (cards || []).filter(Boolean)) {
    const index = merged.findIndex((existing) => sameStableCardIdentity(existing, candidate));
    if (index < 0) {
      merged.push(ensureCardMentionAlias(candidate));
      continue;
    }
    merged[index] = ensureCardMentionAlias(mergeCard(merged[index], candidate));
  }
  return merged;
}

function ensureCardMentionAlias(card = {}) {
  const input = String(card.input || "").trim();
  const requiresExternalVerification = card.requiresExternalIdentityVerification === true
    || card.identityMatchKind === "edit_distance";
  const verificationComplete = /^verified_/u.test(String(card.identityVerificationStatus || ""));
  const includeInput = card.identityVerificationStatus !== "unverified"
    && (!requiresExternalVerification || verificationComplete);
  return {
    ...card,
    aliases: cardIdentityNames(
      includeInput ? card : { ...card, input: "", matchedQuery: "" },
      includeInput && input ? { name: input } : null,
    ),
  };
}

export function reconcileRetrievedCardResolution({
  cardResolution = {},
  retrievedCards = [],
  remainingUnresolvedMentions = [],
  baigeAmbiguousMentions = [],
} = {}) {
  const candidates = mergeCardsByStableIdentity(retrievedCards).map(ensureCardMentionAlias);
  const externallyResolvedSurfaceKeys = new Set(candidates
    .filter((card) => (
      card.externalSurfaceResolution === "unique_exact_primary_name"
      || (
        card.externalSurfaceCompatible === true
        && card.externalIdentityUniqueConvergence === true
      )
    ))
    .map((card) => normalizeCardKey(card.input))
    .filter(Boolean));
  const ambiguousMentions = dedupeMentions([
    ...(cardResolution.ambiguousMentions || []).filter((mention) => (
      !externallyResolvedSurfaceKeys.has(normalizeCardKey(mention.input))
    )),
    ...(baigeAmbiguousMentions || []),
  ]);
  const ambiguousKeys = new Set(ambiguousMentions.map((item) => normalizeCardKey(item.input)).filter(Boolean));
  const conflictsBySurface = new Map();
  for (const card of candidates) {
    const surfaceKey = normalizeCardKey(card.input);
    if (!surfaceKey) continue;
    const cards = conflictsBySurface.get(surfaceKey) || [];
    cards.push(card);
    conflictsBySurface.set(surfaceKey, cards);
  }
  for (const [surfaceKey, cards] of conflictsBySurface.entries()) {
    const identities = new Set(cards.map(stableCardIdentityKey));
    if (identities.size <= 1) continue;
    ambiguousKeys.add(surfaceKey);
    ambiguousMentions.push({
      input: cards[0].input,
      reason: "conflicting_retrieved_card_identity",
      source: "retrieval_identity_reconciliation",
      candidateCards: cards.map(summarizeIdentityCandidate),
    });
  }

  const resolvedCards = candidates.filter((card) => !ambiguousKeys.has(normalizeCardKey(card.input)));
  const resolvedMentionKeys = new Set(resolvedCards
    .filter((card) => card.identityVerificationStatus !== "unverified")
    .map((card) => normalizeCardKey(card.input))
    .filter(Boolean));
  const unresolvedMentions = dedupeMentions([
    ...(remainingUnresolvedMentions || []),
    ...[...conflictsBySurface.entries()]
      .filter(([key, cards]) => ambiguousKeys.has(key) && new Set(cards.map(stableCardIdentityKey)).size > 1)
      .map(([, cards]) => ({
        input: cards[0].input,
        reason: "conflicting_retrieved_card_identity",
        source: "retrieval_identity_reconciliation",
      })),
  ]).filter((mention) => !resolvedMentionKeys.has(normalizeCardKey(mention.input)));

  return {
    ...cardResolution,
    resolvedCards,
    unresolvedMentions,
    ambiguousMentions: dedupeMentions(ambiguousMentions),
    omittedResolvedCards: cardResolution.omittedResolvedCards || [],
    userProvidedCardTexts: cardResolution.userProvidedCardTexts || [],
    modelCardNameCandidates: cardResolution.modelCardNameCandidates || [],
  };
}

function dedupeMentions(items) {
  return dedupeBy((items || []).filter((item) => normalizeCardKey(item?.input)), (item) => (
    `${normalizeCardKey(item.input)}:${String(item.reason || "")}`
  ));
}

function verifiedLocalCardCid(card = {}) {
  const sourceUrlCid = String(card.sourceUrl || card.ygoResourcesUrl || "")
    .match(/\/data\/card\/(\d{1,7})(?:$|[/?#])/u)?.[1];
  for (const value of [card.cid, sourceUrlCid, card.id, card.cardId]) {
    const normalized = normalizedDecimal(value);
    // KONAMI database CIDs in the synchronized corpus are short identifiers;
    // Values outside the synchronized short-CID range must never be
    // reinterpreted as a CID merely because they are decimal strings.
    if (/^[1-9]\d{2,6}$/u.test(normalized)) return normalized;
  }
  return "";
}

function normalizedDecimal(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/u.test(text) ? String(Number(text)) : "";
}

function normalizeUserProvidedCardTexts(items, limits) {
  return dedupeBy((items || [])
    .map((item) => ({
      name: String(item?.name || "").trim(),
      text: String(item?.text || "").trim(),
      source: "user_provided_text",
      official: false,
    }))
    .filter((item) => item.name && item.text)
    .slice(0, limits.maxCards), (item) => normalizeCardKey(item.name));
}

function dedupeCards(cards) {
  return dedupeBy((cards || []).filter(Boolean), stableCardIdentityKey);
}

function dedupeEvidence(items) {
  return dedupeBy(items.filter((item) => item.id && item.text), (item) => `${item.type}:${stableRecordKey(item)}`);
}

function stableRecordKey(record = {}) {
  return String(record.id || record.evidenceId || record.stableId || "")
    .replace(/@[a-f0-9]{8,}(?=#|$)/iu, "");
}

function dedupeBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function readRetrievalLimits(env, maxPerBucket) {
  return {
    maxCards: readPositiveNumber(env.RAG_MAX_CARDS, 6),
    maxOfficialQa: readPositiveNumber(env.RAG_MAX_OFFICIAL_QA, maxPerBucket),
    maxRelatedEvidence: readPositiveNumber(env.RAG_MAX_RELATED_EVIDENCE, Math.max(14, maxPerBucket)),
    maxRuleSearchQueries: readPositiveNumber(env.RAG_MAX_RULE_SEARCH_QUERIES, 16),
    maxRulebookCandidates: readPositiveNumber(env.RAG_MAX_RULEBOOK_CANDIDATES, 24),
    maxRulebookPassageChars: readPositiveNumber(env.RAG_MAX_RULEBOOK_PASSAGE_CHARS, 2200),
    maxCardTextChars: readPositiveNumber(env.RAG_MAX_CARD_TEXT_CHARS, 3200),
    maxEvidenceTextChars: readPositiveNumber(env.RAG_MAX_EVIDENCE_TEXT_CHARS, 2800),
    localFuzzyMinConfidence: readPositiveDecimal(env.RAG_LOCAL_FUZZY_MIN_CONFIDENCE, 0.74),
  };
}

function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function readPositiveDecimal(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isEnabled(value) {
  return /^(?:1|true|yes|on)$/iu.test(String(value || "").trim());
}

function isDisabled(value) {
  return /^(?:0|false|no|off)$/iu.test(String(value || "").trim());
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function reserveIdentitySourceCoverage(items = [], limit = 1, resolvedCards = []) {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const selected = [];
  const selectedKeys = new Set();
  const representedCoverageKeys = new Set();
  const coverageKeysByRecord = new Map();
  const add = (item) => {
    const key = stableRecordKey(item?.record || item);
    if (!key || selectedKeys.has(key) || selected.length >= safeLimit) return false;
    selected.push(item);
    selectedKeys.add(key);
    for (const coverageKey of coverageKeysByRecord.get(key) || []) {
      representedCoverageKeys.add(coverageKey);
    }
    return true;
  };

  // Reserve records by the exact question-side identity combination plus each
  // strict planner/mechanism branch. Two records about the same card identity
  // are not interchangeable when they cover different strict branches.
  const resolvedIds = new Set();
  const identityTokenByResolvedId = new Map();
  const identityTokensByResolvedName = new Map();
  (resolvedCards || []).forEach((card, index) => {
    const id = normalizeCardIdentityId(card?.id || card?.cardId);
    const names = cardIdentityNames(card).map(normalizeCardKey).filter(Boolean);
    const fallbackName = names[0] || "";
    const token = id
      ? `id:${id}`
      : fallbackName
        ? `name:${fallbackName}:${index}`
        : "";
    if (!token) return;
    if (id) {
      resolvedIds.add(id);
      identityTokenByResolvedId.set(id, token);
    }
    for (const name of names) {
      const tokens = identityTokensByResolvedName.get(name) || new Set();
      tokens.add(token);
      identityTokensByResolvedName.set(name, tokens);
    }
  });
  const hasResolvedIdentity = identityTokenByResolvedId.size > 0
    || identityTokensByResolvedName.size > 0;
  const bestByCoverageKey = new Map();
  (items || []).forEach((item, index) => {
    const record = item?.record || item;
    const principalIds = [...principalQuestionCardIds(record)]
      .map(normalizeCardIdentityId)
      .filter(Boolean);
    const rawIds = [
      // Slot coverage must use question-side identities only. Source metadata
      // can establish provenance, but it must not make a one-card question look
      // like a multi-card premise and crowd out a genuine question-side match.
      ...relatedMatchedQuestionSideCardIds(item),
      ...principalIds,
    ]
      .map(normalizeCardIdentityId)
      .filter(Boolean);
    const identityTokens = new Set();
    for (const id of rawIds) {
      const token = identityTokenByResolvedId.get(id);
      if (token) identityTokens.add(token);
      else if (!hasResolvedIdentity) identityTokens.add(`id:${id}`);
    }
    for (const name of retrievalRankingIdentity(record).cardNames.map(normalizeCardKey).filter(Boolean)) {
      const resolvedTokens = identityTokensByResolvedName.get(name);
      if (resolvedTokens?.size === 1) identityTokens.add([...resolvedTokens][0]);
      else if (!hasResolvedIdentity) identityTokens.add(`name:${name}`);
    }
    const identities = [...identityTokens].sort();
    if (!identities.length) return;
    const identityCombination = identities.join("|");
    const strictQueryKeys = supplementalQueryKeysForItem(item, { strictOnly: true }).sort();
    // Query-branch coverage and question-premise coverage are independent.
    // A candidate that happens to match a strict planner branch must not lose
    // its own structured question premise: another record can match the same
    // branch while asking about a materially different restriction. Preserve
    // both dimensions inside the existing global evidence limit. Answer text
    // and broad record metadata never participate.
    const premiseKey = principalIds
      .filter((id) => !resolvedIds.has(id))
      .sort()
      .join("|") || "none";
    const coverageKeys = [
      `${identityCombination}::question-premise:${premiseKey}`,
      ...strictQueryKeys.map((branchKey) => `${identityCombination}::${branchKey}`),
    ];
    coverageKeysByRecord.set(stableRecordKey(record), coverageKeys);
    for (const coverageKey of coverageKeys) {
      if (!bestByCoverageKey.has(coverageKey)) {
        bestByCoverageKey.set(coverageKey, {
          item,
          index,
          identitySize: identities.length,
          strict: strictQueryKeys.length > 0,
        });
      }
    }
  });
  const coverageEntries = [...bestByCoverageKey.entries()]
    .sort((left, right) => (
      right[1].identitySize - left[1].identitySize
      || Number(right[1].strict) - Number(left[1].strict)
      || left[1].index - right[1].index
      || left[0].localeCompare(right[0])
    ));
  // When strict planner branches compete with several distinct official
  // premises inside a very small scoped budget, reserve one best strict
  // representative first. The remaining slots still follow premise/identity
  // coverage, so this does not restore the former fixed two-premise ceiling.
  const strictRepresentative = [...bestByCoverageKey.values()]
    .filter((entry) => entry.strict)
    .sort((left, right) => (
      right.identitySize - left.identitySize
      || left.index - right.index
      || stableRecordKey(left.item?.record || left.item)
        .localeCompare(stableRecordKey(right.item?.record || right.item))
    ))[0]?.item;
  if (strictRepresentative) add(strictRepresentative);
  for (const [coverageKey, { item }] of coverageEntries) {
    if (representedCoverageKeys.has(coverageKey)) continue;
    add(item);
  }
  for (const item of items || []) add(item);
  const remaining = (items || []).filter(
    (item) => !selectedKeys.has(stableRecordKey(item?.record || item)),
  );
  return [...selected, ...remaining];
}

function supplementalQueryKeysForItem(item, { strictOnly = false } = {}) {
  const record = item?.record || item;
  const signals = record?.retrievalSignals || {};
  const values = strictOnly
    ? [
        ...(signals.strictRuleQueryKeys || []),
        ...(signals.strictSupplementalRuleQueryKeys || []),
        // A complete official-question match that is both mechanism-anchored
        // and headline-anchored may represent its planner branch for bounded
        // coverage. It remains related-only and receives no authority upgrade.
        ...(signals.groundedQuestionBranchRuleQueryKeys || []),
      ]
    : [
        ...(signals.ruleQueryKeys || []),
        ...(signals.supplementalRuleQueryKeys || []),
      ];
  return [...new Set(Array.isArray(values) ? values : [])].filter(Boolean);
}

function supplementalQueryRankForItem(item, queryKey) {
  const record = item?.record || item;
  const signals = record?.retrievalSignals || {};
  const rank = Number(
    signals.ruleQueryRanks?.[queryKey]
      || signals.supplementalRuleQueryRanks?.[queryKey]
      || 0,
  );
  return rank > 0 ? rank : Number.POSITIVE_INFINITY;
}

function reserveSupplementalQueryCoverage(items = [], limit = 1, {
  queryKeys = [],
  strictOnly = false,
  fillRemaining = true,
} = {}) {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const orderedItems = dedupeBy(items || [], (item) => stableRecordKey(item?.record || item));
  const selected = [];
  const selectedKeys = new Set();
  const representedQueries = new Set();
  const add = (item) => {
    const key = stableRecordKey(item?.record || item);
    if (!key || selectedKeys.has(key) || selected.length >= safeLimit) return false;
    selected.push(item);
    selectedKeys.add(key);
    return true;
  };

  const requestedQueryKeys = [...new Set((queryKeys || []).filter(Boolean))];
  const orderedQueryKeys = requestedQueryKeys.length
    ? requestedQueryKeys
    : [...new Set(orderedItems.flatMap((item) => (
        supplementalQueryKeysForItem(item, { strictOnly })
      )))];

  // Select the best independently ranked candidate for each query in query
  // order. One record may cover several queries and then consumes one slot.
  // When there are more queries than slots, the explicit normalized query order
  // provides a deterministic finite policy instead of expanding the prompt.
  for (const queryKey of orderedQueryKeys) {
    if (representedQueries.has(queryKey)) continue;
    let item = null;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const candidate of orderedItems) {
      if (!supplementalQueryKeysForItem(candidate, { strictOnly }).includes(queryKey)) continue;
      const rank = supplementalQueryRankForItem(candidate, queryKey);
      if (item && rank >= bestRank) continue;
      item = candidate;
      bestRank = rank;
    }
    if (!item) continue;
    representedQueries.add(queryKey);
    // Pick each query's best candidate independently, then deduplicate. If the
    // same record is best for several queries it still consumes one slot.
    add(item);
  }
  if (!fillRemaining) return selected;

  for (const item of orderedItems) add(item);
  const remaining = orderedItems.filter(
    (item) => !selectedKeys.has(stableRecordKey(item?.record || item)),
  );
  return [...selected, ...remaining];
}

export function reserveRankedHeadAndSupplementalCoverage(items = [], limit = 1, {
  queryKeys = [],
  strictOnly = false,
  preserveStrictMechanismRepresentative = false,
} = {}) {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const orderedItems = dedupeBy(
    items || [],
    (item) => stableRecordKey(item?.record || item),
  );
  if (orderedItems.length <= 1) return orderedItems;

  const head = orderedItems[0];
  if (safeLimit === 1) return [head];
  // Inside the fixed four-slot cross-card budget, preserve the highest-ranked
  // strict mechanism result that did not enter through question-branch search.
  // Question-only candidates can otherwise occupy every slot before the two
  // retrieval paths are merged. The remaining slots keep the existing bounded
  // per-query coverage policy.
  const strictMechanismRepresentative = preserveStrictMechanismRepresentative
    && safeLimit === 4
    && strictOnly
    ? orderedItems.find((item) => {
        const signals = (item?.record || item)?.retrievalSignals || {};
        return signals.questionBranchSearch !== true
          && (signals.strictSupplementalRuleQueryKeys || []).length > 0;
      })
    : null;
  const representativeKey = strictMechanismRepresentative
    ? stableRecordKey(strictMechanismRepresentative?.record || strictMechanismRepresentative)
    : "";
  const representedByStrictMechanism = new Set(
    strictMechanismRepresentative
      ? supplementalQueryKeysForItem(strictMechanismRepresentative, { strictOnly: true })
      : [],
  );
  const remainingQueryKeys = (queryKeys || []).filter(
    (queryKey) => !representedByStrictMechanism.has(queryKey),
  );
  const coverageItems = representativeKey
    ? orderedItems.filter((item) => (
        stableRecordKey(item?.record || item) !== representativeKey
      ))
    : orderedItems;
  const queryReserved = reserveSupplementalQueryCoverage(
    coverageItems,
    safeLimit - Number(Boolean(strictMechanismRepresentative)),
    {
      queryKeys: remainingQueryKeys,
      strictOnly,
      fillRemaining: false,
    },
  );
  return dedupeBy([
    ...(strictMechanismRepresentative ? [strictMechanismRepresentative] : []),
    ...queryReserved,
    head,
    ...orderedItems,
  ], (item) => stableRecordKey(item?.record || item));
}

export function reserveUncoveredCrossCardBranches(items = [], limit = 1, {
  queryKeys = [],
  fillRemaining = false,
  rankedHeadCount = 1,
} = {}) {
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (!safeLimit) return [];
  const ordered = dedupeEvidence(items || []);
  // Preserve the authoritative retrieval head before reserving planner-branch
  // coverage. Planner labels are useful for diversity, but four such labels
  // must not collectively erase the highest-ranked official question.
  const safeRankedHeadCount = Math.min(
    safeLimit,
    Math.max(1, Math.floor(Number(rankedHeadCount) || 1)),
  );
  const selected = ordered.slice(0, safeRankedHeadCount);
  const selectedKeys = new Set(selected.map(stableRecordKey));
  const initiallyRepresentedQueryKeys = new Set(selected.flatMap((item) => (
    supplementalQueryKeysForItem(item, { strictOnly: true })
  )));
  const strictQueryKeys = queryKeys.filter((key) => !initiallyRepresentedQueryKeys.has(key));
  const strict = strictQueryKeys.length && selected.length < safeLimit
    ? reserveSupplementalQueryCoverage(
        ordered.filter((item) => !selectedKeys.has(stableRecordKey(item))),
        safeLimit - selected.length,
        {
          queryKeys: strictQueryKeys,
          strictOnly: true,
          fillRemaining: false,
        },
      ).slice(0, safeLimit - selected.length)
    : [];
  for (const item of strict) {
    if (selected.length >= safeLimit) break;
    const key = stableRecordKey(item);
    if (selectedKeys.has(key)) continue;
    selected.push(item);
    selectedKeys.add(key);
  }
  const representedQueryKeys = new Set(selected.flatMap((item) => (
    supplementalQueryKeysForItem(item, { strictOnly: false })
  )));
  const uncoveredQueryKeys = queryKeys.filter((key) => !representedQueryKeys.has(key));
  const branchRepresentatives = uncoveredQueryKeys.length && selected.length < safeLimit
    ? reserveSupplementalQueryCoverage(
        ordered.filter((item) => !selectedKeys.has(stableRecordKey(item))),
        safeLimit - selected.length,
        {
          queryKeys: uncoveredQueryKeys,
          strictOnly: false,
          fillRemaining: false,
        },
      )
    : [];
  for (const item of branchRepresentatives) {
    if (selected.length >= safeLimit) break;
    const key = stableRecordKey(item);
    if (selectedKeys.has(key)) continue;
    selected.push(item);
    selectedKeys.add(key);
  }
  // A question-only model assessment is not authority and cannot delete any
  // candidate, but a same/partial-premise assessment is useful bounded ranking
  // evidence. Preserve every such candidate that fits after strict branches so
  // one ordinary head cannot hide a second independently relevant premise.
  for (const item of ordered) {
    if (selected.length >= safeLimit) break;
    const key = stableRecordKey(item);
    if (selectedKeys.has(key) || !hasEligibleModelCandidateAssessment(item)) continue;
    selected.push(item);
    selectedKeys.add(key);
  }
  if (fillRemaining) {
    // When there is no scoped evidence at all, fill the bounded cross-card-only
    // result in authoritative rank order. In a mixed allocation, unassessed
    // padding would evict scoped sources without covering another query branch.
    for (const item of ordered) {
      if (selected.length >= safeLimit) break;
      const key = stableRecordKey(item);
      if (selectedKeys.has(key)) continue;
      selected.push(item);
      selectedKeys.add(key);
    }
  }
  return selected;
}

export function allocateOfficialRelatedEvidence({
  scopedCandidates = [],
  crossCardCandidates = [],
  limit = 1,
  resolvedCards = [],
  supplementalRuleQueryKeys = [],
} = {}) {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const rankedScoped = dedupeEvidence(scopedCandidates || []).sort((left, right) => (
    officialRelatedResolvedQuestionIdentityCount(right, resolvedCards)
      - officialRelatedResolvedQuestionIdentityCount(left, resolvedCards)
    || Number(officialRelatedSceneCompatible(right))
      - Number(officialRelatedSceneCompatible(left))
    || compareRetrievedRecords(left, right)
  ));
  const scoped = reserveIdentitySourceCoverage(rankedScoped, safeLimit, resolvedCards);
  const scopedKeys = new Set(scoped.map(stableRecordKey));
  const crossCard = dedupeEvidence(crossCardCandidates || [])
    .filter((item) => !scopedKeys.has(stableRecordKey(item)))
    .sort(compareRetrievedRecords);
  const maxCrossCard = Math.min(5, safeLimit);
  const selected = [];
  const selectedKeys = new Set();
  let selectedCrossCardCount = 0;
  const add = (item, { cross = false } = {}) => {
    const key = stableRecordKey(item);
    if (!key || selectedKeys.has(key) || selected.length >= safeLimit) return false;
    if (cross && selectedCrossCardCount >= maxCrossCard) return false;
    selected.push(item);
    selectedKeys.add(key);
    if (cross) selectedCrossCardCount += 1;
    return true;
  };
  const representedQueryKeys = ({ strictOnly = false } = {}) => new Set(
    selected.flatMap((item) => strictOnly
      ? supplementalQueryKeysForItem(item, { strictOnly: true })
      : [
          ...supplementalQueryKeysForItem(item, { strictOnly: false }),
          ...supplementalQueryKeysForItem(item, { strictOnly: true }),
        ]),
  );
  const addPerQueryCoverage = (candidates, {
    cross = false,
    strictOnly = false,
  } = {}) => {
    const remainingSlots = safeLimit - selected.length;
    const remainingCrossSlots = maxCrossCard - selectedCrossCardCount;
    const capacity = cross ? Math.min(remainingSlots, remainingCrossSlots) : remainingSlots;
    if (capacity <= 0) return;
    const represented = representedQueryKeys({ strictOnly });
    const uncoveredQueryKeys = supplementalRuleQueryKeys.filter(
      (queryKey) => !represented.has(queryKey),
    );
    if (!uncoveredQueryKeys.length) return;
    const coverage = reserveSupplementalQueryCoverage(
      candidates.filter((item) => !selectedKeys.has(stableRecordKey(item))),
      capacity,
      {
        queryKeys: uncoveredQueryKeys,
        strictOnly,
        fillRemaining: false,
      },
    );
    for (const item of coverage) add(item, { cross });
  };

  // Same-card/current-scene evidence is retained first: one ranked head plus
  // one strict representative for each decision-plan query it can cover.
  if (scoped.length) add(scoped[0]);
  addPerQueryCoverage(scoped, { strictOnly: true });

  // Cross-card analogies may enter only for query branches still uncovered by
  // strict scoped evidence, and retain the historical five-item ceiling.
  addPerQueryCoverage(crossCard, { cross: true, strictOnly: true });

  // If no strict candidate exists for a branch, retain the best bounded
  // question-branch candidate without letting it displace strict coverage.
  addPerQueryCoverage(scoped);
  addPerQueryCoverage(crossCard, { cross: true });

  // Preserve distinct scoped official-question premises before adding optional
  // analogy context. Evidence IDs remain the only deduplication boundary.
  for (const item of scoped) add(item);
  for (const item of crossCard) add(item, { cross: true });
  return selected;
}

function officialRelatedSceneCompatible(item = {}) {
  return item?.supportingQuestionBranchIdentityComplete === true
    || item?.supportingQuestionBranchScenarioPremiseCompatibility === "compatible"
    || item?.scenarioPremiseCompatibility === "compatible";
}

function officialRelatedResolvedQuestionIdentityCount(item = {}, resolvedCards = []) {
  const resolvedIds = new Set((resolvedCards || [])
    .map((card) => normalizeCardIdentityId(card?.id || card?.cardId))
    .filter(Boolean));
  const questionIds = new Set([
    ...relatedMatchedQuestionSideCardIds(item),
    ...retrievalRankingIdentity(item).cardIds,
  ].map(normalizeCardIdentityId).filter(Boolean));
  const matchedCount = [...questionIds].filter((id) => resolvedIds.has(id)).length;
  if (matchedCount) return matchedCount;
  return Number(recordSharesResolvedIdentity(item, resolvedCards));
}

async function readRequiredJsonSource(dataDir, name, arrayKeys) {
  let raw;
  try {
    raw = await readFile(join(dataDir, name));
  } catch (error) {
    throw unavailableRagDataError({
      phase: "raw_fallback",
      reason: error?.code === "ENOENT" ? "raw_source_missing" : "raw_source_unreadable",
      source: name,
    }, error);
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw unavailableRagDataError({
      phase: "raw_fallback",
      reason: "raw_source_json_invalid",
      source: name,
    }, error);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !arrayKeys.some((key) => Array.isArray(payload[key]))) {
    throw unavailableRagDataError({
      phase: "raw_fallback",
      reason: "raw_source_shape_invalid",
      source: name,
    });
  }
  return {
    payload,
    descriptor: createRagDataSourceDescriptor(name, raw),
  };
}

function unavailableRagDataError(details, cause) {
  return new RagDataUnavailableError({ details, cause });
}
