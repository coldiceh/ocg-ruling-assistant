import { answerRagRulingQuestion as answerLatestRagRulingQuestion } from "./ragRulingPipeline.mjs";

export const DEFAULT_RULING_VERSION = "latest";

export const RULING_VERSIONS = Object.freeze([
  Object.freeze({ id: "latest", label: "最新版", revision: null, legacyCompatibility: false }),
]);

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
  return {
    requestedRulingVersion,
    effectiveRulingVersion: "latest",
    legacyCompatibility: false,
    versionWarnings: [],
    answerRagRulingQuestion: answerLatestRagRulingQuestion,
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
    legacyCompatibility: resolved.legacyCompatibility,
    versionWarnings: [...resolved.versionWarnings],
  };
}

export async function answerExactOfficialQaQuestionForVersion({
  rulingVersion,
  ...options
} = {}) {
  const resolved = await resolveRulingVersionPipeline(rulingVersion);
  const answer = await resolved.answerRagRulingQuestion({
    ...options,
    officialQaExactOnly: true,
  });
  if (!answer) return null;
  return {
    ...answer,
    requestedRulingVersion: resolved.requestedRulingVersion,
    effectiveRulingVersion: resolved.effectiveRulingVersion,
    rulingVersion: resolved.effectiveRulingVersion,
    legacyCompatibility: resolved.legacyCompatibility,
    versionWarnings: [...resolved.versionWarnings],
  };
}
