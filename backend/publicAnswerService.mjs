import { randomUUID } from 'node:crypto';
import { attachEngineReproWhenReady, createEngineReproSession, engineReproWaitDeadline } from "./engineRepro/session.mjs";
import { startOfficialQaJudge } from "./engineRepro/officialQaJudge.mjs";
import { getPublicReleaseInfo } from './publicReleaseInfo.mjs';
import {
  createPublicAnswerModelEnv,
  getRagBudgetStatus,
  isServerOwnedPrivateEvaluationEnv,
  modelNameForCardExtractionProvider,
  resolveCardExtractionProvider,
  lunaCardProviderLabel,
  resolveRagProvider,
} from "./ragModelClient.mjs";
import {
  assertPublicRulingModelProfileAvailable,
  getPublicRulingModelCapabilities,
  resolvePublicRulingModelProfile,
} from "./publicRulingModelConfig.mjs";
import { appendQueryAudit, updateQueryAudit, saveSelectionIdentityDiagnostic } from "./queryAuditStore.mjs";
import { queryAuditAnswerPatch, queryAuditFailurePatch, saveQueryAuditUpdate } from "./publicQueryAudit.mjs";
import {
  publicAnswerLatencyStorageStatus,
  readPublicAnswerLatencyProfiles,
  recordPublicAnswerLatency,
} from "./publicAnswerLatencyStore.mjs";
import {
  answerExactOfficialQaQuestionForVersion,
  answerRagRulingQuestionForVersion,
  getRulingVersionCapabilities,
} from "./rulingVersionRegistry.mjs";
import { isPublicPreparationId } from "./publicAnswerPreparationStore.mjs";
import { preloadRagRequestAssets, ragRequestAssetsResident, startCardNameExtraction } from './ragRulingPipeline.mjs';
import { createCloudRequestBudget, runCloudBudgetedQuestion } from './cloudRequestBudget.mjs';
import { selectAvailablePublicProfile, withPublicGenerationInfo } from './publicGenerationInfo.mjs';
import {
  buildPublicOutOfScopeAnswer,
  buildPublicOfftopicRiskControlAnswer,
  publicOfftopicRiskControlStorageStatus,
  readPublicOfftopicRiskControl,
} from "./publicOfftopicRiskControl.mjs";
import {
  classifyPublicQueryScope,
} from "./publicQueryScopeClassifier.mjs";

