import { createHash, randomUUID } from "node:crypto";
import { assertAdminEvidenceSnapshot } from "./adminEvidenceSnapshot.mjs";

export const ADMIN_RUN_STATUSES = Object.freeze({
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
  CANCELLED: "CANCELLED",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
});

export const ADMIN_RUN_EVENT_TYPES = Object.freeze({
  RUN_CREATED: "RUN_CREATED",
  RUN_STARTED: "RUN_STARTED",
  EXECUTION_LEASE_ACQUIRED: "EXECUTION_LEASE_ACQUIRED",
  EXECUTION_LEASE_RENEWED: "EXECUTION_LEASE_RENEWED",
  EXECUTION_LEASE_RELEASED: "EXECUTION_LEASE_RELEASED",
  PREPARATION_FINALIZED: "PREPARATION_FINALIZED",
  PROVIDER_SUBMISSION_STARTED: "PROVIDER_SUBMISSION_STARTED",
  PROVIDER_SUBMISSION_ACCEPTED: "PROVIDER_SUBMISSION_ACCEPTED",
  PROVIDER_SUBMISSION_REJECTED: "PROVIDER_SUBMISSION_REJECTED",
  PROVIDER_SUBMISSION_OUTCOME_UNKNOWN: "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
  PROVIDER_REPAIR_SUBMISSION_STARTED: "PROVIDER_REPAIR_SUBMISSION_STARTED",
  PROVIDER_REPAIR_SUBMISSION_ACCEPTED: "PROVIDER_REPAIR_SUBMISSION_ACCEPTED",
  PROVIDER_REPAIR_SUBMISSION_REJECTED: "PROVIDER_REPAIR_SUBMISSION_REJECTED",
  PROVIDER_REPAIR_SUBMISSION_OUTCOME_UNKNOWN: "PROVIDER_REPAIR_SUBMISSION_OUTCOME_UNKNOWN",
  PROVIDER_REPAIR_RESPONSE_COMPLETED: "PROVIDER_REPAIR_RESPONSE_COMPLETED",
  RUN_EVENT: "RUN_EVENT",
  STAGE_PROGRESS: "STAGE_PROGRESS",
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
  RUN_CANCELLED: "RUN_CANCELLED",
  RUN_SUCCEEDED: "RUN_SUCCEEDED",
  RUN_FAILED: "RUN_FAILED",
});

export const ADMIN_PROVIDER_SUBMISSION_STATES = Object.freeze({
  NONE: "NONE",
  SUBMITTING: "SUBMITTING",
  SUBMITTED: "SUBMITTED",
  REJECTED: "REJECTED",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
});

export const DEFAULT_ADMIN_EXECUTION_LEASE_MS = 120_000;

export const DEFAULT_ADMIN_RUN_LIMITS = Object.freeze({
  maxConcurrentRuns: null,
  maxRunDurationMs: null,
  maxInputTokens: null,
  maxOutputTokens: null,
  maxTotalTokens: null,
  maxCostUsd: null,
  maxCostCny: null,
});

const TERMINAL_STATUSES = new Set([
  ADMIN_RUN_STATUSES.CANCELLED,
  ADMIN_RUN_STATUSES.SUCCEEDED,
  ADMIN_RUN_STATUSES.FAILED,
]);

export function normalizeAdminRunLimits(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  return deepFreeze(Object.fromEntries(
    Object.keys(DEFAULT_ADMIN_RUN_LIMITS).map((key) => [
      key,
      normalizeOptionalLimit(input[key], key),
    ]),
  ));
}

export function isAdminRunLimitEnabled(value) {
  return value !== null && value !== undefined;
}

