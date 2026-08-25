#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { callRagModel, createPublicAnswerModelEnv } from "../backend/ragModelClient.mjs";
import { loadRagData } from "../backend/ragEvidenceRetriever.mjs";
import { extractPromptAllowedEvidenceIds } from "../backend/ragRulingPrompt.mjs";
import { answerPublicRulingQuestion } from "../backend/publicAnswerService.mjs";
import { answerRagRulingQuestionForVersion } from "../backend/rulingVersionRegistry.mjs";
import { parseDatasetText } from "./evaluate-pure-llm-preview.mjs";

const SCHEMA_VERSION = 3;
const EVIDENCE_REQUIREMENTS_SCHEMA_VERSION = 1;
const PUBLIC_PROFILE = "relay-gpt-5.6-sol-low";
const PUBLIC_MODEL = "gpt-5.6-sol";
const PUBLIC_RULING_VERSION = "latest";
const PUBLIC_MODE = "rag";
const FINAL_OUTPUT_MODE = "plain_text";
const FINAL_TRANSPORT = "chat_completions_sse";
const ALLOWED_EFFORTS = new Set(["low", "medium"]);
const CAPTURE_SENTINEL = "FROZEN_PUBLIC_RAG_PROMPT_CAPTURED";
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RETRIEVAL_CANDIDATE_STAGE_KEYS = Object.freeze([
  "initialCrossCardQuestionIds",
  "rulePlannerCandidateIds",
  "ruleQueryQuestionBranchCandidateIds",
  "scopedOfficialMatchIds",
  "scopedSupplementalOfficialIds",
  "scopedOfficialRelatedCandidateIds",
  "crossCardRankedPoolIds",
  "crossCardEvidenceCandidateIds",
  "allocatedOfficialRelatedIds",
  "allocatedCrossCardIds",
  "notAllocatedCrossCardIds",
]);
const SAFE_RETRIEVAL_CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@#-]{0,127}$/u;
const PUBLIC_DIAGNOSTICS_SCHEMA_VERSION = 1;
const FREEZE_RUNNER_FAILURE_STATUS = "failed_freeze_runner";
const FREEZE_RUNNER_FAILURE_LAYER = "freeze_runner";
const FREEZE_RUNNER_FAILURE_CODE = "freeze_runner_failure";
const PUBLIC_DIAGNOSTIC_STATUSES = new Set([
  "not_started",
  "running",
  "complete",
  "failed_evidence_preparation",
  "failed_evidence_audit",
]);

export function parseFrozenPublicRagArgs(argv = []) {
  const [command, ...rest] = argv;
  if (!new Set(["capture", "freeze", "run"]).has(command)) {
    throw new TypeError("first argument must be capture, freeze, or run");
  }
  const options = { command, caseIds: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const field = ({
      "--dataset": "datasetPath",
      "--snapshot": "snapshotPath",
      "--output": "outputPath",
      "--case": "caseId",
      "--effort": "effort",
      "--max-calls": "maxCalls",
      "--requirements": "requirementsPath",
      "--diagnostics": "diagnosticsPath",
    })[argument];
    if (!field) throw new TypeError(`unknown argument: ${argument}`);
    const value = rest[index + 1];
    if (value === undefined || String(value).startsWith("--")) {
      throw new TypeError(`${argument} requires a value`);
    }
    index += 1;
    if (field === "caseId") options.caseIds.push(normalizeCaseId(value));
    else options[field] = String(value).trim();
  }
  return options;
}

export async function freezePublicRagFinalInputs({
  diagnosticsPath,
  manualReviewOnly = false,
  ...options
} = {}) {
  if (manualReviewOnly && diagnosticsPath) {
    throw new TypeError("manual evidence capture does not publish automated audit diagnostics");
  }
  const diagnosticsFile = diagnosticsPath
    ? path.resolve(requiredText(diagnosticsPath, "diagnosticsPath"))
    : null;
  const state = { checkpoint: null, outputFile: null };
  let diagnosticsClaimed = false;
  try {
    if (diagnosticsFile) {
      await assertOutputDoesNotExist(diagnosticsFile);
      diagnosticsClaimed = true;
      await writeFrozenPublicDiagnostics(diagnosticsFile, {
        status: "running",
        finalModelCallCount: 0,
        selectedCaseIds: [],
        cases: [],
      }, new Map());
    }
    return await freezePublicRagFinalInputsUnchecked({
      ...options,
      diagnosticsFile,
      manualReviewOnly,
      state,
    });
  } catch (error) {
    if (isCompletedFreezeDomainFailure(state.checkpoint, error)) throw error;
    const failedCheckpoint = state.checkpoint || {
      finalModelCallCount: 0,
      selectedCaseIds: [],
      cases: [],
    };
    failedCheckpoint.status = FREEZE_RUNNER_FAILURE_STATUS;
    failedCheckpoint.failureLayer = FREEZE_RUNNER_FAILURE_LAYER;
    failedCheckpoint.failureCode = FREEZE_RUNNER_FAILURE_CODE;
    if (diagnosticsFile && diagnosticsClaimed) {
      try {
        await writeFrozenPublicDiagnostics(diagnosticsFile, failedCheckpoint, new Map());
      } catch {
        // Preserve the original freeze failure. The fatal diagnostic is fixed and
        // contains no exception-derived values, even if publishing it also fails.
      }
    }
    if (state.checkpoint && state.outputFile) {
      try {
        await writeJsonAtomic(state.outputFile, failedCheckpoint);
      } catch {
        // Preserve the original freeze failure without serializing another error.
      }
    }
    throw error;
  }
}