export const PUBLIC_ANSWER_REQUEST_BODY_LIMIT_BYTES = 64 * 1024;
const CLOUD_BUDGET_PROVIDERS = new Set(["relay", "openai", "bai", "deepseek", "glm"]);
export const PUBLIC_ANSWER_QUESTION_LIMIT_CHARACTERS = 12_000;
export const PUBLIC_ANSWER_LOCALES = Object.freeze(["zh-CN", "en", "ja"]);
export const PUBLIC_EVIDENCE_SELECTORS = Object.freeze(["luna", "decisions"]);
export const DEFAULT_PUBLIC_EVIDENCE_SELECTOR = "luna";
// The public exact-question shortcut is temporarily disabled. Keep the
// underlying matcher and pipeline available for internal evaluation and a
// future, explicitly reviewed re-enable.
export const PUBLIC_EXACT_QA_ROUTE_ENABLED = false;

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

  if (payload.action === "finalize" || payload.action === "status") {
    if (!isPublicPreparationId(payload.preparationId)
      || Object.keys(payload).some((key) => !["action", "preparationId"].includes(key))) {
      throw publicAnswerRequestError(`${payload.action} requires only a valid preparationId`, "invalid_preparation_id");
    }
    return { action: payload.action, preparationId: payload.preparationId };
  }
  if (payload.action === "translate_source") {
    if (!isPublicPreparationId(payload.sourceSnapshotId)
        || typeof payload.sourceId !== "string" || !payload.sourceId || payload.sourceId.length > 200
        || !PUBLIC_ANSWER_LOCALES.includes(payload.targetLocale)
        || Object.keys(payload).some((key) => !["action", "sourceSnapshotId", "sourceId", "targetLocale"].includes(key))) {
      throw publicAnswerRequestError("Invalid source translation request", "invalid_source_translation_request", 400);
    }
    return payload;
  }
  if (payload.action !== undefined && payload.action !== "prepare") {
    throw publicAnswerRequestError("Unsupported answer action", "invalid_answer_action");
  }
  const allowedFields = ["action", "question", "mode", "rulingModelProfile", "rulingVersion", "answerLocale", "evidenceSelector"];
  if (Object.keys(payload).some(key => !allowedFields.includes(key))) {
    throw publicAnswerRequestError("Unsupported public request field", "unsupported_request_field");
  }
  if (payload.mode !== undefined && String(payload.mode).toLowerCase() !== 'rag') {
    throw publicAnswerRequestError("Only the evidence-grounded RAG answer mode is public", "unsupported_answer_mode");
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
  const answerLocale = payload.answerLocale === undefined ? "zh-CN" : payload.answerLocale;
  if (!PUBLIC_ANSWER_LOCALES.includes(answerLocale)) {
    throw publicAnswerRequestError("Unsupported answerLocale", "invalid_answer_locale", 400);
  }
  if (payload.evidenceSelector !== undefined && !PUBLIC_EVIDENCE_SELECTORS.includes(payload.evidenceSelector)) {
    throw publicAnswerRequestError("Unsupported evidenceSelector", "invalid_evidence_selector", 400);
  }

  return {
    ...payload,
    question,
    answerLocale,
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
  const selection = await selectAvailablePublicProfile(modelCapabilities.defaultRulingModelProfile, env);
  modelCapabilities.defaultRulingModelProfile = selection.profile.id;
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
    cardNameProvider: lunaCardProviderLabel(cardProvider.provider, publicEnv),
    cardNameModels: [modelNameForCardExtractionProvider(cardProvider.provider, publicEnv)],
    modelTiers: [],
    budget,
    engineEnabled: false,
    enabled: rulingModelProfiles.some((profile) => profile.available),
    pipeline: env.RAG_EVIDENCE_PIPELINE === 'cloud_evidence_v1' ? 'cloud_evidence_v1' : 'rag_baseline',
    legacyModes: [],
    answerExecution: "prepared_v1",
    defaultEvidenceSelector: DEFAULT_PUBLIC_EVIDENCE_SELECTOR,
    evidenceSelectors: PUBLIC_EVIDENCE_SELECTORS.map((id) => ({
      id,
      label: id === "decisions" ? "Decisions" : "Luna",
    })),
    release: getPublicReleaseInfo(env),
  };
}

