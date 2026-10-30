// Per-stage view of one job's ledger calls and stage timings. A ledger call is
// attributed by its operation and, for evidence generation, by the request
// hash it shares with the bounded provider's own call row (plan, selection,
// rule ToC). Mechanical bookkeeping only.

export const COST_STAGES = Object.freeze(["card", "planning", "embedding", "selection", "toc", "final", "other"]);
export const COST_STAGE_LABELS = Object.freeze({ card: "卡名", planning: "规划", embedding: "向量", selection: "选证",
  toc: "ToC", final: "作答", other: "其他" });
const BOUNDED_STAGE = Object.freeze({ plan: "planning", selection: "selection", rule_toc: "toc" });

export function boundedCallsOf({ continuation, error } = {}) {
  return continuation?.ruleQueryModel?.bounded?.calls || error?.boundedRetrieval?.calls || [];
}

export function costStageOf(call, stageByRequest) {
  if (call.stage === "final_ruling") return "final";
  if (call.operation === "embed_content") return "embedding";
  if (call.operation === "generate_content") return stageByRequest.get(call.requestSha256) || "other";
  // GPT-6 Luna card-name extraction and identity selection (official channel).
  if (call.operation === "responses" && call.provider === "openai") return "card";
  return "other";
}

export function stageCostBreakdown({ calls = [], boundedCalls = [] } = {}) {
  const stageByRequest = new Map(boundedCalls.filter((row) => row?.requestSha256 && BOUNDED_STAGE[row.stage])
    .map((row) => [row.requestSha256, BOUNDED_STAGE[row.stage]]));
  const byStage = Object.fromEntries(COST_STAGES.map((stage) => [stage, { usd: 0, calls: 0, unsettled: 0,
    inputTokens: 0, outputTokens: 0, requestBodyBytes: 0 }]));
  for (const call of calls) {
    if (call.status === "blocked") continue;
    const entry = byStage[costStageOf(call, stageByRequest)];
    entry.usd += Number.isFinite(call.costUsd) ? call.costUsd : 0;
    entry.calls += 1;
    if (call.costBasis !== "settled_from_provider_usage") entry.unsettled += 1;
    const usage = call.usage || {};
    entry.inputTokens += Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? 0) || 0;
    entry.outputTokens += Number(usage.output_tokens ?? usage.completion_tokens
      ?? ((usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0))) || 0;
    entry.requestBodyBytes += Number(call.requestBodyBytes) || 0;
  }
  return byStage;
}

// Stage timings of one job (ms): card = card-name model time, planning and
// selection = the model calls (including a format retry), tocCall = the ToC
// model call, tocWait = time the window assembly waited for it.
export function stageTimings({ continuation, error, wall = {} } = {}) {
  const provider = continuation?.ruleQueryModel?.timingsMs || error?.boundedRetrieval?.timingsMs || {};
  const pipeline = continuation?.timingsMs || {};
  const ruleToc = continuation?.ruleQueryModel?.bounded?.ruleToc || error?.boundedRetrieval?.ruleToc || null;
  const finite = (value) => (Number.isFinite(value) ? value : null);
  return {
    card: finite(pipeline.auxiliaryExtractionModels),
    planning: finite(provider.plan),
    queryEmbedding: finite(provider.queryEmbedding),
    selection: finite(provider.selection),
    tocCall: finite(ruleToc?.elapsedMs),
    tocWait: finite(provider.ruleTocWait),
    retrieval: finite(pipeline.retrieval),
    prepare: finite(wall.prepare),
  };
}
