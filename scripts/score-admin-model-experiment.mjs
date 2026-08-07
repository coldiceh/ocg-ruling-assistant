import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import {
  assertPaidExperimentReportGenerated,
  scoreOfflineExperimentReport,
} from "./lib/offline-experiment-scorer.mjs";

const DEFAULT_ASSERTIONS_FILE = new URL(
  "../tests/fixtures/admin-evidence-dry-run-goldens.json",
  import.meta.url,
);

export async function scoreAdminModelExperimentFiles({
  reportFile,
  assertionsFile = DEFAULT_ASSERTIONS_FILE,
  outputFile = "",
  readFileImpl = readFile,
  writeFileImpl = writeFile,
} = {}) {
  if (!reportFile) throw new Error("--report is required");

  // Deliberate sequencing boundary: first prove a paid experiment report was
  // generated and is terminal. Only then may the independent golden fixture be
  // read. This function never invokes a model or mutates an Evidence Snapshot.
  const report = parseJson(
    await readFileImpl(reportFile, "utf8"),
    "experiment report",
  );
  assertPaidExperimentReportGenerated(report);
  const assertionFixture = parseJson(
    await readFileImpl(assertionsFile, "utf8"),
    "assertion fixture",
  );
  const scored = scoreOfflineExperimentReport({ report, assertionFixture });
  if (outputFile) {
    await writeFileImpl(outputFile, `${JSON.stringify(scored, null, 2)}\n`, "utf8");
  }
  return scored;
}

export function parseArguments(argv) {
  const options = { reportFile: "", assertionsFile: DEFAULT_ASSERTIONS_FILE, outputFile: "", compact: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value`);
      return argv[index];
    };
    if (argument === "--report") options.reportFile = take();
    else if (argument === "--assertions") options.assertionsFile = take();
    else if (argument === "--output") options.outputFile = take();
    else if (argument === "--compact") options.compact = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  const stdout = dependencies.stdout || process.stdout;
  if (options.help) {
    stdout.write("用法：node scripts/score-admin-model-experiment.mjs --report REPORT.json [--assertions GOLDENS.json] [--output SCORED.json] [--compact]\n");
    return 0;
  }
  const scored = await scoreAdminModelExperimentFiles({
    ...options,
    readFileImpl: dependencies.readFileImpl,
    writeFileImpl: dependencies.writeFileImpl,
  });
  stdout.write(`${JSON.stringify(scored, null, options.compact ? 0 : 2)}\n`);
  return 0;
}

function parseJson(serialized, label) {
  try {
    return JSON.parse(String(serialized || ""));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error?.message || error}`);
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
