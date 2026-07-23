import { answerRagRulingQuestion as answerLatestRagRulingQuestion } from "./ragRulingPipeline.mjs";

export const DEFAULT_RULING_VERSION = "latest";
export const PREVIOUS_RULING_REVISION = "4d95ecc96";

export const RULING_VERSIONS = Object.freeze([
  Object.freeze({ id: "latest", label: "最新版", revision: null }),
  Object.freeze({ id: "previous", label: "上一版", revision: PREVIOUS_RULING_REVISION }),
]);

let previousPipelinePromise;

export class InvalidRulingVersionError extends Error {
  constructor(value) {
    const requested = String(value ?? "").trim();
    super(`Unsupported rulingVersion: ${requested || "(empty)"}`);
    this.name = "InvalidRulingVersionError";
    this.code = "invalid_ruling_version";
    this.statusCode = 400;
    this.requestedRulingVersion = requested;
  }
}

export function getRulingVersionCapabilities() {
  return {
    defaultRulingVersion: DEFAULT_RULING_VERSION,
    rulingVersions: RULING_VERSIONS.map((version) => ({ ...version })),
  };
}

export function normalizeRequestedRulingVersion(value) {
  if (value === undefined || value === null) {
    return DEFAULT_RULING_VERSION;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!RULING_VERSIONS.some((version) => version.id === normalized)) {
    throw new InvalidRulingVersionError(value);
  }
  return normalized;
}

export async function resolveRulingVersionPipeline(value) {
  const requestedRulingVersion = normalizeRequestedRulingVersion(value);
  if (requestedRulingVersion === "latest") {
    return {
      requestedRulingVersion,
      effectiveRulingVersion: "latest",
      answerRagRulingQuestion: answerLatestRagRulingQuestion,
    };
  }

  const previousModule = await loadPreviousPipeline();
  if (typeof previousModule.answerRagRulingQuestion !== "function") {
    throw new TypeError(
      `Previous ruling pipeline ${PREVIOUS_RULING_REVISION} does not export answerRagRulingQuestion`,
    );
  }
  return {
    requestedRulingVersion,
    effectiveRulingVersion: "previous",
    answerRagRulingQuestion: previousModule.answerRagRulingQuestion,
  };
}

export async function answerRagRulingQuestionForVersion({
  rulingVersion,
  ...options
} = {}) {
  const resolved = await resolveRulingVersionPipeline(rulingVersion);
  const answer = await resolved.answerRagRulingQuestion(options);
  return {
    ...answer,
    requestedRulingVersion: resolved.requestedRulingVersion,
    effectiveRulingVersion: resolved.effectiveRulingVersion,
    rulingVersion: resolved.effectiveRulingVersion,
  };
}

function loadPreviousPipeline() {
  previousPipelinePromise ||= import("./versions/4d95ecc96/ragRulingPipeline.mjs");
  return previousPipelinePromise;
}
