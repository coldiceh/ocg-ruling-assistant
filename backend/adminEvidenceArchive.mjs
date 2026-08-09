import { createHash } from "node:crypto";

export const ADMIN_EVIDENCE_ARCHIVE_SCHEMA_VERSION = 1;
export const ADMIN_EVIDENCE_DECISION_PACKET_SCHEMA_VERSION = 2;

export const ADMIN_EVIDENCE_CATEGORIES = Object.freeze({
  DIRECT_OFFICIAL_QA: "direct_official_qa",
  PARSED_CARD_TEXT: "parsed_card_text",
  MECHANISM_RULE: "mechanism_rule",
  RELATED_QA: "related_qa",
  CONTEXT: "context",
  OTHER: "other",
});

export const DEFAULT_ADMIN_DECISION_PACKET_LIMITS = Object.freeze({
  maxPacketBytes: 28 * 1024,
  maxItems: 16,
  maxTotalBodyChars: 16_000,
  maxTotalBodyBytes: 20 * 1024,
  maxBodyCharsPerItem: 2_500,
  maxBodyBytesPerItem: 4 * 1024,
  maxEvidenceIdBytes: 160,
  maxConflictCatalogItems: 8,
  maxConflictItemBytes: 4 * 1024,
  maxConflictReferencesPerItem: 8,
});

const MAX_ADMIN_EVIDENCE_SELECTION_CONTEXT_ITEMS = 24;
const MAX_ADMIN_EVIDENCE_SELECTION_CONTEXT_CHARS = 24_000;
const MAX_ADMIN_EVIDENCE_SELECTION_CONTEXT_BYTES = 32 * 1024;

const MIN_ADMIN_DECISION_PACKET_BYTES = 4 * 1024;
const MIN_CONFLICT_ITEM_BYTES = 768;

const CATEGORY_PRIORITY = Object.freeze({
  [ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA]: 0,
  [ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT]: 1,
  [ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE]: 2,
  [ADMIN_EVIDENCE_CATEGORIES.RELATED_QA]: 3,
  [ADMIN_EVIDENCE_CATEGORIES.CONTEXT]: 4,
  [ADMIN_EVIDENCE_CATEGORIES.OTHER]: 5,
});

const QUESTION_FIELDS = new Set([
  "question",
  "rawquestion",
  "rawdetailedquestion",
  "scenario",
]);
const RULING_FIELDS = new Set([
  "answer",
  "conclusion",
  "officialtext",
  "rulingtext",
  "verdicttext",
  "explanation",
]);
const BODY_FIELDS = new Set([
  "fulltext",
  "effecttext",
  "cardtext",
  "text",
  "content",
  "body",
  "passage",
  "description",
]);
const ALL_SUBSTANTIVE_FIELDS = new Set([
  ...QUESTION_FIELDS,
  ...RULING_FIELDS,
  ...BODY_FIELDS,
]);
const OPERATIONAL_COLLECTION_PATTERN = /(?:unresolved|ambiguous|warning|query|debug|retrievedcards|fuzzyresolved|baigeresolved)/iu;
const TRUNCATION_WARNING_PATTERN = /(?:limited|truncated|limit_exceeded|candidate_pool_incomplete)/iu;
const CRITICAL_MECHANISM_FEATURE_IDS = Object.freeze([
  "simultaneous_trigger_order",
  "chain_resolution_reverse",
  "event_immediate_trigger_window",
  "zero_legal_candidate_activation",
]);
const ACTIVATION_CANDIDATE_REVIEW_PROTOCOL = Object.freeze([
  "check_trigger_conditions_and_every_mandatory_operation_separately",
  "count_only_candidates_that_can_legally_receive_the_required_operation_at_activation",
  "do_not_treat_zero_legal_candidates_as_an_empty_success_unless_visible_text_or_ruling_explicitly_allows_it",
  "an_affirmative_legality_conclusion_must_address_every_listed_constraint_or_explain_its_concrete_mismatch",
]);
const ACTIVATION_LEGALITY_QUESTION_PATTERNS = Object.freeze([
  /(?:(?:能否|能不能|可否|可不可以|是否可以|是否能够?).{0,20}(?:直接)?(?:连锁|連鎖|チェーン)?(?:.{0,8})?(?:发动|發動|発動))/isu,
  /(?:(?:可|可以|能够?|不能|无法|無法|不可以).{0,20}(?:直接)?(?:连锁|連鎖|チェーン)?(?:.{0,8})?(?:发动|發動|発動).{0,6}(?:吗|么|呢|[?？]))/isu,
  /(?:(?:为什么|為什麼|为何|為何|何故).{0,24}(?:不能|无法|無法|不可以)?(?:.{0,8})?(?:发动|發動|発動))/isu,
  /(?:(?:发动|發動|発動).{0,16}(?:是否合法|合不合法|能否成立|能不能成立|可以吗|能吗|可否|できる(?:か|[?？])|できますか|可能))/isu,
  /(?:(?:发动合法性|發動合法性|发动条件|發動條件|発動条件).{0,16}(?:是什么|是否满足|满足吗|为何|為何|怎么|如何|[?？])|(?:什么|哪些|怎样|如何).{0,16}(?:发动条件|發動條件|発動条件))/isu,
  /(?:what.{0,24}activation\s+(?:condition|requirement)|activation\s+(?:condition|legality).{0,24}(?:what|whether|satisfied|[?]))/isu,
  /(?:(?:can|may|could)\b.{0,40}\b(?:activate|be activated)\b|\bactivation\b.{0,24}\b(?:legal|allowed|possible)\b)/isu,
]);
const ACTIVATION_LEGALITY_NEGATED_INTENT_PATTERNS = Object.freeze([
  /(?:(?:不是|并非|並非|无需|無需|无须|無須|不用|不需要).{0,10}(?:询问|詢問|问|問|判断|判斷|讨论|討論|审查|審查|确认|確認).{0,24}(?:能否|是否|可否|可以|能够?)?.{0,10}(?:发动|發動|発動))/isu,
  /(?:(?:发动|發動|発動).{0,20}(?:无需|無需|无须|無須|不用|不需要).{0,8}(?:判断|判斷|讨论|討論|审查|審查|确认|確認))/isu,
  /(?:発動(?:できるか|可能か|の可否|条件).{0,16}(?:は)?(?:問わない|判断しない|確認不要|検討不要))/isu,
  /(?:\bnot\s+(?:asking|deciding|checking|reviewing|questioning)\b.{0,48}\bactivat)/isu,
]);

