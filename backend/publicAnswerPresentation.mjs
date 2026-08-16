export const PUBLIC_REQUEST_CHANNELS = Object.freeze({
  WEB: "web",
  EXTERNAL_API: "external_api",
  UNKNOWN: "unknown",
});

export const DEFAULT_AUTHOR_CONTACT_TEXT = "B站 おmaginai，或 QQ 1195362230";

const WEB_REQUEST_KEYS = Object.freeze([
  "mode",
  "question",
  "rulingModelProfile",
  "rulingVersion",
]);

export function classifyPublicRequestChannel(rawBody) {
  const body = parseRequestBodyForPresentation(rawBody);
  if (!isPlainObject(body) || !nonEmptyString(body.question)) {
    return PUBLIC_REQUEST_CHANNELS.UNKNOWN;
  }

  const keys = Object.keys(body).sort();
  if (keys.length === 1 && keys[0] === "question") {
    return PUBLIC_REQUEST_CHANNELS.EXTERNAL_API;
  }
  if (
    sameStringList(keys, WEB_REQUEST_KEYS)
    && body.mode === "rag"
    && nonEmptyString(body.rulingModelProfile)
    && nonEmptyString(body.rulingVersion)
  ) {
    return PUBLIC_REQUEST_CHANNELS.WEB;
  }
  return PUBLIC_REQUEST_CHANNELS.UNKNOWN;
}

export function presentPublicAnswer(answer, {
  channel = PUBLIC_REQUEST_CHANNELS.UNKNOWN,
  env = globalThis.process?.env || {},
} = {}) {
  if (channel !== PUBLIC_REQUEST_CHANNELS.EXTERNAL_API || !isPlainObject(answer)) {
    return answer;
  }
  const notice = String(env.EXTERNAL_API_TEST_NOTICE || "").trim();
  const shortAnswer = typeof answer.shortAnswer === "string" ? answer.shortAnswer : "";
  if (!notice || !shortAnswer.trim() || shortAnswer.includes(notice)) {
    return { ...answer };
  }
  return {
    ...answer,
    shortAnswer: `${shortAnswer}\n\n${notice}`,
  };
}

export function resolveAuthorContactText(env = globalThis.process?.env || {}) {
  const configured = String(env.AUTHOR_CONTACT_TEXT || "").trim();
  return configured || DEFAULT_AUTHOR_CONTACT_TEXT;
}

export function formatAuthorContactSentence(prefix, env = globalThis.process?.env || {}) {
  const normalizedPrefix = String(prefix || "如有需要，请联系作者").trim().replace(/[：:。.!！]+$/gu, "");
  const contact = resolveAuthorContactText(env).replace(/[。.!！]+$/gu, "");
  return `${normalizedPrefix}：${contact}。`;
}

function parseRequestBodyForPresentation(value) {
  let parsed = value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(parsed)) {
    parsed = parsed.toString("utf8");
  } else if (parsed instanceof Uint8Array) {
    parsed = new TextDecoder().decode(parsed);
  }
  if (typeof parsed !== "string") return parsed;
  try {
    return JSON.parse(parsed);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sameStringList(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
