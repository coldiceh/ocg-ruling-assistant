import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ADMIN_MODEL_LAB_STAGES,
  getAdminModelProviderCapabilities,
  readAdminModelLabConfig,
  resolveAdminModelSelection,
} from "./adminModelLabConfig.mjs";
import {
  buildAdminEvidenceDecisionPacket,
  createAdminEvidenceArchive,
} from "./adminEvidenceArchive.mjs";
import { createAdminEvidenceSnapshot } from "./adminEvidenceSnapshot.mjs";
import {
  ADMIN_RUN_STAGE_CATALOG,
  ADMIN_STAGE_STATUSES,
  ADMIN_TRACKER_STATUSES,
  createAdminStageTracker,
} from "./adminStageTracker.mjs";
import {
  ADMIN_PROVIDER_SUBMISSION_STATES,
  ADMIN_RUN_STATUSES,
} from "./adminRunStore.mjs";
import {
  estimateDeepSeekModelCost,
  estimateOpenAIModelCost,
  normalizeOpenAIResponsesUsage,
  normalizeReportedModelUsage,
} from "./modelPricing.mjs";
import {
  extractOpenAIResponseOutputText,
  getRulingModelCapabilityTable,
} from "./rulingModelProviders.mjs";
import { parseAndValidateModelRulingResult } from "./modelRulingSchema.mjs";
import { extractRagCards } from "./ragCardExtractor.mjs";
import {
  evidenceBucketsToList,
  loadRagData,
  retrieveRagEvidence,
} from "./ragEvidenceRetriever.mjs";

const DEFAULT_PROMPT_VERSION = "openai-ruling-v1";
const DEFAULT_PROMPT_FILE_URL = new URL("../prompts/openai-ruling-v1.md", import.meta.url);
export const MAX_FINAL_RULING_INPUT_BYTES = 512 * 1024;
const FINAL_STAGE_ID = "generate_ruling";
const PREPARATION_STAGE_IDS = Object.freeze([
  "understand",
  "extract_card_names",
  "retrieve_card_texts",
  "retrieve_rulings_evidence",
]);
const OPENAI_ACTIVE_STATUSES = new Set(["queued", "in_progress"]);
const OPENAI_FAILURE_STATUSES = new Set(["failed", "incomplete", "expired"]);
const TERMINAL_RUN_STATUSES = new Set([
  ADMIN_RUN_STATUSES.CANCELLED,
  ADMIN_RUN_STATUSES.SUCCEEDED,
  ADMIN_RUN_STATUSES.FAILED,
]);

export const ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES = Object.freeze({
  MODEL_REQUEST_CREATED: "MODEL_REQUEST_CREATED",
  MODEL_STATUS_CHANGED: "MODEL_STATUS_CHANGED",
  MODEL_POLL_ERROR: "MODEL_POLL_ERROR",
  MODEL_VALIDATION_FAILED: "MODEL_VALIDATION_FAILED",
  MODEL_CANCEL_FAILED: "MODEL_CANCEL_FAILED",
});

/**
 * Orchestrates the isolated admin model lab.
 *
 * The service intentionally has no simulator dependency. Deterministic RAG and
 * an optional low-cost preparation provider build a lossless Evidence Snapshot;
 * every final ruling is then submitted to an allowlisted OpenAI GPT-5.6 model.
 */