export function createAdminRunStore({
  storage = createMemoryAdminRunStorage(),
  now,
  runIdFactory = randomUUID,
  executionTokenFactory = randomUUID,
  submissionAttemptIdFactory = randomUUID,
  executionLeaseMs = DEFAULT_ADMIN_EXECUTION_LEASE_MS,
  conflictRetries = 12,
} = {}) {
  assertStorage(storage);
  const clock = resolveRunStoreClock(storage, now);
  const retryCount = positiveInteger(conflictRetries, "conflictRetries");
  const defaultExecutionLeaseMs = positiveInteger(executionLeaseMs, "executionLeaseMs");
  if (typeof executionTokenFactory !== "function") {
    throw new TypeError("executionTokenFactory must be a function");
  }
  if (typeof submissionAttemptIdFactory !== "function") {
    throw new TypeError("submissionAttemptIdFactory must be a function");
  }

  async function createRun({
    runId: requestedRunId = null,
    evidenceSnapshot,
    metadata = {},
    limits,
    executionProfile = null,
    preparationFinalized = false,
  } = {}) {
    assertAdminEvidenceSnapshot(evidenceSnapshot);
    const runId = requestedRunId === null || requestedRunId === undefined
      ? requiredString(runIdFactory(), "runId")
      : requiredString(requestedRunId, "runId");
    const prepared = preparationFinalized === true;
    const frozenProfile = executionProfile === null ? null : canonicalJson(executionProfile);
    if (prepared) {
      if (!frozenProfile || typeof frozenProfile !== "object" || Array.isArray(frozenProfile)) {
        throw new TypeError("executionProfile is required for a preparation-finalized run");
      }
      if (frozenProfile.status !== "evidence_frozen") {
        throw new TypeError("preparation-finalized run requires an evidence_frozen executionProfile");
      }
      if (String(frozenProfile.evidenceSnapshotId || "") !== String(evidenceSnapshot.snapshotId || "")) {
        throw new TypeError("executionProfile evidenceSnapshotId does not match evidenceSnapshot");
      }
    }
    const timestamp = await readTimestamp(clock);
    const event = {
      runId,
      sequence: 1,
      type: ADMIN_RUN_EVENT_TYPES.RUN_CREATED,
      timestamp,
      status: ADMIN_RUN_STATUSES.QUEUED,
      payload: {
        evidenceSnapshotId: evidenceSnapshot.snapshotId,
        ...(prepared ? { preparationFinalized: true } : {}),
      },
    };
    const run = {
      schemaVersion: 1,
      runId,
      revision: 1,
      lastSequence: 1,
      status: ADMIN_RUN_STATUSES.QUEUED,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      endedAt: null,
      evidenceSnapshot: cloneJson(evidenceSnapshot),
      metadata: canonicalJson(metadata),
      executionProfile: frozenProfile,
      preparationFinalizedAt: prepared ? timestamp : null,
      limits: normalizeAdminRunLimits(limits),
      stageTiming: null,
      cancellation: null,
      result: null,
      error: null,
      execution: {
        epoch: 0,
        lease: null,
        providerSubmission: createEmptyProviderSubmission(),
        repairSubmission: createEmptyProviderSubmission(),
        repair: null,
      },
    };
    await storage.createRun({ run: cloneJson(run), event: cloneJson(event) });
    return immutable(run);
  }

  async function getRun(runId) {
    const run = await storage.getRun(requiredString(runId, "runId"));
    return run ? immutable(run) : null;
  }

  async function appendEvent(runId, {
    type = ADMIN_RUN_EVENT_TYPES.RUN_EVENT,
    payload = {},
    executionToken = null,
  } = {}) {
    return mutateRun(runId, (current, timestamp) => {
      if (executionToken !== null && executionToken !== undefined) {
        requireExecutionFence(current, executionToken, timestamp, "append event");
      }
      return {
        eventType: requiredString(type, "event type"),
        eventPayload: canonicalJson(payload),
        patch: {},
      };
    });
  }

  async function startRun(runId) {
    return mutateRun(runId, (current, timestamp) => {
      requireStatus(current, [ADMIN_RUN_STATUSES.QUEUED], "start");
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.RUN_STARTED,
        eventPayload: {},
        patch: {
          status: ADMIN_RUN_STATUSES.RUNNING,
          startedAt: timestamp,
        },
      };
    });
  }

  /**
   * Claims the durable execution slot for one worker. The raw token is returned
   * only to the caller; persistence contains only its SHA-256 digest. A later
   * claim after expiry increments the epoch, fencing every write from the old
   * worker across all service instances.
   */
  async function acquireExecutionLease(runId, {
    ownerId,
    leaseMs = defaultExecutionLeaseMs,
  } = {}) {
    const owner = requiredString(ownerId, "ownerId");
    const durationMs = positiveInteger(leaseMs, "leaseMs");
    const executionToken = requiredString(executionTokenFactory(), "executionToken");
    const tokenHash = hashExecutionToken(executionToken);
    const run = await mutateRun(runId, (current, timestamp) => {
      requireStatus(current, [
        ADMIN_RUN_STATUSES.QUEUED,
        ADMIN_RUN_STATUSES.RUNNING,
        ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
      ], "acquire execution lease");
      const execution = normalizeRunExecution(current.execution);
      if (isExecutionLeaseActive(execution.lease, timestamp)) {
        throw runStoreError(
          "admin run already has an active execution lease",
          "admin_run_execution_lease_active",
        );
      }
      const epoch = execution.epoch + 1;
      const providerSubmission = execution.providerSubmission.state
        === ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTING
        ? providerSubmissionOutcomeUnknown(execution.providerSubmission, timestamp, {
          code: "provider_submission_owner_lost",
          message: "execution lease expired before the provider request id was durably recorded",
        })
        : execution.providerSubmission;
      const repairSubmission = execution.repairSubmission.state
        === ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTING
        ? providerSubmissionOutcomeUnknown(execution.repairSubmission, timestamp, {
          code: "provider_repair_submission_owner_lost",
          message: "execution lease expired before the repair provider request id was durably recorded",
        })
        : execution.repairSubmission;
      const lease = {
        epoch,
        tokenHash,
        ownerId: owner,
        acquiredAt: timestamp,
        renewedAt: timestamp,
        expiresAt: addMilliseconds(timestamp, durationMs),
      };
      const starting = current.status === ADMIN_RUN_STATUSES.QUEUED;
      return {
        eventType: starting
          ? ADMIN_RUN_EVENT_TYPES.RUN_STARTED
          : ADMIN_RUN_EVENT_TYPES.EXECUTION_LEASE_ACQUIRED,
        eventPayload: {
          executionEpoch: epoch,
          ownerId: owner,
          leaseExpiresAt: lease.expiresAt,
          providerSubmissionOutcomeUnknown:
            providerSubmission.state === ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN
            && execution.providerSubmission.state === ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTING,
          repairSubmissionOutcomeUnknown:
            repairSubmission.state === ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN
            && execution.repairSubmission.state === ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTING,
        },
        patch: {
          status: starting ? ADMIN_RUN_STATUSES.RUNNING : current.status,
          ...(starting ? { startedAt: timestamp } : {}),
          execution: {
            ...execution,
            epoch,
            lease,
            providerSubmission,
            repairSubmission,
          },
        },
      };
    });
    return immutable({
      run,
      executionToken,
      executionEpoch: run.execution.epoch,
      leaseExpiresAt: run.execution.lease.expiresAt,
    });
  }

  async function renewExecutionLease(runId, {
    executionToken,
    leaseMs = defaultExecutionLeaseMs,
  } = {}) {
    const durationMs = positiveInteger(leaseMs, "leaseMs");
    return mutateRun(runId, (current, timestamp) => {
      requireStatus(current, [
        ADMIN_RUN_STATUSES.RUNNING,
        ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
      ], "renew execution lease");
      const execution = requireExecutionFence(current, executionToken, timestamp, "renew execution lease");
      const lease = {
        ...execution.lease,
        renewedAt: timestamp,
        expiresAt: addMilliseconds(timestamp, durationMs),
      };
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.EXECUTION_LEASE_RENEWED,
        eventPayload: {
          executionEpoch: execution.epoch,
          ownerId: lease.ownerId,
          leaseExpiresAt: lease.expiresAt,
        },
        patch: {
          execution: {
            ...execution,
            lease,
          },
        },
      };
    });
  }

  async function releaseExecutionLease(runId, {
    executionToken,
  } = {}) {
    return mutateRun(runId, (current, timestamp) => {
      if (TERMINAL_STATUSES.has(current.status)) return { noChange: true };
      const execution = requireExecutionFence(
        current,
        executionToken,
        timestamp,
        "release execution lease",
      );
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.EXECUTION_LEASE_RELEASED,
        eventPayload: {
          executionEpoch: execution.epoch,
          ownerId: execution.lease.ownerId,
        },
        patch: {
          execution: {
            ...execution,
            lease: null,
          },
        },
      };
    });
  }

  async function updateStageProgress(runId, stageTiming, {
    executionToken,
  } = {}) {
    const snapshot = normalizeStageTiming(runId, stageTiming);
    return mutateRun(runId, (current, timestamp) => {
      requireNonTerminal(current, "update stage progress");
      requireExecutionFenceIfLeased(current, executionToken, timestamp, "update stage progress");
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.STAGE_PROGRESS,
        eventPayload: {
          trackerStatus: snapshot.status || null,
          totalElapsedMs: snapshot.totalElapsedMs ?? null,
          stageTiming: snapshot,
          stages: Array.isArray(snapshot.stages) ? snapshot.stages : [],
        },
        patch: { stageTiming: snapshot },
      };
    });
  }

  async function finalizePreparation(runId, {
    evidenceSnapshot,
    executionProfile,
    executionToken,
  } = {}) {
    assertAdminEvidenceSnapshot(evidenceSnapshot);
    if (!executionProfile || typeof executionProfile !== "object" || Array.isArray(executionProfile)) {
      throw new TypeError("executionProfile is required to finalize preparation");
    }
    const frozenSnapshot = cloneJson(evidenceSnapshot);
    const frozenProfile = canonicalJson(executionProfile);
    return mutateRun(runId, (current, timestamp) => {
      requireStatus(current, [ADMIN_RUN_STATUSES.RUNNING], "finalize preparation");
      requireExecutionFenceIfLeased(current, executionToken, timestamp, "finalize preparation");
      if (current.preparationFinalizedAt) {
        const error = new Error("admin run preparation is already finalized");
        error.code = "admin_run_preparation_already_finalized";
        throw error;
      }
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.PREPARATION_FINALIZED,
        eventPayload: {
          evidenceSnapshotId: frozenSnapshot.snapshotId,
        },
        patch: {
          evidenceSnapshot: frozenSnapshot,
          executionProfile: frozenProfile,
          preparationFinalizedAt: timestamp,
        },
      };
    });
  }

  /**
   * Persists the provider-submit intent before the caller performs the billable
   * network request. Only NONE may transition to SUBMITTING; every other state
   * is deliberately non-retryable for this run.
   */
  async function beginProviderSubmission(runId, {
    executionToken,
    providerId,
    requestFingerprint = null,
  } = {}) {
    const provider = requiredString(providerId, "providerId");
    const attemptId = requiredString(submissionAttemptIdFactory(), "submissionAttemptId");
    const fingerprint = requestFingerprint === null || requestFingerprint === undefined
      ? null
      : requiredString(requestFingerprint, "requestFingerprint");
    const run = await mutateRun(runId, (current, timestamp) => {
      requireStatus(current, [ADMIN_RUN_STATUSES.RUNNING], "begin provider submission");
      const execution = requireExecutionFence(
        current,
        executionToken,
        timestamp,
        "begin provider submission",
      );
      if (!current.preparationFinalizedAt) {
        throw runStoreError(
          "provider submission requires finalized preparation",
          "admin_run_preparation_not_finalized",
        );
      }
      requireProviderSubmissionState(
        execution.providerSubmission,
        ADMIN_PROVIDER_SUBMISSION_STATES.NONE,
        "begin provider submission",
      );
      const providerSubmission = {
        state: ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTING,
        attemptId,
        attemptEpoch: execution.epoch,
        providerId: provider,
        requestFingerprint: fingerprint,
        intentAt: timestamp,
        requestId: null,
        acceptedAt: null,
        rejectedAt: null,
        outcomeUnknownAt: null,
        error: null,
      };
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.PROVIDER_SUBMISSION_STARTED,
        eventPayload: {
          attemptId,
          executionEpoch: execution.epoch,
          providerId: provider,
          requestFingerprint: fingerprint,
        },
        patch: {
          execution: {
            ...execution,
            providerSubmission,
          },
        },
      };
    });
    return immutable({
      run,
      submissionIntent: {
        attemptId,
        executionEpoch: run.execution.epoch,
        providerId: provider,
        requestFingerprint: fingerprint,
        intentAt: run.execution.providerSubmission.intentAt,
      },
    });
  }

  async function recordProviderSubmissionAccepted(runId, {
    executionToken,
    attemptId,
    requestId,
    providerId,
  } = {}) {
    const attempt = requiredString(attemptId, "attemptId");
    const request = requiredString(requestId, "requestId");
    const provider = requiredString(providerId, "providerId");
    return mutateRun(runId, (current, timestamp) => {
      requireStatus(current, [
        ADMIN_RUN_STATUSES.RUNNING,
        ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
      ], "record provider submission accepted");
      const execution = requireExecutionFence(
        current,
        executionToken,
        timestamp,
        "record provider submission accepted",
      );
      const existingSubmission = execution.providerSubmission;
      if (
        existingSubmission?.state === ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTED
        && existingSubmission.attemptId === attempt
        && existingSubmission.providerId === provider
        && existingSubmission.requestId === request
        && existingSubmission.attemptEpoch === execution.epoch
      ) {
        // A Redis REST timeout is ambiguous: the atomic commit may have
        // succeeded even though its HTTP response never reached this worker.
        // Repeating the exact same local acknowledgement must therefore be a
        // read-only success. This makes it safe for the service to retry the
        // persistence step without ever repeating the billable provider call.
        return { noChange: true };
      }
      requireProviderSubmissionAttempt(execution, { attemptId: attempt, providerId: provider });
      const providerSubmission = {
        ...execution.providerSubmission,
        state: ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTED,
        requestId: request,
        acceptedAt: timestamp,
        error: null,
      };
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.PROVIDER_SUBMISSION_ACCEPTED,
        eventPayload: {
          attemptId: attempt,
          executionEpoch: execution.epoch,
          providerId: provider,
          requestId: request,
        },
        patch: {
          execution: {
            ...execution,
            providerSubmission,
          },
        },
      };
    });
  }

  async function recordProviderSubmissionRejected(runId, {
    executionToken,
    attemptId,
    providerId,
    error = {},
  } = {}) {
    return settleProviderSubmission(runId, {
      executionToken,
      attemptId,
      providerId,
      error,
      state: ADMIN_PROVIDER_SUBMISSION_STATES.REJECTED,
      eventType: ADMIN_RUN_EVENT_TYPES.PROVIDER_SUBMISSION_REJECTED,
      timestampField: "rejectedAt",
      action: "record provider submission rejected",
    });
  }

  async function markProviderSubmissionOutcomeUnknown(runId, {
    executionToken,
    attemptId,
    providerId,
    error = {},
  } = {}) {
    return settleProviderSubmission(runId, {
      executionToken,
      attemptId,
      providerId,
      error,
      state: ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN,
      eventType: ADMIN_RUN_EVENT_TYPES.PROVIDER_SUBMISSION_OUTCOME_UNKNOWN,
      timestampField: "outcomeUnknownAt",
      action: "mark provider submission outcome unknown",
    });
  }

  async function settleProviderSubmission(runId, {
    executionToken,
    attemptId,
    providerId,
    error,
    state,
    eventType,
    timestampField,
    action,
  }) {
    const attempt = requiredString(attemptId, "attemptId");
    const provider = requiredString(providerId, "providerId");
    const normalizedError = normalizeError(error);
    return mutateRun(runId, (current, timestamp) => {
      requireStatus(current, [
        ADMIN_RUN_STATUSES.RUNNING,
        ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
      ], action);
      const execution = requireExecutionFence(current, executionToken, timestamp, action);
      requireProviderSubmissionAttempt(execution, { attemptId: attempt, providerId: provider });
      const providerSubmission = {
        ...execution.providerSubmission,
        state,
        [timestampField]: timestamp,
        error: normalizedError,
      };
      return {
        eventType,
        eventPayload: {
          attemptId: attempt,
          executionEpoch: execution.epoch,
          providerId: provider,
          error: normalizedError,
        },
        patch: {
          execution: {
            ...execution,
            providerSubmission,
          },
        },
      };
    });
  }

  /**
   * Opens the single allowed directed-repair attempt after a completed primary
   * response failed output validation. The first attempt audit and immutable
   * evidence proof are committed together with the pre-submit intent so a
   * crash can never erase the first charge or silently submit a third request.
   */
  async function beginProviderRepairSubmission(runId, {
    executionToken,
    providerId,
    requestFingerprint = null,
    validationErrors = [],
    initialAttempt = {},
    invariants = {},
  } = {}) {
    const provider = requiredString(providerId, "providerId");
    const attemptId = requiredString(submissionAttemptIdFactory(), "submissionAttemptId");
    const fingerprint = requestFingerprint === null || requestFingerprint === undefined
      ? null
      : requiredString(requestFingerprint, "requestFingerprint");
    const normalizedErrors = canonicalJson(validationErrors).map((item) => String(item));
    if (normalizedErrors.length === 0) {
      throw new TypeError("repair validationErrors must not be empty");
    }
    const normalizedInitialAttempt = canonicalJson(initialAttempt);
    const normalizedInvariants = canonicalJson(invariants);
    const run = await mutateRun(runId, (current, timestamp) => {
      requireStatus(current, [ADMIN_RUN_STATUSES.RUNNING], "begin provider repair submission");
      const execution = requireExecutionFence(
        current,
        executionToken,
        timestamp,
        "begin provider repair submission",
      );
      requireProviderSubmissionState(
        execution.providerSubmission,
        ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTED,
        "begin provider repair submission",
      );
      requireProviderSubmissionState(
        execution.repairSubmission,
        ADMIN_PROVIDER_SUBMISSION_STATES.NONE,
        "begin provider repair submission",
      );
      if (execution.repair) {
        throw runStoreError(
          "cannot begin provider repair submission: repair was already attempted",
          "admin_run_provider_repair_already_attempted",
        );
      }
      assertRepairInvariants(current, normalizedInvariants);
      const repairSubmission = {
        state: ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTING,
        attemptId,
        attemptEpoch: execution.epoch,
        providerId: provider,
        requestFingerprint: fingerprint,
        intentAt: timestamp,
        requestId: null,
        acceptedAt: null,
        rejectedAt: null,
        outcomeUnknownAt: null,
        error: null,
      };
      const repair = {
        schemaVersion: 1,
        attempted: true,
        requestedAt: timestamp,
        validationErrors: normalizedErrors,
        initialAttempt: normalizedInitialAttempt,
        invariants: normalizedInvariants,
      };
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.PROVIDER_REPAIR_SUBMISSION_STARTED,
        eventPayload: {
          attemptId,
          executionEpoch: execution.epoch,
          providerId: provider,
          requestFingerprint: fingerprint,
          validationErrors: normalizedErrors,
          invariants: normalizedInvariants,
          initialAttempt: normalizedInitialAttempt,
        },
        patch: {
          execution: {
            ...execution,
            repairSubmission,
            repair,
          },
        },
      };
    });
    return immutable({
      run,
      submissionIntent: {
        attemptId,
        executionEpoch: run.execution.epoch,
        providerId: provider,
        requestFingerprint: fingerprint,
        intentAt: run.execution.repairSubmission.intentAt,
      },
    });
  }

  async function recordProviderRepairSubmissionAccepted(runId, {
    executionToken,
    attemptId,
    requestId,
    providerId,
  } = {}) {
    const attempt = requiredString(attemptId, "attemptId");
    const request = requiredString(requestId, "requestId");
    const provider = requiredString(providerId, "providerId");
    return mutateRun(runId, (current, timestamp) => {
      requireStatus(current, [
        ADMIN_RUN_STATUSES.RUNNING,
        ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
      ], "record provider repair submission accepted");
      const execution = requireExecutionFence(
        current,
        executionToken,
        timestamp,
        "record provider repair submission accepted",
      );
      const existingSubmission = execution.repairSubmission;
      if (
        existingSubmission?.state === ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTED
        && existingSubmission.attemptId === attempt
        && existingSubmission.providerId === provider
        && existingSubmission.requestId === request
        && existingSubmission.attemptEpoch === execution.epoch
      ) return { noChange: true };
      requireProviderSubmissionAttempt(execution, {
        attemptId: attempt,
        providerId: provider,
        submissionField: "repairSubmission",
      });
      const repairSubmission = {
        ...execution.repairSubmission,
        state: ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTED,
        requestId: request,
        acceptedAt: timestamp,
        error: null,
      };
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.PROVIDER_REPAIR_SUBMISSION_ACCEPTED,
        eventPayload: {
          attemptId: attempt,
          executionEpoch: execution.epoch,
          providerId: provider,
          requestId: request,
        },
        patch: { execution: { ...execution, repairSubmission } },
      };
    });
  }

  async function recordProviderRepairSubmissionRejected(runId, options = {}) {
    return settleProviderRepairSubmission(runId, {
      ...options,
      state: ADMIN_PROVIDER_SUBMISSION_STATES.REJECTED,
      eventType: ADMIN_RUN_EVENT_TYPES.PROVIDER_REPAIR_SUBMISSION_REJECTED,
      timestampField: "rejectedAt",
      action: "record provider repair submission rejected",
    });
  }

  async function markProviderRepairSubmissionOutcomeUnknown(runId, options = {}) {
    return settleProviderRepairSubmission(runId, {
      ...options,
      state: ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN,
      eventType: ADMIN_RUN_EVENT_TYPES.PROVIDER_REPAIR_SUBMISSION_OUTCOME_UNKNOWN,
      timestampField: "outcomeUnknownAt",
      action: "mark provider repair submission outcome unknown",
    });
  }

  async function settleProviderRepairSubmission(runId, {
    executionToken,
    attemptId,
    providerId,
    error = {},
    state,
    eventType,
    timestampField,
    action,
  } = {}) {
    const attempt = requiredString(attemptId, "attemptId");
    const provider = requiredString(providerId, "providerId");
    const normalizedError = normalizeError(error);
    return mutateRun(runId, (current, timestamp) => {
      requireStatus(current, [
        ADMIN_RUN_STATUSES.RUNNING,
        ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
      ], action);
      const execution = requireExecutionFence(current, executionToken, timestamp, action);
      requireProviderSubmissionAttempt(execution, {
        attemptId: attempt,
        providerId: provider,
        submissionField: "repairSubmission",
      });
      const repairSubmission = {
        ...execution.repairSubmission,
        state,
        [timestampField]: timestamp,
        error: normalizedError,
      };
      return {
        eventType,
        eventPayload: {
          attemptId: attempt,
          executionEpoch: execution.epoch,
          providerId: provider,
          error: normalizedError,
        },
        patch: { execution: { ...execution, repairSubmission } },
      };
    });
  }

  async function recordProviderRepairResponseCompleted(runId, {
    executionToken,
    completedAttempt,
    totals,
  } = {}) {
    const normalizedAttempt = canonicalJson(completedAttempt);
    const normalizedTotals = canonicalJson(totals);
    return mutateRun(runId, (current, timestamp) => {
      requireStatus(current, [
        ADMIN_RUN_STATUSES.RUNNING,
        ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
      ], "record provider repair response completed");
      const execution = requireExecutionFence(
        current,
        executionToken,
        timestamp,
        "record provider repair response completed",
      );
      requireProviderSubmissionState(
        execution.repairSubmission,
        ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTED,
        "record provider repair response completed",
      );
      if (normalizedAttempt.requestId !== execution.repairSubmission.requestId) {
        throw runStoreError(
          "repair response request id does not match the submitted repair",
          "admin_run_provider_repair_response_fenced",
        );
      }
      if (execution.repair?.completedAttempt) {
        if (
          JSON.stringify(execution.repair.completedAttempt) === JSON.stringify(normalizedAttempt)
          && JSON.stringify(execution.repair.totals) === JSON.stringify(normalizedTotals)
        ) return { noChange: true };
        throw runStoreError(
          "a different repair response was already recorded",
          "admin_run_provider_repair_response_conflict",
        );
      }
      const repair = {
        ...execution.repair,
        completedAt: timestamp,
        completedAttempt: normalizedAttempt,
        attempts: [execution.repair.initialAttempt, normalizedAttempt],
        totals: normalizedTotals,
      };
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.PROVIDER_REPAIR_RESPONSE_COMPLETED,
        eventPayload: {
          completedAttempt: normalizedAttempt,
          totals: normalizedTotals,
        },
        patch: { execution: { ...execution, repair } },
      };
    });
  }

  async function requestCancellation(runId, {
    reason = "",
    requestedBy = "",
  } = {}) {
    return mutateRun(runId, (current, timestamp) => {
      if (TERMINAL_STATUSES.has(current.status) || current.status === ADMIN_RUN_STATUSES.CANCEL_REQUESTED) {
        return { noChange: true };
      }
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.CANCEL_REQUESTED,
        eventPayload: {
          reason: String(reason || ""),
          requestedBy: String(requestedBy || ""),
        },
        patch: {
          status: ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
          cancellation: {
            requestedAt: timestamp,
            requestedBy: String(requestedBy || ""),
            reason: String(reason || ""),
            cancelledAt: null,
          },
        },
      };
    });
  }

  async function markCancelled(runId, {
    reason = "",
    stageTiming,
    executionToken = null,
  } = {}) {
    const finalStageTiming = stageTiming === undefined
      ? undefined
      : normalizeStageTiming(runId, stageTiming);
    requireTerminalStageTimingStatus(finalStageTiming, "CANCELLED");
    return mutateRun(runId, (current, timestamp) => {
      if (TERMINAL_STATUSES.has(current.status)) return { noChange: true };
      if (executionToken !== null && executionToken !== undefined) {
        requireExecutionFence(current, executionToken, timestamp, "cancel");
      }
      requireStatus(current, [
        ADMIN_RUN_STATUSES.QUEUED,
        ADMIN_RUN_STATUSES.RUNNING,
        ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
      ], "cancel");
      const cancellation = {
        requestedAt: current.cancellation?.requestedAt || timestamp,
        requestedBy: current.cancellation?.requestedBy || "",
        reason: String(reason || current.cancellation?.reason || ""),
        cancelledAt: timestamp,
      };
      const execution = normalizeRunExecution(current.execution);
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.RUN_CANCELLED,
        eventPayload: {
          reason: cancellation.reason,
          trackerStatus: finalStageTiming?.status || null,
        },
        patch: {
          status: ADMIN_RUN_STATUSES.CANCELLED,
          endedAt: timestamp,
          cancellation,
          execution: {
            ...execution,
            lease: null,
          },
          ...(finalStageTiming === undefined ? {} : { stageTiming: finalStageTiming }),
        },
      };
    });
  }

  async function completeRun(runId, {
    result = {},
    stageTiming,
    executionToken = null,
  } = {}) {
    const finalResult = canonicalJson(result);
    const finalStageTiming = stageTiming === undefined
      ? undefined
      : normalizeStageTiming(runId, stageTiming);
    requireTerminalStageTimingStatus(finalStageTiming, "COMPLETED");
    return mutateRun(runId, (current, timestamp) => {
      if (TERMINAL_STATUSES.has(current.status)) return { noChange: true };
      if (executionToken !== null && executionToken !== undefined) {
        requireExecutionFence(current, executionToken, timestamp, "complete");
      }
      requireStatus(current, [
        ADMIN_RUN_STATUSES.RUNNING,
        ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
      ], "complete");
      const execution = normalizeRunExecution(current.execution);
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.RUN_SUCCEEDED,
        eventPayload: {
          trackerStatus: finalStageTiming?.status || null,
        },
        patch: {
          status: ADMIN_RUN_STATUSES.SUCCEEDED,
          endedAt: timestamp,
          result: finalResult,
          execution: {
            ...execution,
            lease: null,
          },
          ...(finalStageTiming === undefined ? {} : { stageTiming: finalStageTiming }),
        },
      };
    });
  }

  async function failRun(runId, {
    error = {},
    stageTiming,
    executionToken = null,
  } = {}) {
    const finalStageTiming = stageTiming === undefined
      ? undefined
      : normalizeStageTiming(runId, stageTiming);
    requireTerminalStageTimingStatus(finalStageTiming, "CANCELLED");
    return mutateRun(runId, (current, timestamp) => {
      if (TERMINAL_STATUSES.has(current.status)) return { noChange: true };
      if (executionToken !== null && executionToken !== undefined) {
        requireExecutionFence(current, executionToken, timestamp, "fail");
      }
      requireStatus(current, [
        ADMIN_RUN_STATUSES.QUEUED,
        ADMIN_RUN_STATUSES.RUNNING,
        ADMIN_RUN_STATUSES.CANCEL_REQUESTED,
      ], "fail");
      const execution = normalizeRunExecution(current.execution);
      return {
        eventType: ADMIN_RUN_EVENT_TYPES.RUN_FAILED,
        eventPayload: {},
        patch: {
          status: ADMIN_RUN_STATUSES.FAILED,
          endedAt: timestamp,
          error: normalizeError(error),
          execution: {
            ...execution,
            lease: null,
          },
          ...(finalStageTiming === undefined ? {} : { stageTiming: finalStageTiming }),
        },
      };
    });
  }

  async function replayEvents(runId, {
    afterSequence = 0,
    limit = null,
  } = {}) {
    const id = requiredString(runId, "runId");
    const cursor = nonNegativeInteger(afterSequence ?? 0, "afterSequence");
    const normalizedLimit = limit === null || limit === undefined
      ? null
      : nonNegativeInteger(limit, "limit");
    const [run, events] = await Promise.all([
      storage.getRun(id),
      storage.readEvents({ runId: id, afterSequence: cursor, limit: normalizedLimit }),
    ]);
    if (!run) throw notFound(id);
    const immutableEvents = events.map(immutable);
    const nextAfterSequence = immutableEvents.length
      ? immutableEvents[immutableEvents.length - 1].sequence
      : cursor;
    return immutable({
      runId: id,
      afterSequence: cursor,
      nextAfterSequence,
      lastSequence: run.lastSequence,
      hasMore: nextAfterSequence < run.lastSequence,
      events: immutableEvents,
    });
  }

  async function isCancellationRequested(runId) {
    const run = await getRun(runId);
    if (!run) throw notFound(runId);
    return run.status === ADMIN_RUN_STATUSES.CANCEL_REQUESTED;
  }

  async function mutateRun(runId, buildMutation) {
    const id = requiredString(runId, "runId");
    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      const current = await storage.getRun(id);
      if (!current) throw notFound(id);
      // Persistent storage may supply an authoritative server clock. The time
      // sample precedes the CAS commit, so a conflict retry obtains a fresh
      // sample instead of reusing a stale application-host timestamp.
      const timestamp = await readTimestamp(clock);
      const mutation = buildMutation(immutable(current), timestamp);
      if (mutation?.noChange) return immutable(current);
      const sequence = current.lastSequence + 1;
      const next = {
        ...cloneJson(current),
        ...cloneJson(mutation.patch || {}),
        revision: current.revision + 1,
        lastSequence: sequence,
        updatedAt: timestamp,
      };
      const event = {
        runId: id,
        sequence,
        type: requiredString(mutation.eventType, "event type"),
        timestamp,
        status: next.status,
        payload: canonicalJson(mutation.eventPayload || {}),
      };
      try {
        await storage.commitRun({
          runId: id,
          expectedRevision: current.revision,
          run: next,
          event,
        });
        return immutable(next);
      } catch (error) {
        if (error?.code !== "admin_run_revision_conflict") throw error;
      }
    }
    const error = new Error("admin run update conflicted too many times");
    error.code = "admin_run_revision_conflict";
    throw error;
  }

  return Object.freeze({
    kind: "admin-run-store",
    storageKind: String(storage?.kind || "unknown"),
    persistent: storage?.persistent === true,
    ttlSeconds: storage?.ttlSeconds ?? null,
    createRun,
    getRun,
    appendEvent,
    startRun,
    acquireExecutionLease,
    renewExecutionLease,
    releaseExecutionLease,
    updateStageProgress,
    finalizePreparation,
    beginProviderSubmission,
    recordProviderSubmissionAccepted,
    recordProviderSubmissionRejected,
    markProviderSubmissionOutcomeUnknown,
    beginProviderRepairSubmission,
    recordProviderRepairSubmissionAccepted,
    recordProviderRepairSubmissionRejected,
    markProviderRepairSubmissionOutcomeUnknown,
    recordProviderRepairResponseCompleted,
    requestCancellation,
    markCancelled,
    completeRun,
    failRun,
    replayEvents,
    isCancellationRequested,
  });
}