// These are card-name-neutral operation/mechanism features. They let the
// bounded model packet retain rules about operations that actually occur in
// the question or printed card text, without turning retrieval terms into a
// ruling or adding scenario-specific branches.
const MECHANISM_RELEVANCE_FEATURES = Object.freeze([
  feature("return_to_hand", 24, true, /(?:回手|(?:返回|放回|回到).{0,16}(?:手牌|手卡|手札)|手札.{0,10}(?:戻|返)|return.{0,24}(?:to )?(?:the )?hand)/isu),
  feature("return_to_deck", 24, true, /(?:(?:返回|放回|回到).{0,16}(?:卡组|牌组|デッキ)|デッキ.{0,10}(?:戻|返)|return.{0,24}(?:to )?(?:the )?deck)/isu),
  feature("destroy", 14, true, /(?:破坏|破壊|destroy)/iu),
  feature("banish", 14, true, /(?:除外|banish)/iu),
  feature("send_to_graveyard", 14, true, /(?:送去墓地|送入墓地|送墓|墓地へ送|send.{0,20}(?:to )?(?:the )?(?:graveyard|gy))/isu),
  feature("special_summon", 14, true, /(?:特殊召唤|特殊召喚|特殊召喚する|special summon)/iu),
  feature("summon_material", 14, true, /(?:融合素材|同调素材|同調素材|超量素材|连接素材|連結素材|リンク素材|仪式召唤.{0,12}解放|儀式召喚.{0,12}リリース|summon material)/isu),
  feature("negate", 14, true, /(?:无效|無效|negate)/iu),
  feature("target", 12, true, /(?:取对象|取對象|作为对象|作為對象|对象.{0,8}(?:不在|离开|丢失)|対象|target)/isu),
  feature("cost", 12, true, /(?:cost|コスト|支付|支払|作为代价|作為代價)/iu),
  feature("tribute", 12, true, /(?:解放|リリース|tribute)/iu),
  feature("draw", 10, true, /(?:抽卡|抽牌|ドロー|draw)/iu),
  feature("discard", 10, true, /(?:舍弃|丢弃|捨て|discard)/iu),
  feature("reveal", 10, true, /(?:公开|公開|给对方观看|給對方觀看|展示|見せ|reveal|show.{0,12}(?:hand|opponent))/isu),
  feature("control_change", 14, true, /(?:控制权|控制權|コントロール|control).{0,24}(?:变更|轉移|转移|改变|移|change|transfer|gain)/isu),
  feature("replacement", 16, true, /(?:(?:代替|替代).{0,12}(?:破坏|破壊|处理|處理)|(?:破坏|破壊).{0,12}(?:代替|替代|代わり)|replacement)/isu),
  feature("effect_duration_or_reapply", 12, true, /(?:只要.{0,24}存在|存在.{0,24}期间|存在する限り|恢复适用|恢復適用|重新适用|再次适用|再び適用|re-?appl)/isu),
  feature(
    "simultaneous_trigger_order",
    40,
    true,
    /(?:(?:同一|相同|同じ).{0,12}(?:时点|時點|タイミング).{0,32}(?:多个|多個|複数).{0,24}(?:诱发|誘発|效果|効果).{0,48}(?:顺序|順序|順番|优先|優先|连锁|連鎖|チェーン)|(?:必发|必發|必须发动|必須発動|必ず発動).{0,48}(?:选发|選發|任意|公開).{0,48}(?:顺序|順序|优先|優先|连锁|連鎖|チェーン)|(?:multiple|several).{0,24}trigger(?:ed)? effects?.{0,48}(?:same (?:time|timing)|chain order|priority))/isu,
    /(?:(?:同一|相同|同じ).{0,12}(?:时点|時點|タイミング).{0,48}(?:多个|多個|複数|诱发|誘発|效果|効果|发动|發動|発動)|(?:必发|必發|必须发动|必須発動|必ず発動).{0,80}(?:选发|選發|任意|可以发动|可以發動|発動できる)|(?:两个|兩個|多个|多個|两者|兩者).{0,32}(?:诱发|誘発|誘発効果|trigger(?:ed)? effect).{0,48}(?:连锁|連鎖|チェーン|顺序|順序|先后|先後)|(?:multiple|several).{0,24}trigger(?:ed)? effects?.{0,48}(?:same (?:time|timing)|chain order|priority))/isu,
  ),
  feature(
    "chain_resolution_reverse",
    38,
    true,
    /(?:(?:连锁|連鎖|チェーン|\bchain\b).{0,64}(?:逆序|逆順|倒序|从最后|從最後|最後.{0,12}(?:开始|開始|先|処理)|reverse order|last.{0,12}first)|(?:从|從).{0,12}(?:最后|最後)发动.{0,24}(?:开始|開始).{0,12}(?:处理|處理|结算|結算)|最後に発動.{0,24}(?:処理|解決)|resolve.{0,32}(?:reverse order|last.{0,12}first))/isu,
    /(?:(?:连锁|連鎖|チェーン|\bchain\b).{0,64}(?:逆序|逆順|倒序|从最后|從最後|最後.{0,12}(?:开始|開始|先|処理)|reverse order|last.{0,12}first)|(?:C(?:L)?1|连锁1|連鎖1|チェーン1).{0,200}(?:C(?:L)?2|连锁2|連鎖2|チェーン2).{0,200}(?:处理|處理|结算|結算|resolve)|(?:C(?:L)?2|连锁2|連鎖2|チェーン2).{0,200}(?:C(?:L)?1|连锁1|連鎖1|チェーン1).{0,200}(?:处理|處理|结算|結算|resolve))/isu,
  ),
  feature(
    "event_immediate_trigger_window",
    36,
    true,
    /(?:(?:召唤|召喚|特殊召唤|特殊召喚|同调召唤|同調召喚|S召唤|S召喚|シンクロ召喚).{0,24}(?:成功).{0,24}(?:直后|直後|之后|之後).{0,80}(?:发动|發動|発動|不能|できません)|(?:チェーン|连锁|連鎖).{0,24}(?:2|二).{0,80}(?:召唤|召喚).{0,80}(?:別の処理|其他处理|別の処理が行われた).{0,48}(?:发动|發動|発動|できません)|(?:召唤|召喚).{0,48}(?:后|後).{0,48}(?:其他处理|別の処理).{0,48}(?:不能发动|発動できません))/isu,
    /(?:(?:错过|錯過|没有错过|沒有錯過|miss(?:ed)?).{0,48}(?:召唤|召喚|特殊召唤|特殊召喚|同调召唤|同調召喚|S召唤|S召喚|シンクロ召喚)|(?:召唤|召喚|特殊召唤|特殊召喚|同调召唤|同調召喚|S召唤|S召喚|シンクロ召喚).{0,24}(?:时的时点|時的時點|成功直后|成功直後|後のタイミング|后的时点|後的時點)|(?:连锁|連鎖|チェーン|\bC(?:L)?\d+\b).{0,80}(?:召唤|召喚).{0,80}(?:召唤后还有|召喚後還有|召唤后另有|召喚後另有|後に別の処理))/isu,
  ),
  feature(
    "zero_legal_candidate_activation",
    42,
    true,
    /(?:(?:除自身以外|自身以外).{0,48}(?:没有|不存在|无).{0,16}(?:能|可).{0,12}(?:适用|處理|处理).{0,24}(?:不能|不可|无法).{0,12}(?:发动|發動|発動)|(?:no|zero).{0,32}(?:applicable|eligible|legal).{0,24}(?:card|candidate).{0,32}(?:cannot|can't|may not).{0,16}(?:activate|be activated))/isu,
    /(?:(?:没有其他|不存在其他|并无其他|無其他|无其他).{0,64}(?:魔法|陷阱|卡|候选|候選).{0,96}(?:能否|可否|能不能|可以|不能|无法|無法).{0,20}(?:发动|發動|発動)|(?:能否|可否|能不能|可以|不能|无法|無法).{0,20}(?:发动|發動|発動).{0,96}(?:没有其他|不存在其他|并无其他|無其他|无其他).{0,64}(?:魔法|陷阱|卡|候选|候選)|(?:no other|no applicable|zero (?:legal|eligible)).{0,64}(?:card|candidate).{0,64}(?:activate|activation))/isu,
  ),
  feature("timing_window", 12, true, /(?:发动时点|發動時點|时点|時点|错过时点|錯過時點|タイミング|timing window|miss.{0,12}timing)/isu),
  feature("sequential_processing", 10, true, /(?:然后|那之后|之后|之後|接着|再进行|その後|then|after that).{0,40}(?:处理|處理|适用|適用|进行|行う|resolve|apply)?/isu),
  feature("extra_deck_restriction", 14, true, /(?:不能|只能|不得|できない|のみ).{0,32}(?:额外卡组|額外牌組|エクストラデッキ|extra deck).{0,16}(?:特殊召唤|特殊召喚|special summon)|(?:额外卡组|額外牌組|エクストラデッキ|extra deck).{0,32}(?:不能|只能|不得|できない|のみ)/isu),
  feature("spell_trap", 6, false, /(?:魔法.{0,4}陷阱|魔法.{0,4}罠|魔陷|spell.{0,8}trap)/isu),
  feature("monster", 3, false, /(?:怪兽|怪獸|モンスター|monster)/iu),
  feature("chain", 7, false, /(?:连锁|連鎖|チェーン|\bchain\b|\bC\d+\b)/iu),
  feature("activated_card_pending", 10, false, /(?:正在发动|發動中的|发动后|發動後|连锁处理中|連鎖處理中|チェーン処理中|activated.{0,24}(?:card|spell|trap)|pending.{0,16}(?:chain|resolution))/isu),
  feature("activation_legality", 4, false, /(?:(?:可以|能|可否|能否|不能|无法|不得).{0,16}(?:发动|發動|発動)|(?:发动|發動|発動).{0,16}(?:条件|合法|できる|できない)|activation.{0,16}(?:legal|condition|require))/isu),
  feature("mandatory_processing", 5, false, /(?:必须|必須|必ず|必做|必须进行|must|mandatory)/iu),
  feature("no_applicable_candidate", 7, false, /(?:没有其他|不存在其他|并无其他|无其他|没有.{0,16}(?:能够|可以|可)|没有可|不存在可|no other|no applicable|none available)/isu),
  feature("field", 3, false, /(?:场上|場上|フィールド|on (?:the )?field)/iu),
  feature("hand", 3, false, /(?:手牌|手卡|手札|\bhand\b)/iu),
  feature("deck", 3, false, /(?:卡组|牌组|デッキ|\bdeck\b)/iu),
  feature("graveyard", 3, false, /(?:墓地|graveyard|\bGY\b)/iu),
]);

const NON_STAYING_ACTIVATED_SPELL_TRAP_PATTERN = /(?:(?:发动|發動)(?:后|後).{0,20}(?:不能|不会|無法|无法|不得).{0,16}(?:留在|停留|存在于|存在於).{0,12}(?:场上|場上|フィールド)|(?:发动|發動).{0,48}(?:连锁|連鎖).{0,24}(?:处理完毕|處理完畢|处理结束|處理結束).{0,24}(?:送去|送入|送往).{0,10}墓地|発動後.{0,24}フィールド.{0,20}(?:残ら|存在しない)|発動.{0,48}チェーン.{0,24}(?:処理|解決).{0,24}墓地へ送ら|(?:spell|trap).{0,80}(?:does not|doesn't|cannot|can't).{0,16}remain.{0,20}field|(?:after|when).{0,32}(?:resolves|resolution).{0,32}(?:sent|send).{0,16}(?:graveyard|\bGY\b))/isu;
const PENDING_RETURN_PROHIBITION_PATTERN = /(?:(?:不能|无法|無法|不得|不可以).{0,48}(?:回到|返回|放回).{0,24}(?:手牌|手卡|卡组|牌组)|(?:手札|デッキ).{0,32}戻.{0,20}(?:できない|できません)|(?:cannot|can't|may not).{0,48}(?:return|returned).{0,24}(?:hand|deck))/isu;

/**
 * Builds a lossless audit archive for the candidate collections supplied by
 * the deterministic retriever.
 *
 * Every occurrence is retained. Repeated normalized body text is stored once
 * in `documents`; occurrences refer to it by hash. Retrieval wrappers and
 * ranking metadata are hashed separately from ruling substance, so the same
 * evidence id in a flat record, an official-match wrapper, or a nested
 * `rawRecord` does not become a conflict merely because fields differ.
 *
 * This module never accepts a cheap-model selection. It archives all supplied
 * collections and records that the final ruling authority remains external.
 */
export function createAdminEvidenceArchive({
  evidenceBuckets = {},
  cardTextCandidates = null,
  collections = [],
  retrievalWarnings = [],
  metadata = {},
} = {}) {
  const normalizedCollections = collectAdminEvidenceCollections({
    evidenceBuckets,
    cardTextCandidates,
    collections,
  });
  const documents = new Map();
  const wrappers = new Map();
  const substances = new Map();
  const occurrences = [];
  let inputCandidateBytes = 0;

  for (const collection of normalizedCollections) {
    collection.items.forEach((rawItem, index) => {
      const item = normalizeCandidateInput(rawItem);
      const canonicalItem = canonicalizeJson(item);
      inputCandidateBytes += byteLength(canonicalStringify(canonicalItem));
      const evidenceId = evidenceIdFor(item);
      const category = classifyEvidenceCategory({
        item,
        collectionName: collection.name,
        categoryHint: collection.categoryHint,
      });
      const substance = extractNormalizedSubstance(item, category);
      const bodyText = renderSubstanceBody(substance);
      const bodyHash = bodyText ? sha256(bodyText) : null;
      if (bodyHash && !documents.has(bodyHash)) {
        documents.set(bodyHash, {
          bodyHash,
          text: bodyText,
          charCount: bodyText.length,
          byteCount: byteLength(bodyText),
        });
      }

      const substanceDescriptor = createSubstanceDescriptor(substance, bodyHash);
      const substanceHash = sha256(canonicalStringify(substanceDescriptor));
      if (!substances.has(substanceHash)) {
        substances.set(substanceHash, {
          substanceHash,
          ...substanceDescriptor,
        });
      }

      const wrapper = stripSubstantiveText(canonicalItem);
      const wrapperHash = sha256(canonicalStringify(wrapper));
      if (!wrappers.has(wrapperHash)) {
        wrappers.set(wrapperHash, {
          wrapperHash,
          metadata: wrapper,
          byteCount: byteLength(canonicalStringify(wrapper)),
        });
      }

      const candidateHash = sha256(canonicalStringify(canonicalItem));
      const occurrenceSeed = canonicalStringify({
        collection: collection.name,
        index,
        candidateHash,
      });
      const occurrenceId = `occ_${sha256(occurrenceSeed).slice(0, 24)}`;
      const signals = evidenceSignals(item, category);
      occurrences.push({
        occurrenceId,
        collection: collection.name,
        index,
        evidenceId,
        category,
        candidateHash,
        wrapperHash,
        substanceHash,
        bodyHash,
        textFieldPaths: substantiveTextFieldPaths(canonicalItem),
        ...signals,
      });
    });
  }

  occurrences.sort(compareOccurrences);
  const evidenceIndex = buildEvidenceIndex(occurrences);
  const conflicts = detectSubstanceConflicts({
    evidenceIndex,
    occurrences,
    substances,
    documents,
  });
  const normalizedWarnings = canonicalizeJson(
    Array.isArray(retrievalWarnings) ? retrievalWarnings : [],
  );
  const archiveContent = canonicalizeJson({
    policy: {
      finalRulingAuthority: "gpt_final_model",
      preparationModelCanMakeFinalRuling: false,
      preparationModelCanDeleteCandidates: false,
      candidateSelection: "archive_every_supplied_occurrence",
    },
    collections: normalizedCollections.map((collection) => ({
      name: collection.name,
      categoryHint: collection.categoryHint,
      occurrenceCount: collection.items.length,
    })),
    documents: [...documents.values()].sort(compareBy("bodyHash")),
    wrappers: [...wrappers.values()].sort(compareBy("wrapperHash")),
    substances: [...substances.values()].sort(compareBy("substanceHash")),
    occurrences,
    evidenceIndex,
    conflicts,
    retrievalWarnings: normalizedWarnings,
    metadata: canonicalizeJson(metadata),
    statistics: buildArchiveStatistics({
      normalizedCollections,
      documents,
      wrappers,
      substances,
      occurrences,
      evidenceIndex,
      conflicts,
      inputCandidateBytes,
    }),
    completeness: buildArchiveCompleteness({
      retrievalWarnings: normalizedWarnings,
      occurrenceCount: occurrences.length,
      expectedOccurrenceCount: normalizedCollections.reduce(
        (total, collection) => total + collection.items.length,
        0,
      ),
    }),
  });
  const contentSha256 = sha256(canonicalStringify(archiveContent));
  const archive = deepFreeze({
    schemaVersion: ADMIN_EVIDENCE_ARCHIVE_SCHEMA_VERSION,
    archiveId: `evidence_archive_${contentSha256.slice(0, 24)}`,
    contentSha256,
    ...archiveContent,
  });
  assertAdminEvidenceArchive(archive);
  return archive;
}

/**
 * Returns the deterministic candidate collections consumed by the archive.
 * All array-valued evidence buckets are retained, including unknown future
 * buckets. Operational arrays are marked as context rather than discarded.
 */
export function collectAdminEvidenceCollections({
  evidenceBuckets = {},
  cardTextCandidates = null,
  collections = [],
} = {}) {
  const result = [];
  if (isPlainObject(evidenceBuckets)) {
    for (const name of Object.keys(evidenceBuckets).sort()) {
      const items = evidenceBuckets[name];
      if (!Array.isArray(items)) continue;
      result.push({
        name: `evidenceBuckets.${name}`,
        categoryHint: categoryHintForCollection(name),
        items: canonicalizeJson(items),
      });
    }
  }
  if (isPlainObject(cardTextCandidates)) {
    for (const name of Object.keys(cardTextCandidates).sort()) {
      const items = cardTextCandidates[name];
      if (!Array.isArray(items)) continue;
      result.push({
        name: `cardTextCandidates.${name}`,
        categoryHint: name === "resolved"
          ? ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT
          : ADMIN_EVIDENCE_CATEGORIES.CONTEXT,
        items: canonicalizeJson(items),
      });
    }
  }
  if (!Array.isArray(collections)) {
    throw new TypeError("collections must be an array");
  }
  for (const [index, collection] of collections.entries()) {
    if (!isPlainObject(collection)) {
      throw new TypeError(`collections[${index}] must be an object`);
    }
    const name = nonEmptyString(collection.name, `collections[${index}].name`);
    if (!Array.isArray(collection.items)) {
      throw new TypeError(`collections[${index}].items must be an array`);
    }
    result.push({
      name: `collections.${name}`,
      categoryHint: normalizeCategoryHint(collection.categoryHint),
      items: canonicalizeJson(collection.items),
    });
  }
  result.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const duplicateNames = result
    .map((collection) => collection.name)
    .filter((name, index, values) => values.indexOf(name) !== index);
  if (duplicateNames.length > 0) {
    throw new TypeError(`duplicate evidence collection name: ${duplicateNames[0]}`);
  }
  return result;
}

/**
 * Creates a small audit-safe relevance context for bounded packet selection.
 * The context influences ordering only: it cannot add, delete, or reinterpret
 * evidence, and it is never treated as a source supporting the final ruling.
 */
export function createAdminEvidenceSelectionContext({
  question = "",
  questions = [],
  providedFacts = [],
} = {}) {
  const questionTexts = [
    question,
    ...arrayValue(questions).map((item) => (
      typeof item === "string" ? item : item?.text || item?.question || ""
    )),
  ];
  const sourceTexts = [
    ...questionTexts,
    ...arrayValue(providedFacts).flatMap((item) => selectionContextScalarStrings(item)),
  ];
  const texts = [];
  const seen = new Set();
  let usedChars = 0;
  let usedBytes = 0;
  let truncated = false;
  for (const sourceText of sourceTexts) {
    if (texts.length >= MAX_ADMIN_EVIDENCE_SELECTION_CONTEXT_ITEMS) {
      truncated = true;
      break;
    }
    const normalized = normalizeSubstantiveText(sourceText);
    if (!normalized || seen.has(normalized)) continue;
    const remainingChars = MAX_ADMIN_EVIDENCE_SELECTION_CONTEXT_CHARS - usedChars;
    const remainingBytes = MAX_ADMIN_EVIDENCE_SELECTION_CONTEXT_BYTES - usedBytes;
    if (remainingChars <= 0 || remainingBytes <= 0) {
      truncated = true;
      break;
    }
    const bounded = utf8PrefixWithin(normalized, remainingChars, remainingBytes);
    if (!bounded) {
      truncated = true;
      break;
    }
    texts.push(bounded);
    seen.add(normalized);
    usedChars += bounded.length;
    usedBytes += byteLength(bounded);
    if (bounded.length < normalized.length) {
      truncated = true;
      break;
    }
  }
  return canonicalizeJson({
    role: "packet_selection_relevance_only",
    asksActivationLegality: questionTexts.some(questionAsksActivationLegality),
    texts,
    truncated,
    charCount: usedChars,
    byteCount: usedBytes,
  });
}

/**
 * Creates two outputs:
 * - `modelPacket`: bounded evidence content suitable for the final GPT model.
 * - audit sidecars (`includedManifest`, `omittedManifest`,
 *   `truncationManifest`) that retain every decision and hash without putting
 *   an unbounded omission list into model input.
 *
 * Selection is deterministic and authority/mechanism based. It is never based
 * on a preparation-model shortlist.
 */
export function buildAdminEvidenceDecisionPacket({
  archive,
  limits = {},
} = {}) {
  assertAdminEvidenceArchive(archive);
  const normalizedLimits = normalizeDecisionPacketLimits(limits);
  const {
    candidates,
    requiredCriticalMechanisms,
    asksActivationLegality,
  } = aggregateDecisionCandidates(archive);
  const includedSelections = [];
  const omittedManifest = [];
  const truncationBySubstance = new Map();
  let usedBodyChars = 0;
  let usedBodyBytes = 0;

  for (const candidate of candidates) {
    if (includedSelections.length >= normalizedLimits.maxItems) {
      omittedManifest.push(omittedEntry(candidate, "item_limit"));
      continue;
    }
    const remainingChars = normalizedLimits.maxTotalBodyChars - usedBodyChars;
    const remainingBytes = normalizedLimits.maxTotalBodyBytes - usedBodyBytes;
    if (remainingChars <= 0 || remainingBytes <= 0) {
      omittedManifest.push(omittedEntry(
        candidate,
        remainingChars <= 0
          ? "total_body_character_budget"
          : "total_body_byte_budget",
      ));
      continue;
    }
    const candidateBodyLimits = bodyLimitsForCandidate(
      candidate,
      normalizedLimits,
    );
    const allowedChars = Math.min(remainingChars, candidateBodyLimits.maxChars);
    const allowedBytes = Math.min(remainingBytes, candidateBodyLimits.maxBytes);
    if (
      (allowedChars < 64 || allowedBytes < 128)
      && (
        candidate.bodyText.length > allowedChars
        || byteLength(candidate.bodyText) > allowedBytes
      )
    ) {
      omittedManifest.push(omittedEntry(candidate, "insufficient_remaining_body_budget"));
      continue;
    }
    const bounded = boundedEvidenceBody(candidate.bodyText, {
      maxChars: allowedChars,
      maxBytes: allowedBytes,
    });
    usedBodyChars += bounded.text.length;
    usedBodyBytes += byteLength(bounded.text);
    includedSelections.push({
      candidate,
      item: modelEvidenceItem(candidate, bounded, normalizedLimits),
    });
    if (bounded.truncated) {
      truncationBySubstance.set(
        candidate.substanceHash,
        truncationEntry(
          candidate,
          bounded,
          initialBodyTruncationReason({
            candidate,
            allowedChars,
            allowedBytes,
            bodyLimits: candidateBodyLimits,
          }),
        ),
      );
    }
  }

  let conflictCatalogLimit = Math.min(
    normalizedLimits.maxConflictCatalogItems,
    archive.conflicts.length,
  );
  let packetSnapshot;

  for (;;) {
    const truncationManifest = [...truncationBySubstance.values()]
      .sort(compareBy("substanceHash"));
    packetSnapshot = createModelPacketSnapshot({
      archive,
      includedSelections,
      omittedManifest,
      truncationManifest,
      limits: normalizedLimits,
      conflictCatalogLimit,
      requiredCriticalMechanisms,
      asksActivationLegality,
      archiveSubstanceCount: archive.substances.length,
    });
    if (packetSnapshot.bytes <= normalizedLimits.maxPacketBytes) break;

    if (conflictCatalogLimit > 0) {
      conflictCatalogLimit = Math.floor(conflictCatalogLimit / 2);
      continue;
    }

    const bodySelection = largestVisibleBodySelection(includedSelections);
    if (bodySelection && byteLength(bodySelection.item.body) > 0) {
      const excessBytes = packetSnapshot.bytes - normalizedLimits.maxPacketBytes;
      const currentBodyBytes = byteLength(bodySelection.item.body);
      const nextBodyBytes = Math.max(
        0,
        currentBodyBytes - excessBytes - 256,
      );
      const bounded = boundedEvidenceBody(bodySelection.candidate.bodyText, {
        maxChars: bodySelection.item.body.length,
        maxBytes: nextBodyBytes,
      });
      bodySelection.item = modelEvidenceItem(
        bodySelection.candidate,
        bounded,
        normalizedLimits,
      );
      truncationBySubstance.set(
        bodySelection.candidate.substanceHash,
        truncationEntry(bodySelection.candidate, bounded, "packet_byte_budget"),
      );
      continue;
    }

    const removed = includedSelections.pop();
    if (removed) {
      omittedManifest.push(omittedEntry(removed.candidate, "packet_byte_budget"));
      truncationBySubstance.delete(removed.candidate.substanceHash);
      continue;
    }

    throw new RangeError(
      `maxPacketBytes is too small for the bounded decision packet envelope (${packetSnapshot.bytes} bytes)`,
    );
  }

  const modelPacketContent = packetSnapshot.modelPacket;
  const includedManifest = createIncludedManifest(includedSelections);
  const truncationManifest = [...truncationBySubstance.values()]
    .sort(compareBy("substanceHash"));
  usedBodyChars = includedSelections.reduce(
    (total, entry) => total + entry.item.body.length,
    0,
  );
  usedBodyBytes = includedSelections.reduce(
    (total, entry) => total + byteLength(entry.item.body),
    0,
  );
  const modelPacketBytes = byteLength(JSON.stringify(modelPacketContent));
  if (modelPacketBytes > normalizedLimits.maxPacketBytes) {
    throw new Error("internal error: decision packet exceeded maxPacketBytes");
  }
  const packetContentSha256 = sha256(canonicalStringify(modelPacketContent));
  const result = deepFreeze({
    schemaVersion: ADMIN_EVIDENCE_DECISION_PACKET_SCHEMA_VERSION,
    decisionPacketId: `decision_packet_${packetContentSha256.slice(0, 24)}`,
    packetContentSha256,
    modelPacket: modelPacketContent,
    includedManifest,
    omittedManifest,
    truncationManifest,
    conflictManifest: archive.conflicts,
    statistics: {
      archiveSubstanceCount: archive.substances.length,
      decisionCandidateCount: candidates.length,
      includedSubstanceCount: includedSelections.length,
      omittedSubstanceCount: omittedManifest.length,
      excerptedSubstanceCount: truncationManifest.length,
      usedBodyChars,
      usedBodyBytes,
      availableBodyChars: normalizedLimits.maxTotalBodyChars,
      availableBodyBytes: normalizedLimits.maxTotalBodyBytes,
      modelPacketBytes,
      maxPacketBytes: normalizedLimits.maxPacketBytes,
      includedManifestBytes: byteLength(canonicalStringify(includedManifest)),
      omittedManifestBytes: byteLength(canonicalStringify(omittedManifest)),
      omittedCatalogBytes: 0,
      truncationManifestBytes: byteLength(canonicalStringify(truncationManifest)),
      conflictManifestBytes: byteLength(canonicalStringify(archive.conflicts)),
      conflictCatalogBytes: byteLength(canonicalStringify(modelPacketContent.conflicts)),
    },
  });
  return result;
}

export function verifyAdminEvidenceArchive(archive) {
  const errors = [];
  if (!isPlainObject(archive)) {
    return { ok: false, errors: ["archive must be an object"] };
  }
  if (archive.schemaVersion !== ADMIN_EVIDENCE_ARCHIVE_SCHEMA_VERSION) {
    errors.push("unsupported evidence archive schema version");
  }
  const documents = new Map();
  for (const document of arrayValue(archive.documents)) {
    if (sha256(String(document?.text || "")) !== document?.bodyHash) {
      errors.push(`document body hash mismatch: ${document?.bodyHash || "missing"}`);
    }
    if (documents.has(document?.bodyHash)) {
      errors.push(`duplicate document body hash: ${document?.bodyHash}`);
    }
    documents.set(document?.bodyHash, document);
  }
  const wrappers = new Map();
  for (const wrapper of arrayValue(archive.wrappers)) {
    const expected = sha256(canonicalStringify(canonicalizeJson(wrapper?.metadata ?? {})));
    if (expected !== wrapper?.wrapperHash) {
      errors.push(`wrapper hash mismatch: ${wrapper?.wrapperHash || "missing"}`);
    }
    wrappers.set(wrapper?.wrapperHash, wrapper);
  }
  const substances = new Map();
  for (const substance of arrayValue(archive.substances)) {
    const descriptor = {
      kind: substance?.kind,
      fields: substance?.fields,
      bodyHash: substance?.bodyHash ?? null,
    };
    const expected = sha256(canonicalStringify(canonicalizeJson(descriptor)));
    if (expected !== substance?.substanceHash) {
      errors.push(`substance hash mismatch: ${substance?.substanceHash || "missing"}`);
    }
    if (substance?.bodyHash && !documents.has(substance.bodyHash)) {
      errors.push(`substance references missing body: ${substance.bodyHash}`);
    }
    substances.set(substance?.substanceHash, substance);
  }
  const occurrenceIds = new Set();
  for (const occurrence of arrayValue(archive.occurrences)) {
    if (occurrenceIds.has(occurrence?.occurrenceId)) {
      errors.push(`duplicate occurrence id: ${occurrence?.occurrenceId}`);
    }
    occurrenceIds.add(occurrence?.occurrenceId);
    if (!wrappers.has(occurrence?.wrapperHash)) {
      errors.push(`occurrence references missing wrapper: ${occurrence?.wrapperHash}`);
    }
    if (!substances.has(occurrence?.substanceHash)) {
      errors.push(`occurrence references missing substance: ${occurrence?.substanceHash}`);
    }
    if (occurrence?.bodyHash && !documents.has(occurrence.bodyHash)) {
      errors.push(`occurrence references missing body: ${occurrence.bodyHash}`);
    }
  }
  if (isPlainObject(archive) && archive.contentSha256) {
    const {
      schemaVersion: _schemaVersion,
      archiveId: _archiveId,
      contentSha256: _contentSha256,
      ...content
    } = archive;
    const expected = sha256(canonicalStringify(canonicalizeJson(content)));
    if (expected !== archive.contentSha256) {
      errors.push("archive content hash mismatch");
    }
    if (`evidence_archive_${expected.slice(0, 24)}` !== archive.archiveId) {
      errors.push("archive id mismatch");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function assertAdminEvidenceArchive(archive) {
  const verification = verifyAdminEvidenceArchive(archive);
  if (!verification.ok) {
    throw new Error(`invalid admin evidence archive: ${verification.errors.join("; ")}`);
  }
  return archive;
}

function categoryHintForCollection(name) {
  const value = String(name || "").toLowerCase();
  if (value === "officialqadirectcandidates") {
    return ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA;
  }
  if (/(?:cardtexts|userprovidedcardtexts)/u.test(value)) {
    return ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT;
  }
  if (/rulebook/u.test(value)) {
    return ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE;
  }
  if (/(?:officialqarelated|faqrelated|provisionalofficialresponses)/u.test(value)) {
    return ADMIN_EVIDENCE_CATEGORIES.RELATED_QA;
  }
  if (OPERATIONAL_COLLECTION_PATTERN.test(value)) {
    return ADMIN_EVIDENCE_CATEGORIES.CONTEXT;
  }
  return null;
}

function normalizeCategoryHint(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value);
  if (!Object.values(ADMIN_EVIDENCE_CATEGORIES).includes(normalized)) {
    throw new TypeError(`unsupported evidence category hint: ${normalized}`);
  }
  return normalized;
}

function classifyEvidenceCategory({ item, collectionName, categoryHint }) {
  const typeText = [
    collectionName,
    findFirstScalar(item, ["type"]),
    findFirstScalar(item, ["sourcetype"]),
    findFirstScalar(item, ["recordtype"]),
    findFirstScalar(item, ["source"]),
  ].filter(Boolean).join(" ").toLowerCase();
  const direct = findFirstBoolean(item, ["isdirect"]) === true
    || categoryHint === ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA
    || /officialqadirect/u.test(typeText);
  const hasQaSubstance = hasAnyField(item, QUESTION_FIELDS)
    && hasAnyField(item, RULING_FIELDS);
  if (direct && (
    /(?:official|qa|faq|ruling)/u.test(typeText)
    || hasQaSubstance
  )) {
    return ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA;
  }
  if (/(?:card[_ -]?text|cardtext|effecttext|parsed.?card)/u.test(typeText)
    || hasAnyField(item, new Set(["effecttext", "cardtext"]))) {
    return ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT;
  }
  if (/(?:rulebook|ocg.?rule|mechanism|master.?rule|rule_reference)/u.test(typeText)) {
    return ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE;
  }
  if (/(?:official|qa|faq|ruling)/u.test(typeText)
    || hasQaSubstance) {
    return ADMIN_EVIDENCE_CATEGORIES.RELATED_QA;
  }
  if (categoryHint) return categoryHint;
  if (OPERATIONAL_COLLECTION_PATTERN.test(collectionName)) {
    return ADMIN_EVIDENCE_CATEGORIES.CONTEXT;
  }
  return ADMIN_EVIDENCE_CATEGORIES.OTHER;
}

function evidenceIdFor(item) {
  const explicit = findFirstScalar(item, [
    "id",
    "evidenceid",
    "stableid",
    "sourceid",
  ]);
  if (explicit) return explicit;
  const cardId = findFirstScalar(item, ["cardid"]);
  if (cardId && hasAnyField(item, new Set(["effecttext", "cardtext"]))) {
    return `card-text-${cardId}`;
  }
  const candidateHash = sha256(canonicalStringify(canonicalizeJson(item)));
  return `anonymous-evidence-${candidateHash.slice(0, 24)}`;
}

function extractNormalizedSubstance(item, category) {
  const questionCandidates = collectNamedStrings(item, QUESTION_FIELDS);
  const rulingCandidates = collectNamedStrings(item, RULING_FIELDS);
  const bodyCandidates = collectNamedStrings(item, BODY_FIELDS);
  const kind = substanceKind(category, item);
  if (kind === "ruling_qa") {
    const question = chooseSemanticValue(questionCandidates, [
      "question",
      "rawquestion",
      "rawdetailedquestion",
      "scenario",
    ]);
    let ruling = chooseSemanticValue(rulingCandidates, [
      "answer",
      "conclusion",
      "officialtext",
      "rulingtext",
      "verdicttext",
      "explanation",
    ]);
    const main = chooseSemanticValue(bodyCandidates, [
      "fulltext",
      "text",
      "content",
      "body",
      "passage",
      "description",
    ]);
    if (!ruling) ruling = removeQuestionPrefix(main, question);
    return {
      kind,
      fields: [
        ["question", question],
        ["ruling", ruling || main],
      ].filter(([, value]) => value),
    };
  }
  if (kind === "card_text") {
    const printedText = chooseSemanticValue(bodyCandidates, [
      "effecttext",
      "cardtext",
      "fulltext",
      "text",
      "content",
      "body",
    ]) || chooseSemanticValue(rulingCandidates);
    return {
      kind,
      fields: printedText ? [["printed_text", printedText]] : [],
    };
  }
  const text = chooseSemanticValue(bodyCandidates, [
    "fulltext",
    "passage",
    "text",
    "content",
    "body",
    "description",
  ]) || chooseSemanticValue(rulingCandidates) || chooseSemanticValue(questionCandidates);
  return {
    kind,
    fields: text ? [["text", text]] : [],
  };
}

function substanceKind(category, item) {
  if (category === ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT) return "card_text";
  if (category === ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA
    || category === ADMIN_EVIDENCE_CATEGORIES.RELATED_QA
    || hasAnyField(item, QUESTION_FIELDS) && hasAnyField(item, RULING_FIELDS)) {
    return "ruling_qa";
  }
  if (category === ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE) return "mechanism_rule";
  return "evidence_text";
}

function createSubstanceDescriptor(substance, bodyHash) {
  return {
    kind: substance.kind,
    fields: substance.fields.map(([name, value]) => ({
      name,
      valueHash: sha256(value),
      charCount: value.length,
    })),
    bodyHash,
  };
}

function renderSubstanceBody(substance) {
  if (!substance.fields.length) return "";
  if (substance.kind === "ruling_qa") {
    const values = Object.fromEntries(substance.fields);
    return [
      values.question ? `Question:\n${values.question}` : "",
      values.ruling ? `Ruling:\n${values.ruling}` : "",
    ].filter(Boolean).join("\n\n");
  }
  return substance.fields.map(([, value]) => value).join("\n\n");
}

function collectNamedStrings(value, acceptedFields, path = "$", output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectNamedStrings(
      item,
      acceptedFields,
      `${path}[${index}]`,
      output,
    ));
    return output;
  }
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    const normalizedKey = normalizeFieldName(key);
    if (acceptedFields.has(normalizedKey) && typeof child === "string") {
      const normalizedValue = normalizeSubstantiveText(child);
      if (normalizedValue) {
        output.push({
          field: normalizedKey,
          value: normalizedValue,
          path: `${path}.${key}`,
        });
      }
    }
    if (child && typeof child === "object") {
      collectNamedStrings(child, acceptedFields, `${path}.${key}`, output);
    }
  }
  return output;
}

function chooseSemanticValue(candidates, priority = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const priorityIndex = new Map(priority.map((field, index) => [field, index]));
  return [...candidates]
    .sort((left, right) => (
      (priorityIndex.get(left.field) ?? 999) - (priorityIndex.get(right.field) ?? 999)
      || right.value.length - left.value.length
      || left.value.localeCompare(right.value, "en")
      || left.path.localeCompare(right.path, "en")
    ))[0].value;
}

function removeQuestionPrefix(text, question) {
  if (!text) return "";
  if (!question) return text;
  if (text === question) return "";
  if (text.startsWith(question)) {
    return text.slice(question.length).replace(/^[\s:：\-—]+/u, "").trim();
  }
  return text;
}

function normalizeSubstantiveText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t \f\v]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function stripSubstantiveText(value) {
  if (Array.isArray(value)) return value.map(stripSubstantiveText);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (ALL_SUBSTANTIVE_FIELDS.has(normalizeFieldName(key))) continue;
    result[key] = stripSubstantiveText(value[key]);
  }
  return result;
}

function substantiveTextFieldPaths(value, path = "$", output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => substantiveTextFieldPaths(item, `${path}[${index}]`, output));
    return output;
  }
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    const childPath = `${path}.${key}`;
    if (ALL_SUBSTANTIVE_FIELDS.has(normalizeFieldName(key)) && typeof child === "string") {
      output.push(childPath);
    } else if (child && typeof child === "object") {
      substantiveTextFieldPaths(child, childPath, output);
    }
  }
  return output;
}

