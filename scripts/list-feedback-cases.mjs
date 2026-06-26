import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildFeedbackSummary, loadFeedbackCases } from "../backend/feedbackCases.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = join(projectRoot, "data");

export async function listFeedbackCases(options = {}) {
  const dataDir = options.dataDir || defaultDataDir;
  const payload = options.payload || await loadFeedbackCases(join(dataDir, "feedback-cases.json"));
  return buildFeedbackSummary(payload.records || []);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const summary = await listFeedbackCases();
  console.log(JSON.stringify(summary, null, 2));
}
