import assert from "node:assert/strict";

// Match the brace and wildcard syntax used by the deployment file lists.
// Tests check packaged paths, independently of how the globs are factored.
export function expandBraces(pattern) {
  const start = pattern.indexOf("{");
  if (start < 0) return [pattern];
  let depth = 0;
  let end = -1;
  for (let index = start; index < pattern.length; index += 1) {
    if (pattern[index] === "{") depth += 1;
    if (pattern[index] === "}") depth -= 1;
    if (depth === 0) {
      end = index;
      break;
    }
  }
  assert.ok(end > start, `unclosed brace glob: ${pattern}`);
  const choices = [];
  let choiceStart = start + 1;
  depth = 0;
  for (let index = choiceStart; index < end; index += 1) {
    if (pattern[index] === "{") depth += 1;
    if (pattern[index] === "}") depth -= 1;
    if (pattern[index] === "," && depth === 0) {
      choices.push(pattern.slice(choiceStart, index));
      choiceStart = index + 1;
    }
  }
  choices.push(pattern.slice(choiceStart, end));
  return choices.flatMap((choice) => expandBraces(
    `${pattern.slice(0, start)}${choice}${pattern.slice(end + 1)}`,
  ));
}

function globMatches(file, pattern) {
  const expression = pattern.replace(/[.+^$()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${expression}$`, "u").test(file);
}

export function matchedFiles(files, includeGlob, excludeGlob = "") {
  const includes = expandBraces(includeGlob);
  const excludes = expandBraces(excludeGlob);
  return files.filter((file) => includes.some((pattern) => globMatches(file, pattern))
    && !excludes.some((pattern) => globMatches(file, pattern))).sort();
}