export async function answerPublicRulingQuestion({
  payload,
  env = process.env,
  signal,
  progress,
  appendAudit = appendQueryAudit,
  updateAudit = updateQueryAudit,
  saveSelectionDiagnostic = saveSelectionIdentityDiagnostic,
  requestContext,
  readRiskControl = readPublicOfftopicRiskControl,
  classifyScope = classifyPublicQueryScope,
  answerOfficialExact = answerExactOfficialQaQuestionForVersion,
  answerRuling = answerRagRulingQuestionForVersion,
  preloadAssets = preloadRagRequestAssets,
  assetsResident = ragRequestAssetsResident,
  startCardExtraction = startCardNameExtraction,
  prepareForContinuation = false,
  createEngineRepro = createEngineReproSession,
  attachEngineRepro = attachEngineReproWhenReady,
  startJudge = startOfficialQaJudge,
} = {}) {
  const publicRequestStartedAt = Date.now();
  const requestDiagnostics = { requestId: randomUUID(), startedAt: new Date(publicRequestStartedAt).toISOString() };
  progress?.start?.();
  const normalizedPayload = parsePublicAnswerPayload(payload);
  if (normalizedPayload.action === "finalize" || normalizedPayload.action === "status") {
    throw publicAnswerRequestError(`${normalizedPayload.action} must use a saved preparation`, "invalid_answer_action");
  }
  const mode = String(normalizedPayload.mode || "rag").toLowerCase();
  if (mode !== "rag") {
    throw publicAnswerRequestError(
      "Only the evidence-grounded RAG answer mode is public",
      "unsupported_answer_mode",
    );
  }

  // Audit begins before any early return so every public question remains
  // visible to the administrator.
  const auditPromise = Promise.resolve().then(() => appendAudit({
    question: normalizedPayload.question,
    mode,
    env,
    requestId: requestDiagnostics.requestId,
    profileId: normalizedPayload.rulingModelProfile || env.PUBLIC_RULING_MODEL_PROFILE,
    requestContext,
  })).catch(() => null);
  // Experimental engine reproduction: every public request while ENGINE_REPRO_ENABLED is on
  // (its own daily budget and per-minute limit apply). It observes the pipeline's card
  // resolution and never changes the answer.
  const engineRepro = createEngineRepro({ env,
    requestStartedAt: publicRequestStartedAt, auditIdPromise: auditPromise.then((audit) => audit?.entry?.id || null),
    saveAudit: (auditId, patch) => saveQueryAuditUpdate(auditId, patch, env, updateAudit) });
  const auditResult = async (answer, status, extra = {}) => {
    const audit = await auditPromise;
    await saveQueryAuditUpdate(audit?.entry?.id, queryAuditAnswerPatch(answer, {
      status, latencyMs: Date.now() - publicRequestStartedAt, ...extra,
    }), env, updateAudit);
    return audit?.entry?.id;
  };

  let preloadedAssets;
  let preloadStarted = false;
  const startAssetPreload = () => {
    if (preloadStarted) return;
    preloadStarted = true;
    preloadedAssets = preloadAssets({ env, officialQaExactAlreadyChecked: true });
  };

  try {
  // Retain existing administrator/shared locks, but an unrelated question no
  // longer creates a global lock that would deny service to other users.
  const activeControl = await readPublicAnswerAvailability({ env, readRiskControl });
  if (activeControl?.active === true) {
    const answer = buildPublicOfftopicRiskControlAnswer({ status: activeControl, env });
    await auditResult(answer, "blocked");
    return { answer, latency: null };
  }

  // On a warm instance the snapshot and indexes are already resident, so the
  // preload is cheap and starts immediately. On a cold instance it parses and
  // builds indexes synchronously for several seconds; running that alongside
  // the scope classifier blocked the event loop past the classifier timeout
  // (observed 2026-10-11 on the first request after a deployment). A cold
  // instance therefore decides scope first and loads afterwards.
  const assetsWarm = assetsResident() === true;
  if (assetsWarm) startAssetPreload();

  const selection = await selectAvailablePublicProfile(normalizedPayload.rulingModelProfile || env.PUBLIC_RULING_MODEL_PROFILE, env);
  const profile = selection.profile;
  assertPublicRulingModelProfileAvailable(profile, env);
  const publicEnv = {
    ...createPublicAnswerModelEnv(env, profile.id),
    EVIDENCE_SELECTOR: normalizedPayload.evidenceSelector || DEFAULT_PUBLIC_EVIDENCE_SELECTOR,
  };
  // Evidence selection has its own official credential. Preserve only that
  // dedicated key after the final-model environment removes OPENAI_* values.
  if (publicEnv.EVIDENCE_SELECTOR === "decisions" && typeof env.OPENAI_DECISIONS_API_KEY === "string") {
    publicEnv.OPENAI_DECISIONS_API_KEY = env.OPENAI_DECISIONS_API_KEY.trim();
  }

  // The scope classifier and card-name extraction both read only the question,
  // so the extraction starts in parallel with the admission decision inside the
  // question's own cloud-budget scope. A question that is then denied aborts the
  // extraction; the pipeline reuses the result only on its own snapshot and
  // data revision. Set PUBLIC_CARD_EXTRACTION_OVERLAP_SCOPE=off to keep the
  // two steps serial.
  // The scope mirrors answerRagRulingQuestion's own wrapper: a mock provider or
  // a non-cloud pipeline runs without a shared budget controller as before.
  const cloudBudget = publicEnv.RAG_EVIDENCE_PIPELINE === "cloud_evidence_v1"
      && CLOUD_BUDGET_PROVIDERS.has(String(publicEnv.RAG_MODEL_PROVIDER || "bai"))
    ? createCloudRequestBudget({ env: publicEnv, fetchImpl: globalThis.fetch })
    : null;
  const inQuestionBudgetScope = cloudBudget
    ? (work) => runCloudBudgetedQuestion({ env: publicEnv, budget: cloudBudget }, work)
    : (work) => work();
  // Early card extraction needs the card snapshot, so it overlaps scope only
  // when that snapshot is already resident (same reason as the preload above).
  const overlapCardExtraction = Boolean(cloudBudget)
    && assetsWarm
    && shouldClassifyPublicQuestion(env)
    && !/^(?:0|false|off|no)$/iu.test(String(env.PUBLIC_CARD_EXTRACTION_OVERLAP_SCOPE || "").trim());
  const earlyExtractionAbort = new AbortController();
  let preloadedCardNameExtraction;
  if (overlapCardExtraction) {
    const earlySignal = signal ? AbortSignal.any([signal, earlyExtractionAbort.signal]) : earlyExtractionAbort.signal;
    preloadedCardNameExtraction = inQuestionBudgetScope(() => startCardExtraction({
      question: normalizedPayload.question, env: publicEnv, preloadedAssets, signal: earlySignal,
    }));
    preloadedCardNameExtraction.catch(() => {});
  }

  // Every new public question needs an explicit in-scope model decision before
  // retrieval. This per-request admission does not depend on shared lock storage
  // or its optional switch; classifier outages must not admit unrelated work.
  if (shouldClassifyPublicQuestion(env)) {
    const scopeStartedAt = Date.now();
    let scopeDecision;
    try {
      scopeDecision = await inQuestionBudgetScope(() => classifyScope({ question: normalizedPayload.question, env, signal }));
    } catch (error) {
      if (signal?.aborted) throw error;
      scopeDecision = { scope: "uncertain", reasonCode: "classifier_failed" };
    }
    signal?.throwIfAborted();
    requestDiagnostics.scope = scopeDiagnostic(scopeDecision, Date.now() - scopeStartedAt);
    if (scopeDecision?.scope === "out_of_scope") {
      earlyExtractionAbort.abort(new Error("public_query_out_of_scope"));
      const answer = {
        ...buildPublicOutOfScopeAnswer({ answerLocale: normalizedPayload.answerLocale }),
        debug: { requestDiagnostics },
      };
      await auditResult(answer, "blocked");
      return { answer, latency: null };
    }
    if (scopeDecision?.scope !== "in_scope") {
      earlyExtractionAbort.abort(new Error("public_query_scope_unavailable"));
      const scopeFailure = publicScopeFailure(scopeDecision);
      throw Object.assign(new Error(publicScopeFailureMessage(scopeFailure)), {
        code: "public_query_scope_unavailable", statusCode: 503, scopeFailure,
      });
    }
  }

  // Admitted (or classification-exempt) questions always load; this is a no-op
  // when the warm path above already started it.
  startAssetPreload();

  // Do not invoke the exact-question route from public requests. The RAG
  // pipeline still searches ordinary official Q&A and FAQ evidence.
  let exactMatchMs = 0;
  if (PUBLIC_EXACT_QA_ROUTE_ENABLED) {
    const exactMatchStartedAt = Date.now();
    const exactAnswer = await answerOfficialExact({
      rulingVersion: normalizedPayload.rulingVersion,
      question: normalizedPayload.question,
      env,
      signal,
      progress,
    });
    exactMatchMs = Math.max(0, Date.now() - exactMatchStartedAt);
    if (exactAnswer) {
      earlyExtractionAbort.abort(new Error("public_exact_answer"));
      await auditResult(exactAnswer, "completed");
      return { answer: exactAnswer, latency: null };
    }
  }

    // The section's official-Q&A judge (single-request shape): started by the pipeline when the
    // evidence is prepared, so it runs alongside the final model call.
    let officialQaJudge = null;
    let answer = await answerRuling({
      rulingVersion: normalizedPayload.rulingVersion,
      question: normalizedPayload.question,
      answerLocale: normalizedPayload.answerLocale,
      env: publicEnv,
      signal,
      officialQaExactAlreadyChecked: true,
      progress,
      preloadedAssets,
      ...(preloadedCardNameExtraction ? { preloadedCardNameExtraction } : {}),
      ...(cloudBudget ? { cloudBudget } : {}),
      onEvidenceEvent: event => event?.type === 'selection_identity_failure'
        ? saveSelectionDiagnostic({ event, requestId: requestDiagnostics.requestId, env }) : undefined,
      nonCardElapsedBeforePipelineMs: Math.max(0, Date.now() - publicRequestStartedAt),
      ...(prepareForContinuation === true ? { prepareForContinuation: true } : {}),
      ...(engineRepro.enabled ? {
        onCardTextsReady: engineRepro.onCardTextsReady,
        onEvidencePrepared: ({ officialQaJudgeInput }) => {
          officialQaJudge = startJudge({ input: officialQaJudgeInput, env });
        },
      } : {}),
    });
    requestDiagnostics.completedAt = new Date().toISOString();
    requestDiagnostics.durationMs = Math.max(0, Date.now() - publicRequestStartedAt);
    answer = { ...answer, answerLocale: normalizedPayload.answerLocale,
      debug: { ...answer.debug, requestDiagnostics } };
    if (!prepareForContinuation) answer = await withPublicGenerationInfo(answer, profile, env, {fallbackFrom:selection.fallbackFrom});
    // The answer is complete here: the response waits for the reproduction, up to this
    // invocation's own duration limit. Timing stays separate: the answer's own latency ends
    // here; the reproduction's timings and the wait are reported in their own fields.
    const mainCompletedAt = Date.now();
    if (!prepareForContinuation && engineRepro.enabled && engineRepro.state.started) {
      answer = await attachEngineRepro(answer, { env,
        auditId: (await auditPromise)?.entry?.id || null, requestStartedAt: publicRequestStartedAt,
        waitDeadlineAt: engineReproWaitDeadline(publicRequestStartedAt, env), officialQaJudge });
    }
    const audit = await auditPromise;
    if (answer.status !== "evidence_prepared") {
      await auditResult(answer, "completed", { profileId: profile.id, latencyMs: mainCompletedAt - publicRequestStartedAt });
    }
    return {
      answer,
      // Internal envelope only; HTTP adapters expose the answer explicitly.
      ...(audit?.entry?.id ? { auditId: audit.entry.id } : {}),
      ...(selection.fallbackFrom ? {fallbackFrom:selection.fallbackFrom} : {}),
      ...(prepareForContinuation && engineRepro.enabled && engineRepro.state.started
        ? { engineRepro: { enabled: true, requestStartedAt: publicRequestStartedAt } } : {}),
      latency: {
        profileId: profile.id,
        // durationMs covers the public service from entry through the answer (not the wait for
        // an engine reproduction); exactMatchMs remains a compatibility field while the shortcut
        // is disabled.
        durationMs: Math.max(0, mainCompletedAt - publicRequestStartedAt),
        exactMatchMs,
      },
    };
  } catch (error) {
    error.requestDiagnostics = { ...requestDiagnostics, failedAt: new Date().toISOString() };
    const audit = await auditPromise;
    await saveQueryAuditUpdate(audit?.entry?.id, queryAuditFailurePatch(error), env, updateAudit);
    throw error;
  }
}

