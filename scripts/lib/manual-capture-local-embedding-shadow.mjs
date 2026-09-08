import crypto from "node:crypto";

import { projectOfficialQaQuestion } from "../../backend/officialQaQuestionProjection.mjs";
import { selectOfficialQaSearchBranch } from "../../backend/ruleSearchQueryText.mjs";
import {
  buildManualCaptureCompleteLexicalQueryQueue,
} from "./manual-capture-evidence-selection.mjs";

export const MANUAL_CAPTURE_EMBEDDING_MODEL = Object.freeze({
  id: "Qwen/Qwen3-Embedding-0.6B",
  revision: "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
});

export const MANUAL_CAPTURE_EMBEDDING_QUERY_INSTRUCTION =
  "Given a web search query, retrieve relevant passages that answer the query";

export const MANUAL_CAPTURE_EMBEDDING_INPUT_CONTRACT = Object.freeze({
  schemaVersion: 1,
  textNormalization: "nfkc_lf_trim_lines_collapse_horizontal_whitespace_v1",
  questionSceneView:
    "official_qa_labeled_title_question_raw_question_raw_detailed_projected_scene_card_reference_context_or_rule_doc_title_v3",
  rulingBodyView:
    "official_qa_separated_answer_else_complete_official_body_card_reference_context_or_rule_doc_source_record_body_v3",
  queryTemplate: "Instruct: {instruction}\\nQuery:{query}",
  queryInstruction: MANUAL_CAPTURE_EMBEDDING_QUERY_INSTRUCTION,
  documentInstruction: null,
  tokenizerPaddingSide: "left",
  tokenizerMaxLength: 8192,
  tokenizerTruncation: true,
  pooling: "last_non_padding_token",
  normalization: "l2",
  similarity: "exact_cosine_matrix_max_two_views",
  vectorDtype: "float32",
});

export const MANUAL_CAPTURE_EMBEDDING_INPUT_CONTRACT_SHA256 = sha256(
  canonicalJson(MANUAL_CAPTURE_EMBEDDING_INPUT_CONTRACT),
);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function compareStableText(left, right) {
  return String(left || "").localeCompare(String(right || ""), "en");
}

export function normalizeManualCaptureEmbeddingText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v ]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function uniqueNormalizedRows(rows = []) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const text = normalizeManualCaptureEmbeddingText(row?.text);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(Object.freeze({ label: String(row.label || "text"), text }));
  }
  return result;
}

function labeledView(rows) {
  return rows.map((row) => `[${row.label}]\n${row.text}`).join("\n\n");
}

export function buildManualCaptureEmbeddingDocumentViews(candidate = {}) {
  const binding = String(candidate?.binding || "").trim();
  if (!/^[a-f0-9]{64}$/u.test(binding)) {
    throw new Error("manual_capture_embedding_candidate_binding_invalid");
  }
  const record = candidate?.body && typeof candidate.body === "object"
    ? candidate.body
    : candidate;
  const ruleDocument = String(record?.recordType || "").trim() === "rule-doc";
  const projected = ruleDocument ? null : projectOfficialQaQuestion(record);
  const questionRows = ruleDocument
    ? uniqueNormalizedRows([{ label: "title", text: record.title }])
    : uniqueNormalizedRows([
        { label: "title", text: record.title },
        { label: "question", text: record.question },
        { label: "raw_question", text: record.rawQuestion },
        { label: "raw_detailed_question", text: record.rawDetailedQuestion },
        { label: "projected_scenario", text: projected.scenarioText },
        { label: "projected_principal", text: projected.principalText },
        { label: "card_reference_context", text: record.cardReferenceContext },
      ]);
  if (questionRows.length === 0) {
    throw new Error("manual_capture_embedding_question_view_empty");
  }
  const separatedAnswerRows = ruleDocument
    ? []
    : uniqueNormalizedRows([
        { label: "answer", text: record.answer },
        { label: "conclusion", text: record.conclusion },
        { label: "projected_answer", text: projected.answerText },
      ]);
  const completeBody = normalizeManualCaptureEmbeddingText(
    record.text || record.fullText || candidate.text,
  );
  const answerSeparated = separatedAnswerRows.length > 0;
  const rulingRows = ruleDocument
    ? uniqueNormalizedRows([{ label: "source_record_body", text: completeBody }])
    : answerSeparated
      ? uniqueNormalizedRows([
          ...separatedAnswerRows,
          { label: "card_reference_context", text: record.cardReferenceContext },
        ])
      : uniqueNormalizedRows([
          { label: "official_record_body", text: completeBody },
          { label: "card_reference_context", text: record.cardReferenceContext },
        ]);
  if (rulingRows.length === 0) {
    throw new Error("manual_capture_embedding_ruling_view_empty");
  }
  const questionSceneText = labeledView(questionRows);
  const rulingBodyText = labeledView(rulingRows);
  const normalizedBodySha256 = sha256(canonicalJson({
    schemaVersion: 1,
    questionSceneText,
    rulingBodyText,
    answerSeparated,
  }));
  return Object.freeze({
    binding,
    candidateBodySha256: String(candidate?.bodySha256 || ""),
    normalizedBodySha256,
    views: Object.freeze([
      Object.freeze({
        kind: "question_scene_v1",
        text: questionSceneText,
        textSha256: sha256(questionSceneText),
      }),
      Object.freeze({
        kind: "ruling_body_v1",
        text: rulingBodyText,
        textSha256: sha256(rulingBodyText),
        answerSeparated,
      }),
    ]),
  });
}

