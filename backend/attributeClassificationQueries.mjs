// These are retrieval questions, not rulings or a claim that an effect is
// currently applying. Only the original question and card text can trigger
// them; card names, identifiers and retrieved Q&A never do.
const MULTIPLE_ATTRIBUTE_CUES = [
  /(?:多(?:重|种|種|个|個)?|复数|複数|複數)(?:の|的)?(?:属性|屬性)/u,
  /(?:全部|所有|全ての|すべての|全)(?:属性|屬性)/u,
  /(?:也|还|還|亦)(?:当作|當作|作为|作為|视为|視為)[^。！？\n]{0,100}(?:属性|屬性)/u,
  /(?:属性|屬性)[^。！？\n]{0,100}(?:としても扱[いうわ]|(?:也|还|還|亦)(?:当作|當作|作为|作為|视为|視為))/u,
  /(?:追加|额外|額外)(?:的)?(?:属性|屬性)/u,
  /\b(?:multi[ -]?attributes?|multiple attributes|several attributes|all attributes|more than one attribute|additional attributes?)\b/iu,
  /\b(?:has|have|having|with)\s+(?:two|three|four|five|six|seven|[2-7])(?:\s+different)?\s+attributes?\b/iu,
  /\balso\s+(?:treated|regarded|considered|counts?)\s+as\b[^.!?\n]{0,100}\battributes?\b/iu,
  /\balso\s+(?:LIGHT|DARK|EARTH|WATER|FIRE|WIND|DIVINE)[ -]+attributes?\b/iu,
  /\balso\s+(?:treated|regarded|considered|counts?)\s+as\s+(?:LIGHT|DARK|EARTH|WATER|FIRE|WIND|DIVINE)(?:\s*[,/&]\s*|\s+and\s+)(?:LIGHT|DARK|EARTH|WATER|FIRE|WIND|DIVINE)\b/iu,
];

const CLASSIFICATION_QUERIES = Object.freeze([
  ['zh', '具有多个属性的怪兽，是否也属于其中某一属性以外的怪兽？'],
  ['ja', '複数の属性を持つモンスターは、そのうちの属性以外のモンスターにも該当しますか？'],
]);
const queryKey = text => String(text || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');

export function attributeClassificationQueryReleaseInfo(env = {}) {
  return { enabled: !/^(?:0|false|off|no)$/iu.test(String(env.ATTRIBUTE_CLASSIFICATION_QUERY_ENABLED ?? '').trim()),
    contract: 'local-multi-attribute-v1', transport: 'local-only' };
}

export function buildAttributeClassificationQueries({ question = '', confirmedCards = [], cardTexts = [] } = {},
  { env = {}, existingQueries = [] } = {}) {
  if (!attributeClassificationQueryReleaseInfo(env).enabled) return null;
  const sources = [['question', question]];
  for (const [label, records] of [['confirmedCards', confirmedCards], ['cardTexts', cardTexts]]) {
    for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
      for (const field of ['effectText', 'text', 'cardText', 'pendulumEffectText']) {
        if (typeof record?.[field] === 'string') sources.push([`${label}[${index}].${field}`, record[field]]);
      }
    }
  }
  const triggerSources = sources.filter(([, text]) => typeof text === 'string'
    && MULTIPLE_ATTRIBUTE_CUES.some(pattern => pattern.test(text.normalize('NFKC')))).map(([source]) => source);
  if (!triggerSources.length) return null;
  const existing = new Set(existingQueries.map(query => queryKey(typeof query === 'string' ? query : query?.text)));
  const queries = CLASSIFICATION_QUERIES.filter(([, text]) => !existing.has(queryKey(text)))
    .map(([language, text]) => ({ needId: 'attribute_classification',
      queryVariantId: `attribute_classification.${language}`, text, localOnly: true }));
  return { triggerSources, queries };
}
