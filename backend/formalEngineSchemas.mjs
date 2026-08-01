import { createHash } from "node:crypto";

export const FORMAL_CAPABILITIES_CONTRACT = "ocg-formal-capabilities/v1";
export const FORMAL_SCENARIO_DRAFT_CONTRACT = "ocg-formal-scenario-draft/v1";
export const FORMAL_SCENARIO_CONTRACT = "ocg-formal-scenario/v1";
export const FORMAL_RESULT_CONTRACT = "ocg-formal-scenario-result/v1";
export const FORMAL_PROOF_CERTIFICATE_CONTRACT = "ocg-proof-certificate/v1";
export const FORMAL_SOURCE_SPAN_ENCODING = "UTF16_CODE_UNIT_HALF_OPEN";
export const FORMAL_AUTHORITY_SCOPE = "SCENARIO_SLICE";
export const FORMAL_VERDICTS = Object.freeze(["TRUE", "FALSE", "UNKNOWN"]);

const VERDICTS = new Set(FORMAL_VERDICTS);
const SHA256 = /^[a-f0-9]{64}$/u;
const QUERY_PREDICATES = new Set(["PROCEDURE_AVAILABLE", "TRIGGER_CAN_ACTIVATE", "CHAIN_ORDER_VALID", "EVENT_ATTRIBUTION"]);
const INPUT_FACT_RULES = new Map([
  ["CARD_PRESENT", new Set(["USER_OBSERVED"])],
  ["CARD_POSITION", new Set(["USER_OBSERVED"])],
  ["LIFE_POINTS", new Set(["USER_OBSERVED"])],
  ["ZONE_CAPACITY", new Set(["USER_OBSERVED"])],
  ["PUBLIC_COUNTER_VALUE", new Set(["USER_OBSERVED"])],
  ["PUBLIC_CONTINUOUS_EFFECT_ACTIVE", new Set(["USER_OBSERVED"])],
  ["SPELL_EFFECT_ACTIVATED_THIS_TURN", new Set(["USER_OBSERVED"])],
  ["PRINTED_CARD_PROPERTY", new Set(["PRINTED_TEXT"])],
  ["PRINTED_EFFECT_REFERENCE", new Set(["PRINTED_TEXT"])],
  ["SUMMON_PROCEDURE_REFERENCE", new Set(["PRINTED_TEXT"])],
]);
const INPUT_EVENT_RULES = new Map([
  ["SPELL_EFFECT_ACTIVATED", new Set(["USER_OBSERVED"])],
  ["CARD_ACTIVATED", new Set(["USER_OBSERVED"])],
  ["SUMMON_DECLARED", new Set(["USER_OBSERVED"])],
  ["CHAIN_RESPONSE_DECLARED", new Set(["USER_OBSERVED"])],
]);
const INPUT_FACT_FIELDS = new Map([
  ["CARD_PRESENT", new Set(["subjectInstanceId", "value"])],
  ["CARD_POSITION", new Set(["subjectInstanceId", "position", "value"])],
  ["LIFE_POINTS", new Set(["player", "value"])],
  ["ZONE_CAPACITY", new Set(["player", "zone", "value"])],
  ["PUBLIC_COUNTER_VALUE", new Set(["subjectInstanceId", "counterName", "value"])],
  ["PUBLIC_CONTINUOUS_EFFECT_ACTIVE", new Set(["subjectInstanceId", "effectId", "value"])],
  ["SPELL_EFFECT_ACTIVATED_THIS_TURN", new Set(["player", "value"])],
  ["PRINTED_CARD_PROPERTY", new Set(["definitionRef", "property", "value"])],
  ["PRINTED_EFFECT_REFERENCE", new Set(["definitionRef"])],
  ["SUMMON_PROCEDURE_REFERENCE", new Set(["definitionRef"])],
]);
const INPUT_EVENT_FIELDS = new Map([
  ["SPELL_EFFECT_ACTIVATED", new Set(["player", "subjectInstanceId", "effectId"])],
  ["CARD_ACTIVATED", new Set(["player", "subjectInstanceId", "effectId"])],
  ["SUMMON_DECLARED", new Set(["player", "subjectInstanceId", "effectId"])],
  ["CHAIN_RESPONSE_DECLARED", new Set(["player", "subjectInstanceId", "effectId"])],
]);
const INPUT_FACT_REQUIRED_FIELDS = new Map([
  ["CARD_PRESENT", ["subjectInstanceId"]],
  ["CARD_POSITION", ["subjectInstanceId", "position"]],
  ["LIFE_POINTS", ["player", "value"]],
  ["ZONE_CAPACITY", ["player", "zone", "value"]],
  ["PUBLIC_COUNTER_VALUE", ["subjectInstanceId", "counterName", "value"]],
  ["PUBLIC_CONTINUOUS_EFFECT_ACTIVE", ["subjectInstanceId", "effectId", "value"]],
  ["SPELL_EFFECT_ACTIVATED_THIS_TURN", ["player", "value"]],
  ["PRINTED_CARD_PROPERTY", ["definitionRef", "property", "value"]],
  ["PRINTED_EFFECT_REFERENCE", ["definitionRef"]],
  ["SUMMON_PROCEDURE_REFERENCE", ["definitionRef"]],
]);
const INPUT_EVENT_REQUIRED_FIELDS = new Map([
  ["SPELL_EFFECT_ACTIVATED", ["player"]],
  ["CARD_ACTIVATED", ["player", "subjectInstanceId"]],
  ["SUMMON_DECLARED", ["player", "subjectInstanceId"]],
  ["CHAIN_RESPONSE_DECLARED", ["player"]],
]);