function scopeDiagnostic(decision, durationMs) {
  return {
    scope: ['in_scope', 'out_of_scope'].includes(decision?.scope) ? decision.scope : 'uncertain',
    confidence: decision?.confidence || 'low',
    reasonCode: decision?.reasonCode || 'classifier_failed', model: decision?.model || null,
    returnedModel: decision?.returnedModel || null, provider: decision?.provider || null,
    thinkingMode: decision?.thinkingMode || null, durationMs: Math.max(0, durationMs),
    usage: decision?.usage || {}, estimatedCostCny: decision?.estimatedCostCny ?? null,
    failure: decision?.failure || null,
  };
}

const SCOPE_FAILURE_KINDS = new Set(["model_uncertain", "invalid_output", "site_budget_exhausted",
  "provider_balance_exhausted", "provider_rate_limited", "provider_auth_failed", "provider_unavailable",
  "provider_rejected", "timeout", "accounting_unavailable", "not_configured", "failed"]);
const SCOPE_PROVIDER_NAMES = Object.freeze({ openai: "OpenAI", bai: "b.ai", deepseek: "DeepSeek" });

// The public description of a missing scope decision. A model that answered
// "uncertain" is a question-wording matter; every other kind is a service-side
// failure that says nothing about the question.
export function publicScopeFailure(decision = {}) {
  const failure = decision?.failure && typeof decision.failure === "object" ? decision.failure : {};
  const token = (value) => (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/u.test(value) ? value : null);
  const kind = SCOPE_FAILURE_KINDS.has(failure.kind) ? failure.kind
    : decision?.reasonCode === "ambiguous" ? "model_uncertain" : "failed";
  const modelAnswered = kind === "model_uncertain";
  return {
    kind,
    reasonCode: token(decision?.reasonCode),
    provider: token(failure.provider) || (modelAnswered ? token(decision?.provider) : null),
    model: token(failure.model) || (modelAnswered ? token(decision?.model) : null),
    httpStatus: Number.isInteger(failure.httpStatus) ? failure.httpStatus : null,
    providerErrorCode: token(failure.providerErrorCode),
    providerErrorType: token(failure.providerErrorType),
  };
}