async function freezePublicRagFinalInputsUnchecked({
  datasetPath,
  snapshotPath,
  caseIds = [],
  maxCalls,
  evidenceRequirements,
  requirementsPath,
  diagnosticsFile,
  manualReviewOnly = false,
  state,
  env = process.env,
  answerPublic = answerPublicRulingQuestion,
  answerRuling = answerRagRulingQuestionForVersion,
  loadEvidenceData = loadRagData,
  now = () => new Date(),
  log = console.log,
} = {}) {
  const datasetFile = path.resolve(requiredText(datasetPath, "datasetPath"));
  const outputFile = path.resolve(requiredText(snapshotPath, "snapshotPath"));
  state.outputFile = outputFile;
  assertPathOutsideRepository(outputFile, "snapshotPath");
  await assertOutputDoesNotExist(outputFile);
  const datasetText = await readFile(datasetFile, "utf8");
  const dataset = manualReviewOnly
    ? parseQuestionOnlyCaptureDatasetText(datasetText)
    : parseDatasetText(datasetText);
  const selected = selectCases(dataset.cases, caseIds);
  const callLimit = positiveInteger(maxCalls ?? Math.max(caseIds.length, 1), "maxCalls");
  if (selected.length > callLimit) {
    throw new Error(`selected ${selected.length} cases exceed maxCalls ${callLimit}`);
  }
  let requirements = evidenceRequirements;
  if (requirementsPath !== undefined) {
    if (evidenceRequirements !== undefined) {
      throw new TypeError("provide evidenceRequirements or requirementsPath, not both");
    }
    const requirementsFile = path.resolve(requiredText(requirementsPath, "requirementsPath"));
    assertPathOutsideRepository(requirementsFile, "requirementsPath");
    requirements = JSON.parse(await readFile(requirementsFile, "utf8"));
  }
  const normalizedRequirements = manualReviewOnly
    ? null
    : normalizeEvidenceRequirements(requirements, selected);
  const requirementContexts = manualReviewOnly
    ? new Map()
    : buildEvidenceRequirementContexts({
        selected,
        requirements: normalizedRequirements,
        data: await loadEvidenceData(),
      });
  const privateEnv = createPrivateEvaluationEnv(env, "freeze");
  const publicEnv = createPublicAnswerModelEnv(privateEnv, PUBLIC_PROFILE);
  const transportContract = buildTransportContract(publicEnv);
  const checkpoint = {
    schemaVersion: SCHEMA_VERSION,
    kind: manualReviewOnly
      ? "frozen_public_rag_evidence_capture"
      : "frozen_public_rag_final_inputs",
    status: "running",
    createdAt: now().toISOString(),
    questionDatasetDigest: sha256(JSON.stringify(dataset.cases.map((item) => ({
      id: item.id,
      question: item.question,
      sourceBlocks: [...(item.sourceBlocks || [])],
    })))),
    sourceCaseCount: dataset.uniqueCaseCount,
    selectedCaseIds: selected.map((item) => item.id),
    publicProfile: PUBLIC_PROFILE,
    rulingVersion: PUBLIC_RULING_VERSION,
    experimentScope: manualReviewOnly
      ? "manual_evidence_review_only"
      : "frozen_final_call_only",
    endToEndWebParity: false,
    transportContract,
    ...(manualReviewOnly ? {} : {
      evidenceRequirementsSha256: sha256(JSON.stringify(normalizedRequirements)),
    }),
    finalModelCallCount: 0,
    cases: [],
  };
  state.checkpoint = checkpoint;
  await writeJsonAtomic(outputFile, checkpoint);
  if (diagnosticsFile) {
    await writeFrozenPublicDiagnostics(diagnosticsFile, checkpoint, requirementContexts);
  }

  for (const item of selected) {
    let captured = null;
    let result;
    try {
      result = await answerPublic({
        payload: {
          question: item.question,
          mode: PUBLIC_MODE,
          rulingModelProfile: PUBLIC_PROFILE,
          rulingVersion: PUBLIC_RULING_VERSION,
        },
        env: privateEnv,
        appendAudit: async () => null,
        answerRuling: (options) => answerRuling({
          ...options,
          modelInvoker: async (request) => {
            if (captured) throw new Error(`${item.id} attempted more than one final-model call`);
            captured = freezeCaptureRequest(request);
            return CAPTURE_SENTINEL;
          },
        }),
      });
      if (!captured) {
        if (manualReviewOnly && isOfficialExactDirectAnswer(result?.answer)) {
          const directRecord = buildManualOfficialDirectRecord({
            item,
            answer: result.answer,
          });
          checkpoint.cases.push(directRecord);
          await writeJsonAtomic(outputFile, checkpoint);
          log(`[capture] ${item.id} official_qa_exact_direct ${directRecord.directInvariantSha256.slice(0, 12)}`);
          continue;
        }
        const error = new Error("ordinary final-model path was not reached");
        error.code = "FROZEN_FINAL_PATH_NOT_REACHED";
        throw error;
      }
    } catch (error) {
      // Once the capture invoker is reached, the final request invariants must
      // remain fail-fast. Only the three public fail-closed rule-query outcomes
      // are recoverable per-case evidence-preparation failures; programming,
      // configuration, and route-invariant errors must still stop immediately.
      if (captured || !isRecoverableEvidencePreparationFailure(error)) throw error;
      const failedRecord = Object.freeze({
        id: normalizeCaseId(item?.id),
        status: "failed_evidence_preparation",
        questionSha256: sha256(requiredText(item?.question, "case.question")),
        sourceBlocksSha256: sha256(JSON.stringify(item?.sourceBlocks || [])),
        evidencePreparation: Object.freeze({
          status: "failed_evidence_preparation",
          error: safeEvidencePreparationError(error),
        }),
      });
      checkpoint.cases.push(failedRecord);
      checkpoint.failedEvidencePreparationCaseIds ||= [];
      checkpoint.failedEvidencePreparationCaseIds.push(item.id);
      await writeJsonAtomic(outputFile, checkpoint);
      if (diagnosticsFile) {
        await writeFrozenPublicDiagnostics(diagnosticsFile, checkpoint, requirementContexts);
      }
      log(`[frozen] ${item.id} failed_evidence_preparation`);
      continue;
    }
    const baseRecord = buildFrozenCaseRecord({
      item,
      captured,
      answer: result?.answer,
      transportContract,
    });
    if (manualReviewOnly) {
      checkpoint.cases.push(Object.freeze({
        ...baseRecord,
        status: "captured_for_manual_review",
        manualReviewTrace: buildManualEvidenceReviewTrace({
          answer: result?.answer,
          record: baseRecord,
        }),
      }));
      await writeJsonAtomic(outputFile, checkpoint);
      log(`[capture] ${item.id} ${baseRecord.promptUtf8Sha256.slice(0, 12)} ${baseRecord.promptChars} chars`);
      continue;
    }
    let evidenceAudit;
    try {
      evidenceAudit = assertFrozenEvidenceCompleteness({
        record: baseRecord,
        requirementContext: requirementContexts.get(item.id),
      });
    } catch (error) {
      const failedRecord = Object.freeze({
        ...baseRecord,
        status: "failed_evidence_audit",
        evidenceAudit: Object.freeze({
          status: "failed_evidence_audit",
          diagnosticFailureCode: classifyEvidenceAuditFailure(error),
          error: safeEvidenceAuditError(error),
        }),
      });
      checkpoint.cases.push(failedRecord);
      checkpoint.failedEvidenceAuditCaseIds ||= [];
      checkpoint.failedEvidenceAuditCaseIds.push(item.id);
      await writeJsonAtomic(outputFile, checkpoint);
      if (diagnosticsFile) {
        await writeFrozenPublicDiagnostics(diagnosticsFile, checkpoint, requirementContexts);
      }
      log(`[frozen] ${item.id} failed_evidence_audit`);
      continue;
    }
    const record = Object.freeze({
      ...baseRecord,
      status: "complete",
      evidenceAudit,
    });
    checkpoint.cases.push(record);
    await writeJsonAtomic(outputFile, checkpoint);
    if (diagnosticsFile) {
      await writeFrozenPublicDiagnostics(diagnosticsFile, checkpoint, requirementContexts);
    }
    log(`[frozen] ${item.id} ${record.promptUtf8Sha256.slice(0, 12)} ${record.promptChars} chars`);
  }

  checkpoint.completedAt = now().toISOString();
  if (checkpoint.failedEvidencePreparationCaseIds?.length) {
    checkpoint.status = "failed_evidence_preparation";
  } else if (checkpoint.failedEvidenceAuditCaseIds?.length) {
    checkpoint.status = "failed_evidence_audit";
  } else if (manualReviewOnly) {
    checkpoint.status = "complete";
    checkpoint.bundleInvariantSha256 = sha256(JSON.stringify(
      checkpoint.cases.map((item) => (
        item.requestInvariantSha256 || item.directInvariantSha256
      )),
    ));
  } else {
    checkpoint.status = "complete";
    checkpoint.bundleInvariantSha256 = sha256(JSON.stringify(
      checkpoint.cases.map((item) => ({
        requestInvariantSha256: item.requestInvariantSha256,
        evidenceAuditSha256: item.evidenceAudit.auditSha256,
      })),
    ));
  }
  assertFreezeFinalModelBoundary(checkpoint);
  await writeJsonAtomic(outputFile, checkpoint);
  if (diagnosticsFile) {
    await writeFrozenPublicDiagnostics(diagnosticsFile, checkpoint, requirementContexts);
  }
  if (checkpoint.status === "failed_evidence_preparation") {
    const error = new Error(
      `frozen evidence preparation failed for ${checkpoint.failedEvidencePreparationCaseIds.length} case(s)`,
    );
    error.code = "FROZEN_EVIDENCE_PREPARATION_FAILED";
    throw error;
  }
  if (checkpoint.status === "failed_evidence_audit") {
    const error = new Error(
      `frozen evidence audit failed for ${checkpoint.failedEvidenceAuditCaseIds.length} case(s)`,
    );
    error.code = "FROZEN_EVIDENCE_AUDIT_FAILED";
    throw error;
  }
  return checkpoint;
}

export function parseQuestionOnlyCaptureDatasetText(text) {
  const normalized = String(text || "").replace(/^\uFEFF/u, "").trim();
  if (!normalized) throw new TypeError("The capture dataset is empty");
  const blocks = normalized.split(/(?:\r?\n[ \t]*){2,}/u);
  const unique = [];
  const byQuestion = new Map();
  let duplicateCount = 0;
  blocks.forEach((block, index) => {
    const lines = block
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) {
      throw new TypeError(`Capture dataset block ${index + 1} must contain a question and a discarded reference line`);
    }
    // The final line is only a structural delimiter inherited from test.txt.
    // It is deliberately neither stored nor compared, so reference answers
    // cannot affect capture identities, deduplication, retrieval, or output.
    const question = lines.slice(0, -1).join("\n").trim();
    if (!question) throw new TypeError(`Capture dataset block ${index + 1} contains an empty question`);
    const key = question.normalize("NFKC").replace(/\s+/gu, " ").trim();
    const existing = byQuestion.get(key);
    if (existing) {
      duplicateCount += 1;
      existing.sourceBlocks.push(index + 1);
      return;
    }
    const item = {
      id: `case-${String(unique.length + 1).padStart(3, "0")}`,
      question,
      sourceBlocks: [index + 1],
    };
    byQuestion.set(key, item);
    unique.push(item);
  });
  return Object.freeze({
    schemaVersion: 1,
    sourceBlockCount: blocks.length,
    uniqueCaseCount: unique.length,
    duplicateCount,
    questionDatasetDigest: sha256(JSON.stringify(unique.map(({ question }) => ({ question })))),
    cases: Object.freeze(unique.map((item) => Object.freeze({
      ...item,
      sourceBlocks: Object.freeze([...item.sourceBlocks]),
    }))),
  });
}

function isOfficialExactDirectAnswer(answer) {
  return String(answer?.debug?.route || "") === "official_qa_exact_direct"
    && Boolean(String(answer?.officialQaId || "").trim())
    && Boolean(String(answer?.officialQuestionJapanese || "").trim())
    && Boolean(String(answer?.officialAnswerJapanese || "").trim());
}

