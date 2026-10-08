import { isIP } from "node:net";
import { safeQueryAuditDiagnostics, safeQueryAuditStreamMetrics, safeQueryAuditRetrievalTimings, updateQueryAudit } from "./queryAuditStore.mjs";
import { classifyPublicRequestChannel } from "./publicAnswerPresentation.mjs";

// Only the HTTP adapter creates this private context. Never accept it from a
// question payload or place it in model input, public diagnostics or evidence.
export function readQueryAuditRequestContext(request, env = process.env,
  requestChannel = classifyPublicRequestChannel(request?.body)) {
  const header = (name) => typeof request?.headers?.get === "function"
    ? request.headers.get(name) : request?.headers?.[name];
  const platform = String(env.VERCEL || "") === "1";
  const raw = platform
    ? header("x-vercel-forwarded-for") || header("x-forwarded-for")
    : request?.socket?.remoteAddress;
  const ip = typeof raw === "string" ? raw.trim() : "";
  return {
    ...(isIP(ip)
      ? { ip, ipSource: platform ? "vercel" : "socket" }
      : { ip: null, ipSource: "unavailable" }),
    requestChannel,
  };
}

export function queryAuditAnswerPatch(answer, { status = "completed", latencyMs, profileId } = {}) {
  const model = answer?.generation?.model;
  const effort = answer?.generation?.reasoningEffort
    || (answer?.generation?.thinkingMode === "disabled" ? "none" : null);
  const errorCode = status === "completed" ? queryAuditAnswerFailureCode(answer) : null;
  return {
    status: errorCode ? "failed" : status,
    completedAt: new Date().toISOString(),
    answer: typeof answer?.shortAnswer === "string" ? answer.shortAnswer : "",
    ...(errorCode ? { errorCode } : {}),
    ...(typeof model === "string" && model ? { model } : {}),
    ...(typeof effort === "string" && effort ? { reasoningEffort: effort } : {}),
    ...(Number.isFinite(latencyMs) ? { latencyMs: Math.max(0, latencyMs) } : {}),
    ...(profileId ? { profileId } : {}),
    ...auditDiagnostics(answer?.debug?.requestDiagnostics, answer?.answerLevel === "out_of_scope"
      ? "scope" : errorCode ? "generation" : undefined),
    ...safeQueryAuditStreamMetrics(lastAttemptStreamMetrics(answer?.debug?.generationAttempts)),
    ...safeQueryAuditRetrievalTimings(answer?.debug?.retrievalTimingsMs),
  };
}

function queryAuditAnswerFailureCode(answer) {
  // Reflect the final parser's existing transport/output result in the audit.
  // Do not independently reinterpret the model response or change its answer.
  const riskFlags = Array.isArray(answer?.riskFlags) ? answer.riskFlags : [];
  for (const flag of [
    "model_plain_text_incomplete",
    "model_plain_text_empty",
    "model_output_not_displayable",
    "public_final_output_not_displayable",
  ]) {
    if (riskFlags.includes(flag)) return flag;
  }

  return null;
}

export function queryAuditFailurePatch(error) {
  // Store a bounded machine code only; supplier messages may contain request
  // data or credentials and do not belong in the history response.
  const code = typeof error?.code === "string" && /^[a-zA-Z0-9_.:-]{1,80}$/u.test(error.code)
    ? error.code : "answer_failed";
  const explicitStage = safeQueryAuditDiagnostics({ errorStage: error?.errorStage || error?.stage }).errorStage;
  return {
    status: "failed", completedAt: new Date().toISOString(), errorCode: code,
    ...auditDiagnostics(error?.requestDiagnostics, explicitStage || auditErrorStage(code)),
    ...safeQueryAuditStreamMetrics(error?.streamMetrics || error?.providerFailure?.streamMetrics),
    ...safeQueryAuditRetrievalTimings(error?.boundedRetrieval?.timingsMs),
  };
}

function lastAttemptStreamMetrics(attempts) {
  return Array.isArray(attempts) ? attempts.at(-1)?.streamMetrics : null;
}

function auditDiagnostics(diagnostics, errorStage) {
  const scope = diagnostics?.scope;
  return safeQueryAuditDiagnostics({ scopeResult: scope?.scope, scopeReason: scope?.reasonCode, errorStage });
}

function auditErrorStage(code) {
  if (["public_query_scope_unavailable", "answer_preparation_scope_unverified"].includes(code)) return "scope";
  if (["public_request_rate_limited", "public_request_rate_limit_unavailable", "public_service_paused"].includes(code)) return "request_admission";
  if (/^(?:decisions_|evidence_|rule_query_)/u.test(code)) return "evidence_selection";
  if (code.startsWith("answer_preparation_")) return "preparation";
  if (/^(?:model_provider_|public_final_)/u.test(code)) return "generation";
  return undefined;
}

export async function saveQueryAuditUpdate(id, patch, env, updateAudit = updateQueryAudit) {
  if (!id) return;
  try { await updateAudit({ id, patch, env }); } catch { /* Observational only. */ }
}