function normalizedInformationNeeds(informationNeeds) {
  if (!Array.isArray(informationNeeds)) {
    throw new TypeError("manual_capture_embedding_information_needs_invalid");
  }
  const seen = new Set();
  const result = [];
  for (const item of informationNeeds) {
    const need = normalizeManualCaptureEmbeddingText(
      typeof item === "string" ? item : item?.need,
    );
    if (!need || seen.has(need)) continue;
    seen.add(need);
    result.push(need);
  }
  if (result.length === 0) {
    throw new TypeError("manual_capture_embedding_information_needs_invalid");
  }
  return Object.freeze(result);
}

export function buildManualCaptureEmbeddingRuleQueryRows(modelRuleSearchQueries) {
  if (modelRuleSearchQueries === undefined || modelRuleSearchQueries === null) {
    return Object.freeze([]);
  }
  if (!Array.isArray(modelRuleSearchQueries)) {
    throw new TypeError("manual_capture_embedding_rule_queries_invalid");
  }
  const seen = new Set();
  const result = [];
  const append = (sourceRuleIndex, value) => {
    const text = selectOfficialQaSearchBranch(value);
    if (!text || seen.has(text)) return;
    seen.add(text);
    result.push(Object.freeze({
      kind: "rule_query",
      sourceRuleIndex,
      text,
    }));
  };
  // Preserve every existing query-derived surface and index before appending
  // the distinct official-question branch omitted by the former projection.
  for (let sourceRuleIndex = 0; sourceRuleIndex < modelRuleSearchQueries.length; sourceRuleIndex += 1) {
    const item = modelRuleSearchQueries[sourceRuleIndex];
    append(sourceRuleIndex, item?.query || item?.scenarioQuestion || item?.officialQuestion);
  }
  for (let sourceRuleIndex = 0; sourceRuleIndex < modelRuleSearchQueries.length; sourceRuleIndex += 1) {
    const item = modelRuleSearchQueries[sourceRuleIndex];
    append(sourceRuleIndex, item?.officialQuestion || item?.query);
  }
  return Object.freeze(result);
}

function stableCandidatePool(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError("manual_capture_embedding_candidate_pool_invalid");
  }
  const ordered = [...candidates].sort((left, right) => (
    compareStableText(left?.binding, right?.binding)
  ));
  const bindings = ordered.map((candidate) => String(candidate?.binding || ""));
  if (bindings.some((binding) => !/^[a-f0-9]{64}$/u.test(binding))
      || new Set(bindings).size !== bindings.length) {
    throw new Error("manual_capture_embedding_candidate_pool_binding_invalid");
  }
  return Object.freeze(ordered);
}

