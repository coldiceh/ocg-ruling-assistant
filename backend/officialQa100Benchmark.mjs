import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerRulingQuestionFast, loadFastJudgeSnapshot } from "./fastJudgeEngine.mjs";
import { createEffectTemplateRegistry } from "./effectTemplateRegistry.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const defaultOfficialQa100Path = join(projectRoot, "tests", "fixtures", "official-qa-100", "benchmark.json");

export async function loadOfficialQa100Benchmark(path = defaultOfficialQa100Path) {
  const benchmark = JSON.parse(await readFile(path, "utf8"));
  validateOfficialQa100Benchmark(benchmark);
  return benchmark;
}

export function validateOfficialQa100Benchmark(benchmark) {
  if (benchmark?.targetCaseCount !== 100 || !Array.isArray(benchmark.cases) || benchmark.cases.length !== 100) {
    throw new TypeError("official QA benchmark must contain exactly 100 cases");
  }
  const ids = new Set();
  for (const fixture of benchmark.cases) {
    const required = ["id", "userQuery", "expectedRoute", "expectedAnswerShape", "expectedConfirmationLevel", "expectedSafety", "sourceType", "involvedCards", "expectedKeyPoints", "forbiddenOutputs", "failureTags"];
    for (const field of required) if (fixture[field] === undefined) throw new TypeError(`${fixture.id || "unknown"}: missing ${field}`);
    if (ids.has(fixture.id)) throw new TypeError(`duplicate benchmark id: ${fixture.id}`);
    ids.add(fixture.id);
  }
  const distribution = countBy(benchmark.cases, (item) => item.category);
  const expected = { official_exact: 20, official_near_exact: 10, official_similar: 20, template_supported: 20, conditional_fallback: 20, insufficient: 10 };
  for (const [category, count] of Object.entries(expected)) {
    if (distribution[category] !== count) throw new TypeError(`invalid ${category} count: ${distribution[category] || 0}`);
  }
  return { valid: true, distribution };
}

export async function runOfficialQa100Benchmark({ benchmark, benchmarkPath = defaultOfficialQa100Path, dataDir = join(projectRoot, "data") } = {}) {
  const suite = benchmark || await loadOfficialQa100Benchmark(benchmarkPath);
  const sourceSnapshot = await loadFastJudgeSnapshot(dataDir);
  const results = [];
  for (const fixture of suite.cases) {
    let modelCalled = false;
    const snapshot = buildCaseSnapshot(fixture, sourceSnapshot);
    const effectTemplateRegistry = fixture.fixtureTemplate
      ? createEffectTemplateRegistry({ templates: [fixture.fixtureTemplate], restrictionTemplates: [], aliases: [] })
      : null;
    const answer = await answerRulingQuestionFast({
      question: fixture.userQuery,
      mode: "duel",
      maxLatencyMs: 20_000,
      snapshot,
      gameState: fixture.request?.gameState || {},
      chainLinks: fixture.request?.chainLinks || [],
      effectTemplateRegistry,
      modelInvoker: async () => {
        modelCalled = true;
        return fixture.modelDraft || null;
      },
    });
    results.push({ fixture, answer, evaluation: evaluateOfficialQa100Case(fixture, answer, { modelCalled }) });
  }
  return buildOfficialQa100Report(results);
}

export function evaluateOfficialQa100Case(fixture, answer, { modelCalled = false } = {}) {
  const errors = [];
  if (answer.answerRoute !== fixture.expectedRoute) errors.push(`route:${answer.answerRoute}!=${fixture.expectedRoute}`);
  const shape = fixture.expectedAnswerShape || {};
  if (shape.status && answer.status !== shape.status) errors.push(`status:${answer.status}!=${shape.status}`);
  if (shape.evidenceGrade && answer.evidenceGrade !== shape.evidenceGrade) errors.push(`evidenceGrade:${answer.evidenceGrade}!=${shape.evidenceGrade}`);
  if (shape.verdict && answer.verdict !== shape.verdict) errors.push(`verdict:${answer.verdict}!=${shape.verdict}`);
  if (fixture.expectedConfirmationLevel && answer.confirmationLevel !== fixture.expectedConfirmationLevel) errors.push(`confirmationLevel:${answer.confirmationLevel}!=${fixture.expectedConfirmationLevel}`);
  for (const field of shape.requiredFields || []) if (!Object.hasOwn(answer, field)) errors.push(`missing_field:${field}`);
  const visible = JSON.stringify(answer);
  for (const keyPoint of fixture.expectedKeyPoints || []) if (!visible.includes(keyPoint)) errors.push(`missing_key_point:${keyPoint}`);
  for (const forbidden of fixture.forbiddenOutputs || []) if (visible.includes(forbidden)) errors.push(`forbidden_output:${forbidden}`);

  const dangerousFailures = {
    unsafeConfirmed: answer.status === "confirmed" && answer.evidenceGrade !== "official_direct",
    officialScopeMismatchUsedAsDirect: fixture.category === "official_similar" && ["official_qa_exact_match", "official_qa_near_case_match"].includes(answer.answerRoute),
    wrongCardResolvedWithoutWarning: fixture.failureTags?.includes("wrong_card_resolution")
      && answer.cardIdentity?.status === "resolved"
      && !(answer.warnings || []).some((item) => /card_identity|card.*warning/iu.test(item)),
    llmOverrideProgramVerdict: Boolean(fixture.modelDraft)
      && modelCalled
      && !(answer.warnings || []).includes("model_explanation_conflict_rejected"),
    relatedEvidenceUsedAsOfficialDirect: fixture.sourceType === "official_similar" && answer.evidenceGrade === "official_direct",
  };
  return {
    passed: errors.length === 0 && !Object.values(dangerousFailures).some(Boolean),
    errors,
    dangerousFailures,
    modelCalled,
  };
}

