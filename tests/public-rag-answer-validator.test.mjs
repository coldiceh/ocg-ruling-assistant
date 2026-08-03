import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPublicRagDirectedRepairPrompt,
  buildSafePublicRagFallback,
  runValidatedPublicRagFinal,
  validatePublicRagFinalAnswer,
} from "../backend/publicRagAnswerValidator.mjs";

test("validator rejects a conclusion that reverses a grounded illegal operation without card-name rules", () => {
  const evidence = operationEvidence("必须完成的返回处理没有可适用卡，因此这个效果不能发动。");
  const validation = validatePublicRagFinalAnswer(makeAnswer("可以发动并正常完成处理。"), {
    rawText: "{}",
    userQuery: "这个效果可以发动吗？",
    evidence,
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((item) => /grounded illegal activation/u.test(item)));
});

test("validator rejects an incomplete answer when the question asks activation and later resolution", () => {
  const validation = validatePublicRagFinalAnswer(makeAnswer("可以发动。"), {
    rawText: "{}",
    userQuery: "这个效果可以发动吗？如果发动，之后效果如何处理？",
    evidence: {},
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((item) => /post-activation resolution/u.test(item)));
});

test("validator rejects JSON that only becomes complete after permissive normalization", () => {
  const normalized = makeAnswer("可以发动。"), validation = validatePublicRagFinalAnswer(normalized, {
    rawText: JSON.stringify({ shortAnswer: "可以发动。", reasoning: ["只返回了部分字段。"] }),
    userQuery: "这个效果可以发动吗？",
    evidence: {},
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((item) => /missing required field: answerLevel/u.test(item)));
  assert.ok(validation.errors.some((item) => /missing required field: usedEvidence/u.test(item)));
});

test("validator rejects natural language and malformed JSON before permissive normalization", () => {
  const naturalLanguage = validatePublicRagFinalAnswer(makeAnswer("可以发动。"), {
    rawText: "可以发动，因为条件已经满足。",
    userQuery: "这个效果可以发动吗？",
    evidence: {},
  });
  const malformedJson = validatePublicRagFinalAnswer(makeAnswer("可以发动。"), {
    rawText: '{"shortAnswer":"可以发动。"',
    userQuery: "这个效果可以发动吗？",
    evidence: {},
  });

  assert.equal(naturalLanguage.ok, false);
  assert.ok(naturalLanguage.errors.includes("raw model output must be one JSON object"));
  assert.equal(malformedJson.ok, false);
  assert.ok(malformedJson.errors.includes("raw model output must be valid JSON"));
});

test("validator rejects a generic answer that contradicts authoritative direct evidence", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-1",
      question: "这个效果可以发动吗？",
      answer: "不可以发动。",
      text: "这个效果可以发动吗？ 不可以发动。",
    }],
  };
  const validation = validatePublicRagFinalAnswer(makeAnswer("可以发动。", [{ id: "official-direct-1" }]), {
    rawText: "{}",
    userQuery: "这个效果可以发动吗？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((item) => /official direct answer/u.test(item)));
});

test("an official-positive headline cannot hide a contradictory negative activation sentence", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-self-conflict",
      question: "这个效果可以发动吗？",
      answer: "可以发动。",
      text: "这个效果可以发动吗？ 可以发动。",
    }],
  };
  const answer = makeAnswer(
    "可以发动。但是不能发动。",
    [{ id: "official-direct-self-conflict" }],
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这个效果可以发动吗？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("shortAnswer contains conflicting activation conclusions for the same subject"));
});

test("an ungrounded headline cannot contain opposite activation conclusions for the same subject", () => {
  const answer = makeAnswer("可以发动，但不能发动。");
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这个效果可以发动吗？",
    evidence: {},
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("shortAnswer contains conflicting activation conclusions for the same subject"));
});

test("different subjects and explicit alternative branches may have opposite activation results", () => {
  const separateSubjects = makeAnswer("「测试卡A」可以发动；「测试卡B」不能发动。");
  const separateValidation = validatePublicRagFinalAnswer(separateSubjects, {
    rawText: JSON.stringify(separateSubjects),
    userQuery: "两张卡分别能否发动？",
    evidence: {},
  });
  assert.equal(separateValidation.ok, true, JSON.stringify(separateValidation.errors));

  const alternativeBranches = makeAnswer("如果满足指定条件，可以发动；否则不能发动。");
  const branchValidation = validatePublicRagFinalAnswer(alternativeBranches, {
    rawText: JSON.stringify(alternativeBranches),
    userQuery: "这个效果在不同条件下能否发动？",
    evidence: {},
  });
  assert.equal(branchValidation.ok, true, JSON.stringify(branchValidation.errors));
});

