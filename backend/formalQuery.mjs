export const CARD_ROLES = ["question_card", "related_card", "cost_card", "target_card", "unknown"];
export const CONTROLLERS = ["self", "opponent", "unknown"];
export const CARD_ZONES = [
  "deck",
  "hand",
  "monster_zone",
  "spell_trap_zone",
  "graveyard",
  "banished",
  "extra_deck",
  "field",
  "unknown",
];
export const CHAIN_STATES = ["before_activation", "during_chain", "after_chain_resolved", "during_resolution", "unknown"];
export const SUB_QUESTION_TYPES = [
  "activation_condition",
  "activation_location",
  "resolution_handling",
  "timing",
  "target",
  "cost",
  "location_change",
  "temporary_banish",
  "return_to_deck",
  "send_to_gy",
  "unknown",
];

/**
 * Machine-readable description of FormalRulingQuery. Unknown facts use the
 * literal string "unknown"; the schema never contains a ruling conclusion.
 */
export const FormalRulingQuery = {
  type: "object",
  additionalProperties: false,
  required: ["originalText", "cards", "scenario", "subQuestions"],
  properties: {
    originalText: { type: "string" },
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "role"],
        properties: {
          name: { type: "string" },
          role: { type: "string", enum: CARD_ROLES },
          effectNo: { type: "string" },
          controller: { type: "string", enum: CONTROLLERS },
          zone: { type: "string", enum: CARD_ZONES },
        },
      },
    },
    scenario: {
      type: "object",
      additionalProperties: false,
      required: ["rawContext"],
      properties: {
        rawContext: { type: "string" },
        turnPlayer: { type: "string", enum: CONTROLLERS },
        phase: { type: "string" },
        chainState: { type: "string", enum: CHAIN_STATES },
        events: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              actor: { type: "string", enum: CONTROLLERS },
              card: { type: "string" },
              effectNo: { type: "string" },
              action: { type: "string" },
              fromZone: { type: "string" },
              toZone: { type: "string" },
              resolved: { type: "boolean" },
            },
          },
        },
      },
    },
    subQuestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "card", "askedResult", "sourceText"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: SUB_QUESTION_TYPES },
          card: { type: "string" },
          askedResult: { type: "string" },
          sourceText: { type: "string" },
        },
      },
    },
  },
};

export const FormalRulingQuerySchema = FormalRulingQuery;