function buildManualOfficialDirectRecord({ item, answer } = {}) {
  const question = requiredText(item?.question, "case.question");
  const officialQa = Object.freeze({
    qaId: requiredText(answer?.officialQaId, "answer.officialQaId"),
    questionJapanese: requiredText(
      answer?.officialQuestionJapanese,
      "answer.officialQuestionJapanese",
      { trim: false },
    ),
    answerJapanese: requiredText(
      answer?.officialAnswerJapanese,
      "answer.officialAnswerJapanese",
      { trim: false },
    ),
    evidence: Object.freeze(reviewArray(answer?.usedEvidence).map((item) => Object.freeze({
      id: reviewText(item?.id, 128),
      type: reviewText(item?.type, 80),
      title: reviewText(item?.title, 320),
      sourceUrl: reviewText(item?.sourceUrl, 1000),
    })).filter((item) => item.id)),
  });
  const invariant = {
    question,
    route: "official_qa_exact_direct",
    officialQa,
  };
  return Object.freeze({
    id: normalizeCaseId(item?.id),
    status: "captured_official_qa_exact_direct",
    question,
    questionSha256: sha256(question),
    sourceBlocks: Object.freeze([...(item?.sourceBlocks || [])]),
    route: "official_qa_exact_direct",
    finalModelCallCount: 0,
    directOfficialQa: officialQa,
    directInvariantSha256: sha256(JSON.stringify(invariant)),
    manualReviewTrace: buildManualEvidenceReviewTrace({ answer, record: {
      allowedEvidenceIds: officialQa.evidence.map((item) => item.id),
    } }),
  });
}

export function buildFrozenPublicDiagnostics({ checkpoint, requirementContexts } = {}) {
  if (!checkpoint || !(requirementContexts instanceof Map)) {
    throw new TypeError("public freeze diagnostics require a checkpoint and requirement contexts");
  }
  if (checkpoint.status === FREEZE_RUNNER_FAILURE_STATUS) {
    return buildFreezeRunnerFailureDiagnostics(checkpoint);
  }
  assertFreezeFinalModelBoundary(checkpoint);
  if (!PUBLIC_DIAGNOSTIC_STATUSES.has(checkpoint.status)) {
    return buildFreezeRunnerFailureDiagnostics(checkpoint);
  }
  const records = new Map((Array.isArray(checkpoint.cases) ? checkpoint.cases : [])
    .map((item) => [normalizeCaseId(item?.id), item]));
  const selectedCaseIds = (checkpoint.selectedCaseIds || []).map(normalizeCaseId);
  return Object.freeze({
    schemaVersion: PUBLIC_DIAGNOSTICS_SCHEMA_VERSION,
    kind: "frozen_public_rag_safe_diagnostics",
    stage: "freeze",
    status: checkpoint.status,
    failureLayer: null,
    failureCode: null,
    finalModelCallCount: 0,
    cases: selectedCaseIds.map((id) => {
      const record = records.get(id) || null;
      const context = requirementContexts.get(id);
      if (!context) throw new Error(`${id} has no source-backed diagnostics context`);
      const sourceEvidenceIds = context.sourceEvidenceIds instanceof Set
        ? context.sourceEvidenceIds
        : new Set(context.evidenceSources?.keys?.() || []);
      const sourceCardIds = new Set(context.cardSources?.keys?.() || []);
      const sourceBacked = (ids) => [...new Set((ids || [])
        .map((value) => String(value || "").trim())
        .filter((value) => SAFE_RETRIEVAL_CANDIDATE_ID.test(value))
        .filter((value) => sourceEvidenceIds.has(value)))].sort();
      const requiredEvidenceIds = sourceBacked(context.requirement.requiredEvidenceIds);
      const forbiddenEvidenceIds = sourceBacked(context.requirement.forbiddenEvidenceIds);
      const promptFacts = parsePublicDiagnosticPromptFacts({
        record,
        sourceEvidenceIds,
        sourceCardIds,
      });
      const presentEvidenceIds = sourceBacked(promptFacts.presentEvidenceIds);
      const visibleEvidenceIds = new Set(sourceBacked(promptFacts.visibleEvidenceIds));
      const present = new Set(presentEvidenceIds);
      const requiredResolvedCardIds = [...context.requirement.requiredResolvedCardIds]
        .filter((value) => sourceCardIds.has(value))
        .sort();
      const presentResolvedCardIds = [...promptFacts.presentResolvedCardIds].sort();
      const presentCards = new Set(presentResolvedCardIds);
      const requiredRelatedOnlyEvidenceIds = sourceBacked(
        context.requirement.requiredRelatedOnlyEvidenceIds,
      );
      const relatedOnlyViolationEvidenceIds = sourceBacked(
        promptFacts.relatedOnlyViolationEvidenceIds,
      ).filter((value) => requiredRelatedOnlyEvidenceIds.includes(value));
      const caseStatus = PUBLIC_DIAGNOSTIC_STATUSES.has(record?.status)
        ? record.status
        : "not_started";
      const failureLayer = ({
        failed_evidence_preparation: "evidence_preparation",
        failed_evidence_audit: "evidence_audit",
      })[caseStatus] || null;
      return Object.freeze({
        id,
        status: caseStatus,
        failureLayer,
        failureCode: diagnosticFailureCode(record, caseStatus),
        promptTruncated: typeof record?.promptTruncated === "boolean"
          ? record.promptTruncated
          : null,
        promptCompacted: typeof record?.promptCompacted === "boolean"
          ? record.promptCompacted
          : null,
        finalModelCallCount: 0,
        cards: Object.freeze({
          requiredResolvedCardIds,
          presentResolvedCardIds,
          missingResolvedCardIds: requiredResolvedCardIds
            .filter((value) => !presentCards.has(value)),
        }),
        evidence: Object.freeze({
          requiredEvidenceIds,
          presentEvidenceIds,
          missingEvidenceIds: requiredEvidenceIds.filter((value) => !present.has(value)),
          forbiddenEvidenceIds,
          forbiddenPresentEvidenceIds: forbiddenEvidenceIds
            .filter((value) => visibleEvidenceIds.has(value)),
          requiredRelatedOnlyEvidenceIds,
          relatedOnlyViolationEvidenceIds,
        }),
        candidateStages: Object.freeze(Object.fromEntries(
          RETRIEVAL_CANDIDATE_STAGE_KEYS.map((key) => [
            key,
            Object.freeze({
              count: sourceBacked(record?.retrievalCandidateStages?.[key]).length,
              requiredEvidenceIds: requiredEvidenceIds.filter((value) => (
                record?.retrievalCandidateStages?.[key]?.includes(value)
              )),
            }),
          ]),
        )),
      });
    }),
  });
}

function buildFreezeRunnerFailureDiagnostics(checkpoint) {
  const finalModelCallCount = Number.isSafeInteger(checkpoint?.finalModelCallCount)
    && checkpoint.finalModelCallCount >= 0
    ? checkpoint.finalModelCallCount
    : 0;
  return Object.freeze({
    schemaVersion: PUBLIC_DIAGNOSTICS_SCHEMA_VERSION,
    kind: "frozen_public_rag_safe_diagnostics",
    stage: "freeze",
    status: FREEZE_RUNNER_FAILURE_STATUS,
    failureLayer: FREEZE_RUNNER_FAILURE_LAYER,
    failureCode: FREEZE_RUNNER_FAILURE_CODE,
    finalModelCallCount,
    cases: Object.freeze([]),
  });
}

function parsePublicDiagnosticPromptFacts({ record, sourceEvidenceIds, sourceCardIds } = {}) {
  const empty = {
    presentEvidenceIds: [],
    visibleEvidenceIds: [],
    presentResolvedCardIds: [],
    relatedOnlyViolationEvidenceIds: [],
  };
  if (!record?.prompt) return empty;
  try {
    const payload = parseFrozenPromptPayload(record.prompt);
    if (!payload) return empty;
    const evidence = indexUniquePromptItems(serializedPromptEvidence(payload));
    const allowed = new Set(extractPromptAllowedEvidenceIds(record.prompt));
    const presentEvidenceIds = [...allowed]
      .filter((id) => evidence.has(id) && sourceEvidenceIds.has(id));
    return {
      presentEvidenceIds,
      visibleEvidenceIds: [...new Set([...allowed, ...evidence.keys()])]
        .filter((id) => sourceEvidenceIds.has(id)),
      presentResolvedCardIds: [...indexUniquePromptItems(payload.resolvedCards || []).keys()]
        .filter((id) => sourceCardIds.has(id)),
      relatedOnlyViolationEvidenceIds: presentEvidenceIds.filter((id) => (
        evidence.get(id)?.retrievalContext?.relatedOnly !== true
      )),
    };
  } catch {
    return empty;
  }
}

function diagnosticFailureCode(record, status) {
  if (status === "failed_evidence_preparation") {
    const code = String(record?.evidencePreparation?.error?.code || "");
    return new Set([
      "rule_query_model_timeout",
      "rule_query_model_empty",
      "rule_query_model_unavailable",
    ]).has(code) ? code : "evidence_preparation_other";
  }
  if (status === "failed_evidence_audit") {
    return String(record?.evidenceAudit?.diagnosticFailureCode || "evidence_audit_other");
  }
  return null;
}

