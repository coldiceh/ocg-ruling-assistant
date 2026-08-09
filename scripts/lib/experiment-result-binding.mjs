import { createHash } from "node:crypto";

/**
 * Preserve model text byte-for-byte. Structured outputs use the same stable
 * representation already persisted by JSON reports. A missing or
 * unserializable output makes the result binding unavailable instead of
 * fabricating a digest for JSON null.
 */
export function serializeExperimentRawOutput(rawOutput) {
  if (typeof rawOutput === "string") return rawOutput;
  const serialized = JSON.stringify(rawOutput);
  if (serialized === undefined) {
    throw new TypeError("experiment raw output is not JSON serializable");
  }
  return serialized;
}

export function hashExperimentRawOutput(rawOutput) {
  return createHash("sha256")
    .update(serializeExperimentRawOutput(rawOutput), "utf8")
    .digest("hex");
}

export function createExperimentResultBinding(result = {}) {
  const source = result && typeof result === "object" ? result : {};
  const resultKey = nonEmptyString(source.key);
  const finalInputSha256 = nonEmptyString(source.finalInputSha256);
  const requestId = source.requestId === null || source.requestId === undefined
    ? null
    : nonEmptyString(source.requestId);
  const unavailableReasons = [];
  if (!resultKey) unavailableReasons.push("result_key_missing");
  if (source.requestId !== null && source.requestId !== undefined && !requestId) {
    unavailableReasons.push("request_id_invalid");
  }
  if (!finalInputSha256) unavailableReasons.push("final_input_sha256_missing");

  let rawOutputSha256 = null;
  if (!Object.hasOwn(source, "rawOutput")) {
    unavailableReasons.push("raw_output_missing");
  } else {
    try {
      rawOutputSha256 = hashExperimentRawOutput(source.rawOutput);
    } catch {
      unavailableReasons.push("raw_output_unserializable");
    }
  }

  return Object.freeze({
    status: unavailableReasons.length === 0 ? "bound" : "unavailable",
    resultKey,
    requestId,
    finalInputSha256,
    rawOutputSha256: unavailableReasons.length === 0 ? rawOutputSha256 : null,
    unavailableReasons: Object.freeze(unavailableReasons),
  });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}
