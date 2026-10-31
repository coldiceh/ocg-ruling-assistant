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
  if (isPlainObject(body) && body.action === "finalize"
    && sameStringList(Object.keys(body).sort(), ["action", "preparationId"])
    && typeof body.preparationId === "string" && /^[0-9a-f]{64}$/u.test(body.preparationId)) {
    return PUBLIC_REQUEST_CHANNELS.WEB;
  }
  if (isPlainObject(body) && body.action === "translate_source"
      && sameStringList(Object.keys(body).sort(), ["action", "sourceId", "sourceSnapshotId", "targetLocale"])
      && typeof body.sourceSnapshotId === "string" && /^[0-9a-f]{64}$/u.test(body.sourceSnapshotId)) {
    return PUBLIC_REQUEST_CHANNELS.WEB;
  }
  if (!isPlainObject(body) || !nonEmptyString(body.question)) {
    return PUBLIC_REQUEST_CHANNELS.UNKNOWN;
  }

  const keys = Object.keys(body).sort();
  if (keys.length === 1 && keys[0] === "question") {
    return PUBLIC_REQUEST_CHANNELS.EXTERNAL_API;
  }
  // evidenceSelector is optional on the web page; so is engineOnly (仅引擎复现) on a prepare request.
  const webKeys = keys.filter((key) => key !== "evidenceSelector"
    && !(key === "engineOnly" && body.action === "prepare" && body.engineOnly === true));
  if (
    (sameStringList(webKeys, WEB_REQUEST_KEYS)
      || sameStringList(webKeys, [...WEB_REQUEST_KEYS, "answerLocale"].sort())
      || (body.action === "prepare" && (
        sameStringList(webKeys, ["action", ...WEB_REQUEST_KEYS])
        || sameStringList(webKeys, ["action", ...WEB_REQUEST_KEYS, "answerLocale"].sort())
      )))
    && body.mode === "rag"
    && nonEmptyString(body.rulingModelProfile)
    && nonEmptyString(body.rulingVersion)
    && (body.answerLocale === undefined || ["zh-CN", "en", "ja"].includes(body.answerLocale))
    && (body.evidenceSelector === undefined || ["decisions", "luna"].includes(body.evidenceSelector))
  ) {
    return PUBLIC_REQUEST_CHANNELS.WEB;
  }
  return PUBLIC_REQUEST_CHANNELS.UNKNOWN;
}

// One plain sentence for the reader when the server ran the single
// supplementary retrieval round (ragRulingPipeline/evidenceSupplementRound).
// It follows the server-owned round status and the final model's explicit gap,
// never a judgement of the answer text. The answer itself remains visible.
const EVIDENCE_SUPPLEMENT_NOTES = Object.freeze({
  applied: Object.freeze({
    "zh-CN": "（首轮证据不足，已补充检索一次）",
    en: "(The first round found the evidence insufficient; one supplementary search was run.)",
    ja: "（初回の根拠が不足していたため、追加検索を1回行いました）",
  }),
  noNewEvidence: Object.freeze({
    "zh-CN": "（首轮证据不足，已补充检索一次，但未补入可用依据，以上仍为首轮回答）",
    en: "(The first round found the evidence insufficient; one supplementary search added no usable evidence, so the answer above is the first-round answer.)",
    ja: "（初回の根拠が不足していたため追加検索を1回行いましたが、使える根拠を追加できなかったため、上記は初回の回答です）",
  }),
  failed: Object.freeze({
    "zh-CN": "（首轮证据不足，补充检索或重新作答未能完成，以上仍为首轮回答）",
    en: "(The first round found the evidence insufficient; the supplementary search or revised answer could not be completed, so the answer above is the first-round answer.)",
    ja: "（初回の根拠が不足していましたが、追加検索または再回答を完了できなかったため、上記は初回の回答です）",
  }),
  notStarted: Object.freeze({
    "zh-CN": "（首轮证据不足，剩余时间不足以启动补充检索，以上仍为首轮回答）",
    en: "(The first round found the evidence insufficient; there was not enough time to start a supplementary search, so the answer above is the first-round answer.)",
    ja: "（初回の根拠が不足していましたが、残り時間が足りず追加検索を開始しなかったため、上記は初回の回答です）",
  }),
  timedOut: Object.freeze({
    "zh-CN": "（首轮证据不足，补充检索因时间限制中止，以上仍为首轮回答）",
    en: "(The first round found the evidence insufficient; the supplementary search was stopped by the time limit, so the answer above is the first-round answer.)",
    ja: "（初回の根拠が不足していましたが、追加検索は時間制限により中止したため、上記は初回の回答です）",
  }),
  cancelled: Object.freeze({
    "zh-CN": "（首轮证据不足，补充检索因请求中断而中止，以上仍为首轮回答）",
    en: "(The first round found the evidence insufficient; the supplementary search was stopped because the request was interrupted, so the answer above is the first-round answer.)",
    ja: "（初回の根拠が不足していましたが、追加検索はリクエストの中断により中止したため、上記は初回の回答です）",
  }),
});

