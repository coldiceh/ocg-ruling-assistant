import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createOfficialQaSemanticEquivalenceVerifier,
  runOfficialQaSemanticDirectExperiment,
} from "../backend/officialQaSemanticDirectExperiment.mjs";
import { requestRelayChatCompletionSse } from "../backend/rulingModelProviders.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(projectRoot, "tests", "fixtures", "official-qa-semantic-direct-experiment.json");
const outputPath = resolveOutputPath(process.argv);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const live = process.argv.includes("--live");
const negativeRepeatCount = parseNonNegativeIntegerArgument(process.argv, "--repeat-negatives", 0);
const cardsById = new Map(fixture.cards.map((card) => [card.id, card]));
const usageTotals = {};

const verifier = createOfficialQaSemanticEquivalenceVerifier({
  model: "gpt-5.6-sol",
  reasoningEffort: "low",
  invoke: live ? invokeSolLow : mockVerifier,
});

const evaluationCases = [
  ...fixture.cases.map((item) => ({ ...item, repetition: 0 })),
  ...Array.from({ length: negativeRepeatCount }, (_, index) =>
    fixture.cases
      .filter((item) => !item.expectedEquivalent)
      .map((item) => ({ ...item, repetition: index + 1 }))),
].flat();

const results = [];
for (const item of evaluationCases) {
  const startedAt = Date.now();
  const result = await runOfficialQaSemanticDirectExperiment({
    userQuestion: item.question,
    records: fixture.records,
    resolvedCards: item.resolvedCardIds.map((id) => cardsById.get(id)),
    verifier,
  });
  const predictedEquivalent = result.route === "official_qa_semantic_direct";
  results.push({
    caseId: item.repetition ? `${item.id}-repeat-${item.repetition}` : item.id,
    sourceCaseId: item.id,
    repetition: item.repetition,
    qaId: item.qaId,
    kind: item.kind,
    expectedEquivalent: item.expectedEquivalent,
    predictedEquivalent,
    correct: predictedEquivalent === item.expectedEquivalent,
    route: result.route,
    reason: result.reason || "",
    candidateQaIds: result.candidateQaIds,
    verification: result.verification,
    durationMs: Date.now() - startedAt,
  });
  process.stdout.write(`${item.id}: ${predictedEquivalent ? "DIRECT" : "RAG"} ${results.at(-1).correct ? "PASS" : "FAIL"}\n`);
}

const positives = results.filter((item) => item.expectedEquivalent);
const negatives = results.filter((item) => !item.expectedEquivalent);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: live ? "sol_low_live" : "fixture_mock",
  model: live ? "gpt-5.6-sol" : "mock",
  reasoningEffort: live ? "low" : null,
  baseCaseTotal: fixture.cases.length,
  negativeRepeatCount,
  total: results.length,
  correct: results.filter((item) => item.correct).length,
  positiveAccepted: positives.filter((item) => item.predictedEquivalent).length,
  positiveTotal: positives.length,
  falsePositives: negatives.filter((item) => item.predictedEquivalent).length,
  negativeTotal: negatives.length,
  usage: usageTotals,
  results,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  outputPath,
  total: report.total,
  correct: report.correct,
  positiveAccepted: `${report.positiveAccepted}/${report.positiveTotal}`,
  falsePositives: report.falsePositives,
  mode: report.mode,
})}\n`);

async function mockVerifier({ prompt }) {
  const item = fixture.cases.find((candidate) => String(prompt || "").includes(candidate.question));
  const equivalent = item?.expectedEquivalent === true;
  return JSON.stringify({
    equivalent,
    userEntailsOfficial: equivalent,
    officialEntailsUser: equivalent,
    differences: equivalent ? [] : ["fixture_negative"],
    unresolvedReferences: [],
    uncertain: false,
  });
}

async function invokeSolLow({ prompt, model, reasoningEffort }) {
  const apiKey = String(process.env.RELAY_API_KEY || "").trim();
  const endpoint = relayEndpoint(process.env.RELAY_BASE_URL);
  if (!apiKey) throw new Error("RELAY_API_KEY is required for --live");
  const payload = await requestRelayChatCompletionSse({
    endpoint,
    apiKey,
    env: {
      ...process.env,
      RELAY_STREAM_TIMEOUT_MS: process.env.RELAY_STREAM_TIMEOUT_MS || "60000",
    },
    body: {
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      reasoning_effort: reasoningEffort,
      max_completion_tokens: 900,
    },
  });
  addUsage(payload?.usage || {});
  return extractMessageText(payload?.choices?.[0]?.message?.content);
}

function relayEndpoint(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("RELAY_BASE_URL must be configured for --live");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("RELAY_BASE_URL must be a credential-free HTTPS URL");
  }
  const base = parsed.toString().replace(/\/+$/u, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function extractMessageText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => typeof item === "string" ? item : String(item?.text || "")).join("");
}

function addUsage(usage) {
  for (const [key, value] of Object.entries(usage || {})) {
    if (Number.isFinite(Number(value))) usageTotals[key] = Number(usageTotals[key] || 0) + Number(value);
  }
}

function parseNonNegativeIntegerArgument(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new Error(`${name} must be an integer between 0 and 10`);
  }
  return value;
}

function resolveOutputPath(argv) {
  const index = argv.indexOf("--output");
  if (index < 0) return join(projectRoot, "artifacts", "official-qa-semantic-direct", "latest.json");
  const value = String(argv[index + 1] || "").trim();
  if (!value) throw new Error("--output requires a path");
  return join(projectRoot, value);
}
