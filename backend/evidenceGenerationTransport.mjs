import { createHash } from "node:crypto";

export const DEFAULT_BAI_GENERATION_BASE_URL = "https://api.b.ai/v1";

export function createEvidenceGenerationTransport({ contract, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!contract || typeof contract !== "object") throw new TypeError("evidence_generation_transport_contract_required");
  if (contract.status !== "ready") throw new TypeError("evidence_generation_transport_contract_incomplete");
  if (contract.providerId === "gemini") return createGeminiTransport({ contract, env, fetchImpl });
  if (contract.providerId === "bai") {
    if (contract.transportContract?.protocol !== "responses" || contract.transportContract?.endpoint !== "/v1/responses") {
      throw new TypeError("evidence_generation_transport_contract_invalid");
    }
    return createBaiResponsesTransport({ contract, env, fetchImpl });
  }
  throw new TypeError(`evidence_generation_transport_provider_unsupported:${String(contract.providerId || "")}`);
}

export function convertEvidenceGenerationRequest(body, contract) {
  if (contract?.providerId === "gemini") return structuredClone(body);
  if (contract?.providerId !== "bai") throw new TypeError("evidence_generation_transport_provider_unsupported");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("evidence_generation_request_body_invalid");
  const instructions = textFromParts(body.systemInstruction?.parts);
  const input = (Array.isArray(body.contents) ? body.contents : []).map((message) => ({
    role: message?.role === "model" ? "assistant" : message?.role === "system" ? "system" : "user",
    content: textFromParts(message?.parts),
  }));
  if (!input.length || input.some((message) => !message.content)) {
    throw new TypeError("evidence_generation_request_messages_invalid");
  }
  const reasoning = contract.reasoningConfig?.responses;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning) || !Object.keys(reasoning).length) {
    throw new TypeError("evidence_generation_reasoning_mapping_missing");
  }
  const responseFormat = contract.responseFormatConfig?.responses;
  const wireInput = responseFormat?.type === "json_object"
    ? [{ role: "system", content: "Return the response as JSON." }, ...input]
    : input;
  const wire = {
    model: contract.modelId,
    ...(instructions ? { instructions } : {}),
    input: wireInput,
    stream: false,
    max_output_tokens: contract.maxBillableOutputTokens,
    reasoning: structuredClone(reasoning),
    text: { format: structuredClone(responseFormat) },
  };
  return wire;
}

