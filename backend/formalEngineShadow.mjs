import { createHash } from "node:crypto";

import { getFormalEngineCapabilities, requestFormalScenarioAnalysis } from "./formalEngineClient.mjs";
import {
  canonicalSha256,
  FORMAL_SCENARIO_PROHIBITED_DERIVED_FIELDS,
  invokeBoundedFormalVerifier,
} from "./formalEngineSchemas.mjs";
import { planFormalScenario } from "./formalScenarioPlanner.mjs";

const DISABLED_VALUES = /^(?:0|false|off|disabled|no)$/iu;
const VALIDATED_CLIENT_ANALYSES = new WeakSet();
const VALIDATED_FORMAL_EVIDENCE = new WeakSet();

export function formalShadowEnabled(env = globalThis.process?.env || {}) {
  const mode = String(env.RAG_FORMAL_ENGINE_MODE ?? "off").trim().toLowerCase();
  return mode === "formal-shadow" || mode === "shadow";
}

export async function runFormalEngineShadow({
  userQuery,
  resolvedCards = [],
  cardResolution = {},
  scenarioDraft,
  scenarioDraftInvoker,
  scenarioDraftVerifier,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  proofVerifier,
  expectedVersions,
  scenarioDraftTimeoutMs,
  scenarioDraftVerifierTimeoutMs,
  expectedScenarioDraftVerifierId,
  expectedScenarioDraftVerifierVersion,
  proofVerifierTimeoutMs,
  dryRun = false,
  signal,
} = {}) {
  if (!formalShadowEnabled(env)) return disabledShadow();
  if (dryRun === true || isEnabled(env.RAG_DRY_RUN)) {
    return unknownShadow({
      stage: "draft",
      code: "FORMAL_SCENARIO_DRAFT_DRY_RUN",
      message: "formal scenario extraction is disabled during dry-run",
    });
  }
  if (typeof scenarioDraftVerifier !== "function") {
    const draftVerification = {
      valid: false,
      code: "FORMAL_SCENARIO_DRAFT_UNVERIFIED",
      message: "no independent scenario-draft completeness verifier is configured",
      details: {},
    };
    return unknownShadow({
      stage: "draft-verification",
      code: draftVerification.code,
      message: draftVerification.message,
      draftVerification,
    });
  }
  if (typeof proofVerifier !== "function") {
    return unknownShadow({
      stage: "proof-verification",
      code: "FORMAL_PROOF_VERIFIER_UNAVAILABLE",
      message: "no independent public proof verifier is configured",
    });
  }
  const expectedDraftVerifierIdentity = resolveExpectedDraftVerifierIdentity({
    verifierId: expectedScenarioDraftVerifierId,
    verifierVersion: expectedScenarioDraftVerifierVersion,
    env,
  });
  if (!expectedDraftVerifierIdentity.configured) {
    const draftVerification = {
      valid: false,
      code: "FORMAL_SCENARIO_DRAFT_VERIFIER_IDENTITY_UNCONFIGURED",
      message: "the expected scenario-draft verifier identity and version must be configured",
      details: {},
      verifierId: null,
      verifierVersion: null,
      expectedVerifierId: expectedDraftVerifierIdentity.verifierId,
      expectedVerifierVersion: expectedDraftVerifierIdentity.verifierVersion,
    };
    return unknownShadow({
      stage: "draft-verification",
      code: draftVerification.code,
      message: draftVerification.message,
      draftVerification,
    });
  }

  const negotiation = await getFormalEngineCapabilities({ env, fetchImpl, expectedVersions, signal });
  if (negotiation.status !== "ready") {
    return unknownShadow({
      stage: "capabilities",
      code: negotiation.error?.code || "ENGINE_FORMAL_API_UNAVAILABLE",
      message: negotiation.error?.message || "formal capability endpoint is unavailable",
      details: negotiation.error?.details || {},
    });
  }

  const draftResult = await resolveScenarioDraft({
    scenarioDraft,
    scenarioDraftInvoker,
    userQuery,
    resolvedCards,
    cardResolution,
    signal,
    timeoutMs: resolveScenarioDraftTimeoutMs(
      scenarioDraftTimeoutMs,
      env.RAG_FORMAL_SCENARIO_DRAFT_TIMEOUT_MS,
    ),
  });
  if (!draftResult.draft) {
    return unknownShadow({
      stage: "draft",
      code: draftResult.error?.code || "FORMAL_SCENARIO_DRAFT_UNAVAILABLE",
      message: draftResult.error?.message || "no formal scenario draft was produced",
      details: draftResult.error?.details || {},
    });
  }

  const plan = planFormalScenario({
    scenarioDraft: draftResult.draft,
    userQuery,
    resolvedCards,
  });
  if (plan.kind !== "READY") {
    const reason = plan.unknownReasons?.[0] || {};
    return unknownShadow({
      stage: "planning",
      code: reason.code || "FORMAL_SCENARIO_SCHEMA_INVALID",
      message: reason.message || "formal scenario planning remained unknown",
      details: reason.details || {},
      plan,
    });
  }


  const draftVerification = await verifyScenarioDraftCompleteness({
    verifier: scenarioDraftVerifier,
    draft: draftResult.draft,
    scenario: plan.scenario,
    userQuery,
    resolvedCards,
    draftProvenance: draftResult.draftProvenance,
    expectedVerifierIdentity: expectedDraftVerifierIdentity,
    signal,
    timeoutMs: resolveVerifierTimeoutMs(
      scenarioDraftVerifierTimeoutMs,
      env.RAG_FORMAL_SCENARIO_DRAFT_VERIFIER_TIMEOUT_MS,
    ),
  });
  if (!draftVerification.valid) {
    return unknownShadow({
      stage: "draft-verification",
      code: draftVerification.code,
      message: draftVerification.message,
      details: draftVerification.details,
      plan,
      draftVerification,
    });
  }

  const analysis = await requestFormalScenarioAnalysis({
    formalScenario: plan.scenario,
    negotiatedCapabilities: negotiation.capabilities,
    env,
    fetchImpl,
    proofVerifier,
    proofVerifierTimeoutMs,
    expectedVersions,
    signal,
  });
  if (analysis && typeof analysis === "object") VALIDATED_CLIENT_ANALYSES.add(analysis);
  return {
    mode: "formal-shadow",
    enabled: true,
    stage: "analysis",
    requested: analysis.requested,
    status: analysis.status,
    plan,
    analysis,
    draftVerification,
    evidence: formalResultToEvidence({ scenario: plan.scenario, analysis, draftVerification }),
  };
}

