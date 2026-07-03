import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EFFECT_PRIMITIVE_TYPES,
  RESOLUTION_CONNECTORS,
  createEffectPrimitive,
  normalizePrimitiveSequence,
} from "./effectPrimitives.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const defaultEffectTemplateDir = join(projectRoot, "data", "effect-templates");
const registryCache = new Map();
const allowedTemplateKeys = new Set([
  "id", "cardId", "name", "effectNo", "activation", "sourceExpectedZone",
  "primitiveSequence", "createsRestrictions",
]);
const allowedActivationKeys = new Set([
  "effectType", "activationLocation", "phase", "targets", "requiresTarget",
  "requiresLegalEffectApplication", "monsterSummonedFrom", "monsterType",
  "targetIsLegal", "hasLegalEffectApplication", "timingLegal", "chainLinkLegal",
  "effectNumberRequired", "attemptsToReturnCurrentlyResolvingCard", "returnTarget",
]);
const forbiddenProgramKeys = new Set([
  "verdict", "status", "answer", "conclusion", "evidenceGrade", "blockers", "ruleTrace",
]);

export async function loadEffectTemplateRegistry(rootDir = defaultEffectTemplateDir, { useCache = true } = {}) {
  if (useCache && registryCache.has(rootDir)) return registryCache.get(rootDir);
  const loading = buildRegistry(rootDir).catch((error) => {
    registryCache.delete(rootDir);
    throw error;
  });
  if (useCache) registryCache.set(rootDir, loading);
  return loading;
}

export function createEffectTemplateRegistry({ templates = [], restrictions = [], aliases = [] } = {}) {
  const errors = [];
  const templateByKey = new Map();
  const templateById = new Map();
  for (const raw of templates) {
    const validation = validateEffectTemplate(raw);
    if (!validation.valid) {
      errors.push(...validation.errors.map((message) => `${raw?.id || raw?.cardId || "unknown"}: ${message}`));
      continue;
    }
    const template = normalizeEffectTemplate(raw);
    templateByKey.set(templateKey(template.cardId, template.effectNo), template);
    templateById.set(template.id, template);
  }

  const restrictionByKey = new Map();
  for (const restriction of restrictions) {
    const cardId = clean(restriction?.cardId);
    const effectNo = clean(restriction?.effectNo);
    const createsRestriction = restriction?.createsRestriction;
    if (!cardId || !effectNo || !createsRestriction?.restrictionType) {
      errors.push(`${restriction?.id || cardId || "unknown"}: invalid restriction template`);
      continue;
    }
    restrictionByKey.set(templateKey(cardId, effectNo), clone(restriction));
  }

  const aliasIndex = new Map();
  for (const item of aliases) {
    const alias = normalizeKey(item?.alias);
    if (!alias || !item?.cardId) {
      errors.push("invalid effect template alias");
      continue;
    }
    const list = aliasIndex.get(alias) || [];
    list.push({ cardId: String(item.cardId), effectNo: clean(item.effectNo) || "unknown" });
    aliasIndex.set(alias, list);
  }
  if (errors.length) throw new TypeError(`Invalid effect template registry:\n${errors.join("\n")}`);

  return {
    templateCount: templateByKey.size,
    restrictionTemplateCount: restrictionByKey.size,
    aliasCount: aliasIndex.size,
    templates: [...templateByKey.values()],
    getTemplate({ cardId, effectNo, effectTemplateId } = {}) {
      if (effectTemplateId && templateById.has(String(effectTemplateId))) return templateById.get(String(effectTemplateId));
      return templateByKey.get(templateKey(cardId, effectNo)) || null;
    },
    resolveAlias(alias) {
      return clone(aliasIndex.get(normalizeKey(alias)) || []);
    },
    getRestrictionTemplate({ cardId, effectNo } = {}) {
      return clone(restrictionByKey.get(templateKey(cardId, effectNo)) || null);
    },
  };
}

