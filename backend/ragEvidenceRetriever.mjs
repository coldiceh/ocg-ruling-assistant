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
import { compileRuleScenario } from "./ruleScenarioCompiler.mjs";
import { retrieveLiveOfficialQa } from "./liveOfficialQaProvider.mjs";
import { analyzePrintedTextReferenceScenario } from "./printedTextReferences.mjs";
import { normalizeLegacyLuaPasscode } from "./legacyLuaSemanticPacket.mjs";
import { projectOfficialQaQuestion } from "./officialQaQuestionProjection.mjs";
import {
  bindTrustedRagDataRevision,
  createRagDataSourceDescriptor,
  RAG_DATA_REVISION_MANIFEST_FILE,
  validateRagDataRevisionManifest,
} from "./ragDataRevisionManifest.mjs";
import { loadRagRuntimeBundle } from "./ragRuntimeBundle.mjs";
import { normalizeRagSourceData as normalizeInjectedData } from "./ragRawDataNormalizer.mjs";
import {
  isRagRuntimeBundleRequired,
  RagDataUnavailableError,
} from "./ragDataAvailability.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = join(projectRoot, "data");
const dataCache = new Map();
const rawDataCache = new Map();
const evidenceRecordBucketsCache = new WeakMap();
const evidenceListCache = new WeakMap();
const retrievalRecordFeatureCache = new WeakMap();
const officialQaMechanismFeatureCache = new WeakMap();
const recordIdentityIndexCache = new WeakMap();
const canonicalCardIdentityIndexCache = new WeakMap();

export { normalizeInjectedData };

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
  enableLiveOfficialQa = false,
  subsumptionCandidatePoolComplete = false,
  maxPerBucket = 5,
  env = {},
  fetchImpl = globalThis.fetch,
} = {}) {
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
  const supplementalRuleQueries = normalizeRuleSearchQueries(ruleSearchQueries, limits);
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
      warnings: retrievalWarnings,
      debug: baigeDebug,
    }),
    resolveUnresolvedMentionCardsWithBaige(externalResolutionCandidates, { fetchImpl, env, limits, warnings: retrievalWarnings, debug: baigeDebug }),
  ]);
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
  const canonicalBaigeCards = canonicalBaigeCandidates.filter(
    (card) => card.identityCanonicalizationConflict !== true,
  );
  for (const conflict of canonicalBaigeCandidates.filter((card) => card.identityCanonicalizationConflict === true)) {
    baigeDebug.ambiguousMentions.push(identityConflictMention(conflict));
  }
  const verifiedLocalCards = suppressModelExpansionConflicts(
    enrichedLocalCards,
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
  const userProvidedCardTextEvidence = dedupeEvidence(providedTexts.map((item, index) => userProvidedTextEvidence(item, index, limits.maxCardTextChars, retrievalWarnings)));
  deterministicRuleQueries = mergeRuleSearchQueries(
    deterministicRuleQueries,
    deriveRuleSearchQueriesFromCardTexts(userQuery, cardTexts),
    limits,
  );
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
  const localOfficialMatches = searchOfficialQaEvidence({
    question: userQuery,
    records: scopedRecordBuckets.officialQa,
    resolvedCards: effectiveQaIdentityCards,
    // This is an in-memory discovery pass. Keep a wider scored pool until the
    // shared related-evidence allocator applies its fixed prompt budget below;
    // otherwise a decisive identity-linked QA can be lost merely because a
    // popular card has many higher-ranked but structurally repetitive entries.
    limit: effectiveQaIdentityCards.length
      ? Math.max(256, limits.maxRelatedEvidence * 24)
      : Math.max(20, limits.maxOfficialQa * 4),
    // The scoped bucket comes from the complete local QA snapshot and keeps
    // every record indexed to any resolved query card.
    subsumptionCandidatePoolComplete: subsumptionCandidatePoolComplete === true
      || !(cards || records || qaRecords),
  });
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
  const officialMatches = liveOfficialQa.records?.length
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
  timingsMs.officialQa = Date.now() - stageStartedAt;
  const officialQaDirectCandidates = officialMatches.exact
    .filter((match) => (
      isOfficialQaRecord(match.record)
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
  const globalMechanismOfficialQaSource = retrieveGlobalMechanismOfficialQaAnalogues({
    userQuery,
    records: recordBuckets.qa,
    resolvedCards: effectiveQaIdentityCards,
    deterministicRuleQueries,
    supplementalRuleQueries: effectiveSupplementalRuleQueries,
    maxResults: limits.maxRelatedEvidence,
  });
  if (globalMechanismOfficialQaSource.length) {
    retrievalWarnings.push(`official_mechanism_analogues_retrieved:${globalMechanismOfficialQaSource.length}`);
  }
  const usefulScopedOfficialMatches = officialMatches.all.filter((match) => (
      isOfficialQaRecord(match.record)
      && isUsefulOfficialRelatedMatch(match)
      && (
        !isIncidentalMultiCardExampleMatch(match, effectiveQaIdentityCards.length)
        || isStrongQuestionStructureAnalogy(match)
      )
    ));
  const combinedOfficialQaRelatedSource = mergeOfficialRelatedSourceItems([
    // Global semantic analogues and same-scene branches share one final budget.
    // Duplicate records are merged so neither mechanism coverage nor branch
    // applicability metadata is lost.
    ...globalMechanismOfficialQaSource,
    ...usefulScopedOfficialMatches,
    // A card-scoped pass cannot find an official ruling for another card that
    // instantiates the same rule mechanism. Strongly matched global analogues
    // remain useful fallback evidence, but can never become a direct ruling.
    ...rankRecordsWithSupplementalQueries({
      userQuery,
      records: scopedRecordBuckets.qa,
      resolvedCards: effectiveQaIdentityCards,
      mentionQueries,
      deterministicRuleQueries,
      supplementalRuleQueries: effectiveSupplementalRuleQueries,
      allowNoCardMatch: effectiveQaIdentityCards.length === 0 && normalizedRuleQueries.length > 0,
    }).filter((record) => !isIncidentalMultiCardExampleRecord(record, effectiveQaIdentityCards.length)),
  ]);
  const officialQaRelatedCandidates = combinedOfficialQaRelatedSource
    .map((item) => item.record
      ? evidenceFromOfficialMatch(item, "related", limits.maxEvidenceTextChars, retrievalWarnings)
      : evidenceFromRecord(item, "related", limits.maxEvidenceTextChars, retrievalWarnings))
    .filter((item) => !directIds.has(item.id));
  // Remove records already selected as direct evidence before allocating the
  // bounded related-evidence slots. Otherwise a duplicate direct record can
  // consume a reserved branch/mechanism slot and disappear only afterwards.
  const officialQaRelated = reserveRelatedEvidenceCoverage(
    officialQaRelatedCandidates,
    limits.maxRelatedEvidence,
  )
    .slice(0, limits.maxRelatedEvidence);
  if (officialQaRelatedCandidates.length > limits.maxRelatedEvidence) retrievalWarnings.push(`official_related_limited:${officialQaRelatedCandidates.length}->${limits.maxRelatedEvidence}`);

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
    records: scopedRecordBuckets.faq,
    resolvedCards: retrievalCards,
    mentionQueries,
    deterministicRuleQueries,
    supplementalRuleQueries: effectiveSupplementalRuleQueries,
    allowNoCardMatch: retrievalCards.length === 0 && normalizedRuleQueries.length > 0,
  });
  const faqRelatedSource = prioritizeOperationSubjectDefinitionFaqs({
    userQuery,
    rankedRecords: rankedFaqRelatedSource,
    resolvedCards: retrievalCards,
  });
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
    records: scopedRecordBuckets.rawRelated,
    resolvedCards: retrievalCards,
    mentionQueries,
    deterministicRuleQueries,
    supplementalRuleQueries: effectiveSupplementalRuleQueries,
    allowNoCardMatch: retrievalCards.length === 0,
  }).filter((record) => !isIncidentalMultiCardExampleRecord(record, retrievalCards.length));
  if (rawRelatedSource.length > limits.maxRelatedEvidence) retrievalWarnings.push(`raw_related_limited:${rawRelatedSource.length}->${limits.maxRelatedEvidence}`);
  const rawRelatedEvidence = rawRelatedSource
    .slice(0, limits.maxRelatedEvidence)
    .map((record) => evidenceFromRecord(record, evidenceTypeForRecord(record, "related"), limits.maxEvidenceTextChars, retrievalWarnings))
    .filter((item) => !directIds.has(item.id));
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
      officialMechanismAnalogueCount: globalMechanismOfficialQaSource.length,
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
    ...(evidence.formalEngineProofs || []),
    ...(evidence.rawRelatedEvidence || []),
  ];
  if (evidence && typeof evidence === "object") evidenceListCache.set(evidence, records);
  return records;
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
      !["qa", "official-database", "card-faq", "card-text"].includes(record.recordType)
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
  const questionIds = new Set((record.questionCardIds || []).map(normalizeId).filter(Boolean));
  const cardIds = new Set((record.cardIds || []).map(normalizeId).filter(Boolean));
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
    const id = normalizeId(card.id || card.cardId);
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
    const id = normalizeId(card.id || card.cardId);
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
  const currentId = normalizeId(card.id || card.cardId);
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

  const canonicalId = normalizeId(canonical.id || canonical.cardId);
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

function mergeQaIdentityCard(card, canonical) {
  return {
    ...card,
    aliases: [...new Set([
      ...(card.aliases || []),
      card.name,
      card.cnName,
      card.jaName,
      card.enName,
      ...(canonical.aliases || []),
      canonical.name,
      canonical.cnName,
      canonical.jaName,
      canonical.enName,
    ].filter(Boolean))],
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
        .map((id) => "id:" + normalizeId(id))
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

function findCardRecord(card, cards) {
  const wantedId = normalizeId(card.id || card.cardId);
  const wantedNames = new Set([card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])].map(normalizeCardKey).filter(Boolean));
  return cards.find((item) => wantedId && normalizeId(item.id || item.cardId) === wantedId)
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
    questionCardIdCount: Number(match.questionCardIdCount || 0),
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
    official: isAuthoritativeQaOrFaqRecord(record),
    isDirect: false,
  };
}

function isOfficialQaRecord(record = {}) {
  return ["qa", "official-database"].includes(record.recordType);
}

function isAuthoritativeQaOrFaqRecord(record = {}) {
  return ["qa", "card-faq", "official-database"].includes(record.recordType)
    || /^S0_/u.test(String(record.sourceTier || ""));
}

function officialQaNumericId(record = {}) {
  const direct = String(record.sourceRecordId || record.sourceId || "").match(/^\d+$/u)?.[0];
  if (direct) return direct;
  return String(record.stableId || record.id || "").match(/(?:ygoresources-qa-|official-qa-)(\d+)$/u)?.[1] || "";
}

function isUsefulOfficialRelatedMatch(match = {}) {
  return match.matchLevel === "official_qa_exact"
    || (match.matchLevel === "official_qa_near" && Number(match.score || 0) >= 0.68)
    || Number(match.score || 0) >= 0.78
    || (
      (match.matchedQuestionCardIds || []).length > 0
      && match.typeCompatible === true
      && match.playerRoleCompatibility !== "mismatch"
      && match.scenarioPremiseCompatibility !== "mismatch"
    );
}

