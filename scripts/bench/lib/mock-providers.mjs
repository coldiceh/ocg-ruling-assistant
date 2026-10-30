// Transport-level fakes for --mock. Every response is generated in-process
// from the request body (and, for the evidence plan, from the job's question),
// so the whole production pipeline runs without keys or network. The fake
// model outputs are mechanical: they echo local references, pick the first
// offered evidence ids and print a digest of the final prompt. They carry no
// ruling content and are only meant to exercise the pipeline and the files.
import { createHash } from "node:crypto";

const MOCK_SELECTION_LIMIT = 6;
const MOCK_FINAL_OUTPUT_TOKENS = 200;

function digest(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(text), "utf8") / 3));
}

function pseudoVector(text, dimension) {
  const values = [];
  let block = digest(text);
  for (let index = 0; values.length < dimension; index += 1) {
    if (index > 0 && index % 16 === 0) block = digest(block);
    const offset = (index % 16) * 4;
    values.push(Number.parseInt(block.slice(offset, offset + 4), 16) / 0xffff - 0.5);
  }
  const norm = Math.hypot(...values) || 1;
  return values.map((value) => value / norm);
}

function responsesPayload(model, text, { inputText, outputTokens = 120 }) {
  const inputTokens = estimateTokens(inputText);
  return {
    id: `mock-resp-${digest(`${inputText}\n${text}`).slice(0, 16)}`,
    object: "response",
    model,
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: Math.floor(outputTokens / 2) },
      total_tokens: inputTokens + outputTokens,
    },
  };
}

// The JSON line that follows a given heading line inside a prompt.
function jsonAfterHeading(prompt, headingPredicate) {
  const lines = String(prompt).split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!headingPredicate(lines[index])) continue;
    try {
      return JSON.parse(lines[index + 1]);
    } catch {
      return null;
    }
  }
  return null;
}

function mockCardTask(prompt) {
  const candidateSets = jsonAfterHeading(prompt, (line) => line.trim() === "候选集：");
  if (Array.isArray(candidateSets)) {
    // Identity selection: decline every mention (candidateId null is the
    // documented "cannot decide" answer), leaving identities unconfirmed.
    return { task: "card_identity_selection", output: {
      selections: candidateSets.map((set) => ({ mentionId: set?.mentionId, candidateId: null })),
    } };
  }
  // Card-name extraction: echo the local catalog references that the
  // pipeline itself placed in the prompt (exact local matches only).
  const references = jsonAfterHeading(prompt, (line) => line.includes("卡库名称参考"));
  const cardNames = (Array.isArray(references) ? references : []).map((reference) => ({
    name: reference.name || reference.input || "",
    enName: reference.enName || "",
    jaName: reference.jaName || "",
    cnName: reference.cnName || "",
    originalText: reference.input || reference.name || "",
    confidence: "high",
  })).filter((item) => item.originalText);
  return { task: "card_name_extraction", output: { cardNames, groupMentions: [], describedCards: [] } };
}

function lastUserJson(body) {
  const messages = Array.isArray(body.input) ? body.input : [];
  const user = [...messages].reverse().find((message) => message?.role === "user");
  const content = typeof user?.content === "string" ? user.content : "";
  try {
    return JSON.parse(content.split("\n").at(-1));
  } catch {
    return null;
  }
}

function mockPlan(question) {
  const text = String(question || "").replace(/\s+/gu, " ").trim();
  return { needs: [{ id: "n1", question: `MOCK 子问：${text.slice(0, 40)}`,
    ruleQuery: text.slice(0, 80), qaQuery: text.slice(0, 80) }] };
}

function mockSelection(delivered) {
  const offered = (delivered?.groups || []).flatMap((group) => [
    ...(group.units || []).map((row) => (Array.isArray(row) ? row[0] : null)),
    ...(group.items || []).map((item) => item?.handle),
  ]).filter((id) => typeof id === "string" && id);
  const selectedIds = [...new Set(offered)].slice(0, MOCK_SELECTION_LIMIT);
  return { checks: [], selectedIds, note: "MOCK：按候选出现顺序取前若干个编号，非模型选择。" };
}