const FORMAL_BASE_CAPABILITIES = [
  "source/span-validation/v1",
  "metadata/card-definition-instance/v1",
  "metadata/definition-snapshot/v1",
  "capability/manifest-binding/v1",
  "proof/request-result-binding/v1",
];
const FORMAL_QUERY_CAPABILITIES = Object.freeze({
  PROCEDURE_AVAILABLE: ["summon/procedure/v1", "zone-change/provenance/v1", "zone-change/leave-field-destination-effect/v1"],
  TRIGGER_CAN_ACTIVATE: [
    "trigger/window-collection/v1", "proof/event-attribution/v1", "zone-change/provenance/v1",
    "event-group/same-timing/v1", "trigger/public-ordering/v1", "trigger/hand-response/v1",
    "chain/builder-priority-pass/v1",
  ],
  CHAIN_ORDER_VALID: [
    "trigger/window-collection/v1", "event-group/same-timing/v1",
    "trigger/public-ordering/v1", "chain/builder-priority-pass/v1",
  ],
  EVENT_ATTRIBUTION: ["event/history/v1", "zone-change/provenance/v1", "proof/event-attribution/v1"],
});
const FORMAL_INTENT_CAPABILITIES = Object.freeze({
  TRY_SUMMON_PROCEDURE: ["summon/procedure/v1", "zone-change/provenance/v1", "zone-change/leave-field-destination-effect/v1"],
});
const FORMAL_INPUT_CAPABILITIES = Object.freeze({
  SPELL_EFFECT_ACTIVATED_THIS_TURN: ["event/history/v1"],
  SPELL_EFFECT_ACTIVATED: ["event/history/v1"],
  CARD_ACTIVATED: ["event/history/v1"],
  SUMMON_DECLARED: ["event/history/v1"],
  CHAIN_RESPONSE_DECLARED: ["event/history/v1", "chain/builder-priority-pass/v1"],
  PRINTED_CARD_PROPERTY: ["metadata/definition-snapshot/v1"],
  PRINTED_EFFECT_REFERENCE: ["metadata/definition-snapshot/v1"],
  SUMMON_PROCEDURE_REFERENCE: ["metadata/definition-snapshot/v1", "summon/procedure/v1"],
});

export class FormalContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FormalContractError";
    this.code = code;
    this.details = details;
  }
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function proofCertificateId(certificate) {
  const body = { ...objectValue(certificate, "proof certificate") };
  delete body.certificateId;
  return "proof:" + canonicalSha256(body);
}

export function capabilityManifestSha256(capabilities) {
  const value = objectValue(capabilities, "formal capabilities response");
  return canonicalSha256({
    manifestId: value.capabilityManifestId,
    contractVersion: value.contractVersion,
    scenarioContractVersion: value.scenarioContractVersion,
    resultContractVersion: value.resultContractVersion,
    sourceSpanEncoding: value.sourceSpanEncoding,
    authorityScope: value.authorityScope,
    proofCertificateVersion: value.proofCertificateVersion,
    versions: value.versions,
    capabilities: normalizeCapabilityDescriptors(value.capabilities),
  });
}

export function definitionSnapshotSha256(snapshot) {
  const value = objectValue(snapshot, "definition snapshot");
  return canonicalSha256({
    snapshotId: value.snapshotId,
    definitions: normalizeDefinitions(value.definitions),
  });
}

export function formalRequestSha256(scenario) {
  return canonicalSha256(scenario);
}

export function formalInputSha256({ requestSha256, capabilityManifestSha256: capabilityDigest, definitionSnapshotSha256: definitionDigest }) {
  return canonicalSha256({
    requestSha256,
    capabilityManifestSha256: capabilityDigest,
    definitionSnapshotSha256: definitionDigest,
  });
}

export function formalQueryOutputSha256(result, queryResult) {
  const query = { ...objectValue(queryResult, "query result") };
  delete query.proofCertificate;
  delete query.certificateVerification;
  return canonicalSha256({
    scenarioId: result.scenarioId,
    queryResult: query,
    branches: result.branches,
    structuredTrace: result.structuredTrace,
    versions: {
      engineVersion: result.engineVersion,
      IRVersion: result.IRVersion,
      rulesetVersion: result.rulesetVersion,
      schemaVersion: result.schemaVersion,
      proofVerifierVersion: result.proofVerifierVersion,
    },
    bindings: {
      requestSha256: result.requestSha256,
      capabilityManifestSha256: result.capabilityManifestSha256,
      definitionSnapshotSha256: result.definitionSnapshotSha256,
    },
    completeness: {
      querySliceComplete: result.querySliceComplete,
      searchComplete: result.searchComplete,
      executionComplete: result.executionComplete,
      unresolvedSemantics: result.unresolvedSemantics,
    },
  });
}

export function deriveFormalRequiredCapabilities({ intents = [], queries = [], stateFacts = [], eventHistory = [] } = {}) {
  const required = new Set(FORMAL_BASE_CAPABILITIES);
  for (const intent of intents || []) {
    for (const capabilityId of FORMAL_INTENT_CAPABILITIES[intent?.type] || []) required.add(capabilityId);
  }
  for (const query of queries || []) {
    for (const capabilityId of FORMAL_QUERY_CAPABILITIES[query?.predicate] || []) required.add(capabilityId);
    for (const capabilityId of query?.requiredCapabilities || []) required.add(String(capabilityId));
  }
  for (const input of [...(stateFacts || []), ...(eventHistory || [])]) {
    for (const capabilityId of FORMAL_INPUT_CAPABILITIES[input?.type] || []) required.add(capabilityId);
  }
  return [...required].sort();
}

export function validateSourceSpan(span, sourceText, label = "sourceSpan") {
  const value = objectValue(span, label);
  equalValue(value.encoding, FORMAL_SOURCE_SPAN_ENCODING, label + ".encoding");
  const start = integerValue(value.start, label + ".start");
  const end = integerValue(value.end, label + ".end");
  if (start < 0 || end <= start || end > sourceText.length) {
    fail("FORMAL_SOURCE_SPAN_INVALID", label + " is outside the UTF-16 source text", {
      start,
      end,
      sourceLength: sourceText.length,
    });
  }
  const text = sourceText.slice(start, end);
  if (value.text !== undefined && value.text !== text) {
    fail("FORMAL_SOURCE_SPAN_INVALID", label + ".text does not match the source slice");
  }
  return { encoding: FORMAL_SOURCE_SPAN_ENCODING, start, end, text };
}

