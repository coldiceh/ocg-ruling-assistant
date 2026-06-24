import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runBenchmarkReport } from "./benchmark-report.mjs";

export async function runNoDirectAudit() {
  const report = await runBenchmarkReport();
  return {
    totalCases: report.totalCases,
    totalSubQuestions: report.totalSubQuestions,
    confirmedCount: report.confirmedCount,
    unknownCount: report.unknownCount,
    noDirectEvidenceCount: report.unknownReasons.no_direct_evidence,
    noDirectReasons: report.noDirectReasons,
    unsafeConfirmedCount: report.unsafeConfirmedCount,
    missingReasonCount: report.missingReasonCount,
    audits: report.noDirectEvidenceDiagnostics,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  console.log(JSON.stringify(await runNoDirectAudit(), null, 2));
}