export function createAdminModelLabService({
  runStore,
  openAIProvider = null,
  deepSeekProvider = null,
  env = globalThis.process?.env || {},
  loadData = loadRagData,
  extractCards = extractRagCards,
  retrieveEvidence = retrieveRagEvidence,
  createEvidenceSnapshot = createAdminEvidenceSnapshot,
  stageTrackerFactory = createAdminStageTracker,
  promptLoader = defaultPromptLoader,
  monotonicNow = defaultMonotonicNow,
  wallNow = () => new Date(),
  dataDir,
  retrievalFetchImpl = globalThis.fetch,
  dataVersions = {},
} = {}) {
  assertRunStore(runStore);
  const config = readAdminModelLabConfig(env);
  const liveOfficialQaEnabled = serverLiveOfficialQaEnabled(env);
  const serverPricingProfile = {
    usdToCnyRate: optionalPositiveNumber(env.ADMIN_MODEL_LAB_USD_TO_CNY_RATE),
    exchangeRateVersion: nullableString(env.ADMIN_MODEL_LAB_EXCHANGE_RATE_VERSION),
    deepSeek: readServerDeepSeekPricingProfile(env),
  };
  const activeExecutionRunIds = new Set();
  const serviceInstanceId = randomUUID();
  const executionHeartbeatMs = readExecutionHeartbeatMs(env);

  async function capabilities() {
    return immutableJson({
      architecture: {
        preparationProvider: "deepseek",
        preparationCanMakeFinalRuling: false,
        preparationCanDecideEscalation: false,
        finalRulingProvider: "openai",
        finalRulingRequiredForEveryRun: true,
        simulatorUsed: false,
      },
      providers: getAdminModelProviderCapabilities({ env }),
      models: getRulingModelCapabilityTable(),
      limits: {
        enabled: config.limitsEnabled,
        values: config.limits,
      },
      promptVersions: [{
        id: DEFAULT_PROMPT_VERSION,
        label: "OpenAI Ruling v1",
        default: true,
      }],
      features: {
        createRun: true,
        executeRun: true,
        reconcileRunOnRead: true,
        cancelRun: true,
        eventReplay: true,
        evidenceSnapshot: true,
        liveOfficialQaDefault: liveOfficialQaEnabled,
        resumablePreparationAfterProcessLoss: false,
        history: false,
        rating: false,
        export: false,
        evaluation: false,
      },
      unavailableReasons: {
        history: "admin run storage has no persistent list/index contract",
        rating: "admin run storage has no persistent rating contract",
        export: "admin run storage has no persistent list/index contract",
        evaluation: "evaluation persistence is not part of the run store contract",
      },
    });
  }

  async function createRun(argument = {}) {
    const body = unwrapBody(argument);
    const questions = normalizeQuestions(body);
    const question = normalizeQuestionText(body, questions);
    const promptVersion = nonEmptyString(body.promptVersion, DEFAULT_PROMPT_VERSION);
    const finalSelection = resolveAdminModelSelection({
      provider: "openai",
      model: body.model || config.defaultFinalModel,
      reasoningEffort: body.reasoningEffort || config.defaultReasoningEffort,
      reasoningMode: body.reasoningMode || config.defaultReasoningMode,
      stage: ADMIN_MODEL_LAB_STAGES.FINAL_RULING,
    });
    const preparationModel = String(body.preparationModel || "deepseek-v4-flash").trim();
    resolveAdminModelSelection({
      provider: "deepseek",
      model: preparationModel,
      reasoningEffort: "none",
      reasoningMode: "standard",
      stage: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
    });
    const instructions = await resolveInstructions(body, promptLoader);
    const executionProfile = {
      status: "planned",
      preparation: {
        provider: "deepseek",
        model: preparationModel,
        canMakeFinalRuling: false,
        canDecideEscalation: false,
      },
      finalRuling: {
        provider: finalSelection.provider,
        requestedModel: finalSelection.requestedModel,
        model: finalSelection.model,
        reasoningEffort: finalSelection.reasoningEffort,
        reasoningMode: finalSelection.reasoningMode,
        maxOutputTokens: optionalPositiveInteger(body.maxOutputTokens),
      },
      prompt: {
        version: promptVersion,
        sha256: sha256(instructions),
        instructions,
      },
      questionIds: questions.map((item) => item.questionId),
      providedFacts: normalizeStringList(body.providedFacts),
      pricing: serverPricingProfile,
    };
    const initialSnapshot = createEvidenceSnapshot({
      question,
      evidence: {
        preparationStatus: "pending",
        questions,
        providedFacts: executionProfile.providedFacts,
        request: {
          preparationModel,
          finalModel: finalSelection.model,
          reasoningEffort: finalSelection.reasoningEffort,
          reasoningMode: finalSelection.reasoningMode,
          promptVersion,
          liveOfficialQaEnabled,
        },
      },
      dataVersions: jsonSafe(resolveServerDataVersions(dataVersions)),
      metadata: {
        initialRequest: true,
        promptVersion,
        promptSha256: sha256(instructions),
        preparationProvider: "deepseek",
        finalRulingProvider: "openai",
        finalRulingRequired: true,
        simulatorUsed: false,
      },
      createdAt: readWall(wallNow),
    });
    return runStore.createRun({
      evidenceSnapshot: initialSnapshot,
      metadata: {
        label: nullableString(body.label),
        source: nullableString(body.source) || "admin_model_lab",
        initialRequestSnapshotId: initialSnapshot.snapshotId,
      },
      executionProfile,
      // Application-level limits are intentionally disabled by default. Null
      // means disabled and is never coerced to zero.
      limits: config.limitsEnabled ? translateConfiguredLimits(config.limits) : undefined,
    });
  }

  async function executeRun({ runId, body = {} } = {}) {
    const id = requiredString(runId, "runId");
    let run = await requireRun(id);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return immutableJson({ run, providerRequest: null });
    if (!openAIProvider || typeof openAIProvider.create !== "function") {
      throw serviceError("OpenAI final-ruling provider is not configured", "final_ruling_provider_unavailable");
    }
    if (run.status === ADMIN_RUN_STATUSES.CANCEL_REQUESTED) {
      const context = await readProviderContext(id);
      if (
        !context.request
        && [
          ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTING,
          ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN,
          ADMIN_PROVIDER_SUBMISSION_STATES.REJECTED,
        ].includes(run.execution?.providerSubmission?.state)
      ) {
        run = await reconcileProviderSubmissionWithoutRequest(id, run);
        return immutableJson({ run, providerRequest: null });
      }
      if (!context.request) {
        run = await markRunCancelled(id, {
          reason: run.cancellation?.reason || "cancelled before provider request",
        });
      }
      return immutableJson({ run, providerRequest: context.request });
    }
    const existingContext = await readProviderContext(id);
    if (existingContext.request) {
      return immutableJson({ run, providerRequest: existingContext.request });
    }
    if (![ADMIN_RUN_STATUSES.QUEUED, ADMIN_RUN_STATUSES.RUNNING].includes(run.status)) {
      throw serviceError(`cannot execute run from ${run.status}`, "admin_run_not_executable");
    }
    if (activeExecutionRunIds.has(id)) {
      return immutableJson({ run, providerRequest: null });
    }

    activeExecutionRunIds.add(id);
    let tracker = null;
    let executionToken = null;
    try {
      let claim;
      try {
        claim = await runStore.acquireExecutionLease(id, {
          ownerId: `${serviceInstanceId}:${randomUUID()}`,
        });
      } catch (error) {
        if (error?.code === "admin_run_execution_lease_active") {
          run = await requireRun(id);
          const context = await readProviderContext(id);
          return immutableJson({ run, providerRequest: context.request });
        }
        throw error;
      }
      run = claim.run;
      executionToken = claim.executionToken;

      const claimedSubmission = run.execution?.providerSubmission;
      if (
        claimedSubmission?.state === ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN
        || claimedSubmission?.state === ADMIN_PROVIDER_SUBMISSION_STATES.REJECTED
      ) {
        const error = providerSubmissionTerminalError(claimedSubmission);
        await failRunWithStage(id, error, executionToken);
        return immutableJson({
          run: await requireRun(id),
          providerRequest: null,
        });
      }
      if (claimedSubmission?.state === ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTED) {
        const context = await readProviderContext(id);
        await releaseLeaseIfOwned(id, executionToken);
        return immutableJson({ run: await requireRun(id), providerRequest: context.request });
      }

      if (!run.preparationFinalizedAt) {
        // A RUNNING record without a frozen snapshot/request is an interrupted
        // preparation. Rebuilding from the immutable initial request is safe;
        // the optimistic run store ensures only one finalized snapshot wins.
        tracker = stageTrackerFactory({
          runId: id,
          monotonicNow,
          wallNow,
        });
        const preparation = await prepareCompleteEvidence({
          run,
          tracker,
          executionToken,
        });
        run = await requireRun(id);
        if (run.status === ADMIN_RUN_STATUSES.CANCELLED) {
          return immutableJson({ run, providerRequest: null });
        }
        const finalSnapshot = createEvidenceSnapshot({
          question: run.evidenceSnapshot.question,
          evidence: {
            ...preparation.snapshotEvidence,
            initialRequest: run.evidenceSnapshot,
          },
          dataVersions: jsonSafe(resolveServerDataVersions(dataVersions)),
          metadata: {
            promptVersion: run.executionProfile?.prompt?.version || DEFAULT_PROMPT_VERSION,
            promptSha256: run.executionProfile?.prompt?.sha256 || null,
            preparationProvider: "deepseek",
            finalRulingProvider: "openai",
            finalRulingRequired: true,
            simulatorUsed: false,
            initialRequestSnapshotId: run.evidenceSnapshot.snapshotId,
            preparationStartedAt: preparation.startedAt,
            preparationEndedAt: preparation.endedAt,
            evidenceCompleteness: preparation.completeness,
          },
          createdAt: preparation.endedAt,
        });
        const finalizedProfile = {
          ...jsonSafe(run.executionProfile),
          status: "evidence_frozen",
          evidenceSnapshotId: finalSnapshot.snapshotId,
        };
        run = await runStore.finalizePreparation(id, {
          evidenceSnapshot: finalSnapshot,
          executionProfile: finalizedProfile,
          executionToken,
        });
      } else {
        tracker = restoreTracker(run, {
          targetElapsedMs: currentElapsedMs(run),
        }).tracker;
      }

      const finalStage = tracker.snapshot().stages.find((stage) => stage.id === FINAL_STAGE_ID);
      if (finalStage?.status === ADMIN_STAGE_STATUSES.PENDING) {
        await runStore.renewExecutionLease(id, { executionToken });
        tracker.startStage(FINAL_STAGE_ID);
        run = await runStore.updateStageProgress(id, tracker.snapshot(), {
          executionToken,
        });
      } else {
        run = await requireRun(id);
      }
      const profile = run.executionProfile.finalRuling;
      const prompt = run.executionProfile.prompt;
      const finalInput = buildFinalRulingInput(run.evidenceSnapshot);
      const providerCreateRequest = {
        model: profile.requestedModel || profile.model,
        reasoningEffort: profile.reasoningEffort,
        reasoningMode: profile.reasoningMode,
        instructions: prompt.instructions,
        input: finalInput,
        maxOutputTokens: profile.maxOutputTokens,
        metadata: {
          runId: id,
          promptVersion: prompt.version || DEFAULT_PROMPT_VERSION,
        },
      };
      await runStore.renewExecutionLease(id, { executionToken });
      const submission = await runStore.beginProviderSubmission(id, {
        executionToken,
        providerId: "openai",
        requestFingerprint: sha256(JSON.stringify({
          model: providerCreateRequest.model,
          reasoningEffort: providerCreateRequest.reasoningEffort,
          reasoningMode: providerCreateRequest.reasoningMode,
          promptSha256: prompt.sha256,
          input: finalInput,
        })),
      });
      let request;
      try {
        const response = await withExecutionLeaseHeartbeat({
          runId: id,
          executionToken,
          operation: (signal) => openAIProvider.create({
            ...providerCreateRequest,
            signal,
          }),
        });
        request = normalizeProviderRequest(response, profile.model);
      } catch (error) {
        const failed = await settleProviderCreateFailure({
          runId: id,
          executionToken,
          submissionIntent: submission.submissionIntent,
          error,
        });
        return immutableJson({ run: failed, providerRequest: null });
      }

      try {
        await runStore.recordProviderSubmissionAccepted(id, {
          executionToken,
          attemptId: submission.submissionIntent.attemptId,
          providerId: "openai",
          requestId: request.requestId,
        });
      } catch (persistenceError) {
        const current = await requireRun(id);
        const persistedSubmission = current.execution?.providerSubmission;
        if (
          persistedSubmission?.state === ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTED
          && persistedSubmission.requestId
        ) {
          request = {
            ...request,
            requestId: persistedSubmission.requestId,
          };
        } else {
          const ambiguous = serviceError(
            "OpenAI accepted the request, but its request id could not be durably recorded",
            "openai_submission_record_outcome_unknown",
          );
          ambiguous.cause = persistenceError;
          try {
            await runStore.markProviderSubmissionOutcomeUnknown(id, {
              executionToken,
              attemptId: submission.submissionIntent.attemptId,
              providerId: "openai",
              error: ambiguous,
            });
          } catch {
            // If persistence is unavailable, the durable SUBMITTING intent is
            // intentionally left in place. A later lease takeover converts it
            // to OUTCOME_UNKNOWN instead of issuing a second billable create.
          }
          await failRunWithStage(id, ambiguous, executionToken);
          return immutableJson({
            run: await requireRun(id),
            providerRequest: null,
          });
        }
      }
      try {
        await runStore.appendEvent(id, {
          type: ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_REQUEST_CREATED,
          payload: request,
          executionToken,
        });
      } catch {
        // The accepted request id is already durable in the run record. This
        // compatibility event is useful for old readers but is not authoritative.
      }
      run = await requireRun(id);
      if (run.status === ADMIN_RUN_STATUSES.CANCEL_REQUESTED) {
        run = await retryProviderCancellation({
          run,
          requestId: request.requestId,
          executionToken,
        });
      }
      await releaseLeaseIfOwned(id, executionToken);
      return immutableJson({ run, providerRequest: request });
    } catch (error) {
      if (error?.code === "admin_run_cancelled_during_preparation") {
        return immutableJson({ run: await requireRun(id), providerRequest: null });
      }
      const current = await requireRun(id);
      if (TERMINAL_RUN_STATUSES.has(current.status)) {
        return immutableJson({ run: current, providerRequest: null });
      }
      const submissionState = current.execution?.providerSubmission?.state;
      if (
        error?.code === "admin_run_execution_fenced"
        || error?.code === "admin_run_execution_lease_active"
      ) {
        const context = await readProviderContext(id);
        return immutableJson({ run: current, providerRequest: context.request });
      }
      if (
        submissionState === ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN
        || submissionState === ADMIN_PROVIDER_SUBMISSION_STATES.REJECTED
      ) {
        await failRunWithStage(
          id,
          providerSubmissionTerminalError(current.execution.providerSubmission),
          executionToken,
        );
        return immutableJson({ run: await requireRun(id), providerRequest: null });
      }
      if (submissionState === ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTED) {
        const context = await readProviderContext(id);
        return immutableJson({ run: current, providerRequest: context.request });
      }
      if (
        current.status === ADMIN_RUN_STATUSES.RUNNING
        && /cannot start admin run from RUNNING/u.test(String(error?.message || ""))
      ) {
        return immutableJson({ run: current, providerRequest: null });
      }
      if (current.status === ADMIN_RUN_STATUSES.CANCEL_REQUESTED) {
        const cancelled = await markRunCancelled(id, {
          reason: current.cancellation?.reason || "operator cancelled",
        });
        return immutableJson({ run: cancelled, providerRequest: null });
      }
      if (current.preparationFinalizedAt && !executionToken) {
        // Another worker may have finalized before this instance obtained its
        // lease. Preserve the frozen snapshot for the lease owner.
        return immutableJson({ run: current, providerRequest: null });
      }
      await failRunWithStage(id, error, executionToken);
      throw error;
    } finally {
      activeExecutionRunIds.delete(id);
    }
  }

  async function getRun({ runId, reconcile = true } = {}) {
    const run = await requireRun(runId);
    if (
      reconcile !== false
      && [ADMIN_RUN_STATUSES.RUNNING, ADMIN_RUN_STATUSES.CANCEL_REQUESTED].includes(run.status)
    ) {
      return pollRun({ runId: run.runId });
    }
    return run;
  }

  async function pollRun({ runId } = {}) {
    const id = requiredString(runId, "runId");
    let run = await requireRun(id);
    if (TERMINAL_RUN_STATUSES.has(run.status) || run.status === ADMIN_RUN_STATUSES.QUEUED) return run;
    const context = await readProviderContext(id);
    if (!context.request?.requestId) {
      if (
        [
          ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTING,
          ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN,
          ADMIN_PROVIDER_SUBMISSION_STATES.REJECTED,
        ].includes(run.execution?.providerSubmission?.state)
      ) {
        return reconcileProviderSubmissionWithoutRequest(id, run);
      }
      if (run.status === ADMIN_RUN_STATUSES.CANCEL_REQUESTED) {
        return markRunCancelled(id, { reason: run.cancellation?.reason || "cancelled before provider request" });
      }
      return run;
    }
    if (!openAIProvider || typeof openAIProvider.retrieve !== "function") {
      throw serviceError("OpenAI background retrieval is not configured", "final_ruling_provider_unavailable");
    }

    let claim;
    try {
      claim = await runStore.acquireExecutionLease(id, {
        ownerId: `${serviceInstanceId}:poll:${randomUUID()}`,
      });
    } catch (error) {
      if (error?.code === "admin_run_execution_lease_active") return requireRun(id);
      throw error;
    }
    const executionToken = claim.executionToken;
    try {
      let response;
      try {
        response = await withExecutionLeaseHeartbeat({
          runId: id,
          executionToken,
          operation: (signal) => openAIProvider.retrieve(
            context.request.requestId,
            { signal },
          ),
        });
      } catch (error) {
        if (error?.code === "admin_run_execution_fenced") return requireRun(id);
        try {
          await runStore.appendEvent(id, {
            type: ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_POLL_ERROR,
            payload: normalizeError(error),
            executionToken,
          });
        } catch {
          // A newer lease owner is authoritative.
        }
        throw error;
      }
      const providerStatus = normalizeProviderStatus(response?.status);
      if (providerStatus !== context.lastStatus) {
        await runStore.appendEvent(id, {
          type: ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_STATUS_CHANGED,
          payload: {
            requestId: context.request.requestId,
            status: providerStatus,
          },
          executionToken,
        });
      }
      run = await requireRun(id);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return run;

      if (OPENAI_ACTIVE_STATUSES.has(providerStatus)) {
        if (run.status === ADMIN_RUN_STATUSES.CANCEL_REQUESTED) {
          return await retryProviderCancellation({
            run,
            requestId: context.request.requestId,
            executionToken,
          });
        }
        return run;
      }
      if (providerStatus === "cancelled") {
        return await markRunCancelled(id, {
          reason: run.cancellation?.reason || "provider cancelled",
          executionToken,
        });
      }
      if (OPENAI_FAILURE_STATUSES.has(providerStatus)) {
        const error = serviceError(
          response?.error?.message || `OpenAI response ended with ${providerStatus}`,
          response?.error?.code || `openai_response_${providerStatus}`,
        );
        await failRunWithStage(id, error, executionToken);
        return requireRun(id);
      }
      if (providerStatus !== "completed") {
        const error = serviceError(
          `unsupported OpenAI response status: ${providerStatus || "(missing)"}`,
          "openai_response_status_unknown",
        );
        await failRunWithStage(id, error, executionToken);
        return requireRun(id);
      }
      return await completeRunFromProviderResponse(
        run,
        response,
        context.request,
        executionToken,
      );
    } finally {
      await releaseLeaseIfOwned(id, executionToken);
    }
  }

  async function cancelRun({ runId, body = {} } = {}) {
    const id = requiredString(runId, "runId");
    let run = await requireRun(id);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    const reason = String(body.reason || "operator requested cancellation");
    const requestedBy = String(body.requestedBy || "admin");
    run = await runStore.requestCancellation(id, { reason, requestedBy });
    if (
      run.execution?.providerSubmission?.state
        === ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTING
    ) {
      return run;
    }
    const context = await readProviderContext(id);
    if (!context.request?.requestId) return markRunCancelled(id, { reason });
    if (!openAIProvider || typeof openAIProvider.cancel !== "function") return run;
    let claim;
    try {
      claim = await runStore.acquireExecutionLease(id, {
        ownerId: `${serviceInstanceId}:cancel:${randomUUID()}`,
      });
    } catch (error) {
      if (error?.code === "admin_run_execution_lease_active") return requireRun(id);
      throw error;
    }
    const executionToken = claim.executionToken;
    try {
      const response = await withExecutionLeaseHeartbeat({
        runId: id,
        executionToken,
        operation: (signal) => openAIProvider.cancel(
          context.request.requestId,
          { signal },
        ),
      });
      const status = normalizeProviderStatus(response?.status);
      if (status === "cancelled") {
        return await markRunCancelled(id, { reason, executionToken });
      }
      return requireRun(id);
    } catch (error) {
      if (error?.code === "admin_run_execution_fenced") return requireRun(id);
      return await recordProviderCancellationFailure(id, error, executionToken);
    } finally {
      await releaseLeaseIfOwned(id, executionToken);
    }
  }

  async function replayEvents({ runId, afterSequence = 0, limit = null } = {}) {
    const id = requiredString(runId, "runId");
    const [replay, run] = await Promise.all([
      runStore.replayEvents(id, {
        afterSequence,
        limit,
      }),
      requireRun(id),
    ]);
    return immutableJson({
      ...replay,
      status: run.status,
      terminal: TERMINAL_RUN_STATUSES.has(run.status),
    });
  }

  async function prepareCompleteEvidence({ run, tracker, executionToken }) {
    const question = run.evidenceSnapshot.question;
    const questions = run.evidenceSnapshot.evidence.questions;
    const preparationModel = run.executionProfile.preparation.model;
    const startedAt = readWall(wallNow).toISOString();
    let preparationOutput;
    let data;
    let cardResolution;
    let cardTextCandidates;
    let retrieval;

    preparationOutput = await runTrackedStage(run.runId, tracker, "understand", async () => (
      runCheapPreparation({
        question,
        questions,
        preparationModel,
      })
    ), executionToken);

    data = await runTrackedStage(run.runId, tracker, "extract_card_names", async () => {
      const loaded = await loadData(dataDir);
      const allCards = Array.isArray(loaded?.cards) ? loaded.cards : [];
      cardResolution = extractCards(question, {
        cards: allCards,
        maxCards: Math.max(1, allCards.length),
        modelCardNameCandidates: preparationOutput.hints.cardNameCandidates,
      });
      return loaded;
    }, executionToken);

    cardTextCandidates = await runTrackedStage(run.runId, tracker, "retrieve_card_texts", async () => (
      collectCompleteCardTextCandidates({
        data,
        cardResolution,
      })
    ), executionToken);

    retrieval = await runTrackedStage(run.runId, tracker, "retrieve_rulings_evidence", async () => {
      const exhaustiveEnv = buildExhaustiveRetrievalEnv(env, data, {
        liveOfficialQaEnabled,
      });
      return retrieveEvidence({
        userQuery: question,
        cardResolution,
        dataDir,
        cards: data?.cards,
        records: data?.records,
        qaRecords: data?.qaRecords,
        ruleSearchQueries: preparationOutput.hints.ruleSearchQueries,
        enableLiveOfficialQa: liveOfficialQaEnabled,
        maxPerBucket: exhaustiveEvidenceLimit(data),
        env: exhaustiveEnv,
        fetchImpl: retrievalFetchImpl,
      });
    }, executionToken);

    const evidenceArchive = createAdminEvidenceArchive({
      evidenceBuckets: jsonSafe(retrieval),
      cardTextCandidates: jsonSafe(cardTextCandidates),
      retrievalWarnings: retrieval?.retrievalWarnings || [],
      metadata: {
        questionSha256: sha256(question),
        retrievalMetadata: collectRetrievalMetadata(retrieval),
      },
    });
    const evidenceDecisionPacket = buildAdminEvidenceDecisionPacket({
      archive: evidenceArchive,
    });
    const conflicts = collectEvidenceConflicts({
      cardResolution,
      retrieval,
      evidenceArchive,
    });
    const completeness = buildCompletenessReport({
      cardResolution,
      retrieval,
      conflicts,
      data,
      evidenceArchive,
      evidenceDecisionPacket,
    });
    const endedAt = readWall(wallNow).toISOString();
    return {
      startedAt,
      endedAt,
      completeness,
      snapshotEvidence: {
        questions,
        providedFacts: run.executionProfile.providedFacts,
        preparation: {
          provider: "deepseek",
          model: preparationModel,
          canMakeFinalRuling: false,
          canDecideEscalation: false,
          rawResult: preparationOutput.rawResult,
          extractedHints: preparationOutput.hints,
          warnings: preparationOutput.warnings,
          usage: preparationOutput.usage,
        },
        cardResolution: jsonSafe(cardResolution),
        evidenceArchive,
        evidenceDecisionPacket,
        retrievalMetadata: collectRetrievalMetadata(retrieval),
        unresolved: {
          cardMentions: jsonSafe(cardResolution?.unresolvedMentions || []),
          ambiguousMentions: jsonSafe(cardResolution?.ambiguousMentions || []),
          remainingAfterRetrieval: jsonSafe(retrieval?.remainingUnresolvedMentions || []),
        },
        conflicts,
        retrievalWarnings: jsonSafe(retrieval?.retrievalWarnings || []),
        completeness,
      },
    };
  }

  async function runCheapPreparation({
    question,
    questions,
    preparationModel,
    suppliedHints,
  }) {
    const warnings = [];
    let rawResult = null;
    let usage = null;
    if (deepSeekProvider && typeof deepSeekProvider.prepareEvidence === "function") {
      const prepared = await deepSeekProvider.prepareEvidence({
        model: preparationModel,
        input: buildPreparationInput({ question, questions }),
        metadata: {
          role: "evidence_preparation_only",
          finalRulingForbidden: "true",
        },
      });
      rawResult = jsonSafe(prepared);
      usage = jsonSafe(extractPreparationUsage(prepared));
    } else {
      warnings.push("deepseek_preparation_provider_unavailable");
    }
    const hints = mergePreparationHints(
      normalizePreparationHints(rawResult),
      normalizePreparationHints(suppliedHints),
    );
    return {
      rawResult,
      usage,
      hints,
      warnings,
    };
  }

  async function withExecutionLeaseHeartbeat({
    runId,
    executionToken,
    operation,
  }) {
    if (typeof operation !== "function") {
      throw new TypeError("lease heartbeat operation must be a function");
    }
    const controller = new AbortController();
    let stopped = false;
    let timer = null;
    let heartbeatInFlight = null;
    let heartbeatError = null;

    const schedule = () => {
      if (stopped || heartbeatError) return;
      timer = setTimeout(() => {
        if (stopped || heartbeatError) return;
        heartbeatInFlight = runStore.renewExecutionLease(runId, {
          executionToken,
        }).catch((error) => {
          heartbeatError = error;
          controller.abort(error);
        }).finally(() => {
          heartbeatInFlight = null;
          schedule();
        });
      }, executionHeartbeatMs);
      timer.unref?.();
    };

    schedule();
    let value;
    let operationError = null;
    try {
      value = await operation(controller.signal);
    } catch (error) {
      operationError = error;
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      const pendingHeartbeat = heartbeatInFlight;
      if (pendingHeartbeat) await pendingHeartbeat;
    }
    if (heartbeatError) throw heartbeatError;
    if (operationError) throw operationError;
    await runStore.renewExecutionLease(runId, { executionToken });
    return value;
  }

  async function releaseLeaseIfOwned(runId, executionToken) {
    if (!executionToken) return;
    try {
      await runStore.releaseExecutionLease(runId, { executionToken });
    } catch (error) {
      if (
        error?.code === "admin_run_execution_fenced"
        || error?.code === "admin_run_not_found"
      ) {
        return;
      }
      const current = await requireRun(runId);
      if (TERMINAL_RUN_STATUSES.has(current.status)) return;
      throw error;
    }
  }

  async function runTrackedStage(runId, tracker, stageId, operation, executionToken) {
    await runStore.renewExecutionLease(runId, { executionToken });
    tracker.startStage(stageId);
    await runStore.updateStageProgress(runId, tracker.snapshot(), {
      executionToken,
    });
    const value = await withExecutionLeaseHeartbeat({
      runId,
      executionToken,
      operation,
    });
    tracker.finishStage(stageId);
    await runStore.updateStageProgress(runId, tracker.snapshot(), {
      executionToken,
    });
    if (await runStore.isCancellationRequested(runId)) {
      const run = await requireRun(runId);
      const timing = tracker.cancel({
        reason: run.cancellation?.reason || "operator cancelled",
        requestedBy: run.cancellation?.requestedBy || "admin",
      });
      await runStore.markCancelled(runId, {
        reason: run.cancellation?.reason || "operator cancelled",
        stageTiming: timing,
        executionToken,
      });
      throw serviceError(
        "run cancelled during evidence preparation",
        "admin_run_cancelled_during_preparation",
      );
    }
    return value;
  }

  async function completeRunFromProviderResponse(
    run,
    response,
    request,
    executionToken = null,
  ) {
    const questionIds = run.executionProfile?.questionIds || [];
    const providedFacts = run.executionProfile?.providedFacts || [];
    const validation = typeof openAIProvider.validateCompletedResponse === "function"
      ? openAIProvider.validateCompletedResponse(response, {
        evidenceSnapshot: run.evidenceSnapshot,
        modelVisibleEvidencePacket: finalRulingModelEvidencePacket(run.evidenceSnapshot),
        expectedQuestionIds: questionIds,
        providedFacts,
      })
      : parseAndValidateModelRulingResult(extractOpenAIResponseOutputText(response), {
        evidenceSnapshot: run.evidenceSnapshot,
        modelVisibleEvidencePacket: finalRulingModelEvidencePacket(run.evidenceSnapshot),
        expectedQuestionIds: questionIds,
        providedFacts,
      });
    if (!validation?.ok) {
      await runStore.appendEvent(run.runId, {
        type: ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_VALIDATION_FAILED,
        payload: { errors: jsonSafe(validation?.errors || ["model result validation failed"]) },
        executionToken,
      });
      const error = serviceError(
        `final ruling validation failed: ${(validation?.errors || []).join("; ")}`,
        "model_ruling_validation_failed",
      );
      await failRunWithStage(run.runId, error, executionToken);
      return requireRun(run.runId);
    }

    const profile = run.executionProfile?.finalRuling || {};
    const pricingProfile = run.executionProfile?.pricing || {};
    const usage = normalizeOpenAIResponsesUsage(response.usage || {});
    const cost = estimateOpenAIModelCost({
      model: response.model || profile.model,
      usage: response.usage || {},
      reasoningMode: profile.reasoningMode || "standard",
      usdToCnyRate: pricingProfile.usdToCnyRate,
      exchangeRateVersion: pricingProfile.exchangeRateVersion,
    });
    const metering = buildAdminModelLabMetering({
      run,
      finalResponse: response,
      finalUsage: usage,
      finalCost: cost,
    });
    const restored = restoreTracker(run, { targetElapsedMs: currentElapsedMs(run) });
    const restoredFinalStage = restored.tracker
      .snapshot()
      .stages
      .find((stage) => stage.id === FINAL_STAGE_ID);
    if (restoredFinalStage?.status === ADMIN_STAGE_STATUSES.PENDING) {
      restored.tracker.startStage(FINAL_STAGE_ID);
      restored.tracker.finishStage(FINAL_STAGE_ID);
    } else if (restoredFinalStage?.status === ADMIN_STAGE_STATUSES.RUNNING) {
      restored.tracker.finishStage(FINAL_STAGE_ID);
    } else if (restoredFinalStage?.status !== ADMIN_STAGE_STATUSES.COMPLETED) {
      throw serviceError(
        `cannot complete final stage from ${restoredFinalStage?.status || "(missing)"}`,
        "admin_stage_timing_not_completable",
      );
    }
    const stageTiming = restored.tracker.complete();
    const latency = buildLatencyMetrics(run, stageTiming, response);
    const result = {
      schemaVersion: 1,
      evidenceSnapshotId: run.evidenceSnapshot.snapshotId,
      finalRuling: validation.normalized,
      validation: {
        ok: true,
        errors: [],
      },
      provider: {
        providerId: "openai",
        requestId: request.requestId,
        model: response.model || profile.model,
        status: "completed",
      },
      // Backward-compatible aliases: these continue to mean the OpenAI final
      // stage. The complete two-stage view lives in metering/metrics below.
      usage,
      cost,
      metering,
      metrics: {
        usage: metering.totals.usage,
        cost: metering.totals.cost,
        estimatedCostUsd: metering.totals.cost.totalCostUsd,
        knownCostUsd: metering.totals.cost.knownCostUsd,
        stageUsage: {
          evidencePreparation: metering.stages.evidencePreparation.usage,
          finalRuling: metering.stages.finalRuling.usage,
        },
        stageCosts: {
          evidencePreparation: metering.stages.evidencePreparation.cost,
          finalRuling: metering.stages.finalRuling.cost,
        },
        latency,
      },
      latency,
      prompt: {
        version: run.executionProfile?.prompt?.version || DEFAULT_PROMPT_VERSION,
        sha256: run.executionProfile?.prompt?.sha256 || null,
      },
    };
    return runStore.completeRun(run.runId, {
      result,
      stageTiming,
      executionToken,
    });
  }

  async function settleProviderCreateFailure({
    runId,
    executionToken,
    submissionIntent,
    error,
  }) {
    const outcomeKnown = error?.outcomeKnown === true;
    const settle = outcomeKnown
      ? runStore.recordProviderSubmissionRejected
      : runStore.markProviderSubmissionOutcomeUnknown;
    try {
      await settle(runId, {
        executionToken,
        attemptId: submissionIntent.attemptId,
        providerId: submissionIntent.providerId,
        error,
      });
    } catch (settleError) {
      const current = await requireRun(runId);
      if (TERMINAL_RUN_STATUSES.has(current.status)) return current;
      if (
        settleError?.code !== "admin_run_execution_fenced"
        && settleError?.code !== "admin_run_provider_submission_fenced"
      ) {
        // Continue to an explicit terminal failure. If the submission-state
        // write was unavailable, the durable SUBMITTING intent still prevents
        // another create for this run.
      }
    }
    const terminalError = outcomeKnown
      ? error
      : serviceError(
        "OpenAI submission outcome is unknown; automatic resubmission is disabled to avoid duplicate charges",
        "openai_submission_outcome_unknown",
      );
    await failRunWithStage(runId, terminalError, executionToken);
    return requireRun(runId);
  }

  async function failRunWithStage(runId, error, executionToken = null) {
    let run = await requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    let stageTiming;
    if (run.stageTiming) {
      try {
        const restored = restoreTracker(run, { targetElapsedMs: currentElapsedMs(run) });
        stageTiming = restored.tracker.cancel({
          reason: "run_failed",
          requestedBy: "admin_model_lab_service",
        });
      } catch {
        // The run error remains authoritative even if a stale timing snapshot
        // cannot be reconstructed after a concurrent terminal transition.
      }
    }
    run = await requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    return runStore.failRun(runId, {
      error,
      stageTiming,
      executionToken,
    });
  }

  async function markRunCancelled(runId, {
    reason,
    executionToken = null,
  }) {
    let run = await requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    let stageTiming;
    if (run.stageTiming) {
      if (run.stageTiming.status === ADMIN_TRACKER_STATUSES.CANCELLED) {
        stageTiming = run.stageTiming;
      } else {
        const restored = restoreTracker(run, { targetElapsedMs: currentElapsedMs(run) });
        stageTiming = restored.tracker.cancel({
          reason,
          requestedBy: run.cancellation?.requestedBy || "admin",
        });
      }
    }
    return runStore.markCancelled(runId, {
      reason,
      stageTiming,
      executionToken,
    });
  }

  async function retryProviderCancellation({
    run,
    requestId,
    executionToken,
  }) {
    if (!openAIProvider || typeof openAIProvider.cancel !== "function") return run;
    try {
      const response = await withExecutionLeaseHeartbeat({
        runId: run.runId,
        executionToken,
        operation: (signal) => openAIProvider.cancel(requestId, { signal }),
      });
      if (normalizeProviderStatus(response?.status) === "cancelled") {
        return markRunCancelled(run.runId, {
          reason: run.cancellation?.reason || "operator cancelled",
          executionToken,
        });
      }
      return requireRun(run.runId);
    } catch (error) {
      if (error?.code === "admin_run_execution_fenced") return requireRun(run.runId);
      return recordProviderCancellationFailure(run.runId, error, executionToken);
    }
  }

  async function recordProviderCancellationFailure(
    runId,
    error,
    executionToken = null,
  ) {
    let run = await requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    try {
      await runStore.appendEvent(runId, {
        type: ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_CANCEL_FAILED,
        payload: normalizeError(error),
        executionToken,
      });
    } catch (appendError) {
      run = await requireRun(runId);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
      throw appendError;
    }
    return requireRun(runId);
  }

  async function readProviderContext(runId) {
    const [run, replay] = await Promise.all([
      requireRun(runId),
      runStore.replayEvents(runId, { afterSequence: 0 }),
    ]);
    const durableSubmission = run.execution?.providerSubmission;
    let request = durableSubmission?.state === ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTED
      && durableSubmission.requestId
      ? {
        providerId: durableSubmission.providerId || "openai",
        requestId: durableSubmission.requestId,
        status: "queued",
        model: run.executionProfile?.finalRuling?.model || "",
        createdAt: durableSubmission.acceptedAt || null,
      }
      : null;
    let lastStatus = request ? normalizeProviderStatus(request.status) : null;
    for (const event of replay.events) {
      if (event.type === ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_REQUEST_CREATED) {
        if (!request || event.payload?.requestId === request.requestId) {
          request = event.payload;
        }
        lastStatus = normalizeProviderStatus(event.payload?.status);
      } else if (
        event.type === ADMIN_MODEL_LAB_SERVICE_EVENT_TYPES.MODEL_STATUS_CHANGED
        && request
        && event.payload?.requestId === request.requestId
      ) {
        lastStatus = normalizeProviderStatus(event.payload?.status);
      }
    }
    return { request, lastStatus };
  }

  async function reconcileProviderSubmissionWithoutRequest(runId, observedRun) {
    const state = observedRun.execution?.providerSubmission?.state;
    if (![
      ADMIN_PROVIDER_SUBMISSION_STATES.SUBMITTING,
      ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN,
      ADMIN_PROVIDER_SUBMISSION_STATES.REJECTED,
    ].includes(state)) {
      return observedRun;
    }
    let claim;
    try {
      claim = await runStore.acquireExecutionLease(runId, {
        ownerId: `${serviceInstanceId}:reconcile-submit:${randomUUID()}`,
      });
    } catch (error) {
      if (error?.code === "admin_run_execution_lease_active") return requireRun(runId);
      throw error;
    }
    const submission = claim.run.execution?.providerSubmission;
    if (
      submission?.state === ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN
      || submission?.state === ADMIN_PROVIDER_SUBMISSION_STATES.REJECTED
    ) {
      await failRunWithStage(
        runId,
        providerSubmissionTerminalError(submission),
        claim.executionToken,
      );
      return requireRun(runId);
    }
    await releaseLeaseIfOwned(runId, claim.executionToken);
    return requireRun(runId);
  }

  async function requireRun(runId) {
    const id = requiredString(runId, "runId");
    const run = await runStore.getRun(id);
    if (!run) throw serviceError(`admin run not found: ${id}`, "admin_run_not_found");
    return run;
  }

  function restoreTracker(run, { targetElapsedMs = 0 } = {}) {
    const timing = run.stageTiming;
    if (!timing) throw serviceError("run has no stage timing", "admin_stage_timing_missing");
    let clock = 0;
    const originMs = Date.parse(timing.createdAt || run.createdAt);
    const tracker = stageTrackerFactory({
      runId: run.runId,
      monotonicNow: () => clock,
      wallNow: () => new Date(originMs + clock),
      speedThresholds: timing.speedThresholds,
    });
    for (const definition of ADMIN_RUN_STAGE_CATALOG) {
      const stage = timing.stages?.find((item) => item.id === definition.id);
      if (!stage || stage.status === ADMIN_STAGE_STATUSES.PENDING) continue;
      if (stage.status === ADMIN_STAGE_STATUSES.SKIPPED) {
        tracker.skipStage(stage.id, { reason: stage.skipReason || "" });
        continue;
      }
      clock = Math.max(clock, numberOrZero(stage.startOffsetMs));
      tracker.startStage(stage.id);
      if (stage.status === ADMIN_STAGE_STATUSES.COMPLETED) {
        clock = Math.max(clock, numberOrZero(stage.endOffsetMs));
        tracker.finishStage(stage.id);
      } else if (stage.status === ADMIN_STAGE_STATUSES.RUNNING) {
        break;
      } else {
        throw serviceError(
          `cannot restore ${stage.id} from ${stage.status}`,
          "admin_stage_timing_not_restorable",
        );
      }
    }
    clock = Math.max(clock, numberOrZero(timing.totalElapsedMs), numberOrZero(targetElapsedMs));
    return { tracker, get clock() { return clock; } };
  }

  function currentElapsedMs(run) {
    const origin = Date.parse(run.stageTiming?.createdAt || run.createdAt);
    const now = readWall(wallNow).getTime();
    return Math.max(numberOrZero(run.stageTiming?.totalElapsedMs), now - origin, 0);
  }

  return Object.freeze({
    persistence: Object.freeze({
      runStore: runStore.persistent === true,
      runStoreKind: String(runStore.storageKind || runStore.kind || "unknown"),
      runTtlSeconds: runStore.ttlSeconds ?? null,
    }),
    capabilities,
    createRun,
    executeRun,
    getRun,
    pollRun,
    cancelRun,
    replayEvents,
  });
}

