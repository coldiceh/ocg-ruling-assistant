export const TruthValue = Object.freeze({
  TRUE: "TRUE",
  FALSE: "FALSE",
  UNKNOWN: "UNKNOWN",
});

export const UnknownReasonType = Object.freeze({
  AMBIGUOUS_INPUT: "AMBIGUOUS_INPUT",
  MISSING_FACT: "MISSING_FACT",
  MISSING_PREMISE: "MISSING_PREMISE",
  UNSUPPORTED_RULE: "UNSUPPORTED_RULE",
  UNMODELED_SEMANTICS: "UNMODELED_SEMANTICS",
  INCOMPLETE_DOMAIN: "INCOMPLETE_DOMAIN",
  CONFLICTING_FACTS: "CONFLICTING_FACTS",
  EXTERNAL_DATA_UNAVAILABLE: "EXTERNAL_DATA_UNAVAILABLE",
});

export const Quantifier = Object.freeze({
  EXISTS: "EXISTS",
  FORALL: "FORALL",
});

export const ProofVerificationErrorCode = Object.freeze({
  MALFORMED_CERTIFICATE: "MALFORMED_CERTIFICATE",
  DUPLICATE_CLAIM_ID: "DUPLICATE_CLAIM_ID",
  DUPLICATE_NODE_ID: "DUPLICATE_NODE_ID",
  DUPLICATE_CONCLUSION: "DUPLICATE_CONCLUSION",
  MISSING_PREMISE_CLAIM: "MISSING_PREMISE_CLAIM",
  MISSING_CONCLUSION_CLAIM: "MISSING_CONCLUSION_CLAIM",
  UNKNOWN_RULE: "UNKNOWN_RULE",
  UNPROVEN_PREMISE: "UNPROVEN_PREMISE",
  CYCLIC_PROOF: "CYCLIC_PROOF",
  RULE_REJECTED: "RULE_REJECTED",
  RULE_VALIDATION_UNKNOWN: "RULE_VALIDATION_UNKNOWN",
  RULE_VALIDATION_ERROR: "RULE_VALIDATION_ERROR",
  MISSING_DECISIVE_CLAIM: "MISSING_DECISIVE_CLAIM",
  UNPROVEN_DECISIVE_CLAIM: "UNPROVEN_DECISIVE_CLAIM",
  DECISIVE_CLAIM_MISMATCH: "DECISIVE_CLAIM_MISMATCH",
  CONFLICTING_CLAIMS: "CONFLICTING_CLAIMS",
  INVALID_QUANTIFIER_CERTIFICATE: "INVALID_QUANTIFIER_CERTIFICATE",
});

const TRUTH_VALUES = new Set(Object.values(TruthValue));
const UNKNOWN_REASON_TYPES = new Set(Object.values(UnknownReasonType));
const QUANTIFIERS = new Set(Object.values(Quantifier));

export function isTruthValue(value) {
  return TRUTH_VALUES.has(value);
}

export function notTruthValue(value) {
  assertTruthValue(value);
  if (value === TruthValue.TRUE) return TruthValue.FALSE;
  if (value === TruthValue.FALSE) return TruthValue.TRUE;
  return TruthValue.UNKNOWN;
}

export function andTruthValues(...values) {
  values.forEach(assertTruthValue);
  if (values.some((value) => value === TruthValue.FALSE)) return TruthValue.FALSE;
  if (values.every((value) => value === TruthValue.TRUE)) return TruthValue.TRUE;
  return TruthValue.UNKNOWN;
}

export function orTruthValues(...values) {
  values.forEach(assertTruthValue);
  if (values.some((value) => value === TruthValue.TRUE)) return TruthValue.TRUE;
  if (values.every((value) => value === TruthValue.FALSE)) return TruthValue.FALSE;
  return TruthValue.UNKNOWN;
}

export function truthValueToBoolean(value) {
  assertTruthValue(value);
  if (value === TruthValue.UNKNOWN) {
    throw new TypeError("TruthValue.UNKNOWN cannot be converted to boolean.");
  }
  return value === TruthValue.TRUE;
}

export class UnknownReason {
  constructor({ type, message, details = {} } = {}) {
    if (!UNKNOWN_REASON_TYPES.has(type)) {
      throw new TypeError(`type must be a registered UnknownReasonType; received ${String(type)}.`);
    }
    assertNonEmptyString(message, "UnknownReason.message");
    if (!isPlainObject(details)) {
      throw new TypeError("UnknownReason.details must be an object.");
    }

    this.type = type;
    this.message = message;
    this.details = Object.freeze({ ...details });
    Object.freeze(this);
  }
}