function classifyEvidenceAuditFailure(error) {
  const message = String(error?.message || "");
  const rules = [
    [/prompt was truncated|truncation warnings/iu, "prompt_truncated"],
    [/reached .* expected/iu, "route_mismatch"],
    [/required resolved card .* absent/iu, "required_card_missing"],
    [/resolved card .* effect text is incomplete|resolved card .* differs/iu, "card_text_incomplete"],
    [/required evidence .* not model-visible/iu, "required_evidence_missing"],
    [/evidence .* (?:incomplete|differs|omits source line)/iu, "evidence_body_mismatch"],
    [/not kept related-only/iu, "related_only_violation"],
    [/forbidden evidence .* visible/iu, "forbidden_visible"],
    [/question does not match/iu, "question_mismatch"],
    [/missing dataRevision or evidenceFingerprint/iu, "evidence_binding_missing"],
    [/prompt payload is missing|different user question/iu, "prompt_payload_mismatch"],
  ];
  return rules.find(([pattern]) => pattern.test(message))?.[1] || "evidence_audit_other";
}

async function writeFrozenPublicDiagnostics(file, checkpoint, requirementContexts) {
  await writeJsonAtomic(file, buildFrozenPublicDiagnostics({
    checkpoint,
    requirementContexts,
  }));
}

function assertFreezeFinalModelBoundary(checkpoint) {
  if (checkpoint?.finalModelCallCount !== 0) {
    const error = new Error("freeze final-model call boundary was violated");
    error.code = "FROZEN_FINAL_MODEL_CALL_DETECTED";
    throw error;
  }
}

function isCompletedFreezeDomainFailure(checkpoint, error) {
  return (checkpoint?.status === "failed_evidence_preparation"
      && error?.code === "FROZEN_EVIDENCE_PREPARATION_FAILED")
    || (checkpoint?.status === "failed_evidence_audit"
      && error?.code === "FROZEN_EVIDENCE_AUDIT_FAILED");
}

export async function runFrozenPublicRagFinalEffort({
  snapshotPath,
  outputPath,
  effort,
  caseIds = [],
  maxCalls,
  env = process.env,
  callModel = callRagModel,
  now = () => new Date(),
  log = console.log,
} = {}) {
  const snapshotFile = path.resolve(requiredText(snapshotPath, "snapshotPath"));
  const outputFile = path.resolve(requiredText(outputPath, "outputPath"));
  assertPathOutsideRepository(snapshotFile, "snapshotPath");
  assertPathOutsideRepository(outputFile, "outputPath");
  await assertOutputDoesNotExist(outputFile);
  const normalizedEffort = String(effort || "").trim().toLowerCase();
  if (!ALLOWED_EFFORTS.has(normalizedEffort)) {
    throw new TypeError("effort must be low or medium");
  }
  const bundleText = await readFile(snapshotFile, "utf8");
  const bundle = normalizeSnapshotBundle(JSON.parse(bundleText));
  const selected = selectCases(bundle.cases, caseIds);
  const callLimit = positiveInteger(maxCalls ?? selected.length, "maxCalls");
  if (selected.length > callLimit) {
    throw new Error(`selected ${selected.length} cases exceed maxCalls ${callLimit}`);
  }
  // Validate every selected evidence gate before the first paid final call.
  // A damaged later case must never be discovered only after an earlier case
  // has already consumed budget.
  selected.forEach(assertFrozenCaseInvariant);
  const privateEnv = createPublicAnswerModelEnv(
    createPrivateEvaluationEnv(env, `run-${normalizedEffort}`),
    PUBLIC_PROFILE,
  );
  const currentTransportContract = buildTransportContract(privateEnv);
  assertSameTransportContract(bundle.transportContract, currentTransportContract);
  const checkpoint = {
    schemaVersion: SCHEMA_VERSION,
    kind: "frozen_public_rag_final_effort_results",
    status: "running",
    createdAt: now().toISOString(),
    snapshotSha256: sha256(bundleText),
    bundleInvariantSha256: bundle.bundleInvariantSha256,
    selectedCaseIds: selected.map((item) => item.id),
    model: PUBLIC_MODEL,
    effort: normalizedEffort,
    retries: 0,
    scoringAnswerField: "displayedAnswer",
    experimentScope: "frozen_final_call_only",
    endToEndWebParity: false,
    transportContract: currentTransportContract,
    results: [],
  };
  await writeJsonAtomic(outputFile, checkpoint);

  for (const item of selected) {
    const running = {
      id: item.id,
      status: "running",
      startedAt: now().toISOString(),
      promptUtf8Sha256: item.promptUtf8Sha256,
      messagesSha256: item.messagesSha256,
      requestInvariantSha256: item.requestInvariantSha256,
    };
    checkpoint.results.push(running);
    await writeJsonAtomic(outputFile, checkpoint);
    const startedAt = performance.now();
    try {
      const replayEnv = {
        ...privateEnv,
        RAG_MODEL: item.model,
        RAG_MAX_OUTPUT_TOKENS: String(item.maxCompletionTokens),
      };
      assertReplayPreDispatchInvariant(item, {
        env: replayEnv,
        effort: normalizedEffort,
        transportContract: currentTransportContract,
      });
      const response = await callModel({
        prompt: item.prompt,
        recoveryPrompt: "",
        // Freeze every request invariant before dispatch. The caller's current
        // shell or deployment defaults cannot silently change model or output
        // budget between the low and medium replays.
        env: replayEnv,
        reasoningEffort: normalizedEffort,
        outputMode: FINAL_OUTPUT_MODE,
      });
      const generation = response?.generationConfig || {};
      if (String(generation.requestModel || "") !== item.model) {
        throw new Error(`${item.id} model drifted from frozen input`);
      }
      if (Number(generation.maxOutputTokens) !== item.maxCompletionTokens) {
        throw new Error(`${item.id} max output tokens drifted from frozen input`);
      }
      if (String(generation.reasoningEffort || "") !== normalizedEffort) {
        throw new Error(`${item.id} reasoning effort was not applied`);
      }
      const attempt = response?.generationAttempts?.at(-1) || null;
      Object.assign(running, modelOutcomeDiagnostics(response, attempt));
      assertCompletedModelOutcome(item, response, attempt);
      Object.assign(running, {
        status: "completed",
        completedAt: now().toISOString(),
        durationMs: Math.round(performance.now() - startedAt),
        requestedModel: generation.requestModel,
        reasoningEffort: generation.reasoningEffort,
        maxCompletionTokens: generation.maxOutputTokens,
        tokenUsage: response?.tokenUsage || {},
        estimatedCostUsd: Number(response?.estimatedCostUsd || 0),
      });
      log(`[complete] ${item.id} ${running.durationMs} ms`);
    } catch (error) {
      Object.assign(running, {
        status: "failed_non_scorable",
        completedAt: now().toISOString(),
        durationMs: Math.round(performance.now() - startedAt),
        error: safeError(error),
      });
      await writeJsonAtomic(outputFile, checkpoint);
      throw error;
    }
    await writeJsonAtomic(outputFile, checkpoint);
  }

  checkpoint.status = "complete";
  checkpoint.completedAt = now().toISOString();
  await writeJsonAtomic(outputFile, checkpoint);
  return checkpoint;
}