function collectCompleteCardTextCandidates({ data, cardResolution }) {
  const cards = Array.isArray(data?.cards) ? data.cards : [];
  const byId = new Map(cards.map((card) => [String(card.id || card.cardId || ""), card]));
  const resolved = (cardResolution?.resolvedCards || []).map((card) => {
    const source = byId.get(String(card.id || card.cardId || "")) || card;
    return {
      resolution: jsonSafe(card),
      rawCardRecord: jsonSafe(source),
    };
  });
  return {
    resolved,
    userProvidedCardTexts: jsonSafe(cardResolution?.userProvidedCardTexts || []),
    unresolvedMentions: jsonSafe(cardResolution?.unresolvedMentions || []),
    ambiguousMentions: jsonSafe(cardResolution?.ambiguousMentions || []),
    omittedResolvedCards: jsonSafe(cardResolution?.omittedResolvedCards || []),
  };
}

function buildPreparationInput({ question, questions }) {
  return JSON.stringify({
    role: "evidence_preparation_only",
    prohibitions: [
      "do_not_make_final_ruling",
      "do_not_decide_whether_to_escalate",
      "do_not_discard_candidates",
    ],
    task: [
      "extract every possible card-name surface form",
      "produce broad rule-search queries",
      "preserve ambiguities, conflicts, and unresolved mentions",
    ],
    outputShape: {
      cardNameCandidates: [{ name: "string", originalText: "string" }],
      ruleSearchQueries: [{ query: "string", reason: "string" }],
      unresolvedNotes: ["string"],
      conflicts: ["string"],
    },
    question,
    questions,
  });
}

