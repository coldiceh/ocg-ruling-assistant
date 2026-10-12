import {createLocalCardDataProvider} from './cardDataProvider.mjs';
import {searchBaigeCards} from './baigeCardProvider.mjs';
import {extractRagCards, normalizeCardKey} from './ragCardExtractor.mjs';
import {callCardIdentitySelectionModel} from './ragModelClient.mjs';

export const CARD_CANDIDATE_CONFIRMATION_LIMITS = Object.freeze({
  mentions: 4, searchRequests: 2, localPerMention: 4,
  baigePerMention: 4, candidatesPerMention: 6, candidatesPerQuestion: 24,
  modelCalls: 1,
});

export async function confirmPendingCardCandidates({userQuery, cardResolution, cards = [],
  dataRevision, env = {}, identityCards = [], modelInvoker, fetchImpl = globalThis.fetch, dryRun, now, signal,
  confirmationAlreadyAttempted = false} = {}) {
  const startedAt = Date.now();
  const pending = new Map();
  const mark = mention => ({...mention, identitySelectionOwner: 'model_candidate_confirmation'});
  const resolution = {...cardResolution,
    unresolvedMentions: (cardResolution.unresolvedMentions || []).map(mark),
    ambiguousMentions: (cardResolution.ambiguousMentions || []).map(mark)};
  for (const mention of [...resolution.unresolvedMentions, ...resolution.ambiguousMentions]) {
    const key = normalizeCardKey(mention.input);
    if (key && !pending.has(key)) pending.set(key, mention);
  }
  const confirmation = {limits: CARD_CANDIDATE_CONFIRMATION_LIMITS, candidateSets: [],
    searchRequestCount: 0, searchCacheHitCount: 0, modelCallCount: 0, warnings: [],
    timingsMs: {search: 0, model: 0, total: 0}};
  const finish = selectionModel => {
    confirmation.timingsMs.total = Date.now() - startedAt;
    return {cardResolution: resolution, candidateConfirmation: confirmation, selectionModel};
  };
  if (confirmationAlreadyAttempted) {
    confirmation.warnings.push('card_candidate_confirmation_already_attempted');
    return finish(null);
  }
  if (!pending.size || dryRun === true || /^(1|true|yes|on)$/iu.test(String(env.RAG_DRY_RUN || ''))) return finish(null);

  const tcg = env.RAG_RULE_SYSTEM === 'TCG';
  // The identity bridge contributes names and CID only. Every candidate body
  // and selected record must come from this question's target TCG catalog.
  const nameCards = tcg ? [...cards, ...identityCards.map(card => ({
    id: card.id, cid: card.cid, name: card.name, cnName: card.cnName, jaName: card.jaName, enName: card.enName,
    aliases: card.aliases,
  }))] : cards;
  const localProvider = createLocalCardDataProvider({cards: nameCards});
  const catalogByCid = new Map(cards.map(card => [cidOf(card), card]));
  const groups = [];
  const searchStartedAt = Date.now();
  for (const mention of [...pending.values()].slice(0, CARD_CANDIDATE_CONFIRMATION_LIMITS.mentions)) {
    signal?.throwIfAborted?.();
    const local = localProvider.searchCardNameCandidates(mention.input, CARD_CANDIDATE_CONFIRMATION_LIMITS.localPerMention);
    const searchBudgetLeft = confirmation.searchRequestCount < CARD_CANDIDATE_CONFIRMATION_LIMITS.searchRequests;
    const external = searchBudgetLeft ? await searchBaigeCards(mention.input, {env, signal,
      candidatesOnly: true, maxRequests: 1, limit: CARD_CANDIDATE_CONFIRMATION_LIMITS.baigePerMention,
      fetchImpl: typeof fetchImpl === 'function' ? async (...args) => {
        // This is a directly counted HTTP limit, including provider fallbacks.
        if (confirmation.searchRequestCount >= CARD_CANDIDATE_CONFIRMATION_LIMITS.searchRequests) throw Error('card_candidate_search_limit');
        confirmation.searchRequestCount++;
        return fetchImpl(...args);
      } : fetchImpl}) : {results: [], warnings: ['card_candidate_search_budget_used'], cacheHit: false};
    confirmation.warnings.push(...external.warnings);
    confirmation.searchCacheHitCount += external.cacheHit ? 1 : 0;
    // The extractor's own formal-name proposal is one more catalog record for
    // the selector to read, never a binding. Surface results keep their order;
    // a proposal the surface search did not return is appended, replacing the
    // last surface candidate when the per-mention cap is already reached.
    const proposed = (mention.proposedCardIds || []).map(id => catalogByCid.get(String(id))).filter(Boolean)
      .map(card => tcg ? {...card, effectText: card.text || ''} : card);
    const unique = new Map();
    for (const source of [...local, ...(external.results || [])]) {
      const cid = cidOf(source, local.includes(source));
      if (!cid || unique.has(cid)) continue;
      const target = catalogByCid.get(cid);
      const record = tcg ? {
        ...(target || {id: cid, cid}),
        name: target?.name || source.name, cnName: source.cnName || target?.cnName,
        jaName: source.jaName || source.jpName || target?.jaName, enName: target?.enName || source.enName,
        effectText: target?.text || '',
      } : target || {...source, id: cid, cardId: cid,
        jaName: source.jaName || source.jpName || '', effectText: source.effectText || source.text || ''};
      if (!record.name && !record.cnName && !record.jaName && !record.enName) continue;
      unique.set(cid, record);
      if (unique.size >= CARD_CANDIDATE_CONFIRMATION_LIMITS.candidatesPerMention) break;
    }
    const proposedCids = new Set(proposed.map(card => cidOf(card)));
    for (const card of proposed) {
      const cid = cidOf(card);
      if (unique.has(cid)) continue;
      if (unique.size >= CARD_CANDIDATE_CONFIRMATION_LIMITS.candidatesPerMention) {
        const removable = [...unique.keys()].reverse().find(key => !proposedCids.has(key));
        if (!removable) continue;
        unique.delete(removable);
      }
      unique.set(cid, card);
    }
    if (unique.size) groups.push({input: mention.input, cards: [...unique.values()]});
  }
  confirmation.timingsMs.search = Date.now() - searchStartedAt;
  confirmation.candidateSets = groups.map((group, i) => ({mentionId: `M${i + 1}`, surface: group.input,
    candidates: group.cards.map((card, j) => ({candidateId: `C${j + 1}`, cid: cidOf(card),
      name: card.cnName || card.name || card.jaName || card.enName,
      aliases: [...new Set([card.name, card.cnName, card.jaName, card.enName].filter(Boolean))],
      typeLine: card.typeLine || catalogTypeLine(card), effectText: card.effectText, pendulumEffectText: card.pendulumEffectText}))}));
  if (!groups.length) return finish(null);
  signal?.throwIfAborted?.();
  const modelStartedAt = Date.now();
  confirmation.modelCallCount = 1;
  const selectionModel = await callCardIdentitySelectionModel({userQuery,
    candidateSets: confirmation.candidateSets, dataRevision,
    env: {...env, RAG_CARD_MODEL_PROVIDER: 'bai', BAI_CARD_ENABLED: 'true'},
    modelInvoker, fetchImpl, dryRun, now, signal});
  confirmation.timingsMs.model = Date.now() - modelStartedAt;
  const selectedKeys = new Set();
  const resolved = [...(resolution.resolvedCards || [])];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i], set = confirmation.candidateSets[i];
    const choices = new Set((selectionModel.selections || []).filter(row => row.mentionId === set.mentionId).map(row => row.candidateId));
    if (choices.size !== 1) continue;
    const index = set.candidates.findIndex(card => card.candidateId === [...choices][0]);
    if (index < 0) continue;
    // The existing selector parser validates handles. Copy the addressed record;
    // neither rank nor a name similarity score decides its identity.
    const source = group.cards[index];
    if (tcg && !catalogByCid.has(cidOf(source))) continue;
    // Build the record from the addressed card's own formal name, then keep
    // the player's wording as its input; the selector already decided identity.
    const formalName = source.name || source.cnName || source.jaName || source.enName;
    const selected = extractRagCards(formalName, {cards: [source], mentionSetSource: 'typed_model',
      modelCardNameCandidates: [{name: formalName, originalText: formalName}]}).resolvedCards[0];
    if (!selected) continue;
    resolved.push({...selected, input: group.input, cid: source.cid || source.id,
      resolutionSource: 'model_candidate_selection', identityVerificationStatus: 'verified_external_resolution',
      identityVerificationSource: 'model_candidate_selection'});
    selectedKeys.add(normalizeCardKey(group.input));
  }
  resolution.resolvedCards = resolved;
  resolution.unresolvedMentions = resolution.unresolvedMentions.filter(mention => !selectedKeys.has(normalizeCardKey(mention.input)));
  resolution.ambiguousMentions = resolution.ambiguousMentions.filter(mention => !selectedKeys.has(normalizeCardKey(mention.input)));
  return finish(selectionModel);
}

// Catalog records carry their kind as structured fields rather than a printed
// type line. Join those stored values verbatim so the selector can see, for
// example, that a candidate is a continuous rather than a field spell.
function catalogTypeLine(card = {}) {
  const kind = String(card.cardType || card.type || '').trim();
  const details = [card.property, ...(Array.isArray(card.properties) ? card.properties : [])]
    .map(value => String(value || '').trim()).filter(Boolean);
  return [...new Set([kind, ...details].filter(Boolean))].join('/');
}

function cidOf(card, local = true) {
  return String(card.cid || (local ? card.id || card.cardId : '') || '');
}