function buildCaseSnapshot(fixture, sourceSnapshot) {
  const records = [];
  const cards = [];
  if (fixture.sourceType === "official_qa" && fixture.sourceId && !fixture.fixtureRecord) {
    const record = sourceSnapshot.records.find((item) => String(item.id) === String(fixture.sourceId));
    if (!record) throw new TypeError(`${fixture.id}: official source not found: ${fixture.sourceId}`);
    records.push({ ...record, evidenceStatus: "current", sourceType: "official_qa" });
    const ids = new Set((record.cardIds || []).map(normalizeId));
    const names = new Set((record.cards || []).map(normalize));
    cards.push(...sourceSnapshot.cards.filter((card) => ids.has(normalizeId(card.id || card.cardId)) || names.has(normalize(card.name || card.cnName))));
  }
  if (fixture.fixtureRecord) records.push(fixture.fixtureRecord);
  if (fixture.fixtureCard) cards.push(fixture.fixtureCard);
  for (const [index, name] of (fixture.involvedCards || []).entries()) {
    if (!name || /^\d+$/u.test(String(name)) || cards.some((card) => normalize(card.name || card.cnName) === normalize(name))) continue;
    cards.push({ id: `fixture-${fixture.id}-${index + 1}`, name, cnName: name, aliases: [name], cardType: "monster", effectText: "用于 benchmark 的最小卡片身份记录。" });
  }
  return {
    cards: dedupe(cards, (item) => String(item.id || item.cardId || item.name)),
    records: dedupe(records, (item) => String(item.id)),
    snapshotMeta: { sourceFreshness: "fresh", lastSuccessfulSyncAt: "2026-07-04T00:00:00.000Z" },
  };
}

function buildOfficialQa100Report(results) {
  const routeCounts = countBy(results, (item) => item.answer.answerRoute || "unknown");
  const correctByRoute = {};
  for (const route of ["official_qa_exact_match", "official_qa_near_case_match", "rule_engine_answer", "conditional_branch_answer", "insufficient"]) {
    const matching = results.filter((item) => item.fixture.expectedRoute === route);
    const correct = matching.filter((item) => item.evaluation.passed).length;
    correctByRoute[route] = metric(correct, matching.length);
  }
  const dangerousFailures = {
    unsafeConfirmed: countDanger(results, "unsafeConfirmed"),
    officialScopeMismatchUsedAsDirect: countDanger(results, "officialScopeMismatchUsedAsDirect"),
    wrongCardResolvedWithoutWarning: countDanger(results, "wrongCardResolvedWithoutWarning"),
    llmOverrideProgramVerdict: countDanger(results, "llmOverrideProgramVerdict"),
    relatedEvidenceUsedAsOfficialDirect: countDanger(results, "relatedEvidenceUsedAsOfficialDirect"),
  };
  return {
    totalCases: results.length,
    categoryCounts: countBy(results, (item) => item.fixture.category),
    routeCounts,
    correctByRoute,
    insufficientCount: results.filter((item) => item.answer.answerRoute === "insufficient").length,
    conditionalCount: results.filter((item) => item.answer.answerRoute === "conditional_branch_answer").length,
    officialExactCorrect: categoryMetric(results, "official_exact"),
    officialNearCorrect: categoryMetric(results, "official_near_exact"),
    templateCorrect: categoryMetric(results, "template_supported"),
    dangerousFailures,
    topFailureReasons: topFailureReasons(results),
    failedCases: results.filter((item) => !item.evaluation.passed).map((item) => ({ id: item.fixture.id, category: item.fixture.category, errors: item.evaluation.errors, dangerousFailures: item.evaluation.dangerousFailures })),
    results,
  };
}

function categoryMetric(results, category) {
  const matching = results.filter((item) => item.fixture.category === category);
  return metric(matching.filter((item) => item.evaluation.passed).length, matching.length);
}

function metric(correct, total) {
  return { correct, total, accuracy: total ? Number((correct / total).toFixed(4)) : 0 };
}

function topFailureReasons(results) {
  const counts = {};
  for (const item of results) {
    if (item.answer.answerRoute === "insufficient" || !item.evaluation.passed) {
      for (const reason of [...(item.fixture.failureTags || []), ...item.evaluation.errors]) counts[reason] = (counts[reason] || 0) + 1;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([reason, count]) => ({ reason, count }));
}

function countDanger(results, field) {
  return results.filter((item) => item.evaluation.dangerousFailures[field]).length;
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function dedupe(items, getKey) {
  const map = new Map();
  for (const item of items) map.set(getKey(item), item);
  return [...map.values()];
}

function normalize(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}

function normalizeId(value) {
  return String(value || "").replace(/\D+/gu, "").replace(/^0+(?=\d)/u, "");
}