function evidenceSignals(item, category) {
  const currentStatus = findFirstScalar(item, ["status", "displaystatus", "maxstatus"]);
  const direct = category === ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA
    || findFirstBoolean(item, ["isdirect"]) === true;
  const official = direct
    || findFirstBoolean(item, ["official"]) === true
    || /official/iu.test(String(findFirstScalar(item, ["sourcetype", "source", "recordtype"]) || ""));
  const current = !/(?:outdated|obsolete|archived|superseded|historic)/iu.test(currentStatus);
  const scoreValue = Number(findFirstScalar(item, ["score"]));
  return {
    authority: official ? "official" : "other",
    direct,
    current,
    relevanceScore: Number.isFinite(scoreValue) ? scoreValue : null,
  };
}

function buildEvidenceIndex(occurrences) {
  const byId = new Map();
  for (const occurrence of occurrences) {
    const entry = byId.get(occurrence.evidenceId) || {
      evidenceId: occurrence.evidenceId,
      occurrenceIds: [],
      substanceHashes: [],
      bodyHashes: [],
      categories: [],
    };
    entry.occurrenceIds.push(occurrence.occurrenceId);
    if (!entry.substanceHashes.includes(occurrence.substanceHash)) {
      entry.substanceHashes.push(occurrence.substanceHash);
    }
    if (occurrence.bodyHash && !entry.bodyHashes.includes(occurrence.bodyHash)) {
      entry.bodyHashes.push(occurrence.bodyHash);
    }
    if (!entry.categories.includes(occurrence.category)) {
      entry.categories.push(occurrence.category);
    }
    byId.set(occurrence.evidenceId, entry);
  }
  return [...byId.values()]
    .map((entry) => ({
      ...entry,
      occurrenceIds: [...entry.occurrenceIds].sort(),
      substanceHashes: [...entry.substanceHashes].sort(),
      bodyHashes: [...entry.bodyHashes].sort(),
      categories: [...entry.categories].sort(),
    }))
    .sort(compareBy("evidenceId"));
}

