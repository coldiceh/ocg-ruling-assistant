import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerRulingQuestionFast } from "./fastJudgeEngine.mjs";
import { loadEffectTemplateRegistry } from "./effectTemplateRegistry.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const defaultRealRulingCasesDir = join(projectRoot, "tests", "fixtures", "real-ruling-cases");

export async function loadRealRulingCases(directory = defaultRealRulingCasesDir) {
  const entries = await readdir(directory, { withFileTypes: true });
  const cases = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const fixture = JSON.parse(await readFile(path, "utf8"));
    validateBenchmarkCase(fixture, path);
    cases.push(fixture);
  }
  return cases;
}

export async function runRulingBenchmark({ cases, casesDir = defaultRealRulingCasesDir, effectTemplateRegistry } = {}) {
  const fixtures = cases || await loadRealRulingCases(casesDir);
  const registry = effectTemplateRegistry || await loadEffectTemplateRegistry();
  const results = [];

  for (const fixture of fixtures) {
    let modelCalled = false;
    const formalQuery = fixture.formalQuery || {};
    const answer = await answerRulingQuestionFast({
      question: fixture.inputText,
      mode: "analysis",
      maxLatencyMs: 20_000,
      snapshot: buildFixtureSnapshot(fixture),
      gameState: {
        ...(fixture.gameState || {}),
        activeRestrictions: [
          ...(fixture.gameState?.activeRestrictions || []),
          ...(formalQuery.activeRestrictions || []),
        ],
      },
      chainLinks: formalQuery.chainLinks || [],
      effectTemplateRegistry: registry,
      modelInvoker: async () => {
        modelCalled = true;
        return fixture.modelDraft || null;
      },
    });
    const evaluation = evaluateBenchmarkAnswer(fixture, answer, { modelCalled });
    results.push({ id: fixture.id, category: fixture.category, answer, evaluation });
  }

  return buildBenchmarkReport(results);
}

export function evaluateBenchmarkAnswer(fixture, answer, { modelCalled = false } = {}) {
  const expected = fixture.expected || {};
  const errors = [];
  if (expected.status && answer.status !== expected.status) errors.push(`status:${answer.status}!=${expected.status}`);
  if (expected.evidenceGrade && answer.evidenceGrade !== expected.evidenceGrade) errors.push(`evidenceGrade:${answer.evidenceGrade}!=${expected.evidenceGrade}`);
  const blockerCodes = new Set((answer.blockers || []).flatMap((item) => [item.code, item.id].filter(Boolean)));
  for (const code of expected.mustHaveBlockers || []) if (!blockerCodes.has(code)) errors.push(`missing_blocker:${code}`);
  for (const token of expected.mustHaveTrace || []) if (!traceContains(answer.ruleTrace, token)) errors.push(`missing_trace:${formatToken(token)}`);
  for (const token of expected.mustNotHaveTrace || []) if (traceContains(answer.ruleTrace, token)) errors.push(`forbidden_trace:${formatToken(token)}`);
  const visibleAnswer = JSON.stringify(answer.answer || answer.shortAnswer || "");
  for (const text of expected.mustNotContainInAnswer || []) if (visibleAnswer.includes(text)) errors.push(`forbidden_answer_text:${text}`);

  const unsafeConfirmed = answer.status === "confirmed" && answer.evidenceGrade !== "official_direct";
  const illegalChainEnteredResolution = answer.status === "illegal_question"
    && ((answer.ruleTrace || []).some((item) => item.step === "primitive_resolution_started" && item.result === "started")
      || ((answer.resolutionSteps || []).length > 0 && !answer.hypotheticalBranch));
  const cardMisidentifiedWithoutWarning = fixture.category === "card_identity"
    && answer.status !== "needs_card_confirmation"
    && !(answer.warnings || []).some((item) => /card_identity/u.test(item));
  const llmOverrideProgramVerdict = Boolean(
    fixture.modelDraft
    && expected.programVerdict
    && answer.verdict !== expected.programVerdict
    && !((answer.warnings || []).includes("model_explanation_conflict_rejected")),
  );

  return {
    passed: errors.length === 0 && !unsafeConfirmed && !illegalChainEnteredResolution && !cardMisidentifiedWithoutWarning && !llmOverrideProgramVerdict,
    errors,
    modelCalled,
    explanation: answer.status === "insufficient"
      ? "insufficient: template or state data is intentionally incomplete"
      : `supported: ${answer.evidenceGrade} program result matched the fixture`,
    dangerousFailures: {
      unsafeConfirmed,
      illegalChainEnteredResolution,
      cardMisidentifiedWithoutWarning,
      llmOverrideProgramVerdict,
    },
  };
}

