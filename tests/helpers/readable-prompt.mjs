import assert from 'node:assert/strict';
import { renderReadableData } from '../../backend/readableEvidenceText.mjs';

// Read the retained render input, then verify it is the exact serialized suffix.
// Readable text is not a machine parsing protocol; no meaning is inferred here.
export function displayedPayload(bundle) {
  assert.ok(bundle.promptPayload);
  assert.ok(bundle.prompt.endsWith(renderReadableData(bundle.promptPayload)));
  assert.equal(bundle.promptChars, bundle.prompt.length);
  return bundle.promptPayload;
}
