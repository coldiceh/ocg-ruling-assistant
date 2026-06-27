import { splitCardTextSections } from "./cardTextSections.mjs";

export function buildCardProfile(card = {}) {
  const textSections = splitCardTextSections(card);
  return {
    cardId: String(card.id || card.cardId || card.passcode || ""),
    names: {
      zh: String(card.cnName || card.name || ""),
      ja: String(card.jaName || ""),
      en: String(card.enName || ""),
      aliases: unique([card.name, card.cnName, card.jaName, card.enName, ...(card.aliases || [])]),
    },
    cardType: String(card.cardType || card.type || "unknown"),
    isPendulum: textSections.isPendulum,
    sections: textSections.sections,
    effectIndex: textSections.effectIndex,
    missingSections: textSections.missingSections,
    sourceUrl: String(card.sourceUrl || ""),
  };
}

export function buildCardProfiles(cards = []) {
  return (Array.isArray(cards) ? cards : []).map(buildCardProfile);
}

export function selectRelevantCardSections(profile, issueFrames = [], question = "", maxSections = 10) {
  if (!profile) return [];
  const requested = new Set((issueFrames || []).flatMap((frame) => frame.requiredCardSections || []));
  const effectNo = String(question).match(/[①②③④⑤⑥⑦⑧⑨⑩]/u)?.[0] || "";
  return profile.effectIndex
    .map((entry) => ({
      ...entry,
      score:
        (requested.has(entry.section) ? 20 : 0)
        + (effectNo && entry.effectNo === effectNo ? 30 : 0)
        + (entry.tags || []).filter((tag) => (issueFrames || []).some((frame) => frame.id === tag)).length * 12,
      cardId: profile.cardId,
      cardName: profile.names.zh || profile.names.ja || profile.names.en,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, maxSections);
}

function unique(items) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}
