import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { answerQuestion, loadSnapshot } from "../backend/engine.mjs";
import { classifyEvidenceQuestionTypes } from "../backend/evidenceQuestionTypeClassifier.mjs";
import { BENCHMARK_CASES } from "./benchmark-report.mjs";

const targetCases = new Set([
  "toon-battle-destruction-chain",
  "perfect-toon-world-temporary-banish",
  "triple-tactics-talent-activation",
  "ohime-damage-step-activation",
]);

export async function runEvidenceTypeAudit() {
  const snapshot = await loadSnapshot();
  const recordsById = new Map((snapshot.records || []).map((record) => [String(record.id || record.evidenceId), record]));
  const audits = [];

  for (const benchmarkCase of BENCHMARK_CASES.filter((item) => targetCases.has(item.id))) {
    const answer = await answerQuestion(
      { question: benchmarkCase.question },
      { useModel: false, onDemandSync: false }
    );
    const trace = (answer.parserDebug?.evidenceTrace || []).find((item) => item.questionId === "q1");
    const subQuestion = (answer.formalQuery?.subQuestions || []).find((item) => item.id === "q1") || {};
    if (!trace) continue;

    audits.push({
      caseId: benchmarkCase.id,
      questionId: "q1",
      sourceText: subQuestion.sourceText || trace.sourceText || "",
      subQuestionType: subQuestion.type || trace.type || "unknown",
      askedResult: subQuestion.askedResult || "unknown",
      card: subQuestion.card || trace.card || "unknown",
      rawCandidateEvidenceTop20: (trace.rawCandidateEvidence || []).slice(0, 20).map((candidate) => {
        const record = recordsById.get(String(candidate.id)) || {};
        const fullText = evidenceFullText(record) || candidate.textPreview || "";
        const detected = classifyEvidenceQuestionTypes(fullText);
        const compatible = evidenceTypesCompatible(subQuestion.type || trace.type, detected);
        const sameCard = (candidate.matchedBy || []).some((item) => item === "resolved_card_id" || item === "card_name");
        const shouldBeDirectCandidate = Boolean(
          sameCard
          && compatible
          && candidate.askedResultCoverage === "explicit"
          && !candidate.rejectedReason
        );
        return {
          id: candidate.id,
          title: candidate.title,
          textPreview: candidate.textPreview,
          fullText,
          currentClassification: candidate.classification || "unknown",
          currentRejectedReason: candidate.rejectedReason || null,
          detectedEvidenceQuestionTypes: detected.questionTypes,
          detectedActions: detected.actions,
          detectedTiming: detected.timing,
          detectedPolarity: detected.polarity,
          askedResultCoverage: candidate.askedResultCoverage || "unknown",
          shouldBeDirectCandidate,
          auditReason: auditReason({ candidate, detected, compatible, sameCard }),
        };
      }),
    });
  }

  return { audits };
}

function evidenceTypesCompatible(subQuestionType, detected) {
  const types = new Set(detected.questionTypes || []);
  const actions = new Set(detected.actions || []);
  if (subQuestionType === "activation_condition") {
    return types.has("activation_condition")
      || types.has("activation_timing")
      || types.has("damage_step_activation");
  }
  if (subQuestionType === "temporary_banish") {
    return types.has("temporary_banish")
      || types.has("banish_applicability")
      || (types.has("effect_applicability") && actions.has("banish"));
  }
  if (subQuestionType === "resolution_handling") {
    return types.has("resolution_handling") || types.has("effect_applicability");
  }
  return types.has(subQuestionType);
}

function auditReason({ candidate, detected, compatible, sameCard }) {
  if (!sameCard) return "different_card_or_context";
  if (!compatible) return "evidence_question_type_not_compatible";
  if (candidate.askedResultCoverage !== "explicit") return `asked_result_${candidate.askedResultCoverage || "unknown"}`;
  if (candidate.rejectedReason) return candidate.rejectedReason;
  if (detected.polarity === "unknown") return "no_explicit_polarity";
  return "type_compatible_and_explicit";
}

function evidenceFullText(evidence) {
  return [
    evidence?.title,
    evidence?.question,
    evidence?.questionText,
    evidence?.conclusion,
    evidence?.answer,
    evidence?.answerText,
    evidence?.text,
    ...(Array.isArray(evidence?.steps) ? evidence.steps : []),
  ].filter(Boolean).join("\n\n").trim();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  console.log(JSON.stringify(await runEvidenceTypeAudit(), null, 2));
}