export function buildFrozenCaseRecord({ item, captured, answer, transportContract } = {}) {
  const question = requiredText(item?.question, "case.question");
  const prompt = requiredText(captured?.prompt, "captured.prompt", { trim: false });
  const model = requiredText(captured?.modelName, "captured.modelName");
  const maxCompletionTokens = positiveInteger(captured?.maxTokens, "captured.maxTokens");
  if (String(captured?.provider || "") !== "relay" || model !== PUBLIC_MODEL) {
    throw new Error(`${item.id} was not captured from the public Relay Sol path`);
  }
  if (String(captured?.reasoningEffort || "") !== "low") {
    throw new Error(`${item.id} freeze capture did not use the public low profile`);
  }
  const normalizedTransportContract = normalizeTransportContract(transportContract);
  const messages = [{ role: "user", content: prompt }];
  const invariant = buildRequestInvariant({
    model,
    messages,
    maxCompletionTokens,
    transportContract: normalizedTransportContract,
  });
  const promptUtf8Sha256 = sha256(prompt);
  const finalPromptSha256 = String(answer?.debug?.finalPromptSha256 || "").trim();
  if (finalPromptSha256 && finalPromptSha256 !== promptUtf8Sha256) {
    throw new Error(`${item.id} pipeline prompt hash does not match captured prompt`);
  }
  return Object.freeze({
    id: normalizeCaseId(item?.id),
    question,
    questionSha256: sha256(question),
    sourceBlocks: [...(item?.sourceBlocks || [])],
    prompt,
    promptChars: prompt.length,
    promptUtf8Sha256,
    messagesSha256: sha256(JSON.stringify(messages)),
    requestInvariantSha256: sha256(JSON.stringify(invariant)),
    transportContract: normalizedTransportContract,
    model,
    maxCompletionTokens,
    capturedReasoningEffort: String(captured?.reasoningEffort || ""),
    route: String(answer?.debug?.route || answer?.debug?.mode || "ordinary_rag"),
    dataRevision: String(answer?.debug?.dataRevision || ""),
    evidenceFingerprint: String(answer?.debug?.evidenceFingerprint || ""),
    finalPromptSha256: finalPromptSha256 || promptUtf8Sha256,
    promptTruncated: answer?.debug?.promptTruncated === true,
    promptCompacted: (answer?.debug?.retrievalWarnings || []).some((warning) => (
      /rag_prompt_compacted/iu.test(String(warning || ""))
    )),
    resolvedCardIds: (answer?.resolvedCards || [])
      .map((card) => String(card?.id || card?.cardId || "").trim())
      .filter(Boolean),
    allowedEvidenceIds: (answer?.usedEvidence || [])
      .map((evidence) => String(evidence?.id || "").trim())
      .filter(Boolean),
    selectedEvidenceDiagnostics: answer?.debug?.selectedEvidenceDiagnostics || [],
    retrievalWarnings: answer?.debug?.retrievalWarnings || [],
    retrievalCandidateStages: sanitizeRetrievalCandidateStages(
      answer?.debug?.retrievalCandidateStages,
    ),
    auxiliaryModels: {
      cardName: {
        provider: String(answer?.debug?.cardNameProviderUsed || ""),
        model: String(answer?.debug?.cardNameModelUsed || ""),
        cacheHit: answer?.debug?.extractionCacheHits?.cardNameModel === true,
        singleflightHit: answer?.debug?.extractionSingleflightHits?.cardNameModel === true,
      },
      ruleQuery: {
        provider: String(answer?.debug?.ruleQueryProviderUsed || ""),
        model: String(answer?.debug?.ruleQueryModelUsed || ""),
        cacheHit: answer?.debug?.extractionCacheHits?.ruleQueryModel === true,
        singleflightHit: answer?.debug?.extractionSingleflightHits?.ruleQueryModel === true,
      },
    },
  });
}

function sanitizeRetrievalCandidateStages(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return Object.freeze(Object.fromEntries(RETRIEVAL_CANDIDATE_STAGE_KEYS.map((key) => {
    const ids = Array.isArray(source[key]) ? source[key] : [];
    const safeIds = [...new Set(ids
      .filter((id) => typeof id === "string")
      .map((id) => id.trim())
      .filter((id) => SAFE_RETRIEVAL_CANDIDATE_ID.test(id)))];
    return [key, Object.freeze(safeIds)];
  })));
}

function buildManualEvidenceReviewTrace({ answer = {}, record = {} } = {}) {
  const debug = answer?.debug && typeof answer.debug === "object" ? answer.debug : {};
  const candidateStages = sanitizeRetrievalCandidateStages(debug.retrievalCandidateStages);
  const visibleIds = new Set((record.allowedEvidenceIds || []).map((id) => String(id || "").trim()));
  const allocatedIds = new Set(candidateStages.allocatedOfficialRelatedIds || []);
  const notAllocatedCrossCardIds = new Set(candidateStages.notAllocatedCrossCardIds || []);
  const allCandidateIds = new Set([
    ...visibleIds,
    ...Object.values(candidateStages).flat(),
  ]);
  const candidateJourney = [...allCandidateIds].sort().map((id) => {
    const stages = RETRIEVAL_CANDIDATE_STAGE_KEYS.filter((key) => candidateStages[key].includes(id));
    const status = visibleIds.has(id)
      ? "model_visible"
      : notAllocatedCrossCardIds.has(id)
        ? "not_allocated_within_related_budget"
        : allocatedIds.has(id)
          ? "removed_during_prompt_packing"
          : "candidate_only_not_selected";
    return Object.freeze({ id, stages: Object.freeze(stages), status });
  });
  return Object.freeze({
    resolvedCards: Object.freeze(reviewArray(answer?.resolvedCards).map(sanitizeReviewCard).filter(Boolean)),
    unresolvedMentions: Object.freeze(sanitizeReviewMentions(debug.unresolvedMentions)),
    ambiguousMentions: Object.freeze(sanitizeReviewMentions(debug.ambiguousMentions)),
    modelCardNameCandidates: Object.freeze(
      reviewArray(debug.modelCardNameCandidates).map(sanitizeReviewCard).filter(Boolean),
    ),
    modelRuleSearchQueries: Object.freeze(
      reviewArray(debug.modelRuleSearchQueries).map(sanitizeReviewRuleQuery).filter(Boolean),
    ),
    modelRuleCandidateAssessments: Object.freeze(
      reviewArray(debug.modelRuleCandidateAssessments).map(sanitizeReviewCandidateAssessment).filter(Boolean),
    ),
    ruleQueryPlanDiagnostics: Object.freeze(
      reviewArray(debug.ruleQueryPlanDiagnostics).map(sanitizeReviewRuleQuery).filter(Boolean),
    ),
    cardNameWarnings: Object.freeze(sanitizeReviewWarnings(debug.cardNameWarnings)),
    ruleQueryWarnings: Object.freeze(sanitizeReviewWarnings(debug.ruleQueryWarnings)),
    candidateJourney: Object.freeze(candidateJourney),
  });
}

function sanitizeReviewCard(card) {
  if (!card || typeof card !== "object") return null;
  const value = {
    id: reviewText(card.id || card.cardId, 128),
    cid: reviewText(card.cid, 64),
    name: reviewText(card.name || card.cnName || card.jaName || card.enName, 180),
    input: reviewText(card.input, 180),
    matchedQuery: reviewText(card.matchedQuery, 180),
    source: reviewText(card.source, 80),
    identityVerificationStatus: reviewText(card.identityVerificationStatus, 80),
  };
  return Object.values(value).some(Boolean) ? Object.freeze(value) : null;
}

function sanitizeReviewMentions(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => Object.freeze({
    input: reviewText(item?.input, 240),
    reason: reviewText(item?.reason, 160),
    source: reviewText(item?.source, 120),
    candidateCards: Object.freeze((Array.isArray(item?.candidateCards) ? item.candidateCards : [])
      .map(sanitizeReviewCard)
      .filter(Boolean)
      .slice(0, 12)),
  })).filter((item) => item.input || item.reason || item.candidateCards.length);
}

function sanitizeReviewRuleQuery(item) {
  if (!item || typeof item !== "object") return null;
  const value = {
    subclaim: reviewText(item.subclaim, 320),
    checkpoint: reviewText(item.checkpoint, 120),
    query: reviewText(item.query, 720),
    reason: reviewText(item.reason, 320),
    confidence: reviewText(item.confidence, 80),
    source: reviewText(item.source, 120),
  };
  return Object.values(value).some(Boolean) ? Object.freeze(value) : null;
}

function sanitizeReviewCandidateAssessment(item) {
  if (!item || typeof item !== "object") return null;
  const value = {
    id: reviewText(item.id, 128),
    relevance: reviewText(item.relevance, 80),
    premise: reviewText(item.premise, 80),
    difference: reviewText(item.difference, 320),
    source: reviewText(item.source, 120),
  };
  return value.id ? Object.freeze(value) : null;
}

function sanitizeReviewWarnings(items = []) {
  return [...new Set((Array.isArray(items) ? items : [])
    .map((item) => reviewText(item, 320))
    .filter(Boolean))];
}

function reviewText(value, maxLength) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function reviewArray(value) {
  return Array.isArray(value) ? value : [];
}