/**
 * In-memory adapter implementing the same optimistic transaction boundary a
 * persistent adapter must provide: run state and its event are committed
 * atomically, with a revision check.
 */
export function createMemoryAdminRunStorage() {
  const runs = new Map();
  const events = new Map();

  return Object.freeze({
    kind: "memory",
    persistent: false,
    ttlSeconds: null,
    async createRun({ run, event }) {
      const id = requiredString(run?.runId, "runId");
      if (runs.has(id)) {
        const error = new Error(`admin run already exists: ${id}`);
        error.code = "admin_run_exists";
        throw error;
      }
      validateCommitPair(null, run, event);
      runs.set(id, cloneJson(run));
      events.set(id, [cloneJson(event)]);
    },

    async getRun(runId) {
      const run = runs.get(String(runId));
      return run ? cloneJson(run) : null;
    },

    async commitRun({ runId, expectedRevision, run, event }) {
      const id = requiredString(runId, "runId");
      const current = runs.get(id);
      if (!current) throw notFound(id);
      if (current.revision !== expectedRevision) {
        const error = new Error("admin run revision conflict");
        error.code = "admin_run_revision_conflict";
        throw error;
      }
      validateCommitPair(current, run, event);
      runs.set(id, cloneJson(run));
      events.get(id).push(cloneJson(event));
    },

    async readEvents({ runId, afterSequence = 0, limit = null }) {
      const source = events.get(String(runId)) || [];
      const selected = source.filter((event) => event.sequence > afterSequence);
      return cloneJson(limit === null ? selected : selected.slice(0, limit));
    },
  });
}