export function validateFormalScenario(value) {
  const scenario = objectValue(value, "formal scenario");
  equalValue(scenario.contractVersion, FORMAL_SCENARIO_CONTRACT, "scenario.contractVersion");
  equalValue(scenario.sourceSpanEncoding, FORMAL_SOURCE_SPAN_ENCODING, "scenario.sourceSpanEncoding");
  equalValue(scenario.authorityScope, FORMAL_AUTHORITY_SCOPE, "scenario.authorityScope");
  stringValue(scenario.scenarioId, "scenario.scenarioId");
  if (!new Set(["STRICT", "ABSTRACT_ASSUMPTIONS"]).has(scenario.mode)) {
    fail("FORMAL_SCENARIO_SCHEMA_INVALID", "scenario.mode must be STRICT or ABSTRACT_ASSUMPTIONS");
  }
  const question = objectValue(scenario.question, "scenario.question");
  const sourceText = stringValue(question.text, "scenario.question.text", false);
  if (!sourceText.trim()) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "scenario.question.text is empty");
  validateTurn(scenario.turn);
  validateInstances(scenario.cardInstances, sourceText);
  validateDefinitionSnapshot(scenario.definitionSnapshot, scenario.cardInstances);
  validateInputRecords(scenario.stateFacts, sourceText, "scenario.stateFacts", "factId", INPUT_FACT_RULES, INPUT_FACT_FIELDS, INPUT_FACT_REQUIRED_FIELDS);
  validateInputRecords(scenario.eventHistory, sourceText, "scenario.eventHistory", "eventId", INPUT_EVENT_RULES, INPUT_EVENT_FIELDS, INPUT_EVENT_REQUIRED_FIELDS);
  validateIntents(scenario.intents, sourceText);
  validateQueries(scenario.queries, sourceText);
  validateAssumptions(scenario.assumptions, sourceText, scenario.mode);
  validateCapabilityIds(scenario.requiredCapabilities);
  const requiredSet = new Set(scenario.requiredCapabilities);
  const omittedCapabilities = deriveFormalRequiredCapabilities(scenario).filter((capabilityId) => !requiredSet.has(capabilityId));
  if (omittedCapabilities.length) {
    fail("CAPABILITY_UNAVAILABLE", "scenario.requiredCapabilities omits capabilities implied by its semantics", { omittedCapabilities });
  }
  const branchPolicy = objectValue(scenario.branchPolicy, "scenario.branchPolicy");
  if (branchPolicy.preserveUnspecifiedResponses !== true) {
    fail("FORMAL_SCENARIO_SCHEMA_INVALID", "unspecified response branches must be preserved");
  }
  assertNoTrustedConclusions(scenario);
  validateReferences(scenario);
  return scenario;
}

export function validateFormalCapabilities(value, { expectedVersions = {} } = {}) {
  const capabilities = objectValue(value, "formal capabilities response");
  if (capabilities.ok !== true) fail("ENGINE_FORMAL_API_UNAVAILABLE", "formal capability endpoint did not return ok=true");
  equalValue(capabilities.contractVersion, FORMAL_CAPABILITIES_CONTRACT, "capabilities.contractVersion");
  equalValue(capabilities.scenarioContractVersion, FORMAL_SCENARIO_CONTRACT, "capabilities.scenarioContractVersion");
  equalValue(capabilities.resultContractVersion, FORMAL_RESULT_CONTRACT, "capabilities.resultContractVersion");
  equalValue(capabilities.sourceSpanEncoding, FORMAL_SOURCE_SPAN_ENCODING, "capabilities.sourceSpanEncoding");
  equalValue(capabilities.authorityScope, FORMAL_AUTHORITY_SCOPE, "capabilities.authorityScope");
  equalValue(capabilities.proofCertificateVersion, FORMAL_PROOF_CERTIFICATE_CONTRACT, "capabilities.proofCertificateVersion");
  stringValue(capabilities.capabilityManifestId, "capabilities.capabilityManifestId");
  digestValue(capabilities.capabilityManifestSha256, "capabilities.capabilityManifestSha256");
  const versions = validateVersions(capabilities.versions, "capabilities.versions");
  for (const [key, expected] of Object.entries(expectedVersions || {})) {
    if (expected !== undefined && expected !== null && versions[key] !== String(expected)) {
      fail("FORMAL_VERSION_INCOMPATIBLE", "formal engine version is incompatible: " + key, {
        key,
        expected: String(expected),
        actual: versions[key],
      });
    }
  }
  if (!Array.isArray(capabilities.capabilities)) {
    fail("FORMAL_CAPABILITY_SCHEMA_INVALID", "capabilities.capabilities must be an array");
  }
  const seen = new Set();
  for (const itemValue of capabilities.capabilities) {
    const item = objectValue(itemValue, "capability descriptor");
    const capabilityId = validateVersionedCapabilityId(item.capabilityId, "capability.capabilityId");
    if (seen.has(capabilityId)) fail("FORMAL_CAPABILITY_SCHEMA_INVALID", "duplicate capability: " + capabilityId);
    seen.add(capabilityId);
    const version = stringValue(item.version, "capability.version");
    if (version !== capabilityVersionFromId(capabilityId)) {
      fail("FORMAL_CAPABILITY_SCHEMA_INVALID", "capability version does not match its versioned ID: " + capabilityId);
    }
    if (!new Set(["SUPPORTED", "PARTIAL", "UNSUPPORTED"]).has(item.status)) {
      fail("FORMAL_CAPABILITY_SCHEMA_INVALID", "invalid capability status: " + capabilityId);
    }
    if (!Array.isArray(item.dependencies) || item.dependencies.some((entry) => typeof entry !== "string" || !entry)) {
      fail("FORMAL_CAPABILITY_SCHEMA_INVALID", "invalid capability dependencies: " + capabilityId);
    }
    for (const dependency of item.dependencies) validateVersionedCapabilityId(dependency, "capability dependency");
    if (new Set(item.dependencies).size !== item.dependencies.length) {
      fail("FORMAL_CAPABILITY_SCHEMA_INVALID", "duplicate capability dependency: " + capabilityId);
    }
  }
  if (capabilities.capabilityManifestSha256 !== capabilityManifestSha256(capabilities)) {
    fail("FORMAL_CAPABILITY_MANIFEST_INVALID", "capability manifest digest does not match its descriptors");
  }
  return capabilities;
}

export function assertRequiredCapabilities(capabilities, requiredCapabilities) {
  const descriptors = new Map(capabilities.capabilities.map((item) => [item.capabilityId, item]));
  const unavailable = [];
  const visited = new Set();
  const visit = (capabilityId, requiredBy = null) => {
    if (visited.has(capabilityId)) return;
    visited.add(capabilityId);
    const item = descriptors.get(capabilityId);
    const expectedVersion = capabilityVersionFromId(capabilityId);
    if (!item || item.status !== "SUPPORTED" || (expectedVersion && item.version !== expectedVersion)) {
      unavailable.push({
        capabilityId,
        requiredBy,
        status: item?.status || "MISSING",
        expectedVersion: expectedVersion || null,
        actualVersion: item?.version || null,
      });
      return;
    }
    for (const dependency of item.dependencies) visit(dependency, capabilityId);
  };
  for (const capabilityId of requiredCapabilities) visit(capabilityId);
  if (unavailable.length) {
    fail("CAPABILITY_UNAVAILABLE", "required formal capabilities are not fully supported", { unavailable });
  }
}

