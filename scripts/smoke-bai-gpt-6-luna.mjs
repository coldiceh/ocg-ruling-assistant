import { buildEvidenceInputMeasurement, estimateGenerationUpperBoundUsd,
  loadEvidenceGenerationContract, normalizeEvidenceGenerationUsage } from "../backend/evidenceGenerationContract.mjs";
import { createEvidenceGenerationTransport, evidenceGenerationResponseDiagnostic } from "../backend/evidenceGenerationTransport.mjs";
import { buildNavigationRequestBody, normalizeNavigationOutput } from "./prepare-evidence-navigation.mjs";

const checks = [
  ["medium", "navigation"],
];
const maxEstimatedUsd = 0.01;

if (!process.env.BAI_API_KEY) throw new Error("bai_smoke_key_missing");

const prepared = await Promise.all(checks.map(async ([effort, stage]) => {
  const profileUrl = new URL(`../config/evidence-generation/bai-gpt-6-luna-${effort}-theoretical.json`, import.meta.url);
  const contract = loadEvidenceGenerationContract(stage, { profileUrl });
  const transport = createEvidenceGenerationTransport({ contract });
  const wire = transport.prepareRequest(buildNavigationRequestBody({ input: {
    sourceKind: "rule", titlePath: ["步骤说明"], unitText: "先完成步骤甲，再执行步骤乙；若甲未完成，不执行乙。",
    structuralContextTexts: [],
  } }, contract));
  const measurement = await buildEvidenceInputMeasurement({ body: wire, contract });
  const reservation = estimateGenerationUpperBoundUsd({ measurement, contract });
  return { effort, contract, transport, wire, measurement, reservation };
}));

const estimatedUsd = prepared.reduce((total, item) => total + item.reservation.amountUsd, 0);
if (estimatedUsd > maxEstimatedUsd) throw new Error("bai_smoke_budget_exceeded");
console.log(JSON.stringify({ kind: "bai-gpt-6-luna-smoke-budget", requestCount: prepared.length,
  estimatedUsd, maxEstimatedUsd, basis: prepared[0].reservation.basis }));

let failures = 0;
for (const item of prepared) {
  try {
    const raw = await item.transport.invoke(item.wire, {
      measurement: item.measurement,
      signal: AbortSignal.timeout(45_000),
    });
    item.transport.validateResponse(raw);
    normalizeNavigationOutput(item.transport.extractText(raw));
    const normalized = normalizeEvidenceGenerationUsage(item.transport.rawUsage(raw), item.contract);
    if (normalized.usageNormalization.status !== "complete") throw new Error("bai_smoke_usage_incomplete");
    console.log(JSON.stringify({ kind: "bai-gpt-6-luna-smoke-result", effort: item.effort,
      success: true, ...evidenceGenerationResponseDiagnostic(raw),
      estimatedUsd: item.reservation.amountUsd,
      calculatedUsd: normalized.billableCost.amountUsd,
      priceVersion: item.contract.priceVersion }));
  } catch (error) {
    failures += 1;
    console.error(JSON.stringify({ kind: "bai-gpt-6-luna-smoke-result", effort: item.effort,
      success: false, errorCode: /^[a-z0-9_:-]+$/u.test(error?.message || "") ? error.message : "request_failed",
      httpStatus: Number.isInteger(error?.status) ? error.status : null,
      ...(error?.responseDiagnostic || {}) }));
  }
}
if (failures) process.exitCode = 1;
