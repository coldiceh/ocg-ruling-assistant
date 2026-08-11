import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["api", "backend", "scripts", "src", "tests"];
const sourceExtensions = new Set([".cjs", ".js", ".mjs"]);
const staticImportPattern = /(?:^|[\r\n;])\s*(?:import|export)\s+(?:[^"'`;]*?\s+from\s*)?["'](?<specifier>\.{1,2}\/[^"']+)["']/gmu;
const callImportPattern = /\b(?:import|require)\s*\(\s*["'](?<specifier>\.{1,2}\/[^"']+)["']\s*\)/gmu;

test("all relative imports in production, scripts, and tests resolve", async () => {
  const sourceFiles = (
    await Promise.all(sourceRoots.map((root) => collectSourceFiles(join(projectRoot, root))))
  ).flat().sort();
  const missing = [];

  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    for (const match of findRelativeImports(source)) {
      if (await relativeImportResolves(file, match.specifier)) continue;
      missing.push({
        file: relative(projectRoot, file).replaceAll("\\", "/"),
        line: lineNumberAt(source, match.index),
        specifier: match.specifier,
      });
    }
  }

  assert.deepEqual(missing, [], formatMissingImports(missing));
});

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(path));
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function findRelativeImports(source) {
  const found = [];
  for (const pattern of [staticImportPattern, callImportPattern]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      found.push({
        index: match.index + match[0].indexOf(match.groups.specifier),
        specifier: match.groups.specifier,
      });
    }
  }
  return found;
}

async function relativeImportResolves(importer, rawSpecifier) {
  const specifier = rawSpecifier.split(/[?#]/u, 1)[0];
  const absolute = resolve(dirname(importer), specifier);
  const candidates = [absolute];
  if (!extname(absolute)) {
    candidates.push(
      `${absolute}.cjs`,
      `${absolute}.js`,
      `${absolute}.mjs`,
      `${absolute}.json`,
      join(absolute, "index.cjs"),
      join(absolute, "index.js"),
      join(absolute, "index.mjs"),
    );
  }
  for (const candidate of candidates) {
    if (await isFile(candidate)) return true;
  }
  return false;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function formatMissingImports(missing) {
  if (!missing.length) return "all relative imports resolve";
  return [
    "Unresolved relative imports:",
    ...missing.map((item) => `- ${item.file}:${item.line} -> ${item.specifier}`),
  ].join("\n");
}
