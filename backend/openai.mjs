const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdictTitle", "verdict", "confidence", "steps", "needsConfirmation"],
  properties: {
    verdictTitle: {
      type: "string",
      description: "Short Chinese title for the answer.",
    },
    verdict: {
      type: "string",
      description: "Main answer in Simplified Chinese.",
    },
    confidence: {
      type: "string",
      enum: ["confirmed", "inferred", "unknown"],
      description: "confirmed only when matchKind=direct Q&A or FAQ supports the exact handling; analogous evidence must be inferred or unknown.",
    },
    steps: {
      type: "array",
      items: { type: "string" },
      description: "Concrete handling steps.",
    },
    needsConfirmation: {
      type: "array",
      items: { type: "string" },
      description: "Facts or official sources still needed.",
    },
    subAnswers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "verdict", "reasoning", "source"],
        properties: {
          question: {
            type: "string",
            description: "One independent sub-question from the user.",
          },
          verdict: {
            type: "string",
            description: "Independent conclusion for this sub-question.",
          },
          reasoning: {
            type: "string",
            description: "Condition-by-condition reasoning for this sub-question.",
          },
          source: {
            type: "string",
            description: "Q&A source id/label, or [推理，需确认] when unsupported.",
          },
        },
      },
      description: "Independent answers for each sub-question. Required in practice when the question has multiple parts.",
    },
  },
};

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

export async function buildModelAnswer(context, env = globalThis.process?.env || {}) {
  const provider = String(env.MODEL_PROVIDER || "").toLowerCase();
  if (provider === "gemini" || (!provider && env.GEMINI_API_KEY && (env.GEMINI_MODEL || env.GEMINI_MODELS))) {
    return buildGeminiAnswer(context, env);
  }

  if (provider && provider !== "openai") return null;
  return buildOpenAiAnswer(context, env);
}

export async function resolveCardNamesWithModel(question, env = globalThis.process?.env || {}) {
  const provider = String(env.MODEL_PROVIDER || "").toLowerCase();
  if (provider === "gemini" || (!provider && env.GEMINI_API_KEY && (env.GEMINI_MODEL || env.GEMINI_MODELS))) {
    return resolveGeminiCardNames(question, env);
  }

  if (provider && provider !== "openai") return null;
  return resolveOpenAiCardNames(question, env);
}

async function buildOpenAiAnswer(context, env) {
  const apiKey = env.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL;
  if (!apiKey || !model) return null;

  const instructions = buildInstructions();
  const userText = buildUserText(context);

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
          content: [{ type: "input_text", text: instructions }],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: userText,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "ocg_ruling_answer",
          schema: responseSchema,
          strict: true,
        },
      },
      max_output_tokens: Number(env.OPENAI_MAX_OUTPUT_TOKENS || 1400),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI API ${response.status}: ${detail.slice(0, 400)}`);
  }

  const payload = await response.json();
  const text = extractResponseText(payload);
  if (!text) throw new Error("OpenAI API response did not contain output text.");
  return { ...parseJsonFromModel(text, "OpenAI answer"), provider: "openai" };
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

async function buildGeminiAnswer(context, env) {
  const apiKey = env.GEMINI_API_KEY;
  const models = getGeminiModelList(env, "GEMINI_MODELS", "GEMINI_MODEL");
  if (!apiKey || !models.length) return null;

  return runGeminiFallback(models, (model) => buildGeminiAnswerWithModel(context, env, apiKey, model));
}

async function buildGeminiAnswerWithModel(context, env, apiKey, model) {
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: buildInstructions() }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: buildUserText(context) }],
        },
      ],
      generationConfig: {
        maxOutputTokens: Number(env.GEMINI_MAX_OUTPUT_TOKENS || 4096),
        temperature: env.GEMINI_TEMPERATURE === undefined ? 0.1 : Number(env.GEMINI_TEMPERATURE),
        candidateCount: 1,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(responseSchema),
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gemini API ${response.status}: ${detail.slice(0, 400)}`);
  }

  const payload = await response.json();
  assertGeminiNotTruncated(payload, "Gemini answer");
  const text = extractGeminiText(payload);
  if (!text) throw new Error("Gemini API response did not contain output text.");
  return { ...parseJsonFromModel(text, "Gemini answer"), provider: "gemini", model };
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

function buildInstructions() {
  return [
    "你是一个游戏王OCG裁定专家。回答规则问题时，必须严格按照以下步骤：",
    "",
    "## 强制推理框架",
    "",
    "### Step 1: 问题拆解",
    "列出用户提问中包含的所有独立子问题，逐一编号，并用 subAnswers 逐条回答。",
    "",
    "### Step 2: 效果识别（针对每张卡的每个相关效果）",
    "- 效果类型：诱发/诱发即时/永续/起动",
    "- 是否含誓约条件（このカードの効果を発動するための～）",
    "- 是否含替代发动条件",
    "",
    "### Step 3: 发动条件逐一核对",
    "针对每个子问题，列出发动条件并对照场景逐条 ✓/✗ 验证。",
    "",
    "### Step 4: 连锁规则",
    "- 当前是否有连锁封锁效果存在？",
    "- 被封锁的效果类型是否与当前效果匹配？",
    "",
    "### Step 5: 逐条结论",
    "针对 Step 1 的每个子问题给出独立结论。",
    "",
    "## 严格规则",
    "1. 没有检索到的Q&A支持时，必须说明“需要Q&A确认”，不得给出已确认结论。",
    "2. 誓约效果（自身の効果による特殊召喚）不受一般连锁封锁影响——这是OCG固有规则。",
    "3. 诱发效果的发动时机是“效果处理结束后的时点”，不是效果发动时。",
    "4. 回答中必须指出每个结论对应的Q&A来源编号；没有来源的推理必须标注[推理，需确认]。",
    "5. 置信度只有在找到直接对应Q&A时才能是 confirmed；否则只能是 inferred 或 unknown。",
    "",
    "## 禁止行为",
    "- 禁止只给结论不给理由。",
    "- 禁止把“卡片文本”当作裁定依据（文本不等于裁定）。",
    "- 禁止对含5个以上子问题的提问只回答一个。",
    "",
    "## 输出约束",
    "必须使用简体中文，只能根据输入的证据包和通用OCG处理原则回答。",
    "不要引用证据包之外的具体Q&A或裁定编号。",
    "如果证据与问题场面不完全一致，必须在 needsConfirmation 中列出差异。",
    "verdict 不超过 420 个汉字，steps 不超过 8 条，needsConfirmation 不超过 6 条。",
  ].join("\n");
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

function buildUserText(context) {
  const evidence = context.evidence.slice(0, 10).map((item) => ({
    type: item.recordType,
      title: item.title,
      matchKind: item.matchKind || "",
      matchScore: item.matchScore || 0,
      cards: item.cards,
    text: item.conclusion,
    steps: item.steps,
    sources: item.sources,
  }));

  return JSON.stringify(
    {
      question: context.question,
      questionTypes: context.questionTypes || [],
      subQuestions: context.subQuestions || [],
      detectedCards: context.detectedCards.map((card) => ({
        name: card.name,
        matched: card.matched,
        released: card.released,
      })),
      topics: context.topics.map((topic) => topic.label),
      chainItems: context.chainItems,
      snapshotAt: context.snapshotMeta?.generatedAt || null,
      evidence,
    },
    null,
    2
  );
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
