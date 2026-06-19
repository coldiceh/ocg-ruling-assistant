import { auditRetrieval } from "../backend/engine.mjs";

const question = process.argv.slice(2).join(" ").trim();

if (!question) {
  console.error('Usage: node scripts/debug-retrieval.mjs "玩家问题"');
  process.exitCode = 1;
} else {
  try {
    const audit = await auditRetrieval(question, {
      includeLive: process.env.DEBUG_RETRIEVAL_LIVE !== "false",
      useModel: process.env.DEBUG_RETRIEVAL_USE_MODEL === "true",
      env: process.env,
    });
    console.log(JSON.stringify(audit, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      error: "retrieval_audit_failed",
      message: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exitCode = 1;
  }
}
