import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeCloudEvidencePreprocessLedger } from "./lib/evidence-preprocess-cloud.mjs";

export async function setupCloudEvidencePreprocessLedger({ ledgerPath, env = process.env, fetchImpl } = {}) {
  if (!ledgerPath) throw codedError("evidence_preprocess_ledger_path_required", 2);
  const ledger = JSON.parse(await readFile(resolve(ledgerPath), "utf8"));
  const result = await initializeCloudEvidencePreprocessLedger({ env, ledger, fetchImpl });
  return {
    status: result.status,
    limitUsd: result.ledger.limitUsd,
    spentUsd: result.ledger.spentUsd,
    reservedUsd: result.ledger.reservedUsd,
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "--ledger") throw codedError("usage: --ledger <authorized-ledger.json>", 2);
  const result = await setupCloudEvidencePreprocessLedger({ ledgerPath: argv[1] });
  console.log(JSON.stringify(result));
}

function codedError(message, exitCode) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = error?.exitCode || 1;
  });
}