function formalResultToEvidence({ scenario, analysis, draftVerification } = {}) {
  if (draftVerification?.valid !== true) return [];
  if (!analysis || typeof analysis !== "object" || !VALIDATED_CLIENT_ANALYSES.has(analysis)) return [];
  const result = analysis?.formalResult;
  if (!scenario || !result || !Array.isArray(result.queryResults)) return [];
  const scenarioQueries = Array.isArray(scenario.queries) ? scenario.queries : [];
  const resultById = new Map(result.queryResults.map((queryResult) => [queryResult.queryId, queryResult]));
  const versions = pickVersions(result);
  const assumptions = publicAssumptions(scenario.assumptions);
  const unconditionalAuthority = scenario.mode === "STRICT" && assumptions.length === 0;
  const draftVerifier = publicDraftVerifierIdentity(draftVerification);
  return scenarioQueries.map((query) => {
    const queryResult = resultById.get(query.queryId) || missingQueryResult(query.queryId);
    const claimText = sourceSpanText(query.sourceSpan) || queryResult.queryId;
    const definitive = queryResult.verdict === "TRUE" || queryResult.verdict === "FALSE";
    const certificateVerified = definitive
      && queryResult.certificateVerification?.valid === true
      && Boolean(queryResult.proofCertificate?.certificateId);
    const trusted = unconditionalAuthority
      && analysis.status === "completed"
      && certificateVerified;
    const conditional = !unconditionalAuthority
      && analysis.status === "completed"
      && certificateVerified;
    const proof = certificateVerified ? {
      certificateId: queryResult.proofCertificate?.certificateId || null,
      certificateSha256: queryResult.certificateVerification?.certificateSha256 || null,
      verifierVersion: queryResult.certificateVerification?.verifierVersion || null,
      verified: queryResult.certificateVerification?.valid === true,
    } : null;
    const summary = {
      queryId: queryResult.queryId,
      predicate: query.predicate || "",
      claimText,
      verdict: queryResult.verdict,
      trusted,
      conditional,
      scenarioMode: scenario.mode || null,
      assumptions,
      unknownReasons: queryResult.unknownReasons || [],
      witness: trusted && queryResult.verdict === "TRUE" ? queryResult.witness : null,
      counterexample: trusted && queryResult.verdict === "FALSE" ? queryResult.counterexample : null,
      versions,
      proof,
      draftVerification: draftVerifier,
      branches: result.branches || [],
      structuredTrace: result.structuredTrace || [],
    };
    const evidence = {
      id: formalEvidenceId(scenario.scenarioId, queryResult.queryId),
      type: "formal_engine_proof",
      title: `Formal ${queryResult.queryId}: ${queryResult.verdict}`,
      text: JSON.stringify(summary),
      official: false,
      isDirect: false,
      source: "formal_engine",
      sourceType: "formal_engine_proof",
      scenarioId: scenario.scenarioId,
      queryId: queryResult.queryId,
      predicate: query.predicate || "",
      claimText,
      verdict: queryResult.verdict,
      trusted,
      conditional,
      scenarioMode: scenario.mode || null,
      assumptions,
      unknownReasons: queryResult.unknownReasons || [],
      witness: summary.witness,
      counterexample: summary.counterexample,
      versions,
      proof,
      draftVerification: draftVerifier,
      branches: summary.branches,
      structuredTrace: summary.structuredTrace,
    };
    const sealedEvidence = deepFreeze(structuredClone(evidence));
    VALIDATED_FORMAL_EVIDENCE.add(sealedEvidence);
    return sealedEvidence;
  });
}