test("validator rejects a performed fusion that contradicts an authoritative direct no-processing result", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-resolution-1",
      question: "这个效果可以发动吗？处理时是否融合召唤？",
      answer: "可以发动，但效果处理时不进行融合召唤。",
      text: "这个效果可以发动吗？处理时是否融合召唤？ 可以发动，但效果处理时不进行融合召唤。",
    }],
  };
  const answer = {
    ...makeAnswer(
      "可以发动，效果处理时正常进行融合召唤。",
      [{ id: "official-direct-resolution-1" }],
    ),
    reasoning: ["发动手续合法。", "官方处理结果是不进行融合召唤。"],
  };
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这个效果可以发动吗？处理时是否融合召唤？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("final resolution contradicts the authoritative official direct answer"));
});

test("authoritative Chinese direct evidence compares Special Summon and non-Fusion Summon separately", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-operation-scoped-zh",
      question: "这次特殊召唤是融合召唤吗？",
      answer: "可以特殊召唤，但这次特殊召唤不是融合召唤。",
      text: "这次特殊召唤是融合召唤吗？ 可以特殊召唤，但这次特殊召唤不是融合召唤。",
    }],
  };
  const answer = makeAnswer(
    "可以特殊召唤；这次特殊召唤不当作融合召唤。",
    [{ id: "official-direct-operation-scoped-zh" }],
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这次特殊召唤是融合召唤吗？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("authoritative Japanese direct evidence accepts the same mixed operation result in Chinese", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-operation-scoped-ja",
      question: "この方法で特殊召喚できますか。また、融合召喚として扱いますか。",
      answer: "特殊召喚できますが、この特殊召喚は融合召喚ではありません。（ただし、使用したモンスターは融合素材として扱います。）",
      text: "この方法で特殊召喚できますか。また、融合召喚として扱いますか。 特殊召喚できますが、この特殊召喚は融合召喚ではありません。（ただし、使用したモンスターは融合素材として扱います。）",
    }],
  };
  const answer = makeAnswer(
    "可以特殊召唤，但不作为融合召唤处理；使用的怪兽仍作为融合素材处理。",
    [{ id: "official-direct-operation-scoped-ja" }],
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "能否用这个方法特殊召唤？这是否属于融合召唤？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("authoritative direct comparison aligns a general result and a restricted exception", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-default-and-exception-ja",
      question: "融合召喚の素材にできないモンスターを使用できますか。",
      answer: "いずれの状況でも墓地へ送って特殊召喚できます。この特殊召喚は融合召喚ではありませんので、使用するモンスターは融合召喚の素材としては扱われません。ただし、融合素材としては扱います。なお、『リリースできない』効果も適用される場合、リリースする特殊召喚手順には使用できません。",
      text: "融合召喚の素材にできないモンスターを使用できますか。 いずれの状況でも墓地へ送って特殊召喚できます。この特殊召喚は融合召喚ではありません。なお、『リリースできない』効果も適用される場合、リリースする特殊召喚手順には使用できません。",
    }],
  };
  const answer = makeAnswer(
    "可以送去墓地并特殊召唤。这次特殊召唤不是融合召唤，但所用怪兽仍作为融合素材。不过，若怪兽同时受到‘不能解放’效果影响，则不能用于需要解放的特殊召唤手续。",
    [{ id: "official-direct-default-and-exception-ja" }],
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "能否用这些怪兽特殊召唤？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("a material restriction inside a concessive clause does not negate the later Summon operation", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-concessive-material-restriction",
      question: "融合召唤的素材にできない怪兽を使用できますか。",
      answer: "墓地へ送って特殊召唤できます。この特殊召唤は融合召唤ではありません。",
      text: "融合召唤的素材にできない怪兽を使用できますか。墓地へ送って特殊召唤できます。この特殊召唤は融合召唤ではありません。",
    }],
  };
  const answer = makeAnswer(
    "可以。即使怪兽带有‘不能作为融合召唤的素材’的效果，也能将其送入墓地来特殊召唤。这次特殊召唤不是融合召唤。",
    [{ id: "official-direct-concessive-material-restriction" }],
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "能否使用受到素材限制的怪兽进行这个特殊召唤？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("a positive modal nested inside a real prohibition does not cancel that prohibition", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-nested-negative-modal",
      question: "特殊召唤できますか。",
      answer: "特殊召唤できません。",
      text: "特殊召唤できますか。特殊召唤できません。",
    }],
  };
  for (const shortAnswer of [
    "不能使其能够特殊召唤。",
    "不能认为其仍然能够特殊召唤。",
    "不能据此断定，仍然能够特殊召唤。",
    "不能认为，即使受到限制也能特殊召唤。",
    "这并不意味着它仍然可以特殊召唤。",
    "该裁定不代表它也能特殊召唤。",
    "并非表示这只怪兽也可以特殊召唤。",
  ]) {
    const answer = makeAnswer(shortAnswer, [{ id: "official-direct-nested-negative-modal" }]);
    const validation = validatePublicRagFinalAnswer(answer, {
      rawText: JSON.stringify(answer),
      userQuery: "能否特殊召唤？",
      evidence,
      authoritativeOfficialDirect: true,
    });
    assert.equal(validation.ok, true, `${shortAnswer}: ${JSON.stringify(validation.errors)}`);
  }
});

