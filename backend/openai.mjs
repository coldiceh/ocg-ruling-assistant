import {
  FormalRulingQuerySchema,
  normalizeFormalRulingQuery,
  preprocessFormalQuestion,
  validateFormalRulingQuery,
} from "./formalQuery.mjs";

const cardResolutionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["input", "candidates", "confidence"],
        properties: {
          input: {
            type: "string",
            description: "The card name, nickname, or translated phrase found in the question.",
          },
          candidates: {
            type: "array",
            items: { type: "string" },
            description: "Possible official English or Japanese card names, plus the original phrase when useful.",
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
        },
      },
    },
  },
};

export async function parseFormalRulingQuery(question, cardCandidates = [], env = globalThis.process?.env || {}) {
  const result = await parseFormalRulingQueryDetailed(question, cardCandidates, env);
  return result.query;
}

export async function parseFormalRulingQueryDetailed(question, cardCandidates = [], env = globalThis.process?.env || {}) {
  const text = String(question || "").trim();
  const preprocessing = preprocessFormalQuestion(text);
  const fallback = buildFormalQueryFallback(text, cardCandidates);
  if (!text) return buildFormalParserFailure("empty_formal_query", fallback, fallback, preprocessing);

  const provider = String(env.MODEL_PROVIDER || "").toLowerCase();
  let parsed = null;
  try {
    if (provider === "gemini" || (!provider && env.GEMINI_API_KEY && (env.GEMINI_MODEL || env.GEMINI_MODELS))) {
      parsed = await parseGeminiFormalQuery(text, cardCandidates, preprocessing, env);
    } else if (!provider || provider === "openai") {
      parsed = await parseOpenAiFormalQuery(text, cardCandidates, preprocessing, env);
    }
  } catch (error) {
    if (isModelOutputTruncated(error)) {
      return buildFormalParserFailure("model_output_truncated", null, fallback, preprocessing);
    }
    if (/invalid JSON|did not contain output text|JSON/i.test(error instanceof Error ? error.message : String(error))) {
      return buildFormalParserFailure("model_output_invalid_json", null, fallback, preprocessing);
    }
    throw error;
  }

  if (!parsed) {
    if (!fallback.subQuestions.length) {
      return buildFormalParserFailure("empty_formal_query", fallback, fallback, preprocessing);
    }
    const parserWarnings = collectFormalParserWarnings(null, fallback, preprocessing);
    return buildFormalParserResult(fallback, fallback, preprocessing, parserWarnings);
  }
  parsed = compactFormalQueryPayload(parsed);
  const normalized = normalizeFormalRulingQuery({
    ...parsed,
    originalText: text,
    cards: mergeFormalCards(parsed.cards, fallback.cards),
  });
  const validation = validateFormalRulingQuery(normalized);
  if (!validation.valid || !normalized.originalText || !normalized.subQuestions.length) {
    return buildFormalParserFailure("empty_formal_query", parsed, normalized, preprocessing, validation.errors);
  }
  const parserWarnings = collectFormalParserWarnings(parsed, normalized, preprocessing);
  return buildFormalParserResult(parsed, normalized, preprocessing, parserWarnings);
}

async function parseOpenAiFormalQuery(question, cardCandidates, preprocessing, env) {
  const apiKey = env.OPENAI_API_KEY;
  const model = env.OPENAI_PARSER_MODEL || env.OPENAI_MODEL;
  if (!apiKey || !model) return null;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: buildFormalParserInstructions() }] },
        { role: "user", content: [{ type: "input_text", text: buildFormalParserInput(question, cardCandidates, preprocessing) }] },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "formal_ruling_query",
          schema: FormalRulingQuerySchema,
          strict: false,
        },
      },
      max_output_tokens: Number(env.OPENAI_PARSER_TOKENS || 3200),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI formal query parser ${response.status}: ${detail.slice(0, 400)}`);
  }
  const payload = await response.json();
  if (payload?.status === "incomplete" && /max_output_tokens/i.test(String(payload?.incomplete_details?.reason || ""))) {
    throw createParserError("model_output_truncated", "OpenAI formal query parser was truncated by max output tokens.");
  }
  const output = extractResponseText(payload);
  return output ? parseJsonFromModel(output, "OpenAI formal query parser") : null;
}

async function parseGeminiFormalQuery(question, cardCandidates, preprocessing, env) {
  const apiKey = env.GEMINI_API_KEY;
  const models = getGeminiModelList(
    env,
    "GEMINI_PARSER_MODELS",
    "GEMINI_PARSER_MODEL",
    "GEMINI_MODELS",
    "GEMINI_MODEL"
  );
  if (!apiKey || !models.length) return null;
  return runGeminiFallback(models, (model) => parseGeminiFormalQueryWithModel(question, cardCandidates, preprocessing, env, apiKey, model));
}

async function parseGeminiFormalQueryWithModel(question, cardCandidates, preprocessing, env, apiKey, model) {
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buildFormalParserInstructions() }] },
      contents: [{ role: "user", parts: [{ text: buildFormalParserInput(question, cardCandidates, preprocessing) }] }],
      generationConfig: {
        maxOutputTokens: Number(env.GEMINI_PARSER_TOKENS || 4096),
        temperature: 0,
        candidateCount: 1,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(FormalRulingQuerySchema),
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gemini formal query parser ${response.status}: ${detail.slice(0, 400)}`);
  }
  const payload = await response.json();
  assertGeminiNotTruncated(payload, "Gemini formal query parser");
  const output = extractGeminiText(payload);
  return output ? parseJsonFromModel(output, "Gemini formal query parser") : null;
}