export function validateFormalResult(value, { scenario, capabilities, proofVerifier } = {}) {
  validateFormalScenario(scenario);
  validateFormalCapabilities(capabilities);
  assertRequiredCapabilities(capabilities, scenario.requiredCapabilities);
  const result = objectValue(value, "formal result");
  equalValue(result.contractVersion, FORMAL_RESULT_CONTRACT, "result.contractVersion");
  equalValue(result.scenarioId, scenario.scenarioId, "result.scenarioId");
  const requestDigest = formalRequestSha256(scenario);
  digestValue(result.requestSha256, "result.requestSha256");
  digestValue(result.capabilityManifestSha256, "result.capabilityManifestSha256");
  digestValue(result.definitionSnapshotSha256, "result.definitionSnapshotSha256");
  equalBinding(result.requestSha256, requestDigest, "result.requestSha256");
  equalBinding(result.capabilityManifestSha256, capabilities.capabilityManifestSha256, "result.capabilityManifestSha256");
  equalBinding(result.definitionSnapshotSha256, scenario.definitionSnapshot.manifestSha256, "result.definitionSnapshotSha256");
  const versions = validateVersions({
    engineVersion: result.engineVersion,
    IRVersion: result.IRVersion,
    rulesetVersion: result.rulesetVersion,
    schemaVersion: result.schemaVersion,
    proofVerifierVersion: result.proofVerifierVersion,
  }, "result versions");
  assertVersionMatch(versions, capabilities.versions);
  if (!Array.isArray(result.unresolvedSemantics)) fail("FORMAL_RESPONSE_SCHEMA_INVALID", "unresolvedSemantics must be an array");
  if (!Array.isArray(result.branches) || !Array.isArray(result.structuredTrace)) {
    fail("FORMAL_RESPONSE_SCHEMA_INVALID", "branches and structuredTrace must be arrays");
  }
  if (!Array.isArray(result.queryResults)) fail("FORMAL_RESPONSE_SCHEMA_INVALID", "queryResults must be an array");
  const expectedIds = scenario.queries.map((item) => item.queryId);
  const actualIds = result.queryResults.map((item) => item?.queryId);
  if (new Set(actualIds).size !== actualIds.length || expectedIds.length !== actualIds.length ||
      expectedIds.some((queryId) => !actualIds.includes(queryId))) {
    fail("FORMAL_RESPONSE_SCHEMA_INVALID", "result query IDs do not match scenario queries");
  }
  const complete = result.querySliceComplete === true && result.searchComplete === true &&
    result.executionComplete === true && result.unresolvedSemantics.length === 0;
  const queryResults = result.queryResults.map((queryValue) => {
    const queryId = String(queryValue?.queryId || "");
    try {
      return validateQueryResult(queryValue, {
        scenario,
        result,
        versions,
        capabilities,
        proofVerifier,
        complete,
      });
    } catch (error) {
      const normalized = normalizeContractFailure(error);
      return unknownQueryResult(queryId, normalized);
    }
  });
  return { ...result, queryResults };
}

function validateQueryResult(queryValue, { scenario, result, versions, capabilities, proofVerifier, complete }) {
  const query = objectValue(queryValue, "query result");
  stringValue(query.queryId, "queryResult.queryId");
  for (const field of ["witness", "counterexample", "proofCertificate", "certificateVerification", "unknownReasons"]) {
    if (!Object.hasOwn(query, field)) fail("FORMAL_RESPONSE_SCHEMA_INVALID", "query result is missing field: " + field);
  }
  if (!VERDICTS.has(query.verdict)) fail("FORMAL_RESPONSE_SCHEMA_INVALID", "query verdict must be TRUE, FALSE, or UNKNOWN");
  validateUnknownReasons(query.unknownReasons, query.verdict === "UNKNOWN");
  if (query.verdict === "UNKNOWN") {
    if (query.proofCertificate !== null || query.certificateVerification !== null || query.witness !== null || query.counterexample !== null) {
      fail("FORMAL_RESPONSE_SCHEMA_INVALID", "UNKNOWN cannot carry trusted proof, witness, or counterexample artifacts");
    }
    return query;
  }
  if (scenario.mode !== "STRICT") {
    fail("FORMAL_AUTHORITY_MODE_UNSUPPORTED", "only STRICT scenarios may retain verified TRUE/FALSE verdicts");
  }
  if (!complete) fail("FORMAL_EXECUTION_INCOMPLETE", "definitive verdict returned for incomplete scenario slice");
  if (query.unknownReasons.length) fail("FORMAL_RESPONSE_SCHEMA_INVALID", "definitive verdict cannot carry unknown reasons");
  if (query.verdict === "TRUE" && (!query.witness || typeof query.witness !== "object")) {
    fail("FORMAL_RESPONSE_SCHEMA_INVALID", "TRUE requires a witness");
  }
  if (query.verdict === "FALSE" && (!query.counterexample || typeof query.counterexample !== "object")) {
    fail("FORMAL_RESPONSE_SCHEMA_INVALID", "FALSE requires a counterexample");
  }
  validateProof(query, result, versions, capabilities, proofVerifier, scenario);
  return query;
}

function validateUnknownReasons(value, required) {
  if (!Array.isArray(value)) fail("FORMAL_RESPONSE_SCHEMA_INVALID", "unknownReasons must be an array");
  if (required && !value.length) fail("FORMAL_RESPONSE_SCHEMA_INVALID", "UNKNOWN requires an unknown reason");
  for (const reasonValue of value) {
    const reason = objectValue(reasonValue, "unknown reason");
    stringValue(reason.code, "unknownReason.code");
    stringValue(reason.message, "unknownReason.message");
    if (reason.details !== undefined) objectValue(reason.details, "unknownReason.details");
  }
}

function unknownQueryResult(queryId, error) {
  return {
    queryId,
    verdict: "UNKNOWN",
    witness: null,
    counterexample: null,
    proofCertificate: null,
    certificateVerification: null,
    unknownReasons: [{ code: error.code, message: error.message, details: error.details }],
  };
}

