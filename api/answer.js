import {
  createPublicAnswerModelEnv,
  getRagBudgetStatus,
  resolveCardExtractionProvider,
  resolveRagProvider,
} from "../backend/ragModelClient.mjs";
import {
  assertPublicRulingModelProfileAvailable,
  getPublicRulingModelCapabilities,
  resolvePublicRulingModelProfile,
} from "../backend/publicRulingModelConfig.mjs";
import { appendQueryAudit } from "../backend/queryAuditStore.mjs";
import {
  publicAnswerLatencyStorageStatus,
  readPublicAnswerLatencyProfiles,
  recordPublicAnswerLatency,
} from "../backend/publicAnswerLatencyStore.mjs";
import {
  answerRagRulingQuestionForVersion,
  getRulingVersionCapabilities,
} from "../backend/rulingVersionRegistry.mjs";
import {
  createConfiguredLegacyLuaSemanticPacketFactory,
} from "../backend/legacyLuaSemanticProduction.mjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

export default async function handler(request, response) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (request.method === "GET") {
    response.status(200).json(await getModelInfo());
    return;
  }

  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  let auditPromise = Promise.resolve();
  let answerStartedAt = 0;
  let selectedProfileId = "";
  const requestAbort = createRequestAbortContext(request, response);
  try {
    const payload = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
    const mode = String(payload.mode || "rag").toLowerCase();
    if (mode !== "rag") {
      const error = new Error("Only the evidence-grounded RAG answer mode is public");
      error.statusCode = 400;
      error.code = "unsupported_answer_mode";
      throw error;
    }
    const profile = resolvePublicRulingModelProfile(payload.rulingModelProfile);
    assertPublicRulingModelProfileAvailable(profile, process.env);
    selectedProfileId = profile.id;
    const publicEnv = createPublicAnswerModelEnv(process.env, profile.id);
    const legacyLuaSemanticPacketFactory =
      createConfiguredLegacyLuaSemanticPacketFactory({ env: publicEnv });
    auditPromise = appendQueryAudit({
      question: payload.question,
      mode,
      env: publicEnv,
    }).catch(() => null);
    answerStartedAt = Date.now();
    const answer = await answerRagRulingQuestionForVersion({
      rulingVersion: payload.rulingVersion,
      question: payload.question,
      env: publicEnv,
      engineScenario: payload.engineScenario,
      legacyLuaSemanticPacketFactory,
      signal: requestAbort.signal,
    });
    await auditPromise;
    const durationMs = Math.max(0, Date.now() - answerStartedAt);
    response.status(200).json(answer);
    // The answer is already on the wire. Keep the serverless invocation alive
    // only long enough for this best-effort write; failures never change the
    // successful response the user has received.
    await recordPublicAnswerLatency({
      profileId: selectedProfileId,
      durationMs,
      env: process.env,
    }).catch(() => null);
  } catch (error) {
    await auditPromise;
    if (requestAbort.signal.aborted) return;
    response.status([400, 503].includes(error?.statusCode) ? error.statusCode : 500).json({
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || "answer_failed",
    });
  } finally {
    requestAbort.cleanup();
  }
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

async function getModelInfo() {
  const modelCapabilities = getPublicRulingModelCapabilities(process.env);
  const availableProfileIds = modelCapabilities.rulingModelProfiles
    .filter((profile) => profile.available)
    .map((profile) => profile.id);
  const latencyStorage = publicAnswerLatencyStorageStatus(process.env);
  const latencyResult = await readPublicAnswerLatencyProfiles({
    profileIds: availableProfileIds,
    env: process.env,
  }).catch(() => ({ profiles: [] }));
  const latencyByProfile = new Map(
    (latencyResult.profiles || []).map((item) => [item.profileId, item]),
  );
  const rulingModelProfiles = modelCapabilities.rulingModelProfiles.map((profile) => ({
    ...profile,
    ...(profile.available ? { answerLatency: latencyByProfile.get(profile.id) || null } : {}),
  }));
  const publicEnv = createPublicAnswerModelEnv(process.env, modelCapabilities.defaultRulingModelProfile);
  const ragProvider = resolveRagProvider(publicEnv);
  const cardProvider = resolveCardExtractionProvider(publicEnv);
  const budget = await getRagBudgetStatus({ env: publicEnv }).catch(() => null);
  const engineEnabled = !/^(?:0|false|off|disabled|no)$/iu.test(
    String(publicEnv.RAG_AUTO_ENGINE_SIMULATION ?? "true").trim(),
  ) && Boolean(String(publicEnv.OCG_ENGINE_URL || "").trim());
  const rulingVersionCapabilities = getRulingVersionCapabilities();
  return {
    ...rulingVersionCapabilities,
    ...modelCapabilities,
    rulingModelProfiles,
    answerLatency: {
      ...latencyStorage,
      profiles: latencyResult.profiles || [],
    },
    provider: "glm",
    requestedProvider: ragProvider.requested,
    models: rulingModelProfiles.map((profile) => profile.model),
    cardNameProvider: cardProvider.provider,
    cardNameModels: [publicEnv.DEEPSEEK_CARD_MODEL || "deepseek-v4-flash"],
    modelTiers: [],
    budget,
    engineEnabled,
    enabled: rulingModelProfiles.some((profile) => profile.available),
    pipeline: "rag_baseline",
    legacyModes: [],
  };
}

function createRequestAbortContext(request, response) {
  if (request?.signal && typeof request.signal.aborted === "boolean") {
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