function validateCommitPair(current, run, event) {
  const expectedRevision = current ? current.revision + 1 : 1;
  const expectedSequence = current ? current.lastSequence + 1 : 1;
  if (run.revision !== expectedRevision || event.sequence !== expectedSequence || run.lastSequence !== expectedSequence) {
    throw new Error("invalid admin run atomic commit");
  }
  if (String(run.runId) !== String(event.runId)) throw new Error("admin run/event id mismatch");
}

function assertStorage(storage) {
  for (const method of ["createRun", "getRun", "commitRun", "readEvents"]) {
    if (typeof storage?.[method] !== "function") {
      throw new TypeError(`admin run storage is missing ${method}()`);
    }
  }
}

function requireNonTerminal(run, action) {
  if (TERMINAL_STATUSES.has(run.status)) {
    throw new Error(`cannot ${action} for terminal run ${run.status}`);
  }
}

function requireStatus(run, allowed, action) {
  if (!allowed.includes(run.status)) {
    throw new Error(`cannot ${action} admin run from ${run.status}`);
  }
}

function normalizeStageTiming(runId, stageTiming) {
  const snapshot = canonicalJson(stageTiming);
  if (String(snapshot.runId || "") !== String(runId || "")) {
    throw new TypeError("stage timing runId does not match run");
  }
  return snapshot;
}