export function assertFrozenEvidenceCompleteness({
  record,
  requirementContext,
} = {}) {
  if (!record || !requirementContext) {
    throw new TypeError("frozen evidence audit requires a record and source-backed requirement context");
  }
  const { requirement, cardSources, evidenceSources } = requirementContext;
  if (record.questionSha256 !== requirement.questionSha256) {
    throw new Error(`${record.id} question does not match its evidence requirement`);
  }
  if (record.promptTruncated === true) {
    throw new Error(`${record.id} prompt was truncated`);
  }
  if (!record.dataRevision || !record.evidenceFingerprint) {
    throw new Error(`${record.id} is missing dataRevision or evidenceFingerprint`);
  }
  if (requirement.expectedRoute && record.route !== requirement.expectedRoute) {
    throw new Error(`${record.id} reached ${record.route}, expected ${requirement.expectedRoute}`);
  }

  const payload = parseFrozenPromptPayload(record.prompt);
  if (!payload || payload.userQuery !== record.question) {
    throw new Error(`${record.id} final prompt payload is missing or has a different user question`);
  }
  const allowedEvidenceIds = extractPromptAllowedEvidenceIds(record.prompt);
  const serializedEvidence = serializedPromptEvidence(payload);
  const evidenceById = indexUniquePromptItems(serializedEvidence, `${record.id} evidence`);
  const cardsById = indexUniquePromptItems(
    Array.isArray(payload.resolvedCards) ? payload.resolvedCards : [],
    `${record.id} resolved cards`,
  );
  const allowed = new Set(allowedEvidenceIds);

  const cardEffectTextSha256 = [];
  for (const [id, source] of cardSources) {
    const serialized = cardsById.get(id);
    if (!serialized) throw new Error(`${record.id} required resolved card ${id} is absent from the final prompt`);
    const expectedText = String(source.effectText || source.text || "");
    if (!expectedText || String(serialized.effectText || "") !== expectedText) {
      throw new Error(`${record.id} resolved card ${id} effect text is incomplete or differs from cards.json`);
    }
    cardEffectTextSha256.push({ id, sha256: sha256(expectedText) });
  }

  const evidenceBodySha256 = [];
  const evidenceSourceUrlSha256 = [];
  for (const [id, source] of evidenceSources) {
    const serialized = evidenceById.get(id);
    if (!serialized || !allowed.has(id)) {
      throw new Error(`${record.id} required evidence ${id} is not model-visible`);
    }
    assertSourceEqualPromptEvidenceBody({
      caseId: record.id,
      evidenceId: id,
      sourceRecord: source,
      serialized,
    });
    const expectedSourceUrl = String(source.sourceUrl || source.officialUrl || "");
    if (expectedSourceUrl) {
      const diagnostic = requireUniqueSelectedEvidenceDiagnostic(record, id);
      if (String(diagnostic.sourceUrl || "") !== expectedSourceUrl) {
        throw new Error(`${record.id} evidence ${id}.sourceUrl differs from qa-index.json selectedEvidenceDiagnostics`);
      }
      evidenceSourceUrlSha256.push({ id, sha256: sha256(expectedSourceUrl) });
    }
    if (requirement.requiredRelatedOnlyEvidenceIds.includes(id)
        && serialized.retrievalContext?.relatedOnly !== true) {
      throw new Error(`${record.id} evidence ${id} was not kept related-only`);
    }
    evidenceBodySha256.push({
      id,
      sha256: sha256(JSON.stringify(promptEvidenceAuditBody(serialized))),
    });
  }

  for (const id of requirement.forbiddenEvidenceIds) {
    if (allowed.has(id) || evidenceById.has(id) || record.prompt.includes(id)) {
      throw new Error(`${record.id} forbidden evidence ${id} is visible in the final prompt`);
    }
  }
  const requiredWarningIds = new Set(requirement.requiredEvidenceIds);
  const damagingWarnings = (record.retrievalWarnings || []).filter((warning) => {
    const text = String(warning || "");
    return /truncated/iu.test(text)
      && ([...requiredWarningIds].some((id) => text.includes(id))
        || /official_direct_prompt_truncated/iu.test(text));
  });
  if (damagingWarnings.length) {
    throw new Error(`${record.id} required evidence has truncation warnings: ${damagingWarnings.join(", ")}`);
  }

  cardEffectTextSha256.sort(compareAuditIds);
  evidenceBodySha256.sort(compareAuditIds);
  evidenceSourceUrlSha256.sort(compareAuditIds);
  const auditPayload = {
    status: "complete",
    questionSha256: requirement.questionSha256,
    dataRevision: record.dataRevision,
    evidenceFingerprint: record.evidenceFingerprint,
    promptUtf8Sha256: record.promptUtf8Sha256,
    requiredResolvedCardIds: [...requirement.requiredResolvedCardIds],
    requiredEvidenceIds: [...requirement.requiredEvidenceIds],
    requiredRelatedOnlyEvidenceIds: [...requirement.requiredRelatedOnlyEvidenceIds],
    forbiddenEvidenceIds: [...requirement.forbiddenEvidenceIds],
    cardEffectTextSha256,
    evidenceBodySha256,
    evidenceSourceUrlSha256,
  };
  return Object.freeze({
    ...auditPayload,
    auditSha256: sha256(JSON.stringify(auditPayload)),
  });
}

function normalizeEvidenceRequirements(value, selectedCases = []) {
  if (!value || value.schemaVersion !== EVIDENCE_REQUIREMENTS_SCHEMA_VERSION
      || !value.cases || typeof value.cases !== "object" || Array.isArray(value.cases)) {
    throw new TypeError("evidence requirements must be a schemaVersion 1 case map");
  }
  const cases = {};
  for (const item of selectedCases) {
    const source = value.cases[item.id];
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new TypeError(`evidence requirements are missing ${item.id}`);
    }
    const questionSha256 = requiredSha256(source.questionSha256, `${item.id}.questionSha256`);
    if (questionSha256 !== sha256(item.question)) {
      throw new Error(`${item.id} question hash does not match the selected dataset case`);
    }
    const requiredResolvedCardIds = normalizedIdList(
      source.requiredResolvedCardIds,
      `${item.id}.requiredResolvedCardIds`,
    );
    const requiredEvidenceIds = normalizedIdList(
      source.requiredEvidenceIds,
      `${item.id}.requiredEvidenceIds`,
    );
    const requiredRelatedOnlyEvidenceIds = normalizedIdList(
      source.requiredRelatedOnlyEvidenceIds || [],
      `${item.id}.requiredRelatedOnlyEvidenceIds`,
    );
    const forbiddenEvidenceIds = normalizedIdList(
      source.forbiddenEvidenceIds || [],
      `${item.id}.forbiddenEvidenceIds`,
    );
    if (!requiredResolvedCardIds.length && !requiredEvidenceIds.length) {
      throw new TypeError(`${item.id} evidence requirement must name at least one card or evidence record`);
    }
    if (requiredRelatedOnlyEvidenceIds.some((id) => !requiredEvidenceIds.includes(id))) {
      throw new TypeError(`${item.id} related-only evidence must also be required evidence`);
    }
    if (forbiddenEvidenceIds.some((id) => requiredEvidenceIds.includes(id))) {
      throw new TypeError(`${item.id} evidence cannot be both required and forbidden`);
    }
    cases[item.id] = {
      questionSha256,
      expectedRoute: String(source.expectedRoute || "").trim(),
      requiredResolvedCardIds,
      requiredEvidenceIds,
      requiredRelatedOnlyEvidenceIds,
      forbiddenEvidenceIds,
    };
  }
  return Object.freeze({
    schemaVersion: EVIDENCE_REQUIREMENTS_SCHEMA_VERSION,
    cases: Object.freeze(cases),
  });
}

function buildEvidenceRequirementContexts({ selected, requirements, data } = {}) {
  const cards = Array.isArray(data?.cards) ? data.cards : [];
  const qaRecords = Array.isArray(data?.qaRecords) ? data.qaRecords : [];
  const sourceEvidenceIds = new Set(qaRecords
    .map((item) => String(item?.id || "").trim())
    .filter((id) => SAFE_RETRIEVAL_CANDIDATE_ID.test(id)));
  const contexts = new Map();
  for (const item of selected) {
    const requirement = requirements.cases[item.id];
    const cardSources = new Map(requirement.requiredResolvedCardIds.map((id) => [
      id,
      requireUniqueSourceRecord(cards, id, `${item.id} card`),
    ]));
    const evidenceSources = new Map(requirement.requiredEvidenceIds.map((id) => [
      id,
      requireUniqueSourceRecord(qaRecords, id, `${item.id} official evidence`),
    ]));
    contexts.set(item.id, Object.freeze({
      requirement,
      cardSources,
      evidenceSources,
      sourceEvidenceIds,
    }));
  }
  return contexts;
}

function requireUniqueSourceRecord(records, id, label) {
  const matches = records.filter((item) => String(item?.id || item?.cardId || "") === id);
  if (matches.length !== 1) {
    throw new Error(`${label} ${id} resolved to ${matches.length} source records`);
  }
  return matches[0];
}

function parseFrozenPromptPayload(prompt) {
  const marker = "本次用户问题、卡片原文与检索资料如下：\n";
  const source = String(prompt || "");
  const markerIndex = source.lastIndexOf(marker);
  const candidate = markerIndex >= 0
    ? source.slice(markerIndex + marker.length)
    : source.trimEnd().slice(source.trimEnd().lastIndexOf("\n") + 1);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function serializedPromptEvidence(payload = {}) {
  if (Array.isArray(payload.evidence)) return payload.evidence;
  if (!payload.evidence || typeof payload.evidence !== "object") return [];
  return Object.values(payload.evidence).flatMap((items) => (
    Array.isArray(items) ? items : []
  ));
}

function indexUniquePromptItems(items = [], label = "prompt items") {
  const result = new Map();
  for (const item of items) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    if (result.has(id)) throw new Error(`${label} contains duplicate id ${id}`);
    result.set(id, item);
  }
  return result;
}

function requireUniqueSelectedEvidenceDiagnostic(record, id) {
  const diagnostics = Array.isArray(record?.selectedEvidenceDiagnostics)
    ? record.selectedEvidenceDiagnostics
    : [];
  const matches = diagnostics.filter((item) => String(item?.id || "").trim() === id);
  if (matches.length !== 1) {
    throw new Error(
      `${record.id} evidence ${id}.sourceUrl differs from qa-index.json: selectedEvidenceDiagnostics contains ${matches.length} matching records`,
    );
  }
  return matches[0];
}