function normalizePreparationHints(value) {
  const parsed = unwrapPreparationPayload(value);
  return {
    cardNameCandidates: normalizeCardNameCandidates(parsed?.cardNameCandidates),
    ruleSearchQueries: normalizeRuleQueries(parsed?.ruleSearchQueries),
    unresolvedNotes: normalizeStringList(parsed?.unresolvedNotes),
    conflicts: normalizeStringList(parsed?.conflicts),
  };
}

function unwrapPreparationPayload(value) {
  if (!value) return {};
  if (typeof value === "string") return parseJsonObject(value);
  if (typeof value !== "object") return {};
  const candidate = value.result ?? value.output ?? value.content ?? value.text ?? value;
  if (typeof candidate === "string") return parseJsonObject(candidate);
  if (candidate && typeof candidate === "object") return candidate;
  return {};
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergePreparationHints(...values) {
  return {
    cardNameCandidates: dedupeJson(
      values.flatMap((value) => value.cardNameCandidates || []),
      (item) => `${item.name}\u0000${item.originalText}`,
    ),
    ruleSearchQueries: dedupeJson(
      values.flatMap((value) => value.ruleSearchQueries || []),
      (item) => item.query,
    ),
    unresolvedNotes: [...new Set(values.flatMap((value) => value.unresolvedNotes || []))],
    conflicts: [...new Set(values.flatMap((value) => value.conflicts || []))],
  };
}

function normalizeCardNameCandidates(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return { name: item.trim(), originalText: item.trim() };
    return {
      name: String(item?.name || "").trim(),
      originalText: String(item?.originalText || item?.name || "").trim(),
    };
  }).filter((item) => item.name);
}

