import assert from 'node:assert/strict';
import test from 'node:test';

import { loadEvidenceGenerationContract } from '../backend/evidenceGenerationContract.mjs';

const profiles = [
  new URL(
    '../config/evidence-generation/bai-gpt-5.6-luna-low.incomplete.json',
    import.meta.url,
  ),
  new URL(
    '../config/evidence-generation/bai-deepseek-v4.1-flash-low.incomplete.json',
    import.meta.url,
  ),
];

test('B.AI evidence-generation profiles remain unsendable without complete-request counts', () => {
  for (const profileUrl of profiles) {
    assert.throws(
      () => loadEvidenceGenerationContract('navigation', { profileUrl }),
      /evidence_generation_profile_incomplete/u,
    );
  }
});
