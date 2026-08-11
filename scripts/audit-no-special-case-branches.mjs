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
  {
    id: "fabricated-provisional-answer-default",
    pattern: /record\.explanation\s*\|\|[^;]{0,300}(?:可以发动|can_activate|can_pay_cost|处理不进行)/isu,
  },
  {
    id: "hardcoded-card-alias-filter",
    pattern: /(?:isGeneric(?:Visible|Card)AliasKey|isLikelyCardNameCandidate)[\s\S]{0,700}(?:卡通世界|toonworld|トゥーンワールド|闪刀姬|閃刀姫|时空)/iu,
  },
  {
    id: "scenario-specific-symbolic-entity",
    pattern: /referenced_toon_monster|can_banish_that_toon_monster/iu,
  },
  {
    id: "scenario-specific-readable-ruling",
    pattern: /把战斗破坏预定的卡通怪兽除外|自己场上的卡通怪兽/iu,
  },
  {
    id: "legacy-scenario-answer-analyzer",
    pattern: /analyzeBoundLingeringRestrictionLifecycle|analyzeOrderedSummonDestroyCheckpoint|inferStructuredRuleAnswer|inferProvidedCardRuleAnswer|buildProvidedCardInferenceAnswer|deriveTypedEffectSemanticsFromCards/iu,
  },
  {
    id: "card-name-triggered-fixed-answer",
    pattern: /(?:黑玛丽|暗黑界龙神王|救祓|エクソシスター|グラファ|鲜花女男爵|バロネス|Baronne|神之宣告|神の宣告)[^\n]{0,300}(?:can_|cannot_|可以|不能|无效|破坏|改写)/iu,
  },
  {
    id: "constructed-c1-c2-damage-scenario",
    pattern: /damageCard\s*\?\s*800\s*:\s*0|buildSpecialVictoryScenario|specialVictoryScenario/iu,
  },
  {
    id: "card-name-answer-validator-table",
    pattern: /(?:青眼白龙|Blue-Eyes White Dragon|超重武者)[^\n]{0,300}(?:terms|守备表示攻击仍可继续|攻击怪兽转守后战斗停止)/iu,
  },
  {
    id: "frontend-offline-ruling-answer",
    pattern: /normalizeRulingRecords|\b(?:builtInNotes|syncedNotes|allNotes)\b|["'][^"']*data\/rulings\.json["']|function\s+(?:scoreNote|findMatches|filterRelevantMatches|confidenceFor)\s*\(|ui\.verdictBody\.textContent\s*=\s*(?:note|bestMatch\.note|match\.note)\.conclusion/iu,
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
  "天雷之双风神",
  "无限泡影",
  "破械冥官",
  "破械焰魔天",
  "完美电子多元驱动蛇",
  "加速同调士",
  "纠罪巧恐怖",
  "黑蔷薇龙",
  "谜式密码大师",
  "无垢者",
  "B2B",
  "18150",
  "24229",
  "13107",
  "24174",
  "23948",
  "11290",
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
  if (displayPath === "backend/fastJudgeEngine.mjs") {
    auditFastJudgeAuthority(source, displayPath, failures);
  }
  if (displayPath !== "backend/rulingBlockers.mjs" && /\bevaluateRulingBlockers\b/u.test(source)) {
    failures.push(`${displayPath}: legacy-ruling-blocker-reentered-production`);
  }
  if (["backend/damageStepBlockers.mjs", "backend/timingMissBlockers.mjs"].includes(displayPath)) {
    if (/structuredProof\s*===\s*true/u.test(source)) failures.push(`${displayPath}: caller-self-attested-structured-proof`);
  }
  if (displayPath === "backend/ragRulingPipeline.mjs") {
    if (/needs_more_info_(?:upgraded|downgraded)|low_confidence_upgraded/u.test(source)) {
      failures.push(`${displayPath}: evidence-presence-strengthens-model-authority`);
    }
    const defaultDraftChecks = [
      /createDefaultFormalScenarioDraftInvoker/u,
      /createDefaultFormalScenarioDraftInvoker\s*\(\s*\{/u,
      /scenarioDraftInvoker:\s*effectiveFormalScenarioDraftInvoker/u,
    ];
    if (defaultDraftChecks.some((pattern) => !pattern.test(source))) {
      failures.push(`${displayPath}: default-formal-draft-invoker-missing`);
    }
  }
  if (displayPath === "backend/formalEngineShadow.mjs") {
    if (!/VALIDATED_FORMAL_EVIDENCE\.has\s*\(/u.test(source)) {
      failures.push(`${displayPath}: formal-evidence-origin-not-branded`);
    }
    const planningOffset = source.indexOf("planFormalScenario(");
    const analysisOffset = source.indexOf("requestFormalScenarioAnalysis(");
    if (planningOffset < 0 || analysisOffset < 0 || planningOffset > analysisOffset) {
      failures.push(`${displayPath}: formal-draft-bypasses-planner`);
    }
    if (!/verifyScenarioDraftCompleteness\s*\(/u.test(source)
        || !/FORMAL_SCENARIO_DRAFT_UNVERIFIED/u.test(source)) {
      failures.push(`${displayPath}: formal-draft-completeness-gate-missing`);
    }
    const capabilityOffset = source.indexOf("getFormalEngineCapabilities(");
    const draftVerifierGuardOffset = source.indexOf('typeof scenarioDraftVerifier !== "function"');
    const proofVerifierGuardOffset = source.indexOf('typeof proofVerifier !== "function"');
    if (draftVerifierGuardOffset < 0 || proofVerifierGuardOffset < 0
        || capabilityOffset < 0 || draftVerifierGuardOffset > capabilityOffset || proofVerifierGuardOffset > capabilityOffset) {
      failures.push(`${displayPath}: formal-verifier-preflight-after-network`);
    }
    if (!/deepFreeze\s*\(\s*structuredClone\s*\(\s*evidence\s*\)\s*\)/u.test(source)) {
      failures.push(`${displayPath}: branded-formal-evidence-remains-mutable`);
    }
    if (!/FORMAL_SCENARIO_DRAFT_DRY_RUN/u.test(source)) {
      failures.push(`${displayPath}: formal-dry-run-paid-call-guard-missing`);
    }
  }
  if (displayPath === "backend/formalScenarioDraftModel.mjs") {
    for (const token of benchmarkIdentityTokens) {
      if (source.includes(token)) failures.push(`${displayPath}: formal-draft-benchmark-identity (${token})`);
    }
    const requiredDraftSymbols = [
      "FORMAL_SCENARIO_DRAFT_CONTRACT",
      "FORMAL_SOURCE_SPAN_ENCODING",
      "prohibitedDerivedFields",
      "MODEL_EXTRACTED_UNVERIFIED",
      "trackPublicBudget: true",
      'Object.hasOwn(item, "sourceSpan")',
    ];
    if (requiredDraftSymbols.some((symbol) => !source.includes(symbol))) {
      failures.push(`${displayPath}: formal-draft-contract-guard-missing`);
    }
    if (/(?:tests?[\\/](?:fixtures?|data)|acceptance)|\bcallRagModel\b|\bbuildRagRulingPromptBundle\b/iu.test(source)) {
      failures.push(`${displayPath}: formal-draft-imports-answer-or-fixture-data`);
    }
  }
  if (displayPath === "backend/formalScenarioPlanner.mjs") {
    for (const symbol of [
      "assertCardMentionBinding",
      "FORMAL_CARD_MENTION_MISMATCH",
      "validateExplicitEffectBindings",
      "FORMAL_EFFECT_MENTION_UNVERIFIED",
    ]) {
      if (!source.includes(symbol)) failures.push(`${displayPath}: formal-entity-binding-guard-missing (${symbol})`);
    }
  }
  if (displayPath === "backend/officialResponses.mjs") {
    const traceabilityStart = source.indexOf("export function hasTraceableOfficialResponseSource");
    const nextFunction = traceabilityStart >= 0 ? source.indexOf("export function", traceabilityStart + 10) : -1;
    const traceabilityBody = traceabilityStart >= 0
      ? source.slice(traceabilityStart, nextFunction > traceabilityStart ? nextFunction : source.length)
      : "";
    if (!traceabilityBody || /officialText|evidenceText/u.test(traceabilityBody)) {
      failures.push(`${displayPath}: official-response-text-self-proves-provenance`);
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

function auditFastJudgeAuthority(source, displayPath, output) {
  const exactOfficialGate = source.match(
    /const\s+directOfficial\s*=\s*cardIdentityGate\.passed\s*\?\s*bindExactOfficialQaAnswer\s*\(/u,
  );
  if (!exactOfficialGate) {
    output.push(`${displayPath}: missing-exact-official-card-identity-gate`);
  }

  const directOfficialReturn = source.search(/if\s*\(\s*directOfficial\s*\)\s*return\s+finalize\s*\(/u);
  if (
    directOfficialReturn >= 0
    && (!exactOfficialGate || directOfficialReturn < (exactOfficialGate.index ?? Number.POSITIVE_INFINITY))
  ) {
    output.push(`${displayPath}: official-answer-return-before-card-identity-gate`);
  }

  const binderStart = source.search(/function\s+bindExactOfficialQaAnswer\s*\(/u);
  const binderEnd = binderStart >= 0 ? source.indexOf("function finalize", binderStart) : -1;
  const exactBinder = binderStart >= 0 && binderEnd > binderStart
    ? source.slice(binderStart, binderEnd)
    : "";
  const binderChecks = [
    /route\?\.level\s*!==\s*["']official_qa_exact_match["']/u,
    /if\s*\(\s*!cardIdentityGate\?\.passed\s*\)\s*return\s+null\s*;/u,
    /candidate\.identityCompatibleForExact\s*===\s*true/u,
    /Number\(candidate\.cardIdCoverage\)\s*===\s*1/u,
    /canonicalIds[^;]{0,160}\.every\s*\(/u,
  ];
  if (!exactBinder || binderChecks.some((pattern) => !pattern.test(exactBinder))) {
    output.push(`${displayPath}: exact-official-binder-not-fail-closed`);
  }

  const forbiddenFastJudgePaths = [
    { id: "fast-judge-ruling-blocker-authority", pattern: /\bevaluateRulingBlockers\b/u },
    { id: "fast-judge-legacy-direct-official-answer", pattern: /\bfindDirectOfficialAnswer\b/u },
    // FastJudge must not accept a caller/model supplied candidate as
    // "verified" authority.  Verified conclusions belong to the formal
    // proof gate or to the exact canonical official-Q&A binding above.
    { id: "fast-judge-self-attested-activation-candidate", pattern: /\bactivationCandidate\b/u },
  ];
  for (const check of forbiddenFastJudgePaths) {
    if (check.pattern.test(source)) output.push(`${displayPath}: ${check.id}`);
  }
}