test("a metalinguistic prohibition remains negative inside a concessive scenario", () => {
  const shortAnswer = "即使满足其他条件，也不能认为其仍然能够特殊召唤。";
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-concessive-metalinguistic-negative",
      question: "满足其他条件时可以特殊召唤吗。",
      answer: shortAnswer,
      text: `满足其他条件时可以特殊召唤吗。${shortAnswer}`,
    }],
  };
  const answer = makeAnswer(shortAnswer, [{ id: "official-direct-concessive-metalinguistic-negative" }]);
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "满足其他条件时可以特殊召唤吗？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("a metalinguistic prohibition does not cross an explicit discourse reset", () => {
  const shortAnswer = "不能认为前者可以破坏卡片，但是后者可以特殊召唤。";
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-discourse-reset",
      question: "后者可以特殊召唤吗。",
      answer: "后者可以特殊召唤。",
      text: "后者可以特殊召唤吗。后者可以特殊召唤。",
    }],
  };
  const answer = makeAnswer(shortAnswer, [{ id: "official-direct-discourse-reset" }]);
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "后者可以特殊召唤吗？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("a negated negative proposition is not flattened into a negative operation claim", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-metalinguistic-double-negative",
      question: "可以特殊召唤吗。",
      answer: "可以特殊召唤。",
      text: "可以特殊召唤吗。可以特殊召唤。",
    }],
  };
  for (const shortAnswer of [
    "不能认为这只怪兽不能特殊召唤；事实上仍然可以特殊召唤。",
    "这并不意味着它不能特殊召唤；相反，它仍然可以特殊召唤。",
    "不能理解为该手续不能特殊召唤。实际可以特殊召唤。",
  ]) {
    const answer = makeAnswer(shortAnswer, [{ id: "official-direct-metalinguistic-double-negative" }]);
    const validation = validatePublicRagFinalAnswer(answer, {
      rawText: JSON.stringify(answer),
      userQuery: "可以特殊召唤吗？",
      evidence,
      authoritativeOfficialDirect: true,
    });
    assert.equal(validation.ok, true, `${shortAnswer}: ${JSON.stringify(validation.errors)}`);
  }
});

test("a standalone positive 可 form is recognized as a performed operation", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-bare-ke-positive",
      question: "特殊召唤できますか。",
      answer: "特殊召唤できます。",
      text: "特殊召唤できますか。特殊召唤できます。",
    }],
  };
  const answer = makeAnswer("不过仍可特殊召唤。", [{ id: "official-direct-bare-ke-positive" }]);
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "能否特殊召唤？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("opposite claims for the same Summon operation remain a conflict across discourse pivots", () => {
  for (const shortAnswer of [
    "不能特殊召唤，也能特殊召唤。",
    "不能特殊召唤，却可以特殊召唤。",
    "不能特殊召唤，然而依然可以特殊召唤。",
  ]) {
    const answer = makeAnswer(shortAnswer);
    const validation = validatePublicRagFinalAnswer(answer, {
      rawText: JSON.stringify(answer),
      userQuery: "能否特殊召唤？",
      evidence: {},
    });
    assert.equal(validation.ok, false, shortAnswer);
    assert.ok(
      validation.errors.includes("shortAnswer contains conflicting resolution conclusions for the same operation"),
      `${shortAnswer}: ${JSON.stringify(validation.errors)}`,
    );
  }
});

