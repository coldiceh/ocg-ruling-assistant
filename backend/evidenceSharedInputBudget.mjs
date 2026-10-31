// A request-local input budget. The caller must establish the baseline with
// the provider's exact counter and use the same model and uncached input
// pricing for the baseline, directory and selection requests. This module
// does not infer a token count or include output fees.
export function createSharedInputBudget({ baselineTokens, baselineRequestSha256, modelId }) {
  integer(baselineTokens, 'baseline_tokens', 1);
  sha256(baselineRequestSha256);
  if (typeof modelId !== 'string' || !modelId.trim()) {
    throw failure('evidence_shared_input_model_required');
  }
  const baseline = BigInt(baselineTokens);
  const tickets = new Map();
  let nextId = 1, frozenReason = null;
  const allocated = () => [...tickets.values()].reduce((sum, row) => (
    row.status === 'released' ? sum : sum + BigInt(row.accountedInputTokens)
  ), 0n);
  const remainingTokens = () => Number(max(0n, baseline - allocated()));
  const rowFor = ticket => {
    const row = tickets.get(ticket);
    if (!row) throw failure('evidence_shared_input_ticket_unknown');
    return row;
  };

  return Object.freeze({
    remainingTokens,
    reserve({ stage, inputTokens, requestSha256, minimumRemainingTokens = 0 }) {
      if (frozenReason) throw failure(frozenReason);
      if (!['rule_toc', 'selection'].includes(stage)) {
        throw failure('evidence_shared_input_stage_invalid');
      }
      integer(inputTokens, 'input_tokens', 1);
      integer(minimumRemainingTokens, 'minimum_remaining_tokens');
      sha256(requestSha256);
      if (allocated() + BigInt(inputTokens) + BigInt(minimumRemainingTokens) > baseline) {
        throw failure('evidence_shared_input_budget_exceeded');
      }
      const ticket = Object.freeze({ id: nextId++ });
      tickets.set(ticket, { id: ticket.id, stage, requestSha256, inputTokens,
        accountedInputTokens: inputTokens, status: 'reserved', reportedInputTokens: null });
      return ticket;
    },
    // The caller can release only a request it knows was never submitted.
    // Once a response has been observed, even an absent usage object does not
    // establish that the provider charged nothing.
    release(ticket, { submitted } = {}) {
      const row = rowFor(ticket);
      if (submitted !== false || row.status === 'observed') {
        throw failure('evidence_shared_input_release_requires_unsubmitted');
      }
      row.status = 'released';
    },
    observeUsage(ticket, usage) {
      const row = rowFor(ticket);
      if (row.status === 'released') throw failure('evidence_shared_input_ticket_released');
      row.status = 'observed';
      const reported = usage?.input_tokens;
      if (!Number.isSafeInteger(reported) || reported < 0) return;
      row.reportedInputTokens = Math.max(row.reportedInputTokens ?? 0, reported);
      // Never finance a later call by assuming a cache discount or refunding
      // a lower usage count. A mismatch invalidates the preflight guarantee.
      row.accountedInputTokens = Math.max(row.accountedInputTokens, reported);
      if (reported > row.inputTokens) {
        frozenReason = 'evidence_shared_input_count_mismatch';
        throw failure(frozenReason);
      }
    },
    snapshot() {
      const rows = [...tickets.values()];
      const sum = status => rows.reduce((total, row) => (
        row.status === status ? total + BigInt(row.accountedInputTokens) : total
      ), 0n);
      return {
        basis: 'provider_count', modelId, baselineTokens, baselineRequestSha256,
        accountedInputTokens: serializableTokens(allocated()),
        reservedInputTokens: serializableTokens(sum('reserved')),
        consumedInputTokens: serializableTokens(sum('observed')),
        remainingInputTokens: remainingTokens(),
        frozen: frozenReason !== null, frozenReason,
        attempts: rows.map(row => ({ ...row })),
      };
    },
  });
}

function failure(code) { return Object.assign(new Error(code), { code }); }
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw failure(`evidence_shared_input_${name}_invalid`);
  }
}
function sha256(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw failure('evidence_shared_input_request_sha256_invalid');
  }
}
function max(left, right) { return left > right ? left : right; }
// Invalid provider usage could exceed the JS safe integer range after several
// calls. Keep that diagnostic exact and JSON-compatible rather than rounding.
function serializableTokens(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