function normalizeRuleQueries(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return { query: item.trim(), reason: "deepseek_preparation" };
    return {
      query: String(item?.query || "").trim(),
      reason: String(item?.reason || "deepseek_preparation"),
    };
  }).filter((item) => item.query);
}

function collectEvidenceConflicts({
  cardResolution,
  retrieval,
  evidenceArchive,
}) {
  const conflicts = [
    ...(cardResolution?.ambiguousMentions || []).map((mention) => ({
      type: "ambiguous_card_mention",
      mention: jsonSafe(mention),
    })),
    ...(cardResolution?.resolvedCards || [])
      .filter((card) => card.numberedIdentityNameMismatch)
      .map((card) => ({
        type: "numbered_identity_name_mismatch",
        card: jsonSafe(card),
      })),
    ...(evidenceArchive?.conflicts || []).map((conflict) => jsonSafe(conflict)),
  ];
  const direct = retrieval?.officialQaDirectCandidates || [];
  const directAnswers = new Set(direct.map(evidenceAnswerFingerprint).filter(Boolean));
  if (directAnswers.size > 1) {
    conflicts.push({
      type: "conflicting_direct_official_candidates",
      evidenceIds: direct.map((item) => item.id).filter(Boolean),
    });
  }
  return jsonSafe(conflicts);
}