export function createUnknownFormalResult({ scenario, code, message, details = {} }) {
  const safeScenario = scenario && typeof scenario === "object" ? scenario : {};
  const queryIds = Array.isArray(safeScenario.queries)
    ? safeScenario.queries.map((item, index) => String(item?.queryId || "query-" + (index + 1)))
    : [];
  const reason = { code: String(code || "FORMAL_UNKNOWN"), message: String(message || "formal analysis unavailable"), details };
  return {
    contractVersion: FORMAL_RESULT_CONTRACT,
    scenarioId: String(safeScenario.scenarioId || "unknown-scenario"),
    queryResults: queryIds.map((queryId) => ({
      queryId,
      verdict: "UNKNOWN",
      witness: null,
      counterexample: null,
      proofCertificate: null,
      certificateVerification: null,
      unknownReasons: [reason],
    })),
    branches: [],
    structuredTrace: [],
    engineVersion: null,
    IRVersion: null,
    rulesetVersion: null,
    schemaVersion: null,
    proofVerifierVersion: null,
    unresolvedSemantics: [reason],
    querySliceComplete: false,
    searchComplete: false,
    executionComplete: false,
  };
}

function validateProof(query, result, versions, capabilities, proofVerifier, scenario) {
  const certificate = objectValue(query.proofCertificate, "proofCertificate");
  equalValue(certificate.schemaVersion, FORMAL_PROOF_CERTIFICATE_CONTRACT, "certificate.schemaVersion");
  equalValue(certificate.proofKind, "QUERY_VERDICT", "certificate.proofKind");
  equalValue(certificate.verdict, query.verdict, "certificate.verdict");
  const rootNodeId = stringValue(certificate.rootNodeId, "certificate.rootNodeId");
  assertVersionMatch(validateVersions(certificate.versions, "certificate.versions"), versions);
  const expectedInputHash = formalInputSha256({
    requestSha256: result.requestSha256,
    capabilityManifestSha256: result.capabilityManifestSha256,
    definitionSnapshotSha256: result.definitionSnapshotSha256,
  });
  const expectedOutputHash = formalQueryOutputSha256(result, query);
  equalBinding(certificate.inputHash, expectedInputHash, "certificate.inputHash");
  equalBinding(certificate.outputHash, expectedOutputHash, "certificate.outputHash");
  if (!Array.isArray(certificate.nodes)) fail("FORMAL_CERTIFICATE_INVALID", "certificate.nodes must be an array");
  const root = certificate.nodes.find((node) => node?.nodeId === rootNodeId);
  const rootVerdict = root?.verdict ?? root?.conclusion?.verdict;
  const rootQueryId = root?.queryId ?? root?.conclusion?.queryId;
  if (!root || rootVerdict !== query.verdict || rootQueryId !== query.queryId) {
    fail("FORMAL_CERTIFICATE_INVALID", "certificate root does not match query verdict");
  }
  if (certificate.certificateId !== proofCertificateId(certificate)) {
    fail("FORMAL_CERTIFICATE_INVALID", "certificateId does not match canonical body");
  }
  const receipt = objectValue(query.certificateVerification, "certificateVerification");
  if (receipt.valid !== true || receipt.queryId !== query.queryId || receipt.verdict !== query.verdict) {
    fail("FORMAL_CERTIFICATE_INVALID", "public verifier receipt does not bind query verdict");
  }
  equalValue(receipt.verifierVersion, capabilities.versions.proofVerifierVersion, "certificateVerification.verifierVersion");
  equalValue(receipt.certificateId, certificate.certificateId, "certificateVerification.certificateId");
  const certificateDigest = canonicalSha256(certificate);
  const exactBindings = {
    certificateSha256: certificateDigest,
    requestSha256: result.requestSha256,
    outputSha256: expectedOutputHash,
    capabilityManifestSha256: result.capabilityManifestSha256,
    definitionSnapshotSha256: result.definitionSnapshotSha256,
  };
  for (const [key, expected] of Object.entries(exactBindings)) {
    digestValue(receipt[key], "certificateVerification." + key);
    equalBinding(receipt[key], expected, "certificateVerification." + key);
  }
  if (typeof proofVerifier !== "function") {
    fail("FORMAL_PROOF_VERIFIER_UNAVAILABLE", "an independent public proof verifier is required for definitive verdicts");
  }
  let independentVerification;
  try {
    independentVerification = proofVerifier(deepFreeze(structuredClone({
      certificate,
      receipt,
      queryResult: query,
      scenario,
      capabilities,
      resultBindings: {
        requestSha256: result.requestSha256,
        outputSha256: expectedOutputHash,
        capabilityManifestSha256: result.capabilityManifestSha256,
        definitionSnapshotSha256: result.definitionSnapshotSha256,
      },
    })));
  } catch (error) {
    fail("FORMAL_CERTIFICATE_INVALID", "independent public proof verifier rejected the certificate", {
      verifierError: error instanceof Error ? error.message : String(error),
    });
  }
  if (!independentVerification || typeof independentVerification !== "object" || Array.isArray(independentVerification) || independentVerification.valid !== true) {
    fail("FORMAL_CERTIFICATE_INVALID", "independent public proof verifier must return a structured valid result");
  }
  const verifierBindings = {
    certificateId: certificate.certificateId,
    certificateSha256: certificateDigest,
    queryId: query.queryId,
    verdict: query.verdict,
    verifierVersion: capabilities.versions.proofVerifierVersion,
    requestSha256: result.requestSha256,
    outputSha256: expectedOutputHash,
    capabilityManifestSha256: result.capabilityManifestSha256,
    definitionSnapshotSha256: result.definitionSnapshotSha256,
  };
  for (const [key, expected] of Object.entries(verifierBindings)) {
    if (independentVerification[key] !== expected) {
      fail("FORMAL_CERTIFICATE_INVALID", "independent verifier result does not bind " + key);
    }
  }
}

function validateVersions(value, label) {
  const versions = objectValue(value, label);
  return Object.fromEntries(["engineVersion", "IRVersion", "rulesetVersion", "schemaVersion", "proofVerifierVersion"]
    .map((key) => [key, stringValue(versions[key], label + "." + key)]));
}

function assertVersionMatch(actual, expected) {
  for (const key of ["engineVersion", "IRVersion", "rulesetVersion", "schemaVersion", "proofVerifierVersion"]) {
    if (actual[key] !== expected[key]) {
      fail("FORMAL_VERSION_INCOMPATIBLE", "formal version mismatch: " + key, { expected: expected[key], actual: actual[key] });
    }
  }
}

function validateTurn(value) {
  const turn = objectValue(value, "scenario.turn");
  stringValue(turn.activePlayer, "scenario.turn.activePlayer");
  if (!new Set(["MAIN1", "MAIN2"]).has(turn.phase)) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "turn.phase must be MAIN1 or MAIN2");
}

