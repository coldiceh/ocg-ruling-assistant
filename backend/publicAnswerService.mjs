import {
  createPublicAnswerModelEnv,
  getRagBudgetStatus,
  resolveCardExtractionProvider,
  resolveRagProvider,
} from "./ragModelClient.mjs";
import {
  assertPublicRulingModelProfileAvailable,
  getPublicRulingModelCapabilities,
  resolvePublicRulingModelProfile,
} from "./publicRulingModelConfig.mjs";
import { appendQueryAudit } from "./queryAuditStore.mjs";
import {
  publicAnswerLatencyStorageStatus,
  readPublicAnswerLatencyProfiles,
  recordPublicAnswerLatency,
} from "./publicAnswerLatencyStore.mjs";
import {
  answerRagRulingQuestionForVersion,
  getRulingVersionCapabilities,
} from "./rulingVersionRegistry.mjs";

export const PUBLIC_ANSWER_REQUEST_BODY_LIMIT_BYTES = 64 * 1024;
export const PUBLIC_ANSWER_QUESTION_LIMIT_CHARACTERS = 12_000;

export function parsePublicAnswerPayload(body, {
  declaredBytes = null,
} = {}) {
  assertBodySize(declaredBytes);

  let payload = body;
  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    payload = Buffer.from(payload).toString("utf8");
  }
  if (typeof payload === "string") {
    assertBodySize(Buffer.byteLength(payload, "utf8"));
    if (!payload.trim()) {
      throw publicAnswerRequestError(
        "Request body must contain a JSON object",
        "empty_request_body",
      );
    }
    try {
      payload = JSON.parse(payload);
    } catch {
      throw publicAnswerRequestError(
        "Request body must contain valid JSON",
        "invalid_json",
      );
    }
  } else {
    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      throw publicAnswerRequestError(
        "Request body must be JSON-serializable",
        "invalid_request_body",
      );
    }
    if (serialized === undefined) {
      throw publicAnswerRequestError(
        "Request body must contain a JSON object",
        "empty_request_body",
      );
    }
    assertBodySize(Buffer.byteLength(serialized, "utf8"));
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw publicAnswerRequestError(
      "Request body must be a JSON object",
      "invalid_request_body",
    );
  }

  if (typeof payload.question !== "string" || !payload.question.trim()) {
    throw publicAnswerRequestError(
      "question must be a non-empty string",
      "invalid_question",
    );
  }
  const question = payload.question.trim();
  if (Array.from(question).length > PUBLIC_ANSWER_QUESTION_LIMIT_CHARACTERS) {
    throw publicAnswerRequestError(
      `question exceeds ${PUBLIC_ANSWER_QUESTION_LIMIT_CHARACTERS} characters`,
      "question_too_long",
      413,
    );
  }

  return {
    ...payload,
    question,
  };
}