function buildFormalParserInstructions() {
  return [
    "你是 OCG 问题字段填充器，不负责拆问，也不回答规则。",
    "只输出一行 compact JSON；禁止 Markdown、解释、reasoning、evidence、Q&A 和裁定结论。",
    "输入中的 questionLines 已由程序确定。subQuestions 必须与 questionLines 数量和顺序完全一致，并原样复制 id 与 sourceText。",
    "只保留 originalText、scenario、cards、subQuestions 四个顶层字段。",
    "每个 subQuestion 只填写 id、type、card、askedResult、sourceText。无法确定的字段写 unknown，不能省略。",
    "不得输出可以、不可以、会、不会等答案。",
  ].join("\n");
}

function buildFormalParserInput(question, cardCandidates, preprocessing) {
  return JSON.stringify({
    originalText: question,
    scenario: { rawContext: preprocessing.contextLines.join("\n") },
    questionLines: preprocessing.questionLines.map((sourceText, index) => ({ id: `q${index + 1}`, sourceText })),
    cardCandidates: (Array.isArray(cardCandidates) ? cardCandidates : []).map((card) => ({
      name: String(card?.name || card?.cnName || card?.jaName || card?.enName || "unknown"),
      aliases: [card?.cnName, card?.jaName, card?.enName, card?.matched, ...(card?.aliases || [])].filter(Boolean).slice(0, 12),
    })),
  });
}

function buildFormalParserResult(rawFormalQuery, normalizedFormalQuery, preprocessing, parserWarnings = [], parseFailed = null) {
  return {
    query: normalizedFormalQuery,
    rawFormalQuery,
    normalizedFormalQuery,
    preprocessing,
    parserWarnings,
    parseFailed,
  };
}

function compactFormalQueryPayload(payload) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const scenario = source.scenario && typeof source.scenario === "object" && !Array.isArray(source.scenario)
    ? source.scenario
    : {};
  return {
    originalText: source.originalText,
    scenario: {
      rawContext: scenario.rawContext,
      turnPlayer: scenario.turnPlayer,
      phase: scenario.phase,
      chainState: scenario.chainState,
      events: Array.isArray(scenario.events)
        ? scenario.events.map((event) => ({
            actor: event?.actor,
            card: event?.card,
            effectNo: event?.effectNo,
            action: event?.action,
            fromZone: event?.fromZone,
            toZone: event?.toZone,
            resolved: event?.resolved,
          }))
        : [],
    },
    cards: (Array.isArray(source.cards) ? source.cards : []).map((card) => ({
      name: card?.name,
      role: card?.role,
      effectNo: card?.effectNo,
      controller: card?.controller,
      zone: card?.zone,
    })),
    subQuestions: (Array.isArray(source.subQuestions) ? source.subQuestions : []).map((subQuestion) => ({
      id: subQuestion?.id,
      type: subQuestion?.type,
      card: subQuestion?.card,
      askedResult: subQuestion?.askedResult,
      sourceText: subQuestion?.sourceText,
    })),
  };
}

function buildFormalParserFailure(code, rawFormalQuery, normalizedFormalQuery, preprocessing, details = []) {
  return buildFormalParserResult(rawFormalQuery, normalizedFormalQuery, preprocessing, [code, ...details], code);
}