function requireTerminalStageTimingStatus(stageTiming, expectedStatus) {
  if (
    stageTiming !== undefined
    && String(stageTiming.status || "").toUpperCase() !== expectedStatus
  ) {
    throw new TypeError(`terminal stage timing status must be ${expectedStatus}`);
  }
}

function createEmptyProviderSubmission() {
  return {
    state: ADMIN_PROVIDER_SUBMISSION_STATES.NONE,
    attemptId: null,
    attemptEpoch: null,
    providerId: null,
    requestFingerprint: null,
    intentAt: null,
    requestId: null,
    acceptedAt: null,
    rejectedAt: null,
    outcomeUnknownAt: null,
    error: null,
  };
}

function normalizeRunExecution(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const epoch = Number(input.epoch || 0);
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw runStoreError("invalid persisted execution epoch", "admin_run_execution_state_invalid");
  }
  const providerSubmissionInput = input.providerSubmission
    && typeof input.providerSubmission === "object"
    && !Array.isArray(input.providerSubmission)
    ? input.providerSubmission
    : createEmptyProviderSubmission();
  const providerState = String(
    providerSubmissionInput.state || ADMIN_PROVIDER_SUBMISSION_STATES.NONE,
  ).trim().toUpperCase();
  if (!Object.values(ADMIN_PROVIDER_SUBMISSION_STATES).includes(providerState)) {
    throw runStoreError(
      "invalid persisted provider submission state",
      "admin_run_provider_submission_state_invalid",
    );
  }
  const repairSubmissionInput = input.repairSubmission
    && typeof input.repairSubmission === "object"
    && !Array.isArray(input.repairSubmission)
    ? input.repairSubmission
    : createEmptyProviderSubmission();
  const repairState = String(
    repairSubmissionInput.state || ADMIN_PROVIDER_SUBMISSION_STATES.NONE,
  ).trim().toUpperCase();
  if (!Object.values(ADMIN_PROVIDER_SUBMISSION_STATES).includes(repairState)) {
    throw runStoreError(
      "invalid persisted provider repair submission state",
      "admin_run_provider_repair_submission_state_invalid",
    );
  }
  return canonicalJson({
    epoch,
    lease: input.lease || null,
    providerSubmission: {
      ...createEmptyProviderSubmission(),
      ...providerSubmissionInput,
      state: providerState,
    },
    repairSubmission: {
      ...createEmptyProviderSubmission(),
      ...repairSubmissionInput,
      state: repairState,
    },
    repair: input.repair || null,
  });
}