export class Claim {
  constructor({
    id,
    key,
    statement,
    truthValue = TruthValue.UNKNOWN,
    quantifier = null,
    metadata = {},
  } = {}) {
    assertNonEmptyString(id, "Claim.id");
    assertNonEmptyString(key, "Claim.key");
    assertNonEmptyString(statement, "Claim.statement");
    assertTruthValue(truthValue);
    if (quantifier !== null && !QUANTIFIERS.has(quantifier)) {
      throw new TypeError(`Claim.quantifier must be null or a registered Quantifier; received ${String(quantifier)}.`);
    }
    if (!isPlainObject(metadata)) {
      throw new TypeError("Claim.metadata must be an object.");
    }

    this.id = id;
    this.key = key;
    this.statement = statement;
    this.truthValue = truthValue;
    this.quantifier = quantifier;
    this.metadata = Object.freeze({ ...metadata });
    Object.freeze(this);
  }
}

export class ProofNode {
  constructor({
    id,
    ruleId,
    premiseClaimIds = [],
    conclusionClaimId,
    quantifierCertificate = null,
    metadata = {},
  } = {}) {
    assertNonEmptyString(id, "ProofNode.id");
    assertNonEmptyString(ruleId, "ProofNode.ruleId");
    assertStringArray(premiseClaimIds, "ProofNode.premiseClaimIds");
    assertNonEmptyString(conclusionClaimId, "ProofNode.conclusionClaimId");
    if (quantifierCertificate !== null && !isPlainObject(quantifierCertificate)) {
      throw new TypeError("ProofNode.quantifierCertificate must be null or an object.");
    }
    if (!isPlainObject(metadata)) {
      throw new TypeError("ProofNode.metadata must be an object.");
    }

    this.id = id;
    this.ruleId = ruleId;
    this.premiseClaimIds = Object.freeze([...premiseClaimIds]);
    this.conclusionClaimId = conclusionClaimId;
    this.quantifierCertificate = quantifierCertificate === null
      ? null
      : freezeQuantifierCertificate(quantifierCertificate);
    this.metadata = Object.freeze({ ...metadata });
    Object.freeze(this);
  }
}

export class ProofCertificate {
  constructor({
    id,
    claims = [],
    nodes = [],
    premiseClaimIds = [],
    decisiveClaimIds = [],
    resultTruthValue,
    metadata = {},
  } = {}) {
    assertNonEmptyString(id, "ProofCertificate.id");
    if (!Array.isArray(claims) || claims.some((claim) => !isClaimLike(claim))) {
      throw new TypeError("ProofCertificate.claims must contain Claim-like objects.");
    }
    if (!Array.isArray(nodes) || nodes.some((node) => !isProofNodeLike(node))) {
      throw new TypeError("ProofCertificate.nodes must contain ProofNode-like objects.");
    }
    assertStringArray(premiseClaimIds, "ProofCertificate.premiseClaimIds");
    assertStringArray(decisiveClaimIds, "ProofCertificate.decisiveClaimIds");
    assertTruthValue(resultTruthValue);
    if (!isPlainObject(metadata)) {
      throw new TypeError("ProofCertificate.metadata must be an object.");
    }

    this.id = id;
    this.claims = Object.freeze([...claims]);
    this.nodes = Object.freeze([...nodes]);
    this.premiseClaimIds = Object.freeze([...premiseClaimIds]);
    this.decisiveClaimIds = Object.freeze([...decisiveClaimIds]);
    this.resultTruthValue = resultTruthValue;
    this.metadata = Object.freeze({ ...metadata });
    Object.freeze(this);
  }
}

