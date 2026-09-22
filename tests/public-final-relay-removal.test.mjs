import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getPublicRulingModelCapabilities,
  resolvePublicRulingModelProfile,
} from '../backend/publicRulingModelConfig.mjs';

test('public final model capabilities omit relay even when relay credentials are configured', () => {
  const capabilities = getPublicRulingModelCapabilities({
    BAI_API_KEY: 'synthetic-bai-key',
    DEEPSEEK_API_KEY: 'synthetic-deepseek-key',
    GLM_API_KEY: 'synthetic-glm-key',
    RELAY_API_KEY: 'synthetic-relay-key',
    RELAY_BASE_URL: 'https://relay.example.test/v1',
  });
  assert.equal(capabilities.defaultRulingModelProfile, 'bai-astra-low');
  assert.deepEqual(capabilities.rulingModelProfiles.map(({ id }) => id), [
    'bai-astra-low',
    'deepseek-v4.1-flash-none', 'deepseek-v4.1-flash-low',
    'deepseek-v4.1-flash-high', 'deepseek-v4.1-flash-max',
    'glm-5.3-low', 'glm-5.3-high', 'glm-5.3-max',
  ]);
  assert.ok(capabilities.rulingModelProfiles.every(({ available }) => available));
});

test('previous public relay profile IDs cannot dispatch final generation', () => {
  for (const model of ['gpt-5.6-sol', 'gpt-6-astra']) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.throws(() => resolvePublicRulingModelProfile(`relay-${model}-${effort}`), {
        code: 'invalid_ruling_model_profile', statusCode: 400,
      });
    }
  }
});