function validateCompleteQueue(queue, stableCandidates, code) {
  if (!Array.isArray(queue) || queue.length !== stableCandidates.length) {
    throw new Error(code);
  }
  const expected = new Set(stableCandidates.map((candidate) => candidate.binding));
  const actual = queue.map((candidate) => String(candidate?.binding || ""));
  if (new Set(actual).size !== actual.length
      || actual.some((binding) => !expected.has(binding))) {
    throw new Error(code);
  }
  return Object.freeze([...queue]);
}

export function buildManualCaptureEmbeddingShadowInputs({
  candidates,
  userQuery,
  informationNeeds,
  modelRuleSearchQueries,
} = {}) {
  const stableCandidates = stableCandidatePool(candidates);
  const question = normalizeManualCaptureEmbeddingText(userQuery);
  if (!question) throw new TypeError("manual_capture_embedding_question_invalid");
  const needs = normalizedInformationNeeds(informationNeeds)
    .filter((need) => need !== question);
  const queryRows = [
    Object.freeze({ kind: "original_question", text: question }),
    ...needs.map((need, needIndex) => Object.freeze({
      kind: "information_need",
      needIndex,
      text: need,
    })),
    ...buildManualCaptureEmbeddingRuleQueryRows(modelRuleSearchQueries),
  ].map((row) => {
    const modelInput = `Instruct: ${MANUAL_CAPTURE_EMBEDDING_QUERY_INSTRUCTION}\nQuery:${row.text}`;
    return Object.freeze({
      ...row,
      textSha256: sha256(row.text),
      modelInput,
      modelInputSha256: sha256(modelInput),
    });
  });
  const documents = stableCandidates.map(buildManualCaptureEmbeddingDocumentViews);
  return Object.freeze({
    stableCandidates,
    documents: Object.freeze(documents),
    queryRows: Object.freeze(queryRows),
    eligiblePoolSha256: sha256(canonicalJson(stableCandidates.map((candidate) => ({
      binding: candidate.binding,
      bodySha256: candidate.bodySha256,
    })))),
  });
}

function denseQueueForScores(stableCandidates, scores) {
  if (!Array.isArray(scores) || scores.length !== stableCandidates.length
      || scores.some((score) => !Number.isFinite(score))) {
    throw new Error("manual_capture_embedding_dense_scores_invalid");
  }
  return Object.freeze(stableCandidates.map((candidate, index) => ({
    candidate,
    score: scores[index],
  })).sort((left, right) => (
    right.score - left.score
      || compareStableText(left.candidate.binding, right.candidate.binding)
  )).map((row) => row.candidate));
}