test("an operation quoted inside example card text is not the official resolution claim", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-quoted-example",
      question: "この方法で特殊召喚できますか。",
      answer: "通常は特殊召喚できます。なお、『リリースできない』効果も適用される場合、一例として『モンスター1体を除外し、モンスター2体をリリースした場合にEXデッキから特殊召喚できる』のような手順には使用できません。",
      text: "この方法で特殊召喚できますか。 通常は特殊召喚できます。なお、『リリースできない』効果も適用される場合、一例として『モンスター1体を除外し、モンスター2体をリリースした場合にEXデッキから特殊召喚できる』のような手順には使用できません。",
    }],
  };
  const answer = makeAnswer(
    "通常可以特殊召唤；但若另外受到‘不能解放’效果影响，则不能用于要求解放的特殊召唤手续。",
    [{ id: "official-direct-quoted-example" }],
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这个方法能否特殊召唤？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("authoritative direct comparison rejects a reversed restricted exception", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-restricted-reversal",
      question: "この方法で特殊召喚できますか。",
      answer: "通常は特殊召喚できます。ただし、制限が適用される場合は特殊召喚できません。",
      text: "この方法で特殊召喚できますか。 通常は特殊召喚できます。ただし、制限が適用される場合は特殊召喚できません。",
    }],
  };
  const answer = makeAnswer(
    "通常可以特殊召唤；但在限制适用的场合也可以特殊召唤。",
    [{ id: "official-direct-restricted-reversal" }],
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这个方法能否特殊召唤？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("final resolution contradicts the authoritative official direct answer"));
});

test("authoritative direct comparison supports opposite outcomes in different conditions", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-two-opposite-conditions",
      question: "条件ごとの特殊召喚の処理はどうなりますか。",
      answer: "Aが適用される場合は特殊召喚できません。Bが適用される場合は特殊召喚できます。",
      text: "条件ごとの特殊召喚の処理はどうなりますか。 Aが適用される場合は特殊召喚できません。Bが適用される場合は特殊召喚できます。",
    }],
  };
  const answer = makeAnswer(
    "A适用的场合不能特殊召唤；B适用的场合可以特殊召唤。",
    [{ id: "official-direct-two-opposite-conditions" }],
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "A与B条件下分别能否特殊召唤？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("authoritative direct comparison rejects swapped outcomes between aligned conditions", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-swapped-conditions",
      question: "AとBの場合はどうなりますか。",
      answer: "Aが適用される場合は特殊召喚できません。Bが適用される場合は特殊召喚できます。",
      text: "AとBの場合はどうなりますか。 Aが適用される場合は特殊召喚できません。Bが適用される場合は特殊召喚できます。",
    }],
  };
  const answer = makeAnswer(
    "A适用的场合可以特殊召唤；B适用的场合不能特殊召唤。",
    [{ id: "official-direct-swapped-conditions" }],
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "A与B条件下分别能否特殊召唤？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("final resolution contradicts the authoritative official direct answer"));
});

test("authoritative direct validation does not let explanatory branches override a correct headline", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-branching-explanation",
      question: "この方法で特殊召喚できますか。",
      answer: "この方法で特殊召喚できます。",
      text: "この方法で特殊召喚できますか。 この方法で特殊召喚できます。",
    }],
  };
  const answer = makeAnswer(
    "可以用这个方法特殊召唤。",
    [{ id: "official-direct-branching-explanation" }],
  );
  answer.reasoning = ["另一个不满足手续的条件分支不能特殊召唤；官方直接回答会在输出契约中取代这段模型解释。"];
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "能否用这个方法特殊召唤？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("operation-scoped official comparison still rejects the opposite result for the same operation", () => {
  const evidence = {
    officialQaDirectCandidates: [{
      id: "official-direct-operation-conflict-ja",
      question: "この方法で特殊召喚できますか。",
      answer: "この方法で特殊召喚できます。",
      text: "この方法で特殊召喚できますか。 この方法で特殊召喚できます。",
    }],
  };
  const answer = makeAnswer(
    "这个方法不能进行特殊召唤。",
    [{ id: "official-direct-operation-conflict-ja" }],
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "能否用这个方法特殊召唤？",
    evidence,
    authoritativeOfficialDirect: true,
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("final resolution contradicts the authoritative official direct answer"));
});