function sseResponse(model, content, usage) {
  const id = `mock-chat-${digest(content).slice(0, 16)}`;
  const chunks = [
    { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content } }] },
    { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id, object: "chat.completion.chunk", model, choices: [], usage },
  ];
  const text = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * @param {{getContext: () => ({question?: string}|undefined)}} options
 * @returns {(url: URL, init: object) => Promise<{response: Response, task: string}|null>}
 */
export function createMockResponder({ getContext = () => undefined } = {}) {
  return async function respond(url, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    const bodyText = typeof init.body === "string" ? init.body : "";
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses" && method === "POST") {
      const body = JSON.parse(bodyText);
      if (Array.isArray(body.input)) {
        const delivered = lastUserJson(body);
        const isSelection = Array.isArray(delivered?.groups);
        const output = isSelection ? mockSelection(delivered) : mockPlan(getContext()?.question);
        return { task: isSelection ? "evidence_selection" : "evidence_plan",
          response: Response.json(responsesPayload(body.model, JSON.stringify(output), { inputText: bodyText })) };
      }
      const { task, output } = mockCardTask(String(body.input || ""));
      return { task, response: Response.json(responsesPayload(body.model, JSON.stringify(output),
        { inputText: bodyText, outputTokens: 60 })) };
    }
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/chat/completions" && method === "POST") {
      const body = JSON.parse(bodyText);
      const prompt = (body.messages || []).map((message) => String(message?.content || "")).join("\n");
      const content = `【MOCK 回答】这是 --mock 传输层生成的占位文本，不是模型输出。最终提示词 sha256:${digest(prompt).slice(0, 12)}，`
        + `${prompt.length} 字符。\n\n用于检查产物格式；判定列请勿据此填写。`;
      const promptTokens = estimateTokens(prompt);
      return { task: "final_answer", response: sseResponse(body.model, content, {
        prompt_tokens: promptTokens, completion_tokens: MOCK_FINAL_OUTPUT_TOKENS,
        total_tokens: promptTokens + MOCK_FINAL_OUTPUT_TOKENS,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 100 },
      }) };
    }
    if (url.hostname === "generativelanguage.googleapis.com" && method === "POST") {
      const match = /^\/v1beta\/models\/([^/:]+):([A-Za-z]+)$/u.exec(url.pathname);
      if (!match) return null;
      const [, model, operation] = match;
      const body = JSON.parse(bodyText);
      if (operation === "countTokens") {
        return { task: "gemini_count_tokens", response: Response.json({ totalTokens: estimateTokens(bodyText) }) };
      }
      if (operation === "embedContent") {
        const text = (body.content?.parts || []).map((part) => part?.text || "").join("");
        const dimension = Number(body.embedContentConfig?.outputDimensionality) || 768;
        return { task: "gemini_embedding", response: Response.json({ embedding: { values: pseudoVector(text, dimension) },
          usageMetadata: { promptTokenCount: estimateTokens(text) } }) };
      }
      if (operation === "batchEmbedContents") {
        const requests = Array.isArray(body.requests) ? body.requests : [];
        const texts = requests.map((request) => (request.content?.parts || []).map((part) => part?.text || "").join(""));
        return { task: "gemini_embedding", response: Response.json({
          embeddings: requests.map((request, index) => ({
            values: pseudoVector(texts[index], Number(request.embedContentConfig?.outputDimensionality) || 768),
          })),
          usageMetadata: { promptTokenCount: texts.reduce((sum, text) => sum + estimateTokens(text), 0) } }) };
      }
      if (operation === "generateContent") {
        const output = mockPlan(getContext()?.question);
        const promptTokens = estimateTokens(bodyText);
        return { task: "evidence_plan", response: Response.json({
          candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(output) }] }, finishReason: "STOP" }],
          modelVersion: model,
          usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: 80, thoughtsTokenCount: 40,
            totalTokenCount: promptTokens + 120 } }) };
      }
      return null;
    }
    if (url.hostname === "ygocdb.com" && method === "GET") {
      // 百鸽 search: an empty result list, as for a name with no match.
      return { task: "baige_search", response: Response.json({ result: [] }) };
    }
    if (url.hostname === "db.ygoresources.com" && method === "GET") {
      // Live official Q&A: answer like an unavailable optional source.
      return { task: "live_official_qa", response: new Response("mock: live official Q&A unavailable",
        { status: 503, headers: { "content-type": "text/plain" } }) };
    }
    return null;
  };
}