function detectSubstanceConflicts({
  evidenceIndex,
  occurrences,
  substances,
  documents,
}) {
  const occurrenceById = new Map(occurrences.map((item) => [item.occurrenceId, item]));
  const conflicts = [];
  for (const entry of evidenceIndex) {
    if (entry.substanceHashes.length <= 1) continue;
    const variants = entry.substanceHashes
      .map((hash) => substances.get(hash))
      .filter(Boolean);
    const incompatiblePairs = [];
    for (let leftIndex = 0; leftIndex < variants.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < variants.length; rightIndex += 1) {
        if (!substancesCompatible(
          variants[leftIndex],
          variants[rightIndex],
          documents,
        )) {
          incompatiblePairs.push([
            variants[leftIndex].substanceHash,
            variants[rightIndex].substanceHash,
          ]);
        }
      }
    }
    if (incompatiblePairs.length === 0) continue;
    const occurrenceIds = entry.occurrenceIds.filter((occurrenceId) => (
      entry.substanceHashes.includes(occurrenceById.get(occurrenceId)?.substanceHash)
    ));
    conflicts.push({
      type: "evidence_id_substance_conflict",
      evidenceId: entry.evidenceId,
      substanceHashes: entry.substanceHashes,
      bodyHashes: entry.bodyHashes,
      occurrenceIds,
      incompatiblePairs,
      differenceSummary: summarizeSubstanceDifferences(variants),
    });
  }
  return conflicts.sort(compareBy("evidenceId"));
}

function substancesCompatible(left, right, documents) {
  if (left.bodyHash && left.bodyHash === right.bodyHash) return true;
  const leftBody = bodyTextForSubstance(left, documents);
  const rightBody = bodyTextForSubstance(right, documents);
  const leftQa = parseRenderedRulingQa(left, leftBody);
  const rightQa = parseRenderedRulingQa(right, rightBody);
  if (leftQa && rightQa
    && rulingQaPartsAppearInOrder(leftQa, rightQa)) {
    return true;
  }
  if (leftQa?.question && leftQa?.ruling
    && rightQa?.question && rightQa?.ruling) {
    return comparableTextContainsEither(leftQa.question, rightQa.question)
      && comparableTextContainsEither(leftQa.ruling, rightQa.ruling);
  }
  if (leftQa && rightQa) {
    const leftQaBody = [leftQa.question, leftQa.ruling].filter(Boolean).join("\n");
    const rightQaBody = [rightQa.question, rightQa.ruling].filter(Boolean).join("\n");
    if (comparableTextContainsEither(leftQaBody, rightQaBody)) return true;
  }
  if (leftQa && !rightQa) {
    if ([leftQa.question, leftQa.ruling]
      .filter(Boolean)
      .some((part) => comparableTextContainsEither(part, rightBody))) return true;
  }
  if (rightQa && !leftQa) {
    if ([rightQa.question, rightQa.ruling]
      .filter(Boolean)
      .some((part) => comparableTextContainsEither(leftBody, part))) return true;
  }
  if (comparableTextContainsEither(leftBody, rightBody)) return true;
  if (left.kind !== right.kind) return false;
  const leftFields = new Map(left.fields.map((field) => [field.name, field]));
  const rightFields = new Map(right.fields.map((field) => [field.name, field]));
  const sharedNames = [...leftFields.keys()].filter((name) => rightFields.has(name));
  if (sharedNames.length === 0) {
    return Boolean(left.bodyHash && left.bodyHash === right.bodyHash);
  }
  return sharedNames.every((name) => (
    leftFields.get(name).valueHash === rightFields.get(name).valueHash
  ));
}

