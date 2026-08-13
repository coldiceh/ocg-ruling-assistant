import assert from "node:assert/strict";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceExtensions = new Set([".cjs", ".js", ".mjs"]);

const publicEntries = Object.freeze([
  "backend/publicAnswerService.mjs",
  "backend/rulingVersionRegistry.mjs",
  "api/answer.js",
  "api/budget.js",
]);

const rawAnswerClosure = Object.freeze([
  "backend/rawEvidenceRagPipeline.mjs",
  "backend/rawEvidenceModelClient.mjs",
  "backend/rawEvidenceRagPrompt.mjs",
  "backend/rawEvidenceAnswerValidator.mjs",
  "backend/rawGenericCardResolver.mjs",
  "backend/rawGenericDataStore.mjs",
  "backend/rawGenericEvidenceRetriever.mjs",
  "backend/rawGenericRuntimeBundle.mjs",
]);

const rawTransportClosure = Object.freeze([
  "backend/rawEvidenceModelClient.mjs",
  "backend/publicModelBudgetLedger.mjs",
  "backend/relayChatCompletionSseTransport.mjs",
]);

const forbiddenExactModules = new Set([
  // Superseded public RAG stack and its semantic matcher/prompt helpers.
  "backend/ragModelClient.mjs",
  "backend/ragRulingPipeline.mjs",
  "backend/ragRulingPrompt.mjs",
  "backend/ragEvidenceRetriever.mjs",
  "backend/ragCardExtractor.mjs",
  "backend/ragRuntimeBundle.mjs",
  "backend/officialQaMatcher.mjs",
  "backend/officialQaAnswerExtractor.mjs",
  "backend/rulebookPassageRetriever.mjs",
  "backend/evidenceQuestionTypeClassifier.mjs",

  // Handwritten scenario analysis and semantic authority components.
  "backend/operationLegalityAnalyzer.mjs",
  "backend/ruleScenarioCompiler.mjs",
  "backend/semanticAuthorityGate.mjs",
  "backend/publicRagAnswerValidator.mjs",
  "backend/activationEventStateReasoner.mjs",
  "backend/duelStateReasoner.mjs",
  "backend/effectApplicabilityContext.mjs",
  "backend/effectInstanceLifecycle.mjs",
  "backend/effectPrimitives.mjs",
  "backend/effectResolutionEngine.mjs",
  "backend/effectRewriteAttribution.mjs",
  "backend/effectStateReasoner.mjs",
  "backend/orderedResolutionCheckpointReasoner.mjs",
  "backend/printedCardNameReferenceReasoner.mjs",
  "backend/printedTextReferences.mjs",
  "backend/scenarioEntityResolver.mjs",
  "backend/simultaneousTriggerChain.mjs",
  "backend/spellTrapActivationProcedure.mjs",
  "backend/summonLegalityContext.mjs",
  "backend/summonProcedureTriggerReasoner.mjs",
  "backend/triggerTimingRules.mjs",

  // The neutral public client must not load the old admin provider/schema layer.
  "backend/rulingModelProviders.mjs",
  "backend/modelRulingSchema.mjs",
]);

test("public latest entries recursively stay inside the raw-evidence dependency boundary", async () => {
  const closures = new Map();
  for (const entry of publicEntries) {
    const closure = await collectStaticImportClosure(resolve(projectRoot, entry));
    closures.set(entry, closure);
    assertNoForbiddenDependencies(entry, closure);
  }

  for (const entry of [
    "backend/publicAnswerService.mjs",
    "backend/rulingVersionRegistry.mjs",
    "api/answer.js",
  ]) {
    assertClosureContains(closures.get(entry), entry, rawAnswerClosure);
  }
  assertClosureContains(
    closures.get("api/budget.js"),
    "api/budget.js",
    rawTransportClosure,
  );
});

test("static import scanner ignores import-like text outside module declarations", () => {
  const source = [
    "// import \"./comment-one.mjs\";",
    "/* export * from \"./comment-two.mjs\"; */",
    "const quoted = 'import \\\"./string.mjs\\\"';",
    "const templated = `export { fake } from \"./template.mjs\"`;",
    String.raw`const matcher = /import\s+["']\.\/regex\.mjs["']/u;`,
    "import value from \"./real-import.mjs\" with { type: \"javascript\" };",
    "import \"./real-side-effect.mjs\";",
    "export { value } from \"../real-export.mjs\";",
    "void import(\"./dynamic-import.mjs\");",
  ].join("\n");

  assert.deepEqual(findStaticModuleSpecifiers(source), [
    "./real-import.mjs",
    "./real-side-effect.mjs",
    "../real-export.mjs",
  ]);
});

