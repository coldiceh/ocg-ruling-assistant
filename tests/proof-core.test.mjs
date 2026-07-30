import test from "node:test";
import assert from "node:assert/strict";

import {
  Claim,
  ProofCertificate,
  ProofNode,
  ProofResult,
  ProofVerificationErrorCode,
  Quantifier,
  TruthValue,
  UnknownReason,
  UnknownReasonType,
  andTruthValues,
  notTruthValue,
  orTruthValues,
  truthValueToBoolean,
  verifyProofCertificate,
} from "../backend/proofCore.mjs";

const copyRule = Object.freeze({
  validate({ premises, conclusion }) {
    return premises.length === 1
      && premises[0].truthValue === conclusion.truthValue;
  },
});

const quantifierRule = Object.freeze({
  validate({ node }) {
    return node.quantifierCertificate ? TruthValue.TRUE : TruthValue.FALSE;
  },
});

function certificate(overrides = {}) {
  return new ProofCertificate({
    id: "certificate-1",
    claims: [
      new Claim({
        id: "fact",
        key: "fact",
        statement: "The input fact holds.",
        truthValue: TruthValue.TRUE,
      }),
      new Claim({
        id: "decision",
        key: "decision",
        statement: "The requested operation is legal.",
        truthValue: TruthValue.TRUE,
      }),
    ],
    nodes: [
      new ProofNode({
        id: "node-1",
        ruleId: "copy",
        premiseClaimIds: ["fact"],
        conclusionClaimId: "decision",
      }),
    ],
    premiseClaimIds: ["fact"],
    decisiveClaimIds: ["decision"],
    resultTruthValue: TruthValue.TRUE,
    ...overrides,
  });
}

test("three-valued operators preserve UNKNOWN instead of treating it as FALSE", () => {
  assert.equal(notTruthValue(TruthValue.UNKNOWN), TruthValue.UNKNOWN);
  assert.equal(andTruthValues(TruthValue.TRUE, TruthValue.UNKNOWN), TruthValue.UNKNOWN);
  assert.equal(andTruthValues(TruthValue.FALSE, TruthValue.UNKNOWN), TruthValue.FALSE);
  assert.equal(orTruthValues(TruthValue.FALSE, TruthValue.UNKNOWN), TruthValue.UNKNOWN);
  assert.equal(orTruthValues(TruthValue.TRUE, TruthValue.UNKNOWN), TruthValue.TRUE);
  assert.throws(
    () => truthValueToBoolean(TruthValue.UNKNOWN),
    /UNKNOWN cannot be converted to boolean/i,
  );
});

test("ProofResult requires a typed reason for UNKNOWN and never exposes it as false", () => {
  const reason = new UnknownReason({
    type: UnknownReasonType.UNMODELED_SEMANTICS,
    message: "A required transition has no executable semantics.",
    details: { transitionType: "opaque-transition" },
  });
  const result = new ProofResult({
    truthValue: TruthValue.UNKNOWN,
    unknownReasons: [reason],
  });

  assert.equal(result.isUnknown(), true);
  assert.equal(result.isFalse(), false);
  assert.throws(() => result.toBoolean(), /UNKNOWN cannot be converted to boolean/i);
  assert.throws(
    () => new ProofResult({ truthValue: TruthValue.UNKNOWN }),
    /at least one typed UnknownReason/i,
  );
  assert.throws(
    () => new UnknownReason({ type: "OTHER", message: "untyped" }),
    /UnknownReasonType/i,
  );
});

test("a complete certificate verifies with registered rules and proven premises", () => {
  const verification = verifyProofCertificate(certificate(), {
    rules: { copy: copyRule },
  });

  assert.equal(verification.valid, true);
  assert.deepEqual(verification.errors, []);
  assert.equal(verification.resultTruthValue, TruthValue.TRUE);
});

