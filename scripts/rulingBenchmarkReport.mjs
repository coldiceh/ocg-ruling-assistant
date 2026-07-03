import { runRulingBenchmark } from "../backend/rulingBenchmark.mjs";

const report = await runRulingBenchmark();
const publicReport = {
  totalCases: report.totalCases,
  byCategory: report.byCategory,
  byEvidenceGrade: report.byEvidenceGrade,
  supportedCorrect: report.supportedCorrect,
  insufficientCount: report.insufficientCount,
  dangerousFailures: report.dangerousFailures,
};
console.log(JSON.stringify(publicReport, null, 2));
if (report.failedCases.length || Object.values(report.dangerousFailures).some((count) => count > 0)) process.exitCode = 1;
