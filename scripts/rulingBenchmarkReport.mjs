import { runRulingBenchmark } from "../backend/rulingBenchmark.mjs";
import { runOfficialQa100Benchmark } from "../backend/officialQa100Benchmark.mjs";

const [legacyReport, report] = await Promise.all([
  runRulingBenchmark(),
  runOfficialQa100Benchmark(),
]);
const publicReport = {
  totalCases: report.totalCases,
  categoryCounts: report.categoryCounts,
  routeCounts: report.routeCounts,
  correctByRoute: report.correctByRoute,
  insufficientCount: report.insufficientCount,
  conditionalCount: report.conditionalCount,
  officialExactCorrect: report.officialExactCorrect,
  officialNearCorrect: report.officialNearCorrect,
  templateCorrect: report.templateCorrect,
  dangerousFailures: report.dangerousFailures,
  topFailureReasons: report.topFailureReasons,
  legacyBenchmark: {
    totalCases: legacyReport.totalCases,
    supportedCorrect: legacyReport.supportedCorrect,
    insufficientCount: legacyReport.insufficientCount,
    dangerousFailures: legacyReport.dangerousFailures,
  },
};
console.log(JSON.stringify(publicReport, null, 2));
if (report.failedCases.length
  || legacyReport.failedCases.length
  || Object.values(report.dangerousFailures).some((count) => count > 0)
  || Object.values(legacyReport.dangerousFailures).some((count) => count > 0)) process.exitCode = 1;