function roundRobinCompleteQueues(queues) {
  const positions = Array(queues.length).fill(0);
  const selected = new Set();
  const ordered = [];
  while (true) {
    let added = false;
    for (let queueIndex = 0; queueIndex < queues.length; queueIndex += 1) {
      const queue = queues[queueIndex];
      while (positions[queueIndex] < queue.length) {
        const candidate = queue[positions[queueIndex]];
        positions[queueIndex] += 1;
        if (selected.has(candidate.binding)) continue;
        selected.add(candidate.binding);
        ordered.push(candidate);
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  return { ordered, selected };
}

export function buildManualCaptureLexicalDenseShadowTotalOrder({
  globalOrderedCandidates,
  candidates,
  userQuery,
  informationNeeds,
  modelRuleSearchQueries,
  denseScoresByQueryInputSha256,
  dataRevision,
  modelSnapshotSha256,
} = {}) {
  const inputs = buildManualCaptureEmbeddingShadowInputs({
    candidates,
    userQuery,
    informationNeeds,
    modelRuleSearchQueries,
  });
  const globalQueue = validateCompleteQueue(
    globalOrderedCandidates,
    inputs.stableCandidates,
    "manual_capture_embedding_global_queue_invalid",
  );
  if (!denseScoresByQueryInputSha256
      || typeof denseScoresByQueryInputSha256 !== "object"
      || Array.isArray(denseScoresByQueryInputSha256)) {
    throw new TypeError("manual_capture_embedding_dense_result_invalid");
  }
  const queues = [Object.freeze({ kind: "global_complete", queue: globalQueue })];
  for (const row of inputs.queryRows) {
    const lexicalQueue = buildManualCaptureCompleteLexicalQueryQueue({
      query: row.text,
      candidates: inputs.stableCandidates,
    });
    const denseQueue = denseQueueForScores(
      inputs.stableCandidates,
      denseScoresByQueryInputSha256[row.modelInputSha256],
    );
    const suffix = row.kind === "information_need"
      ? { needIndex: row.needIndex }
      : row.kind === "rule_query"
        ? { sourceRuleIndex: row.sourceRuleIndex }
        : {};
    queues.push(
      Object.freeze({ kind: `${row.kind}_lexical`, ...suffix, queue: lexicalQueue }),
      Object.freeze({ kind: `${row.kind}_dense`, ...suffix, queue: denseQueue }),
    );
  }
  const interleaved = roundRobinCompleteQueues(queues.map((row) => row.queue));
  const realQueueCandidateCount = interleaved.ordered.length;
  for (const candidate of inputs.stableCandidates) {
    if (interleaved.selected.has(candidate.binding)) continue;
    interleaved.selected.add(candidate.binding);
    interleaved.ordered.push(candidate);
  }
  if (interleaved.ordered.length !== inputs.stableCandidates.length
      || interleaved.selected.size !== inputs.stableCandidates.length) {
    throw new Error("manual_capture_embedding_total_order_incomplete");
  }
  const queueSummaries = Object.freeze(queues.map((row) => Object.freeze({
    kind: row.kind,
    ...(row.needIndex === undefined ? {} : { needIndex: row.needIndex }),
    ...(row.sourceRuleIndex === undefined ? {} : { sourceRuleIndex: row.sourceRuleIndex }),
    candidateCount: row.queue.length,
    queueSha256: sha256(canonicalJson(row.queue.map((candidate) => candidate.binding))),
  })));
  const orderedCandidateBindings = Object.freeze(
    interleaved.ordered.map((candidate) => candidate.binding),
  );
  const revision = String(dataRevision || "").trim();
  const snapshotHash = String(modelSnapshotSha256 || "").trim();
  if (!/^[a-f0-9]{64}$/u.test(revision)
      || !/^[a-f0-9]{64}$/u.test(snapshotHash)) {
    throw new Error("manual_capture_embedding_total_order_binding_invalid");
  }
  return Object.freeze({
    strategy: "need_first_lexical_dense_complete_surfaces_v1",
    model: MANUAL_CAPTURE_EMBEDDING_MODEL,
    modelSnapshotSha256: snapshotHash,
    inputContractSha256: MANUAL_CAPTURE_EMBEDDING_INPUT_CONTRACT_SHA256,
    eligiblePoolSha256: inputs.eligiblePoolSha256,
    queryRows: inputs.queryRows,
    documents: inputs.documents,
    queueSummaries,
    queryQueues: Object.freeze(queues),
    orderedCandidates: Object.freeze(interleaved.ordered),
    orderedCandidateBindings,
    candidateCount: interleaved.ordered.length,
    realQueueCandidateCount,
    fallbackCandidateCount: interleaved.ordered.length - realQueueCandidateCount,
    prefixes: Object.freeze({
      "192": Object.freeze(interleaved.ordered.slice(0, 192)),
      "256": Object.freeze(interleaved.ordered.slice(0, 256)),
    }),
    totalOrderSha256: sha256(canonicalJson({
      strategy: "need_first_lexical_dense_complete_surfaces_v1",
      dataRevision: revision,
      model: MANUAL_CAPTURE_EMBEDDING_MODEL,
      modelSnapshotSha256: snapshotHash,
      inputContractSha256: MANUAL_CAPTURE_EMBEDDING_INPUT_CONTRACT_SHA256,
      eligiblePoolSha256: inputs.eligiblePoolSha256,
      questionSha256: sha256(normalizeManualCaptureEmbeddingText(userQuery)),
      informationNeedSha256s: normalizedInformationNeeds(informationNeeds).map(sha256),
      ...(inputs.queryRows.some((row) => row.kind === "rule_query") ? {
        ruleQuerySha256s: inputs.queryRows
          .filter((row) => row.kind === "rule_query")
          .map((row) => row.textSha256),
      } : {}),
      queueSummaries,
      orderedCandidateBindings,
    })),
  });
}
