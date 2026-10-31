// The final model reports on its own last line whether the supplied evidence
// was sufficient. This module only serializes and reads that explicitly written
// protocol line; it never judges the answer text. A line that cannot be read is
// "unknown", and an unknown status never starts supplementary retrieval.

export const EVIDENCE_STATUSES = Object.freeze(['sufficient', 'insufficient', 'unknown']);

// The status line is requested only while the supplementary round is enabled;
// with the switch off every final prompt stays byte-identical to the prompt
// before this protocol existed. Parsing stays on: an absent line is unknown.
export function evidenceSupplementEnabled(env = {}) {
  return /^(?:1|true|yes|on)$/iu.test(String(env?.EVIDENCE_SUPPLEMENT_ENABLED || '').trim());
}

// Kept free of the substring "中文": localized answer instructions replace it
// with the answer language, while this line must stay byte-identical.
export const EVIDENCE_STATUS_INSTRUCTION = '正文写完后，最后单独一行只写证据状态；这一行只供系统读取，不会展示给玩家，无论回答使用哪种语言都原样使用下列标签。所给卡文、适用的一般规则或条件相符的相关裁定足以支持结论及关键理由时，包括核对适用条件后可以推导结论的情况，写“证据状态：充分”；没有同卡组合的直接问答本身不代表证据不足。确实缺少决定结论所必需的规则或裁定依据，或仍无法核对决定性适用条件时，写“证据状态：不足｜缺少：”，并在冒号后用一句话写明缺的是哪条规则或哪类裁定，不为避免报告不足而猜测或强行下结论。题面没有给出的事实不算资料不足，仍按上文在正文中说明条件分支。这一行之后不要再写任何内容。';

const LABEL = /^证据状态\s*[:：]\s*/u;
const VALUE = /^(充分|不足)[。.]?\s*(?:[|｜]\s*缺少\s*[:：]\s*([\s\S]*))?$/u;

/**
 * Split the protocol line off the model text. Only the last non-empty line is
 * considered. A last line that carries the protocol label is always removed
 * from the displayed text (it is server protocol, not ruling content); its
 * value is read only when it has exactly one of the two documented shapes.
 */
export function extractEvidenceStatusLine(text) {
  const source = typeof text === 'string' ? text : '';
  const body = source.replace(/\s+$/u, '');
  const lineStart = body.lastIndexOf('\n') + 1;
  const line = presentationUnwrapped(body.slice(lineStart));
  if (!LABEL.test(line)) {
    return { text: source, evidenceStatus: 'unknown', evidenceGap: '', evidenceStatusLine: 'absent' };
  }
  const remaining = body.slice(0, lineStart).replace(/\s+$/u, '');
  const value = VALUE.exec(line.replace(LABEL, '').trim());
  if (!value) {
    return { text: remaining, evidenceStatus: 'unknown', evidenceGap: '', evidenceStatusLine: 'malformed' };
  }
  const gap = typeof value[2] === 'string' ? value[2].trim() : '';
  if (value[1] === '充分') {
    return value[2] === undefined
      ? { text: remaining, evidenceStatus: 'sufficient', evidenceGap: '', evidenceStatusLine: 'parsed' }
      : { text: remaining, evidenceStatus: 'unknown', evidenceGap: '', evidenceStatusLine: 'malformed' };
  }
  return { text: remaining, evidenceStatus: 'insufficient', evidenceGap: gap, evidenceStatusLine: 'parsed' };
}

// Markdown writers sometimes wrap a whole line in emphasis, inline code or a
// list/quote marker. These wrappers carry no protocol meaning.
function presentationUnwrapped(line) {
  return String(line || '')
    .replace(/^\s*(?:[>•-]\s*)+/u, '')
    .replace(/[*`]/gu, '')
    .trim();
}