export function validateEffectTemplate(template = {}) {
  const errors = [];
  if (!template || typeof template !== "object" || Array.isArray(template)) return { valid: false, errors: ["template must be an object"] };
  for (const key of Object.keys(template)) if (!allowedTemplateKeys.has(key)) errors.push(`unsupported top-level field: ${key}`);
  if (!clean(template.cardId)) errors.push("cardId is required");
  if (!clean(template.effectNo)) errors.push("effectNo is required");
  if (!clean(template.name)) errors.push("name is required");
  if (!template.activation || typeof template.activation !== "object" || Array.isArray(template.activation)) errors.push("activation must be an object");
  else for (const key of Object.keys(template.activation)) if (!allowedActivationKeys.has(key)) errors.push(`unsupported activation field: ${key}`);
  if (!Array.isArray(template.primitiveSequence)) errors.push("primitiveSequence must be an array");
  else {
    try {
      normalizePrimitiveSequence(template.primitiveSequence);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (template.createsRestrictions !== undefined && !Array.isArray(template.createsRestrictions)) errors.push("createsRestrictions must be an array");
  for (const restriction of template.createsRestrictions || []) {
    if (!restriction?.restrictionType || typeof restriction.appliesTo !== "object") errors.push("invalid createsRestrictions entry");
  }
  scanForbiddenKeys(template, "template", errors);
  return { valid: errors.length === 0, errors };
}

export function normalizeEffectTemplate(template) {
  const sequence = normalizePrimitiveSequence(template.primitiveSequence).map((item) => ({
    ...item.primitive,
    id: item.id,
    connector: item.connector,
  }));
  return {
    id: clean(template.id) || `effect_template:${template.cardId}:${template.effectNo}`,
    cardId: String(template.cardId),
    name: clean(template.name),
    effectNo: clean(template.effectNo),
    activation: clone(template.activation || {}),
    sourceExpectedZone: clean(template.sourceExpectedZone) || "unknown",
    primitiveSequence: sequence,
    createsRestrictions: clone(template.createsRestrictions || []),
  };
}

export function hydrateChainLinkFromTemplate(link = {}, registry) {
  const sourceCardId = String(link.sourceCardId || link.source?.cardId || link.effect?.sourceCardId || "");
  const effectNo = clean(link.effectNo || link.effect?.effectNo || "unknown");
  const template = registry?.getTemplate({ cardId: sourceCardId, effectNo, effectTemplateId: link.effectTemplateId });
  const explicitSequence = link.primitiveSequence || link.effect?.primitiveSequence || [];
  if (!template) {
    return {
      ...clone(link),
      templateStatus: explicitSequence.length ? "explicit_sequence" : "missing",
      templateLookup: { cardId: sourceCardId, effectNo, effectTemplateId: link.effectTemplateId || null },
    };
  }

  const activation = template.activation || {};
  const targets = (link.targets?.length ? link.targets : activation.targets) || [];
  const primitiveSequence = explicitSequence.length ? explicitSequence : template.primitiveSequence;
  const candidateEffect = {
    ...clone(activation),
    allowedPhases: activation.phase || [],
    requiresTarget: activation.requiresTarget ?? targets.length > 0,
    legalTargets: targets,
    sourceCardId,
    effectNumber: effectNo,
    ...clone(link.effect || {}),
    ...clone(link.candidateEffect || {}),
  };
  delete candidateEffect.phase;
  delete candidateEffect.targets;
  return {
    ...clone(link),
    sourceCardId,
    effectNo,
    sourceExpectedZone: link.sourceExpectedZone || template.sourceExpectedZone,
    source: link.source || { cardId: sourceCardId, expectedZone: link.sourceExpectedZone || template.sourceExpectedZone },
    targets: clone(targets),
    primitiveSequence: clone(primitiveSequence),
    candidateEffect,
    createsRestrictions: clone(template.createsRestrictions),
    effectTemplateId: template.id,
    templateStatus: "loaded",
  };
}

export function hydrateChainLinksFromTemplates(chainLinks = [], registry) {
  return chainLinks.map((link) => hydrateChainLinkFromTemplate(link, registry));
}

export function generateRestrictionsFromEffectTemplates(entries = [], registry) {
  return entries.flatMap((entry) => {
    const template = registry?.getTemplate(entry || {});
    if (!template) return [];
    return template.createsRestrictions.map((restriction) => ({
      ...clone(restriction),
      sourceCard: entry.sourceCard || template.name,
      sourceCardId: String(entry.cardId || template.cardId),
      effectNo: clean(entry.effectNo || template.effectNo),
      generatedFromTemplate: template.id,
    }));
  });
}

export function clearEffectTemplateRegistryCache() {
  registryCache.clear();
}

async function buildRegistry(rootDir) {
  const [templates, restrictions, aliases] = await Promise.all([
    loadJsonCollection(join(rootDir, "cards"), ["templates"]),
    loadJsonCollection(join(rootDir, "restrictions"), ["restrictions", "templates"]),
    loadJsonCollection(join(rootDir, "aliases"), ["aliases"]),
  ]);
  return createEffectTemplateRegistry({ templates, restrictions, aliases });
}

async function loadJsonCollection(directory, collectionKeys) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
  const output = [];
  for (const file of files) {
    const path = join(directory, file.name);
    let payload;
    try {
      payload = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new TypeError(`Invalid effect template JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (Array.isArray(payload)) output.push(...payload);
    else {
      const collection = collectionKeys.map((key) => payload?.[key]).find(Array.isArray);
      if (collection) output.push(...collection);
      else output.push(payload);
    }
  }
  return output;
}

function scanForbiddenKeys(value, path, errors) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenProgramKeys.has(key)) errors.push(`${path}.${key} is program-owned and forbidden in templates`);
    scanForbiddenKeys(child, `${path}.${key}`, errors);
  }
}

function templateKey(cardId, effectNo) {
  return `${String(cardId || "").trim()}:${clean(effectNo)}`;
}

function normalizeKey(value) {
  return clean(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function clean(value) {
  return String(value || "").trim();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
