// Reads the model's reply text from a Responses API payload.
//
// GPT-6 can return a `phase: "commentary"` message before the
// `phase: "final_answer"` message, both with output_text. Only the final answer
// is the reply; joining every message duplicated structured JSON output (two
// identical objects back to back) and made strict parsing fail. This is a
// protocol field, not a judgement about the content.
//
// When any message carries phase "final_answer", only those messages are read.
// Otherwise every message except explicit commentary is read, which keeps the
// previous behaviour for payloads that do not label phases.
export function responsesOutputText(payload, { separator = "" } = {}) {
  const messages = (Array.isArray(payload?.output) ? payload.output : [])
    .filter((item) => item?.type === "message");
  const finalAnswers = messages.filter((item) => item?.phase === "final_answer");
  const chosen = finalAnswers.length
    ? finalAnswers
    : messages.filter((item) => item?.phase !== "commentary");
  return chosen
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(separator);
}
