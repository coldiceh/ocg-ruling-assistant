const QUOTED_NAME = /[「『“"]([^「」『』“”"]{1,80})[」』”"]/gu;
const PRINTED_TEXT_COMPLEMENT = /(?:效果文本框|效果文本栏|效果文本|卡面|印刷文本|印刷文字|テキスト欄|カードテキスト|printed\s+(?:effect\s+)?text)[^，,。；;!?？]{0,32}?(?:记载|记述|記載|記述|mention)(?:有|了)?([^，,。；;!?？]{0,120})/iu;
const PRINTED_REFERENCE_REQUIREMENT_PATTERNS = Object.freeze([
  /有\s*[「『“"]([^「」『』“”"]{1,80})[」』”"]\s*(?:这个|该)?卡名(?:的)?(?:记载|记述|記載|記述)/iu,
  /(?:记载|记述|記載|記述)(?:有|了)?\s*[「『“"]([^「」『』“”"]{1,80})[」』”"]\s*(?:这个|该)?卡名/iu,
  /[「『“"]([^「」『』“”"]{1,80})[」』”"]\s*(?:这个|该)?卡名(?:的)?(?:记载|记述|記載|記述)/iu,
  /(?:mentions?|lists?|specifically lists?)\s+[「『“"]?([^「」『』“”",.;:]{2,80})[」』”"]?\s+(?:in (?:its|the) card text|as a card name)/iu,
]);
const COPY_NAME_AND_EFFECT_PATTERN = /(?:获得|得到|复制|拷贝|適用|得る|コピー|copy|gain).{0,100}(?:原本|original)?.{0,16}(?:卡名|カード名|name).{0,100}(?:效果|効果|effect)|(?:卡名|カード名|name).{0,60}(?:效果|効果|effect).{0,80}(?:相同|同じ|same)/isu;
const COPY_SCENARIO_PATTERN = /(?:获得|得到|复制|拷贝|コピー|copy|gain).{0,120}(?:卡名|カード名|name|效果|効果|effect)|(?:卡名|カード名|name).{0,80}(?:效果|効果|effect).{0,80}(?:相同|同じ|same)/isu;

export function extractPrintedNameReferences(effectText = "") {
  const references = [];
  for (const match of String(effectText || "").matchAll(QUOTED_NAME)) {
    const name = cleanName(match[1]);
    if (name) references.push(name);
  }
  return uniqueBy(references, normalizeName);
}

export function extractPrintedReferenceRequirement(value = "") {
  const text = String(value || "");
  const printedComplement = text.match(PRINTED_TEXT_COMPLEMENT)?.[1] || "";
  if (printedComplement) {
    const complements = extractPrintedNameReferences(printedComplement);
    if (complements.length === 1) return complements[0];
    if (complements.length > 1) return "";
  }
  for (const pattern of PRINTED_REFERENCE_REQUIREMENT_PATTERNS) {
    const match = text.match(pattern);
    const requiredName = cleanName(match?.[1]);
    if (requiredName) return requiredName;
  }
  return "";
}

export function analyzePrintedTextReferenceScenario({
  userQuery = "",
  cardTexts = [],
} = {}) {
  const requiredName = extractPrintedReferenceRequirement(userQuery);
  const normalizedRequiredName = normalizeName(requiredName);
  const cards = (cardTexts || [])
    .map((item, index) => normalizeCardTextRecord(item, index))
    .filter((item) => item.text);
  const copyReceivers = cards.filter((item) => COPY_NAME_AND_EFFECT_PATTERN.test(item.text));
  const copyScenarioMentioned = COPY_SCENARIO_PATTERN.test(String(userQuery || ""));
  const activationAsked = /(?:能否|是否|可不可以|可以|能不能).{0,20}(?:发动|發動|発動|activate)|(?:发动|發動|発動|activate).{0,20}(?:吗|嗎|能否|是否|can)/iu.test(String(userQuery || ""));
  const receiversWithPrintedReference = normalizedRequiredName
    ? copyReceivers.filter((item) => item.printedNameReferences.some((name) => normalizeName(name) === normalizedRequiredName))
    : [];

  return {
    requiredName,
    normalizedRequiredName,
    cards,
    copyReceivers,
    receiversWithPrintedReference,
    copyScenarioMentioned,
    activationAsked,
    copiedTextDoesNotRewritePrintedReferences: Boolean(
      requiredName
      && copyScenarioMentioned
      && copyReceivers.length
      && receiversWithPrintedReference.length === 0
    ),
    activationBlocked: Boolean(
      requiredName
      && copyScenarioMentioned
      && activationAsked
      && copyReceivers.length
      && receiversWithPrintedReference.length === 0
    ),
  };
}

export function isPrintedTextReferenceRule(value = "") {
  const text = String(value || "");
  return /有[「『“"]?○○[」』”"]?卡名(?:记载|记述)|效果文本栏中记述作为卡名存在|not as (?:a )?card name|カード名が記された/iu.test(text)
    && /(?:满足条件|不满足条件|指的是|means?|カード名)/iu.test(text);
}

export function selectPrintedTextReferenceRuleQuote(value = "") {
  const text = String(value || "").replace(/\r\n?/gu, "\n").trim();
  if (!text) return "";
  const headingIndex = text.search(/有[「『“"]?○○[」』”"]?卡名(?:记载|记述)/u);
  const basisIndex = text.search(/这类文本指的是，效果文本栏中记述作为卡名存在/u);
  const start = headingIndex >= 0 ? headingIndex : basisIndex;
  if (start < 0) return "";
  const tail = text.slice(start);
  const endMarker = tail.search(/\n\s*(?:例：|例:|咒文速度|阶段·步骤·时点)/u);
  return cleanText((endMarker > 0 ? tail.slice(0, endMarker) : tail).slice(0, 800));
}

function normalizeCardTextRecord(item = {}, index = 0) {
  const text = String(item.text || item.effectText || item.conclusion || "");
  return {
    ...item,
    id: String(item.id || item.evidenceId || item.cardId || `card-text-${index + 1}`),
    title: String(item.title || item.cardName || (item.cards || [])[0] || item.name || "卡片文本"),
    text,
    printedNameReferences: extractPrintedNameReferences(text),
  };
}

function cleanName(value) {
  return String(value || "").normalize("NFKC").trim().replace(/^[\s「」『』“”"]+|[\s「」『』“”"]+$/gu, "");
}

function normalizeName(value) {
  return cleanName(value)
    .toLowerCase()
    .replace(/[の之的]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}
