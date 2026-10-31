import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedInputBudget } from '../backend/evidenceSharedInputBudget.mjs';

const BASELINE = 'a'.repeat(64), REQUEST = 'b'.repeat(64);
const ledger = (baselineTokens = 1000) => createSharedInputBudget({ baselineTokens,
  baselineRequestSha256: BASELINE, modelId: 'gpt-6-luna' });
const request = (inputTokens, stage = 'rule_toc', minimumRemainingTokens = 0) => ({
  stage, inputTokens, requestSha256: REQUEST, minimumRemainingTokens,
});

test('directory and its retry share the original selection input, preserving selection headroom', () => {
  const budget = ledger();
  const first = budget.reserve(request(250, 'rule_toc', 500));
  budget.observeUsage(first, { input_tokens: 250 });
  const retry = budget.reserve(request(250, 'rule_toc', 500));
  budget.observeUsage(retry, { input_tokens: 250 });
  assert.throws(() => budget.reserve(request(1, 'rule_toc', 500)),
    { code: 'evidence_shared_input_budget_exceeded' });
  const selection = budget.reserve(request(500, 'selection'));
  budget.observeUsage(selection, { input_tokens: 500 });
  assert.equal(budget.remainingTokens(), 0);
  assert.throws(() => budget.reserve(request(500, 'selection')),
    { code: 'evidence_shared_input_budget_exceeded' });
  const state = budget.snapshot();
  assert.equal(state.baselineTokens, 1000);
  assert.equal(state.accountedInputTokens, 1000);
  assert.equal(state.consumedInputTokens, 1000);
  assert.equal(state.attempts.length, 3);
});

test('a sent call with no response keeps its reservation; missing usage does not imply a refund', () => {
  const budget = ledger();
  budget.reserve(request(400)); // Sent and timed out without a response.
  const retried = budget.reserve(request(300));
  budget.observeUsage(retried, null);
  assert.equal(budget.remainingTokens(), 300);
  assert.throws(() => budget.reserve(request(301, 'selection')),
    { code: 'evidence_shared_input_budget_exceeded' });
  assert.throws(() => budget.release(retried, { submitted: false }),
    { code: 'evidence_shared_input_release_requires_unsubmitted' });
  assert.deepEqual([budget.snapshot().reservedInputTokens, budget.snapshot().consumedInputTokens], [400, 300]);
});

test('only an explicitly unsubmitted request can release its reservation', () => {
  const budget = ledger();
  const ticket = budget.reserve(request(1000));
  assert.throws(() => budget.release(ticket),
    { code: 'evidence_shared_input_release_requires_unsubmitted' });
  assert.throws(() => budget.release(ticket, { submitted: true }),
    { code: 'evidence_shared_input_release_requires_unsubmitted' });
  budget.release(ticket, { submitted: false });
  budget.release(ticket, { submitted: false }); // Idempotent cleanup does not double-credit.
  assert.equal(budget.remainingTokens(), 1000);
  budget.reserve(request(1000, 'selection'));
  assert.equal(budget.remainingTokens(), 0);
  assert.throws(() => budget.observeUsage(ticket, { input_tokens: 1 }),
    { code: 'evidence_shared_input_ticket_released' });
});

test('smaller usage or cache hits never finance additional input', () => {
  const budget = ledger();
  const ticket = budget.reserve(request(800));
  budget.observeUsage(ticket, { input_tokens: 700, input_tokens_details: { cached_tokens: 700 } });
  budget.observeUsage(ticket, { input_tokens: 0 });
  assert.equal(budget.remainingTokens(), 200);
  assert.equal(budget.snapshot().attempts[0].reportedInputTokens, 700);
  assert.throws(() => budget.reserve(request(201, 'selection')),
    { code: 'evidence_shared_input_budget_exceeded' });
});

test('a count overrun is recorded and freezes future calls even when aggregate headroom remains', () => {
  const budget = ledger();
  const ticket = budget.reserve(request(100));
  assert.throws(() => budget.observeUsage(ticket, { input_tokens: 101 }),
    { code: 'evidence_shared_input_count_mismatch' });
  assert.equal(budget.remainingTokens(), 899);
  assert.equal(budget.snapshot().accountedInputTokens, 101);
  assert.equal(budget.snapshot().frozen, true);
  assert.throws(() => budget.reserve(request(1, 'selection')),
    { code: 'evidence_shared_input_count_mismatch' });
  assert.doesNotThrow(() => JSON.stringify(budget.snapshot()));
});

test('budget metadata is immutable from snapshots and tickets cannot be forged or shared', () => {
  const first = ledger(), second = ledger();
  const ticket = first.reserve(request(100));
  const state = first.snapshot();
  state.attempts[0].accountedInputTokens = 0;
  state.attempts.length = 0;
  assert.equal(first.remainingTokens(), 900);
  assert.throws(() => first.release({ id: ticket.id }, { submitted: false }),
    { code: 'evidence_shared_input_ticket_unknown' });
  assert.throws(() => second.observeUsage(ticket, null),
    { code: 'evidence_shared_input_ticket_unknown' });
});

test('invalid counts fail before allocation, including fractional and unsafe integers', () => {
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => ledger(invalid), /baseline_tokens_invalid/u);
    assert.throws(() => ledger().reserve(request(invalid)), /input_tokens_invalid/u);
  }
  const budget = ledger();
  assert.throws(() => budget.reserve(request(1, 'plan')), /stage_invalid/u);
  assert.throws(() => budget.reserve(request(1, 'selection', -1)), /minimum_remaining_tokens_invalid/u);
  assert.throws(() => budget.reserve({ ...request(1), requestSha256: '' }), /request_sha256_invalid/u);
  assert.equal(budget.remainingTokens(), 1000);
});

test('unexpected huge usage remains exact in diagnostics without permitting another request', () => {
  const budget = ledger(Number.MAX_SAFE_INTEGER);
  const first = budget.reserve(request(Number.MAX_SAFE_INTEGER - 1));
  const second = budget.reserve(request(1, 'selection'));
  budget.observeUsage(first, { input_tokens: Number.MAX_SAFE_INTEGER - 1 });
  assert.throws(() => budget.observeUsage(second, { input_tokens: Number.MAX_SAFE_INTEGER }),
    { code: 'evidence_shared_input_count_mismatch' });
  assert.equal(budget.remainingTokens(), 0);
  assert.equal(budget.snapshot().accountedInputTokens,
    (2n * BigInt(Number.MAX_SAFE_INTEGER) - 1n).toString());
  assert.doesNotThrow(() => JSON.stringify(budget.snapshot()));
});