function requireExecutionFenceIfLeased(run, executionToken, timestamp, action) {
  const execution = normalizeRunExecution(run.execution);
  if (!execution.lease) return execution;
  return requireExecutionFence(run, executionToken, timestamp, action);
}

function requireExecutionFence(run, executionToken, timestamp, action) {
  const execution = normalizeRunExecution(run.execution);
  const token = requiredString(executionToken, "executionToken");
  if (!execution.lease || !isExecutionLeaseActive(execution.lease, timestamp)) {
    throw runStoreError(
      `cannot ${action}: execution lease is missing or expired`,
      "admin_run_execution_fenced",
    );
  }
  if (hashExecutionToken(token) !== String(execution.lease.tokenHash || "")) {
    throw runStoreError(
      `cannot ${action}: execution token belongs to an older worker`,
      "admin_run_execution_fenced",
    );
  }
  if (Number(execution.lease.epoch) !== execution.epoch) {
    throw runStoreError(
      `cannot ${action}: execution epoch is stale`,
      "admin_run_execution_fenced",
    );
  }
  return execution;
}

function requireProviderSubmissionState(providerSubmission, expected, action) {
  const actual = String(providerSubmission?.state || ADMIN_PROVIDER_SUBMISSION_STATES.NONE);
  if (actual === expected) return;
  const codeByState = {
    [ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTING]:
      "admin_run_provider_submission_in_progress",
    [ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTED]:
      "admin_run_provider_submission_already_accepted",
    [ADMIN_PROVIDER_SUBMISSION_STATES.REJECTED]:
      "admin_run_provider_submission_rejected",
    [ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN]:
      "admin_run_provider_submission_outcome_unknown",
  };
  throw runStoreError(
    `cannot ${action}: provider submission is ${actual}`,
    codeByState[actual] || "admin_run_provider_submission_state_invalid",
  );
}