test("validator rejects trusted semantic activation and resolution reversals", () => {
  const evidence = {
    semanticStateTransition: {
      status: "resolved",
      complete: true,
      authoritative: true,
      activation: { legal: true },
      resolution: { legal: false },
      shortAnswer: "可以发动，但处理时后续步骤不进行。",
      evidenceIds: ["semantic-rule-1"],
    },
  };
  const validation = validatePublicRagFinalAnswer(makeAnswer("不能发动。"), {
    rawText: "{}",
    userQuery: "这个效果可以发动吗？如果发动，之后如何处理？",
    evidence,
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((item) => /trusted semantic activation/u.test(item)));
  assert.ok(validation.errors.some((item) => /requested post-activation resolution/u.test(item)));
});

test("validator reads string semantic resolution and rejects the opposite processing result", () => {
  const evidence = trustedNoProcessingEvidence();
  const answer = makeAnswer("可以发动且正常融合。");
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这个效果可以发动吗？如果可以，之后如何处理？",
    evidence,
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("final resolution contradicts the trusted semantic state transition"));
});

test("a wrong public headline cannot be rescued by correct reasoning", () => {
  const answer = {
    ...makeAnswer("可以发动且正常融合召唤。"),
    reasoning: [
      "发动时存在合法素材，因此可以发动。",
      "支付 cost 后保护效果开始适用，所以处理时不进行融合召唤。",
    ],
  };
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这个效果可以发动吗？如果可以，之后如何处理？",
    evidence: trustedNoProcessingEvidence(),
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("final resolution contradicts the trusted semantic state transition"));
  assert.ok(validation.errors.includes("shortAnswer resolution conclusion conflicts with reasoning"));
});

test("shortAnswer and reasoning resolution conflict is rejected without relying on card-specific evidence", () => {
  const answer = {
    ...makeAnswer("可以发动，处理时正常进行融合召唤。"),
    reasoning: ["发动手续满足。", "处理时素材不再合法，因此不进行融合召唤。"],
  };
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这个效果可以发动吗？之后处理结果如何？",
    evidence: {},
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("shortAnswer resolution conclusion conflicts with reasoning"));
});