function rulingQaPartsAppearInOrder(left, right) {
  if (left.question && left.ruling
    && comparableTextContainsPartsInOrder(
      right.ruling,
      [left.question, left.ruling],
    )) {
    return true;
  }
  return Boolean(
    right.question
    && right.ruling
    && comparableTextContainsPartsInOrder(
      left.ruling,
      [right.question, right.ruling],
    ),
  );
}

function comparableTextContainsPartsInOrder(container, parts) {
  const normalizedContainer = normalizeComparableBody(container);
  if (!normalizedContainer) return false;
  let searchFrom = 0;
  for (const part of parts) {
    const normalizedPart = normalizeComparableBody(part);
    if (!normalizedPart) return false;
    const index = normalizedContainer.indexOf(normalizedPart, searchFrom);
    if (index < 0) return false;
    searchFrom = index + normalizedPart.length;
  }
  return true;
}

function bodyTextForSubstance(substance, documents) {
  if (!substance?.bodyHash || !(documents instanceof Map)) return "";
  return String(documents.get(substance.bodyHash)?.text || "");
}

function comparableTextContainsEither(left, right) {
  const normalizedLeft = normalizeComparableBody(left);
  const normalizedRight = normalizeComparableBody(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft);
}

function normalizeComparableBody(value) {
  return normalizeSubstantiveText(value).replace(/\s+/gu, " ");
}

function parseRenderedRulingQa(substance, body) {
  if (substance?.kind !== "ruling_qa") return null;
  let parsed = splitRenderedRulingQa(body);
  if (!parsed) return null;
  if (!parsed.question && parsed.ruling) {
    const nested = splitRenderedRulingQa(parsed.ruling);
    if (nested?.question && nested?.ruling) parsed = nested;
  }
  return parsed;
}

function splitRenderedRulingQa(value) {
  const text = normalizeSubstantiveText(value);
  const questionPrefix = "Question:\n";
  const rulingSeparator = "\n\nRuling:\n";
  const rulingPrefix = "Ruling:\n";
  if (text.startsWith(questionPrefix)) {
    const separatorIndex = text.indexOf(rulingSeparator, questionPrefix.length);
    if (separatorIndex < 0) {
      return {
        question: text.slice(questionPrefix.length).trim(),
        ruling: "",
      };
    }
    return {
      question: text.slice(questionPrefix.length, separatorIndex).trim(),
      ruling: text.slice(separatorIndex + rulingSeparator.length).trim(),
    };
  }
  if (text.startsWith(rulingPrefix)) {
    return {
      question: "",
      ruling: text.slice(rulingPrefix.length).trim(),
    };
  }
  return null;
}

function summarizeSubstanceDifferences(variants) {
  const fieldNames = [...new Set(variants.flatMap(
    (variant) => variant.fields.map((field) => field.name),
  ))].sort();
  return fieldNames.map((fieldName) => {
    const fieldVariants = variants
      .map((variant) => {
        const field = variant.fields.find((item) => item.name === fieldName);
        return field ? {
          substanceHash: variant.substanceHash,
          valueHash: field.valueHash,
          charCount: field.charCount,
        } : {
          substanceHash: variant.substanceHash,
          valueHash: null,
          charCount: 0,
        };
      });
    if (new Set(fieldVariants.map((item) => item.valueHash)).size <= 1) return null;
    return {
      field: fieldName,
      variants: fieldVariants,
    };
  }).filter(Boolean);
}

function buildArchiveStatistics({
  normalizedCollections,
  documents,
  wrappers,
  substances,
  occurrences,
  evidenceIndex,
  conflicts,
  inputCandidateBytes,
}) {
  const occurrenceBodyCount = occurrences.filter((item) => item.bodyHash).length;
  const equivalentById = evidenceIndex.reduce((total, entry) => (
    total + Math.max(0, entry.occurrenceIds.length - entry.substanceHashes.length)
  ), 0);
  return {
    collectionCount: normalizedCollections.length,
    inputOccurrenceCount: occurrences.length,
    archivedOccurrenceCount: occurrences.length,
    uniqueEvidenceIdCount: evidenceIndex.length,
    uniqueSubstanceCount: substances.size,
    uniqueBodyCount: documents.size,
    uniqueWrapperCount: wrappers.size,
    duplicateBodyOccurrenceCount: Math.max(0, occurrenceBodyCount - documents.size),
    sameIdEquivalentOccurrenceCount: equivalentById,
    conflictCount: conflicts.length,
    inputCandidateBytes,
    uniqueBodyBytes: [...documents.values()].reduce(
      (total, document) => total + document.byteCount,
      0,
    ),
    uniqueWrapperBytes: [...wrappers.values()].reduce(
      (total, wrapper) => total + wrapper.byteCount,
      0,
    ),
  };
}

function buildArchiveCompleteness({
  retrievalWarnings,
  occurrenceCount,
  expectedOccurrenceCount,
}) {
  const truncationWarnings = retrievalWarnings
    .map((warning) => String(warning))
    .filter((warning) => TRUNCATION_WARNING_PATTERN.test(warning));
  return {
    allProvidedCandidateOccurrencesArchived:
      occurrenceCount === expectedOccurrenceCount,
    occurrenceCountMatchesInput:
      occurrenceCount === expectedOccurrenceCount,
    repeatedBodiesStoredOnce: true,
    wrapperAndSubstanceSeparated: true,
    conflictsContainReferencesOnly: true,
    preparationModelCandidateFilteringApplied: false,
    retrievalTruncationObserved: truncationWarnings.length > 0,
    retrievalTruncationWarnings: truncationWarnings,
    sourceCoverage: "UNKNOWN",
    evidenceSufficiency: "NOT_ASSESSED",
    note: "No truncation warning only describes the supplied candidate set; it does not prove that evidence is sufficient.",
  };
}

function aggregateDecisionCandidates(archive) {
  const documents = new Map(archive.documents.map((item) => [item.bodyHash, item]));
  const bySubstance = new Map();
  for (const occurrence of archive.occurrences) {
    const document = occurrence.bodyHash ? documents.get(occurrence.bodyHash) : null;
    if (!document?.text) continue;
    const candidate = bySubstance.get(occurrence.substanceHash) || {
      substanceHash: occurrence.substanceHash,
      bodyHash: occurrence.bodyHash,
      bodyText: document.text,
      evidenceIds: [],
      occurrenceIds: [],
      categories: [],
      category: occurrence.category,
      authority: occurrence.authority,
      direct: occurrence.direct,
      current: occurrence.current,
      relevanceScore: occurrence.relevanceScore,
      bestCollectionRank: occurrence.index,
      bestSourceCollectionPriority: sourceCollectionPriority(occurrence.collection),
      sourceCollections: [],
      representativeOccurrence: occurrence,
    };
    if (!candidate.evidenceIds.includes(occurrence.evidenceId)) {
      candidate.evidenceIds.push(occurrence.evidenceId);
    }
    candidate.occurrenceIds.push(occurrence.occurrenceId);
    if (!candidate.categories.includes(occurrence.category)) {
      candidate.categories.push(occurrence.category);
    }
    if (!candidate.sourceCollections.includes(occurrence.collection)) {
      candidate.sourceCollections.push(occurrence.collection);
    }
    if (categoryPriority(occurrence.category) < categoryPriority(candidate.category)) {
      candidate.category = occurrence.category;
    }
    if (occurrence.authority === "official") candidate.authority = "official";
    if (occurrence.direct) candidate.direct = true;
    if (occurrence.current) candidate.current = true;
    if (Number.isFinite(occurrence.relevanceScore)) {
      candidate.relevanceScore = Math.max(
        Number.isFinite(candidate.relevanceScore) ? candidate.relevanceScore : -Infinity,
        occurrence.relevanceScore,
      );
    }
    candidate.bestCollectionRank = Math.min(
      candidate.bestCollectionRank,
      occurrence.index,
    );
    candidate.bestSourceCollectionPriority = Math.min(
      candidate.bestSourceCollectionPriority,
      sourceCollectionPriority(occurrence.collection),
    );
    if (compareRepresentativeOccurrences(
      occurrence,
      candidate.representativeOccurrence,
    ) < 0) {
      candidate.representativeOccurrence = occurrence;
    }
    bySubstance.set(occurrence.substanceHash, candidate);
  }
  const rawAggregated = [...bySubstance.values()]
    .map((candidate) => {
      const {
        representativeOccurrence: representative,
        ...candidateWithoutRepresentative
      } = candidate;
      return {
        ...candidateWithoutRepresentative,
        representativeEvidenceId: representative.evidenceId,
        category: representative.category,
        authority: representative.authority,
        direct: representative.direct,
        current: representative.current,
        relevanceScore: representative.relevanceScore,
        bestCollectionRank: representative.index,
        bestSourceCollectionPriority: sourceCollectionPriority(
          representative.collection,
        ),
        evidenceIds: [...candidate.evidenceIds].sort(),
        occurrenceIds: [...candidate.occurrenceIds].sort(),
        categories: [...candidate.categories].sort(),
        sourceCollections: [...candidate.sourceCollections].sort(),
      };
    });
  const aggregated = collapseCompatibleDecisionCandidates(rawAggregated, archive);
  const relevanceContext = buildMechanismRelevanceContext(archive, aggregated);
  const requiredCriticalMechanisms = CRITICAL_MECHANISM_FEATURE_IDS.filter(
    (featureId) => relevanceContext.has(featureId),
  );
  const enriched = aggregated.map((candidate) => {
    const candidateFeatures = extractMechanismFeatureSet(candidate.bodyText);
    const criticalMechanismMatches = requiredCriticalMechanisms.filter(
      (featureId) => candidateFeatures.has(featureId),
    );
    return {
      ...candidate,
      criticalMechanismMatches,
      criticalMechanismRelevanceScore: mechanismFeatureWeight(
        criticalMechanismMatches,
      ),
      pendingSpellTrapMovementRestrictionScore:
        pendingSpellTrapMovementRestrictionRelevance(
          candidate.bodyText,
          relevanceContext,
        ),
      operationRelevanceScore:
        candidate.category === ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE
          ? mechanismOperationRelevance(candidate.bodyText, relevanceContext)
          : 0,
    };
  });
  return {
    candidates: reserveCriticalMechanismCoverage(
      layerDecisionCandidates(enriched),
      requiredCriticalMechanisms,
    ),
    requiredCriticalMechanisms,
    asksActivationLegality:
      archive.metadata?.selectionContext?.asksActivationLegality === true,
  };
}

function collapseCompatibleDecisionCandidates(candidates, archive) {
  if (!Array.isArray(candidates) || candidates.length < 2) return candidates;
  const conflictingEvidenceIds = new Set(
    arrayValue(archive?.conflicts).map((item) => item?.evidenceId).filter(Boolean),
  );
  const parent = candidates.map((_, index) => index);
  const find = (index) => {
    let current = index;
    while (parent[current] !== current) current = parent[current];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = current;
      index = next;
    }
    return current;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const byEvidenceId = new Map();
  candidates.forEach((candidate, index) => {
    for (const evidenceId of candidate.evidenceIds || []) {
      if (conflictingEvidenceIds.has(evidenceId)) continue;
      const indexes = byEvidenceId.get(evidenceId) || [];
      indexes.push(index);
      byEvidenceId.set(evidenceId, indexes);
    }
  });
  for (const indexes of byEvidenceId.values()) {
    for (let index = 1; index < indexes.length; index += 1) {
      union(indexes[0], indexes[index]);
    }
  }
  const groups = new Map();
  candidates.forEach((candidate, index) => {
    const root = find(index);
    const group = groups.get(root) || [];
    group.push(candidate);
    groups.set(root, group);
  });
  const substancesByHash = new Map(
    arrayValue(archive?.substances).map((item) => [item?.substanceHash, item]),
  );
  const documentsByHash = new Map(
    arrayValue(archive?.documents).map((item) => [item?.bodyHash, item]),
  );
  return [...groups.values()].flatMap((group) => (
    compatibleDecisionCandidateClique(group, substancesByHash, documentsByHash)
      ? [mergeCompatibleDecisionCandidateGroup(group)]
      : group
  ));
}

function compatibleDecisionCandidateClique(group, substancesByHash, documentsByHash) {
  for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
      const left = substancesByHash.get(group[leftIndex].substanceHash);
      const right = substancesByHash.get(group[rightIndex].substanceHash);
      if (!left || !right || !substancesCompatible(left, right, documentsByHash)) {
        return false;
      }
    }
  }
  return true;
}