export function evidenceSupplementNote(answer) {
  const supplement = answer?.debug?.evidenceSupplement;
  const status = supplement?.status;
  const kind = status === "applied" ? "applied"
    : status === "cancelled" ? "cancelled"
    : status === "failed" && supplement?.failureReason === "deadline_exceeded" ? "timedOut"
    : status === "failed" ? "failed"
    : status === "no_new_evidence" ? "noNewEvidence"
    : status === "skipped" && supplement?.skipReason === "skipped_time_budget" ? "notStarted" : "";
  if (!kind) return "";
  const locale = answer?.answerLocale === "en" || answer?.answerLocale === "ja" ? answer.answerLocale : "zh-CN";
  if (kind === "applied" && supplement?.finalModel?.evidenceStatus === "insufficient") {
    const gap = typeof supplement.finalModel.evidenceGap === "string"
      ? supplement.finalModel.evidenceGap.replace(/\s+/gu, " ").trim() : "";
    if (locale === "en") return `(One supplementary search was run; ${gap ? `evidence still missing: ${gap}` : "the answer still identifies an evidence gap"}.)`;
    if (locale === "ja") return `（追加検索を1回行いましたが、${gap ? `まだ不足している根拠：${gap}` : "回答では根拠の不足が残るとしています"}）`;
    return `（已补充检索一次；${gap ? `仍缺少的依据：${gap}` : "补查后仍有依据缺口"}）`;
  }
  return EVIDENCE_SUPPLEMENT_NOTES[kind][locale];
}

export function presentPublicAnswer(answer, {
  channel = PUBLIC_REQUEST_CHANNELS.UNKNOWN,
  env = globalThis.process?.env || {},
} = {}) {
  if (channel === PUBLIC_REQUEST_CHANNELS.WEB && isPlainObject(answer)) {
    const footer = answer.generation?.embeddedInAnswerText === true
      ? String(answer.generation.answerTextFooter || "") : "";
    const shortAnswer = typeof answer.shortAnswer === "string" ? answer.shortAnswer : "";
    const body = footer && shortAnswer.endsWith(footer) ? shortAnswer.slice(0, -footer.length) : shortAnswer;
    const note = evidenceSupplementNote(answer);
    const shown = note && body.trim() && !body.includes(note) ? `${body}\n\n${note}` : body;
    return shown === shortAnswer ? answer : { ...answer, shortAnswer: shown };
  }
  if (channel !== PUBLIC_REQUEST_CHANNELS.EXTERNAL_API || !isPlainObject(answer)) {
    return answer;
  }
  const shortAnswer = typeof answer.shortAnswer === "string" ? answer.shortAnswer : "";
  const notice = [
    evidenceSupplementNote(answer),
    String(env.EXTERNAL_API_TEST_NOTICE || "").trim(),
    "网页端体验完整内容：https://coldiceh.github.io/ocg-ruling-assistant/",
  ].filter((text) => text && !shortAnswer.includes(text)).join("\n");
  if (!notice || !shortAnswer.trim()) {
    return { ...answer };
  }
  const answerTextFooter = answer.generation?.embeddedInAnswerText === true
    ? String(answer.generation.answerTextFooter || "")
    : "";
  if (answerTextFooter && shortAnswer.endsWith(answerTextFooter)) {
    return {
      ...answer,
      shortAnswer: `${shortAnswer.slice(0, -answerTextFooter.length)}\n\n${notice}${answerTextFooter}`,
    };
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