async function collectStaticImportClosure(entryPath) {
  const canonicalEntry = await realpath(entryPath);
  const pending = [canonicalEntry];
  const visited = new Set();
  const parentByPath = new Map([[canonicalEntry, null]]);

  while (pending.length) {
    const importer = pending.shift();
    if (visited.has(importer)) continue;
    visited.add(importer);
    if (!sourceExtensions.has(extname(importer))) continue;

    const source = await readFile(importer, "utf8");
    for (const specifier of findStaticModuleSpecifiers(source)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const imported = await resolveRelativeModule(importer, specifier);
      assert.ok(
        imported,
        `${projectPath(importer)} has an unresolved static import: ${specifier}`,
      );
      if (!parentByPath.has(imported)) {
        parentByPath.set(imported, importer);
        pending.push(imported);
      }
    }
  }

  return { entryPath: canonicalEntry, visited, parentByPath };
}

function assertNoForbiddenDependencies(entry, closure) {
  const failures = [];
  for (const absolutePath of closure.visited) {
    const modulePath = projectPath(absolutePath);
    const reason = forbiddenModuleReason(modulePath);
    if (!reason) continue;
    failures.push(
      `${reason}: ${formatDependencyPath(absolutePath, closure.parentByPath)}`,
    );
  }
  assert.deepEqual(
    failures,
    [],
    `${entry} reaches forbidden public dependencies:\n${failures.map((item) => `- ${item}`).join("\n")}`,
  );
}

function forbiddenModuleReason(modulePath) {
  if (forbiddenExactModules.has(modulePath)) return "legacy or semantic module";
  if (/^(?:api|backend)\/admin[^/]*\.(?:cjs|js|mjs)$/u.test(modulePath)) {
    return "admin module";
  }
  if (/^backend\/legacyLuaSemantic[^/]*\.mjs$/u.test(modulePath)) {
    return "Lua semantic module";
  }
  if (/^backend\/formal(?:Engine|Scenario)[^/]*\.mjs$/u.test(modulePath)) {
    return "formal engine module";
  }
  if (/^backend\/ocg(?:Engine|Scenario)[^/]*\.mjs$/u.test(modulePath)) {
    return "OCG engine module";
  }
  if (/^backend\/(?!rawEvidenceAnswerValidator\.mjs$)[^/]*(?:Analyzer|Compiler|Reasoner|Validator)\.mjs$/u.test(modulePath)) {
    return "analyzer, compiler, reasoner or semantic validator module";
  }
  return "";
}

function assertClosureContains(closure, entry, expectedModules) {
  const actual = new Set([...closure.visited].map(projectPath));
  const missing = expectedModules.filter((modulePath) => !actual.has(modulePath));
  assert.deepEqual(
    missing,
    [],
    `${entry} is missing required raw public modules: ${missing.join(", ")}`,
  );
}

function formatDependencyPath(target, parentByPath) {
  const path = [];
  let current = target;
  while (current) {
    path.unshift(projectPath(current));
    current = parentByPath.get(current) || null;
  }
  return path.join(" -> ");
}