export function declaredRequestBodyBytes(request) {
  const headers = request?.headers;
  const raw = typeof headers?.get === "function"
    ? headers.get("content-length")
    : headers?.["content-length"] ?? headers?.["Content-Length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const text = String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) return null;
  const bytes = Number(text);
  return Number.isSafeInteger(bytes) ? bytes : Number.POSITIVE_INFINITY;
}

export async function getPublicAnswerModelInfo({ env = process.env } = {}) {
  const modelCapabilities = getPublicRulingModelCapabilities(env);
  const availableProfileIds = modelCapabilities.rulingModelProfiles
    .filter((profile) => profile.available)
    .map((profile) => profile.id);
  const latencyStorage = publicAnswerLatencyStorageStatus(env);
  const latencyResult = await readPublicAnswerLatencyProfiles({
    profileIds: availableProfileIds,
    env,
  }).catch(() => ({ profiles: [] }));
  const latencyByProfile = new Map(
    (latencyResult.profiles || []).map((item) => [item.profileId, item]),
  );
  const rulingModelProfiles = modelCapabilities.rulingModelProfiles.map((profile) => ({
    ...profile,
    ...(profile.available ? { answerLatency: latencyByProfile.get(profile.id) || null } : {}),
  }));
  const defaultRulingModelProfile = rulingModelProfiles.find(
    (profile) => profile.id === modelCapabilities.defaultRulingModelProfile,
  );
  const publicEnv = createPublicAnswerModelEnv(env, modelCapabilities.defaultRulingModelProfile);
  const ragProvider = resolveRagProvider(publicEnv);
  const cardProvider = resolveCardExtractionProvider(publicEnv);
  const budget = await getRagBudgetStatus({ env: publicEnv }).catch(() => null);
  const rulingVersionCapabilities = getRulingVersionCapabilities();
  return {
    ...rulingVersionCapabilities,
    ...modelCapabilities,
    rulingModelProfiles,
    answerLatency: {
      ...latencyStorage,
      profiles: latencyResult.profiles || [],
    },
    provider: defaultRulingModelProfile?.provider || "none",
    requestedProvider: ragProvider.requested,
    models: rulingModelProfiles.map((profile) => profile.model),
    cardNameProvider: cardProvider.provider,
    cardNameModels: [publicEnv.DEEPSEEK_CARD_MODEL || "deepseek-v4-flash"],
    modelTiers: [],
    budget,
    engineEnabled: false,
    enabled: rulingModelProfiles.some((profile) => profile.available),
    pipeline: "rag_baseline",
    legacyModes: [],
  };
}

export async function answerPublicRulingQuestion({
  payload,
  env = process.env,
  signal,
} = {}) {
  const normalizedPayload = parsePublicAnswerPayload(payload);
  const mode = String(normalizedPayload.mode || "rag").toLowerCase();
  if (mode !== "rag") {
    throw publicAnswerRequestError(
      "Only the evidence-grounded RAG answer mode is public",
      "unsupported_answer_mode",
    );
  }

  const profile = resolvePublicRulingModelProfile(
    normalizedPayload.rulingModelProfile || env.PUBLIC_RULING_MODEL_PROFILE,
  );
  assertPublicRulingModelProfileAvailable(profile, env);
  const publicEnv = createPublicAnswerModelEnv(env, profile.id);
  const auditPromise = appendQueryAudit({
    question: normalizedPayload.question,
    mode,
    env: publicEnv,
  }).catch(() => null);
  const answerStartedAt = Date.now();

  try {
    const answer = await answerRagRulingQuestionForVersion({
      rulingVersion: normalizedPayload.rulingVersion,
      question: normalizedPayload.question,
      env: publicEnv,
      signal,
    });
    await auditPromise;
    return {
      answer,
      latency: {
        profileId: profile.id,
        durationMs: Math.max(0, Date.now() - answerStartedAt),
      },
    };
  } catch (error) {
    await auditPromise;
    throw error;
  }
}

export async function persistPublicAnswerLatency({ latency, env = process.env } = {}) {
  if (!latency?.profileId || !Number.isFinite(latency?.durationMs)) return;
  await recordPublicAnswerLatency({
    profileId: latency.profileId,
    durationMs: Math.max(0, latency.durationMs),
    env,
  });
}

export function publicAnswerHttpError(error) {
  const inferredStatus = error?.code === "request_body_too_large" ? 413 : error?.statusCode;
  const statusCode = [400, 413, 503].includes(inferredStatus) ? inferredStatus : 500;
  const publicMessage = error?.code === "rag_data_unavailable"
    && error?.expose === true
    && String(error?.publicMessage || "").trim()
    ? String(error.publicMessage).trim()
    : "";
  return {
    statusCode,
    payload: {
      error: publicMessage || (error instanceof Error ? error.message : String(error)),
      code: error?.code || "answer_failed",
    },
  };
}

export function createPublicAnswerAbortContext(request, response) {
  // Fetch/WHATWG requests own a connection-lifetime AbortSignal. Node's
  // IncomingMessage gained a different `signal` property in Node 24.16: it is
  // tied to the readable request stream and can abort after a normal POST body
  // has been consumed, while the server is still computing its response. A
  // Node-style request is therefore tracked with its established aborted/
  // response-close events below instead of feature-detecting `.signal` alone.
  const nodeStyleRequest = typeof request?.once === "function"
    && typeof request?.off === "function";
  if (!nodeStyleRequest && request?.signal && typeof request.signal.aborted === "boolean") {
    return { signal: request.signal, cleanup() {} };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => {
    if (!response?.writableEnded && !response?.finished) abort();
  };
  request?.once?.("aborted", abort);
  response?.once?.("close", close);
  return {
    signal: controller.signal,
    cleanup() {
      request?.off?.("aborted", abort);
      response?.off?.("close", close);
    },
  };
}

function assertBodySize(bytes) {
  if (bytes === null || bytes === undefined) return;
  if (!Number.isFinite(bytes) || bytes > PUBLIC_ANSWER_REQUEST_BODY_LIMIT_BYTES) {
    throw publicAnswerRequestError(
      `Request body exceeds ${PUBLIC_ANSWER_REQUEST_BODY_LIMIT_BYTES} bytes`,
      "request_body_too_large",
      413,
    );
  }
}

function publicAnswerRequestError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