function promptEvidenceAuditBody(item = {}) {
  return {
    question: String(item.question || ""),
    detailedScene: String(item.detailedScene || ""),
    answer: String(item.answer || ""),
    text: String(item.text || ""),
  };
}

function assertSourceEqualPromptEvidenceBody({
  caseId,
  evidenceId,
  sourceRecord = {},
  serialized = {},
} = {}) {
  const sourceQuestion = String(sourceRecord.question || sourceRecord.rawQuestion || "").trim();
  const sourceDetailedScene = String(
    sourceRecord.rawDetailedQuestion
      || sourceRecord.detailedScene
      || sourceRecord.detailedQuestion
      || "",
  ).trim();
  const sourceAnswer = String(
    sourceRecord.answer || sourceRecord.officialAnswer || sourceRecord.conclusion || "",
  ).trim();
  const structuredFields = Object.entries({
    question: sourceQuestion,
    detailedScene: sourceDetailedScene,
    answer: sourceAnswer,
  }).filter(([, value]) => value);
  for (const [field, expected] of structuredFields) {
    if (String(serialized[field] ?? "") !== String(expected)) {
      throw new Error(`${caseId} evidence ${evidenceId}.${field} is incomplete or differs from qa-index.json`);
    }
  }
  if (structuredFields.length) return;
  const sourceText = String(
    sourceRecord.text || sourceRecord.fullText || sourceRecord.officialText || "",
  ).trim();
  if (!sourceText) return;
  const serializedBody = [
    serialized.question,
    serialized.detailedScene,
    serialized.answer,
    serialized.text,
  ].map((value) => String(value || "")).filter(Boolean).join("\n");
  const sourceLines = [...new Set(sourceText.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean))];
  const missingLine = sourceLines.find((line) => !serializedBody.includes(line));
  if (missingLine) {
    throw new Error(`${caseId} evidence ${evidenceId} omits source line: ${missingLine}`);
  }
}

function assertStoredEvidenceAudit(item) {
  const audit = item?.evidenceAudit;
  if (!audit || audit.status !== "complete") {
    throw new Error(`${item?.id || "unknown case"} has no completed evidence audit`);
  }
  const { auditSha256, ...auditPayload } = audit;
  if (auditSha256 !== sha256(JSON.stringify(auditPayload))) {
    throw new Error(`${item.id} evidence audit hash mismatch`);
  }
  if (audit.questionSha256 !== item.questionSha256
      || audit.dataRevision !== item.dataRevision
      || audit.evidenceFingerprint !== item.evidenceFingerprint
      || audit.promptUtf8Sha256 !== item.promptUtf8Sha256) {
    throw new Error(`${item.id} evidence audit is not bound to the frozen prompt and data`);
  }
  const payload = parseFrozenPromptPayload(item.prompt);
  if (!payload) throw new Error(`${item.id} frozen prompt payload cannot be parsed`);
  const cards = indexUniquePromptItems(payload.resolvedCards || [], `${item.id} resolved cards`);
  const evidence = indexUniquePromptItems(serializedPromptEvidence(payload), `${item.id} evidence`);
  const allowed = new Set(extractPromptAllowedEvidenceIds(item.prompt));
  for (const expected of audit.cardEffectTextSha256 || []) {
    const card = cards.get(String(expected.id));
    if (!card || sha256(String(card.effectText || "")) !== expected.sha256) {
      throw new Error(`${item.id} frozen card ${expected.id} no longer matches its evidence audit`);
    }
  }
  for (const expected of audit.evidenceBodySha256 || []) {
    const source = evidence.get(String(expected.id));
    if (!source || !allowed.has(String(expected.id))
        || sha256(JSON.stringify(promptEvidenceAuditBody(source))) !== expected.sha256) {
      throw new Error(`${item.id} frozen evidence ${expected.id} no longer matches its audit`);
    }
  }
  for (const expected of audit.evidenceSourceUrlSha256 || []) {
    const diagnostic = requireUniqueSelectedEvidenceDiagnostic(item, String(expected.id));
    if (sha256(String(diagnostic.sourceUrl || "")) !== expected.sha256) {
      throw new Error(`${item.id} frozen evidence ${expected.id}.sourceUrl no longer matches its audit`);
    }
  }
  for (const id of audit.requiredRelatedOnlyEvidenceIds || []) {
    if (evidence.get(String(id))?.retrievalContext?.relatedOnly !== true) {
      throw new Error(`${item.id} frozen evidence ${id} lost its related-only boundary`);
    }
  }
  for (const id of audit.forbiddenEvidenceIds || []) {
    if (allowed.has(String(id)) || evidence.has(String(id)) || item.prompt.includes(String(id))) {
      throw new Error(`${item.id} forbidden evidence ${id} entered the frozen prompt`);
    }
  }
}

function normalizedIdList(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const ids = value.map((item) => requiredText(item, name));
  if (new Set(ids).size !== ids.length) throw new TypeError(`${name} contains duplicates`);
  return ids;
}

function requiredSha256(value, name) {
  const digest = requiredText(value, name).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new TypeError(`${name} must be a SHA-256 digest`);
  return digest;
}

function compareAuditIds(left, right) {
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function normalizeSnapshotBundle(value) {
  if (value?.schemaVersion !== SCHEMA_VERSION
      || value?.kind !== "frozen_public_rag_final_inputs"
      || value?.status !== "complete") {
    throw new TypeError("snapshot must be a completed frozen public RAG bundle");
  }
  const cases = Array.isArray(value.cases) ? value.cases : [];
  if (!cases.length) throw new TypeError("snapshot contains no cases");
  cases.forEach(assertFrozenCaseInvariant);
  const expectedBundleHash = sha256(JSON.stringify(
    cases.map((item) => ({
      requestInvariantSha256: item.requestInvariantSha256,
      evidenceAuditSha256: item.evidenceAudit.auditSha256,
    })),
  ));
  if (value.bundleInvariantSha256 !== expectedBundleHash) {
    throw new Error("snapshot bundle invariant hash mismatch");
  }
  const bundleTransportContract = normalizeTransportContract(value.transportContract);
  cases.forEach((item) => assertSameTransportContract(
    bundleTransportContract,
    item.transportContract,
  ));
  return value;
}

function assertFrozenCaseInvariant(item) {
  const prompt = requiredText(item?.prompt, "snapshot prompt", { trim: false });
  const model = requiredText(item?.model, "snapshot model");
  if (model !== PUBLIC_MODEL) throw new Error(`unsupported frozen model: ${model}`);
  const maxCompletionTokens = positiveInteger(item?.maxCompletionTokens, "snapshot maxCompletionTokens");
  const question = requiredText(item?.question, "snapshot question");
  if (item.questionSha256 !== sha256(question)) {
    throw new Error(`${item?.id || "unknown case"} frozen question hash mismatch`);
  }
  const transportContract = normalizeTransportContract(item?.transportContract);
  const messages = [{ role: "user", content: prompt }];
  const invariant = buildRequestInvariant({
    model,
    messages,
    maxCompletionTokens,
    transportContract,
  });
  if (item.promptUtf8Sha256 !== sha256(prompt)
      || item.messagesSha256 !== sha256(JSON.stringify(messages))
      || item.requestInvariantSha256 !== sha256(JSON.stringify(invariant))) {
    throw new Error(`${item?.id || "unknown case"} frozen input hash mismatch`);
  }
  if (item.promptTruncated === true) {
    throw new Error(`${item?.id || "unknown case"} frozen prompt is truncated`);
  }
  assertStoredEvidenceAudit(item);
}

function freezeCaptureRequest(request = {}) {
  return Object.freeze({
    prompt: requiredText(request.prompt, "final prompt", { trim: false }),
    provider: String(request.provider || ""),
    modelName: String(request.modelName || ""),
    maxTokens: Number(request.maxTokens),
    thinkingMode: String(request.thinkingMode || ""),
    reasoningEffort: String(request.reasoningEffort || ""),
  });
}

function createPrivateEvaluationEnv(env = {}, suffix = "run") {
  return {
    ...env,
    PUBLIC_RULING_MODEL_PROFILE: PUBLIC_PROFILE,
    PRIVATE_EVALUATION_MODE: "true",
    PRIVATE_EVALUATION_DIAGNOSTICS: "true",
    PRIVATE_EVALUATION_BUDGET_USD: String(env.PRIVATE_EVALUATION_BUDGET_USD || "40"),
    PRIVATE_EVALUATION_RUN_ID: `frozen-public-rag-${suffix}-${randomUUID()}`.slice(0, 128),
    HOST: "127.0.0.1",
  };
}

function buildRequestInvariant({ model, messages, maxCompletionTokens, transportContract }) {
  return {
    model,
    messages,
    max_completion_tokens: maxCompletionTokens,
    output_mode: FINAL_OUTPUT_MODE,
    transport: FINAL_TRANSPORT,
    relay_endpoint_sha256: transportContract.relayEndpointSha256,
    public_profile: PUBLIC_PROFILE,
    ruling_version: PUBLIC_RULING_VERSION,
  };
}

function buildTransportContract(env = {}) {
  const rawBaseUrl = requiredText(env.RELAY_BASE_URL, "RELAY_BASE_URL");
  let parsed;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new TypeError("RELAY_BASE_URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("RELAY_BASE_URL must be an HTTPS URL without credentials, query parameters or fragments");
  }
  const basePath = parsed.pathname.replace(/\/+$/u, "");
  const normalizedBase = `${parsed.origin}${basePath}`;
  const endpoint = normalizedBase.endsWith("/chat/completions")
    ? normalizedBase
    : `${normalizedBase}/chat/completions`;
  return Object.freeze({
    provider: "relay",
    transport: FINAL_TRANSPORT,
    outputMode: FINAL_OUTPUT_MODE,
    relayHost: parsed.host,
    relayEndpointSha256: sha256(endpoint),
  });
}

function normalizeTransportContract(value = {}) {
  const contract = {
    provider: requiredText(value.provider, "transportContract.provider"),
    transport: requiredText(value.transport, "transportContract.transport"),
    outputMode: requiredText(value.outputMode, "transportContract.outputMode"),
    relayHost: requiredText(value.relayHost, "transportContract.relayHost"),
    relayEndpointSha256: requiredText(
      value.relayEndpointSha256,
      "transportContract.relayEndpointSha256",
    ),
  };
  if (contract.provider !== "relay"
      || contract.transport !== FINAL_TRANSPORT
      || contract.outputMode !== FINAL_OUTPUT_MODE
      || !/^[a-f0-9]{64}$/u.test(contract.relayEndpointSha256)) {
    throw new Error("unsupported frozen transport contract");
  }
  return Object.freeze(contract);
}

function assertSameTransportContract(expected, actual) {
  const left = normalizeTransportContract(expected);
  const right = normalizeTransportContract(actual);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error("Relay endpoint or transport differs from the frozen web request");
  }
}