function buildBenchmarkReport(results) {
  const byCategory = countBy(results, (item) => item.category);
  const byEvidenceGrade = countBy(results, (item) => item.answer.evidenceGrade || "unknown");
  const dangerousFailures = {
    unsafeConfirmed: countDanger(results, "unsafeConfirmed"),
    illegalChainEnteredResolution: countDanger(results, "illegalChainEnteredResolution"),
    cardMisidentifiedWithoutWarning: countDanger(results, "cardMisidentifiedWithoutWarning"),
    llmOverrideProgramVerdict: countDanger(results, "llmOverrideProgramVerdict"),
  };
  return {
    totalCases: results.length,
    byCategory,
    byEvidenceGrade,
    supportedCorrect: results.filter((item) => item.evaluation.passed && item.answer.status !== "insufficient").length,
    insufficientCount: results.filter((item) => item.answer.status === "insufficient").length,
    dangerousFailures,
    failedCases: results.filter((item) => !item.evaluation.passed).map((item) => ({ id: item.id, errors: item.evaluation.errors })),
    cases: results,
  };
}

function buildFixtureSnapshot(fixture) {
  const formalQuery = fixture.formalQuery || {};
  const cards = [];
  for (const identity of formalQuery.cardIdentities || []) {
    if (identity.status === "resolved" && identity.cardId) {
      cards.push({
        id: String(identity.cardId),
        name: identity.canonicalName || identity.rawText,
        cnName: identity.canonicalName || identity.rawText,
        aliases: [identity.rawText, ...(identity.aliases || [])].filter(Boolean),
        cardType: identity.cardType || "monster",
        effectText: identity.effectText || "结构化效果模板测试。",
      });
    }
    for (const candidate of identity.candidates || []) {
      cards.push({
        id: String(candidate.cardId || candidate.id),
        name: candidate.name,
        cnName: candidate.name,
        aliases: [identity.rawText, candidate.name],
        cardType: candidate.cardType || "monster",
        effectText: candidate.effectText || "候选卡片。",
      });
    }
  }
  cards.push(...(fixture.snapshotCards || []));
  return {
    cards: dedupeCards(cards),
    records: fixture.records || [],
    snapshotMeta: { sourceFreshness: "fresh", lastSuccessfulSyncAt: "2026-07-03T00:00:00.000Z" },
  };
}

function traceContains(trace = [], token) {
  if (typeof token === "object" && token) {
    return trace.some((item) => Object.entries(token).every(([key, value]) => item?.[key] === value));
  }
  return trace.some((item) => Object.values(item || {}).some((value) => String(value) === String(token)));
}

function formatToken(token) {
  return typeof token === "string" ? token : JSON.stringify(token);
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function countDanger(results, field) {
  return results.filter((item) => item.evaluation.dangerousFailures[field]).length;
}

function dedupeCards(cards) {
  const map = new Map();
  for (const card of cards) map.set(String(card.id || card.cardId || card.name), card);
  return [...map.values()];
}

function validateBenchmarkCase(fixture, path) {
  if (!fixture?.id || !fixture?.category || !fixture?.inputText || !fixture?.formalQuery || !fixture?.expected) {
    throw new TypeError(`Invalid real ruling case: ${path}`);
  }
}