export function applyFormalAnswerGate(answer, formalEvidence = [], {
  preserveAuthoritativeAnswer = false,
} = {}) {
  const supplied = Array.isArray(formalEvidence) ? formalEvidence : [];
  const source = supplied.filter((item) => item && VALIDATED_FORMAL_EVIDENCE.has(item));
  if (!source.length) {
    if (!supplied.length) return answer;
    return {
      ...answer,
      riskFlags: [...new Set([...(answer?.riskFlags || []), "formal_engine_evidence_rejected_unverified_origin"])],
    };
  }
  const trusted = source.filter((item) => item?.trusted === true && ["TRUE", "FALSE"].includes(item.verdict));
  const unknown = source.filter((item) => item?.verdict === "UNKNOWN");
  const conditional = source.filter((item) => item?.conditional === true && ["TRUE", "FALSE"].includes(item.verdict));
  const unverified = source.filter((item) => !trusted.includes(item) && !unknown.includes(item) && !conditional.includes(item));
  const riskFlags = new Set(answer?.riskFlags || []);
  for (const item of unknown) riskFlags.add(`formal_engine_unknown:${item.queryId}`);
  for (const item of conditional) riskFlags.add(`formal_engine_conditional:${item.queryId}`);
  for (const item of unverified) riskFlags.add(`formal_engine_unverified:${item.queryId}`);
  const modelPolarity = definiteAnswerPolarity([
    answer?.shortAnswer,
    ...(Array.isArray(answer?.reasoning) ? answer.reasoning : []),
  ].filter(Boolean).join("\n"));
  if (!preserveAuthoritativeAnswer && unknown.length && modelPolarity !== "neutral") {
    riskFlags.add(`formal_engine_unknown_blocked_model_${modelPolarity}`);
  }

  const unresolved = unknown.length > 0 || conditional.length > 0 || unverified.length > 0;
  const formalLines = source.map(renderFormalClaim);
  const formalReasoning = trusted.map((item) => {
    const proofId = item.proof?.certificateId ? `，证明证书 ${item.proof.certificateId}` : "";
    return `形式规则内核对“${item.claimText}”给出经校验的 ${item.verdict}${proofId}；模型无权翻转该结论。`;
  });
  for (const item of unknown) {
    formalReasoning.push(`形式规则内核对“${item.claimText}”返回 UNKNOWN，未签发确定性证明；UNKNOWN 对“可以”和“不可以”均不构成依据。`);
  }
  for (const item of conditional) {
    formalReasoning.push(`形式规则内核对“${item.claimText}”的 ${item.verdict} 仅成立于 ${item.scenarioMode || "非严格"} 场景及其显式假设下，不能作为无条件权威结论。`);
  }
  for (const item of unverified) {
    formalReasoning.push(`形式规则内核对“${item.claimText}”没有产生可作为权威使用的 STRICT 验证结果。`);
  }
  const gated = {
    ...answer,
    usedEvidence: mergeEvidenceRefs(answer?.usedEvidence, trusted),
    riskFlags: [...riskFlags],
    formalQueryResults: source.map(publicFormalClaim),
  };
  if (preserveAuthoritativeAnswer) {
    return {
      ...gated,
      reasoning: [
        ...(Array.isArray(answer?.reasoning) ? answer.reasoning : []),
        ...formalReasoning,
        ...traceReasoning(trusted),
      ].slice(0, 12),
    };
  }
  return {
    ...gated,
    ...(unresolved ? { answerLevel: "low_confidence_analysis", confidenceSelfEstimate: "low" } : {}),
    shortAnswer: formalLines.join(" "),
    reasoning: [...formalReasoning, ...traceReasoning(trusted)].slice(0, 6),
  };
}