export function publicScopeFailureMessage(failure = {}) {
  if (failure.kind === "model_uncertain") {
    return "问题范围检查未通过：模型未能确认本题是否属于游戏王规则与裁定，本次请求已停止。请写明需要判断的规则或卡片互动后重试。";
  }
  const provider = SCOPE_PROVIDER_NAMES[failure.provider] || "模型服务";
  const upstreamCode = failure.providerErrorCode || failure.providerErrorType;
  const upstream = failure.httpStatus ? `（HTTP ${failure.httpStatus}${upstreamCode ? ` · ${upstreamCode}` : ""}）` : "";
  const causes = {
    invalid_output: `${provider} 返回了无法解析的结果`,
    site_budget_exhausted: "本站官方模型今日预算已用完",
    provider_balance_exhausted: `${provider} 账户余额不足${upstream}`,
    provider_rate_limited: `${provider} 暂时限流${upstream}`,
    provider_auth_failed: `${provider} 拒绝了服务端密钥${upstream}`,
    provider_unavailable: `${provider} 服务暂时故障${upstream}`,
    provider_rejected: `${provider} 拒绝了请求${upstream}`,
    timeout: `${provider} 未在时限内返回`,
    accounting_unavailable: "费用记账服务暂不可用",
    not_configured: "服务端未配置范围检查模型",
  };
  const cause = causes[failure.kind] || `范围检查模型调用失败${upstream}`;
  return `问题范围检查暂不可用：${cause}。这是服务端问题，与问题内容无关；本次请求已停止，未开始检索或生成裁定。`;
}