function buildCompletenessReport({
  cardResolution,
  retrieval,
  conflicts,
  data,
  evidenceArchive,
  evidenceDecisionPacket,
}) {
  const warnings = retrieval?.retrievalWarnings || [];
  const truncationWarnings = warnings.filter((warning) => (
    /(?:limited|truncated|limit_exceeded)/iu.test(String(warning))
  ));
  return {
    allRetrievedCandidatesPreserved: true,
    cheapModelSelectionApplied: false,
    unresolvedMentionsPreserved: true,
    ambiguousMentionsPreserved: true,
    conflictsPreserved: true,
    allProvidedCandidateOccurrencesArchived:
      evidenceArchive?.completeness?.allProvidedCandidateOccurrencesArchived === true,
    repeatedEvidenceBodiesStoredOnce:
      evidenceArchive?.completeness?.repeatedBodiesStoredOnce === true,
    rawEvidenceBucketsPreservedInArchive: true,
    retrievedEvidenceCount: evidenceArchive?.statistics?.inputOccurrenceCount || 0,
    uniqueEvidenceIdCount: evidenceArchive?.statistics?.uniqueEvidenceIdCount || 0,
    uniqueEvidenceBodyCount: evidenceArchive?.statistics?.uniqueBodyCount || 0,
    resolvedCardCount: cardResolution?.resolvedCards?.length || 0,
    unresolvedMentionCount: cardResolution?.unresolvedMentions?.length || 0,
    ambiguousMentionCount: cardResolution?.ambiguousMentions?.length || 0,
    allCardNamesResolved:
      (cardResolution?.unresolvedMentions?.length || 0) === 0
      && (cardResolution?.ambiguousMentions?.length || 0) === 0,
    conflictCount: conflicts.length,
    sourceCorpusCounts: {
      cards: data?.cards?.length || 0,
      records: data?.records?.length || 0,
      qaRecords: data?.qaRecords?.length || 0,
    },
    retrievalTruncationWarnings: jsonSafe(truncationWarnings),
    retrieverCandidateSetUntruncated: truncationWarnings.length === 0,
    completeWithinRetrieverCandidateSet: truncationWarnings.length === 0,
    sourceCoverage: "UNKNOWN",
    evidenceSufficiency: "NOT_ASSESSED",
    decisiveMechanismCoverageComplete: false,
    decisionPacketTruncated:
      evidenceDecisionPacket?.modelPacket?.completeness?.decisionPacketTruncated === true,
    decisionPacketIncludedEvidenceCount:
      evidenceDecisionPacket?.statistics?.includedSubstanceCount || 0,
    decisionPacketOmittedEvidenceCount:
      evidenceDecisionPacket?.statistics?.omittedSubstanceCount || 0,
  };
}