function evidenceMechanismAnalogues(item = {}) {
  const record = item?.record || item;
  const signals = record?.retrievalSignals || {};
  return [...new Set([
    ...(Array.isArray(signals.mechanismAnalogues) ? signals.mechanismAnalogues : []),
    signals.mechanismAnalogue,
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function primaryEvidenceMechanismAnalogue(item = {}) {
  const record = item?.record || item;
  const signals = record?.retrievalSignals || {};
  const metrics = collectMechanismAnalogueMetrics(record);
  return selectPrimaryMechanismAnalogue(metrics)
    || String(signals.mechanismAnalogue || "").trim();
}

function reserveRelatedEvidenceCoverage(items = [], limit = 1) {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const reserved = [];
  const reservedRecordKeys = new Set();
  const representedMechanisms = new Set();

  const reserve = (item, representedMechanismOverride = "") => {
    const key = stableRecordKey(item?.record || item);
    if (!key || reservedRecordKeys.has(key) || reserved.length >= safeLimit) return false;
    reserved.push(item);
    reservedRecordKeys.add(key);
    // A merged record may carry several discovery labels. Reserving that one
    // record must not claim every label's diversity slot; credit only its
    // strongest mechanism so the others can select independent representatives.
    const representedMechanism = representedMechanismOverride
      || primaryEvidenceMechanismAnalogue(item);
    if (representedMechanism) representedMechanisms.add(representedMechanism);
    return true;
  };

  const candidates = items || [];
  // Mechanism analogues can reference one of the resolved cards without being
  // identity-scoped matches for the concrete scene. Reserve a bounded share for
  // those question-side identities, but keep them classified as related global
  // analogues and do not increase the final evidence budget.
  const mechanismIdentityCandidates = candidates
    .filter((item) => (
      !isIdentityScopedRelatedEvidence(item)
      && relatedMatchedQuestionCardIds(item).length > 0
      && evidenceMechanismAnalogues(item).length > 0
    ))
    .sort(compareIdentityScopedRelatedEvidence);
  // Identity-scoped matcher results are the closest candidates to the user's
  // concrete scene. Preserve a small bounded prefix before adding broad
  // mechanism analogues. This is recall/ranking only: every item remains
  // related and the final model still decides applicability.
  const scopedCandidates = candidates
    .filter(isIdentityScopedRelatedEvidence)
    .sort(compareIdentityScopedRelatedEvidence);
  const scopedIdentityCount = new Set(
    scopedCandidates
      .filter(isIdentityScopedRelatedEvidence)
      .flatMap(relatedMatchedQuestionCardIds),
  ).size;
  const scopedSlotLimit = scopedCandidates.length
    ? Math.min(
        safeLimit,
        Math.max(
          1,
          Math.ceil(safeLimit / 2),
          scopedIdentityCount,
        ),
      )
    : 0;
  const mechanismIdentitySlotLimit = mechanismIdentityCandidates.length
    ? Math.min(
        Math.max(0, safeLimit - scopedSlotLimit),
        Math.max(1, Math.floor(safeLimit / 6)),
      )
    : 0;
  // Preserve question-type diversity inside the fixed identity-scoped share.
  // A popular card can have dozens of high-scoring Q&A for the same broad
  // "can activate" shape; taking only their score prefix can hide a lower-ranked
  // but structurally different branch such as card activation versus effect
  // activation. This remains a bounded, source-agnostic allocation and never
  // changes related evidence into direct evidence.
  const scopedTypeRepresentatives = [];
  const representedScopedTypes = new Set();
  const representedScopedCardIds = new Set();
  for (const item of scopedCandidates.filter(isIdentityScopedRelatedEvidence)) {
    const type = relatedQuestionTypeIdentity(item);
    if (!type || representedScopedTypes.has(type)) continue;
    representedScopedTypes.add(type);
    scopedTypeRepresentatives.push(item);
  }
  const scopedDiversityCandidates = [];
  const scopedDiversityKeys = new Set();
  const scopedDiversityAssignedIdentities = new Map();
  const scopedIdentityCandidatesById = new Map();
  for (const item of scopedCandidates) {
    for (const id of relatedMatchedQuestionCardIds(item)) {
      const identityCandidates = scopedIdentityCandidatesById.get(id) || [];
      identityCandidates.push(item);
      scopedIdentityCandidatesById.set(id, identityCandidates);
    }
  }
  for (const identityCandidates of scopedIdentityCandidatesById.values()) {
    identityCandidates.sort(compareIdentityScopedRelatedEvidence);
  }
  const addScopedDiversityCandidate = (item) => {
    const key = stableRecordKey(item?.record || item);
    if (!key || scopedDiversityKeys.has(key)) return;
    scopedDiversityKeys.add(key);
    scopedDiversityCandidates.push(item);
  };
  // Preserve the strongest representative of every question-side identity
  // combination before allocating representatives for the individual cards.
  // A two-card interaction contains information that neither of its one-card
  // subsets can replace, even when corpus growth gives those subsets higher
  // lexical scores. This ordering affects related recall only; it never changes
  // matchLevel or direct-evidence authority.
  const bestScopedCandidateByIdentitySet = new Map();
  for (const item of scopedCandidates) {
    const identitySet = relatedQuestionIdentitySetKey(item);
    if (!identitySet) continue;
    const previous = bestScopedCandidateByIdentitySet.get(identitySet);
    if (!previous || compareIdentityScopedRelatedEvidence(item, previous) < 0) {
      bestScopedCandidateByIdentitySet.set(identitySet, item);
    }
  }
  const scopedIdentitySetRepresentatives = [...bestScopedCandidateByIdentitySet.entries()]
    .sort((left, right) => (
      relatedIdentitySetSize(right[0]) - relatedIdentitySetSize(left[0])
      || compareIdentityScopedRelatedEvidence(left[1], right[1])
      || left[0].localeCompare(right[0])
    ));
  for (const [, item] of scopedIdentitySetRepresentatives) {
    if (scopedDiversityCandidates.length >= scopedSlotLimit) break;
    const itemIds = relatedMatchedQuestionCardIds(item);
    const isStrictSubsetOfRetainedSet = scopedDiversityCandidates.some((retained) => (
      isStrictQuestionIdentitySubset(
        new Set(itemIds),
        new Set(relatedMatchedQuestionCardIds(retained)),
      )
    ));
    if (isStrictSubsetOfRetainedSet) continue;
    addScopedDiversityCandidate(item);
  }
  // First give each resolved identity represented in the candidate pool one
  // chance. Prefer candidates that introduce the fewest already represented
  // identities, otherwise one multi-label record can consume the opportunity
  // for several independent identities at once.
  while (scopedDiversityCandidates.length < scopedSlotLimit) {
    const nextEntry = [...scopedIdentityCandidatesById.entries()]
      .filter(([id]) => !representedScopedCardIds.has(id))
      .map(([id, identityCandidates]) => [
        id,
        identityCandidates.find(
          (item) => !scopedDiversityKeys.has(stableRecordKey(item?.record || item)),
        ),
      ])
      .filter(([, item]) => Boolean(item))
      .sort((left, right) => (
        compareIdentityScopedRelatedEvidence(left[1], right[1])
        || left[0].localeCompare(right[0])
      ))[0];
    if (!nextEntry) break;
    const [assignedId, next] = nextEntry;
    addScopedDiversityCandidate(next);
    representedScopedCardIds.add(assignedId);
    scopedDiversityAssignedIdentities.set(stableRecordKey(next?.record || next), assignedId);
  }
  for (const item of scopedTypeRepresentatives) {
    if (scopedDiversityCandidates.length >= scopedSlotLimit) break;
    addScopedDiversityCandidate(item);
  }
  // Do not let one selected record mark every identity it happens to mention
  // as represented. Each diversity slot is assigned to exactly one identity,
  // just as each mechanism slot below is assigned to exactly one mechanism.
  for (const item of scopedDiversityCandidates) {
    const key = stableRecordKey(item?.record || item);
    if (!key || reservedRecordKeys.has(key) || reserved.length >= safeLimit) continue;
    reserved.push(item);
    reservedRecordKeys.add(key);
    const assignedId = scopedDiversityAssignedIdentities.get(key);
    if (assignedId) representedScopedCardIds.add(assignedId);
    const representedMechanism = primaryEvidenceMechanismAnalogue(item);
    if (representedMechanism) representedMechanisms.add(representedMechanism);
  }
  for (const item of scopedCandidates) {
    if (reserved.length >= scopedSlotLimit) break;
    reserve(item);
  }

  const representedMechanismIdentityIds = new Set();
  for (const item of mechanismIdentityCandidates) {
    if (representedMechanismIdentityIds.size >= mechanismIdentitySlotLimit) break;
    const assignedId = relatedMatchedQuestionCardIds(item)
      .find((id) => !representedMechanismIdentityIds.has(id));
    if (!assignedId) continue;
    if (reserve(item)) representedMechanismIdentityIds.add(assignedId);
  }

  // A broad question may be associated with several mechanism signatures. Do
  // not let that single record consume every mechanism slot merely because it
  // carries more labels. When identity-scoped evidence exists, mechanism-only
  // analogues receive a small bounded share; pure rule queries may use the
  // whole budget for mechanism diversity.
  const mechanismSlotLimit = scopedCandidates.length
    ? Math.min(
        Math.max(0, safeLimit - reserved.length),
        Math.max(2, Math.floor(safeLimit / 6)),
      )
    : Math.max(0, safeLimit - reserved.length);
  let mechanismSlotsUsed = 0;
  const mechanismPool = candidates.filter((item) => (
    !isIdentityScopedRelatedEvidence(item)
    && evidenceMechanismAnalogues(item).length > 0
    && !reservedRecordKeys.has(stableRecordKey(item))
  ));
  // Preserve the discovery order of independently inferred mechanisms. A
  // merged candidate may carry weak overlap labels from several passes, but it
  // may represent only its strongest (primary) mechanism here. Otherwise one
  // broad record can falsely claim every mechanism slot and displace the actual
  // representative of an independent rule question.
  const mechanismOrder = [...new Set(mechanismPool
    .map(primaryEvidenceMechanismAnalogue)
    .filter(Boolean))];
  // Phase one assigns at most one record to each primary mechanism. The fixed
  // share is unchanged; weak secondary labels remain available to the profile
  // pass but never count as independent coverage.
  for (const mechanism of mechanismOrder) {
    if (reserved.length >= safeLimit || mechanismSlotsUsed >= mechanismSlotLimit) break;
    if (representedMechanisms.has(mechanism)) continue;
    const representative = mechanismPool
      .filter((candidate) => (
        !reservedRecordKeys.has(stableRecordKey(candidate))
        && primaryEvidenceMechanismAnalogue(candidate) === mechanism
      ))
      .sort((left, right) => compareMechanismRepresentatives(left, right, mechanism))[0];
    if (!representative || !reserve(representative, mechanism)) continue;
    mechanismSlotsUsed += 1;
  }

  // Phase two spends only the remaining fixed share on non-dominated profile
  // and question-type diversity. It cannot displace a mechanism representative
  // selected above and does not increase the final evidence budget.
  while (reserved.length < safeLimit && mechanismSlotsUsed < mechanismSlotLimit) {
    const next = mechanismPool
      .filter((candidate) => !reservedRecordKeys.has(stableRecordKey(candidate)))
      .map((candidate) => ({
        candidate,
        gain: mechanismCandidateCoverageGain(candidate, reserved, representedMechanisms),
      }))
      .filter((entry) => entry.gain > 0)
      .sort((left, right) => (
        right.gain - left.gain
        || compareMechanismSlotCandidates(left.candidate, right.candidate)
      ))[0]?.candidate;
    if (!next || !reserve(next)) break;
    mechanismSlotsUsed += 1;
  }

  for (const item of items || []) {
    if (reserved.length >= safeLimit) break;
    reserve(item);
  }
  const remaining = (items || []).filter(
    (item) => !reservedRecordKeys.has(stableRecordKey(item?.record || item)),
  );
  return [
    ...reserved,
    ...remaining,
  ];
}

function isIdentityScopedRelatedEvidence(item = {}) {
  return item.identityScopedMatch === true || item.branchRelevant === true;
}

function relatedQuestionTypeIdentity(item = {}) {
  const value = String(
    item?.questionType
      || item?.retrievalSignals?.questionType
      || "",
  ).trim().toLowerCase();
  return value && value !== "unknown" ? value : "";
}

function relatedMatchedQuestionCardIds(item = {}) {
  const values = [
    ...(Array.isArray(item?.matchedQuestionCardIds) ? item.matchedQuestionCardIds : []),
    ...(Array.isArray(item?.retrievalSignals?.matchedQuestionCardIds)
      ? item.retrievalSignals.matchedQuestionCardIds
      : []),
  ];
  return [...new Set(values.map(normalizeId).filter(Boolean))];
}

function relatedQuestionIdentitySetKey(item = {}) {
  return relatedMatchedQuestionCardIds(item).sort().join("|");
}

function relatedIdentitySetSize(identitySetKey = "") {
  return String(identitySetKey || "").split("|").filter(Boolean).length;
}

function isStrictQuestionIdentitySubset(left = new Set(), right = new Set()) {
  return left.size < right.size && [...left].every((id) => right.has(id));
}

function compareIdentityScopedRelatedEvidence(left, right) {
  const leftSignals = left?.retrievalSignals || {};
  const rightSignals = right?.retrievalSignals || {};
  return Number(right?.score || 0) - Number(left?.score || 0)
    || Number(right?.retrievalScore || 0) - Number(left?.retrievalScore || 0)
    || Number(right?.branchRelevant === true) - Number(left?.branchRelevant === true)
    || Number(
      right?.questionCardIdCoverage ?? rightSignals.questionCardIdCoverage ?? 0,
    ) - Number(
      left?.questionCardIdCoverage ?? leftSignals.questionCardIdCoverage ?? 0,
    )
    || Number(
      (right?.matchedQuestionCardIds || []).length
        || rightSignals.matchedQuestionCardIdCount
        || 0,
    ) - Number(
      (left?.matchedQuestionCardIds || []).length
        || leftSignals.matchedQuestionCardIdCount
        || 0,
    )
    || stableRecordKey(left?.record || left).localeCompare(stableRecordKey(right?.record || right));
}

function compareMechanismRepresentatives(left, right, mechanism) {
  const leftMetric = left?.retrievalSignals?.mechanismAnalogueMetrics?.[mechanism] || {};
  const rightMetric = right?.retrievalSignals?.mechanismAnalogueMetrics?.[mechanism] || {};
  return Number(rightMetric.fullQueryCoverage || 0) - Number(leftMetric.fullQueryCoverage || 0)
    || Number(rightMetric.fullScore || 0) - Number(leftMetric.fullScore || 0)
    || Number(rightMetric.fullQuestionCoverage || 0) - Number(leftMetric.fullQuestionCoverage || 0)
    || Number(rightMetric.coreScore || 0) - Number(leftMetric.coreScore || 0)
    || Number(rightMetric.coreQueryCoverage || 0) - Number(leftMetric.coreQueryCoverage || 0)
    || Number(rightMetric.coreQuestionCoverage || 0) - Number(leftMetric.coreQuestionCoverage || 0)
    || Number(rightMetric.score || 0) - Number(leftMetric.score || 0)
    || Number(rightMetric.queryCoverage || 0) - Number(leftMetric.queryCoverage || 0)
    || Number(rightMetric.questionCoverage || 0) - Number(leftMetric.questionCoverage || 0)
    || Number(right?.retrievalScore || 0) - Number(left?.retrievalScore || 0)
    || stableRecordKey(left?.record || left).localeCompare(stableRecordKey(right?.record || right));
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

function mergeRelatedRecordMetadata(left = {}, right = {}) {
  const leftSignals = left.retrievalSignals || {};
  const rightSignals = right.retrievalSignals || {};
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

function compareMechanismSlotCandidates(left, right) {
  const leftMetrics = collectMechanismAnalogueMetrics(left);
  const rightMetrics = collectMechanismAnalogueMetrics(right);
  const leftBest = leftMetrics[primaryEvidenceMechanismAnalogue(left)] || {};
  const rightBest = rightMetrics[primaryEvidenceMechanismAnalogue(right)] || {};
  return Number(rightBest.score || 0) - Number(leftBest.score || 0)
    || Number(rightBest.queryCoverage || 0) - Number(leftBest.queryCoverage || 0)
    || Number(rightBest.questionCoverage || 0) - Number(leftBest.questionCoverage || 0)
    || Number(right?.retrievalScore || 0) - Number(left?.retrievalScore || 0)
    || stableRecordKey(left).localeCompare(stableRecordKey(right));
}

function mechanismCandidateDominates(selected, candidate) {
  const sharedMechanisms = evidenceMechanismAnalogues(candidate)
    .filter((mechanism) => evidenceMechanismAnalogues(selected).includes(mechanism));
  if (!sharedMechanisms.length) return false;
  const selectedType = relatedQuestionTypeIdentity(selected);
  const candidateType = relatedQuestionTypeIdentity(candidate);
  if (selectedType && candidateType && selectedType !== candidateType) return false;
  const selectedMetrics = collectMechanismAnalogueMetrics(selected);
  const candidateMetrics = collectMechanismAnalogueMetrics(candidate);
  return sharedMechanisms.some((mechanism) => {
    const left = selectedMetrics[mechanism] || {};
    const right = candidateMetrics[mechanism] || {};
    return Number(left.fullQueryCoverage || 0) >= Number(right.fullQueryCoverage || 0)
      && Number(left.fullScore || 0) >= Number(right.fullScore || 0)
      && Number(left.fullQuestionCoverage || 0) >= Number(right.fullQuestionCoverage || 0);
  });
}

function mechanismCandidateCoverageGain(candidate, selected = [], representedMechanisms = new Set()) {
  const candidateMechanisms = evidenceMechanismAnalogues(candidate);
  const uncoveredMechanisms = candidateMechanisms.filter(
    (mechanism) => !representedMechanisms.has(mechanism),
  ).length;
  const nonDominatedProfile = selected.some((item) => mechanismCandidateDominates(item, candidate))
    ? 0
    : 1;
  const distinctQuestionType = relatedQuestionTypeIdentity(candidate)
    && !selected.some((item) => (
      relatedQuestionTypeIdentity(item) === relatedQuestionTypeIdentity(candidate)
    ))
    ? 1
    : 0;
  return uncoveredMechanisms * 4 + nonDominatedProfile * 2 + distinctQuestionType;
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
  const ruleQueries = normalizeRuleSearchQueries(ruleSearchQueries, { maxRuleSearchQueries: 8 });
  const ruleTerms = tokenize(ruleQueries.map((item) => item.query).join(" "));
  const rulePhrases = ruleQueries.map((item) => normalizeCardKey(item.query)).filter(Boolean);
  const queryKey = normalizeCardKey(userQuery);
  const resolvedIds = new Set((resolvedCards || []).map((card) => normalizeId(card.id || card.cardId)).filter(Boolean));
  const resolvedNames = new Set((resolvedCards || []).flatMap((card) => [card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]).map(normalizeCardKey).filter(Boolean));
  const unresolvedNames = new Set((mentionQueries || []).map(normalizeCardKey).filter(Boolean));
  const queryEffectNumbers = extractEffectNumbers(userQuery);
  const queryQuestionType = classifyOfficialQaQuestionType(userQuery);
  const queryEffectPhrases = extractOfficialQaEffectPhrases(userQuery);
  const querySemanticConcepts = extractOfficialQaSemanticConcepts(userQuery);
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
        retrievalSignals: item.signals,
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
  allowNoCardMatch = false,
}) {
  const deterministic = rankRecords({
    userQuery,
    records,
    resolvedCards,
    mentionQueries,
    ruleSearchQueries: deterministicRuleQueries,
    allowNoCardMatch,
  });
  if (!supplementalRuleQueries.length) return deterministic;
  const supplemental = rankRecords({
    userQuery,
    records,
    resolvedCards,
    mentionQueries,
    ruleSearchQueries: supplementalRuleQueries,
    allowNoCardMatch,
  });
  return dedupeBy([...deterministic, ...supplemental], stableRecordKey);
}

function prioritizeOperationSubjectDefinitionFaqs({
  userQuery,
  rankedRecords = [],
  resolvedCards = [],
} = {}) {
  const subject = findOperationQuestionSubject(userQuery, resolvedCards);
  if (!subject) return rankedRecords;

  const candidates = (rankedRecords || [])
    .map((record, originalIndex) => {
      if (!recordMatchesStableCardIdentity(record, subject.identity)) return null;
      const overlap = definitionFaqSemanticOverlap({
        record,
        userQuery,
        subjectCard: subject.card,
        operationPredicate: subject.predicate,
      });
      return overlap
        ? { record, originalIndex, ...overlap }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.overlapScore - left.overlapScore
      || left.originalIndex - right.originalIndex)
    // A card can have many explanatory FAQs.  Bringing all of them forward
    // merely replaces one recall problem with unrelated same-card noise.
    .slice(0, 2);

  if (!candidates.length) return rankedRecords;
  const promotedKeys = new Set(candidates.map((item) => stableRecordKey(item.record)));
  const promoted = candidates.map(({ record, overlapKeys }) => ({
    ...record,
    retrievalSignals: {
      ...(record.retrievalSignals || {}),
      operationSubjectDefinitionFaq: true,
      operationSubjectDefinitionOverlap: overlapKeys,
    },
  }));
  return dedupeBy([
    ...promoted,
    ...(rankedRecords || []).filter((record) => !promotedKeys.has(stableRecordKey(record))),
  ], stableRecordKey);
}

export function findOperationQuestionSubject(userQuery, resolvedCards = []) {
  const text = String(userQuery || "").normalize("NFKC");
  if (!text) return null;
  const lowerText = text.toLowerCase();
  const identities = buildStableResolvedCardIdentities(resolvedCards);
  const aliasesByKey = new Map();
  for (const identity of identities) {
    for (const alias of identity.aliases) {
      const key = normalizeCardKey(alias);
      if (!key) continue;
      const owners = aliasesByKey.get(key) || new Set();
      owners.add(identity.key);
      aliasesByKey.set(key, owners);
    }
  }
  const allAliases = identities.flatMap((identity) => identity.aliases
    .filter((alias) => aliasesByKey.get(normalizeCardKey(alias))?.size === 1)
    .map((alias) => ({ identity, card: identity.card, alias })));
  const candidates = [];

  for (const { identity, card, alias } of allAliases) {
    const lowerAlias = alias.toLowerCase();
    let cursor = 0;
    while (cursor <= lowerText.length - lowerAlias.length) {
      const index = lowerText.indexOf(lowerAlias, cursor);
      if (index < 0) break;
      const end = index + alias.length;
      cursor = Math.max(end, index + 1);
      if (!hasExactAliasBoundaries(text, index, end, alias)) continue;
      if (allAliases.some((other) => (
        other.identity.key !== identity.key
        && other.alias.length > alias.length
        && occurrenceContainedByAlias(lowerText, index, end, other.alias.toLowerCase())
      ))) continue;
      const before = text.slice(Math.max(0, index - 80), index);
      const after = text.slice(end, Math.min(text.length, end + 80));
      const focus = operationSubjectMentionFocus(before, after);
      if (
        focus?.coreferential === true
        && focus.explicitTopic !== true
        && !coreferenceScopeHasSingleCardIdentity({
          text,
          mentionStart: index,
          mentionEnd: end,
          identity,
          allAliases,
        })
      ) continue;
      if (focus) candidates.push({ identity, card, ...focus, index });
    }
  }

  if (!candidates.length) return null;
  const bestScore = Math.max(...candidates.map((item) => item.score));
  const bestByIdentity = new Map();
  for (const candidate of candidates.filter((item) => item.score === bestScore)) {
    const existing = bestByIdentity.get(candidate.identity.key);
    if (!existing || candidate.index > existing.index) {
      bestByIdentity.set(candidate.identity.key, candidate);
    }
  }
  // Two genuinely interrogated cards means there is no single operation
  // subject.  Failing closed is safer than arbitrarily promoting one FAQ.
  return bestByIdentity.size === 1 ? [...bestByIdentity.values()][0] : null;
}

function buildStableResolvedCardIdentities(resolvedCards = []) {
  const identities = [];
  const seen = new Set();
  for (const card of resolvedCards || []) {
    const id = normalizeId(card.id || card.cardId);
    const aliases = [...new Set([
      card.name,
      card.cnName,
      card.jaName,
      card.jpName,
      card.enName,
      ...(card.aliases || []),
    ].map((value) => String(value || "").normalize("NFKC").trim()).filter(Boolean))];
    const aliasKeys = [...new Set(aliases.map(normalizeCardKey).filter(Boolean))];
    const key = id ? `id:${id}` : aliasKeys.length ? `names:${aliasKeys.slice().sort().join("|")}` : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    identities.push({ key, id, aliases, aliasKeys: new Set(aliasKeys), card });
  }
  return identities;
}

function hasExactAliasBoundaries(text, start, end, alias) {
  const first = alias[0] || "";
  const last = alias[alias.length - 1] || "";
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  if (/[A-Za-z0-9]/u.test(first) && /[A-Za-z0-9]/u.test(before)) return false;
  if (/[A-Za-z0-9]/u.test(last) && /[A-Za-z0-9]/u.test(after)) return false;
  return true;
}

function occurrenceContainedByAlias(lowerText, mentionStart, mentionEnd, lowerAlias) {
  let cursor = Math.max(0, mentionStart - lowerAlias.length);
  while (cursor <= mentionStart) {
    const aliasStart = lowerText.indexOf(lowerAlias, cursor);
    if (aliasStart < 0 || aliasStart > mentionStart) return false;
    const aliasEnd = aliasStart + lowerAlias.length;
    if (aliasStart <= mentionStart && aliasEnd >= mentionEnd) return true;
    cursor = aliasStart + 1;
  }
  return false;
}

function operationSubjectMentionFocus(before, after) {
  const beforeText = String(before || "").replace(/[\s「『《【（("']+$/gu, "");
  const afterText = String(after || "")
    .replace(/^[\s」』》】）)"]+/gu, "")
    .replace(/^'(?!s\b)/iu, "");
  const chineseAfter = afterText.match(/^(?:的)?(?:[①-⑩]\s*)?(?:效果)?\s*(?:能否|是否(?:可以|能)?|能不能|可否|可不可以)\s*(?:连锁|連鎖)?\s*(发动|發動|适用|適用|使用)(?:\s*(?:吗|嗎|么|麼|？|\?|$))/iu)
    || afterText.match(/^(?:的)?(?:[①-⑩]\s*)?(?:效果)?\s*(?:可以|能)\s*(?:连锁|連鎖)?\s*(发动|發動|适用|適用|使用)\s*(?:吗|嗎|么|麼|？|\?)/iu);
  if (chineseAfter) return { score: 12, predicate: normalizeOperationPredicate(chineseAfter[1]) };

  const japaneseAfter = afterText.match(/^(?:の)?(?:は|を|が)?\s*(?:チェーンして\s*)?(?:(?:[①-⑩]\s*)?効果を\s*)?(発動|適用|使用)(?:する(?:事|こと)が)?(?:できますか|できる(?:のでしょう)?か|は可能ですか)/iu)
    || afterText.match(/^(?:の)?(?:は|を|が)?\s*(?:チェーンして\s*)?(発動|適用|使用)(?:は|が)?可能ですか/iu);
  if (japaneseAfter) return { score: 12, predicate: normalizeOperationPredicate(japaneseAfter[1]) };

  const englishAfter = afterText.match(/^(?:'s\s+(?:effect\s+)?)?(?:be\s+)?(activated|used|applied)\b/iu);
  if (/(?:^|[.!?;。！？]\s*|,\s*(?:and\s+)?)(?:can|may)\s*$/iu.test(beforeText) && englishAfter) {
    return { score: 12, predicate: normalizeOperationPredicate(englishAfter[1]) };
  }

  const chineseBefore = beforeText.match(/(?:能否|是否(?:可以|能)?|能不能|可否|可不可以)\s*(发动|發動|适用|適用|使用)\s*$/iu)
    || (/^(?:的)?(?:[①-⑩]\s*)?(?:效果)?\s*(?:吗|嗎|么|麼|？|\?)/iu.test(afterText)
      ? beforeText.match(/(?:可以|能)\s*(发动|發動|适用|適用|使用)\s*$/iu)
      : null);
  if (chineseBefore && /^(?:的)?(?:[①-⑩]\s*)?(?:效果)?\s*(?:吗|嗎|么|麼|？|\?|$)/iu.test(afterText)) {
    return { score: 11, predicate: normalizeOperationPredicate(chineseBefore[1]) };
  }

  const englishBefore = beforeText.match(/(?:^|[.!?;。！？]\s*|,\s*(?:and\s+)?)can\s+(?:(?:i|you|we|they|a\s+player|the\s+player|your\s+opponent|the\s+opponent)\s+)?(activate|use|apply)\s*$/iu);
  if (englishBefore) return { score: 11, predicate: normalizeOperationPredicate(englishBefore[1]) };
  const englishPossibleBefore = beforeText.match(/(?:^|[.!?;。！？]\s*|,\s*(?:and\s+)?)is\s+it\s+possible\s+to\s+(activate|use|apply)\s*$/iu);
  if (englishPossibleBefore) return { score: 11, predicate: normalizeOperationPredicate(englishPossibleBefore[1]) };

  const explicitChineseTopic = /(?:关于|關於|至于|至於|对于|對於)\s*$/iu.test(beforeText);
  const chineseCoreference = afterText.match(
    /^(?:来说|來說|而言|的话|的話)?\s*[，,、:：]?\s*(?:(?:在|于|於)?[^，,。！？!?]{0,24}?(?:场合|場合|情况下|情況下|时候|時候|时点|時點|时|時)\s*[，,]?\s*)?(?:它|其|该卡|該卡|此卡|这张卡|這張卡)(?:的)?\s*(?:[①-⑩]\s*)?(?:效果)?\s*(?:能否|是否(?:可以|能)?|能不能|可否|可不可以|可以|能)\s*(?:连锁|連鎖)?\s*(发动|發動|适用|適用|使用)(?:\s*(?:吗|嗎|么|麼|？|\?|$))/iu,
  );
  if (chineseCoreference) {
    return {
      score: 10,
      predicate: normalizeOperationPredicate(chineseCoreference[1]),
      coreferential: true,
      explicitTopic: explicitChineseTopic,
    };
  }

  const japaneseCoreference = afterText.match(
    /^(?:(について|に関して|に關して|の場合))?\s*[、,，]?\s*(?:(?:この|その)場合(?:に)?\s*[、,，]?\s*)?(?:そのカード|このカード|それ|その)(?:の)?\s*(?:[①-⑩]\s*)?(?:効果|効果を)\s*(?:チェーンして\s*)?(発動|適用|使用)(?:する(?:事|こと)が)?(?:できますか|できる(?:のでしょう)?か|は可能ですか)/iu,
  );
  if (japaneseCoreference) {
    return {
      score: 10,
      predicate: normalizeOperationPredicate(japaneseCoreference[2]),
      coreferential: true,
      explicitTopic: Boolean(japaneseCoreference[1]),
    };
  }

  const explicitEnglishTopic = /(?:regarding|concerning|about|as\s+for)\s*$/iu.test(beforeText);
  const englishCoreferencePassive = afterText.match(
    /^[,;:\s]*(?:(?:in|under|during|at)\b[^,.;!?]{0,32}[,;:\s]+)?(?:can|may)\s+(?:its|that\s+card(?:'s|’s)|this\s+card(?:'s|’s))\s+(?:[①-⑩]\s*)?effect\s+be\s+(activated|used|applied)\b/iu,
  );
  if (englishCoreferencePassive) {
    return {
      score: 10,
      predicate: normalizeOperationPredicate(englishCoreferencePassive[1]),
      coreferential: true,
      explicitTopic: explicitEnglishTopic,
    };
  }
  const englishCoreferenceActive = afterText.match(
    /^[,;:\s]*(?:(?:in|under|during|at)\b[^,.;!?]{0,32}[,;:\s]+)?(?:can|may)\s+(?:(?:i|you|we|they|a\s+player|the\s+player)\s+)?(activate|use|apply)\s+(?:its|that\s+card(?:'s|’s)|this\s+card(?:'s|’s))\s+(?:[①-⑩]\s*)?effect\b/iu,
  );
  if (englishCoreferenceActive) {
    return {
      score: 10,
      predicate: normalizeOperationPredicate(englishCoreferenceActive[1]),
      coreferential: true,
      explicitTopic: explicitEnglishTopic,
    };
  }
  return null;
}

function coreferenceScopeHasSingleCardIdentity({
  text,
  mentionStart,
  mentionEnd,
  identity,
  allAliases = [],
} = {}) {
  const source = String(text || "");
  let scopeStart = 0;
  for (let index = mentionStart - 1; index >= 0; index -= 1) {
    if (!/[\u3002！？!?;\n\r]/u.test(source[index])) continue;
    scopeStart = index + 1;
    break;
  }
  let scopeEnd = source.length;
  for (let index = mentionEnd; index < source.length; index += 1) {
    if (!/[\u3002！？!?;\n\r]/u.test(source[index])) continue;
    scopeEnd = index;
    break;
  }
  const scope = source.slice(scopeStart, scopeEnd).toLowerCase();
  const identityKeys = new Set();
  for (const candidate of allAliases || []) {
    const alias = String(candidate.alias || "").toLowerCase();
    if (!alias || !scope.includes(alias)) continue;
    let cursor = 0;
    while (cursor <= scope.length - alias.length) {
      const start = scope.indexOf(alias, cursor);
      if (start < 0) break;
      const end = start + alias.length;
      cursor = Math.max(end, start + 1);
      if (!hasExactAliasBoundaries(scope, start, end, alias)) continue;
      if (allAliases.some((other) => (
        other.identity.key !== candidate.identity.key
        && other.alias.length > candidate.alias.length
        && occurrenceContainedByAlias(scope, start, end, String(other.alias || "").toLowerCase())
      ))) continue;
      identityKeys.add(candidate.identity.key);
      break;
    }
  }
  return identityKeys.size === 1 && identityKeys.has(identity.key);
}

function normalizeOperationPredicate(value) {
  const text = String(value || "").toLowerCase();
  if (/(?:适用|適用|apply|applied)/iu.test(text)) return "apply";
  if (/(?:使用|use|used)/iu.test(text)) return "use";
  return "activate";
}

function recordMatchesStableCardIdentity(record = {}, identity = {}) {
  const subjectId = normalizeId(identity.id);
  const recordIds = new Set((record.cardIds || []).map(normalizeId).filter(Boolean));
  if (subjectId && recordIds.has(subjectId)) return true;
  // IDs are the strongest identity.  If both sides supply one and disagree,
  // do not override that contradiction with a coincidental surface name.
  if (subjectId && recordIds.size) return false;
  const recordNameKeys = new Set([
    record.cardName,
    ...(record.cards || []),
    ...(record.cardNames || []),
  ].map(normalizeCardKey).filter(Boolean));
  return [...(identity.aliasKeys || [])].some((key) => recordNameKeys.has(key));
}

function definitionFaqSemanticOverlap({
  record,
  userQuery,
  subjectCard,
  operationPredicate,
} = {}) {
  if (record?.recordType !== "card-faq") return null;
  const recordText = [record.title, record.question, record.text, record.answer, record.conclusion]
    .filter(Boolean)
    .join("\n");
  const definitionText = extractDefinitionStyleText(recordText);
  if (!definitionText) return null;

  const queryKeys = extractDefinitionSemanticKeys(userQuery);
  const subjectKeys = extractDefinitionSemanticKeys([
    subjectCard?.effectText,
    subjectCard?.text,
    subjectCard?.pendulumEffect,
  ].filter(Boolean).join("\n"));
  const recordKeys = extractDefinitionSemanticKeys(definitionText);
  const directQueryOverlap = [...queryKeys].filter((key) => recordKeys.has(key));
  const highSpecificitySubjectOverlap = [...subjectKeys].filter((key) => (
    isHighSpecificityDefinitionRelation(key) && recordKeys.has(key)
  ));
  const overlapKeys = [...new Set([
    ...directQueryOverlap,
    ...highSpecificitySubjectOverlap,
  ])];
  const predicateMatches = definitionTextMatchesPredicate(definitionText, operationPredicate);
  // A shared operation verb alone (for example, both definitions mentioning
  // "activate") is not a mechanism match.  It may rank an already-relevant
  // definition, but it must never make an unrelated same-card FAQ eligible.
  if (!overlapKeys.length) return null;
  return {
    overlapScore: overlapKeys.reduce((sum, key) => sum + definitionSemanticKeyWeight(key), 0)
      + Number(predicateMatches),
    overlapKeys: [...new Set([
      ...overlapKeys,
      ...(predicateMatches ? [`operation:${operationPredicate}`] : []),
    ])].slice(0, 8),
  };
}

function isHighSpecificityDefinitionRelation(key) {
  return key === "card_name_reference" || key === "printed_text";
}

function extractDefinitionStyleText(value) {
  const marker = /(?:とは|指的是|是指|意味着|意味する|means?\b|refers?\s+to|カードテキスト|卡片文本|卡面文本|效果文本|カード名が記された|卡名.{0,12}(?:记载|记述|記載|記述))/iu;
  return String(value || "")
    .split(/(?:\r?\n|(?<=[。！？!?])\s*|(?<=\.)\s+)/u)
    .map((part) => part.trim())
    .filter((part) => part && marker.test(part))
    .join("\n");
}

function definitionSemanticKeyWeight(key) {
  if (key === "card_name_reference") return 4;
  if (key === "printed_text") return 3;
  if (key === "copy_or_gain" || key === "special_summon") return 2;
  return 1;
}

function definitionTextMatchesPredicate(text, predicate) {
  if (predicate === "apply") return /(?:適用|适用|appl(?:y|ied|ication))/iu.test(text);
  if (predicate === "use") return /(?:使用|\buse[ds]?\b|usable)/iu.test(text);
  return /(?:発動|发动|發動|activat)/iu.test(text);
}

function extractDefinitionSemanticKeys(value) {
  const text = String(value || "");
  const definitions = [
    ["card_name_reference", /(?:カード名が記され|カード名.{0,16}(?:記載|記述)|卡名.{0,16}(?:记载|记述|記載|記述)|(?:记载|记述|記載|記述)有?.{0,24}卡名|(?:card\s+)?name.{0,24}(?:mentioned|written|listed))/iu],
    ["printed_text", /(?:カードテキスト|卡片文本|卡面文本|效果文本|printed\s+(?:card\s+)?text|text\s+(?:box|mentions?))/iu],
    ["copy_or_gain", /(?:コピー|複製|获得|獲得|得到|复制|拷贝|\b(?:copy|copied|gain|gained)\b)/iu],
    ["special_summon", /(?:特殊召喚|特殊召唤|special\s+summon)/iu],
    ["summon", /(?:召喚|召唤|summon)/iu],
    ["target", /(?:対象|对象|對象|target)/iu],
    ["cost", /(?:コスト|代价|支付|支払|\bcost\b)/iu],
    ["chain", /(?:チェーン|连锁|連鎖|\bchain\b)/iu],
    ["destroy", /(?:破壊|破坏|毀坏|destroy)/iu],
    ["return_hand", /(?:手札.{0,12}戻|回到手牌|返回手牌|return.{0,16}hand)/iu],
    ["return_deck", /(?:デッキ.{0,12}戻|回到卡组|返回牌組|return.{0,16}deck)/iu],
    ["level_rank_link", /(?:レベル|ランク|リンク|等级|阶级|连接|\b(?:level|rank|link)\b)/iu],
    ["attribute_race_type", /(?:属性|種族|种族|類別|类别|\b(?:attribute|race)\b|card\s+type)/iu],
    ["once_per_turn", /(?:1ターンに1度|一回合一次|每回合一次|once\s+per\s+turn)/iu],
  ];
  const keys = new Set(definitions.filter(([, pattern]) => pattern.test(text)).map(([key]) => key));
  for (const concept of extractOfficialQaSemanticConcepts(text)) {
    if (!["activation", "resolution", "effect", "monster_effect"].includes(concept)) {
      keys.add(`concept:${concept}`);
    }
  }
  return keys;
}

function retrieveGlobalMechanismOfficialQaAnalogues({
  userQuery = "",
  records,
  resolvedCards = [],
  deterministicRuleQueries = [],
  supplementalRuleQueries = [],
  maxResults = 5,
} = {}) {
  // Discovery must be wider than the final prompt budget. A fixed top-three
  // cut is unstable under ordinary corpus growth: a small near-duplicate
  // cluster can hide the best identity/question-shape representative before
  // the shared allocator ever sees it.
  const perMechanismLimit = Math.min(
    96,
    Math.max(8, Math.floor(Number(maxResults) || 1) * 3),
  );
  // `maxResults` is the final related-evidence budget, not the discovery
  // budget. Keep a bounded set of alternatives for every inferred mechanism
  // until all scoped and global candidates reach the common allocator. The
  // allocator later trims the prompt back to `maxResults`, so this wider local
  // pool does not increase model context or cost.
  const allQueries = [...deterministicRuleQueries, ...supplementalRuleQueries];
  const mechanismQueries = buildRuleMechanismQueries(allQueries);
  const discoveryPoolLimit = Math.min(
    256,
    Math.max(1, mechanismQueries.length) * perMechanismLimit,
  );
  const resolvedIds = new Set((resolvedCards || [])
    .map((card) => normalizeId(card?.id || card?.cardId))
    .filter(Boolean));
  const questionSideMechanismSignature = buildRuleMechanismSignature(userQuery);
  const questionSideOperationFeatures = new Set(
    [...questionSideMechanismSignature].filter(
      (feature) => ruleMechanismFeatureDimension(feature) === "operation",
    ),
  );

  // Every mechanism follows the same broad signature-overlap path. Candidate
  // eligibility and ordering come only from the official question/scenario.
  // Answer wording never controls whether a candidate survives the top-N cut.
  // Grouping is derived only from the query text's atomic semantic signature.
  // A caller-supplied label is diagnostic metadata and cannot create a match.
  const candidatesByMechanism = [];
  for (const {
    mechanism,
    fullSignatures,
    coreSignatures,
  } of mechanismQueries) {
    const candidates = (records || [])
      .filter(isCurrentOfficialQaRecord)
      .map((record) => {
        const questionFeatures = officialQaMechanismFeatures(record);
        const questionSignature = questionFeatures.signature;
        const analysis = buildRuleMechanismAnalysisProfile({
          fullSignatures,
          coreSignatures,
          questionSignature,
        });
        if (!analysis) return null;
        const matchedQuestionCardIds = questionFeatures.questionCardIds
          .filter((id) => resolvedIds.has(id));
        const unmatchedQuestionCardIdCount = Math.max(
          0,
          questionFeatures.questionCardIds.length - matchedQuestionCardIds.length,
        );
        const severePartialIdentity = resolvedIds.size >= 2
          && matchedQuestionCardIds.length >= 1
          && unmatchedQuestionCardIdCount >= 1
          && (matchedQuestionCardIds.length / resolvedIds.size) <= 0.5;
        const matchedQuestionSideOperationFeatures = analysis.matchedFeatures.filter(
          (feature) => questionSideOperationFeatures.has(feature),
        );
        const questionSideOperationCoverage = questionSideOperationFeatures.size
          ? matchedQuestionSideOperationFeatures.length / questionSideOperationFeatures.size
          : 0;
        // A global mechanism pass must not reintroduce the same noisy case that
        // the scoped matcher rejected: one coincidentally shared card inside a
        // larger foreign scene. Only explicit question-side operation overlap
        // can justify retaining that partial-identity analogy. Pure global
        // rules with no shared card identity remain eligible.
        if (severePartialIdentity && questionSideOperationCoverage < 0.5) return null;
        const questionType = questionFeatures.questionType;
        return {
          ...record,
          retrievalScore: normalizeEvidenceRelevanceScore(
            0.68 + Math.min(0.3, analysis.score * 0.035),
          ),
          retrievalSignals: {
            ...(record.retrievalSignals || {}),
            matchedSemanticConcepts: analysis.matchedFeatures,
            mechanismAnalogue: mechanism,
            mechanismAnalogues: [mechanism],
            mechanismAnalogueScore: analysis.score,
            mechanismAnalogueScores: { [mechanism]: analysis.score },
            mechanismAnalogueMetrics: {
              [mechanism]: {
                score: analysis.score,
                queryCoverage: analysis.queryCoverage,
                questionCoverage: analysis.questionCoverage,
                features: analysis.matchedFeatures,
                profile: analysis.profile,
                fullScore: analysis.fullScore,
                fullQueryCoverage: analysis.fullQueryCoverage,
                fullQuestionCoverage: analysis.fullQuestionCoverage,
                coreScore: analysis.coreScore,
                coreQueryCoverage: analysis.coreQueryCoverage,
                coreQuestionCoverage: analysis.coreQuestionCoverage,
              },
            },
            mechanismQueryCoverage: analysis.queryCoverage,
            mechanismQuestionCoverage: analysis.questionCoverage,
            mechanismSignatureFeatures: analysis.matchedFeatures,
            mechanismSignatureProfile: analysis.profile,
            mechanismFullScore: analysis.fullScore,
            mechanismFullQueryCoverage: analysis.fullQueryCoverage,
            mechanismFullQuestionCoverage: analysis.fullQuestionCoverage,
            mechanismCoreScore: analysis.coreScore,
            mechanismCoreQueryCoverage: analysis.coreQueryCoverage,
            mechanismCoreQuestionCoverage: analysis.coreQuestionCoverage,
            questionSideMatchedOperationFeatures: matchedQuestionSideOperationFeatures,
            questionSideOperationCoverage: Number(questionSideOperationCoverage.toFixed(4)),
            questionType,
            matchedQuestionCardIds,
            matchedQuestionCardIdCount: matchedQuestionCardIds.length,
            questionCardIdCount: questionFeatures.questionCardIds.length,
          },
        };
      })
      .filter(Boolean)
      .sort(compareRuleMechanismCandidates);
    if (candidates.length) {
      const selectedCandidates = selectMechanismDiscoveryCandidates(
        candidates,
        resolvedIds,
        perMechanismLimit,
      );
      candidatesByMechanism.push(selectedCandidates);
    }
  }

  // Interleave candidate lists so the applicability model sees alternatives
  // for each query without allowing one broad query to occupy the whole budget.
  const interleaved = [];
  for (let index = 0; index < perMechanismLimit; index += 1) {
    for (const candidates of candidatesByMechanism) {
      if (candidates[index]) interleaved.push(candidates[index]);
    }
  }
  return mergeMechanismAnalogueRecords(interleaved)
    .slice(0, discoveryPoolLimit);
}

function selectMechanismDiscoveryCandidates(candidates = [], resolvedIds = new Set(), limit = 3) {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  if (!resolvedIds.size) return candidates.slice(0, safeLimit);
  const selected = [];
  const selectedKeys = new Set();
  const representedQuestionCardIds = new Set();
  const representedQuestionTypes = new Set();
  const add = (candidate) => {
    const key = stableRecordKey(candidate);
    if (!key || selectedKeys.has(key) || selected.length >= safeLimit) return;
    selected.push(candidate);
    selectedKeys.add(key);
    matchedResolvedQuestionCardIds(candidate, resolvedIds)
      .forEach((id) => representedQuestionCardIds.add(id));
    const questionType = mechanismCandidateQuestionType(candidate);
    if (questionType) representedQuestionTypes.add(questionType);
  };
  // Keep one representative per question-side identity combination while the
  // discovery pool is still wide. Prefer larger combinations before their
  // one-card subsets so downstream allocation can preserve interaction-level
  // evidence instead of seeing only independently popular cards.
  const bestByQuestionIdentitySet = new Map();
  for (const candidate of candidates) {
    const matchedIds = matchedResolvedQuestionCardIds(candidate, resolvedIds).sort();
    if (!matchedIds.length) continue;
    const identitySet = matchedIds.join("|");
    if (!bestByQuestionIdentitySet.has(identitySet)) {
      bestByQuestionIdentitySet.set(identitySet, candidate);
    }
  }

  const retainedDiscoveryIdentitySets = [];
  for (const [identitySet, candidate] of [...bestByQuestionIdentitySet.entries()]
    .sort((left, right) => (
      relatedIdentitySetSize(right[0]) - relatedIdentitySetSize(left[0])
      || candidates.indexOf(left[1]) - candidates.indexOf(right[1])
      || left[0].localeCompare(right[0])
    ))) {
    if (selected.length >= safeLimit) break;
    const ids = new Set(identitySet.split("|").filter(Boolean));
    if (retainedDiscoveryIdentitySets.some((retained) => (
      isStrictQuestionIdentitySubset(ids, retained)
    ))) continue;
    add(candidate);
    retainedDiscoveryIdentitySets.push(ids);
  }
  // Preserve the best candidate for each resolved question identity first.
  // This is a discovery pool, so keep additional question-shape variants for
  // those identities before falling back to broad global analogues.
  for (const candidate of candidates) {
    const matchedIds = matchedResolvedQuestionCardIds(candidate, resolvedIds);
    if (!matchedIds.some((id) => !representedQuestionCardIds.has(id))) continue;
    add(candidate);
  }
  // Always retain the strongest global question-side mechanism match after
  // reserving identity representatives. This prevents a general analogue from
  // taking the only slot before the identity-diversity pass can run.
  add(candidates[0]);
  const identityCandidates = candidates
    .filter((candidate) => matchedResolvedQuestionCardIds(candidate, resolvedIds).length);
  for (const candidate of identityCandidates) {
    const matchedIds = matchedResolvedQuestionCardIds(candidate, resolvedIds);
    const questionType = mechanismCandidateQuestionType(candidate);
    if (!matchedIds.length || !questionType || representedQuestionTypes.has(questionType)) continue;
    add(candidate);
  }
  candidates.forEach(add);
  return selected;
}

function mechanismCandidateQuestionType(candidate = {}) {
  const value = String(
    candidate?.retrievalSignals?.questionType
      || classifyOfficialQaQuestionType(officialQaMechanismQuestionText(candidate)),
  ).trim().toLowerCase();
  return value && value !== "unknown" ? value : "";
}

function matchedResolvedQuestionCardIds(candidate = {}, resolvedIds = new Set()) {
  return [...principalQuestionCardIds(candidate)]
    .filter((id) => resolvedIds.has(id));
}

function isIncidentalMultiCardExampleMatch(match = {}, resolvedCardCount = 0) {
  if (!hasSevereQuestionIdentityMismatch(match, resolvedCardCount)) return false;
  // A supporting analogy may intentionally use different cards. Permit it
  // only when the operation signature itself is strong and compatible; raw or
  // skeleton text similarity cannot override an explicit identity conflict.
  return !isStrongCompatibleOperationAnalogy(match);
}

function isIncidentalMultiCardExampleRecord(record = {}, resolvedCardCount = 0) {
  if (record.recordType !== "qa") return false;
  const signals = record.retrievalSignals || {};
  const questionCardIdCount = principalQuestionCardIds(record).size;
  const matchedQuestionCardIdCount = Number(
    signals.matchedQuestionCardIdCount || 0,
  );
  const unmatchedQuestionCardIdCount = Math.max(
    0,
    questionCardIdCount - matchedQuestionCardIdCount,
  );
  return resolvedCardCount >= 2
    && matchedQuestionCardIdCount >= 1
    && questionCardIdCount > matchedQuestionCardIdCount
    && unmatchedQuestionCardIdCount >= 1
    && (matchedQuestionCardIdCount / resolvedCardCount) <= 0.5
    && !signals.mechanismAnalogue;
}

function hasSevereQuestionIdentityMismatch(match = {}, resolvedCardCount = 0) {
  const record = match.record || {};
  const selectedBranchCardIds = new Set(
    (match.supportingQuestionBranchCardIds || []).map(normalizeId).filter(Boolean),
  );
  const selectedBranchMatchedCardIds = new Set(
    (match.branchMatchedCardIds || []).map(normalizeId).filter(Boolean),
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

function isStrongCompatibleOperationAnalogy(match = {}) {
  const distinctiveHits = Array.isArray(match.distinctiveOperationSemanticHits)
    ? match.distinctiveOperationSemanticHits.length
    : 0;
  return match.typeCompatible === true
    && match.playerRoleCompatibility !== "mismatch"
    && match.scenarioPremiseCompatibility !== "mismatch"
    && match.effectNumberCompatible !== false
    && match.sceneQualifiersCompatible !== false
    && (match.matchedQuestionOperationFamilies || []).length >= 1
    && distinctiveHits >= 2
    && Number(match.distinctiveOperationSemanticQueryCoverage || 0) >= 0.66
    && Number(match.operationSemanticQueryCoverage || 0) >= 0.6;
}

function isStrongQuestionStructureAnalogy(match = {}) {
  const matchedOperationFamilies = match.matchedQuestionOperationFamilies || [];
  return match.typeCompatible === true
    && match.playerRoleCompatibility !== "mismatch"
    && match.scenarioPremiseCompatibility !== "mismatch"
    && match.effectNumberCompatible !== false
    && match.sceneQualifiersCompatible !== false
    && (match.matchedQuestionCardIds || []).length >= 1
    && matchedOperationFamilies.length >= 1
    && Number(match.operationSemanticQueryCoverage || 0) >= 0.5
    && Number(match.semanticQueryCoverage || 0) >= 0.75
    && Number(match.distinctiveSemanticQueryCoverage || 0) >= 0.5
    && Number(match.score || 0) >= 0.84;
}

function principalQuestionCardIds(record = {}) {
  return new Set(projectOfficialQaQuestion(record).principalCardIds
    .map(normalizeId)
    .filter(Boolean));
}

function isCurrentOfficialQaRecord(record) {
  return record?.recordType === "qa"
    && record.status !== "removed"
    && record.status !== "superseded";
}

function officialQaMechanismQuestionText(record = {}) {
  const projection = projectOfficialQaQuestion(record);
  return [projection.scenarioText, projection.questionText, record.question, record.title]
    .filter(Boolean)
    .join("\n");
}

function officialQaMechanismFeatures(record = {}) {
  if (record && typeof record === "object") {
    const cached = officialQaMechanismFeatureCache.get(record);
    if (cached) return cached;
  }
  const questionText = officialQaMechanismQuestionText(record);
  const features = {
    signature: buildRuleMechanismSignature(questionText),
    questionType: classifyOfficialQaQuestionType(questionText),
    questionCardIds: [...principalQuestionCardIds(record)],
  };
  if (record && typeof record === "object") {
    officialQaMechanismFeatureCache.set(record, features);
  }
  return features;
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

function buildRuleMechanismQueries(items = []) {
  const byMechanism = new Map();
  for (const item of items || []) {
    // Reasons are human-facing diagnostics and sometimes explain the expected
    // outcome. They must never become retrieval features.
    // `mechanism` is inferred from this exact query before any merge. Reuse it
    // only as an identity hint; signatures themselves are always rebuilt from
    // the question-side query text so a caller label cannot create evidence.
    const signature = buildRuleMechanismSignature(item?.query);
    if (!isUsableRuleMechanismSignature(signature)) continue;
    const mechanism = ruleMechanismSignatureIdentity(signature);
    const coreSignature = projectRuleMechanismCoreSignature(signature);
    const fullSignatures = [signature];
    const coreSignatures = coreSignature
        && ruleMechanismSignatureIdentity(coreSignature) !== mechanism
      ? [coreSignature]
      : [];
    if (!byMechanism.has(mechanism)) {
      byMechanism.set(mechanism, {
        mechanism,
        fullSignatures,
        coreSignatures,
        queries: [item],
      });
    }
    else {
      const entry = byMechanism.get(mechanism);
      entry.queries.push(item);
      appendUniqueRuleMechanismSignatures(entry.fullSignatures, fullSignatures);
      appendUniqueRuleMechanismSignatures(entry.coreSignatures, coreSignatures);
    }
  }
  return [...byMechanism.values()];
}

function appendUniqueRuleMechanismSignatures(target = [], candidates = []) {
  for (const candidate of candidates || []) {
    const identity = ruleMechanismSignatureIdentity(candidate);
    if (!target.some((existing) => ruleMechanismSignatureIdentity(existing) === identity)) {
      target.push(candidate);
    }
  }
}

function projectRuleMechanismCoreSignature(signature = new Set()) {
  const preferredDimensions = new Set(["timing", "quantity", "sequence", "operation"]);
  const core = new Set([...signature].filter(
    (feature) => preferredDimensions.has(ruleMechanismFeatureDimension(feature)),
  ));
  const dimensions = ruleMechanismSignatureDimensions(core);
  if (dimensions.length < 2 || !isUsableRuleMechanismSignature(core)) return null;
  return core;
}

function compareRuleMechanismAnalyses(left, right) {
  return Number(right?.score || 0) - Number(left?.score || 0)
    || Number(right?.queryCoverage || 0) - Number(left?.queryCoverage || 0)
    || Number(right?.matchedFeatures?.length || 0) - Number(left?.matchedFeatures?.length || 0);
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

function compareRuleMechanismSignatures({
  querySignature = new Set(),
  questionSignature = new Set(),
} = {}) {
  if (!isUsableRuleMechanismSignature(querySignature)) return null;
  const questionMatchedFeatures = [...querySignature].filter(
    (feature) => questionSignature.has(feature),
  );
  const matchedFeatures = questionMatchedFeatures;
  const queryWeight = ruleMechanismSignatureWeight(querySignature);
  const questionWeight = ruleMechanismSignatureWeight(questionSignature);
  const questionMatchedWeight = ruleMechanismSignatureWeight(questionMatchedFeatures);
  const queryCoverage = queryWeight ? questionMatchedWeight / queryWeight : 0;
  // Coverage is directional: the query denominator measures recall of the
  // requested mechanism, while the source-question denominator measures the
  // precision of that candidate. Reusing the query denominator for both made
  // broad weak candidates rank as if they were exact representatives.
  const questionCoverage = questionWeight ? questionMatchedWeight / questionWeight : 0;
  const missingQuestionDimensions = missingRuleMechanismDimensions(
    querySignature,
    questionSignature,
    { exclude: new Set(["relation"]) },
  );
  const matchedQuestionDimensions = ruleMechanismSignatureDimensions(
    new Set(questionMatchedFeatures),
  ).filter((dimension) => dimension !== "relation");
  const hasQuestionAnchor = matchedQuestionDimensions.some((dimension) => (
    dimension === "operation"
    || dimension === "activation"
    || dimension === "sequence"
    || dimension.startsWith("concept:")
  ));
  // This stage is candidate discovery, not the applicability judge. Keep a
  // broad candidate when the source question shares a real mechanism anchor.
  // Compatibility and polarity are left to the auxiliary applicability model.
  if (!hasQuestionAnchor) {
    return null;
  }
  return {
    matchedFeatures,
    queryCoverage: Number(queryCoverage.toFixed(4)),
    questionCoverage: Number(questionCoverage.toFixed(4)),
    matchedQuestionDimensions,
    missingQuestionDimensions,
    score: Number((
      queryCoverage * 4
      + questionCoverage * 2
      + Math.min(1, questionMatchedWeight / 4)
      - Math.min(2, missingQuestionDimensions.length * 0.3)
    ).toFixed(4)),
  };
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

function missingRuleMechanismDimensions(
  querySignature,
  evidenceSignature,
  { exclude = new Set() } = {},
) {
  const queryByDimension = new Map();
  for (const feature of querySignature || []) {
    const dimension = ruleMechanismFeatureDimension(feature);
    if (!dimension || exclude.has(dimension)) continue;
    const features = queryByDimension.get(dimension) || new Set();
    features.add(feature);
    queryByDimension.set(dimension, features);
  }
  const evidenceFeatures = new Set(evidenceSignature || []);
  return [...queryByDimension.entries()]
    .filter(([, features]) => ![...features].some((feature) => evidenceFeatures.has(feature)))
    .map(([dimension]) => dimension)
    .sort();
}

function ruleMechanismSignatureWeight(signature = []) {
  return [...signature].reduce(
    (sum, feature) => sum + ruleMechanismFeatureWeight(feature),
    0,
  );
}

function ruleMechanismFeatureWeight(feature) {
  const value = String(feature || "");
  if (value.startsWith("concept:")) return 1.25;
  if (value.startsWith("operation:")) return 1.5;
  return 1;
}

function mergeMechanismAnalogueRecords(records = []) {
  const merged = new Map();
  for (const record of records || []) {
    const key = stableRecordKey(record);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, mergeRelatedRecordMetadata({}, record));
      continue;
    }
    merged.set(key, mergeRelatedRecordMetadata(previous, record));
  }
  return [...merged.values()];
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
}) {
  const rankingIdentity = retrievalRankingIdentity(record);
  const text = rankingIdentity.text;
  const { textKey, normalizedCardIds, normalizedCardNames } = retrievalRecordFeatures(
    record,
    rankingIdentity,
  );
  const questionProjection = projectOfficialQaQuestion(record);
  const questionText = questionProjection.scenarioText || record.title || "";
  const questionCardIds = new Set(questionProjection.principalCardIds
    .map(normalizeId)
    .filter(Boolean));
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
  const cardNameMatch = normalizedCardNames.some((name) => resolvedNames.has(name)) || [...resolvedNames].some((name) => name.length >= 3 && !hasNumberedCardIdentityConflict(name, text) && textKey.includes(name));
  const unresolvedNameMatch = [...unresolvedNames].some((name) => name.length >= 3 && !hasNumberedCardIdentityConflict(name, text) && textKey.includes(name));
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
  if (!cardScore && !phraseMatched && !fullQueryMatched && lexicalHits.size < 3) {
    return emptyRecordScore();
  }
  const evidenceEffectNumbers = extractEffectNumbers(questionText || text);
  const effectNumberCompatible = !queryEffectNumbers.length
    || !evidenceEffectNumbers.length
    || queryEffectNumbers.some((number) => evidenceEffectNumbers.includes(number));
  const evidenceQuestionType = classifyOfficialQaQuestionType(questionText || text);
  const typeCompatible = questionTypeCompatibleForRanking(queryQuestionType, evidenceQuestionType);
  const evidenceEffectPhrases = extractOfficialQaEffectPhrases(questionText || text);
  const matchedEffectPhrases = queryEffectPhrases.filter((phrase) => evidenceEffectPhrases.includes(phrase));
  const evidenceSemanticConcepts = extractOfficialQaSemanticConcepts(questionText || text);
  const matchedSemanticConcepts = querySemanticConcepts.filter((concept) => evidenceSemanticConcepts.includes(concept));
  const semanticQueryCoverage = querySemanticConcepts.length
    ? matchedSemanticConcepts.length / querySemanticConcepts.length
    : 0;
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
    normalizedCardIds: identity.cardIds.map(normalizeId).filter(Boolean),
    normalizedCardNames: identity.cardNames.map(normalizeCardKey).filter(Boolean),
  };
  if (record && typeof record === "object") retrievalRecordFeatureCache.set(record, features);
  return features;
}

function isScenarioOfficialQaRecord(record = {}) {
  return record.recordType === "qa" || record.recordType === "official-database";
}

function retrievalRankingIdentity(record = {}) {
  if (!isScenarioOfficialQaRecord(record)) {
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

  const projection = projectOfficialQaQuestion(record);
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
    cardIds: [...new Set((projection.principalCardIds || []).map(normalizeId).filter(Boolean))],
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
          query: item,
          reason: "",
          confidence: "medium",
          source: "rule_search_query",
          declaredMechanism: "",
        }
      : {
          query: String(item?.query || item?.searchQuery || item?.keyword || item?.topic || "").trim(),
          reason: String(item?.reason || "").trim(),
          confidence: item?.confidence || "medium",
          source: item?.source || "rule_search_query",
          declaredMechanism: String(item?.declaredMechanism || item?.mechanism || "").trim(),
        })
    .map((item) => ({
      ...item,
      query: item.query.replace(/\s+/gu, " ").slice(0, 120),
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
  const representedMechanisms = new Set();
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
  const generic = query ? [{
    query,
    reason: "从题目中的操作、时点、位置和连锁描述生成通用规则检索词。",
    confidence: "medium",
    source: "derived_rule_search_query",
  }] : [];
  return dedupeBy([
    ...deriveMechanismRuleQueries(userQuery),
    ...generic,
  ], (item) => normalizeCardKey(item.query));
}

function deriveRuleSearchQueriesFromCardTexts(userQuery, cardTexts = []) {
  const questionContext = buildGenericRuleQuery(userQuery).slice(0, 56);
  const perCardQueries = (cardTexts || []).map((item) => {
    const cardLabel = [...(item.cards || []), item.cardType].filter(Boolean).join(" ");
    return splitCardTextClauses(item.text)
      .filter((clause) => clause.length >= 4 && containsOperationLanguage(clause))
      .map((clause) => ({
        query: expandRetrievalVocabulary(`${questionContext} ${cardLabel} ${clause}`).slice(0, 120),
        reason: `根据${(item.cards || [item.title || "卡片"]).join("、")}的处理句检索对应规则。`,
        confidence: "medium",
        source: "card_text_derived_rule_search_query",
      }))
      .filter((entry) => entry.query)
      .slice(0, 4);
  });
  const interleaved = roundRobin(perCardQueries, 12);
  // Mechanism regexes must stay inside one printed-effect clause. Combining
  // every effect of every card allowed unrelated clauses to satisfy opposite
  // halves of a regex (for example, one effect mentions a chain while another
  // mentions banishing), which produced irrelevant rule searches.
  const perEffectMechanismQueries = (cardTexts || []).flatMap((item) => (
    splitCardTextClauses(item.text).flatMap((clause) => deriveMechanismRuleQueries(clause))
  ));
  return dedupeBy([
    ...deriveScenarioMechanismRuleQueries(userQuery, cardTexts),
    ...perEffectMechanismQueries,
    ...interleaved,
  ], (item) => normalizeCardKey(item.query)).slice(0, 12);
}

function deriveScenarioMechanismRuleQueries(userQuery, cardTexts) {
  const scenario = compileRuleScenario({ userQuery, cardTexts });
  const queries = [];
  const add = (query, reason, mechanism = "") => queries.push({
    query: expandRetrievalVocabulary(query).slice(0, 120),
    reason,
    confidence: "high",
    source: "compiled_scenario_rule_search_query",
    mechanism,
  });
  if (scenario.mandatoryFieldSpellTrapReturn && scenario.currentChainSpellTrap) {
    add("魔法陷阱卡 发动中 连锁途中 回到手卡 回到卡组", "卡文包含必做的场上魔法・陷阱返回处理，题目中的当前连锁卡是魔法・陷阱。 ");
    if (scenario.noOtherSpellTraps) {
      add("发动中的非永续魔法陷阱 能否回到手卡或卡组 没有其他候选 发动合法性", "场景角色表明当前发动卡是唯一可能候选，检索必做处理无可适用卡时的发动限制。 ");
    }
  }
  if (scenario.simultaneousDestructionReplacement) {
    add("同一时点 双方 代替破坏 回合玩家 非回合玩家 适用顺序", "从双方效果载体、同一破坏事件及代替破坏卡文推导适用顺序规则。 ");
    add("多个代替破坏 处理改变场面后 是否重新检查效果载体和适用条件", "检索第一个代替处理改变场面后，第二个代替效果是否仍适用。 ");
  }
  if (scenario.simultaneousPublicPrivateTriggers) {
    add("同一时点发动多个诱发类效果 回合玩家 对方 公开情报 非公开手牌 选发 组成连锁顺序", "场景中同时存在公开区域的选发诱发效果与非公开手牌的诱发效果，检索 OCG 组链优先顺序。 ", "simultaneous_trigger_order");
    add("公开区域诱发与手牌诱发 同一时点 各自在什么发动窗口组成连锁", "检索公开区域诱发进入连锁时，响应权转移及手牌诱发的发动窗口。 ", "simultaneous_trigger_order");
  }
  if (scenario.simultaneousContinuouslyPublicHandTriggers) {
    queries.push({
      query: expandRetrievalVocabulary("手札 持続的に公開 誘発効果 チェーン1 チェーン2 順番を選べるか").slice(0, 120),
      reason: "题面说明手牌已持续公开，并询问该手牌效果与同一时点的另一诱发效果能否自行排列连锁。",
      confidence: "high",
      source: "public_hand_trigger_order_rule_search_query",
      mechanism: "public_hand_trigger_order",
    });
  }
  return queries;
}

function deriveMechanismRuleQueries(value) {
  const text = String(value || "");
  const queries = [];
  const add = (query, reason, source = "mechanism_rule_search_query", mechanism = "") => queries.push({
    query: expandRetrievalVocabulary(query).slice(0, 120),
    reason,
    confidence: "high",
    source,
    mechanism,
  });
  const chainLinkNumbers = new Set([
    ...[...text.normalize("NFKC").matchAll(/[cＣ]\s*([1-9]\d*)/giu)].map((match) => Number(match[1])),
    ...[...text.matchAll(/(?:连锁|連鎖|チェーン)\s*([1-9]\d*)/gu)].map((match) => Number(match[1])),
  ].filter(Number.isFinite));
  const mentionsMultipleChainLinks = chainLinkNumbers.size >= 2;
  const explicitSameTimingTriggers = /(?:同一|相同|同じ).{0,12}(?:时点|時點|タイミング).{0,40}(?:多个|多個|複数|诱发|誘発|trigger)/iu.test(text);
  const explicitMandatoryOptionalTriggers = /(?:必发|必發|必须发动|必須発動|必ず発動).{0,80}(?:选发|選發|任意|可以发动|可以發動|発動できる)/isu.test(text);
  const newTriggerChainMatch = text.match(/(?:另|再|新)(?:开|開|起|组成|組成|构筑|構築|建立).{0,12}(?:连锁|連鎖|チェーン)/iu);
  const newTriggerChainTail = newTriggerChainMatch
    ? text.slice((newTriggerChainMatch.index || 0) + newTriggerChainMatch[0].length)
    : "";
  const tailChainLinkNumbers = new Set([
    ...[...newTriggerChainTail.normalize("NFKC").matchAll(/[cＣ]\s*([1-9]\d*)/giu)].map((match) => Number(match[1])),
    ...[...newTriggerChainTail.matchAll(/(?:连锁|連鎖|チェーン)\s*([1-9]\d*)/gu)].map((match) => Number(match[1])),
  ].filter(Number.isFinite));
  const explicitPostChainTriggerOrdering = tailChainLinkNumbers.size >= 2
    && /(?:诱发|誘発|时点|時點|タイミング|错过|錯過|召唤|召喚|反转|反轉)/iu.test(text);
  if (explicitSameTimingTriggers || explicitMandatoryOptionalTriggers || explicitPostChainTriggerOrdering) {
    add(
      "同一时点 多个诱发效果 必发 公开选发 回合玩家 非回合玩家 如何组成连锁及顺序",
      "题面要求排列同一发动窗口中的多个诱发效果，检索必发、公开选发和双方玩家的组链优先级。",
      "simultaneous_trigger_order_rule_search_query",
      "simultaneous_trigger_order",
    );
    add(
      "同じタイミング 発動する効果 複数 必ず発動 任意 公開 ターンプレイヤー チェーンの順番",
      "检索官方数据库中同一时点多个效果按优先度组成连锁的通用 Q&A。",
      "simultaneous_trigger_order_rule_search_query",
      "simultaneous_trigger_order",
    );
  }
  if (mentionsMultipleChainLinks && /(?:处理|處理|结算|結算|解決|逆序|resolve)/iu.test(text)) {
    add(
      "连锁组成后 多个连锁环节 按什么顺序处理 连锁2 连锁1",
      "题面同时给出多个连锁环节及其处理，检索从最高连锁环节开始逆序结算的基础规则。",
      "chain_resolution_reverse_rule_search_query",
    );
  }
  if (/(?:连锁|連鎖|チェーン|\bC\d+\b|chain)/iu.test(text) && /(除外|送去墓地|送墓|离场|離場|不在|回到手|返回手|回到卡组|返回卡组|回去|位置)/u.test(text)) {
    add("已经发动的效果 连锁处理中 发动效果的卡离开原位置 效果处理", "检索发动源在连锁处理中改变位置后的处理规则。");
    add("效果处理 部分不能处理 后续处理 尽可能处理", "检索一项处理不能完成时其余处理是否继续。");
  }
  if (/(对象|對象|対象|target)/iu.test(text) && /(丢失|丟失|离场|離場|不在|除外|回到|返回|送去墓地|送墓)/u.test(text)) {
    add("效果处理时 对象不在原位置 对象丢失 其他处理 后续处理", "检索处理时对象不再存在时各项处理的适用范围。");
  }
  if (/(无效|無效|negate)/iu.test(text) && /(破坏|破壊|destroy)/iu.test(text)) {
    add(
      "魔法陷阱 卡的发动无效 效果发动无效 场上的卡 破坏",
      "区分卡的发动与效果发动被无效后的场上状态。",
      "activation_negation_destruction_rule_search_query",
      "activation_negation_destruction_location",
    );
  }
  if (/(?:舍弃|丢弃|捨て|送去墓地|送墓|支付|支払|cost|コスト)/iu.test(text) && /(?:发动|發動|発動)/u.test(text)) {
    add("卡片效果发动 支付cost 顺序 支付后 状态立即变化", "检索发动时支付 cost 的顺序以及支付后卡片位置何时改变。");
    add("支付cost后 效果处理前 永续效果 适用条件重新判断", "检索 cost 改变场面后，连锁处理前持续适用效果是否开始或停止适用。");
  }
  const asksLaterChainLinkActivation = mentionsMultipleChainLinks
    && /(?:[cＣ]\s*2|(?:连锁|連鎖|チェーン)\s*2).{0,48}(?:能否|能不能|可否|是否|可以|发动|發動|発動|activate)|(?:能否|能不能|可否|是否|可以).{0,48}(?:[cＣ]\s*2|(?:连锁|連鎖|チェーン)\s*2)/isu.test(text);
  const earlierChainLinkPaysCost = /(?:[cＣ]\s*1|(?:连锁|連鎖|チェーン)\s*1).{0,80}(?:舍弃|丢弃|捨て|送去墓地|送墓|支付|支払|cost|コスト)|(?:舍弃|丢弃|捨て|送去墓地|送墓|支付|支払|cost|コスト).{0,80}(?:[cＣ]\s*1|(?:连锁|連鎖|チェーン)\s*1)/isu.test(text);
  if (asksLaterChainLinkActivation && earlierChainLinkPaysCost) {
    add(
      "同一时点 诱发类效果 发动条件在何时判断 C1支付cost后 C2的条件或对象才出现",
      "题面询问 C1 支付 cost 后是否能让同一诱发窗口中的 C2 新取得发动资格；检索组链开始前的发动合法性快照。",
      "pre_chain_trigger_legality_rule_search_query",
    );
    add(
      "诱发效果组成连锁时 支付cost后才出现对象 是否影响后续效果的发动合法性",
      "区分多个公开区域诱发的组链前合法性与单一效果自身支付 cost 后选择对象。",
      "pre_chain_trigger_legality_rule_search_query",
    );
  }
  if (/(?:代替破坏|破坏.{0,12}代替|破壊.{0,12}代わり|替代破坏)/u.test(text)
      && /(?:同时|同一时点|双方|多个|复数|複数|各自|都要|一起)/u.test(text)) {
    add("同一时点 多个不入连锁效果 适用顺序 回合玩家 非回合玩家", "检索多个不入连锁效果同时适用时的先后顺序。");
    add("同时适用 多个代替破坏效果 双方玩家 适用顺序 场面变化后是否重新判断", "检索双方代替破坏效果竞争时是否依次适用并重新判断场面。");
  }
  if (/(不受.{0,8}效果影响|不受效果|unaffected)/iu.test(text) && /(对象|對象|対象|target)/iu.test(text)) {
    add("不受其他卡的效果影响 可以成为效果对象 对象选择 效果适用", "分别检索对象选择限制与效果抗性。");
  }
  if (/(魔法|陷阱|罠)/u.test(text) && /(回到手|返回手|放回手|回到卡组|返回卡组|回去|戻)/u.test(text)) {
    add("魔法陷阱卡 发动中 连锁途中 回到手卡 回到卡组", "检索发动中魔法陷阱的位置移动限制。");
    if (/(没有其他|不存在其他|并无其他|无其他|只有.{0,24}(?:1|一)张|除.{0,20}以外没有|no other|none)/iu.test(text)) {
      add("发动中的非永续魔法陷阱 能否回到手卡或卡组 无其他候选时的发动合法性", "检索唯一候选受位置移动限制时，必做处理是否导致不能发动。");
    }
  }
  if (/(然后|那之后|之后|之後|并且|並且|再|仍然|尽可能|不能处理)/u.test(text)) {
    add("效果文本 连续处理 前一项不能处理 后续处理 是否进行", "检索多段效果的处理顺序和依赖关系。");
  }
  const controlChanged = /(?:控制权|控制權|コントロール|control)/iu.test(text)
    && /(?:变更|轉移|转移|改变|移る|移った|移す|change|transfer|gain)/iu.test(text);
  const ownFieldDuration = /(?:只要|期间|存在于|存在於|存在する限り|while)/iu.test(text)
    && /(?:自己|我方|自分|your).{0,20}(?:场上|場上|怪兽区域|怪獸區域|フィールド|モンスターゾーン|field|monster zone)/iu.test(text);
  const returnOrReapply = /(?:归还|歸還|回到自己|返回自己|再び自分に戻|恢复适用|恢復適用|重新适用|再次适用|再び適用|return|re-?appl|again)/iu.test(text);
  if (controlChanged && ownFieldDuration && returnOrReapply) {
    queries.push({
      query: "コントロール 相手に移った 自分フィールドに存在する限り 再び自分に戻った 効果は適用されるか",
      reason: "检索已处理效果绑定‘在自己场上存在期间’时，控制权转移及归还后的效果实例生命周期。",
      confidence: "high",
      source: "effect_lifecycle_rule_search_query",
      mechanism: "bound_effect_lifecycle",
    });
    queries.push({
      query: "控制权转移 只要在自己场上存在 控制权归还后 效果是否适用",
      reason: "检索持续条件首次不成立及后来再次成立时，既有适用是否重启。",
      confidence: "high",
      source: "effect_lifecycle_rule_search_query",
      mechanism: "bound_effect_lifecycle",
    });
  }
  const printedReferenceScenario = analyzePrintedTextReferenceScenario({
    userQuery: text,
    cardTexts: [],
  });
  if (printedReferenceScenario.requiredName
      || /(?:有.{0,30}卡名(?:记载|记述)|卡名(?:记载|记述).{0,30}怪兽)/u.test(text)) {
    add("有「○○」卡名记述 如何判断 是否要求效果文本栏中存在该卡名", "检索“有某卡名记述”的定义及其对卡面效果文本栏的要求。");
    if (/(?:获得|得到|复制|拷贝|コピー|copy|gain).{0,100}(?:卡名|效果|効果|effect)/isu.test(text)) {
      add("复制或获得卡名效果后 是否改变自身效果文本栏中的卡名记述", "区分当前获得的卡名・效果与卡片自身印刷文本中的卡名记述。");
    }
  }
  return dedupeBy(queries, (item) => normalizeCardKey(item.query));
}

function splitCardTextClauses(value) {
  return String(value || "")
    .replace(/(?=[①②③④⑤⑥⑦⑧⑨●])/gu, "\n")
    .split(/[。；;\n]+/u)
    .map((item) => item.replace(/^[①②③④⑤⑥⑦⑧⑨\d●]+[：:.、]?/u, "").trim())
    .filter(Boolean);
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
  // Caller/model-generated queries are retained after the local reproducible
  // query plan. Retrieval ranks these two groups independently and appends the
  // supplemental results, so model output can broaden but never reorder the
  // deterministic evidence prefix.
  return normalizeRuleSearchQueries([
    ...deterministic,
    ...supplemental,
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
  if (/(墓地|送墓|graveyard)/iu.test(text)) additions.push("墓地 送去墓地 graveyard");
  if (/(除外|banish)/iu.test(text)) additions.push("除外 banish");
  if (/(破坏|破壊|destroy)/iu.test(text)) additions.push("破坏 破壊 destroy");
  if (/(攻击|攻擊|攻撃|attack)/iu.test(text)) additions.push("攻击 攻撃 attack 战斗 バトル");
  if (/(次数|回数|多次|两次|兩次|[一二三四五六七八九十\d]+次|twice)/iu.test(text)) additions.push("次数 回数 多次 twice");
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

function normalizeId(value) {
  return String(value || "").replace(/\D+/gu, "").replace(/^0+(?=\d)/u, "");
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
      warnings.push(`unresolved_mention_fuzzy_match:${query}->${best.name}`);
      result.push({
        ...best,
        input: mention.input,
        matchedQuery: query,
        confidence: Math.min(best.confidence, 0.7),
      });
      break;
    }
  }
  return dedupeCards(result);
}

async function resolveUnresolvedMentionCardsWithBaige(unresolvedMentions, { fetchImpl, env, limits, warnings, debug }) {
  const mentions = (unresolvedMentions || []).slice(0, limits.maxCards);
  const minConfidence = readPositiveDecimal(env.RAG_BAIGE_MIN_CONFIDENCE, 0.72);
  const result = await Promise.all(mentions.map(async (mention) => {
    let bestLowConfidence = null;
    let bestLowConfidenceCandidates = [];
    let bestLowConfidenceQuery = "";
    let bestAmbiguousSelection = null;
    let bestAmbiguousQuery = "";
    for (const query of mentionSearchQueries(mention)) {
      const searchResult = await searchBaige(query, { fetchImpl, env, limits, debug });
      warnings.push(...searchResult.warnings);
      const candidates = searchResult.results || [];
      if (!candidates.length) {
        warnings.push(`baige_no_result:${query}`);
        continue;
      }
      const selection = selectUniqueBaigeCandidate(candidates, minConfidence);
      const best = selection.card;
      const confidence = Number(best?.confidence || 0);
      if (best) {
        const queryMatchesUserSurface = normalizeCardKey(query) === normalizeCardKey(mention.input);
        const resolutionKind = selection.resolutionKind === "unique_exact_primary_name"
          && !queryMatchesUserSurface
          ? "canonical_expansion_exact_primary_name"
          : selection.resolutionKind || "confidence_margin";
        warnings.push(`baige_match:${query}->${best.name}`);
        return {
          ...toRagCard(best, mention.input, confidence),
          matchedQuery: query,
          externalSurfaceResolution: resolutionKind,
        };
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

async function enrichCardsWithBaige(cards, {
  fetchImpl,
  env,
  limits,
  warnings,
  debug,
}) {
  const sourceCards = (cards || []).slice(0, limits.maxCards);
  const result = await Promise.all(sourceCards.map(async (card) => {
    const needsNumberedIdentityEnrichment = card.numberedIdentityNameMismatch === true;
    const needsSurfaceIdentityVerification = !needsNumberedIdentityEnrichment
      && cardInputNeedsIdentityVerification(card);
    if (!needsNumberedIdentityEnrichment && !needsSurfaceIdentityVerification
      && hasUsableCardText(card) && (card.id || card.cardId)
      && (!enginePasscodeRequired(env) || hasEnginePasscode(card))) {
      return card;
    }
    const nameQuery = needsNumberedIdentityEnrichment || needsSurfaceIdentityVerification
      ? card.numberedIdentityInput || card.input || card.name
      : card.name || card.cnName || card.jaName || card.enName || card.input;
    const localCid = !needsSurfaceIdentityVerification
      && enginePasscodeRequired(env) && !hasEnginePasscode(card)
      ? verifiedLocalCardCid(card)
      : "";
    if (localCid) {
      const cidSearchResult = await searchBaige(localCid, {
        fetchImpl,
        env,
        limits,
        debug,
      });
      warnings.push(...cidSearchResult.warnings);
      const exactCidCard = (cidSearchResult.results || []).find((candidate) => (
        normalizedDecimal(candidate.cid) === localCid
        && Boolean(verifiedEnginePasscode(candidate))
      ));
      if (exactCidCard) {
        warnings.push(`engine_passcode_baige_cid_enriched:${localCid}`);
        return mergeCard(
          card,
          toRagCard(exactCidCard, card.input || nameQuery || localCid, 1),
        );
      }
      warnings.push(`engine_passcode_baige_cid_not_found:${localCid}`);
    }
    if (!nameQuery) {
      return card;
    }
    const searchResult = await searchBaige(nameQuery, { fetchImpl, env, limits, debug });
    warnings.push(...searchResult.warnings);
    const selection = selectUniqueBaigeCandidate(searchResult.results || [], 0.72);
    let best = selection.card;
    let matchedQuery = nameQuery;
    let verifiedByCanonicalLookup = false;
    if (!best && !selection.ambiguous && needsSurfaceIdentityVerification) {
      const canonicalLookup = await verifySurfaceIdentityThroughCanonicalBaigeLookup(card, {
        primaryQuery: nameQuery,
        fetchImpl,
        env,
        limits,
        warnings,
        debug,
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
        replacedLocalCandidate: summarizeIdentityCandidate(card),
      });
    }
    return {
      ...mergeCard(card, externalCard),
      identityVerificationStatus: needsSurfaceIdentityVerification
        ? "verified_same_identity"
        : card.identityVerificationStatus,
    };
  }));
  return result.filter(Boolean);
}

async function verifySurfaceIdentityThroughCanonicalBaigeLookup(card, {
  primaryQuery,
  fetchImpl,
  env,
  limits,
  warnings,
  debug,
}) {
  for (const query of canonicalIdentityVerificationQueries(card, primaryQuery)) {
    const searchResult = await searchBaige(query, { fetchImpl, env, limits, debug });
    warnings.push(...searchResult.warnings);
    const selection = selectUniqueBaigeCandidate(searchResult.results || [], 0.72);
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

function selectUniqueBaigeCandidate(candidates, minConfidence) {
  const eligible = (candidates || [])
    .filter((candidate) => Number(candidate?.confidence || 0) >= minConfidence);
  if (!eligible.length) return { card: null, ambiguous: false, candidates: [] };
  const identities = new Map();
  for (const candidate of eligible) {
    const key = externalCardIdentityKey(candidate);
    if (!identities.has(key)) identities.set(key, candidate);
  }
  const uniqueCandidates = [...identities.values()]
    .sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0));
  if (uniqueCandidates.length === 1) {
    return {
      card: uniqueCandidates[0],
      ambiguous: false,
      candidates: uniqueCandidates,
      resolutionKind: String(uniqueCandidates[0].confidenceSource || "").includes("unique_exact_primary_name")
        ? "unique_exact_primary_name"
        : "single_eligible_identity",
    };
  }
  const best = uniqueCandidates[0];
  const runnerUp = uniqueCandidates[1];
  const margin = Number(best.confidence || 0) - Number(runnerUp.confidence || 0);
  const providerCertifiedUnique = /(?:unique|high_gap)/u.test(String(best.confidenceSource || ""));
  if (margin >= 0.05 || providerCertifiedUnique) {
    return {
      card: best,
      ambiguous: false,
      candidates: uniqueCandidates,
      resolutionKind: String(best.confidenceSource || "").includes("unique_exact_primary_name")
        ? "unique_exact_primary_name"
        : providerCertifiedUnique
          ? "provider_certified_unique"
          : "confidence_margin",
    };
  }
  return { card: null, ambiguous: true, candidates: uniqueCandidates };
}

function externalCardIdentityKey(card = {}) {
  const passcode = verifiedEnginePasscode(card)
    || (/^[1-9]\d{4,9}$/u.test(normalizeId(card.id || card.cardId))
      ? normalizeId(card.id || card.cardId)
      : "");
  const cid = verifiedExternalCardCid(card);
  return passcode ? `passcode:${passcode}` : cid ? `cid:${cid}` : `name:${normalizeCardKey(card.name)}`;
}

function suppressModelExpansionConflicts(localCards, baigeCards, warnings) {
  const surfaceVerified = (baigeCards || []).filter((card) => (
    Number(card.confidence || 0) >= 0.72
    && normalizeCardKey(card.matchedQuery) === normalizeCardKey(card.input)
  ));
  if (!surfaceVerified.length) return localCards || [];
  return (localCards || []).filter((localCard) => {
    const conflict = surfaceVerified.find((verifiedCard) => (
      normalizeCardKey(verifiedCard.input) === normalizeCardKey(localCard.input)
      && !sameStableCardIdentity(verifiedCard, localCard)
      && (
        normalizeCardKey(localCard.matchedQuery) !== normalizeCardKey(localCard.input)
        || Number(verifiedCard.confidence || 0) >= Number(localCard.confidence || 0) + 0.02
      )
    ));
    if (!conflict) return true;
    warnings.push(`model_expansion_conflict_suppressed:${localCard.input}:${localCard.name}->${conflict.name}`);
    return false;
  });
}

async function searchBaige(query, { fetchImpl, env, limits, debug }) {
  const result = await searchCards(query, { fetchImpl, env, limit: Math.max(3, limits.maxCards) });
  debug.searchCount += 1;
  if (result.cacheHit) debug.cacheHitCount += 1;
  debug.warnings.push(...(result.warnings || []));
  return result;
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

function enginePasscodeRequired(env = {}) {
  // Legacy Lua discovery is independently enabled by OCG_ENGINE_URL. Turning
  // off automatic scenario simulation must not disable passcode hydration for
  // the production packet factory.
  return Boolean(String(env.OCG_ENGINE_URL || "").trim());
}

function hasEnginePasscode(card = {}) {
  return Boolean(verifiedEnginePasscode(card));
}

function verifiedEnginePasscode(card = {}) {
  const cid = verifiedLocalCardCid(card);
  for (const value of [card.passcode, card.password]) {
    const passcode = normalizeLegacyLuaPasscode(value);
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
  const leftId = normalizeId(left.id || left.cardId);
  const rightId = normalizeId(right.id || right.cardId);
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
  const id = normalizeId(card.id || card.cardId);
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
  const includeInput = card.identityVerificationStatus !== "unverified";
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
    .filter((card) => card.externalSurfaceResolution === "unique_exact_primary_name")
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
  return dedupeBy((cards || []).filter(Boolean), (card) => normalizeId(card.id || card.cardId) || normalizeCardKey(card.name || card.cnName || card.jaName || card.enName || card.input));
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

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
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

function buildRuleMechanismAnalysisProfile({
  fullSignatures = [],
  coreSignatures = [],
  questionSignature = new Set(),
} = {}) {
  const best = (signatures) => (signatures || [])
    .map((querySignature) => compareRuleMechanismSignatures({
      querySignature,
      questionSignature,
    }))
    .filter(Boolean)
    .sort(compareRuleMechanismAnalyses)[0] || null;
  const fullAnalysis = best(fullSignatures);
  const coreAnalysis = best(coreSignatures);
  const analysis = [{ profile: "full", analysis: fullAnalysis }, {
    profile: "core",
    analysis: coreAnalysis,
  }]
    .filter((entry) => Boolean(entry.analysis))
    .sort((left, right) => compareRuleMechanismAnalyses(left.analysis, right.analysis))[0];
  if (!analysis) return null;
  return {
    ...analysis.analysis,
    profile: analysis.profile,
    fullScore: Number(fullAnalysis?.score || 0),
    fullQueryCoverage: Number(fullAnalysis?.queryCoverage || 0),
    fullQuestionCoverage: Number(fullAnalysis?.questionCoverage || 0),
    coreScore: Number(coreAnalysis?.score || 0),
    coreQueryCoverage: Number(coreAnalysis?.queryCoverage || 0),
    coreQuestionCoverage: Number(coreAnalysis?.questionCoverage || 0),
  };
}

function compareRuleMechanismCandidates(left, right) {
  const leftSignals = left?.retrievalSignals || {};
  const rightSignals = right?.retrievalSignals || {};
  return Number(rightSignals.mechanismFullQueryCoverage || 0)
      - Number(leftSignals.mechanismFullQueryCoverage || 0)
    || Number(rightSignals.mechanismFullScore || 0)
      - Number(leftSignals.mechanismFullScore || 0)
    || Number(rightSignals.mechanismFullQuestionCoverage || 0)
      - Number(leftSignals.mechanismFullQuestionCoverage || 0)
    || Number(rightSignals.mechanismCoreScore || 0)
      - Number(leftSignals.mechanismCoreScore || 0)
    || Number(rightSignals.mechanismCoreQueryCoverage || 0)
      - Number(leftSignals.mechanismCoreQueryCoverage || 0)
    || Number(rightSignals.mechanismCoreQuestionCoverage || 0)
      - Number(leftSignals.mechanismCoreQuestionCoverage || 0)
    || Number(rightSignals.mechanismAnalogueScore || 0)
      - Number(leftSignals.mechanismAnalogueScore || 0)
    || Number(right?.retrievalScore || 0) - Number(left?.retrievalScore || 0)
    || String(left?.id || "").localeCompare(String(right?.id || ""));
}

function reserveIdentitySourceCoverage(items = [], limit = 1, resolvedCards = []) {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const selected = [];
  const selectedKeys = new Set();
  const representedIds = new Set();
  const add = (item, assignedId = "") => {
    const key = stableRecordKey(item?.record || item);
    if (!key || selectedKeys.has(key) || selected.length >= safeLimit) return false;
    selected.push(item);
    selectedKeys.add(key);
    if (assignedId) representedIds.add(assignedId);
    return true;
  };

  // Reserve records that cover distinct question-side identity combinations
  // before filling by global rank. This keeps one multi-card interaction from
  // being reduced to independent same-card tails as synchronized corpora grow.
  const resolvedIds = new Set((resolvedCards || [])
    .map((card) => normalizeId(card?.id || card?.cardId))
    .filter(Boolean));
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
  const bestByIdentityGroup = new Map();
  for (const item of items || []) {
    const record = item?.record || item;
    const ids = [
      ...evidenceMatchedQuestionCardIds(item),
      ...(record.cardIds || []),
    ]
      .map(normalizeId)
      .filter((id) => !resolvedIds.size || resolvedIds.has(id))
      .sort();
    const names = [record.cardName, ...(record.cards || []), ...(record.cardNames || [])]
      .map(normalizeCardKey)
      .filter((name) => name && (!resolvedNames.size || resolvedNames.has(name)))
      .sort();
    const identities = [...new Set([
      ...ids.map((id) => `id:${id}`),
      ...names.map((name) => `name:${name}`),
    ])];
    if (!identities.length) continue;
    const group = identities.join("|");
    if (!bestByIdentityGroup.has(group)) bestByIdentityGroup.set(group, item);
  }
  const identityGroups = [...bestByIdentityGroup.entries()]
    .sort((left, right) => {
      const leftSize = left[0].split("|").length;
      const rightSize = right[0].split("|").length;
      return rightSize - leftSize || left[0].localeCompare(right[0]);
    });
  for (const [group, item] of identityGroups) {
    const identities = group.split("|");
    if (!identities.some((id) => !representedIds.has(id))) continue;
    if (add(item)) identities.forEach((id) => representedIds.add(id));
  }
  for (const item of items || []) add(item);
  const remaining = (items || []).filter(
    (item) => !selectedKeys.has(stableRecordKey(item?.record || item)),
  );
  return [...selected, ...remaining];
}

function evidenceMatchedQuestionCardIds(item = {}) {
  const record = item?.record || item;
  return [...new Set([
    ...relatedMatchedQuestionCardIds(item),
    ...principalQuestionCardIds(record),
  ].map(normalizeId).filter(Boolean))];
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