test("verification rejects unknown rules and undeclared or unproved premises", () => {
  const unknownRule = verifyProofCertificate(certificate(), { rules: {} });
  assert.equal(unknownRule.valid, false);
  assert.ok(unknownRule.errors.some(
    (error) => error.code === ProofVerificationErrorCode.UNKNOWN_RULE,
  ));

  const unproved = verifyProofCertificate(certificate({
    premiseClaimIds: [],
  }), {
    rules: { copy: copyRule },
  });
  assert.equal(unproved.valid, false);
  assert.ok(unproved.errors.some(
    (error) => error.code === ProofVerificationErrorCode.UNPROVEN_PREMISE,
  ));
});

test("verification rejects missing, unproved, UNKNOWN, or result-mismatched decisive claims", () => {
  const missing = verifyProofCertificate(certificate({
    decisiveClaimIds: ["missing"],
  }), {
    rules: { copy: copyRule },
  });
  assert.ok(missing.errors.some(
    (error) => error.code === ProofVerificationErrorCode.MISSING_DECISIVE_CLAIM,
  ));

  const unknownDecision = verifyProofCertificate(certificate({
    claims: [
      new Claim({
        id: "fact",
        key: "fact",
        statement: "The input fact is unresolved.",
        truthValue: TruthValue.UNKNOWN,
      }),
      new Claim({
        id: "decision",
        key: "decision",
        statement: "The requested operation is unresolved.",
        truthValue: TruthValue.UNKNOWN,
      }),
    ],
    resultTruthValue: TruthValue.TRUE,
  }), {
    rules: { copy: copyRule },
  });
  assert.ok(unknownDecision.errors.some(
    (error) => error.code === ProofVerificationErrorCode.DECISIVE_CLAIM_MISMATCH,
  ));

  const unprovedDecision = verifyProofCertificate(certificate({
    nodes: [],
  }), {
    rules: { copy: copyRule },
  });
  assert.ok(unprovedDecision.errors.some(
    (error) => error.code === ProofVerificationErrorCode.UNPROVEN_DECISIVE_CLAIM,
  ));
});

test("verification detects TRUE/FALSE conflicts for the same semantic claim key", () => {
  const conflict = verifyProofCertificate(certificate({
    claims: [
      new Claim({
        id: "fact-true",
        key: "shared-fact",
        statement: "The shared fact holds.",
        truthValue: TruthValue.TRUE,
      }),
      new Claim({
        id: "fact-false",
        key: "shared-fact",
        statement: "The shared fact does not hold.",
        truthValue: TruthValue.FALSE,
      }),
      new Claim({
        id: "decision",
        key: "decision",
        statement: "The requested operation is legal.",
        truthValue: TruthValue.TRUE,
      }),
    ],
    nodes: [
      new ProofNode({
        id: "node-1",
        ruleId: "copy",
        premiseClaimIds: ["fact-true"],
        conclusionClaimId: "decision",
      }),
    ],
    premiseClaimIds: ["fact-true", "fact-false"],
  }), {
    rules: { copy: copyRule },
  });

  assert.ok(conflict.errors.some(
    (error) => error.code === ProofVerificationErrorCode.CONFLICTING_CLAIMS,
  ));
});