export class ProofResult {
  constructor({
    truthValue,
    certificate = null,
    unknownReasons = [],
  } = {}) {
    assertTruthValue(truthValue);
    if (certificate !== null && !isCertificateLike(certificate)) {
      throw new TypeError("ProofResult.certificate must be null or a ProofCertificate-like object.");
    }
    if (!Array.isArray(unknownReasons)
      || unknownReasons.some((reason) => !(reason instanceof UnknownReason))) {
      throw new TypeError("ProofResult.unknownReasons must contain typed UnknownReason instances.");
    }
    if (truthValue === TruthValue.UNKNOWN && unknownReasons.length === 0) {
      throw new TypeError("An UNKNOWN ProofResult requires at least one typed UnknownReason.");
    }
    if (truthValue !== TruthValue.UNKNOWN && unknownReasons.length > 0) {
      throw new TypeError("A definitive ProofResult cannot contain UnknownReason entries.");
    }

    this.truthValue = truthValue;
    this.certificate = certificate;
    this.unknownReasons = Object.freeze([...unknownReasons]);
    Object.freeze(this);
  }

  isTrue() {
    return this.truthValue === TruthValue.TRUE;
  }

  isFalse() {
    return this.truthValue === TruthValue.FALSE;
  }

  isUnknown() {
    return this.truthValue === TruthValue.UNKNOWN;
  }

  toBoolean() {
    return truthValueToBoolean(this.truthValue);
  }
}

