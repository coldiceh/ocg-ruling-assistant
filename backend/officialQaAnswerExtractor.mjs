import { classifyOfficialQaQuestionType } from "./officialQaMatcher.mjs";

export function extractOfficialQaAnswer(record = {}, { questionType } = {}) {
  const type = questionType || classifyOfficialQaQuestionType(record.question || record.title || record.text || "");
  const answerText = extractAnswerText(record);
  const polarity = detectPolarity(answerText);
  const subject = type === "who_can_activate" ? detectActivationSubject(answerText) : null;
  const verdict = detectOfficialVerdict(type, answerText, polarity, subject);
  const explicit = Boolean(answerText) && (verdict !== "unknown" || hasExplicitResolutionStatement(answerText));
  return {
    evidenceId: String(record.id || "unknown"),
    questionType: type,
    answerText,
    verdict: verdict === "unknown" && explicit ? "official_answer" : verdict,
    subject,
    polarity,
    explicit,
    warnings: explicit ? [] : [answerText ? "answer_does_not_explicitly_resolve_question" : "answer_text_missing"],
  };
}

export function extractAnswerText(record = {}) {
  if (record.answer) return clean(record.answer);
  if (record.officialAnswer) return clean(record.officialAnswer);
  const text = clean(record.text || record.conclusion || record.officialText || "");
  if (!text) return "";
  const question = clean(record.question || "");
  if (question) {
    const index = text.indexOf(question);
    if (index >= 0) return clean(text.slice(index + question.length));
  }
  const questionEnd = Math.max(text.lastIndexOf("?"), text.lastIndexOf("？"));
  if (questionEnd >= 0) {
    const tail = text.slice(questionEnd + 1);
    const marker = findAnswerMarker(tail);
    return clean(marker >= 0 ? tail.slice(marker) : tail);
  }
  return clean(record.conclusion || text);
}

function detectOfficialVerdict(type, text, polarity, subject) {
  if (!text) return "unknown";
  if (type === "who_can_activate") {
    if (polarity === "negative") return "cannot_activate";
    if (subject === "self") return "self_can_activate";
    if (subject === "opponent") return "opponent_can_activate";
    if (subject === "current_controller") return "current_controller_can_activate";
    return polarity === "positive" ? "controller_can_activate" : "unknown";
  }
  if (type === "target_legality") return polarity === "negative" ? "illegal_target" : polarity === "positive" ? "legal_target" : "unknown";
  if (["can_activate", "timing_window"].includes(type)) return polarity === "negative" ? "cannot_activate" : polarity === "positive" ? "can_activate" : "unknown";
  if (type === "card_activation_vs_effect_activation") {
    if (/只能.*卡的发动|カードの発動のみ|card activation only/iu.test(text)) return "card_activation_only";
    if (/效果也.*发动|効果も発動|effect can also be activated/iu.test(text)) return "card_and_effect_can_activate";
  }
  if (type === "copy_effect_procedure") {
    if (/对象.*发动时|発動時.*対象|choose.*target.*activation/iu.test(text)) return "choose_target_on_copied_effect_activation";
    if (polarity === "positive") return "can_copy_effect";
    if (polarity === "negative") return "cannot_copy_effect";
  }
  if (type === "continuous_effect_during_resolution" && /处理(?:完毕|结束)后|処理後|after.*resol/iu.test(text)) return "applies_after_current_resolution";
  return "unknown";
}

function detectPolarity(text) {
  if (/不能|不可以|无法|できません|発動できない|cannot|can't|may not|no[,. ]/iu.test(text)) return "negative";
  if (/可以|能够|能发动|できます|発動できる|can |may |yes[,. ]/iu.test(text)) return "positive";
  return "unknown";
}

function detectActivationSubject(text) {
  if (/自己(?:可以|能).*发动|自分(?:が|は).*発動|you can activate|the player who controls.*can/iu.test(text)) return "self";
  if (/对方(?:可以|能).*发动|相手(?:が|は).*発動|your opponent can|the opponent can/iu.test(text)) return "opponent";
  if (/当时的控制者|当前控制者|その時点.*コントローラー|current controller|controller at that time/iu.test(text)) return "current_controller";
  return null;
}

function hasExplicitResolutionStatement(text) {
  return /处理|适用|返回|送去|除外|破坏|发动|処理|適用|戻|墓地|除外|破壊|発動|resolve|apply|return|send|banish|destroy|activate/iu.test(text);
}

function findAnswerMarker(text) {
  const match = /(?:^|\s)(?:可以|不可以|不能|自己|对方|当时的控制者|はい|いいえ|自分|相手|その時点|できます|できません|Yes\b|No\b|It can|It cannot|They can|They cannot|You can|You cannot|The current controller)/iu.exec(text);
  return match?.index ?? -1;
}

function clean(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}