function validateInstances(value, sourceText) {
  if (!Array.isArray(value) || !value.length) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "cardInstances must be non-empty");
  const ids = new Set();
  for (const instanceValue of value) {
    const instance = objectValue(instanceValue, "cardInstance");
    const id = stringValue(instance.instanceId, "cardInstance.instanceId");
    if (ids.has(id)) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "duplicate instanceId: " + id);
    ids.add(id);
    if (integerValue(instance.objectEpoch, "cardInstance.objectEpoch") < 0) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "objectEpoch cannot be negative");
    stringValue(instance.owner, "cardInstance.owner");
    stringValue(instance.controller, "cardInstance.controller");
    stringValue(instance.zone, "cardInstance.zone");
    const binding = objectValue(instance.definitionBinding, "definitionBinding");
    stringValue(binding.cardId, "definitionBinding.cardId");
    stringValue(binding.definitionId, "definitionBinding.definitionId");
    stringValue(binding.snapshotId, "definitionBinding.snapshotId");
    digestValue(binding.contentSha256, "definitionBinding.contentSha256");
    if (!Array.isArray(instance.effectBindings)) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "effectBindings must be an array");
    const effectIds = new Set();
    for (const effectValue of instance.effectBindings) {
      const effect = objectValue(effectValue, "effectBinding");
      const effectId = stringValue(effect.effectId, "effectBinding.effectId");
      if (effectIds.has(effectId)) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "duplicate effect binding: " + effectId);
      effectIds.add(effectId);
      stringValue(effect.definitionEffectId, "effectBinding.definitionEffectId");
      digestValue(effect.contentSha256, "effectBinding.contentSha256");
    }
    validateSourceSpan(instance.sourceSpan, sourceText, "cardInstance.sourceSpan");
  }
}

function validateInputRecords(value, sourceText, label, idField, rules, fieldRules, requiredFieldRules) {
  if (!Array.isArray(value)) fail("FORMAL_SCENARIO_SCHEMA_INVALID", label + " must be an array");
  const ids = new Set();
  for (const itemValue of value) {
    const item = objectValue(itemValue, label + " item");
    const id = stringValue(item[idField], label + "." + idField);
    if (ids.has(id)) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "duplicate " + idField + ": " + id);
    ids.add(id);
    const type = stringValue(item.type, label + ".type");
    const provenance = stringValue(item.provenance, label + ".provenance");
    const allowedProvenance = rules.get(type);
    if (!allowedProvenance || !allowedProvenance.has(provenance)) {
      fail("UNTRUSTED_DERIVED_FACT", label + " contains a fact/event type that callers may not author", { type, provenance });
    }
    const allowedFields = new Set([idField, "type", "provenance", "sourceSpan", ...(fieldRules.get(type) || [])]);
    const unexpectedFields = Object.keys(item).filter((key) => !allowedFields.has(key));
    if (unexpectedFields.length) {
      fail("UNTRUSTED_DERIVED_FACT", label + " contains fields outside the closed input schema", { type, unexpectedFields });
    }
    const missingFields = (requiredFieldRules.get(type) || []).filter((key) => item[key] === undefined || item[key] === null || item[key] === "");
    if (missingFields.length) {
      fail("FORMAL_SCENARIO_SCHEMA_INVALID", label + " is missing required fields for " + type, { missingFields });
    }
    for (const key of ["player", "subjectInstanceId", "effectId", "position", "zone", "counterName", "property"]) {
      if (item[key] !== undefined) stringValue(item[key], label + "." + key);
    }
    if (item.value !== undefined && !["string", "number", "boolean"].includes(typeof item.value)) {
      fail("UNTRUSTED_DERIVED_FACT", label + ".value must be a scalar observation, not a nested conclusion");
    }
    if (typeof item.value === "number" && !Number.isFinite(item.value)) {
      fail("FORMAL_SCENARIO_SCHEMA_INVALID", label + ".value must be finite");
    }
    if (provenance === "PRINTED_TEXT") {
      const reference = objectValue(item.definitionRef, label + ".definitionRef");
      const unexpectedReferenceFields = Object.keys(reference).filter((key) => !new Set(["cardId", "effectId"]).has(key));
      if (unexpectedReferenceFields.length) {
        fail("UNTRUSTED_DERIVED_FACT", label + ".definitionRef contains fields outside the closed schema", { unexpectedReferenceFields });
      }
      stringValue(reference.cardId, label + ".definitionRef.cardId");
      if (reference.effectId !== undefined) stringValue(reference.effectId, label + ".definitionRef.effectId");
    }
    validateSourceSpan(item.sourceSpan, sourceText, label + ".sourceSpan");
  }
}

function validateIntents(value, sourceText) {
  if (!Array.isArray(value) || !value.length) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "intents must be non-empty");
  const ids = new Set();
  for (const intentValue of value) {
    const intent = objectValue(intentValue, "intent");
    const id = stringValue(intent.intentId, "intent.intentId");
    if (ids.has(id)) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "duplicate intentId: " + id);
    ids.add(id);
    if (intent.type !== "TRY_SUMMON_PROCEDURE") {
      fail("FORMAL_SCENARIO_SCHEMA_INVALID", "only high-level TRY_SUMMON_PROCEDURE intents are accepted");
    }
    stringValue(intent.procedureId, "intent.procedureId");
    validateSourceSpan(intent.sourceSpan, sourceText, "intent.sourceSpan");
  }
}

function validateQueries(value, sourceText) {
  if (!Array.isArray(value) || !value.length) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "queries must be non-empty");
  const ids = new Set();
  for (const queryValue of value) {
    const query = objectValue(queryValue, "query");
    const id = stringValue(query.queryId, "query.queryId");
    if (ids.has(id)) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "duplicate queryId: " + id);
    ids.add(id);
    const predicate = stringValue(query.predicate, "query.predicate");
    if (!QUERY_PREDICATES.has(predicate)) fail("CAPABILITY_UNAVAILABLE", "unsupported formal query predicate: " + predicate);
    validateSourceSpan(query.sourceSpan, sourceText, "query.sourceSpan");
  }
}

function validateAssumptions(value, sourceText, mode) {
  if (!Array.isArray(value)) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "assumptions must be an array");
  if (mode === "STRICT" && value.length) fail("MISSING_STATE_FACT", "STRICT mode cannot replace missing state with assumptions");
  for (const assumptionValue of value) {
    const assumption = objectValue(assumptionValue, "assumption");
    stringValue(assumption.assumptionId, "assumption.assumptionId");
    stringValue(assumption.type, "assumption.type");
    if (mode === "ABSTRACT_ASSUMPTIONS") stringValue(assumption.assumesFactId, "assumption.assumesFactId");
    validateSourceSpan(assumption.sourceSpan, sourceText, "assumption.sourceSpan");
  }
}