function collectFormalParserWarnings(rawFormalQuery, normalizedFormalQuery, preprocessing) {
  const warnings = [];
  const rawSubQuestions = Array.isArray(rawFormalQuery?.subQuestions) ? rawFormalQuery.subQuestions : [];
  if (rawFormalQuery && rawSubQuestions.length !== preprocessing.questionLines.length) {
    warnings.push("model_subquestion_count_ignored");
  }
  for (const [index, subQuestion] of normalizedFormalQuery.subQuestions.entries()) {
    const raw = rawSubQuestions[index];
    if (rawFormalQuery && (!raw || !raw.type)) warnings.push(`defaulted_type:q${index + 1}`);
    if (rawFormalQuery && (!raw || !raw.card)) warnings.push(`defaulted_card:q${index + 1}`);
    if (rawFormalQuery && (!raw || !raw.askedResult)) warnings.push(`defaulted_asked_result:q${index + 1}`);
    if (subQuestion.type === "unknown") warnings.push(`unknown_type:${subQuestion.id}`);
    if (subQuestion.card === "unknown") warnings.push(`unknown_card:${subQuestion.id}`);
  }
  if (!preprocessing.questionLines.length) warnings.push("no_question_lines");
  return [...new Set(warnings)];
}

function isModelOutputTruncated(error) {
  const message = error instanceof Error ? error.message : String(error);
  return error?.code === "model_output_truncated" || /truncated|max output tokens|MAX_TOKENS/i.test(message);
}

function createParserError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function buildFormalQueryFallback(question, cardCandidates) {
  return normalizeFormalRulingQuery({
    originalText: question,
    cards: (Array.isArray(cardCandidates) ? cardCandidates : []).map((card) => ({
      name: String(card?.name || card?.cnName || card?.jaName || card?.enName || "unknown"),
      role: "unknown",
      effectNo: "unknown",
      controller: "unknown",
      zone: "unknown",
      aliases: [card?.cnName, card?.jaName, card?.enName, card?.matched, ...(card?.aliases || [])].filter(Boolean),
    })),
    scenario: { turnPlayer: "unknown", phase: "unknown", chainState: "unknown", events: [] },
    subQuestions: [],
  });
}

function mergeFormalCards(parsedCards, fallbackCards) {
  const result = [];
  const seen = new Set();
  for (const card of [...(Array.isArray(parsedCards) ? parsedCards : []), ...(fallbackCards || [])]) {
    const name = String(card?.name || "unknown").trim() || "unknown";
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(card);
  }
  return result;
}

export async function resolveCardNamesWithModel(question, env = globalThis.process?.env || {}) {
  const provider = String(env.MODEL_PROVIDER || "").toLowerCase();
  if (provider === "gemini" || (!provider && env.GEMINI_API_KEY && (env.GEMINI_MODEL || env.GEMINI_MODELS))) {
    return resolveGeminiCardNames(question, env);
  }

  if (provider && provider !== "openai") return null;
  return resolveOpenAiCardNames(question, env);
}

async function resolveOpenAiCardNames(question, env) {
  const apiKey = env.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL;
  if (!apiKey || !model) return null;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: buildCardResolutionInstructions() }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: question }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "ocg_card_name_resolution",
          schema: cardResolutionSchema,
          strict: true,
        },
      },
      max_output_tokens: Number(env.OPENAI_CARD_RESOLUTION_TOKENS || 800),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI card resolver ${response.status}: ${detail.slice(0, 400)}`);
  }

  const payload = await response.json();
  const text = extractResponseText(payload);
  return normalizeCardResolutionPayload(text ? parseJsonFromModel(text, "OpenAI card resolver") : null);
}

async function resolveGeminiCardNames(question, env) {
  const apiKey = env.GEMINI_API_KEY;
  const models = getGeminiModelList(env, "GEMINI_CARD_RESOLUTION_MODELS", "GEMINI_CARD_RESOLUTION_MODEL", "GEMINI_MODELS", "GEMINI_MODEL");
  if (!apiKey || !models.length) return null;

  return runGeminiFallback(models, (model) => resolveGeminiCardNamesWithModel(question, env, apiKey, model));
}

async function resolveGeminiCardNamesWithModel(question, env, apiKey, model) {
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: buildCardResolutionInstructions() }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: question }],
        },
      ],
      generationConfig: {
        maxOutputTokens: Number(env.GEMINI_CARD_RESOLUTION_TOKENS || 1800),
        temperature: env.GEMINI_TEMPERATURE === undefined ? 0.1 : Number(env.GEMINI_TEMPERATURE),
        candidateCount: 1,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(cardResolutionSchema),
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gemini card resolver ${response.status}: ${detail.slice(0, 400)}`);
  }

  const payload = await response.json();
  assertGeminiNotTruncated(payload, "Gemini card resolver");
  const text = extractGeminiText(payload);
  return normalizeCardResolutionPayload(text ? parseJsonFromModel(text, "Gemini card resolver") : null);
}