async function resolveRelativeModule(importer, rawSpecifier) {
  const specifier = rawSpecifier.split(/[?#]/u, 1)[0];
  const absolute = resolve(dirname(importer), specifier);
  const candidates = [absolute];
  if (!extname(absolute)) {
    candidates.push(
      `${absolute}.cjs`,
      `${absolute}.js`,
      `${absolute}.mjs`,
      `${absolute}.json`,
      resolve(absolute, "index.cjs"),
      resolve(absolute, "index.js"),
      resolve(absolute, "index.mjs"),
    );
  }
  for (const candidate of candidates) {
    if (await isFile(candidate)) return realpath(candidate);
  }
  return null;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function projectPath(absolutePath) {
  return relative(projectRoot, absolutePath).replaceAll("\\", "/");
}

/**
 * Return only ESM import declarations and export-from declarations.
 * The lexer discards comments, strings, templates and regular expressions
 * before declaration recognition, so dependency checks never inspect prose.
 */
function findStaticModuleSpecifiers(source) {
  const tokens = lexJavaScript(source);
  const specifiers = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "identifier") continue;
    if (!isModuleDeclarationStart(tokens[index - 1])) continue;

    if (token.value === "import") {
      const next = tokens[index + 1];
      if (!next || next.value === "(" || next.value === ".") continue;
      if (next.type === "string") {
        specifiers.push(next.value);
        continue;
      }
      const specifier = findImportFromSpecifier(tokens, index + 1);
      if (specifier) specifiers.push(specifier);
      continue;
    }

    if (token.value === "export") {
      const specifier = findImportFromSpecifier(tokens, index + 1);
      if (specifier) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function isModuleDeclarationStart(previous) {
  return !previous || previous.value === ";" || previous.value === "}";
}

function findImportFromSpecifier(tokens, startIndex) {
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === ";") return "";
    if (token.type === "identifier" && (token.value === "import" || token.value === "export")) {
      return "";
    }
    if (token.type === "identifier" && token.value === "from") {
      const next = tokens[index + 1];
      return next?.type === "string" ? next.value : "";
    }
  }
  return "";
}

function lexJavaScript(source) {
  const tokens = [];
  let index = 0;
  let previous = null;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (index === 0 && character === "#" && next === "!") {
      index = skipLineComment(source, index + 2);
      continue;
    }

    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index = skipLineComment(source, index + 2);
      continue;
    }
    if (character === "/" && next === "*") {
      index = skipBlockComment(source, index + 2);
      continue;
    }
    if (character === "'" || character === '"') {
      const string = readString(source, index, character);
      tokens.push({ type: "string", value: string.value });
      previous = tokens.at(-1);
      index = string.end;
      continue;
    }
    if (character === "`") {
      index = skipTemplate(source, index + 1);
      continue;
    }
    if (character === "/" && canStartRegularExpression(previous)) {
      index = skipRegularExpression(source, index + 1);
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index])) index += 1;
      tokens.push({ type: "identifier", value: source.slice(start, index) });
      previous = tokens.at(-1);
      continue;
    }

    const punctuator = readPunctuator(source, index);
    tokens.push({ type: "punctuator", value: punctuator });
    previous = tokens.at(-1);
    index += punctuator.length;
  }
  return tokens;
}

function readString(source, start, quote) {
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const character = source[index];
    if (character === quote) return { value, end: index + 1 };
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === "\r" && source[index + 2] === "\n") {
        index += 3;
        continue;
      }
      if (escaped === "\r" || escaped === "\n") {
        index += 2;
        continue;
      }
      value += decodeSimpleEscape(escaped);
      index += 2;
      continue;
    }
    value += character;
    index += 1;
  }
  return { value, end: index };
}

function decodeSimpleEscape(value) {
  return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" })[value] ?? value ?? "";
}

function skipLineComment(source, start) {
  const end = source.indexOf("\n", start);
  return end < 0 ? source.length : end + 1;
}

function skipBlockComment(source, start) {
  const end = source.indexOf("*/", start);
  return end < 0 ? source.length : end + 2;
}

function skipTemplate(source, start) {
  let index = start;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
    } else if (source[index] === "`") {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return index;
}

function skipRegularExpression(source, start) {
  let index = start;
  let inCharacterClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "[") inCharacterClass = true;
    else if (character === "]") inCharacterClass = false;
    else if (character === "/" && !inCharacterClass) {
      index += 1;
      while (index < source.length && /[A-Za-z]/u.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return index;
}

function canStartRegularExpression(previous) {
  if (!previous) return true;
  if (previous.type === "identifier") {
    return new Set([
      "await", "case", "delete", "do", "else", "in", "instanceof",
      "new", "of", "return", "throw", "typeof", "void", "yield",
    ]).has(previous.value);
  }
  return new Set([
    "(", "[", "{", ",", ";", ":", "=", "==", "===", "!", "!=", "!==",
    "?", "=>", "+", "-", "*", "%", "&", "&&", "|", "||", "^", "~", "??",
  ]).has(previous.value);
}

function readPunctuator(source, index) {
  for (const width of [4, 3, 2]) {
    const value = source.slice(index, index + width);
    if (new Set([
      ">>>=", "===", "!==", ">>>", "**=", "&&=", "||=", "??=", "=>", "==",
      "!=", "<=", ">=", "++", "--", "&&", "||", "??", "**", "<<", ">>",
      "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "?.",
    ]).has(value)) return value;
  }
  return source[index];
}