function validateCapabilityIds(value) {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item)) {
    fail("FORMAL_SCENARIO_SCHEMA_INVALID", "requiredCapabilities must contain capability IDs");
  }
  if (new Set(value).size !== value.length) fail("FORMAL_SCENARIO_SCHEMA_INVALID", "requiredCapabilities contains duplicates");
  for (const capabilityId of value) validateVersionedCapabilityId(capabilityId, "required capability");
}

function assertNoTrustedConclusions(value, path = "scenario") {
  const forbidden = new Set([
    "banishedByCardEffect", "summonLegal", "triggerActivates", "finalChainNumber", "canActivate", "operationSuccessful",
    "legal", "verdict", "chainPosition", "canSummon", "canResolve", "trusted", "authority", "proofCertificate",
    "certificateVerification",
  ]);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) fail("UNTRUSTED_DERIVED_FACT", "scenario cannot author engine-derived conclusion: " + path + "." + key);
    assertNoTrustedConclusions(child, path + "." + key);
  }
}

function validateDefinitionSnapshot(value, instances) {
  const snapshot = objectValue(value, "scenario.definitionSnapshot");
  const snapshotId = stringValue(snapshot.snapshotId, "definitionSnapshot.snapshotId");
  digestValue(snapshot.manifestSha256, "definitionSnapshot.manifestSha256");
  if (!Array.isArray(snapshot.definitions) || !snapshot.definitions.length) {
    fail("FORMAL_DEFINITION_SNAPSHOT_INVALID", "definitionSnapshot.definitions must be non-empty");
  }
  const definitions = new Map();
  for (const definitionValue of snapshot.definitions) {
    const definition = objectValue(definitionValue, "definition snapshot entry");
    const cardId = stringValue(definition.cardId, "definition.cardId");
    if (definitions.has(cardId)) fail("FORMAL_DEFINITION_SNAPSHOT_INVALID", "duplicate definition cardId: " + cardId);
    const definitionId = stringValue(definition.definitionId, "definition.definitionId");
    digestValue(definition.contentSha256, "definition.contentSha256");
    if (!Array.isArray(definition.effects)) fail("FORMAL_DEFINITION_SNAPSHOT_INVALID", "definition.effects must be an array");
    const effects = new Map();
    for (const effectValue of definition.effects) {
      const effect = objectValue(effectValue, "definition effect entry");
      const effectId = stringValue(effect.effectId, "definitionEffect.effectId");
      if (effects.has(effectId)) fail("FORMAL_DEFINITION_SNAPSHOT_INVALID", "duplicate definition effectId: " + effectId);
      effects.set(effectId, {
        definitionEffectId: stringValue(effect.definitionEffectId, "definitionEffect.definitionEffectId"),
        contentSha256: digestValue(effect.contentSha256, "definitionEffect.contentSha256"),
      });
    }
    definitions.set(cardId, { definitionId, contentSha256: definition.contentSha256, effects });
  }
  if (snapshot.manifestSha256 !== definitionSnapshotSha256(snapshot)) {
    fail("FORMAL_DEFINITION_SNAPSHOT_INVALID", "definition snapshot digest does not match its definitions");
  }
  for (const instance of instances) {
    const binding = instance.definitionBinding;
    const definition = definitions.get(binding.cardId);
    if (!definition || binding.snapshotId !== snapshotId || binding.definitionId !== definition.definitionId ||
        binding.contentSha256 !== definition.contentSha256) {
      fail("FORMAL_DEFINITION_BINDING_MISMATCH", "card instance does not match the bound definition snapshot", {
        instanceId: instance.instanceId,
        cardId: binding.cardId,
      });
    }
    for (const effectBinding of instance.effectBindings) {
      const effect = definition.effects.get(effectBinding.effectId);
      if (!effect || effect.definitionEffectId !== effectBinding.definitionEffectId || effect.contentSha256 !== effectBinding.contentSha256) {
        fail("FORMAL_EFFECT_BINDING_MISMATCH", "effect instance does not match the bound definition snapshot", {
          instanceId: instance.instanceId,
          effectId: effectBinding.effectId,
        });
      }
    }
  }
}

