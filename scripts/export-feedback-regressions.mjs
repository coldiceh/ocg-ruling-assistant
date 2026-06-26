import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportFeedbackRegressionDrafts, loadFeedbackCases } from "../backend/feedbackCases.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = join(projectRoot, "data");

export async function exportFeedbackRegressions(options = {}) {
  const dataDir = options.dataDir || defaultDataDir;
  const payload = options.payload || await loadFeedbackCases(join(dataDir, "feedback-cases.json"));
  return exportFeedbackRegressionDrafts(payload.records || [], { format: options.format || "json" });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const format = process.argv.includes("--markdown") ? "markdown" : "json";
  const output = await exportFeedbackRegressions({ format });
  console.log(typeof output === "string" ? output : JSON.stringify(output, null, 2));
}