function assertReplayPreDispatchInvariant(item, { env, effort, transportContract } = {}) {
  if (/^(?:1|true|yes|on)$/iu.test(String(env?.RAG_DRY_RUN || "").trim())) {
    throw new Error(`${item.id} RAG_DRY_RUN must be disabled before replay`);
  }
  if (String(env?.RAG_MODEL_PROVIDER || "") !== "relay"
      || String(env?.RAG_MODEL || "") !== item.model
      || Number(env?.RAG_MAX_OUTPUT_TOKENS) !== item.maxCompletionTokens
      || !String(env?.RELAY_API_KEY || "").trim()) {
    throw new Error(`${item.id} resolved final-model request differs from the frozen Relay input`);
  }
  if (!ALLOWED_EFFORTS.has(String(effort || ""))) {
    throw new Error(`${item.id} unsupported replay reasoning effort`);
  }
  assertSameTransportContract(item.transportContract, transportContract);
}

function modelOutcomeDiagnostics(response, attempt) {
  return {
    rawAnswer: String(response?.rawText || ""),
    displayedAnswer: String(response?.answer?.shortAnswer || ""),
    answerRiskFlags: [...(response?.answer?.riskFlags || [])],
    finishReason: String(attempt?.finishReason || "") || null,
    returnedModel: String(attempt?.responseModel || "") || null,
    streamMetrics: attempt?.streamMetrics || null,
    warnings: [...(response?.warnings || [])],
    providerFailure: response?.providerFailure || null,
    dryRun: response?.dryRun === true,
  };
}

function assertCompletedModelOutcome(item, response, attempt) {
  if (response?.dryRun === true) {
    throw new Error(`${item.id} final model was not dispatched`);
  }
  if (response?.providerFailure) {
    throw new Error(`${item.id} Relay provider failed: ${response.providerFailure.code || "unknown"}`);
  }
  if (!attempt) throw new Error(`${item.id} has no real generation attempt`);
  const rawText = String(response?.rawText || "").trim();
  if (!rawText) throw new Error(`${item.id} Relay returned no visible answer`);
  const riskFlags = new Set(response?.answer?.riskFlags || []);
  if (riskFlags.has("model_output_not_displayable")) {
    throw new Error(`${item.id} Relay answer was not complete and displayable`);
  }
  const finishReason = String(attempt.finishReason || "").trim().toLowerCase();
  const missingFinishAccepted = !finishReason
    && (response?.warnings || []).includes("model_plain_text_missing_finish_reason_accepted");
  if (finishReason !== "stop" && !missingFinishAccepted) {
    throw new Error(`${item.id} Relay finish reason is not complete: ${finishReason || "missing"}`);
  }
  const returnedModel = String(attempt.responseModel || "").trim();
  if (returnedModel !== item.model) {
    throw new Error(`${item.id} Relay returned model ${returnedModel || "(missing)"}, expected ${item.model}`);
  }
}

function selectCases(cases, requestedIds = []) {
  const ids = [...new Set((requestedIds || []).map(normalizeCaseId))];
  const selected = ids.length
    ? ids.map((id) => cases.find((item) => item.id === id))
    : [...cases];
  if (selected.some((item) => !item)) {
    const available = new Set(cases.map((item) => item.id));
    const missing = ids.filter((id) => !available.has(id));
    throw new TypeError(`unknown cases: ${missing.join(", ")}`);
  }
  return selected;
}

function normalizeCaseId(value) {
  const id = String(value || "").trim();
  if (!/^case-\d{3,}$/u.test(id)) throw new TypeError(`invalid case id: ${id || "(empty)"}`);
  return id;
}

function requiredText(value, name, { trim = true } = {}) {
  const text = String(value ?? "");
  const checked = trim ? text.trim() : text;
  if (!checked) throw new TypeError(`${name} must not be empty`);
  return checked;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return number;
}

async function assertOutputDoesNotExist(file) {
  try {
    await readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing output: ${file}`);
}

function assertPathOutsideRepository(candidate, name) {
  const relativePath = path.relative(REPOSITORY_ROOT, path.resolve(candidate));
  const inside = relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  if (inside) {
    throw new TypeError(`${name} must be outside the repository because it contains private questions or model output`);
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  await rename(temporary, file);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function safeError(error) {
  return {
    name: String(error?.name || "Error"),
    code: String(error?.code || "") || null,
    message: String(error?.message || error || "unknown error"),
    outcomeKnown: error?.outcomeKnown ?? null,
    budgetReservationMayExist: error?.budgetReservationMayExist ?? null,
  };
}

function safeEvidenceAuditError(error) {
  const serialized = safeError(error);
  const originalMessage = serialized.message;
  return Object.freeze({
    ...serialized,
    message: originalMessage.replace(/(omits source line:)[\s\S]*$/u, "$1 [redacted]"),
    messageSha256: sha256(originalMessage),
  });
}

function safeEvidencePreparationError(error) {
  const serialized = safeError(error);
  return Object.freeze({
    ...serialized,
    message: "evidence preparation failed",
    messageSha256: sha256(serialized.message),
  });
}

function isRecoverableEvidencePreparationFailure(error) {
  return new Set([
    "rule_query_model_empty",
    "rule_query_model_timeout",
    "rule_query_model_unavailable",
  ]).has(String(error?.code || ""));
}

function helpText() {
  return `Usage:
  node scripts/frozen-public-rag-final-effort.mjs capture --dataset <test.txt> --snapshot <bundle.json> [--case case-004 ...] --max-calls <n>
  node scripts/frozen-public-rag-final-effort.mjs freeze --dataset <test.txt> --snapshot <bundle.json> --requirements <requirements.json> --diagnostics <safe.json> --case case-004 [--case ...] --max-calls <n>
  node scripts/frozen-public-rag-final-effort.mjs run --snapshot <bundle.json> --output <results.json> --effort <low|medium> --case case-004 [--case ...] --max-calls <n>

Capture executes the current public evidence-preparation path and saves each
model-visible prompt for manual review without an automated completeness gate.
Freeze executes the same path once and captures
the exact final prompt without calling the final model. It completes only after
the required cards and official records are source-equal and untruncated in the
serialized prompt. Run never rebuilds the prompt and performs one zero-retry
plain-text Relay final call per selected case.
This is a frozen final-call comparison, not an end-to-end Production web test.`;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseFrozenPublicRagArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  if (options.command === "capture") {
    await freezePublicRagFinalInputs({
      datasetPath: options.datasetPath,
      snapshotPath: options.snapshotPath,
      caseIds: options.caseIds,
      maxCalls: options.maxCalls,
      manualReviewOnly: true,
    });
    return;
  }
  if (options.command === "freeze") {
    await freezePublicRagFinalInputs({
      datasetPath: options.datasetPath,
      snapshotPath: options.snapshotPath,
      caseIds: options.caseIds,
      maxCalls: options.maxCalls,
      requirementsPath: options.requirementsPath,
      diagnosticsPath: options.diagnosticsPath,
    });
    return;
  }
  await runFrozenPublicRagFinalEffort({
    snapshotPath: options.snapshotPath,
    outputPath: options.outputPath,
    effort: options.effort,
    caseIds: options.caseIds,
    maxCalls: options.maxCalls,
  });
}

function isDirectExecution() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
