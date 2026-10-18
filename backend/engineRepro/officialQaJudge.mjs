// Official-Q&A line of the engine-reproduction section (experimental, 2026-10-18).
//
// One GPT-6 Luna call (reasoning "low") per answer compares the user's question with the question
// fields of the official Q&A the final answer was given (officialQaCorrespondence.mjs; official
// answers are never sent). It goes through the reproduction's own official API call
// (modelCalls.mjs createOfficialModelCall: the request body of the offline evaluation, ocg-sim-core
// experiments/official-qa-correspondence run-v1.1) and is charged to the reproduction's own daily
// budget bucket (limits.mjs). It is not a reproduction attempt, so it takes no per-minute slot.
//
// The call starts when the final answer's model call starts and runs alongside it. When the answer is
// complete, the section waits for it only if the reproduction completed or partly completed (the only
// sections that can show the line), and never past the section's own wait deadline (session.mjs).
// Worst case on its own: two 3 s budget-store calls, the 30 s request, a 3 s settlement.
// Fail closed: only a completed response whose output
// names every candidate exactly once with a known verdict counts, and only EXACT ("正好对应",
// the user's two-way rule: PARTIAL and NOT both mean "not found") shows the line. A disabled
// switch, no candidate, a budget refusal, a timeout, an HTTP error or any invalid output shows
// nothing. Nothing here changes the evidence or the main answer.
import {
  OFFICIAL_QA_CORRESPONDENCE_PROMPT_VERSION,
  buildOfficialQaCorrespondenceRequest,
  parseOfficialQaCorrespondenceOutput,
} from "../officialQaCorrespondence.mjs";
import { createEngineReproLimits, redisCommand } from "./limits.mjs";
import { createOfficialModelCall } from "./modelCalls.mjs";

// low: 20 of 20 "found" verdicts correct, 20 of the 21 exact pairs found, median 4.7 s, P95 6.9 s
// on the frozen 40-question set (run-v1.1). Candidates per question there were 2-3.
export const OFFICIAL_QA_JUDGE = Object.freeze({ model: "gpt-6-luna", effort: "low", maxOutput: 6000, timeoutMs: 30_000 });

/** On unless ENGINE_REPRO_OFFICIAL_QA_JUDGE is 0 / false / no / off (the section must be enabled too). */
export function officialQaJudgeEnabled(env = {}) {
  return !/^(?:0|false|no|off)$/iu.test(String(env.ENGINE_REPRO_OFFICIAL_QA_JUDGE || "").trim());
}

const failureCode = (error) => String(error?.code || error?.message || error || "unknown").slice(0, 120);

/**
 * Run the judge for prepared material (buildOfficialQaJudgeInput). Never throws. Result:
 *   { status: "done", exact: [{ id, title, handle }], assessments, ... }
 *   { status: "skipped", reason }   no call was made
 *   { status: "failed", error }     a call was attempted (or refused by the budget); shows nothing
 */
export async function runOfficialQaJudge({ input, env = {}, fetchImpl = globalThis.fetch, now = Date.now,
  command = redisCommand, modelCall = null, limits = null } = {}) {
  const startedAt = now();
  const base = { promptVersion: OFFICIAL_QA_CORRESPONDENCE_PROMPT_VERSION, model: OFFICIAL_QA_JUDGE.model,
    effort: OFFICIAL_QA_JUDGE.effort };
  if (!officialQaJudgeEnabled(env)) return { ...base, status: "skipped", reason: "disabled" };
  const candidates = Array.isArray(input?.candidates) ? input.candidates : [];
  let request;
  try {
    request = buildOfficialQaCorrespondenceRequest({ userQuery: input?.userQuery,
      userCards: Array.isArray(input?.userCards) ? input.userCards : [], candidates });
  } catch (error) {
    return { ...base, status: "failed", error: `request_invalid:${failureCode(error)}`, candidateCount: candidates.length };
  }
  const candidateCount = Object.keys(request.aliases).length;
  if (!candidateCount) return { ...base, status: "skipped", reason: "no_candidates" };
  const measured = { candidateCount, requestSha256: request.requestSha256 };
  let response;
  try {
    const call = modelCall || createOfficialModelCall({ env, fetchImpl,
      limits: limits || createEngineReproLimits({ env, fetchImpl, now, command }) });
    response = await call({ model: OFFICIAL_QA_JUDGE.model, instructions: request.instructions, input: request.input,
      reasoningEffort: OFFICIAL_QA_JUDGE.effort, maxOutputTokens: OFFICIAL_QA_JUDGE.maxOutput,
      timeoutMs: OFFICIAL_QA_JUDGE.timeoutMs });
  } catch (error) {
    return { ...base, ...measured, status: "failed", error: failureCode(error), ms: now() - startedAt };
  }
  const spent = { usage: response?.usage || null, costUsd: Number.isFinite(response?.costUsd) ? response.costUsd : null,
    ms: now() - startedAt };
  if (response?.status !== "completed") {
    return { ...base, ...measured, ...spent, status: "failed", error: `response_${response?.status || "missing_status"}` };
  }
  const parsed = parseOfficialQaCorrespondenceOutput(response.outputText, request.aliases);
  if (!parsed.ok) return { ...base, ...measured, ...spent, status: "failed", error: parsed.error };
  const byId = new Map(candidates.map((candidate) => [String(candidate.id), candidate]));
  const exact = parsed.assessments.filter((row) => row.verdict === "EXACT").map((row) => {
    const candidate = byId.get(row.id) || {};
    return { id: row.id, title: String(candidate.displayTitle || candidate.title || row.id),
      handle: candidate.handle ? String(candidate.handle) : null };
  });
  return { ...base, ...measured, ...spent, status: "done", exact,
    assessments: parsed.assessments.map(({ id, verdict, differences, reason }) => ({ id, verdict, differences, reason })) };
}

/**
 * Start the judge for one answer, or return null when there is nothing to judge. The returned
 * promise never rejects.
 */
export function startOfficialQaJudge({ input, ...options } = {}) {
  if (!input || !Array.isArray(input.candidates) || !input.candidates.length) return null;
  return runOfficialQaJudge({ input, ...options })
    .catch((error) => ({ promptVersion: OFFICIAL_QA_CORRESPONDENCE_PROMPT_VERSION, status: "failed", error: failureCode(error) }));
}

/** Compact, response-safe view of a judge result (no request text). */
export function officialQaJudgeSummary(result) {
  if (!result || typeof result !== "object") return null;
  const counts = { EXACT: 0, PARTIAL: 0, NOT: 0 };
  for (const row of Array.isArray(result.assessments) ? result.assessments : []) {
    if (Object.hasOwn(counts, row?.verdict)) counts[row.verdict] += 1;
  }
  return {
    status: typeof result.status === "string" ? result.status : null,
    ...(result.reason ? { reason: String(result.reason) } : {}),
    ...(result.error ? { error: String(result.error) } : {}),
    promptVersion: result.promptVersion || null, model: result.model || null, effort: result.effort || null,
    candidateCount: Number.isSafeInteger(result.candidateCount) ? result.candidateCount : null,
    verdicts: result.status === "done" ? counts : null,
    exact: Array.isArray(result.exact) ? result.exact.map(({ id, title }) => ({ id, title })) : [],
    assessments: Array.isArray(result.assessments) ? result.assessments : [],
    ms: Number.isFinite(result.ms) ? result.ms : null,
    costUsd: Number.isFinite(result.costUsd) ? result.costUsd : null,
  };
}