function requireProviderSubmissionAttempt(execution, {
  attemptId,
  providerId,
  submissionField = "providerSubmission",
}) {
  const submission = execution[submissionField];
  requireProviderSubmissionState(
    submission,
    ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTING,
    "settle provider submission",
  );
  if (
    submission.attemptId !== attemptId
    || submission.providerId !== providerId
    || submission.attemptEpoch !== execution.epoch
  ) {
    throw runStoreError(
      "provider submission attempt belongs to an older worker",
      "admin_run_provider_submission_fenced",
    );
  }
}

function assertRepairInvariants(run, invariants) {
  const snapshot = run.evidenceSnapshot || {};
  const decisionPacket = snapshot?.evidence?.evidenceDecisionPacket || {};
  const prompt = run.executionProfile?.prompt || {};
  const expected = {
    evidenceSnapshotId: snapshot.snapshotId || null,
    evidenceSnapshotSha256: snapshot.contentSha256 || null,
    decisionPacketId: decisionPacket.decisionPacketId || null,
    decisionPacketSha256: decisionPacket.packetContentSha256 || null,
    promptSha256: prompt.sha256 || null,
  };
  for (const [key, value] of Object.entries(expected)) {
    if ((invariants?.[key] ?? null) !== value) {
      throw runStoreError(
        `cannot begin provider repair submission: ${key} changed`,
        "admin_run_provider_repair_invariant_mismatch",
      );
    }
  }
}