test("EXISTS TRUE accepts a proven true witness but rejects a false witness", () => {
  const valid = verifyProofCertificate(new ProofCertificate({
    id: "exists-valid",
    claims: [
      new Claim({
        id: "case-a",
        key: "case-a",
        statement: "Candidate A satisfies the predicate.",
        truthValue: TruthValue.TRUE,
      }),
      new Claim({
        id: "exists",
        key: "exists",
        statement: "At least one candidate satisfies the predicate.",
        truthValue: TruthValue.TRUE,
        quantifier: Quantifier.EXISTS,
      }),
    ],
    nodes: [
      new ProofNode({
        id: "exists-node",
        ruleId: "quantifier",
        premiseClaimIds: ["case-a"],
        conclusionClaimId: "exists",
        quantifierCertificate: {
          quantifier: Quantifier.EXISTS,
          caseClaimIds: ["case-a"],
          witnessClaimIds: ["case-a"],
        },
      }),
    ],
    premiseClaimIds: ["case-a"],
    decisiveClaimIds: ["exists"],
    resultTruthValue: TruthValue.TRUE,
  }), {
    rules: { quantifier: quantifierRule },
  });
  assert.equal(valid.valid, true);

  const invalid = verifyProofCertificate(new ProofCertificate({
    id: "exists-invalid",
    claims: [
      new Claim({
        id: "case-a",
        key: "case-a",
        statement: "Candidate A does not satisfy the predicate.",
        truthValue: TruthValue.FALSE,
      }),
      new Claim({
        id: "exists",
        key: "exists",
        statement: "At least one candidate satisfies the predicate.",
        truthValue: TruthValue.TRUE,
        quantifier: Quantifier.EXISTS,
      }),
    ],
    nodes: [
      new ProofNode({
        id: "exists-node",
        ruleId: "quantifier",
        premiseClaimIds: ["case-a"],
        conclusionClaimId: "exists",
        quantifierCertificate: {
          quantifier: Quantifier.EXISTS,
          caseClaimIds: ["case-a"],
          witnessClaimIds: ["case-a"],
        },
      }),
    ],
    premiseClaimIds: ["case-a"],
    decisiveClaimIds: ["exists"],
    resultTruthValue: TruthValue.TRUE,
  }), {
    rules: { quantifier: quantifierRule },
  });
  assert.ok(invalid.errors.some(
    (error) => error.code === ProofVerificationErrorCode.INVALID_QUANTIFIER_CERTIFICATE,
  ));
});

test("FORALL TRUE and EXISTS FALSE require proven exhaustive finite domains", () => {
  const forallWithoutExhaustiveness = verifyProofCertificate(new ProofCertificate({
    id: "forall-invalid",
    claims: [
      new Claim({
        id: "case-a",
        key: "case-a",
        statement: "Candidate A satisfies the predicate.",
        truthValue: TruthValue.TRUE,
      }),
      new Claim({
        id: "forall",
        key: "forall",
        statement: "Every candidate satisfies the predicate.",
        truthValue: TruthValue.TRUE,
        quantifier: Quantifier.FORALL,
      }),
    ],
    nodes: [
      new ProofNode({
        id: "forall-node",
        ruleId: "quantifier",
        premiseClaimIds: ["case-a"],
        conclusionClaimId: "forall",
        quantifierCertificate: {
          quantifier: Quantifier.FORALL,
          caseClaimIds: ["case-a"],
          exhaustive: false,
        },
      }),
    ],
    premiseClaimIds: ["case-a"],
    decisiveClaimIds: ["forall"],
    resultTruthValue: TruthValue.TRUE,
  }), {
    rules: { quantifier: quantifierRule },
  });
  assert.ok(forallWithoutExhaustiveness.errors.some(
    (error) => error.code === ProofVerificationErrorCode.INVALID_QUANTIFIER_CERTIFICATE,
  ));

  const existsFalse = verifyProofCertificate(new ProofCertificate({
    id: "exists-false-valid",
    claims: [
      new Claim({
        id: "case-a",
        key: "case-a",
        statement: "Candidate A does not satisfy the predicate.",
        truthValue: TruthValue.FALSE,
      }),
      new Claim({
        id: "domain-complete",
        key: "domain-complete",
        statement: "The finite candidate domain is exhaustively enumerated.",
        truthValue: TruthValue.TRUE,
      }),
      new Claim({
        id: "exists",
        key: "exists",
        statement: "At least one candidate satisfies the predicate.",
        truthValue: TruthValue.FALSE,
        quantifier: Quantifier.EXISTS,
      }),
    ],
    nodes: [
      new ProofNode({
        id: "exists-node",
        ruleId: "quantifier",
        premiseClaimIds: ["case-a", "domain-complete"],
        conclusionClaimId: "exists",
        quantifierCertificate: {
          quantifier: Quantifier.EXISTS,
          caseClaimIds: ["case-a"],
          exhaustive: true,
          exhaustivenessClaimId: "domain-complete",
        },
      }),
    ],
    premiseClaimIds: ["case-a", "domain-complete"],
    decisiveClaimIds: ["exists"],
    resultTruthValue: TruthValue.FALSE,
  }), {
    rules: { quantifier: quantifierRule },
  });
  assert.equal(existsFalse.valid, true);
});