function createGeminiTransport({ contract, env, fetchImpl }) {
  const apiKey = () => requiredSecret(env.GEMINI_RULE_QA_API_KEY || env.GEMINI_API_KEY, "gemini_navigation_api_key_required");
  const base = "https://generativelanguage.googleapis.com/v1beta";
  const call = async (operation, body, { signal } = {}) => {
    requireFetch(fetchImpl);
    const response = await fetchImpl(`${base}/models/${contract.modelId}:${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey() },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    return readJsonResponse(response, `gemini_navigation_http_${response.status}`);
  };
  return Object.freeze({
    providerId: "gemini",
    prepareRequest: (body) => convertEvidenceGenerationRequest(body, contract),
    countTokens: (body, options) => call("countTokens", body, options),
    invoke: (body, options) => {
      assertMeasuredWireRequest(body, contract, options?.measurement);
      return call("generateContent", body, options);
    },
    extractText: extractGeminiText,
    rawUsage: (raw) => raw?.usageMetadata ?? null,
    validateResponse: () => true,
  });
}

function createBaiResponsesTransport({ contract, env, fetchImpl }) {
  const endpoint = `${normalizeBaiBaseUrl(env.RAG_EVIDENCE_BAI_BASE_URL || env.BAI_BASE_URL)}/responses`;
  return Object.freeze({
    providerId: "bai",
    protocol: "responses",
    prepareRequest: (body) => convertEvidenceGenerationRequest(body, contract),
    invoke: async (body, { measurement, signal } = {}) => {
      assertMeasuredWireRequest(body, contract, measurement);
      requireFetch(fetchImpl);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${requiredSecret(
            env.RAG_EVIDENCE_BAI_API_KEY || env.BAI_API_KEY,
            "bai_navigation_api_key_required",
          )}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      return readJsonResponse(response, `bai_navigation_http_${response.status}`);
    },
    extractText: extractBaiResponsesText,
    rawUsage: (raw) => raw?.usage ?? null,
    validateResponse: (raw) => validateBaiResponse(raw, contract),
  });
}

function assertMeasuredWireRequest(body, contract, measurement) {
  const serialized = JSON.stringify(body);
  if (!measurement || measurement.providerId !== contract.providerId
      || measurement.modelId !== contract.modelId
      || measurement.generationContractSha256 !== sha256(stableJson(contract))
      || measurement.requestSha256 !== sha256(serialized)
      || measurement.requestBodyBytes !== Buffer.byteLength(serialized, "utf8")
      || measurement.countingContractVersion !== contract.countingContractVersion
      || measurement.contextCountingContractVersion !== contract.capacityContract?.contextCountingContractVersion
      || !Number.isSafeInteger(measurement.inputTokensUpperBound) || measurement.inputTokensUpperBound <= 0
      || (measurement.contextInputTokensUpperBound !== null
        && (!Number.isSafeInteger(measurement.contextInputTokensUpperBound) || measurement.contextInputTokensUpperBound <= 0))
      || !measurementBasisAllowed(contract, measurement)) {
    throw new Error("evidence_generation_unmeasured_request_blocked");
  }
}

function measurementBasisAllowed(contract, measurement) {
  if (contract.providerId === "gemini") {
    return measurement.basis === "provider_count" && measurement.exact === true;
  }
  return contract.providerId === "bai"
    && contract.measurementContract?.status === "user_authorized_theoretical"
    && contract.measurementContract?.basis === "user_authorized_theoretical"
    && contract.measurementContract?.exact === false
    && measurement.basis === "user_authorized_theoretical"
    && measurement.exact === false
    && measurement.inputTokenAllocationKind === "theoretical_estimate"
    && measurement.estimatorVersion === contract.measurementContract?.estimator?.version;
}

function validateBaiResponse(raw, contract) {
  if (raw?.model !== contract.modelId) throw new Error("evidence_generation_response_model_mismatch");
  if (raw?.status !== "completed") {
    const error = new Error(`evidence_generation_response_${String(raw?.status || "invalid")}`);
    error.incompleteDetails = raw?.incomplete_details ?? null;
    throw error;
  }
  return true;
}

function extractGeminiText(raw) {
  return (Array.isArray(raw?.candidates?.[0]?.content?.parts)
    ? raw.candidates[0].content.parts
    : [])
    .filter((part) => !part?.thought && typeof part?.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function extractBaiResponsesText(raw) {
  return (Array.isArray(raw?.output) ? raw.output : [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => part?.type === "output_text")
    .map((part) => String(part.text || ""))
    .join("");
}

function textFromParts(parts) {
  return (Array.isArray(parts) ? parts : []).map((part) => String(part?.text || "")).filter(Boolean).join("\n\n");
}

function normalizeBaiBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || DEFAULT_BAI_GENERATION_BASE_URL).trim());
  } catch {
    throw new TypeError("BAI_BASE_URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("BAI_BASE_URL must be a credential-free HTTPS URL without query or fragment");
  }
  const normalized = parsed.toString().replace(/\/+$/u, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

async function readJsonResponse(response, errorCode) {
  let raw;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`${errorCode}:invalid_json`);
  }
  if (!response.ok) {
    const error = new Error(errorCode);
    error.status = response.status;
    error.providerResponse = raw;
    throw error;
  }
  return raw;
}

function requiredSecret(value, code) {
  const secret = String(value || "").trim();
  if (!secret) throw new Error(code);
  return secret;
}

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("evidence_generation_fetch_required");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}