function renderFormalClaim(item) {
  if (item?.trusted === true && ["TRUE", "FALSE"].includes(item.verdict)) return renderTrustedClaim(item);
  if (item?.verdict === "UNKNOWN") {
    return `对于“${item.claimText}”：未签发确定性证明/UNKNOWN，不能据此断言“可以”或“不可以”。`;
  }
  if (item?.conditional === true) {
    return `对于“${item.claimText}”：形式内核仅在 ${item.scenarioMode || "非严格"} 场景及其显式假设下得到 ${item.verdict}；这不是无条件权威结论。`;
  }
  return `对于“${item?.claimText || item?.queryId || "该查询"}”：未签发可作为权威使用的 STRICT 确定性证明。`;
}

function renderTrustedClaim(item) {
  const verdictText = item.verdict === "TRUE" ? "可以" : "不可以";
  return `对于“${item.claimText}”：${verdictText}（形式证明已通过校验）。`;
}

function traceReasoning(items) {
  const trace = items.find((item) => Array.isArray(item.structuredTrace) && item.structuredTrace.length)?.structuredTrace || [];
  if (!trace.length) return [];
  const rendered = trace.slice(0, 12).map((step) => {
    if (typeof step === "string") return step;
    if (!step || typeof step !== "object") return String(step);
    return String(step.label || step.event || step.type || step.operation || step.nodeId || "状态迁移");
  });
  return rendered.length ? [`形式证明轨迹：${rendered.join(" → ")}`] : [];
}

function mergeEvidenceRefs(existing = [], trusted = []) {
  const merged = [...(Array.isArray(existing) ? existing : [])];
  const seen = new Set(merged.map((item) => item?.id).filter(Boolean));
  for (const item of trusted) {
    if (seen.has(item.id)) continue;
    merged.push({ id: item.id, type: item.type, title: item.title });
    seen.add(item.id);
  }
  return merged;
}

function publicFormalClaim(item) {
  return {
    queryId: item.queryId,
    predicate: item.predicate,
    claimText: item.claimText,
    verdict: item.verdict,
    trusted: item.trusted === true,
    conditional: item.conditional === true,
    scenarioMode: item.scenarioMode || null,
    assumptions: item.assumptions || [],
    unknownReasons: publicUnknownReasons(item.unknownReasons),
    versions: item.versions || {},
    proof: item.proof || null,
  };
}

function publicUnknownReasons(reasons) {
  return (Array.isArray(reasons) ? reasons : []).map((reason) => ({
    code: String(reason?.code || reason || "FORMAL_UNKNOWN"),
  }));
}

async function resolveScenarioDraft({
  scenarioDraft,
  scenarioDraftInvoker,
  userQuery,
  resolvedCards,
  cardResolution,
  signal,
  timeoutMs,
}) {
  if (scenarioDraft && typeof scenarioDraft === "object") {
    return { draft: scenarioDraft, error: null, draftProvenance: "EXPLICIT_INTERNAL_UNVERIFIED" };
  }
  if (typeof scenarioDraftInvoker !== "function") return { draft: null, error: null };
  try {
    const value = await invokeBoundedFormalVerifier(
      (payload, options) => scenarioDraftInvoker({
        ...payload,
        signal: options.signal,
      }),
      {
        task: "formal_scenario_draft",
        userQuery,
        resolvedCards,
        cardResolution,
        prohibitedDerivedFields: FORMAL_SCENARIO_PROHIBITED_DERIVED_FIELDS,
      },
      {
        signal,
        timeoutMs,
        timeoutCode: "FORMAL_SCENARIO_DRAFT_TIMEOUT",
        abortCode: "FORMAL_SCENARIO_DRAFT_ABORTED",
        label: "formal scenario-draft invoker",
      },
    );
    const draft = value?.scenarioDraft ?? value?.draft ?? value;
    if (!draft || typeof draft !== "object") {
      return { draft: null, error: { code: "FORMAL_SCENARIO_DRAFT_INVALID", message: "scenario draft invoker returned no JSON object" } };
    }
    return {
      draft,
      error: null,
      draftProvenance: String(value?.draftProvenance || "INVOKER_UNVERIFIED"),
    };
  } catch (error) {
    return {
      draft: null,
      error: {
        code: typeof error?.code === "string" && error.code.startsWith("FORMAL_")
          ? error.code
          : "FORMAL_SCENARIO_DRAFT_FAILED",
        message: error instanceof Error ? error.message : String(error),
        details: error?.details && typeof error.details === "object" ? error.details : {},
      },
    };
  }
}

