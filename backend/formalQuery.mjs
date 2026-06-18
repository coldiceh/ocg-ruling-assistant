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
      properties: {
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
        required: ["id", "type"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: SUB_QUESTION_TYPES },
          card: { type: "string" },
          effectNo: { type: "string" },
          askedResult: { type: "string" },
          timing: { type: "string" },
          requiredSlots: { type: "array", items: { type: "string" } },
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
    if (subQuestion.requiredSlots !== undefined && !Array.isArray(subQuestion.requiredSlots)) {
      errors.push(`${path}.requiredSlots must be an array`);
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
  const scenario = normalizeScenario(source.scenario);
  const seed = {
    originalText,
    cards: Array.isArray(source.cards) ? source.cards : [],
    scenario,
    subQuestions: Array.isArray(source.subQuestions) ? source.subQuestions : [],
  };
  const split = splitSubQuestions(seed);
  const subQuestions = split.map((item, index) => normalizeSubQuestion(item, index, originalText, cards));
  markQuestionCardRoles(cards, subQuestions);
  return { originalText, cards, scenario, subQuestions };
}

export function splitSubQuestions(query) {
  const provided = Array.isArray(query?.subQuestions) ? query.subQuestions.filter(isPlainObject) : [];
  if (provided.length > 1) return provided;

  const originalText = cleanString(query?.originalText);
  const clauses = extractQuestionClauses(originalText);
  if (clauses.length <= 1 && provided.length === 1) return provided;
  const sourceClauses = clauses.length ? clauses : [originalText];
  return sourceClauses.slice(0, 12).map((askedResult, index) => ({
    id: `q${index + 1}`,
    type: inferSubQuestionType(askedResult),
    card: findQuestionCard(askedResult, query?.cards || []),
    effectNo: extractEffectNo(askedResult),
    askedResult,
    timing: inferTiming(askedResult),
    requiredSlots: ["card", "type"],
  }));
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

function normalizeScenario(value) {
  const scenario = isPlainObject(value) ? value : {};
  return {
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

function normalizeSubQuestion(item, index, originalText, cards) {
  const askedResult = cleanString(item.askedResult) || extractQuestionClauses(originalText)[index] || originalText || "unknown";
  const inferredType = inferSubQuestionType(askedResult);
  const type = SUB_QUESTION_TYPES.includes(item.type) && item.type !== "unknown" ? item.type : inferredType;
  const card = cleanString(item.card) || findQuestionCard(askedResult, cards) || "unknown";
  const requiredSlots = Array.isArray(item.requiredSlots)
    ? item.requiredSlots.map(cleanString).filter(Boolean)
    : ["card", "type"];
  return {
    id: cleanString(item.id) || `q${index + 1}`,
    type: SUB_QUESTION_TYPES.includes(type) ? type : "unknown",
    card,
    effectNo: cleanString(item.effectNo) || extractEffectNo(askedResult) || "unknown",
    askedResult,
    timing: cleanString(item.timing) || inferTiming(askedResult),
    requiredSlots: [...new Set(requiredSlots)],
  };
}

function extractQuestionClauses(value) {
  const text = cleanString(value);
  if (!text) return [];
  const sentenceParts = text
    .replace(/([？?])/gu, "$1\n")
    .replace(/[；;]/gu, "\n")
    .split(/\n+/u)
    .map((part) => part.trim().replace(/^[，。、:：\s]+/u, ""))
    .filter(Boolean);

  const clauses = [];
  for (const part of sentenceParts) {
    const subParts = part.split(
      /(?:[，,、]\s*|(?:另外|以及|并且|同时|那么|然后)[，,]?\s*)(?=(?:(?:这时|处理时|结算时).{0,16})?(?:能否|能不能|可否|是否|会不会|怎么|如何|哪里))/u
    );
    for (const subPart of subParts) {
      const clause = subPart.trim().replace(/^(?:另外|以及|并且|同时|那么|然后)[，,]?/u, "");
      if (isQuestionLike(clause)) clauses.push(clause);
    }
  }
  return dedupe(clauses);
}

function inferSubQuestionType(value) {
  const text = cleanString(value);
  if (/(能否|能不能|是否|可否|可以|能).{0,16}(发动|發動|発動)|(?:发动|發動|発動).{0,8}(吗|么|能否|能不能|是否|可否)/iu.test(text)) return "activation_condition";
  if (/(发动时机|发动时点|什么时候发动|何时发动|タイミング|时点)/iu.test(text)) return "timing";
  if (/(对象|取对象|选择.*卡|対象)/iu.test(text)) return "target";
  if (/(cost|代价|作为.*发动|丢弃.*发动|支付|コスト)/iu.test(text)) return "cost";
  if (/(回卡组|回到卡组|返回卡组|洗回卡组|デッキ.*戻)/iu.test(text)) return "return_to_deck";
  if (/(送墓|送去墓地|送到墓地|墓地へ送)/iu.test(text)) return "send_to_gy";
  if (/(暂时除外|临时除外|直到.{0,20}除外|除外.{0,20}(处理后|结束阶段|回到|返回)|一时的に除外)/iu.test(text)) return "temporary_banish";
  if (/(能否|能不能|是否|可否|会不会|怎么|如何).{0,16}(除外|回场|离场|移动|转移)|(?:除外|回场|离场).{0,10}(吗|呢|么)/iu.test(text)) return "location_change";
  if (/(处理时|处理后|结算时|怎么处理|如何处理|效果处理|効果処理|解決時)/iu.test(text)) return "resolution_handling";
  return "unknown";
}

function findQuestionCard(text, cards) {
  const source = cleanString(text).toLocaleLowerCase();
  let best = "";
  let bestScore = -Infinity;
  const intentIndex = source.search(/能否发动|能不能发动|是否发动|可否发动|发动吗|会不会|是否|怎么|如何|哪里/u);
  for (const card of Array.isArray(cards) ? cards : []) {
    const names = [card?.name, card?.cnName, card?.jaName, card?.enName, card?.matched, ...(card?.aliases || [])]
      .map(cleanString)
      .filter((name) => name && name !== "unknown");
    for (const name of names) {
      const index = source.lastIndexOf(name.toLocaleLowerCase());
      if (index < 0) continue;
      const distance = intentIndex >= 0 ? Math.abs(intentIndex - (index + name.length)) : source.length - index;
      const score = 1000 - distance * 4 + name.length;
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

function extractEffectNo(value) {
  const match = cleanString(value).match(/(?:效果|効果)?\s*([①②③④⑤⑥⑦⑧⑨])|(?:效果|効果)\s*([1-9一二三四五六七八九])/u);
  return match?.[1] || match?.[2] || "";
}

function inferTiming(value) {
  const text = cleanString(value);
  const match = text.match(/(伤害步骤结束时|伤害计算后|结束阶段|准备阶段|主要阶段|战斗阶段|处理时|结算时|连锁处理后|效果处理后)/u);
  return match?.[1] || "unknown";
}

function isQuestionLike(value) {
  return /(吗|呢|么|嘛|？|\?|能否|能不能|可否|是否|会不会|怎么|如何|哪里|发动|处理时|结算时)/u.test(value);
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