export function verifyProofCertificate(certificate, { rules = {} } = {}) {
  const errors = [];
  const addError = (code, message, context = {}) => {
    errors.push(Object.freeze({ code, message, ...context }));
  };

  if (!isCertificateLike(certificate)) {
    addError(
      ProofVerificationErrorCode.MALFORMED_CERTIFICATE,
      "The proof certificate is missing required arrays or a valid result truth value.",
    );
    return verificationResult(false, errors, TruthValue.UNKNOWN);
  }

  const claimsById = new Map();
  for (const claim of certificate.claims) {
    if (!isClaimLike(claim)) {
      addError(
        ProofVerificationErrorCode.MALFORMED_CERTIFICATE,
        "The certificate contains a malformed claim.",
      );
      continue;
    }
    if (claimsById.has(claim.id)) {
      addError(
        ProofVerificationErrorCode.DUPLICATE_CLAIM_ID,
        `Claim id ${claim.id} appears more than once.`,
        { claimId: claim.id },
      );
      continue;
    }
    claimsById.set(claim.id, claim);
  }

  const nodesById = new Map();
  const producerByClaimId = new Map();
  for (const node of certificate.nodes) {
    if (!isProofNodeLike(node)) {
      addError(
        ProofVerificationErrorCode.MALFORMED_CERTIFICATE,
        "The certificate contains a malformed proof node.",
      );
      continue;
    }
    if (nodesById.has(node.id)) {
      addError(
        ProofVerificationErrorCode.DUPLICATE_NODE_ID,
        `Proof node id ${node.id} appears more than once.`,
        { nodeId: node.id },
      );
      continue;
    }
    nodesById.set(node.id, node);
    if (producerByClaimId.has(node.conclusionClaimId)) {
      addError(
        ProofVerificationErrorCode.DUPLICATE_CONCLUSION,
        `More than one proof node derives claim ${node.conclusionClaimId}.`,
        { nodeId: node.id, claimId: node.conclusionClaimId },
      );
    } else {
      producerByClaimId.set(node.conclusionClaimId, node);
    }
  }

  const declaredPremises = new Set(certificate.premiseClaimIds);
  for (const premiseClaimId of declaredPremises) {
    if (!claimsById.has(premiseClaimId)) {
      addError(
        ProofVerificationErrorCode.MISSING_PREMISE_CLAIM,
        `Declared premise ${premiseClaimId} does not exist.`,
        { claimId: premiseClaimId },
      );
    }
  }

  detectClaimConflicts(claimsById, addError);

  const proofState = new Map();
  const proveClaim = (claimId, consumerNodeId = null) => {
    if (!claimsById.has(claimId)) return false;
    if (declaredPremises.has(claimId)) return true;

    const priorState = proofState.get(claimId);
    if (priorState === "PROVEN") return true;
    if (priorState === "FAILED") return false;
    if (priorState === "VISITING") {
      addError(
        ProofVerificationErrorCode.CYCLIC_PROOF,
        `Proof dependency cycle reaches claim ${claimId}.`,
        { claimId, nodeId: consumerNodeId },
      );
      proofState.set(claimId, "FAILED");
      return false;
    }

    const node = producerByClaimId.get(claimId);
    if (!node) return false;

    proofState.set(claimId, "VISITING");
    const conclusion = claimsById.get(claimId);
    if (!conclusion) {
      addError(
        ProofVerificationErrorCode.MISSING_CONCLUSION_CLAIM,
        `Proof node ${node.id} concludes missing claim ${claimId}.`,
        { nodeId: node.id, claimId },
      );
      proofState.set(claimId, "FAILED");
      return false;
    }

    const premises = [];
    let premisesProven = true;
    for (const premiseClaimId of node.premiseClaimIds) {
      const premise = claimsById.get(premiseClaimId);
      if (!premise) {
        addError(
          ProofVerificationErrorCode.MISSING_PREMISE_CLAIM,
          `Proof node ${node.id} references missing premise ${premiseClaimId}.`,
          { nodeId: node.id, claimId: premiseClaimId },
        );
        premisesProven = false;
        continue;
      }
      premises.push(premise);
      if (!proveClaim(premiseClaimId, node.id)) {
        addError(
          ProofVerificationErrorCode.UNPROVEN_PREMISE,
          `Premise ${premiseClaimId} used by node ${node.id} is neither declared nor proved.`,
          { nodeId: node.id, claimId: premiseClaimId },
        );
        premisesProven = false;
      }
    }

    const rule = getRegisteredRule(rules, node.ruleId);
    let ruleAccepted = false;
    if (!rule) {
      addError(
        ProofVerificationErrorCode.UNKNOWN_RULE,
        `Proof node ${node.id} uses unregistered rule ${node.ruleId}.`,
        { nodeId: node.id, ruleId: node.ruleId },
      );
    } else if (premisesProven) {
      ruleAccepted = validateRule({
        rule,
        node,
        premises,
        conclusion,
        certificate,
        claimsById,
        addError,
      });
    }

    const quantifierAccepted = validateQuantifierCertificate({
      node,
      conclusion,
      claimsById,
      addError,
    });
    const proved = premisesProven && ruleAccepted && quantifierAccepted;
    proofState.set(claimId, proved ? "PROVEN" : "FAILED");
    return proved;
  };

  for (const node of nodesById.values()) {
    if (!claimsById.has(node.conclusionClaimId)) {
      addError(
        ProofVerificationErrorCode.MISSING_CONCLUSION_CLAIM,
        `Proof node ${node.id} concludes missing claim ${node.conclusionClaimId}.`,
        { nodeId: node.id, claimId: node.conclusionClaimId },
      );
      continue;
    }
    proveClaim(node.conclusionClaimId);
  }

  if (certificate.decisiveClaimIds.length === 0) {
    addError(
      ProofVerificationErrorCode.MISSING_DECISIVE_CLAIM,
      "A proof certificate must identify at least one decisive claim.",
    );
  }

  for (const decisiveClaimId of certificate.decisiveClaimIds) {
    const decisiveClaim = claimsById.get(decisiveClaimId);
    if (!decisiveClaim) {
      addError(
        ProofVerificationErrorCode.MISSING_DECISIVE_CLAIM,
        `Decisive claim ${decisiveClaimId} does not exist.`,
        { claimId: decisiveClaimId },
      );
      continue;
    }
    if (!proveClaim(decisiveClaimId)) {
      addError(
        ProofVerificationErrorCode.UNPROVEN_DECISIVE_CLAIM,
        `Decisive claim ${decisiveClaimId} is not supported by a valid proof.`,
        { claimId: decisiveClaimId },
      );
    }
    if (decisiveClaim.truthValue !== certificate.resultTruthValue) {
      addError(
        ProofVerificationErrorCode.DECISIVE_CLAIM_MISMATCH,
        `Decisive claim ${decisiveClaimId} is ${decisiveClaim.truthValue}, not ${certificate.resultTruthValue}.`,
        {
          claimId: decisiveClaimId,
          claimTruthValue: decisiveClaim.truthValue,
          resultTruthValue: certificate.resultTruthValue,
        },
      );
    }
  }

  return verificationResult(
    errors.length === 0,
    errors,
    certificate.resultTruthValue,
  );
}