function validateReferences(scenario) {
  const instances = new Map(scenario.cardInstances.map((item) => [item.instanceId, item]));
  const intents = new Map(scenario.intents.map((item) => [item.intentId, item]));
  const queries = new Map(scenario.queries.map((item) => [item.queryId, item]));
  const events = new Map(scenario.eventHistory.map((item) => [item.eventId, item]));
  const definitions = new Map(scenario.definitionSnapshot.definitions.map((item) => [item.cardId, item]));
  const requireInstanceEffect = (instanceId, effectId, label) => {
    const instance = instances.get(instanceId);
    if (!instance) fail("FORMAL_REFERENCE_INVALID", label + " references an unknown instance", { instanceId });
    if (!instance.effectBindings.some((item) => item.effectId === effectId)) {
      fail("FORMAL_REFERENCE_INVALID", label + " references an effect not bound to the instance", { instanceId, effectId });
    }
  };
  for (const intent of scenario.intents) {
    requireInstanceEffect(intent.actorInstanceId, intent.procedureId, "intent " + intent.intentId);
    if (intent.procedureInputInstanceIds !== undefined) {
      if (!Array.isArray(intent.procedureInputInstanceIds)) fail("FORMAL_REFERENCE_INVALID", "procedureInputInstanceIds must be an array");
      for (const instanceId of intent.procedureInputInstanceIds) {
        if (!instances.has(instanceId)) fail("FORMAL_REFERENCE_INVALID", "intent references an unknown procedure input", { instanceId });
      }
    }
  }
  for (const query of scenario.queries) {
    if (query.predicate === "PROCEDURE_AVAILABLE") {
      if (!intents.has(query.intentId)) fail("FORMAL_REFERENCE_INVALID", "procedure query references an unknown intent", { queryId: query.queryId });
    } else if (query.predicate === "TRIGGER_CAN_ACTIVATE") {
      requireInstanceEffect(query.subjectInstanceId, query.effectId, "query " + query.queryId);
    } else if (query.predicate === "EVENT_ATTRIBUTION") {
      if (!events.has(query.eventId)) fail("FORMAL_REFERENCE_INVALID", "event attribution query references an unknown event", { queryId: query.queryId });
    } else if (query.predicate === "CHAIN_ORDER_VALID") {
      if (!Array.isArray(query.chainCandidates) || !query.chainCandidates.length) {
        fail("FORMAL_REFERENCE_INVALID", "chain order query requires chainCandidates", { queryId: query.queryId });
      }
      for (const candidate of query.chainCandidates) {
        requireInstanceEffect(candidate?.instanceId, candidate?.effectId, "query " + query.queryId);
      }
    }
    if (query.dependsOn !== undefined) {
      if (!Array.isArray(query.dependsOn)) fail("FORMAL_REFERENCE_INVALID", "query.dependsOn must be an array");
      for (const dependency of query.dependsOn) {
        if (dependency === query.queryId || !queries.has(dependency)) {
          fail("FORMAL_REFERENCE_INVALID", "query depends on an invalid query", { queryId: query.queryId, dependency });
        }
      }
    }
  }
  assertAcyclicQueryDependencies(scenario.queries);
  for (const record of [...scenario.stateFacts, ...scenario.eventHistory]) {
    if (record.subjectInstanceId !== undefined) {
      const instance = instances.get(record.subjectInstanceId);
      if (!instance) fail("FORMAL_REFERENCE_INVALID", "input record references an unknown instance", { subjectInstanceId: record.subjectInstanceId });
      if (record.effectId !== undefined && !instance.effectBindings.some((item) => item.effectId === record.effectId)) {
        fail("FORMAL_REFERENCE_INVALID", "input record references an unbound effect", { effectId: record.effectId });
      }
    }
    if (record.effectId !== undefined && record.subjectInstanceId === undefined) {
      fail("FORMAL_REFERENCE_INVALID", "input record effectId requires a subjectInstanceId", { effectId: record.effectId });
    }
    if (record.provenance === "PRINTED_TEXT") {
      const definition = definitions.get(record.definitionRef.cardId);
      if (!definition) fail("FORMAL_REFERENCE_INVALID", "printed-text record references an unknown definition");
      if (record.definitionRef.effectId !== undefined && !definition.effects.some((item) => item.effectId === record.definitionRef.effectId)) {
        fail("FORMAL_REFERENCE_INVALID", "printed-text record references an unknown definition effect");
      }
    }
  }
}

function assertAcyclicQueryDependencies(queries) {
  const byId = new Map(queries.map((item) => [item.queryId, item]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (queryId) => {
    if (visited.has(queryId)) return;
    if (visiting.has(queryId)) fail("FORMAL_REFERENCE_INVALID", "query dependency graph contains a cycle", { queryId });
    visiting.add(queryId);
    for (const dependency of byId.get(queryId)?.dependsOn || []) visit(dependency);
    visiting.delete(queryId);
    visited.add(queryId);
  };
  for (const query of queries) visit(query.queryId);
}

function normalizeCapabilityDescriptors(value) {
  if (!Array.isArray(value)) fail("FORMAL_CAPABILITY_SCHEMA_INVALID", "capabilities must be an array");
  return value.map((itemValue) => {
    const item = objectValue(itemValue, "capability descriptor");
    return {
      capabilityId: item.capabilityId,
      version: item.version,
      status: item.status,
      dependencies: Array.isArray(item.dependencies) ? [...item.dependencies].sort() : item.dependencies,
    };
  }).sort((left, right) => String(left.capabilityId).localeCompare(String(right.capabilityId)));
}

function normalizeDefinitions(value) {
  if (!Array.isArray(value)) fail("FORMAL_DEFINITION_SNAPSHOT_INVALID", "definitions must be an array");
  return value.map((definitionValue) => {
    const definition = objectValue(definitionValue, "definition snapshot entry");
    const effects = Array.isArray(definition.effects) ? definition.effects.map((effectValue) => {
      const effect = objectValue(effectValue, "definition effect entry");
      return {
        effectId: effect.effectId,
        definitionEffectId: effect.definitionEffectId,
        contentSha256: effect.contentSha256,
      };
    }).sort((left, right) => String(left.effectId).localeCompare(String(right.effectId))) : definition.effects;
    return {
      cardId: definition.cardId,
      definitionId: definition.definitionId,
      contentSha256: definition.contentSha256,
      effects,
    };
  }).sort((left, right) => String(left.cardId).localeCompare(String(right.cardId)));
}

function capabilityVersionFromId(capabilityId) {
  return String(capabilityId).match(/\/(v\d+)$/u)?.[1] || "";
}

function validateVersionedCapabilityId(value, label) {
  const capabilityId = stringValue(value, label);
  if (!capabilityVersionFromId(capabilityId)) {
    fail("FORMAL_CAPABILITY_SCHEMA_INVALID", label + " must end with an explicit /vN version: " + capabilityId);
  }
  return capabilityId;
}

function digestValue(value, label) {
  const text = stringValue(value, label);
  if (!SHA256.test(text)) fail("FORMAL_BINDING_INVALID", label + " must be a lowercase SHA-256 digest");
  return text;
}

function equalBinding(actual, expected, label) {
  digestValue(actual, label);
  if (actual !== expected) fail("FORMAL_BINDING_MISMATCH", label + " does not match the negotiated artifact", { expected, actual });
}

function normalizeContractFailure(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "FORMAL_RESPONSE_SCHEMA_INVALID",
    message: error instanceof Error ? error.message : String(error),
    details: error?.details && typeof error.details === "object" ? error.details : {},
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("FORMAL_CANONICALIZATION_FAILED", "non-finite number in formal artifact");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("FORMAL_CANONICALIZATION_FAILED", "formal artifacts must contain plain JSON values");
  }
  const entries = Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => [key, canonicalValue(value[key])]);
  return Object.fromEntries(entries);
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("FORMAL_RESPONSE_SCHEMA_INVALID", label + " must be an object");
  return value;
}

function stringValue(value, label, trim = true) {
  if (typeof value !== "string" || !(trim ? value.trim() : value).length) fail("FORMAL_RESPONSE_SCHEMA_INVALID", label + " must be a non-empty string");
  return trim ? value.trim() : value;
}

function integerValue(value, label) {
  if (!Number.isSafeInteger(value)) fail("FORMAL_RESPONSE_SCHEMA_INVALID", label + " must be a safe integer");
  return value;
}

function equalValue(actual, expected, label) {
  if (actual !== expected) fail("FORMAL_VERSION_INCOMPATIBLE", label + " is incompatible", { expected, actual });
}

function fail(code, message, details) {
  throw new FormalContractError(code, message, details);
}