function providerSubmissionOutcomeUnknown(providerSubmission, timestamp, error) {
  return {
    ...providerSubmission,
    state: ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN,
    outcomeUnknownAt: timestamp,
    error: normalizeError(error),
  };
}

function isExecutionLeaseActive(lease, timestamp) {
  if (!lease || typeof lease !== "object") return false;
  const expiresAt = Date.parse(String(lease.expiresAt || ""));
  const current = Date.parse(String(timestamp || ""));
  return Number.isFinite(expiresAt) && Number.isFinite(current) && expiresAt > current;
}

function addMilliseconds(timestamp, durationMs) {
  return new Date(Date.parse(timestamp) + durationMs).toISOString();
}

function hashExecutionToken(token) {
  return createHash("sha256").update(requiredString(token, "executionToken"), "utf8").digest("hex");
}

function runStoreError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeOptionalLimit(value, name) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RangeError(`${name} must be null or a finite non-negative number`);
  }
  return number;
}

function normalizeError(error) {
  if (error instanceof Error) {
    return canonicalJson({
      name: error.name,
      code: error.code || "",
      message: error.message,
      ...copySafeErrorAudit(error),
    });
  }
  if (typeof error === "string") return canonicalJson({ name: "Error", code: "", message: error });
  return canonicalJson(error || {});
}

function copySafeErrorAudit(error) {
  const result = {};
  for (const field of [
    "provider",
    "requestId",
    "model",
    "requestedModel",
    "submittedModel",
    "billingStatus",
    "upstreamErrorCode",
    "upstreamCauseCode",
  ]) {
    const value = safeAuditString(error?.[field]);
    if (value !== null) result[field] = value;
  }
  if (Object.hasOwn(error || {}, "reportedModel")) {
    result.reportedModel = safeAuditString(error?.reportedModel);
  }
  const status = safeAuditNumber(error?.status);
  if (status !== null) result.status = status;
  for (const field of ["outcomeKnown", "budgetReservationMayExist"]) {
    if (typeof error?.[field] === "boolean") result[field] = error[field];
  }
  const streamMetrics = copySafeRelayStreamMetrics(error?.streamMetrics);
  if (streamMetrics) result.streamMetrics = streamMetrics;
  const usage = copySafeAuditFields(error?.usage, {
    numbers: [
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteTokens",
      "uncachedInputTokens",
      "outputTokens",
      "reasoningTokens",
      "totalTokens",
    ],
  });
  if (usage) result.usage = usage;
  const failureMetering = copySafeFailureMetering(error?.failureMetering);
  if (failureMetering) {
    result.failureMetering = failureMetering;
  }
  return result;
}

function copySafeRelayStreamMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {
    schemaVersion: 1,
    transport: "sse",
  };
  for (const field of [
    "requestToResponseHeadersMs",
    "requestToFirstByteMs",
    "requestToFirstEventMs",
    "requestToFirstContentMs",
    "requestToCompleteMs",
  ]) {
    const number = safeAuditNumber(value[field]);
    result[field] = number !== null && number >= 0 ? number : null;
  }
  for (const field of [
    "networkChunkCount",
    "sseEventCount",
    "visibleContentChunkCount",
    "responseBytes",
    "visibleContentBytes",
  ]) {
    const number = safeAuditNumber(value[field]);
    result[field] = Number.isSafeInteger(number) && number >= 0 ? number : 0;
  }
  result.finishReason = safeAuditString(value.finishReason)?.slice(0, 128) || null;
  return result;
}

function copySafeFailureMetering(value) {
  if (
    !value
    || typeof value !== "object"
    || value.scope !== "final_ruling_only"
  ) return null;
  const usage = copySafeAuditFields(value.usage, {
    numbers: [
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteTokens",
      "uncachedInputTokens",
      "outputTokens",
      "reasoningTokens",
      "totalTokens",
    ],
  });
  const cost = copySafeAuditFields(value.cost, {
    strings: [
      "provider",
      "model",
      "requestedModel",
      "exchangeRateVersion",
      "pricingVersion",
      "pricingEffectiveDate",
      "pricingStatus",
      "unavailabilityReason",
    ],
    numbers: [
      "exchangeRate",
      "pricingMultiplier",
      "inputCostUsd",
      "cachedInputCostUsd",
      "cacheWriteCostUsd",
      "outputCostUsd",
      "totalCostUsd",
      "inputCostCny",
      "cachedInputCostCny",
      "cacheWriteCostCny",
      "outputCostCny",
      "totalCostCny",
    ],
    booleans: ["pricingSourceVerified", "estimateOnly"],
  });
  return {
    scope: "final_ruling_only",
    usage,
    cost,
  };
}

function copySafeAuditFields(value, {
  strings = [],
  numbers = [],
  booleans = [],
} = {}) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const field of strings) {
    const item = safeAuditString(value[field]);
    if (item !== null) result[field] = item;
  }
  for (const field of numbers) {
    const item = safeAuditNumber(value[field]);
    if (item !== null) result[field] = item;
  }
  for (const field of booleans) {
    if (typeof value[field] === "boolean") result[field] = value[field];
  }
  return Object.keys(result).length ? result : null;
}

function safeAuditString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeAuditNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function canonicalJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function immutable(value) {
  return deepFreeze(cloneJson(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function resolveRunStoreClock(storage, explicitNow) {
  if (explicitNow !== undefined) {
    if (typeof explicitNow !== "function") throw new TypeError("now must be a function");
    return explicitNow;
  }
  if (typeof storage?.serverNow === "function") {
    return () => storage.serverNow();
  }
  return () => new Date();
}

async function readTimestamp(now) {
  const value = await now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("run store clock returned invalid time");
  return date.toISOString();
}

function requiredString(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new RangeError(`${name} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return number;
}

function notFound(runId) {
  const error = new Error(`admin run not found: ${runId}`);
  error.code = "admin_run_not_found";
  return error;
}