function getGeminiModelList(env, ...keys) {
  const values = [];
  for (const key of keys) {
    const raw = env[key];
    if (!raw) continue;
    values.push(...String(raw).split(","));
    if (values.length) break;
  }

  return [...new Set(values.map((model) => model.trim()).filter(Boolean))];
}

async function runGeminiFallback(models, run) {
  const errors = [];

  for (const model of models) {
    try {
      return await run(model);
    } catch (error) {
      errors.push({ model, error });
      if (!canTryNextGeminiModel(error)) throw error;
    }
  }

  throw new Error(
    `Gemini configured models all failed: ${errors
      .map(({ model, error }) => `${model}: ${error instanceof Error ? error.message : String(error)}`)
      .join(" | ")}`
  );
}

function canTryNextGeminiModel(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/API key not valid|PERMISSION_DENIED|401|403/i.test(message)) return false;
  return /429|RESOURCE_EXHAUSTED|quota|rate limit|MAX_TOKENS|invalid JSON|Unterminated string|Unexpected end of JSON|model .*not found|not found|INVALID_ARGUMENT|400/i.test(
    message
  );
}

function buildCardResolutionInstructions() {
  return [
    "你只负责从游戏王 OCG 问题中解析卡名。",
    "用户可能输入简体中文民间译名、俗称、日文片假名音译、英文缩写或错别字。",
    "请返回题目中出现的每张疑似卡，以及可能对应的官方英文名或日文名。",
    "不要回答裁定，不要解释规则，不要编造效果。",
    "不确定时也可以给 low confidence 候选；后端只会采纳资料库中真实存在的卡。",
  ].join("\n");
}

function normalizeCardResolutionPayload(payload) {
  if (!payload || !Array.isArray(payload.cards)) return { cards: [] };
  return {
    cards: payload.cards
      .map((card) => ({
        input: String(card.input || "").trim(),
        candidates: Array.isArray(card.candidates)
          ? card.candidates.map((candidate) => String(candidate || "").trim()).filter(Boolean).slice(0, 8)
          : [],
        confidence: ["high", "medium", "low"].includes(card.confidence) ? card.confidence : "low",
      }))
      .filter((card) => card.input || card.candidates.length)
      .slice(0, 12),
  };
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const chunks = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("").trim();
}

function extractGeminiText(payload) {
  const chunks = [];
  for (const candidate of payload?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (typeof part?.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("").trim();
}

function stripJsonFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseJsonFromModel(text, label) {
  const cleaned = stripJsonFence(text);
  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    const isolated = isolateFirstJsonValue(cleaned);
    if (isolated && isolated !== cleaned) {
      try {
        return JSON.parse(isolated);
      } catch {
        // Fall through to the clearer error below.
      }
    }
    const detail = firstError instanceof Error ? firstError.message : String(firstError);
    throw new Error(`${label} returned invalid JSON: ${detail}`);
  }
}

function isolateFirstJsonValue(text) {
  const start = text.search(/[\[{]/);
  if (start < 0) return "";

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return "";
      if (!stack.length) return text.slice(start, index + 1);
    }
  }

  return "";
}

function assertGeminiNotTruncated(payload, label) {
  const finishReasons = (payload?.candidates || [])
    .map((candidate) => candidate?.finishReason)
    .filter(Boolean);
  if (finishReasons.some((reason) => String(reason).toUpperCase() === "MAX_TOKENS")) {
    throw new Error(`${label} was truncated by max output tokens. Increase GEMINI_MAX_OUTPUT_TOKENS or GEMINI_CARD_RESOLUTION_TOKENS.`);
  }
}

function toGeminiSchema(schema) {
  const result = {};
  const type = String(schema.type || "").toLowerCase();
  const typeMap = {
    object: "OBJECT",
    array: "ARRAY",
    string: "STRING",
    number: "NUMBER",
    integer: "INTEGER",
    boolean: "BOOLEAN",
  };

  if (typeMap[type]) result.type = typeMap[type];
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = schema.enum;
  if (schema.required) result.required = schema.required;
  if (schema.items) result.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    result.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      result.properties[key] = toGeminiSchema(value);
    }
  }
  return result;
}
