import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeClassificationQueryReleaseInfo, buildAttributeClassificationQueries }
  from '../backend/attributeClassificationQueries.mjs';
import { ruleTocProvider, fixtureEnv, fixtureRetrieveInput } from './helpers/rule-toc-fixture.mjs';

const additionalText = 'このカードはモンスターゾーンに存在する限り、属性を「光」「水」「炎」「風」としても扱い、効果を適用する。';

test('multiple or additional attribute wording in Chinese, Japanese and English adds neutral local queries', () => {
  for (const question of [
    '具有多个属性的怪兽如何分类？', '同時具有多種屬性的怪獸如何分類？', '複数の属性を持つモンスターはどう扱う？',
    'このカードの属性は「光」としても扱う。', additionalText,
    '这张卡也当作光、水、炎、风属性。', '这张卡的属性也当作暗。', '追加属性时如何处理？',
    'How are monsters with multiple attributes classified?', 'This monster has two different Attributes.',
    'This card is also treated as LIGHT-Attribute.', 'This card gains an additional Attribute.',
    'This card is also treated as LIGHT, WATER, FIRE, and WIND.', 'This card is also WIND-Attribute.',
  ]) {
    const result = buildAttributeClassificationQueries({ question });
    assert.equal(result?.queries.length, 2, question);
    assert.deepEqual(result.triggerSources, ['question']);
    assert.equal(new Set(result.queries.map(query => query.needId)).size, 1);
    assert.ok(result.queries.every(query => query.localOnly && query.text.endsWith('？')));
  }
});

test('confirmed card effects can trigger retrieval; names, identifiers, ordinary text and a single attribute change cannot', () => {
  for (const key of ['confirmedCards', 'cardTexts']) {
    const result = buildAttributeClassificationQueries({ question: 'Can I activate this effect?', [key]: [{ effectText: additionalText }] });
    assert.deepEqual(result.triggerSources, [`${key}[0].effectText`]);
  }
  for (const question of [
    '场上的怪兽变成水属性。', '两只怪兽同时变成地属性。', '选择光属性或暗属性中的一种。',
    '光属性怪兽和暗属性怪兽作为素材。', 'フィールドのモンスターは水属性になる。',
    '属性を１つ宣言する。', 'All monsters become WATER-Attribute.',
    'Use 1 LIGHT monster and 1 DARK monster as materials.', 'Can this Spell be activated?',
    'This card is also treated as Fire King Avatar.',
    'This monster changes to another attribute.',
  ]) assert.equal(buildAttributeClassificationQueries({ question }), null, question);
  assert.equal(buildAttributeClassificationQueries({ confirmedCards: [{ id: 'multiple attributes', name: '多属性怪兽' }] }), null);
});

test('the rollback switch and existing planned queries prevent automatic additions', () => {
  assert.deepEqual(attributeClassificationQueryReleaseInfo(), {
    enabled: true, contract: 'local-multi-attribute-v1', transport: 'local-only',
  });
  for (const setting of ['false', '0', 'off', 'no']) {
    assert.equal(buildAttributeClassificationQueries({ question: additionalText }, {
      env: { ATTRIBUTE_CLASSIFICATION_QUERY_ENABLED: setting },
    }), null);
  }
  const original = buildAttributeClassificationQueries({ question: additionalText });
  assert.equal(buildAttributeClassificationQueries({ question: additionalText }, {
    existingQueries: original.queries.map(query => ({ text: ` ${query.text} ` })),
  }).queries.length, 0);
});

function expansionInput(fixture, env = fixtureEnv) {
  const value = fixtureRetrieveInput(fixture.assets, env);
  value.cardResolution.resolvedCards[0].effectText = additionalText;
  return value;
}

test('automatic queries use lexical/navigation only with unchanged model stages, embedding inputs, plans and caps', async () => {
  const enabled = ruleTocProvider(), disabled = ruleTocProvider();
  const result = await enabled.provider.retrieve(expansionInput(enabled));
  const baseline = await disabled.provider.retrieve(expansionInput(disabled, {
    ...fixtureEnv, ATTRIBUTE_CLASSIFICATION_QUERY_ENABLED: 'false',
  }));
  const diagnostic = result.telemetry.bounded.attributeClassification;
  assert.equal(diagnostic.queries.length, 2);
  assert.deepEqual(enabled.calls.map(row => row.kind), disabled.calls.map(row => row.kind));
  assert.deepEqual(enabled.calls[0].body, disabled.calls[0].body);
  const embeddings = telemetry => telemetry.bounded.calls.filter(row => row.operation === 'embed_content')
    .map(({ requestSha256, queryCount, inputTokenBound }) => ({ requestSha256, queryCount, inputTokenBound }));
  assert.deepEqual(embeddings(result.telemetry), embeddings(baseline.telemetry));
  assert.deepEqual(result.telemetry.queryPlan, baseline.telemetry.queryPlan);
  const selection = body => JSON.parse(body.input.find(row => row.role === 'user').content.split('\n').at(-1));
  assert.deepEqual(selection(enabled.calls.at(-1).body).queryPlan, selection(disabled.calls.at(-1).body).queryPlan);
  for (const query of diagnostic.queries) {
    const lanes = result.telemetry.bounded.reading.lanes.filter(lane => lane.queryVariantId === query.queryVariantId);
    assert.ok(lanes.length > 0);
    assert.ok(lanes.every(lane => ['original_lexical', 'navigation_lexical'].includes(lane.channel)));
    assert.ok(enabled.calls.every(row => !JSON.stringify(row.body).includes(query.text)), 'queries stay out of generation input');
  }
  assert.equal(result.telemetry.bounded.readTargetChars, baseline.telemetry.bounded.readTargetChars);
  assert.equal(result.telemetry.bounded.maxPromptChars, baseline.telemetry.bounded.maxPromptChars);
  assert.ok(result.packing.promptChars <= baseline.telemetry.bounded.maxPromptChars);
  assert.equal(baseline.telemetry.bounded.attributeClassification, undefined);
});

