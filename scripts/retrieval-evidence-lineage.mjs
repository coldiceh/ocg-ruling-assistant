import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadFrozenPublicRagReplayCases,
  runPublicRagEvidenceLineageAudit,
} from "./lib/retrieval-evidence-lineage.mjs";

export function parseRetrievalEvidenceLineageArguments(argv = []) {
  const options = { compact: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dataset") options.datasetPath = requiredNext(argv, ++index, argument);
    else if (argument === "--generations") options.generationsDir = requiredNext(argv, ++index, argument);
    else if (argument === "--expectations") options.expectationsPath = requiredNext(argv, ++index, argument);
    else if (argument === "--data-dir") options.dataDir = requiredNext(argv, ++index, argument);
    else if (argument === "--output") options.outputPath = requiredNext(argv, ++index, argument);
    else if (argument === "--compact") options.compact = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new TypeError(`unsupported argument: ${argument}`);
  }
  return options;
}

export async function runRetrievalEvidenceLineageCli(
  argv = process.argv.slice(2),
  {
    loadCases = loadFrozenPublicRagReplayCases,
    runAudit = runPublicRagEvidenceLineageAudit,
    stdout = process.stdout,
    readFileImpl = readFile,
    writeFileImpl = writeFile,
    mkdirImpl = mkdir,
    setExitCode = (value) => { process.exitCode = value; },
  } = {},
) {
  const options = parseRetrievalEvidenceLineageArguments(argv);
  if (options.help) {
    stdout.write([
      "Usage: node scripts/retrieval-evidence-lineage.mjs --dataset <path> --generations <dir> --expectations <path> [options]",
      "",
      "Replays the public retrieveRagEvidence -> buildRagRulingPromptBundle path.",
      "Frozen planner outputs are supplied as inputs; this runner directly connects no model transport.",
      "Injected fetch attempts are blocked and counted instead of being sent to the network.",
      "",
    ].join("\n"));
    return null;
  }
  for (const [key, option] of [
    ["datasetPath", "--dataset"],
    ["generationsDir", "--generations"],
    ["expectationsPath", "--expectations"],
  ]) {
    if (!options[key]) throw new TypeError(`${option} is required`);
  }
  const expectations = JSON.parse(await readFileImpl(resolve(options.expectationsPath), "utf8"));
  const cases = await loadCases({
    datasetPath: resolve(options.datasetPath),
    generationsDir: resolve(options.generationsDir),
    expectations,
  });
  const report = await runAudit({
    cases,
    dataDir: options.dataDir ? resolve(options.dataDir) : undefined,
  });
  const serialized = `${JSON.stringify(report, null, options.compact ? 0 : 2)}\n`;
  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdirImpl(dirname(outputPath), { recursive: true });
    await writeFileImpl(outputPath, serialized, "utf8");
  }
  stdout.write(serialized);
  if (report?.integrityOk === false) setExitCode(1);
  return report;
}

function requiredNext(argv, index, option) {
  const value = String(argv[index] || "").trim();
  if (!value || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
  return value;
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runRetrievalEvidenceLineageCli().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || error}\n`);
    process.exitCode = 1;
  });
}