function mergeCompatibleDecisionCandidateGroup(group) {
  if (group.length === 1) return group[0];
  const bodyRepresentative = [...group].sort(compareCompatibleCandidateBodies)[0];
  const metadataRepresentative = [...group].sort(compareCompatibleCandidateMetadata)[0];
  const finiteRelevanceScores = group
    .map((candidate) => candidate.relevanceScore)
    .filter(Number.isFinite);
  return {
    ...bodyRepresentative,
    representativeEvidenceId: metadataRepresentative.representativeEvidenceId,
    category: metadataRepresentative.category,
    authority: group.some((candidate) => candidate.authority === "official")
      ? "official"
      : metadataRepresentative.authority,
    direct: group.some((candidate) => candidate.direct),
    current: group.some((candidate) => candidate.current),
    relevanceScore: finiteRelevanceScores.length > 0
      ? Math.max(...finiteRelevanceScores)
      : metadataRepresentative.relevanceScore,
    bestCollectionRank: Math.min(...group.map((candidate) => candidate.bestCollectionRank)),
    bestSourceCollectionPriority: Math.min(
      ...group.map((candidate) => candidate.bestSourceCollectionPriority),
    ),
    evidenceIds: [...new Set(group.flatMap((candidate) => candidate.evidenceIds))].sort(),
    occurrenceIds: [...new Set(group.flatMap((candidate) => candidate.occurrenceIds))].sort(),
    categories: [...new Set(group.flatMap((candidate) => candidate.categories))].sort(),
    sourceCollections: [
      ...new Set(group.flatMap((candidate) => candidate.sourceCollections)),
    ].sort(),
  };
}

function compareCompatibleCandidateBodies(left, right) {
  return rulingQaBodyStructureRank(right.bodyText)
    - rulingQaBodyStructureRank(left.bodyText)
    || right.bodyText.length - left.bodyText.length
    || left.substanceHash.localeCompare(right.substanceHash, "en");
}

function rulingQaBodyStructureRank(value) {
  const text = normalizeSubstantiveText(value);
  if (text.startsWith("Question:\n") && text.includes("\n\nRuling:\n")) return 2;
  if (text.startsWith("Question:\n") || text.startsWith("Ruling:\n")) return 1;
  return 0;
}

function compareCompatibleCandidateMetadata(left, right) {
  return Number(right.direct) - Number(left.direct)
    || Number(right.authority === "official") - Number(left.authority === "official")
    || Number(right.current) - Number(left.current)
    || categoryPriority(left.category) - categoryPriority(right.category)
    || numberOrNegativeInfinity(right.relevanceScore)
      - numberOrNegativeInfinity(left.relevanceScore)
    || left.bestSourceCollectionPriority - right.bestSourceCollectionPriority
    || left.bestCollectionRank - right.bestCollectionRank
    || left.representativeEvidenceId.localeCompare(
      right.representativeEvidenceId,
      "en",
    )
    || left.substanceHash.localeCompare(right.substanceHash, "en");
}

function buildMechanismRelevanceContext(archive, candidates) {
  const wrappers = new Map(archive.wrappers.map((item) => [item.wrapperHash, item]));
  const ruleQueryTexts = archive.occurrences
    .filter((occurrence) => /ruleSearchQueries/iu.test(occurrence.collection))
    .flatMap((occurrence) => selectionContextScalarStrings(
      wrappers.get(occurrence.wrapperHash)?.metadata,
    ));
  const selectionTexts = selectionContextScalarStrings(
    archive.metadata?.selectionContext,
  );
  const cardTexts = candidates
    .filter((candidate) => (
      candidate.category === ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT
    ))
    .map((candidate) => candidate.bodyText);
  const boundedContext = createAdminEvidenceSelectionContext({
    question: selectionTexts.join("\n"),
    questions: ruleQueryTexts.map((text, index) => ({
      questionId: `rule-query-${index + 1}`,
      text,
    })),
    providedFacts: cardTexts,
  });
  return extractMechanismFeatureSet(
    boundedContext.texts.join("\n"),
    { context: true },
  );
}

function mechanismOperationRelevance(bodyText, contextFeatures) {
  if (!(contextFeatures instanceof Set) || contextFeatures.size === 0) return 0;
  const candidateFeatures = extractMechanismFeatureSet(bodyText);
  const shared = MECHANISM_RELEVANCE_FEATURES.filter((item) => (
    contextFeatures.has(item.id) && candidateFeatures.has(item.id)
  ));
  if (!shared.some((item) => item.core)) return 0;
  return shared.reduce((total, item) => total + item.weight, 0);
}

function pendingSpellTrapMovementRestrictionRelevance(bodyText, contextFeatures) {
  if (!(contextFeatures instanceof Set)) return 0;
  const contextMatches = contextFeatures.has("spell_trap")
    && (
      contextFeatures.has("return_to_hand")
      || contextFeatures.has("return_to_deck")
    )
    && (
      contextFeatures.has("chain")
      || contextFeatures.has("activation_legality")
      || contextFeatures.has("activated_card_pending")
    );
  if (!contextMatches) return 0;

  const candidateFeatures = extractMechanismFeatureSet(bodyText);
  const candidateMatches = candidateFeatures.has("spell_trap")
    && candidateFeatures.has("chain")
    && candidateFeatures.has("activated_card_pending")
    && (
      candidateFeatures.has("return_to_hand")
      || candidateFeatures.has("return_to_deck")
    );
  if (!candidateMatches) return 0;

  const text = normalizeSubstantiveText(bodyText);
  return NON_STAYING_ACTIVATED_SPELL_TRAP_PATTERN.test(text)
    && PENDING_RETURN_PROHIBITION_PATTERN.test(text)
    ? 1
    : 0;
}

function extractMechanismFeatureSet(value, { context = false } = {}) {
  const text = normalizeSubstantiveText(value);
  if (!text) return new Set();
  return new Set(MECHANISM_RELEVANCE_FEATURES
    .filter((item) => (
      context ? item.contextPattern : item.pattern
    ).test(text))
    .map((item) => item.id));
}

function feature(id, weight, core, pattern, contextPattern = pattern) {
  return Object.freeze({ id, weight, core, pattern, contextPattern });
}

function mechanismFeatureWeight(featureIds) {
  const selected = new Set(featureIds);
  return MECHANISM_RELEVANCE_FEATURES.reduce((total, item) => (
    selected.has(item.id) ? total + item.weight : total
  ), 0);
}

function selectionContextScalarStrings(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number") {
    const normalized = normalizeSubstantiveText(String(value));
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => selectionContextScalarStrings(item, depth + 1));
  }
  if (!isPlainObject(value)) return [];
  return Object.keys(value)
    .sort()
    .flatMap((key) => selectionContextScalarStrings(value[key], depth + 1));
}

function compareRepresentativeOccurrences(left, right) {
  return Number(right.direct) - Number(left.direct)
    || Number(right.authority === "official") - Number(left.authority === "official")
    || Number(right.current) - Number(left.current)
    || sourceCollectionPriority(left.collection) - sourceCollectionPriority(right.collection)
    || categoryPriority(left.category) - categoryPriority(right.category)
    || left.index - right.index
    || left.evidenceId.localeCompare(right.evidenceId, "en")
    || left.occurrenceId.localeCompare(right.occurrenceId, "en");
}

function layerDecisionCandidates(candidates) {
  const byCategory = new Map();
  for (const candidate of candidates) {
    const categoryCandidates = byCategory.get(candidate.category) || [];
    categoryCandidates.push(candidate);
    byCategory.set(candidate.category, categoryCandidates);
  }
  const categories = [...byCategory.keys()].sort((left, right) => (
    categoryPriority(left) - categoryPriority(right)
    || left.localeCompare(right, "en")
  ));
  for (const category of categories) {
    const categoryCandidates = byCategory.get(category);
    categoryCandidates.sort(compareDecisionCandidatesWithinCategory);
    if (category === ADMIN_EVIDENCE_CATEGORIES.RELATED_QA) {
      byCategory.set(category, weightedRelatedCandidateOrder(categoryCandidates));
    }
  }
  const layered = [];
  const offsets = new Map(categories.map((category) => [category, 0]));

  // A current direct official answer is the strongest available source. Keep
  // every such candidate ahead of weaker card-text, analogous-QA, mechanism,
  // context, and other evidence. Stale or otherwise ineligible direct records
  // remain in the normal weighted schedule and cannot inherit this privilege.
  const directCategory = ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA;
  const directCandidates = byCategory.get(directCategory) || [];
  const priorityDirectCandidates = directCandidates.filter(
    isEligibleDirectOfficialCandidate,
  );
  if (priorityDirectCandidates.length > 0) {
    layered.push(...priorityDirectCandidates);
    byCategory.set(
      directCategory,
      directCandidates.filter((candidate) => !isEligibleDirectOfficialCandidate(candidate)),
    );
  }
  const takeNext = (category) => {
    const source = byCategory.get(category) || [];
    const offset = offsets.get(category) || 0;
    if (offset >= source.length) return false;
    layered.push(source[offset]);
    offsets.set(category, offset + 1);
    return true;
  };

  // Interleave grounding and supporting evidence so a question with many
  // resolved cards cannot consume every bounded packet slot. Direct rulings
  // and card text remain the most frequent categories, while related rulings
  // and mechanism rules are guaranteed opportunities before another cycle.
  const weightedSchedule = [
    ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA,
    ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT,
    ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT,
    ADMIN_EVIDENCE_CATEGORIES.RELATED_QA,
    ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA,
    ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT,
    ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT,
    ADMIN_EVIDENCE_CATEGORIES.RELATED_QA,
    ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE,
    ADMIN_EVIDENCE_CATEGORIES.RELATED_QA,
    ADMIN_EVIDENCE_CATEGORIES.CONTEXT,
    ADMIN_EVIDENCE_CATEGORIES.OTHER,
  ];
  while (categories.some((category) => (
    (offsets.get(category) || 0) < (byCategory.get(category)?.length || 0)
  ))) {
    let progressed = false;
    for (const category of weightedSchedule) progressed = takeNext(category) || progressed;
    for (const category of categories) {
      if (!weightedSchedule.includes(category)) progressed = takeNext(category) || progressed;
    }
    if (!progressed) break;
  }
  return layered;
}

function reserveCriticalMechanismCoverage(candidates, requiredMechanisms) {
  if (!Array.isArray(requiredMechanisms) || requiredMechanisms.length === 0) {
    return candidates;
  }
  const priorityDirect = candidates.filter(isEligibleDirectOfficialCandidate);
  const priorityDirectSet = new Set(
    priorityDirect.map((candidate) => candidate.substanceHash),
  );
  const remaining = candidates.filter(
    (candidate) => !priorityDirectSet.has(candidate.substanceHash),
  );
  const reserved = [];
  const reservedSet = new Set();
  const pendingMovementRestriction = remaining.find((candidate) => (
    (candidate.pendingSpellTrapMovementRestrictionScore || 0) > 0
  ));
  if (pendingMovementRestriction) {
    reserved.push(pendingMovementRestriction);
    reservedSet.add(pendingMovementRestriction.substanceHash);
  }
  for (const mechanism of requiredMechanisms) {
    const candidate = remaining.find((item) => (
      !reservedSet.has(item.substanceHash)
      && item.criticalMechanismMatches.includes(mechanism)
    ));
    if (!candidate) continue;
    reserved.push(candidate);
    reservedSet.add(candidate.substanceHash);
  }
  return [
    ...priorityDirect,
    ...reserved,
    ...remaining.filter((candidate) => !reservedSet.has(candidate.substanceHash)),
  ];
}

function compareDecisionCandidatesWithinCategory(left, right) {
  return criticalMechanismRelevanceDelta(left, right)
    || pendingSpellTrapMovementRestrictionDelta(left, right)
    || mechanismOperationRelevanceDelta(left, right)
    || Number(right.direct) - Number(left.direct)
    || Number(right.authority === "official") - Number(left.authority === "official")
    || Number(right.current) - Number(left.current)
    || left.bestSourceCollectionPriority - right.bestSourceCollectionPriority
    || left.bestCollectionRank - right.bestCollectionRank
    || numberOrNegativeInfinity(right.relevanceScore)
      - numberOrNegativeInfinity(left.relevanceScore)
    || left.evidenceIds[0].localeCompare(right.evidenceIds[0], "en")
    || left.substanceHash.localeCompare(right.substanceHash, "en");
}

function criticalMechanismRelevanceDelta(left, right) {
  return Number(right.criticalMechanismRelevanceScore || 0)
    - Number(left.criticalMechanismRelevanceScore || 0);
}

function pendingSpellTrapMovementRestrictionDelta(left, right) {
  return Number(right.pendingSpellTrapMovementRestrictionScore || 0)
    - Number(left.pendingSpellTrapMovementRestrictionScore || 0);
}

function mechanismOperationRelevanceDelta(left, right) {
  if (
    left.category !== ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE
    || right.category !== ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE
  ) return 0;
  return Number(right.operationRelevanceScore || 0)
    - Number(left.operationRelevanceScore || 0);
}

function sourceCollectionPriority(collection) {
  const value = String(collection || "");
  if (/officialQaDirectCandidates|provisionalOfficialResponses/iu.test(value)) return 0;
  if (/cardTextCandidates|cardTexts|faqRelated|officialQaRelated/iu.test(value)) return 1;
  if (/rulebookCandidates/iu.test(value)) return 2;
  if (/rawRelatedEvidence/iu.test(value)) return 4;
  return 3;
}