function buildExhaustiveRetrievalEnv(baseEnv, data, { liveOfficialQaEnabled }) {
  const evidenceCount = exhaustiveEvidenceLimit(data);
  const cardCount = Math.max(1, data?.cards?.length || 0);
  return {
    ...baseEnv,
    RAG_LIVE_OFFICIAL_QA: liveOfficialQaEnabled ? "true" : "false",
    RAG_MAX_CARDS: String(cardCount),
    RAG_MAX_OFFICIAL_QA: String(evidenceCount),
    RAG_MAX_RELATED_EVIDENCE: String(evidenceCount),
    RAG_MAX_RULE_SEARCH_QUERIES: String(Math.max(512, evidenceCount)),
    RAG_MAX_RULEBOOK_CANDIDATES: String(evidenceCount),
    RAG_MAX_RULEBOOK_PASSAGE_CHARS: "1000000",
    RAG_MAX_CARD_TEXT_CHARS: "1000000",
    RAG_MAX_EVIDENCE_TEXT_CHARS: "1000000",
  };
}

function exhaustiveEvidenceLimit(data) {
  return Math.max(
    64,
    numberOrZero(data?.records?.length) + numberOrZero(data?.qaRecords?.length),
  );
}

export function buildFinalRulingInput(snapshot) {
  const evidence = snapshot?.evidence || {};
  const boundedInput = {
    schemaVersion: 1,
    evidenceSnapshotId: snapshot?.snapshotId || null,
    evidenceSnapshotSha256: snapshot?.contentSha256 || null,
    question: snapshot?.question || "",
    questions: evidence.questions || [],
    providedFacts: evidence.providedFacts || [],
    cardResolution: compactCardResolutionForModel(evidence.cardResolution),
    unresolved: evidence.unresolved || {},
    retrievalWarnings: evidence.retrievalWarnings || [],
    completeness: evidence.completeness || {},
    evidenceDecisionPacket: finalRulingModelEvidencePacket(snapshot),
    dataVersions: snapshot?.dataVersions || {},
    metadata: snapshot?.metadata || {},
  };
  const input = [
    "以下是从完整、冻结且通过内容哈希校验的 Evidence Snapshot 生成的有界决策资料包。",
    "完整候选与完整冲突均保存在审计归档中；此处只包含确定性分层规则选出的卡文、FAQ 与机制资料，以及有界冲突目录、完整计数/哈希、遗漏和截断摘要。",
    "DeepSeek 只提供候选卡名与补充检索词，不是裁定；确定性查询始终优先，但其补充词仍可能扩展候选集合，所以必须独立核对每条可见证据。",
    "只能引用 evidenceDecisionPacket.evidenceItems 中实际展示正文的 evidenceId/evidenceIds；omissionSummary.catalog 仅用于提示未展示的候选，不能作为可引用证据。",
    "不得调用网络搜索，不得引用快照外资料。",
    JSON.stringify(boundedInput),
  ].join("\n");
  const inputBytes = Buffer.byteLength(input, "utf8");
  if (inputBytes > MAX_FINAL_RULING_INPUT_BYTES) {
    throw serviceError(
      `final ruling input exceeds ${MAX_FINAL_RULING_INPUT_BYTES} UTF-8 bytes`,
      "final_ruling_input_too_large",
    );
  }
  return input;
}

function finalRulingModelEvidencePacket(snapshot) {
  return snapshot?.evidence?.evidenceDecisionPacket?.modelPacket || null;
}

function collectRetrievalMetadata(retrieval) {
  if (!retrieval || typeof retrieval !== "object" || Array.isArray(retrieval)) return {};
  return jsonSafe(Object.fromEntries(
    Object.entries(retrieval).filter(([, value]) => !Array.isArray(value)),
  ));
}

function compactCardResolutionForModel(cardResolution = {}) {
  return {
    resolvedCards: (cardResolution.resolvedCards || []).map((card) => ({
      id: card.id || card.cardId || null,
      passcode: card.passcode || null,
      input: card.input || null,
      name: card.name || null,
      cnName: card.cnName || null,
      jaName: card.jaName || null,
      enName: card.enName || null,
      aliases: Array.isArray(card.aliases) ? card.aliases : [],
      type: card.type || card.cardType || null,
      cardType: card.cardType || card.type || null,
      race: card.race || null,
      attribute: card.attribute || null,
      attack: finiteCardNumber(card.attack ?? card.atk),
      defense: finiteCardNumber(card.defense ?? card.def),
      level: finiteCardNumber(card.level),
      rank: finiteCardNumber(card.rank),
      link: finiteCardNumber(card.link ?? card.linkRating),
      linkArrows: card.linkArrows || null,
      propertyIds: Array.isArray(card.propertyIds) ? card.propertyIds : [],
      properties: Array.isArray(card.properties) ? card.properties : [],
      monsterPropertyIds: Array.isArray(card.monsterPropertyIds)
        ? card.monsterPropertyIds
        : [],
      monsterProperties: Array.isArray(card.monsterProperties)
        ? card.monsterProperties
        : [],
      resolutionSource: card.resolutionSource || null,
      confidence: Number.isFinite(Number(card.confidence))
        ? Number(card.confidence)
        : null,
      numberedIdentityNameMismatch: card.numberedIdentityNameMismatch === true,
    })),
    unresolvedMentions: cardResolution.unresolvedMentions || [],
    ambiguousMentions: cardResolution.ambiguousMentions || [],
    omittedResolvedCards: cardResolution.omittedResolvedCards || [],
  };
}

function finiteCardNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeProviderRequest(response, fallbackModel) {
  const requestId = String(response?.id || "").trim();
  if (!requestId) {
    throw serviceError("OpenAI background response did not include an id", "openai_response_id_missing");
  }
  return {
    providerId: "openai",
    requestId,
    status: normalizeProviderStatus(response?.status),
    model: String(response?.model || fallbackModel || ""),
    createdAt: normalizeProviderTimestamp(response?.created_at),
  };
}

function normalizeProviderStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function normalizeProviderTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  const date = Number.isFinite(number)
    ? new Date(number > 10_000_000_000 ? number : number * 1000)
    : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function buildLatencyMetrics(run, stageTiming, response) {
  const generation = stageTiming.stages.find((stage) => stage.id === FINAL_STAGE_ID);
  const providerCreatedAt = normalizeProviderTimestamp(response.created_at);
  const providerCompletedAt = normalizeProviderTimestamp(response.completed_at);
  const providerLatencyMs = providerCreatedAt && providerCompletedAt
    ? Math.max(0, Date.parse(providerCompletedAt) - Date.parse(providerCreatedAt))
    : null;
  return {
    totalWallClockMs: stageTiming.totalElapsedMs,
    preparationMs: generation?.startOffsetMs ?? null,
    finalRulingMs: generation?.durationMs ?? null,
    providerLatencyMs,
    providerCreatedAt,
    providerCompletedAt,
    stages: stageTiming.stages.map((stage) => ({
      id: stage.id,
      durationMs: stage.durationMs,
      speedLabel: stage.speedLabel,
    })),
    runStartedAt: run.startedAt,
    runEndedObservationAt: stageTiming.endedAt,
  };
}

function buildAdminModelLabMetering({
  run,
  finalResponse,
  finalUsage,
  finalCost,
}) {
  const pricingProfile = run.executionProfile?.pricing || {};
  const preparationProfile = run.executionProfile?.preparation || {};
  const preparationRawUsage = run.evidenceSnapshot?.evidence?.preparation?.usage ?? null;
  const preparationUsage = normalizeReportedModelUsage(preparationRawUsage);
  const finalRawUsage = finalResponse?.usage ?? null;
  const measuredFinalUsage = normalizeReportedModelUsage(finalRawUsage);
  const preparationCost = estimateDeepSeekModelCost({
    model: preparationProfile.model,
    usage: preparationUsage,
    pricingProfile: pricingProfile.deepSeek,
    usdToCnyRate: pricingProfile.usdToCnyRate,
    exchangeRateVersion: pricingProfile.exchangeRateVersion,
  });
  const stages = {
    evidencePreparation: {
      stageId: ADMIN_MODEL_LAB_STAGES.EVIDENCE_PREPARATION,
      provider: "deepseek",
      model: preparationProfile.model || null,
      usageStatus: preparationUsage ? "reported" : "unavailable",
      usage: preparationUsage,
      rawUsage: jsonSafe(preparationRawUsage),
      cost: preparationCost,
    },
    finalRuling: {
      stageId: ADMIN_MODEL_LAB_STAGES.FINAL_RULING,
      provider: "openai",
      model: finalResponse?.model || run.executionProfile?.finalRuling?.model || null,
      usageStatus: measuredFinalUsage ? "reported" : "unavailable",
      usage: measuredFinalUsage,
      rawUsage: jsonSafe(finalRawUsage),
      cost: finalCost,
    },
  };
  return {
    schemaVersion: 1,
    stages,
    totals: {
      usage: aggregateStageUsage(stages),
      cost: aggregateStageCosts(stages),
    },
    legacyFinalStageUsage: finalUsage,
  };
}

