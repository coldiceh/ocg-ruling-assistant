import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const testRoot = path.resolve("tests");

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(absolutePath);
    }
  }
  return files;
}

const files = (await collectTestFiles(testRoot)).sort((left, right) => left.localeCompare(right));
if (!files.length) throw new Error("No free test files were found under tests/");

run({ files, concurrency: 1 })
  .on("test:fail", () => {
    process.exitCode = 1;
  })
  .compose(spec)
  .pipe(process.stdout);