function validateRule({
  rule,
  node,
  premises,
  conclusion,
  certificate,
  claimsById,
  addError,
}) {
  const validator = typeof rule === "function" ? rule : rule?.validate;
  if (typeof validator !== "function") {
    addError(
      ProofVerificationErrorCode.RULE_VALIDATION_ERROR,
      `Registered rule ${node.ruleId} has no validate function.`,
      { nodeId: node.id, ruleId: node.ruleId },
    );
    return false;
  }

  let validation;
  try {
    validation = validator({
      node,
      premises: Object.freeze([...premises]),
      conclusion,
      certificate,
      claimsById,
    });
  } catch (error) {
    addError(
      ProofVerificationErrorCode.RULE_VALIDATION_ERROR,
      `Rule ${node.ruleId} threw while validating node ${node.id}: ${error instanceof Error ? error.message : String(error)}`,
      { nodeId: node.id, ruleId: node.ruleId },
    );
    return false;
  }

  const normalized = normalizeRuleValidation(validation);
  if (normalized === TruthValue.UNKNOWN) {
    addError(
      ProofVerificationErrorCode.RULE_VALIDATION_UNKNOWN,
      `Rule ${node.ruleId} could not validate node ${node.id} decisively.`,
      { nodeId: node.id, ruleId: node.ruleId },
    );
    return false;
  }
  if (normalized !== TruthValue.TRUE) {
    addError(
      ProofVerificationErrorCode.RULE_REJECTED,
      `Rule ${node.ruleId} rejected node ${node.id}.`,
      { nodeId: node.id, ruleId: node.ruleId },
    );
    return false;
  }
  return true;
}

function normalizeRuleValidation(validation) {
  if (validation === true || validation === TruthValue.TRUE) return TruthValue.TRUE;
  if (validation === false || validation === TruthValue.FALSE) return TruthValue.FALSE;
  if (validation === TruthValue.UNKNOWN) return TruthValue.UNKNOWN;
  if (isPlainObject(validation) && Object.hasOwn(validation, "valid")) {
    return normalizeRuleValidation(validation.valid);
  }
  return TruthValue.UNKNOWN;
}

function validateQuantifierCertificate({
  node,
  conclusion,
  claimsById,
  addError,
}) {
  const quantifierCertificate = node.quantifierCertificate;
  if (conclusion.quantifier === null && quantifierCertificate === null) return true;

  const reject = (message) => {
    addError(
      ProofVerificationErrorCode.INVALID_QUANTIFIER_CERTIFICATE,
      message,
      { nodeId: node.id, claimId: conclusion.id },
    );
    return false;
  };

  if (!QUANTIFIERS.has(conclusion.quantifier)) {
    return reject(`Conclusion ${conclusion.id} has no valid quantifier.`);
  }
  if (!isPlainObject(quantifierCertificate)) {
    return reject(`Quantified conclusion ${conclusion.id} has no quantifier certificate.`);
  }
  if (quantifierCertificate.quantifier !== conclusion.quantifier) {
    return reject(`Quantifier certificate for ${conclusion.id} does not match its quantifier.`);
  }

  const caseClaimIds = quantifierCertificate.caseClaimIds;
  if (!Array.isArray(caseClaimIds)
    || caseClaimIds.some((claimId) => typeof claimId !== "string")
    || new Set(caseClaimIds).size !== caseClaimIds.length) {
    return reject(`Quantifier certificate for ${conclusion.id} has invalid caseClaimIds.`);
  }

  const premiseSet = new Set(node.premiseClaimIds);
  const cases = [];
  for (const caseClaimId of caseClaimIds) {
    const claim = claimsById.get(caseClaimId);
    if (!claim || !premiseSet.has(caseClaimId)) {
      return reject(`Quantifier case ${caseClaimId} is missing or is not a premise of node ${node.id}.`);
    }
    cases.push(claim);
  }

  if (conclusion.truthValue === TruthValue.UNKNOWN) {
    return true;
  }

  if (conclusion.quantifier === Quantifier.EXISTS
    && conclusion.truthValue === TruthValue.TRUE) {
    const witnessClaimIds = quantifierCertificate.witnessClaimIds;
    if (!Array.isArray(witnessClaimIds) || witnessClaimIds.length === 0) {
      return reject(`EXISTS TRUE conclusion ${conclusion.id} requires a witness.`);
    }
    for (const witnessClaimId of witnessClaimIds) {
      if (!caseClaimIds.includes(witnessClaimId)
        || claimsById.get(witnessClaimId)?.truthValue !== TruthValue.TRUE) {
        return reject(`Existential witness ${witnessClaimId} is not a proven TRUE case.`);
      }
    }
    return true;
  }

  if (conclusion.quantifier === Quantifier.FORALL
    && conclusion.truthValue === TruthValue.FALSE) {
    const counterexampleClaimIds = quantifierCertificate.counterexampleClaimIds;
    if (!Array.isArray(counterexampleClaimIds) || counterexampleClaimIds.length === 0) {
      return reject(`FORALL FALSE conclusion ${conclusion.id} requires a counterexample.`);
    }
    for (const counterexampleClaimId of counterexampleClaimIds) {
      if (!caseClaimIds.includes(counterexampleClaimId)
        || claimsById.get(counterexampleClaimId)?.truthValue !== TruthValue.FALSE) {
        return reject(`Universal counterexample ${counterexampleClaimId} is not a proven FALSE case.`);
      }
    }
    return true;
  }

  if (quantifierCertificate.exhaustive !== true) {
    return reject(`Conclusion ${conclusion.id} requires an exhaustive finite-domain certificate.`);
  }
  const exhaustivenessClaimId = quantifierCertificate.exhaustivenessClaimId;
  const exhaustivenessClaim = claimsById.get(exhaustivenessClaimId);
  if (!exhaustivenessClaim
    || !premiseSet.has(exhaustivenessClaimId)
    || exhaustivenessClaim.truthValue !== TruthValue.TRUE) {
    return reject(`Conclusion ${conclusion.id} has no proven TRUE exhaustiveness claim.`);
  }

  const requiredCaseTruthValue = conclusion.quantifier === Quantifier.FORALL
    ? TruthValue.TRUE
    : TruthValue.FALSE;
  if (cases.some((claim) => claim.truthValue !== requiredCaseTruthValue)) {
    return reject(
      `${conclusion.quantifier} ${conclusion.truthValue} conclusion ${conclusion.id} contains a non-${requiredCaseTruthValue} case.`,
    );
  }
  return true;
}