function weightedRelatedCandidateOrder(candidates) {
  const groups = new Map([
    ["direct_or_response", []],
    ["pending_spell_trap_movement_restriction", []],
    ["faq", []],
    ["official_related", []],
    ["raw_or_other", []],
  ]);
  for (const candidate of candidates) groups.get(relatedCandidateGroup(candidate)).push(candidate);
  groups.get("faq").sort(compareRelatedFaqCandidates);
  const ordered = [];
  const offsets = new Map([...groups.keys()].map((key) => [key, 0]));
  const take = (key) => {
    const source = groups.get(key);
    const offset = offsets.get(key) || 0;
    if (offset >= source.length) return false;
    ordered.push(source[offset]);
    offsets.set(key, offset + 1);
    return true;
  };
  while (take("direct_or_response")) {
    // direct/traceable response candidates are always first
  }
  while (take("pending_spell_trap_movement_restriction")) {
    // A self-contained applicable restriction is more useful than merely
    // similar examples when the bounded packet cannot retain every candidate.
  }
  const schedule = [
    "faq",
    "faq",
    "official_related",
    "faq",
    "faq",
    "official_related",
    "raw_or_other",
  ];
  while ([...groups.keys()].some((key) => (
    (offsets.get(key) || 0) < groups.get(key).length
  ))) {
    let progressed = false;
    for (const key of schedule) progressed = take(key) || progressed;
    if (!progressed) break;
  }
  return ordered;
}

function compareRelatedFaqCandidates(left, right) {
  return Number(right.direct) - Number(left.direct)
    || Number(right.authority === "official") - Number(left.authority === "official")
    || Number(right.current) - Number(left.current)
    || numberOrNegativeInfinity(right.relevanceScore)
      - numberOrNegativeInfinity(left.relevanceScore)
    || left.bestCollectionRank - right.bestCollectionRank
    || left.evidenceIds[0].localeCompare(right.evidenceIds[0], "en")
    || left.substanceHash.localeCompare(right.substanceHash, "en");
}

function relatedCandidateGroup(candidate) {
  const collections = candidate.sourceCollections || [];
  if (candidate.direct || collections.some(
    (value) => /officialQaDirectCandidates|provisionalOfficialResponses/iu.test(value),
  )) return "direct_or_response";
  if (candidate.pendingSpellTrapMovementRestrictionScore > 0) {
    return "pending_spell_trap_movement_restriction";
  }
  if (collections.some((value) => /faqRelated/iu.test(value))) return "faq";
  if (collections.some((value) => /officialQaRelated/iu.test(value))) return "official_related";
  return "raw_or_other";
}

function categoryPriority(category) {
  return CATEGORY_PRIORITY[category] ?? 999;
}

function omittedEntry(candidate, reason) {
  return {
    substanceHash: candidate.substanceHash,
    bodyHash: candidate.bodyHash,
    evidenceIds: candidate.evidenceIds,
    occurrenceIds: candidate.occurrenceIds,
    category: candidate.category,
    authority: candidate.authority,
    direct: candidate.direct,
    current: candidate.current,
    relevanceScore: Number.isFinite(candidate.relevanceScore)
      ? candidate.relevanceScore
      : null,
    criticalMechanismMatches: candidate.criticalMechanismMatches || [],
    criticalMechanismRelevanceScore:
      candidate.criticalMechanismRelevanceScore || 0,
    pendingSpellTrapMovementRestrictionScore:
      candidate.pendingSpellTrapMovementRestrictionScore || 0,
    operationRelevanceScore: candidate.operationRelevanceScore || 0,
    bestCollectionRank: candidate.bestCollectionRank,
    sourceCollections: candidate.sourceCollections,
    priorityRank: categoryPriority(candidate.category),
    reason,
    bodyCharCount: candidate.bodyText.length,
    bodyByteCount: byteLength(candidate.bodyText),
  };
}

function modelEvidenceItem(candidate, bounded, limits) {
  const identifier = boundedVisibleIdentifier(
    candidate.representativeEvidenceId,
    limits.maxEvidenceIdBytes,
  );
  return {
    packetItemId: `packet_item_${candidate.substanceHash.slice(0, 20)}`,
    evidenceId: identifier.value,
    evidenceIdAliased: identifier.aliased,
    category: candidate.category,
    authority: candidate.authority,
    direct: candidate.direct,
    current: candidate.current,
    body: bounded.text,
    bodyExcerpted: bounded.truncated,
  };
}

function boundedVisibleIdentifier(value, maxBytes) {
  const identifier = String(value || "");
  if (byteLength(identifier) <= maxBytes) {
    return { value: identifier, aliased: false };
  }
  return {
    value: `sha256:${sha256(identifier)}`,
    aliased: true,
  };
}

function truncationEntry(candidate, bounded, reason) {
  return {
    substanceHash: candidate.substanceHash,
    bodyHash: candidate.bodyHash,
    evidenceIds: candidate.evidenceIds,
    reason,
    originalBodyCharCount: candidate.bodyText.length,
    originalBodyByteCount: byteLength(candidate.bodyText),
    includedBodyCharCount: bounded.text.length,
    includedBodyByteCount: byteLength(bounded.text),
    omittedBodySha256: bounded.omittedBodySha256,
  };
}

function initialBodyTruncationReason({
  candidate,
  allowedChars,
  allowedBytes,
  bodyLimits,
}) {
  if (allowedChars < bodyLimits.maxChars) {
    return "total_body_character_budget";
  }
  if (allowedBytes < bodyLimits.maxBytes) {
    return "total_body_byte_budget";
  }
  if (candidate.bodyText.length > bodyLimits.maxChars) {
    return bodyLimits.scope === "total"
      ? "total_body_character_budget"
      : "per_item_body_character_budget";
  }
  return bodyLimits.scope === "total"
    ? "total_body_byte_budget"
    : "per_item_body_byte_budget";
}

function bodyLimitsForCandidate(candidate, limits) {
  if (isEligibleDirectOfficialCandidate(candidate)) {
    return {
      maxChars: limits.maxTotalBodyChars,
      maxBytes: limits.maxTotalBodyBytes,
      scope: "total",
    };
  }
  return {
    maxChars: limits.maxBodyCharsPerItem,
    maxBytes: limits.maxBodyBytesPerItem,
    scope: "per_item",
  };
}

function isEligibleDirectOfficialCandidate(candidate) {
  return candidate.category === ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA
    && candidate.direct === true
    && candidate.authority === "official"
    && candidate.current === true;
}

function createIncludedManifest(includedSelections) {
  return includedSelections.map(({ candidate, item }) => ({
    packetItemId: item.packetItemId,
    substanceHash: candidate.substanceHash,
    bodyHash: candidate.bodyHash,
    evidenceIds: candidate.evidenceIds,
    occurrenceIds: candidate.occurrenceIds,
    criticalMechanismMatches: candidate.criticalMechanismMatches || [],
    criticalMechanismRelevanceScore:
      candidate.criticalMechanismRelevanceScore || 0,
    pendingSpellTrapMovementRestrictionScore:
      candidate.pendingSpellTrapMovementRestrictionScore || 0,
    operationRelevanceScore: candidate.operationRelevanceScore || 0,
  }));
}

function createModelPacketSnapshot({
  archive,
  includedSelections,
  omittedManifest,
  truncationManifest,
  limits,
  conflictCatalogLimit,
  requiredCriticalMechanisms,
  asksActivationLegality,
  archiveSubstanceCount,
}) {
  const included = includedSelections.map((entry) => entry.item);
  const includedManifest = createIncludedManifest(includedSelections);
  const mandatoryConstraintReview = createMandatoryConstraintReview(includedSelections);
  const mechanismCoverage = createCriticalMechanismCoverage(
    requiredCriticalMechanisms,
    includedSelections,
  );
  const activationCandidateReviewRequired = asksActivationLegality === true
    || mandatoryConstraintReview.length > 0;
  const conflictCatalog = createModelConflictCatalog(
    archive.conflicts,
    limits,
    conflictCatalogLimit,
  );
  const conflictCatalogExcerptedCount = conflictCatalog.filter(
    (entry) => entry.itemExcerpted,
  ).length;
  const includedIdExcerptedCount = included.filter(
    (entry) => entry.evidenceIdAliased,
  ).length;
  const packetStructurallyExcerpted = (
    includedIdExcerptedCount > 0
    || conflictCatalogLimit < archive.conflicts.length
    || conflictCatalogExcerptedCount > 0
  );
  const modelPacket = canonicalizeJson({
    schemaVersion: ADMIN_EVIDENCE_DECISION_PACKET_SCHEMA_VERSION,
    archiveId: archive.archiveId,
    archiveContentSha256: archive.contentSha256,
    policy: {
      selectionPolicy: "deterministic_grounding_and_weighted_evidence_selection",
      priorityOrder: [
        ADMIN_EVIDENCE_CATEGORIES.DIRECT_OFFICIAL_QA,
        ADMIN_EVIDENCE_CATEGORIES.PARSED_CARD_TEXT,
        ADMIN_EVIDENCE_CATEGORIES.RELATED_QA,
        ADMIN_EVIDENCE_CATEGORIES.MECHANISM_RULE,
        ADMIN_EVIDENCE_CATEGORIES.CONTEXT,
        ADMIN_EVIDENCE_CATEGORIES.OTHER,
      ],
      categoryMinimumGuarantee:
        "weighted_grounding_and_support_coverage_without_category_starvation",
      withinCategoryPriority: [
        "criticalMechanismCoverage",
        "pendingSpellTrapMovementRestriction",
        "mechanismOperationRelevance",
        "direct",
        "official",
        "current",
        "sourceCollectionPriority",
        "bestCollectionRank",
        "relevanceScore",
        "evidenceId",
        "substanceHash",
      ],
      longVisibleIdentifierPolicy: "sha256_alias",
      preparationModelCanMakeFinalRuling: false,
      preparationModelCanDeleteCandidates: false,
      finalRulingMustConsiderConflictManifest: true,
    },
    limits,
    decisionFocus: {
      asksActivationLegality: asksActivationLegality === true,
      mechanismCoverage,
      mandatoryConstraintReview,
      reviewProtocol: activationCandidateReviewRequired
        ? [...ACTIVATION_CANDIDATE_REVIEW_PROTOCOL]
        : [],
    },
    evidenceItems: included,
    evidenceSummary: {
      archiveSubstanceCount,
      decisionCandidateCount:
        includedSelections.length + omittedManifest.length,
      includedSubstanceCount: includedSelections.length,
      omittedSubstanceCount: omittedManifest.length,
      equivalentEvidenceIdCount: includedSelections.reduce(
        (total, entry) => total + entry.candidate.evidenceIds.length,
        0,
      ),
      visibleEvidenceIdCount: included.reduce(
        (total, entry) => total + (entry.evidenceId ? 1 : 0),
        0,
      ),
      evidenceIdExcerptedItemCount: includedIdExcerptedCount,
      includedManifestSha256: sha256(canonicalStringify(includedManifest)),
    },
    conflicts: conflictCatalog,
    conflictSummary: {
      totalConflictCount: archive.conflicts.length,
      catalogedConflictCount: conflictCatalog.length,
      uncatalogedConflictCount: archive.conflicts.length - conflictCatalog.length,
      catalogComplete:
        conflictCatalog.length === archive.conflicts.length
        && conflictCatalogExcerptedCount === 0,
      catalogItemExcerptedCount: conflictCatalogExcerptedCount,
      manifestSha256: sha256(canonicalStringify(archive.conflicts)),
    },
    omissionSummary: {
      omittedSubstanceCount: omittedManifest.length,
      reasons: countBy(omittedManifest, (entry) => entry.reason),
      categories: countBy(omittedManifest, (entry) => entry.category),
      authorities: countBy(omittedManifest, (entry) => entry.authority),
      directOfficialSubstanceCount: omittedManifest.filter(
        (entry) => entry.direct && entry.authority === "official",
      ).length,
      manifestSha256: sha256(canonicalStringify(omittedManifest)),
    },
    truncationSummary: {
      excerptedSubstanceCount: truncationManifest.length,
      manifestSha256: sha256(canonicalStringify(truncationManifest)),
    },
    completeness: {
      archiveIntegrityVerified: true,
      allProvidedCandidateOccurrencesArchived:
        archive.completeness.allProvidedCandidateOccurrencesArchived,
      retrievalTruncationObserved:
        archive.completeness.retrievalTruncationObserved,
      decisionPacketTruncated:
        omittedManifest.length > 0
        || truncationManifest.length > 0
        || packetStructurallyExcerpted,
      packetStructurallyExcerpted,
      sourceCoverage: archive.completeness.sourceCoverage,
      evidenceSufficiency: "NOT_ASSESSED",
    },
  });
  return {
    modelPacket,
    bytes: byteLength(JSON.stringify(modelPacket)),
  };
}

function createMandatoryConstraintReview(includedSelections) {
  return includedSelections.flatMap(({ candidate, item }) => {
    const constraintKinds = [];
    if ((candidate.pendingSpellTrapMovementRestrictionScore || 0) > 0) {
      constraintKinds.push("pending_activated_spell_trap_movement_restriction");
    }
    if (candidate.criticalMechanismMatches?.includes(
      "zero_legal_candidate_activation",
    )) {
      constraintKinds.push("zero_legal_candidate_activation");
    }
    if (constraintKinds.length === 0) return [];
    return [{
      evidenceId: item.evidenceId,
      constraintKinds,
      reviewRequiredBefore: [
        "activation_legality",
        "resolution_legality",
      ],
    }];
  });
}

