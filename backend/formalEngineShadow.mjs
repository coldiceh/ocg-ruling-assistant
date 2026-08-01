import { createHash } from "node:crypto";

import { requestFormalScenarioAnalysis } from "./formalEngineClient.mjs";
import { planFormalScenario } from "./formalScenarioPlanner.mjs";

const DISABLED_VALUES = /^(?:0|false|off|disabled|no)$/iu;
const VALIDATED_CLIENT_ANALYSES = new WeakSet();

export function formalShadowEnabled(env = globalThis.process?.env || {}) {
  const mode = String(env.RAG_FORMAL_ENGINE_MODE ?? "off").trim().toLowerCase();
  return mode === "formal-shadow" || mode === "shadow";
}

export async function runFormalEngineShadow({
  userQuery,
  resolvedCards = [],
  scenarioDraft,
  scenarioDraftInvoker,
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  proofVerifier,
  expectedVersions,
} = {}) {
  if (!formalShadowEnabled(env)) return disabledShadow();

  const draftResult = await resolveScenarioDraft({
    scenarioDraft,
    scenarioDraftInvoker,
    userQuery,
    resolvedCards,
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

  const analysis = await requestFormalScenarioAnalysis({
    formalScenario: plan.scenario,
    env,
    fetchImpl,
    proofVerifier,
    expectedVersions,
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
    evidence: formalResultToEvidence({ scenario: plan.scenario, analysis }),
  };
}

function formalResultToEvidence({ scenario, analysis } = {}) {
  if (!analysis || typeof analysis !== "object" || !VALIDATED_CLIENT_ANALYSES.has(analysis)) return [];
  const result = analysis?.formalResult;
  if (!scenario || !result || !Array.isArray(result.queryResults)) return [];
  const scenarioQueries = Array.isArray(scenario.queries) ? scenario.queries : [];
  const resultById = new Map(result.queryResults.map((queryResult) => [queryResult.queryId, queryResult]));
  const versions = pickVersions(result);
  const assumptions = publicAssumptions(scenario.assumptions);
  const unconditionalAuthority = scenario.mode === "STRICT" && assumptions.length === 0;
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
      branches: result.branches || [],
      structuredTrace: result.structuredTrace || [],
    };
    return {
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
      branches: summary.branches,
      structuredTrace: summary.structuredTrace,
    };
  });
}

export function applyFormalAnswerGate(answer, formalEvidence = [], {
  preserveAuthoritativeAnswer = false,
} = {}) {
  const source = Array.isArray(formalEvidence) ? formalEvidence : [];
  if (!source.length) return answer;
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

async function resolveScenarioDraft({ scenarioDraft, scenarioDraftInvoker, userQuery, resolvedCards }) {
  if (scenarioDraft && typeof scenarioDraft === "object") return { draft: scenarioDraft, error: null };
  if (typeof scenarioDraftInvoker !== "function") return { draft: null, error: null };
  try {
    const value = await scenarioDraftInvoker({
      task: "formal_scenario_draft",
      userQuery,
      resolvedCards,
      prohibitedDerivedFields: [
        "banishedByCardEffect",
        "summonLegal",
        "triggerActivates",
        "finalChainNumber",
        "canActivate",
        "operationSuccessful",
      ],
    });
    const draft = value?.scenarioDraft ?? value?.draft ?? value;
    if (!draft || typeof draft !== "object") {
      return { draft: null, error: { code: "FORMAL_SCENARIO_DRAFT_INVALID", message: "scenario draft invoker returned no JSON object" } };
    }
    return { draft, error: null };
  } catch (error) {
    return {
      draft: null,
      error: {
        code: "FORMAL_SCENARIO_DRAFT_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
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

function unknownShadow({ stage, code, message, details = {}, plan = null }) {
  return {
    mode: "formal-shadow",
    enabled: true,
    stage,
    requested: false,
    status: "unknown",
    plan,
    analysis: null,
    evidence: [],
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