export function shouldClassifyPublicQuestion(env = process.env) {
  if (isServerOwnedPrivateEvaluationEnv(env)) return false;
  if (/^(?:1|true|yes|on)$/iu.test(String(env.RAG_DRY_RUN || "").trim())) return false;
  return true;
}

export function shouldApplyPublicOfftopicRiskControl(env = process.env) {
  if (!shouldClassifyPublicQuestion(env)) return false;
  return !/^(?:0|false|off|no)$/iu.test(
    String(env.PUBLIC_OFFTOPIC_RISK_CONTROL_ENABLED || "").trim(),
  );
}

// Shared with continuation and translation routes. A configured lock that
// cannot be read must not silently authorize further paid work.
export async function readPublicAnswerAvailability({ env = process.env, readRiskControl = readPublicOfftopicRiskControl } = {}) {
  if (!shouldApplyPublicOfftopicRiskControl(env) || !publicOfftopicRiskControlStorageStatus(env).enabled) return null;
  let status;
  try { status = await readRiskControl({ env }); } catch { /* handled below */ }
  if (status?.ok !== true) {
    throw publicAnswerRequestError("服务状态检查暂不可用，请稍后重试。", "public_request_rate_limit_unavailable", 503);
  }
  return status;
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
  const statusCode = [400, 409, 410, 413, 429, 502, 503, 504].includes(inferredStatus) ? inferredStatus : 500;
  const publicMessage = error?.code === "rag_data_unavailable"
    && error?.expose === true
    && String(error?.publicMessage || "").trim()
    ? String(error.publicMessage).trim()
    : "";
  const officialQaBodyDetails = error?.code === "OFFICIAL_QA_BODY_UNAVAILABLE"
    ? {
        qaId: String(error?.details?.qaId || ""),
        sourceRevision: String(error?.details?.sourceRevision || ""),
        questionHash: String(error?.details?.questionHash || ""),
        failureReason: String(error?.details?.failureReason || "official_qa_body_unavailable"),
      }
    : null;
  return {
    statusCode,
    payload: {
      error: publicMessage || (error instanceof Error ? error.message : String(error)),
      code: error?.code || "answer_failed",
      ...(statusCode === 429 ? { retryAfterSeconds: Math.max(1, Math.ceil(Number(error?.retryAfterSeconds) || 60)) } : {}),
      ...(error?.code === "public_query_scope_unavailable" && error?.scopeFailure ? { scopeFailure: error.scopeFailure } : {}),
      ...(officialQaBodyDetails ? { details: officialQaBodyDetails } : {}),
      ...((error?.cloudCosts || error?.requestDiagnostics || error?.boundedRetrieval || error?.decisionsFailure) ? {debug:{
        ...(error.cloudCosts ? {cloudCosts:error.cloudCosts} : {}),
        ...(error.requestDiagnostics ? {requestDiagnostics:error.requestDiagnostics} : {}),
        ...(error.boundedRetrieval ? {boundedRetrieval:error.boundedRetrieval} : {}),
        ...(error.decisionsFailure ? {decisionsFailure:error.decisionsFailure} : {}),
      }} : {}),
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