function questionAsksActivationLegality(value) {
  const text = normalizeSubstantiveText(value);
  if (!text) return false;
  if (ACTIVATION_LEGALITY_NEGATED_INTENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }
  return ACTIVATION_LEGALITY_QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}

function createCriticalMechanismCoverage(
  requiredMechanisms,
  includedSelections,
) {
  const required = Array.isArray(requiredMechanisms)
    ? [...requiredMechanisms]
    : [];
  const evidenceByMechanism = required.map((mechanism) => ({
    mechanism,
    evidenceIds: includedSelections
      .filter(({ candidate }) => (
        candidate.criticalMechanismMatches?.includes(mechanism)
      ))
      .map(({ item }) => item.evidenceId),
  }));
  const covered = evidenceByMechanism
    .filter((entry) => entry.evidenceIds.length > 0)
    .map((entry) => entry.mechanism);
  const coveredSet = new Set(covered);
  return {
    scope: "packet_presence_only_not_evidence_entailment",
    required,
    covered,
    missing: required.filter((mechanism) => !coveredSet.has(mechanism)),
    evidenceByMechanism,
  };
}

function createModelConflictCatalog(conflicts, limits, catalogLimit) {
  return conflicts.slice(0, catalogLimit).map(
    (conflict) => createModelConflictItem(conflict, limits),
  );
}

function createModelConflictItem(conflict, limits) {
  const evidenceId = boundedVisibleIdentifier(
    conflict.evidenceId,
    limits.maxEvidenceIdBytes,
  );
  const referenceLimit = limits.maxConflictReferencesPerItem;
  const differenceFields = arrayValue(conflict.differenceSummary)
    .slice(0, referenceLimit)
    .map((difference) => ({
      field: boundedVisibleIdentifier(
        difference.field,
        limits.maxEvidenceIdBytes,
      ).value,
      variantCount: arrayValue(difference.variants).length,
    }));
  const item = {
    type: String(conflict.type || "evidence_id_substance_conflict"),
    evidenceId: evidenceId.value,
    evidenceIdAliased: evidenceId.aliased,
    counts: {
      substanceHashCount: arrayValue(conflict.substanceHashes).length,
      bodyHashCount: arrayValue(conflict.bodyHashes).length,
      occurrenceIdCount: arrayValue(conflict.occurrenceIds).length,
      incompatiblePairCount: arrayValue(conflict.incompatiblePairs).length,
      differenceFieldCount: arrayValue(conflict.differenceSummary).length,
    },
    differenceFields,
    itemExcerpted:
      evidenceId.aliased
      || arrayValue(conflict.substanceHashes).length > 0
      || arrayValue(conflict.bodyHashes).length > 0
      || arrayValue(conflict.occurrenceIds).length > 0
      || arrayValue(conflict.incompatiblePairs).length > 0
      || arrayValue(conflict.differenceSummary).length > referenceLimit,
  };
  return boundConflictItemBytes(item, limits.maxConflictItemBytes);
}

function boundConflictItemBytes(item, maxBytes) {
  const bounded = canonicalizeJson(item);
  const removableArrays = [
    "differenceFields",
  ];
  for (const field of removableArrays) {
    while (
      byteLength(JSON.stringify(bounded)) > maxBytes
      && bounded[field].length > 0
    ) {
      bounded[field].pop();
      bounded.itemExcerpted = true;
    }
  }
  if (byteLength(JSON.stringify(bounded)) <= maxBytes) return bounded;
  const minimal = canonicalizeJson({
    type: bounded.type,
    evidenceId: bounded.evidenceId,
    evidenceIdAliased: bounded.evidenceIdAliased,
    counts: bounded.counts,
    differenceFields: [],
    itemExcerpted: true,
  });
  if (byteLength(JSON.stringify(minimal)) > maxBytes) {
    throw new RangeError("maxConflictItemBytes is too small for a conflict summary");
  }
  return minimal;
}

function largestVisibleBodySelection(includedSelections) {
  let selected = null;
  let selectedBytes = -1;
  for (const entry of includedSelections) {
    const currentBytes = byteLength(entry.item.body);
    if (currentBytes >= selectedBytes) {
      selected = entry;
      selectedBytes = currentBytes;
    }
  }
  return selected;
}

function boundedEvidenceBody(text, {
  maxChars,
  maxBytes,
}) {
  const normalizedText = String(text || "");
  const normalizedMaxChars = Math.max(0, Number(maxChars) || 0);
  const normalizedMaxBytes = Math.max(0, Number(maxBytes) || 0);
  if (
    normalizedText.length <= normalizedMaxChars
    && byteLength(normalizedText) <= normalizedMaxBytes
  ) {
    return {
      text: normalizedText,
      truncated: false,
      omittedBodySha256: null,
    };
  }
  const omittedBodySha256 = sha256(normalizedText);
  const marker = `\n…<excerpt omitted; full_body_sha256=${omittedBodySha256}; chars=${normalizedText.length}; bytes=${byteLength(normalizedText)}>…\n`;
  if (
    normalizedMaxChars <= marker.length + 2
    || normalizedMaxBytes <= byteLength(marker) + 2
  ) {
    return {
      text: utf8PrefixWithin(
        normalizedText,
        normalizedMaxChars,
        normalizedMaxBytes,
      ),
      truncated: true,
      omittedBodySha256,
    };
  }
  const availableChars = normalizedMaxChars - marker.length;
  const availableBytes = normalizedMaxBytes - byteLength(marker);
  const head = utf8PrefixWithin(
    normalizedText,
    Math.ceil(availableChars * 0.67),
    Math.ceil(availableBytes * 0.67),
  );
  const tailSource = normalizedText.slice(head.length);
  const tail = utf8SuffixWithin(
    tailSource,
    availableChars - head.length,
    availableBytes - byteLength(head),
  );
  return {
    text: `${head}${marker}${tail}`,
    truncated: true,
    omittedBodySha256,
  };
}

function utf8PrefixWithin(value, maxChars, maxBytes) {
  const text = String(value || "");
  let high = safePrefixEnd(text, Math.min(text.length, Math.max(0, maxChars)));
  if (byteLength(text.slice(0, high)) <= maxBytes) return text.slice(0, high);
  let low = 0;
  while (low < high) {
    const middle = safePrefixEnd(text, Math.ceil((low + high) / 2));
    if (middle <= low) break;
    if (byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const end = safePrefixEnd(text, low);
  return text.slice(0, end);
}

function utf8SuffixWithin(value, maxChars, maxBytes) {
  const text = String(value || "");
  const minimumStart = Math.max(0, text.length - Math.max(0, maxChars));
  let low = safeSuffixStart(text, minimumStart);
  if (byteLength(text.slice(low)) <= maxBytes) return text.slice(low);
  let high = text.length;
  while (low < high) {
    const middle = safeSuffixStart(text, Math.floor((low + high) / 2));
    if (byteLength(text.slice(middle)) <= maxBytes) high = middle;
    else low = middle + 1;
  }
  const start = safeSuffixStart(text, low);
  return text.slice(start);
}

function safePrefixEnd(text, requestedEnd) {
  let end = Math.max(0, Math.min(text.length, requestedEnd));
  if (
    end > 0
    && end < text.length
    && isHighSurrogate(text.charCodeAt(end - 1))
    && isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
  }
  return end;
}

function safeSuffixStart(text, requestedStart) {
  let start = Math.max(0, Math.min(text.length, requestedStart));
  if (
    start > 0
    && start < text.length
    && isLowSurrogate(text.charCodeAt(start))
    && isHighSurrogate(text.charCodeAt(start - 1))
  ) {
    start += 1;
  }
  return start;
}

function isHighSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code) {
  return code >= 0xDC00 && code <= 0xDFFF;
}

function normalizeDecisionPacketLimits(limits) {
  if (!isPlainObject(limits)) throw new TypeError("decision packet limits must be an object");
  const maxPacketBytes = positiveIntegerInRangeOrDefault(
    limits.maxPacketBytes,
    DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxPacketBytes,
    "maxPacketBytes",
    MIN_ADMIN_DECISION_PACKET_BYTES,
    1024 * 1024,
  );
  return {
    maxPacketBytes,
    maxItems: positiveIntegerOrDefault(
      limits.maxItems,
      DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxItems,
      "maxItems",
    ),
    maxTotalBodyChars: positiveIntegerOrDefault(
      limits.maxTotalBodyChars,
      DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxTotalBodyChars,
      "maxTotalBodyChars",
    ),
    maxTotalBodyBytes: positiveIntegerOrDefault(
      limits.maxTotalBodyBytes,
      DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxTotalBodyBytes,
      "maxTotalBodyBytes",
    ),
    maxBodyCharsPerItem: positiveIntegerOrDefault(
      limits.maxBodyCharsPerItem,
      DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxBodyCharsPerItem,
      "maxBodyCharsPerItem",
    ),
    maxBodyBytesPerItem: positiveIntegerOrDefault(
      limits.maxBodyBytesPerItem,
      DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxBodyBytesPerItem,
      "maxBodyBytesPerItem",
    ),
    maxEvidenceIdBytes: positiveIntegerInRangeOrDefault(
      limits.maxEvidenceIdBytes,
      DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxEvidenceIdBytes,
      "maxEvidenceIdBytes",
      80,
      512,
    ),
    maxConflictCatalogItems: positiveIntegerOrDefault(
      limits.maxConflictCatalogItems,
      DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxConflictCatalogItems,
      "maxConflictCatalogItems",
    ),
    maxConflictItemBytes: Math.min(
      maxPacketBytes,
      positiveIntegerInRangeOrDefault(
        limits.maxConflictItemBytes,
        DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxConflictItemBytes,
        "maxConflictItemBytes",
        MIN_CONFLICT_ITEM_BYTES,
        64 * 1024,
      ),
    ),
    maxConflictReferencesPerItem: positiveIntegerInRangeOrDefault(
      limits.maxConflictReferencesPerItem,
      DEFAULT_ADMIN_DECISION_PACKET_LIMITS.maxConflictReferencesPerItem,
      "maxConflictReferencesPerItem",
      1,
      64,
    ),
  };
}

function positiveIntegerOrDefault(value, fallback, name) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return number;
}

function positiveIntegerInRangeOrDefault(value, fallback, name, minimum, maximum) {
  const number = positiveIntegerOrDefault(value, fallback, name);
  if (number < minimum || number > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function normalizeCandidateInput(value) {
  if (isPlainObject(value) || Array.isArray(value)) return value;
  return { value: value === null || value === undefined ? null : String(value) };
}

function normalizeFieldName(value) {
  return String(value || "").replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function hasAnyField(value, acceptedFields) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasAnyField(item, acceptedFields));
  return Object.entries(value).some(([key, child]) => (
    acceptedFields.has(normalizeFieldName(key))
    || hasAnyField(child, acceptedFields)
  ));
}

function findFirstScalar(value, fieldNames) {
  const accepted = new Set(fieldNames);
  const matches = [];
  collectScalars(value, accepted, matches);
  const match = matches.find((item) => item.value !== "");
  return match?.value ?? "";
}

function findFirstBoolean(value, fieldNames) {
  const accepted = new Set(fieldNames);
  const matches = [];
  collectScalars(value, accepted, matches, { allowBoolean: true });
  return matches.find((item) => typeof item.value === "boolean")?.value ?? null;
}

function collectScalars(value, accepted, output, { allowBoolean = false } = {}) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectScalars(item, accepted, output, { allowBoolean }));
    return;
  }
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (accepted.has(normalizeFieldName(key))) {
      if (typeof child === "string" || typeof child === "number") {
        output.push({ key, value: String(child) });
      } else if (allowBoolean && typeof child === "boolean") {
        output.push({ key, value: child });
      }
    }
    if (child && typeof child === "object") {
      collectScalars(child, accepted, output, { allowBoolean });
    }
  }
}

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) {
    const key = String(keyOf(value));
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => (
    left.localeCompare(right, "en")
  )));
}

function compareOccurrences(left, right) {
  return left.collection.localeCompare(right.collection, "en")
    || left.index - right.index
    || left.occurrenceId.localeCompare(right.occurrenceId, "en");
}

function compareBy(field) {
  return (left, right) => String(left?.[field] || "").localeCompare(
    String(right?.[field] || ""),
    "en",
  );
}

function numberOrNegativeInfinity(value) {
  return Number.isFinite(value) ? value : -Infinity;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${name} must be a non-empty string`);
  return normalized;
}

function canonicalizeJson(value, seen = new Set(), path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${path}`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`non-JSON value at ${path}`);
  if (seen.has(value)) throw new TypeError(`cyclic value at ${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalizeJson(item, seen, `${path}[${index}]`));
    }
    if (!isPlainObject(value)) throw new TypeError(`non-plain object at ${path}`);
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalizeJson(value[key], seen, `${path}.${key}`)]),
    );
  } finally {
    seen.delete(value);
  }
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalizeJson(value));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