function detectClaimConflicts(claimsById, addError) {
  const valuesByKey = new Map();
  for (const claim of claimsById.values()) {
    if (claim.truthValue === TruthValue.UNKNOWN) continue;
    const existing = valuesByKey.get(claim.key) ?? new Map();
    const ids = existing.get(claim.truthValue) ?? [];
    ids.push(claim.id);
    existing.set(claim.truthValue, ids);
    valuesByKey.set(claim.key, existing);
  }

  for (const [key, values] of valuesByKey) {
    if (!values.has(TruthValue.TRUE) || !values.has(TruthValue.FALSE)) continue;
    addError(
      ProofVerificationErrorCode.CONFLICTING_CLAIMS,
      `Semantic claim key ${key} is asserted as both TRUE and FALSE.`,
      {
        claimKey: key,
        trueClaimIds: Object.freeze([...values.get(TruthValue.TRUE)]),
        falseClaimIds: Object.freeze([...values.get(TruthValue.FALSE)]),
      },
    );
  }
}

function getRegisteredRule(rules, ruleId) {
  if (rules instanceof Map) return rules.get(ruleId);
  if (isPlainObject(rules)) return rules[ruleId];
  return undefined;
}

function verificationResult(valid, errors, resultTruthValue) {
  return Object.freeze({
    valid,
    errors: Object.freeze([...errors]),
    resultTruthValue,
  });
}

function freezeQuantifierCertificate(certificate) {
  const frozen = { ...certificate };
  for (const key of [
    "caseClaimIds",
    "witnessClaimIds",
    "counterexampleClaimIds",
  ]) {
    if (Array.isArray(frozen[key])) frozen[key] = Object.freeze([...frozen[key]]);
  }
  return Object.freeze(frozen);
}

function isCertificateLike(value) {
  return value !== null
    && typeof value === "object"
    && Array.isArray(value.claims)
    && Array.isArray(value.nodes)
    && Array.isArray(value.premiseClaimIds)
    && Array.isArray(value.decisiveClaimIds)
    && isTruthValue(value.resultTruthValue);
}

function isClaimLike(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.id === "string"
    && typeof value.key === "string"
    && typeof value.statement === "string"
    && isTruthValue(value.truthValue)
    && (value.quantifier === null
      || value.quantifier === undefined
      || QUANTIFIERS.has(value.quantifier));
}

function isProofNodeLike(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.id === "string"
    && typeof value.ruleId === "string"
    && Array.isArray(value.premiseClaimIds)
    && typeof value.conclusionClaimId === "string";
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertTruthValue(value) {
  if (!isTruthValue(value)) {
    throw new TypeError(`Expected TruthValue; received ${String(value)}.`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError(`${label} must be an array of non-empty strings.`);
  }
}
