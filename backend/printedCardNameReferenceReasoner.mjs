import { extractPrintedReferenceRequirement } from "./printedTextReferences.mjs";

const QUOTED_TOKEN = /[「『“"]([^「」『』“”"]{1,100})[」』”"]/gu;
const COPY_NAME_AND_EFFECT = /(?:复制(?:了)?|获得(?:了)?|得到(?:了)?|适用(?:了)?|コピー(?:した|している|し)?|copy(?:ied|ing)?|gain(?:ed|ing)?).{0,80}(?:原本|original|元々|originally)?.{0,24}(?:卡名|カード名|name).{0,80}(?:效果|効果|effect)|(?:复制(?:了)?|获得(?:了)?|得到(?:了)?|コピー(?:した|している|し)?|copy(?:ied|ing)?|gain(?:ed|ing)?).{0,80}(?:效果|効果|effect).{0,40}(?:卡名|カード名|name)/isu;
const PRINTED_REFERENCE_QUESTION = /(?:效果文本框|效果文本栏|效果文本|卡面|印刷文本|印刷文字|テキスト欄|カードテキスト|printed\s+(?:effect\s+)?text).{0,60}(?:记载|记述|記載|記述|mention)|(?:记载|记述|記載|記述|mention).{0,60}(?:卡名|カード名|card\s+name)/isu;
const ARCHETYPE_CONTEXT = /^(?:系列|主题|字段|怪兽|怪獸|モンスター|monster(?:s)?|卡(?:片)?(?!名)|カード(?!名)|cards?(?!\s+name))/iu;

/**
 * Compile the immutable text printed on each resolved card definition.
 * Runtime name/effect acquisition is intentionally absent from this object.
 */
export function compileImmutablePrintedCardDefinitions({
  resolvedCards = [],
  cardTexts = [],
} = {}) {
  const identityCatalog = buildIdentityCatalog(resolvedCards);
  const authorityReasons = [...identityCatalog.authorityReasons];
  const definitions = [];

  for (const identity of identityCatalog.identities) {
    const textBinding = bindPrintedText(identity, cardTexts);
    if (!textBinding.text) {
      authorityReasons.push(`printed_text_missing:${identity.definitionId}`);
      continue;
    }
    if (textBinding.ambiguous) {
      authorityReasons.push(`printed_text_ambiguous:${identity.definitionId}`);
      continue;
    }
    const rawQuotedTokens = extractRawQuotedTokens(textBinding.text);
    const printedReferences = rawQuotedTokens.map((token) => classifyPrintedReference(
      token,
      textBinding.text,
      identityCatalog,
    ));
    definitions.push(deepFreeze({
      definitionId: identity.definitionId,
      canonicalName: identity.canonicalName,
      names: [...identity.names],
      printedText: textBinding.text,
      printedTextEvidenceId: textBinding.evidenceId,
      printedTextSourceField: textBinding.sourceField,
      rawQuotedTokens,
      printedReferences,
      immutable: true,
    }));
  }

  return deepFreeze({
    schema: "ocg-immutable-printed-card-definitions/v1",
    definitions,
    identityBindings: identityCatalog.identities.map((identity) => ({
      definitionId: identity.definitionId,
      canonicalName: identity.canonicalName,
      names: [...identity.names],
    })),
    authorityReasons: unique(authorityReasons),
    complete: authorityReasons.length === 0 && definitions.length === identityCatalog.identities.length,
  });
}

/**
 * Resolve the generic ruling: acquiring another card's name/effects changes
 * runtime state, but never mutates the receiver definition's printed text.
 */
export function analyzePrintedCardNameReferenceTransition({
  userQuery = "",
  resolvedCards = [],
  cardTexts = [],
} = {}) {
  const query = String(userQuery || "").normalize("NFKC").trim();
  if (!isCandidateScenario(query)) return null;

  const compiled = compileImmutablePrintedCardDefinitions({ resolvedCards, cardTexts });
  const roleBinding = bindScenarioRoles(query, compiled);
  const authorityReasons = unique([
    ...(compiled.authorityReasons || []),
    ...(roleBinding.authorityReasons || []),
  ]);
  if (authorityReasons.length) {
    return unresolvedTransition({ query, compiled, roleBinding, authorityReasons });
  }

  const receiver = definitionById(compiled, roleBinding.receiverDefinitionId);
  const source = definitionById(compiled, roleBinding.sourceDefinitionId);
  const required = definitionById(compiled, roleBinding.requiredDefinitionId);
  if (!receiver || !source || !required) {
    return unresolvedTransition({
      query,
      compiled,
      roleBinding,
      authorityReasons: ["scenario_role_definition_missing"],
    });
  }

  const unsafeReceiverReferences = receiver.printedReferences.filter((reference) => (
    reference.kind === "unresolved" || reference.kind === "ambiguous_exact_card_name"
  ));
  if (unsafeReceiverReferences.length) {
    return unresolvedTransition({
      query,
      compiled,
      roleBinding,
      authorityReasons: unsafeReceiverReferences.map((reference) => (
        `receiver_printed_reference_${reference.kind}:${reference.normalizedSurface}`
      )),
    });
  }

  const sourceHasRequiredReference = hasExactPrintedReference(source, required.definitionId);
  if (!sourceHasRequiredReference) {
    return unresolvedTransition({
      query,
      compiled,
      roleBinding,
      authorityReasons: ["copied_source_required_printed_reference_not_bound"],
    });
  }

  const receiverHasRequiredReference = hasExactPrintedReference(receiver, required.definitionId);
  const runtimeAcquisition = deepFreeze({
    schema: "ocg-runtime-acquired-card-semantics/v1",
    receiverDefinitionId: receiver.definitionId,
    acquiredFromDefinitionId: source.definitionId,
    acquiredNames: [{
      definitionId: source.definitionId,
      canonicalName: source.canonicalName,
    }],
    acquiredEffects: [{
      sourceDefinitionId: source.definitionId,
      sourcePrintedTextEvidenceId: source.printedTextEvidenceId,
    }],
    mutatesReceiverPrintedDefinition: false,
  });
  const targetName = required.canonicalName;
  const receiverName = receiver.canonicalName;
  const sourceName = source.canonicalName;
  const shortAnswer = receiverHasRequiredReference
    ? `满足这项卡名记载条件，但不是因为复制。是否记载有「${targetName}」按卡面原本的效果文本判断；「${receiverName}」自身原本卡面已经精确记载该卡名，复制「${sourceName}」的卡名和效果不会改写卡面印刷文本。`
    : `不能仅凭复制获得的卡名和效果满足『效果文本框内记载有「${targetName}」卡名』的条件。是否有该卡名记述按怪兽卡面原本的效果文本框判断；复制不会改写卡面印刷文本，而「${receiverName}」自身原本卡面没有该精确卡名记载。`;
  const evidenceIds = unique([
    receiver.printedTextEvidenceId,
    source.printedTextEvidenceId,
    required.printedTextEvidenceId,
  ]);

  return deepFreeze({
    scenarioType: "printed_card_name_reference_after_runtime_copy",
    status: "resolved",
    complete: true,
    authoritative: true,
    authorityReasons: [],
    activation: receiverHasRequiredReference ? "legal" : "illegal",
    condition: receiverHasRequiredReference ? "satisfied" : "not_satisfied",
    resolution: "not_applicable",
    shortAnswer,
    reasoning: receiverHasRequiredReference
      ? [
          `「${receiverName}」的不可变卡面文本本来就精确引用了「${targetName}」。`,
          `从「${sourceName}」获得的运行时卡名与效果记录在独立状态中，不会新增、删除或改写卡面印刷引用。`,
        ]
      : [
          `「${receiverName}」的不可变卡面文本没有精确引用「${targetName}」。`,
          `「${sourceName}」的原本卡面虽然引用了「${targetName}」，但复制只产生运行时获得的卡名与效果，不会把该引用写入接收者卡面。`,
        ],
    evidenceIds,
    program: {
      immutablePrintedDefinitions: compiled,
      runtimeAcquisition,
      roleBinding,
      verdict: {
        receiverHasRequiredReference,
        copiedTextCountsAsReceiverPrintedReference: false,
      },
    },
  });
}

function isCandidateScenario(query) {
  return Boolean(
    query
    && COPY_NAME_AND_EFFECT.test(query)
    && PRINTED_REFERENCE_QUESTION.test(query)
    && extractPrintedReferenceRequirement(query)
  );
}

function bindScenarioRoles(query, compiled) {
  const authorityReasons = [];
  const copyPair = extractCopyPair(query);
  if (!copyPair) authorityReasons.push("runtime_copy_pair_missing");
  const receiverBinding = bindQuerySurface(copyPair?.receiverSurface, compiled);
  const sourceBinding = bindQuerySurface(copyPair?.sourceSurface, compiled);
  const requiredSurface = extractPrintedReferenceRequirement(query);
  const requiredBinding = bindQuerySurface(requiredSurface, compiled);

  collectRoleBindingReason(authorityReasons, "receiver", receiverBinding);
  collectRoleBindingReason(authorityReasons, "source", sourceBinding);
  collectRoleBindingReason(authorityReasons, "required_name", requiredBinding);
  if (receiverBinding.definitionId && receiverBinding.definitionId === sourceBinding.definitionId) {
    authorityReasons.push("runtime_copy_roles_not_distinct");
  }
  return deepFreeze({
    receiverSurface: copyPair?.receiverSurface || "",
    sourceSurface: copyPair?.sourceSurface || "",
    requiredSurface,
    receiverDefinitionId: receiverBinding.definitionId,
    sourceDefinitionId: sourceBinding.definitionId,
    requiredDefinitionId: requiredBinding.definitionId,
    authorityReasons: unique(authorityReasons),
  });
}

function extractCopyPair(query) {
  const mentions = extractRawQuotedTokens(query);
  const copyWord = [...query.matchAll(/复制(?:了)?|获得(?:了)?|得到(?:了)?|コピー(?:した|している|し)?|copy(?:ied|ing)?|gain(?:ed|ing)?/giu)]
    .map((match) => Number(match.index))
    .find((index) => !mentions.some((mention) => (
      index >= mention.quoteSpan.start && index < mention.quoteSpan.end
    )));
  if (!Number.isFinite(copyWord)) return null;
  const before = mentions.filter((mention) => mention.span.end <= copyWord).at(-1);
  const after = mentions.find((mention) => mention.span.start >= copyWord);
  if (!before || !after) return null;
  return {
    receiverSurface: before.surface,
    sourceSurface: after.surface,
  };
}

function collectRoleBindingReason(reasons, role, binding) {
  if (binding.status === "bound") return;
  reasons.push(`${role}_identity_${binding.status}`);
}

function bindQuerySurface(surface, compiled) {
  const normalized = normalizeIdentity(surface);
  if (!normalized) return { status: "missing", definitionId: "" };
  const matches = (compiled.identityBindings || []).filter((binding) => (
    (binding.names || []).some((name) => normalizeIdentity(name) === normalized)
  ));
  const definitionIds = unique(matches.map((binding) => binding.definitionId));
  if (definitionIds.length === 1) return { status: "bound", definitionId: definitionIds[0] };
  if (definitionIds.length > 1) return { status: "ambiguous", definitionId: "" };
  return { status: "unresolved", definitionId: "" };
}

function buildIdentityCatalog(resolvedCards) {
  const authorityReasons = [];
  const identities = [];
  for (const [index, card] of (resolvedCards || []).entries()) {
    const definitionId = String(card?.cardId || card?.id || "").trim();
    if (!definitionId) {
      authorityReasons.push(`definition_identity_missing:${index + 1}`);
      continue;
    }
    const names = unique([
      card?.name,
      card?.cnName,
      card?.jaName,
      card?.jpName,
      card?.enName,
      ...(Array.isArray(card?.aliases) ? card.aliases : []),
    ].map(cleanSurface));
    if (!names.length) {
      authorityReasons.push(`definition_name_missing:${definitionId}`);
      continue;
    }
    identities.push({
      definitionId,
      canonicalName: cleanSurface(card?.name || card?.cnName || card?.jaName || names[0]),
      names,
      source: card,
    });
  }

  const byNormalizedName = new Map();
  for (const identity of identities) {
    for (const name of identity.names) {
      const key = normalizeIdentity(name);
      if (!key) continue;
      if (!byNormalizedName.has(key)) byNormalizedName.set(key, new Set());
      byNormalizedName.get(key).add(identity.definitionId);
    }
  }
  for (const [key, ids] of byNormalizedName) {
    if (ids.size > 1) authorityReasons.push(`resolved_identity_alias_ambiguous:${key}`);
  }
  return { identities, byNormalizedName, authorityReasons: unique(authorityReasons) };
}

function bindPrintedText(identity, cardTexts) {
  const sourceText = cleanTextPreserveLines(
    identity.source?.effectText || identity.source?.text || identity.source?.description,
  );
  if (sourceText) {
    return {
      text: sourceText,
      evidenceId: String(identity.source?.evidenceId || `card-text-${identity.definitionId}`),
      sourceField: identity.source?.effectText ? "effectText" : identity.source?.text ? "text" : "description",
      ambiguous: false,
    };
  }
  const matches = (cardTexts || []).filter((item) => cardTextBelongsToIdentity(item, identity));
  const distinctTexts = unique(matches.map((item) => cleanTextPreserveLines(
    item?.text || item?.effectText || item?.description,
  )).filter(Boolean));
  if (distinctTexts.length !== 1) return { text: "", evidenceId: "", sourceField: "", ambiguous: distinctTexts.length > 1 };
  const source = matches.find((item) => cleanTextPreserveLines(
    item?.text || item?.effectText || item?.description,
  ) === distinctTexts[0]);
  return {
    text: distinctTexts[0],
    evidenceId: String(source?.id || source?.evidenceId || `card-text-${identity.definitionId}`),
    sourceField: source?.effectText ? "effectText" : source?.text ? "text" : "description",
    ambiguous: false,
  };
}

function cardTextBelongsToIdentity(item, identity) {
  const ids = unique([
    item?.cardId,
    ...(Array.isArray(item?.cardIds) ? item.cardIds : []),
  ].map((value) => String(value || "").trim()));
  if (ids.length) return ids.includes(identity.definitionId);
  const names = unique([
    item?.title,
    item?.name,
    ...(Array.isArray(item?.cards) ? item.cards : []),
  ].map(normalizeIdentity));
  return names.some((name) => identity.names.some((candidate) => normalizeIdentity(candidate) === name));
}

function extractRawQuotedTokens(text) {
  const output = [];
  for (const match of String(text || "").matchAll(QUOTED_TOKEN)) {
    const surface = cleanSurface(match[1]);
    if (!surface) continue;
    const offset = match[0].indexOf(match[1]);
    output.push(deepFreeze({
      surface,
      normalizedSurface: normalizeIdentity(surface),
      quoteSpan: {
        start: Number(match.index || 0),
        end: Number(match.index || 0) + match[0].length,
      },
      span: {
        start: Number(match.index || 0) + Math.max(0, offset),
        end: Number(match.index || 0) + Math.max(0, offset) + match[1].length,
      },
      sourceField: "effectText",
    }));
  }
  return output;
}

function classifyPrintedReference(token, fullText, identityCatalog) {
  const exactIds = [...(identityCatalog.byNormalizedName.get(token.normalizedSurface) || [])];
  let kind = "unresolved";
  let definitionId = "";
  if (exactIds.length === 1) {
    kind = "exact_card_name";
    [definitionId] = exactIds;
  } else if (exactIds.length > 1) {
    kind = "ambiguous_exact_card_name";
  } else {
    const suffix = String(fullText || "").slice(token.quoteSpan?.end ?? token.span.end).trimStart().slice(0, 40);
    if (ARCHETYPE_CONTEXT.test(suffix)) kind = "archetype_or_field_label";
  }
  return deepFreeze({
    ...token,
    kind,
    ...(definitionId ? { definitionId } : {}),
    immutable: true,
  });
}

function hasExactPrintedReference(definition, requiredDefinitionId) {
  return (definition?.printedReferences || []).some((reference) => (
    reference.kind === "exact_card_name"
    && reference.definitionId === requiredDefinitionId
  ));
}

function definitionById(compiled, definitionId) {
  return (compiled.definitions || []).find((definition) => definition.definitionId === definitionId) || null;
}

function unresolvedTransition({ query, compiled, roleBinding, authorityReasons }) {
  const reasons = unique(authorityReasons);
  return deepFreeze({
    scenarioType: "printed_card_name_reference_after_runtime_copy",
    status: "unresolved",
    complete: false,
    authoritative: false,
    authorityReason: reasons[0] || "printed_reference_semantics_incomplete",
    authorityReasons: reasons,
    reason: "卡面精确卡名引用所需的身份或原始文本尚未唯一绑定，不能猜测。",
    shortAnswer: "当前不能可靠判断该卡面是否精确记载了所要求的卡名。",
    reasoning: ["复制得到的运行时卡名与效果不能代替卡面原始文本身份校验。"],
    evidenceIds: [],
    program: {
      immutablePrintedDefinitions: compiled,
      roleBinding,
      query,
    },
  });
}

function cleanSurface(value) {
  return String(value || "").normalize("NFKC").trim().replace(/^[\s「」『』“”"]+|[\s「」『』“”"]+$/gu, "");
}

function normalizeIdentity(value) {
  return cleanSurface(value)
    .toLowerCase()
    .replace(/[·・･]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function cleanTextPreserveLines(value) {
  return String(value || "").normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