test('unrelated inputs and already planned classification queries keep the disabled model requests and lanes', async () => {
  for (const alreadyPlanned of [false, true]) {
    const queries = buildAttributeClassificationQueries({ question: additionalText }).queries;
    const options = alreadyPlanned ? { plan: { needs: [{ id: 'n1', question: 'classification',
      ruleQuery: queries[0].text, qaQuery: queries[1].text }] } } : {};
    const enabled = ruleTocProvider(options), disabled = ruleTocProvider(options);
    const makeInput = alreadyPlanned ? expansionInput : fixtureRetrieveInput;
    const enabledInput = alreadyPlanned ? makeInput(enabled) : makeInput(enabled.assets);
    const disabledInput = alreadyPlanned ? makeInput(disabled) : makeInput(disabled.assets);
    disabledInput.env = { ...fixtureEnv, ATTRIBUTE_CLASSIFICATION_QUERY_ENABLED: 'false' };
    const result = await enabled.provider.retrieve(enabledInput);
    const baseline = await disabled.provider.retrieve(disabledInput);
    assert.deepEqual(enabled.calls, disabled.calls);
    assert.deepEqual(result.telemetry.bounded.reading.lanes, baseline.telemetry.bounded.reading.lanes);
    assert.equal(result.telemetry.bounded.attributeClassification?.queries.length || 0, 0);
  }
});

test('only newly added classification queries lower the reading ceiling; smaller configured budgets stay intact', async () => {
  for (const configuredChars of [5000, 224000]) {
    const enabled = ruleTocProvider(), disabled = ruleTocProvider();
    const env = { ...fixtureEnv, GEMINI_EVIDENCE_READING_TARGET_CHARS: String(configuredChars) };
    const result = await enabled.provider.retrieve(expansionInput(enabled, env));
    const baseline = await disabled.provider.retrieve(expansionInput(disabled, {
      ...env, ATTRIBUTE_CLASSIFICATION_QUERY_ENABLED: 'false',
    }));
    assert.equal(result.telemetry.bounded.readTargetChars, Math.min(configuredChars, 220000));
    assert.deepEqual(result.telemetry.bounded.attributeClassification.readingBudget, {
      configuredChars, effectiveChars: Math.min(configuredChars, 220000),
    });
    assert.equal(baseline.telemetry.bounded.readTargetChars, configuredChars);
    assert.equal(result.telemetry.bounded.maxPromptChars, baseline.telemetry.bounded.maxPromptChars);
  }
});

test('frozen replay does not add unrecorded classification lanes', async () => {
  const original = ruleTocProvider();
  const baseline = await original.provider.retrieve(expansionInput(original, {
    ...fixtureEnv, ATTRIBUTE_CLASSIFICATION_QUERY_ENABLED: 'false',
  }));
  const replay = ruleTocProvider({ assets: original.assets, frozenRetrieval: {
    queryPlan: baseline.telemetry.queryPlan, lanes: baseline.telemetry.bounded.reading.lanes,
  } });
  const result = await replay.provider.retrieve(expansionInput(replay));
  assert.deepEqual(replay.calls.map(row => row.kind), ['selection']);
  assert.deepEqual(replay.calls[0].body, original.calls.at(-1).body);
  assert.deepEqual(result.telemetry.bounded.reading.lanes, baseline.telemetry.bounded.reading.lanes);
  assert.equal(result.telemetry.bounded.attributeClassification, undefined);
});

test('a supplementary round inherits classification lanes once without generating them again', async () => {
  const original = ruleTocProvider();
  const first = await original.provider.retrieve(expansionInput(original));
  const supplement = ruleTocProvider({ assets: original.assets });
  const result = await supplement.provider.retrieve({ ...expansionInput(supplement), supplement: {
    evidenceGap: 'fixture missing relation', baseSelectionIds: first.telemetry.bounded.selectedCanonicalIds,
    priorLanes: first.telemetry.bounded.reading.lanes, basePromptChars: first.packing.promptChars,
    previousQueryPlan: first.telemetry.queryPlan,
  } });
  const originalLanes = first.telemetry.bounded.reading.lanes.filter(lane => lane.needId === 'attribute_classification');
  const inherited = result.telemetry.bounded.reading.lanes
    .filter(lane => lane.queryVariantId.startsWith('prior:attribute_classification:'));
  assert.equal(inherited.length, originalLanes.length);
  assert.deepEqual(inherited.map(lane => lane.hits), originalLanes.map(lane => lane.hits));
  assert.equal(result.telemetry.bounded.reading.lanes.some(lane => lane.needId === 'attribute_classification'), false);
  assert.equal(result.telemetry.bounded.attributeClassification, undefined);
});