function aggregateStageUsage(stages) {
  const entries = Object.entries(stages);
  const available = entries.filter(([, stage]) => stage.usage);
  const missingStages = entries
    .filter(([, stage]) => !stage.usage)
    .map(([stageName]) => stageName);
  const fields = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "uncachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
  ];
  const known = Object.fromEntries(fields.map((field) => [
    `known${field[0].toUpperCase()}${field.slice(1)}`,
    available.reduce((sum, [, stage]) => sum + stage.usage[field], 0),
  ]));
  return {
    ...Object.fromEntries(fields.map((field) => [
      field,
      missingStages.length === 0 ? known[`known${field[0].toUpperCase()}${field.slice(1)}`] : null,
    ])),
    ...known,
    complete: missingStages.length === 0,
    missingStages,
  };
}

function aggregateStageCosts(stages) {
  const entries = Object.entries(stages);
  const usd = aggregateCurrency(entries, "totalCostUsd");
  const cny = aggregateCurrency(entries, "totalCostCny");
  return {
    totalCostUsd: usd.complete ? usd.knownTotal : null,
    knownCostUsd: usd.knownTotal,
    totalCostCny: cny.complete ? cny.knownTotal : null,
    knownCostCny: cny.knownTotal,
    completeInUsd: usd.complete,
    completeInCny: cny.complete,
    complete: usd.complete || cny.complete,
    missingUsdStages: usd.missingStages,
    missingCnyStages: cny.missingStages,
    pricingVersions: Object.fromEntries(entries.map(([stageName, stage]) => [
      stageName,
      stage.cost?.pricingVersion ?? null,
    ])),
    estimateOnly: true,
  };
}

function aggregateCurrency(entries, field) {
  const knownValues = [];
  const missingStages = [];
  for (const [stageName, stage] of entries) {
    const value = stage.cost?.[field];
    if (Number.isFinite(value)) knownValues.push(Number(value));
    else missingStages.push(stageName);
  }
  return {
    knownTotal: knownValues.length ? roundMeteredMoney(knownValues.reduce((sum, value) => sum + value, 0)) : null,
    complete: missingStages.length === 0,
    missingStages,
  };
}

function readServerDeepSeekPricingProfile(env) {
  return {
    pricingVersion: nullableString(env.ADMIN_MODEL_LAB_DEEPSEEK_PRICING_VERSION),
    pricingEffectiveDate: nullableString(env.ADMIN_MODEL_LAB_DEEPSEEK_PRICING_EFFECTIVE_DATE),
    inputCnyPerMillion: optionalNonNegativeNumber(
      env.ADMIN_MODEL_LAB_DEEPSEEK_INPUT_CNY_PER_MTOK,
    ),
    cachedInputCnyPerMillion: optionalNonNegativeNumber(
      env.ADMIN_MODEL_LAB_DEEPSEEK_CACHED_INPUT_CNY_PER_MTOK,
    ),
    cacheWriteInputCnyPerMillion: optionalNonNegativeNumber(
      env.ADMIN_MODEL_LAB_DEEPSEEK_CACHE_WRITE_INPUT_CNY_PER_MTOK,
    ),
    outputCnyPerMillion: optionalNonNegativeNumber(
      env.ADMIN_MODEL_LAB_DEEPSEEK_OUTPUT_CNY_PER_MTOK,
    ),
  };
}

function roundMeteredMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e9) / 1e9;
}

function extractPreparationUsage(prepared) {
  return prepared?.usage
    || prepared?.result?.usage
    || prepared?.result?.response?.usage
    || null;
}

function evidenceAnswerFingerprint(item) {
  const text = String(
    item?.answer
    || item?.officialText
    || item?.fullText
    || item?.text
    || "",
  ).replace(/\s+/gu, "");
  return text ? sha256(text) : "";
}

function normalizeQuestions(body) {
  if (Array.isArray(body.questions) && body.questions.length) {
    const ids = new Set();
    return body.questions.map((item, index) => {
      const questionId = requiredString(
        typeof item === "string" ? `q${index + 1}` : item?.questionId || item?.id || `q${index + 1}`,
        `questions[${index}].questionId`,
      );
      if (ids.has(questionId)) throw new TypeError(`duplicate questionId: ${questionId}`);
      ids.add(questionId);
      const text = requiredString(typeof item === "string" ? item : item?.text, `questions[${index}].text`);
      return { questionId, text };
    });
  }
  return [{ questionId: "q1", text: requiredString(body.question || body.userQuery, "question") }];
}

function normalizeQuestionText(body, questions) {
  const explicit = String(body.question || body.userQuery || "").trim();
  if (explicit) return explicit;
  return questions.map((item) => `[${item.questionId}] ${item.text}`).join("\n");
}

async function resolveInstructions(body, loader) {
  const supplied = String(body.instructions || "").trim();
  if (supplied) return supplied;
  const loaded = await loader(body.promptVersion || DEFAULT_PROMPT_VERSION);
  return requiredString(loaded, "prompt instructions");
}

async function defaultPromptLoader() {
  return readFile(DEFAULT_PROMPT_FILE_URL, "utf8");
}

function translateConfiguredLimits(limits) {
  return {
    maxConcurrentRuns: limits.maxConcurrency,
    maxRunDurationMs: limits.maxRuntimeMs,
    maxInputTokens: limits.maxInputTokens,
    maxOutputTokens: limits.maxOutputTokens,
    maxTotalTokens: null,
    maxCostUsd: limits.maxRunCostUsd,
    maxCostCny: null,
  };
}

function serverLiveOfficialQaEnabled(env) {
  const value = env.ADMIN_MODEL_LAB_LIVE_OFFICIAL_QA ?? env.RAG_LIVE_OFFICIAL_QA;
  if (value === undefined || value === null || String(value).trim() === "") return true;
  return !/^(?:0|false|no|off|disabled)$/iu.test(String(value).trim());
}

function resolveServerDataVersions(value) {
  if (typeof value === "function") return value();
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function unwrapBody(argument) {
  if (argument?.body && typeof argument.body === "object" && !Array.isArray(argument.body)) {
    return argument.body;
  }
  return argument && typeof argument === "object" && !Array.isArray(argument) ? argument : {};
}

function assertRunStore(runStore) {
  for (const method of [
    "createRun",
    "getRun",
    "appendEvent",
    "startRun",
    "acquireExecutionLease",
    "renewExecutionLease",
    "releaseExecutionLease",
    "updateStageProgress",
    "finalizePreparation",
    "beginProviderSubmission",
    "recordProviderSubmissionAccepted",
    "recordProviderSubmissionRejected",
    "markProviderSubmissionOutcomeUnknown",
    "requestCancellation",
    "markCancelled",
    "completeRun",
    "failRun",
    "replayEvents",
    "isCancellationRequested",
  ]) {
    if (typeof runStore?.[method] !== "function") {
      throw new TypeError(`admin model lab requires runStore.${method}()`);
    }
  }
}

function optionalPositiveInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError("maxOutputTokens must be a positive integer");
  return number;
}

function readExecutionHeartbeatMs(env) {
  const value = env.ADMIN_MODEL_LAB_EXECUTION_HEARTBEAT_MS;
  if (value === undefined || value === null || value === "") return 30_000;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError("ADMIN_MODEL_LAB_EXECUTION_HEARTBEAT_MS must be a positive integer");
  }
  return number;
}

function optionalPositiveNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError("usdToCnyRate must be positive");
  return number;
}

function optionalNonNegativeNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function nullableString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function nonEmptyString(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function requiredString(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

function readMonotonic(clock) {
  const value = Number(clock());
  if (!Number.isFinite(value)) throw new TypeError("monotonic clock must return a finite number");
  return value;
}

function defaultMonotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function readWall(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("wall clock returned invalid time");
  return date;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function dedupeJson(values, keyOf) {
  const seen = new Set();
  return values.filter((item) => {
    const key = keyOf(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function jsonSafe(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { serializationError: true, value: String(value) };
  }
}

function immutableJson(value) {
  return deepFreeze(jsonSafe(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeError(error) {
  return {
    name: String(error?.name || "Error"),
    code: String(error?.code || ""),
    message: String(error?.message || error || "unknown error"),
  };
}

function providerSubmissionTerminalError(submission) {
  const state = String(submission?.state || "");
  const persisted = submission?.error || {};
  if (state === ADMIN_PROVIDER_SUBMISSION_STATES.OUTCOME_UNKNOWN) {
    return serviceError(
      "OpenAI submission outcome is unknown; automatic resubmission is disabled to avoid duplicate charges",
      "openai_submission_outcome_unknown",
    );
  }
  return serviceError(
    String(persisted.message || "OpenAI explicitly rejected the background request"),
    String(persisted.code || "openai_submission_rejected"),
  );
}

function serviceError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.expose = true;
  error.status = code === "admin_run_not_found" ? 404 : 409;
  error.publicMessage = message;
  return error;
}