test("aligned headline and reasoning may explain a pre-cost possibility before the final no-processing result", () => {
  const answer = {
    ...makeAnswer("可以发动，但处理时不进行融合召唤。"),
    reasoning: [
      "支付 cost 前存在完整素材组合，所以发动手续合法。",
      "支付 cost 后素材不再受效果影响，最终处理时不进行融合召唤。",
    ],
  };
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这个效果可以发动吗？之后处理结果如何？",
    evidence: trustedNoProcessingEvidence(),
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("a positive continuous-effect operation does not reverse a later negative summon operation", () => {
  const answer = {
    ...makeAnswer("可以发动。支付 cost 后抗性开始适用，因此处理时不进行融合召唤。"),
    reasoning: [
      "发动时存在合法素材，因此可以发动。",
      "支付 cost 后抗性开始适用，使素材不受该效果影响，处理时不进行融合召唤。",
    ],
  };
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这个效果可以发动吗？之后处理结果如何？",
    evidence: trustedNoProcessingEvidence(),
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("different chain links and a continuous modifier do not create a global resolution conflict", () => {
  const answer = {
    ...makeAnswer("C1可以发动。C2处理后，C1被无效，不进行这个连锁项的效果处理。"),
    reasoning: [
      "连锁逆算时C2正常完成处理。",
      "C2处理后持续无效效果开始适用；轮到C1时，其效果被无效。",
    ],
  };
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "C1已经发动，C2连锁发动；连锁处理时C1的效果还会处理吗？",
    evidence: {},
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("opposite results bound to the same chain link and operation still conflict", () => {
  const answer = {
    ...makeAnswer("C1可以发动，但C1不进行效果处理。"),
    reasoning: ["C2处理结束。", "轮到C1时，C1正常进行效果处理。"],
  };
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "C1可以发动吗？处理结果如何？",
    evidence: {},
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("shortAnswer resolution conclusion conflicts with reasoning"));
});

test("one headline cannot state opposite outcomes for the same chain operation", () => {
  const answer = makeAnswer("C1可以发动。C1不进行效果处理，但C1正常进行效果处理。");
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "C1可以发动吗？处理结果如何？",
    evidence: {},
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("shortAnswer contains conflicting resolution conclusions for the same operation"));
});

test("a qualified exception branch may have a different result for the same operation", () => {
  const answer = makeAnswer("通常可以特殊召唤；但当某只怪兽还适用不能解放的限制时，不能用要求解放的手续特殊召唤。");
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这种特殊召唤手续如何处理？",
    evidence: {},
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("an attributive restricted subset is a separate resolution branch", () => {
  const answer = makeAnswer(
    "通常可以特殊召唤；但受到‘不能解放’效果影响的怪兽，不能用于要求解放融合素材的特殊召唤手续。",
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这种特殊召唤手续如何处理？",
    evidence: {},
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("synonymous attributive restriction wording is a separate branch", () => {
  const answer = makeAnswer(
    "一般可以特殊召唤；不过，适用‘不能解放’限制的怪兽不能用于要求解放的特殊召唤手续。",
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这种特殊召唤手续如何处理？",
    evidence: {},
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("opposite outcomes explicitly under the same condition remain a conflict", () => {
  const answer = makeAnswer("通常可以特殊召唤；但在同一条件下不能特殊召唤。");
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这种特殊召唤手续如何处理？",
    evidence: {},
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("shortAnswer contains conflicting resolution conclusions for the same operation"));
});

test("opposite outcomes inside one restricted branch remain a conflict", () => {
  const answer = makeAnswer(
    "可以特殊召唤；但受到限制效果影响的怪兽不能特殊召唤，但又可以特殊召唤。",
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这种特殊召唤手续如何处理？",
    evidence: {},
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("shortAnswer contains conflicting resolution conclusions for the same operation"));
});

test("a same-sentence conditional exception is not merged into the default branch", () => {
  const answer = makeAnswer("通常可以特殊召唤，但如果怪兽受到不能解放的限制，则不能用于该特殊召唤手续。");
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这种特殊召唤手续如何处理？",
    evidence: {},
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("the same repeated condition across sentences retains one branch scope", () => {
  const answer = makeAnswer("当A适用时不能特殊召唤。当A适用时又可以特殊召唤。");
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "A适用时能否特殊召唤？",
    evidence: {},
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("shortAnswer contains conflicting resolution conclusions for the same operation"));
});

test("material classification is not mistaken for performing a Fusion Summon", () => {
  const answer = makeAnswer(
    "可以将这些怪兽送去墓地并特殊召唤。这个特殊召唤不是融合召唤，所使用的怪兽不作为融合召唤的素材，但仍作为融合素材。",
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "能否用记载的手续特殊召唤？这是融合召唤吗？",
    evidence: {},
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("extended material-role wording is not mistaken for a Fusion Summon operation", () => {
  const answer = makeAnswer(
    "可以特殊召唤，但这不是融合召唤，所用怪兽仍作为融合召唤所使用的素材，也就是融合召唤素材。",
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这是融合召唤吗？所用怪兽如何处理？",
    evidence: {},
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("a monster object after Fusion Summon remains an operation claim", () => {
  const answer = makeAnswer("不能融合召唤怪兽，但在同一条件下又可以融合召唤怪兽。");
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "能否融合召唤怪兽？",
    evidence: {},
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("shortAnswer contains conflicting resolution conclusions for the same operation"));
});

test("Japanese Fusion Summon material wording is a role rather than an operation", () => {
  const answer = makeAnswer(
    "特殊召喚できます。この特殊召喚は融合召喚ではありませんので、使用するモンスターは融合召喚の素材としては扱われません。ただし、融合素材としては扱います。",
  );
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "この手順で特殊召喚できますか。",
    evidence: {},
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("a complete answer agreeing with string semantic resolution remains a one-call fast result", async () => {
  let calls = 0;
  const answer = makeAnswer("可以发动，但是不会进行任何效果处理，因此不进行融合召唤。");
  const result = await runValidatedPublicRagFinal({
    originalPrompt: "FROZEN_TRUSTED_RESOLUTION",
    userQuery: "这个效果可以发动吗？如果可以，之后如何处理？",
    evidence: trustedNoProcessingEvidence(),
    invoke: async () => {
      calls += 1;
      return {
        answer,
        rawText: JSON.stringify(answer),
        warnings: [],
        dryRun: false,
        tokenUsage: {},
        estimatedCostCny: 0,
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.publicFinalValidation.outcome, "primary_valid");
  assert.equal(result.publicFinalValidation.repairAttempted, false);
  assert.equal(result.publicFinalValidation.primary.candidate.shortAnswer, answer.shortAnswer);
});

test("bare temporal follow-up does not manufacture a resolution question", () => {
  const answer = makeAnswer("可以发动。");
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这个效果可以发动吗？之后我还可以通常召唤吗？",
    evidence: {},
  });

  assert.equal(validation.ok, true);
  assert.equal(validation.checks.multiPartQuestion, false);
});

test("temporal follow-up with a nearby processing result still requires resolution", () => {
  const answer = makeAnswer("可以发动。");
  const validation = validatePublicRagFinalAnswer(answer, {
    rawText: JSON.stringify(answer),
    userQuery: "这个效果可以发动吗？之后的效果处理结果如何？",
    evidence: {},
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.checks.multiPartQuestion, true);
  assert.ok(validation.errors.includes("shortAnswer omits the requested post-activation resolution result"));
});

test("formal UNKNOWN rejects definite model claims and preserves their polarity for the later gate", async () => {
  const evidence = {
    formalEngineProofs: [{
      id: "formal-unknown-1",
      queryId: "q1",
      verdict: "UNKNOWN",
      claimText: "题述操作是否可以进行",
    }],
  };
  const invalid = makeAnswer("两项都可以发动并正常处理。");
  const validation = validatePublicRagFinalAnswer(invalid, {
    rawText: JSON.stringify(invalid),
    userQuery: "题述操作是否可以进行？",
    evidence,
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("formal UNKNOWN blocked model positive claim"));

  const result = await runValidatedPublicRagFinal({
    originalPrompt: "FROZEN_FORMAL_UNKNOWN",
    userQuery: "题述操作是否可以进行？",
    evidence,
    invoke: async () => ({
      answer: invalid,
      rawText: JSON.stringify(invalid),
      warnings: [],
      dryRun: false,
    }),
  });
  assert.equal(result.publicFinalValidation.outcome, "primary_failed_safe_fallback");
  assert.equal(result.publicFinalValidation.callCount, 1);
  assert.ok(result.answer.riskFlags.includes("formal_engine_unknown_blocked_model_positive"));
});

test("directed repair keeps the original frozen prompt and exposes only validation errors plus prior output", () => {
  const prompt = "FROZEN_EVIDENCE_PACKET_7f4c";
  const repaired = buildPublicRagDirectedRepairPrompt({
    originalPrompt: prompt,
    priorOutput: "{\"shortAnswer\":\"可以发动\"}",
    validationErrors: ["shortAnswer omits the requested post-activation resolution result"],
    allowedEvidenceIds: ["qa-allowed-1", "card-text-allowed-2"],
  });

  assert.ok(repaired.startsWith(prompt));
  assert.match(repaired, /唯一一次定向修复/u);
  assert.match(repaired, /不得重新检索/u);
  assert.match(repaired, /post-activation resolution/u);
  assert.match(repaired, /allowedEvidenceIds/u);
  assert.match(repaired, /qa-allowed-1/u);
  assert.match(repaired, /id 必须非空/u);
});

test("safe fallback uses a grounded blocker and never guesses a conflicting conclusion", () => {
  const evidence = operationEvidence("不能发动，因为必做处理没有可适用卡。");
  const fallback = buildSafePublicRagFallback({
    evidence,
    validationErrors: ["primary conflict", "repair conflict"],
  });

  assert.equal(fallback.answerLevel, "rule_analysis");
  assert.match(fallback.shortAnswer, /不能发动/u);
  assert.ok(fallback.riskFlags.includes("grounded_operation_blocker_fallback_applied"));
  assert.ok(fallback.usedEvidence.some((item) => item.id === "rule-neutral-1"));
});

test("public final gate performs exactly one directed repair on the same frozen prompt", async () => {
  const prompts = [];
  const outputs = [
    makeAnswer("可以发动。"),
    makeAnswer("可以发动；处理时不进行后续特殊召唤。"),
  ];
  const result = await runValidatedPublicRagFinal({
    originalPrompt: "FROZEN_PUBLIC_PACKET_11",
    userQuery: "这个效果可以发动吗？如果发动，之后如何处理？",
    evidence: {},
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      const answer = outputs[prompts.length - 1];
      return {
        answer,
        rawText: JSON.stringify(answer),
        warnings: [],
        dryRun: false,
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        estimatedCostCny: 0.02,
      };
    },
  });

  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].startsWith("FROZEN_PUBLIC_PACKET_11"));
  assert.equal(result.publicFinalValidation.outcome, "repair_valid");
  assert.equal(result.publicFinalValidation.callCount, 2);
  assert.equal(result.tokenUsage.inputTokens, 20);
  assert.equal(result.estimatedCostCny, 0.04);
  assert.match(result.answer.shortAnswer, /不进行后续特殊召唤/u);
});

test("a valid primary answer adds no second model call", async () => {
  let calls = 0;
  const valid = makeAnswer("可以发动。"), result = await runValidatedPublicRagFinal({
    originalPrompt: "FROZEN_PUBLIC_PACKET_FAST",
    userQuery: "这个效果可以发动吗？",
    evidence: {},
    invoke: async () => {
      calls += 1;
      return {
        answer: valid,
        rawText: JSON.stringify(valid),
        warnings: [],
        dryRun: false,
        tokenUsage: {},
        estimatedCostCny: 0,
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.publicFinalValidation.outcome, "primary_valid");
  assert.equal(result.publicFinalValidation.callCount, 1);
  assert.equal(result.publicFinalValidation.repairAttempted, false);
});

test("a failed directed repair is not retried and safely degrades", async () => {
  let calls = 0;
  const invalid = makeAnswer("可以发动。"), evidence = operationEvidence("不能发动，因为必做处理没有可适用卡。");
  const result = await runValidatedPublicRagFinal({
    originalPrompt: "FROZEN_PUBLIC_PACKET_12",
    userQuery: "这个效果可以发动吗？",
    evidence,
    invoke: async () => {
      calls += 1;
      return {
        answer: invalid,
        rawText: JSON.stringify(invalid),
        warnings: [],
        dryRun: false,
        tokenUsage: {},
        estimatedCostCny: 0,
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.publicFinalValidation.outcome, "repair_failed_safe_fallback");
  assert.match(result.answer.shortAnswer, /不能发动/u);
  assert.ok(result.warnings.includes("public_final_directed_repair_failed"));
});

function makeAnswer(shortAnswer, usedEvidence = []) {
  return {
    answerLevel: "rule_analysis",
    shortAnswer,
    reasoning: ["先核对题面事实。", "再核对冻结证据中的操作约束。"],
    usedCards: [],
    usedEvidence,
    missingInfo: [],
    riskFlags: [],
    confidenceSelfEstimate: "medium",
  };
}

function operationEvidence(conclusion) {
  return {
    operationLegality: {
      hasGroundedChecks: true,
      hasBlockingCheck: true,
      hasUnresolvedConstraints: false,
      checks: [{
        operationId: "neutral-operation-1",
        action: "执行题述必做处理",
        status: "illegal",
        conclusion,
        reasoning: ["冻结规则资料明确排除了这个操作。"],
        citations: [{ id: "rule-neutral-1", quote: "没有可适用卡时不能发动。" }],
      }],
      matchedRuleEvidence: [{
        id: "rule-neutral-1",
        type: "rulebook",
        title: "通用必做处理规则",
        text: "没有可适用卡时不能发动。",
      }],
    },
  };
}

function trustedNoProcessingEvidence() {
  return {
    semanticStateTransition: {
      status: "resolved",
      complete: true,
      authoritative: true,
      activation: "legal",
      resolution: "not_performed",
      shortAnswer: "可以发动，但是不会进行任何效果处理，因此不进行融合召唤。",
      evidenceIds: [],
    },
  };
}