export function validateFormalRulingQuery(query) {
  const errors = [];
  if (!isPlainObject(query)) return { valid: false, errors: ["query must be an object"] };

  if (!cleanString(query.originalText)) errors.push("originalText must be a non-empty string");
  if (!Array.isArray(query.cards)) errors.push("cards must be an array");
  if (!isPlainObject(query.scenario)) errors.push("scenario must be an object");
  if (!Array.isArray(query.subQuestions) || query.subQuestions.length === 0) {
    errors.push("subQuestions must contain at least one item");
  }

  const ids = new Set();
  for (const [index, card] of (Array.isArray(query.cards) ? query.cards : []).entries()) {
    const path = `cards[${index}]`;
    if (!isPlainObject(card)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (!cleanString(card.name)) errors.push(`${path}.name must be a non-empty string`);
    validateEnum(errors, `${path}.role`, card.role, CARD_ROLES);
    validateOptionalEnum(errors, `${path}.controller`, card.controller, CONTROLLERS);
    validateOptionalEnum(errors, `${path}.zone`, card.zone, CARD_ZONES);
  }

  if (isPlainObject(query.scenario)) {
    if (typeof query.scenario.rawContext !== "string") errors.push("scenario.rawContext must be a string");
    validateOptionalEnum(errors, "scenario.turnPlayer", query.scenario.turnPlayer, CONTROLLERS);
    validateOptionalEnum(errors, "scenario.chainState", query.scenario.chainState, CHAIN_STATES);
    if (query.scenario.events !== undefined && !Array.isArray(query.scenario.events)) {
      errors.push("scenario.events must be an array");
    }
  }

  for (const [index, subQuestion] of (Array.isArray(query.subQuestions) ? query.subQuestions : []).entries()) {
    const path = `subQuestions[${index}]`;
    if (!isPlainObject(subQuestion)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    const id = cleanString(subQuestion.id);
    if (!id) errors.push(`${path}.id must be a non-empty string`);
    if (id && ids.has(id)) errors.push(`${path}.id must be unique`);
    ids.add(id);
    validateEnum(errors, `${path}.type`, subQuestion.type, SUB_QUESTION_TYPES);
    for (const field of ["card", "askedResult", "sourceText"]) {
      if (!cleanString(subQuestion[field])) errors.push(`${path}.${field} must be a non-empty string`);
    }
    if (/^(可以|不可以|能|不能|会|不会)[。.!！]?$/u.test(cleanString(subQuestion.askedResult))) {
      errors.push(`${path}.askedResult contains a ruling conclusion instead of a requested result`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function normalizeFormalRulingQuery(query) {
  const source = isPlainObject(query) ? query : {};
  const originalText = cleanString(source.originalText);
  const cards = normalizeCards(source.cards);
  const preprocessing = preprocessFormalQuestion(originalText);
  const scenario = normalizeScenario(source.scenario, preprocessing.contextLines);
  const seed = {
    originalText,
    cards: Array.isArray(source.cards) ? source.cards : [],
    scenario,
    subQuestions: Array.isArray(source.subQuestions) ? source.subQuestions : [],
  };
  const split = splitSubQuestions(seed);
  const subQuestions = split.map((item, index) => normalizeSubQuestion(item, index, cards));
  markQuestionCardRoles(cards, subQuestions);
  return { originalText, cards, scenario, subQuestions };
}

export function splitSubQuestions(query) {
  const provided = Array.isArray(query?.subQuestions) ? query.subQuestions.filter(isPlainObject) : [];
  const originalText = cleanString(query?.originalText);
  const questionLines = preprocessFormalQuestion(originalText).questionLines;
  if (questionLines.length) {
    return questionLines.slice(0, 12).map((sourceText, index) => ({
      ...findProvidedSubQuestion(provided, sourceText, index, questionLines.length),
      id: `q${index + 1}`,
      sourceText,
    }));
  }
  return provided.slice(0, 12).map((item, index) => ({
    ...item,
    id: `q${index + 1}`,
    sourceText: cleanString(item.sourceText) || cleanString(item.askedResult) || "unknown",
  }));
}

export function preprocessFormalQuestion(value) {
  const rawQuestion = cleanString(value);
  if (!rawQuestion) return { rawQuestion: "", contextLines: [], questionLines: [] };

  const contextLines = [];
  const questionLines = [];
  const physicalLines = rawQuestion.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (const physicalLine of physicalLines) {
    const { contextPrefix, remainder } = splitContextPrefix(physicalLine);
    if (contextPrefix) contextLines.push(contextPrefix);
    const segments = splitQuestionSegments(remainder || physicalLine);
    for (const segment of segments) {
      if (hasQuestionMarker(segment)) questionLines.push(segment);
      else if (segment && segment !== contextPrefix) contextLines.push(segment);
    }
  }

  return {
    rawQuestion,
    contextLines: dedupe(contextLines),
    questionLines: dedupe(questionLines),
  };
}

function normalizeCards(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const name = cleanString(item.name) || "unknown";
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      name,
      role: enumOrUnknown(item.role, CARD_ROLES),
      effectNo: cleanString(item.effectNo) || "unknown",
      controller: enumOrUnknown(item.controller, CONTROLLERS),
      zone: enumOrUnknown(item.zone, CARD_ZONES),
    });
  }
  return result;
}

function normalizeScenario(value, contextLines = []) {
  const scenario = isPlainObject(value) ? value : {};
  return {
    rawContext: cleanString(scenario.rawContext) || contextLines.join("\n"),
    turnPlayer: enumOrUnknown(scenario.turnPlayer, CONTROLLERS),
    phase: cleanString(scenario.phase) || "unknown",
    chainState: enumOrUnknown(scenario.chainState, CHAIN_STATES),
    events: (Array.isArray(scenario.events) ? scenario.events : []).filter(isPlainObject).map((event) => {
      const normalized = {
        actor: enumOrUnknown(event.actor, CONTROLLERS),
        card: cleanString(event.card) || "unknown",
        effectNo: cleanString(event.effectNo) || "unknown",
        action: cleanString(event.action) || "unknown",
        fromZone: cleanString(event.fromZone) || "unknown",
        toZone: cleanString(event.toZone) || "unknown",
      };
      if (typeof event.resolved === "boolean") normalized.resolved = event.resolved;
      return normalized;
    }),
  };
}

function normalizeSubQuestion(item, index, cards) {
  const sourceText = cleanString(item.sourceText) || "unknown";
  const ruleType = inferSubQuestionType(sourceText);
  const modelType = SUB_QUESTION_TYPES.includes(item.type) ? item.type : "unknown";
  const type = ruleType !== "unknown" ? ruleType : modelType;
  const inferredCard = inferSubQuestionCard(sourceText, cards);
  const modelCard = cleanString(item.card);
  const card = modelCard && modelCard !== "unknown" ? modelCard : inferredCard;
  const ruleAskedResult = inferAskedResult(sourceText, type);
  const modelAskedResult = cleanString(item.askedResult);
  const askedResult = ruleAskedResult !== "unknown"
    ? ruleAskedResult
    : modelAskedResult && !isBareRulingConclusion(modelAskedResult)
      ? modelAskedResult
      : "unknown";
  return {
    id: `q${index + 1}`,
    type: SUB_QUESTION_TYPES.includes(type) ? type : "unknown",
    card: card || "unknown",
    askedResult,
    sourceText,
  };
}

function inferSubQuestionType(value) {
  const text = cleanString(value);
  if (/(墓地发动|场上发动|在哪里发动|哪里发动|还是在.{0,12}发动|发动还是)/iu.test(text)) return "activation_location";
  if (/(已经送墓|是否已经|已经送去墓地|这个时候.{0,20}送墓)/iu.test(text)) return "location_change";
  if (/(效果除外|除外该|能用.{0,30}除外|可以.{0,20}除外)/iu.test(text)) return "temporary_banish";
  if (/(送墓|送去墓地|送到墓地|墓地へ送)/iu.test(text)) return "send_to_gy";
  if (/(能否|能不能|是否|可否|可以|能).{0,16}(发动|發動|発動)|(?:发动|發動|発動).{0,8}(吗|么|能否|能不能|是否|可否)/iu.test(text)) return "activation_condition";
  if (/(发动时机|发动时点|什么时候发动|何时发动|タイミング|时点)/iu.test(text)) return "timing";
  if (/(对象|取对象|选择.*卡|対象)/iu.test(text)) return "target";
  if (/(cost|代价|作为.*发动|丢弃.*发动|支付|コスト)/iu.test(text)) return "cost";
  if (/(回卡组|回到卡组|返回卡组|洗回卡组|デッキ.*戻)/iu.test(text)) return "return_to_deck";
  if (/(暂时除外|临时除外|直到.{0,20}除外|除外.{0,20}(处理后|结束阶段|回到|返回)|一时的に除外)/iu.test(text)) return "temporary_banish";
  if (/(能否|能不能|是否|可否|会不会|怎么|如何).{0,16}(除外|回场|离场|移动|转移)|(?:除外|回场|离场).{0,10}(吗|呢|么)/iu.test(text)) return "location_change";
  if (/(处理时|处理后|结算时|怎么处理|如何处理|效果处理|効果処理|解決時)/iu.test(text)) return "resolution_handling";
  return "unknown";
}

function inferAskedResult(sourceText, type) {
  const text = cleanString(sourceText);
  if (type === "temporary_banish" && /(该卡通怪兽|卡通怪兽)/u.test(text)) return "can_banish_that_toon_monster";
  if (type === "send_to_gy" && /(战破|战斗破坏)/u.test(text)) return "will_still_be_sent_to_graveyard_by_battle";
  if (type === "activation_location") return "effect_activates_in_graveyard_or_field";
  if (type === "location_change" && /(已经送墓|是否已经|已经送去墓地)/u.test(text)) return "is_already_sent_to_graveyard_at_that_timing";
  if (type === "activation_condition") return "can_activate";
  if (type === "return_to_deck") return "will_return_to_deck";
  if (type === "send_to_gy") return "will_be_sent_to_graveyard";
  if (type === "temporary_banish") return "can_temporarily_banish";
  if (type === "location_change") return "location_change_result";
  if (type === "resolution_handling") return "resolution_result";
  return "unknown";
}

function inferSubQuestionCard(sourceText, cards) {
  const matched = findQuestionCard(sourceText, cards);
  if (matched && matched !== "unknown") return matched;
  if (/(该卡通怪兽|那只卡通怪兽|卡通怪兽)/u.test(sourceText)) return "referenced_toon_monster";
  return "unknown";
}

function findProvidedSubQuestion(provided, sourceText, index, expectedCount) {
  const sourceKey = normalizeComparableText(sourceText);
  const exact = provided.find((item) => {
    const itemKey = normalizeComparableText(item.sourceText);
    return itemKey && (itemKey === sourceKey || itemKey.includes(sourceKey) || sourceKey.includes(itemKey));
  });
  if (exact) return exact;
  return provided.length === expectedCount ? provided[index] || {} : {};
}

function splitContextPrefix(line) {
  const match = line.match(/^(.+?[：:])\s*(.+)$/u);
  if (!match) return { contextPrefix: "", remainder: line };
  if (hasQuestionMarker(match[1]) || !hasQuestionMarker(match[2])) return { contextPrefix: "", remainder: line };
  return { contextPrefix: match[1].trim(), remainder: match[2].trim() };
}

function splitQuestionSegments(line) {
  return cleanString(line)
    .replace(/([？?])/gu, "$1\n")
    .replace(/(吗|么|呢)(?=\s*(?:能用|能否|能不能|可以|可否|是否|会不会|在哪里发动|哪里发动|怎么|如何|怎样))/gu, "$1\n")
    .replace(/[；;]/gu, "\n")
    .split(/\n+/u)
    .flatMap((part) => part.split(
      /(?:[，,、]\s*|(?:另外|以及|并且|同时|那么|然后)[，,]?\s*)(?=(?:能用|能否|能不能|可以|可否|是否|会不会|在哪里发动|哪里发动|怎么|如何|怎样))/u
    ))
    .map((part) => part.trim().replace(/^[，。、:：\s]+/u, ""))
    .filter(Boolean);
}

function hasQuestionMarker(value) {
  return /(能用|能否|能不能|可以|可否|是否|会不会|在哪里发动|哪里发动|还是|吗|么|呢|怎么|如何|怎样|[？?])/u.test(cleanString(value));
}

function isBareRulingConclusion(value) {
  return /^(可以|不可以|能|不能|会|不会)[。.!！]?$/u.test(cleanString(value));
}

function normalizeComparableText(value) {
  return cleanString(value).replace(/[\s，。；;、:：？！?"“”'‘’「」『』()（）-]/gu, "").toLocaleLowerCase();
}

function findQuestionCard(text, cards) {
  const source = normalizeComparableText(text);
  let best = "";
  let bestScore = -Infinity;
  const intentIndex = source.search(/能否发动|能不能发动|是否发动|可否发动|发动吗|会不会|是否|怎么|如何|哪里/u);
  for (const card of Array.isArray(cards) ? cards : []) {
    const names = [card?.name, card?.cnName, card?.jaName, card?.enName, card?.matched, ...(card?.aliases || [])]
      .map(cleanString)
      .filter((name) => name && name !== "unknown");
    for (const name of names) {
      const nameKey = normalizeComparableText(name);
      const index = source.lastIndexOf(nameKey);
      if (index < 0) continue;
      const distance = intentIndex >= 0 ? Math.abs(intentIndex - (index + nameKey.length)) : source.length - index;
      const score = 1000 - distance * 4 + nameKey.length;
      if (score > bestScore) {
        bestScore = score;
        best = cleanString(card.name) || name;
      }
    }
  }
  return best || (cards.length === 1 ? cleanString(cards[0]?.name) : "unknown");
}

function markQuestionCardRoles(cards, subQuestions) {
  const names = new Set(subQuestions.map((item) => item.card).filter((name) => name && name !== "unknown"));
  for (const card of cards) {
    if (card.role === "unknown") card.role = names.has(card.name) ? "question_card" : "related_card";
  }
}

function validateEnum(errors, path, value, allowed) {
  if (!allowed.includes(value)) errors.push(`${path} must be one of: ${allowed.join(", ")}`);
}

function validateOptionalEnum(errors, path, value, allowed) {
  if (value !== undefined && !allowed.includes(value)) validateEnum(errors, path, value, allowed);
}

function enumOrUnknown(value, allowed) {
  return allowed.includes(value) ? value : "unknown";
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dedupe(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = value.replace(/\s+/gu, "").toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