async function verifyScenarioDraftCompleteness({
  verifier,
  draft,
  scenario,
  userQuery,
  resolvedCards,
  draftProvenance,
  expectedVerifierIdentity,
  signal,
  timeoutMs,
}) {
  const bindings = {
    draftSha256: canonicalSha256(draft),
    scenarioSha256: canonicalSha256(scenario),
    questionSha256: canonicalSha256({ text: String(userQuery || "") }),
  };
  if (typeof verifier !== "function") {
    return {
      valid: false,
      code: "FORMAL_SCENARIO_DRAFT_UNVERIFIED",
      message: "no independent scenario-draft completeness verifier is configured",
      details: { draftProvenance: String(draftProvenance || "UNVERIFIED") },
      ...bindings,
    };
  }
  let result;
  try {
    const verifierDraft = deepFreeze(structuredClone(draft));
    const verifierScenario = deepFreeze(structuredClone(scenario));
    const verifierResolvedCards = deepFreeze(structuredClone(resolvedCards));
    const verifierResult = await invokeBoundedFormalVerifier(
      verifier,
      {
        task: "verify_formal_scenario_draft_completeness",
        draft: verifierDraft,
        scenario: verifierScenario,
        userQuery,
        resolvedCards: verifierResolvedCards,
        draftProvenance,
        ...bindings,
      },
      {
        signal,
        timeoutMs,
        timeoutCode: "FORMAL_SCENARIO_DRAFT_VERIFIER_TIMEOUT",
        abortCode: "FORMAL_SCENARIO_DRAFT_VERIFIER_ABORTED",
        label: "scenario-draft completeness verifier",
      },
    );
    result = deepFreeze(structuredClone(verifierResult));
  } catch (error) {
    return {
      valid: false,
      code: error?.code === "FORMAL_SCENARIO_DRAFT_VERIFIER_TIMEOUT" || error?.code === "FORMAL_SCENARIO_DRAFT_VERIFIER_ABORTED"
        ? error.code
        : "FORMAL_SCENARIO_DRAFT_VERIFIER_FAILED",
      message: error instanceof Error ? error.message : String(error),
      details: {},
      verifierId: null,
      verifierVersion: null,
      expectedVerifierId: expectedVerifierIdentity.verifierId,
      expectedVerifierVersion: expectedVerifierIdentity.verifierVersion,
      ...bindings,
    };
  }
  const inputsUnchanged = canonicalSha256(draft) === bindings.draftSha256
    && canonicalSha256(scenario) === bindings.scenarioSha256
    && canonicalSha256({ text: String(userQuery || "") }) === bindings.questionSha256;
  const bindingMatches = inputsUnchanged
    && result?.draftSha256 === bindings.draftSha256
    && result?.scenarioSha256 === bindings.scenarioSha256
    && result?.questionSha256 === bindings.questionSha256;
  const verifierId = String(result?.verifierId || "").trim();
  const verifierVersion = String(result?.verifierVersion || "").trim();
  if (result?.valid !== true || !bindingMatches || !verifierId || !verifierVersion) {
    return {
      valid: false,
      code: result?.valid === true ? "FORMAL_SCENARIO_DRAFT_VERIFICATION_MISMATCH" : "FORMAL_SCENARIO_DRAFT_UNVERIFIED",
      message: result?.valid === true
        ? "scenario-draft verification did not bind the exact draft, scenario, and question"
        : "scenario-draft completeness was not verified",
      details: {},
      verifierId: verifierId || null,
      verifierVersion: verifierVersion || null,
      expectedVerifierId: expectedVerifierIdentity.verifierId,
      expectedVerifierVersion: expectedVerifierIdentity.verifierVersion,
      ...bindings,
    };
  }
  if (verifierId !== expectedVerifierIdentity.verifierId
      || verifierVersion !== expectedVerifierIdentity.verifierVersion) {
    return {
      valid: false,
      code: "FORMAL_SCENARIO_DRAFT_VERIFIER_IDENTITY_MISMATCH",
      message: "scenario-draft verification was produced by an unexpected verifier identity or version",
      details: {
        expectedVerifierId: expectedVerifierIdentity.verifierId,
        expectedVerifierVersion: expectedVerifierIdentity.verifierVersion,
        actualVerifierId: verifierId,
        actualVerifierVersion: verifierVersion,
      },
      verifierId,
      verifierVersion,
      expectedVerifierId: expectedVerifierIdentity.verifierId,
      expectedVerifierVersion: expectedVerifierIdentity.verifierVersion,
      ...bindings,
    };
  }
  return {
    valid: true,
    code: null,
    message: "scenario-draft completeness verified",
    details: {},
    verifierId,
    verifierVersion,
    expectedVerifierId: expectedVerifierIdentity.verifierId,
    expectedVerifierVersion: expectedVerifierIdentity.verifierVersion,
    ...bindings,
  };
}

