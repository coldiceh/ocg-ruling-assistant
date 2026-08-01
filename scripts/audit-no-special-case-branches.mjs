import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const productionRoots = ["backend", "api", "src"];
const excludedDirectories = new Set([
  "data",
  "fixtures",
  "generated",
  "node_modules",
  "test",
  "tests",
  "vendor",
  "versions",
]);
const executableExtensions = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx"]);

const forbidden = [
  { id: "answer-from-user-statement", pattern: /extractStatedValuePair|statedFinal/u },
  { id: "embedded-card-alias-catalog", pattern: /const\s+(?:baseCardIndex|localCardAliasHints)\s*=\s*\[\s*\{/u },
  { id: "embedded-question-answer-notes", pattern: /const\s+builtInNotes\s*=\s*\[\s*\{/u },
  { id: "historical-card-answer-handler", pattern: /inferDamageStepEndBattleDestroyedAnswer|buildDamageStepEndBattleDestroyedSubAnswers/u },
  { id: "issue-frame-final-answer-table", pattern: /return\s+ruleAnswer\s*\(/u },
  {
    id: "deleted-answer-override",
    pattern: /applyOperationLegalityOverride|applyExactScenarioGrounding|applySemanticStateConstraint|applyGroundedOperationFallback|selectDeterministicDecision/u,
  },
  {
    id: "local-deterministic-answer-shortcut",
    pattern: /RAG_ALLOW_LOCAL_DETERMINISTIC_SHORTCUT|localDeterministicShortcutEnabled|buildDeterministicModelResult|hasCompleteDeterministicRuling/u,
  },
  {
    id: "fixed-answer-map",
    pattern: /(?:fixed|hardcoded|specialCase|scenario)(?:Answer|Ruling)(?:Map|Table|Overrides?)\s*=\s*(?:new\s+Map\s*\(|\{|\[)/iu,
  },
  {
    id: "user-asserted-answer-injection",
    pattern: /(?:user|question|query)(?:Text|Input|Statement).{0,100}(?:应为|应该是|正确答案)|(?:应为|应该是|正确答案).{0,100}(?:user|question|query)(?:Text|Input|Statement)/isu,
  },
];

// Regression sentinels only: these identities must never influence a production answer branch.
const benchmarkIdentityTokens = [
  "混沌の黒魔術師",
  "深淵の相剣龍",
  "滅びの黒魔術師",
  "教导的圣女",
  "冰剑龙",
  "No.41",
  "月光银狗",
  "红莲之指名者",
  "B2B",
  "18150",
  "24229",
  "13107",
  "24174",
  "24006",
];

const productionFiles = [];
for (const root of productionRoots) {
  await collectProductionFiles(resolve(repositoryRoot, root), productionFiles);
}

const failures = [];
for (const file of productionFiles) {
  const source = await readFile(file, "utf8");
  const displayPath = relative(repositoryRoot, file).replaceAll("\\", "/");
  for (const check of forbidden) {
    if (check.pattern.test(source)) failures.push(`${displayPath}: ${check.id}`);
  }
  for (const token of benchmarkIdentityTokens) {
    if (containsIdentityBranch(source, token)) {
      failures.push(`${displayPath}: benchmark-identity-branch (${token})`);
    }
  }
}

if (failures.length) {
  console.error("Special-case authority audit failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Special-case authority audit passed (${productionFiles.length} production files).`);
}

async function collectProductionFiles(directory, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) await collectProductionFiles(absolutePath, output);
      continue;
    }
    if (entry.isFile() && executableExtensions.has(extname(entry.name))) output.push(absolutePath);
  }
}

function containsIdentityBranch(source, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:if\\s*\\(|switch\\s*\\(|case\\s+|\\?\\s*|&&|\\|\\|)[^\\n]{0,240}${escaped}|${escaped}[^\\n]{0,240}(?:if\\s*\\(|switch\\s*\\(|case\\s+|\\?\\s*|&&|\\|\\|)`,
    "iu",
  ).test(source);
}
