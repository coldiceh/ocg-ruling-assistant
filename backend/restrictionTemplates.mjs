const defaultRegistry = new Map();

export function createRestrictionTemplateRegistry(templates = []) {
  const registry = new Map();
  for (const template of templates) registerRestrictionTemplate(template, registry);
  return registry;
}

export function registerRestrictionTemplate(template, registry = defaultRegistry) {
  const normalized = normalizeTemplate(template);
  registry.set(templateKey(normalized.cardId, normalized.effectNo), normalized);
  return normalized;
}

export function getRestrictionTemplate({ cardId, effectNo }, registry = defaultRegistry) {
  return registry.get(templateKey(cardId, effectNo)) || null;
}

export function generateActiveRestriction({
  cardId,
  effectNo,
  sourceCard,
  activatedAt = null,
  duration,
  overrides = {},
} = {}, registry = defaultRegistry) {
  const template = getRestrictionTemplate({ cardId, effectNo }, registry);
  if (!template) return null;
  const generated = {
    ...clone(template.createsRestriction),
    ...clone(overrides),
    sourceCard: sourceCard || template.sourceCard || String(cardId),
    sourceCardId: String(cardId),
    effectNo: String(effectNo),
    duration: duration || overrides.duration || template.createsRestriction.duration || "this_turn",
    generatedFromTemplate: template.id,
  };
  if (activatedAt !== null) generated.activatedAt = clone(activatedAt);
  return generated;
}

export function clearDefaultRestrictionTemplates() {
  defaultRegistry.clear();
}

function normalizeTemplate(template = {}) {
  const cardId = String(template.cardId || "").trim();
  const effectNo = String(template.effectNo || "").trim();
  if (!cardId) throw new TypeError("restriction template cardId is required");
  if (!effectNo) throw new TypeError("restriction template effectNo is required");
  if (!template.createsRestriction || typeof template.createsRestriction !== "object") {
    throw new TypeError("restriction template createsRestriction is required");
  }
  if (!template.createsRestriction.restrictionType) {
    throw new TypeError("createsRestriction.restrictionType is required");
  }
  return {
    id: template.id || `restriction_template:${cardId}:${effectNo}`,
    cardId,
    effectNo,
    sourceCard: template.sourceCard || "",
    createsRestriction: clone(template.createsRestriction),
  };
}

function templateKey(cardId, effectNo) {
  return `${String(cardId || "").trim()}:${String(effectNo || "").trim()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