function resolveExpectedDraftVerifierIdentity({ verifierId, verifierVersion, env }) {
  const expectedId = String(
    verifierId
      ?? env?.RAG_FORMAL_SCENARIO_DRAFT_VERIFIER_ID
      ?? "",
  ).trim();
  const expectedVersion = String(
    verifierVersion
      ?? env?.RAG_FORMAL_SCENARIO_DRAFT_VERIFIER_VERSION
      ?? "",
  ).trim();
  return {
    configured: Boolean(expectedId && expectedVersion),
    verifierId: expectedId || null,
    verifierVersion: expectedVersion || null,
  };
}

function publicDraftVerifierIdentity(value) {
  return {
    verifierId: value?.verifierId || null,
    verifierVersion: value?.verifierVersion || null,
    expectedVerifierId: value?.expectedVerifierId || null,
    expectedVerifierVersion: value?.expectedVerifierVersion || null,
  };
}

function resolveVerifierTimeoutMs(explicitValue, environmentValue) {
  const requested = Number(explicitValue ?? environmentValue ?? 5_000);
  return Number.isInteger(requested) && requested > 0 ? requested : 5_000;
}

function resolveScenarioDraftTimeoutMs(explicitValue, environmentValue) {
  const requested = Number(explicitValue ?? environmentValue ?? 15_000);
  return Number.isInteger(requested) && requested > 0 ? requested : 15_000;
}

function disabledShadow() {
  return {
    mode: "off",
    enabled: false,
    stage: "disabled",
    requested: false,
    status: "disabled",
    plan: null,
    analysis: null,
    evidence: [],
  };
}

function unknownShadow({ stage, code, message, details = {}, plan = null, draftVerification = null }) {
  return {
    mode: "formal-shadow",
    enabled: true,
    stage,
    requested: false,
    status: "unknown",
    plan,
    analysis: null,
    evidence: [],
    draftVerification,
    error: { code, message, details },
  };
}

function formalEvidenceId(scenarioId, queryId) {
  const digest = createHash("sha256").update(`${scenarioId}\u0000${queryId}`).digest("hex").slice(0, 20);
  return `formal-engine-proof:${digest}`;
}

function pickVersions(value) {
  return Object.fromEntries([
    "engineVersion",
    "IRVersion",
    "rulesetVersion",
    "schemaVersion",
    "proofVerifierVersion",
  ].map((key) => [key, value?.[key] ?? null]));
}

function sourceSpanText(span) {
  return typeof span?.text === "string" ? span.text : "";
}

function missingQueryResult(queryId) {
  return {
    queryId,
    verdict: "UNKNOWN",
    witness: null,
    counterexample: null,
    proofCertificate: null,
    certificateVerification: null,
    unknownReasons: [{
      code: "FORMAL_QUERY_RESULT_MISSING",
      message: "formal result omitted a scenario query",
    }],
  };
}

function publicAssumptions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    assumptionId: item?.assumptionId || null,
    type: item?.type || null,
    assumesFactId: item?.assumesFactId || null,
    sourceSpan: item?.sourceSpan || null,
  }));
}

function definiteAnswerPolarity(value) {
  const text = String(value || "");
  const negative = /(?:不能|不可以|无法)(?:发动|召唤|进行|适用|加入|处理|特殊召唤)?/u.test(text);
  const positive = /(?:可以|能够|能)(?:发动|召唤|进行|适用|加入|处理|特殊召唤)?/u.test(text);
  if (positive && negative) return "mixed";
  if (positive) return "positive";
  if (negative) return "negative";
  return "neutral";
}

function isEnabled(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && !DISABLED_VALUES.test(text);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
