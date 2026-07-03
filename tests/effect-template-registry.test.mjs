import assert from "node:assert/strict";
import test from "node:test";
import {
  createEffectTemplateRegistry,
  hydrateChainLinkFromTemplate,
  loadEffectTemplateRegistry,
  validateEffectTemplate,
} from "../backend/effectTemplateRegistry.mjs";

test("loads and validates every initial effect template", async () => {
  const registry = await loadEffectTemplateRegistry(undefined, { useCache: false });
  assert.equal(registry.templateCount, 24);
  assert.equal(registry.restrictionTemplateCount, 4);
  assert.equal(registry.aliasCount, 8);
  for (const template of registry.templates) {
    assert.equal(validateEffectTemplate(template).valid, true, template.id);
    const hydrated = hydrateChainLinkFromTemplate({ id: "C1", sourceCardId: template.cardId, effectNo: template.effectNo }, registry);
    assert.equal(hydrated.templateStatus, "loaded", template.id);
    assert.equal(hydrated.effectTemplateId, template.id);
    assert.ok(hydrated.primitiveSequence.length > 0, template.id);
  }
  const dependent = registry.getTemplate({ cardId: "900201", effectNo: "1" });
  assert.equal(dependent.primitiveSequence[1].connector, "THEN");
});

test("rejects final answers and unknown primitives in templates", () => {
  const invalid = {
    cardId: "1",
    name: "非法模板",
    effectNo: "1",
    activation: {},
    sourceExpectedZone: "monster_zone",
    primitiveSequence: [{ type: "invent_final_answer" }],
    createsRestrictions: [],
    verdict: "can_activate",
  };
  const validation = validateEffectTemplate(invalid);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((item) => /program-owned|unsupported top-level/u.test(item)));
  assert.throws(() => createEffectTemplateRegistry({ templates: [invalid] }), /Invalid effect template registry/u);
});

test("missing template remains explicit", async () => {
  const registry = await loadEffectTemplateRegistry();
  const hydrated = hydrateChainLinkFromTemplate({ id: "C1", sourceCardId: "not-found", effectNo: "9" }, registry);
  assert.equal(hydrated.templateStatus, "missing");
  assert.deepEqual(hydrated.templateLookup, { cardId: "not-found", effectNo: "9", effectTemplateId: null });
});
