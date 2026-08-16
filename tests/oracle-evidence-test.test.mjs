import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildOracleRequestBody,
  ORACLE_CASE_SPECS,
  ORACLE_REASONING_EFFORTS,
  runOracleCases,
} from "../scripts/run-oracle-evidence-test.mjs";

const ORACLE_CASE_IDS = Object.freeze(Object.keys(ORACLE_CASE_SPECS));

test("Oracle workflow is isolated from the production backend and public budget", async () => {
  const workflow = await readFile(new URL(
    "../.github/workflows/oracle-evidence-test.yml",
    import.meta.url,
  ), "utf8");
  assert.match(workflow, /oracle-evidence-sol-low-\*/u);
  assert.match(workflow, /scripts\/run-oracle-evidence-test\.mjs/u);
  assert.match(workflow, /RELAY_API_KEY/u);
  assert.match(workflow, /reasoning_effort=%s/u);
  assert.match(workflow, /workflow_dispatch:[\s\S]*reasoning_effort:[\s\S]*case_ids:/u);
  for (const effort of ORACLE_REASONING_EFFORTS) {
    assert.match(workflow, new RegExp(`\\n\\s+- ${effort}\\n`, "u"));
  }
  assert.match(workflow, /rsa_padding_mode:oaep/u);
  assert.doesNotMatch(workflow, /backend\/server\.mjs/u);
  assert.doesNotMatch(workflow, /DEEPSEEK_API_KEY|UPSTASH|API_CHATGPT_DAILY_BUDGET/u);
});

test("Oracle diagnostic accepts every Sol reasoning effort without changing its contract", () => {
  for (const reasoningEffort of ORACLE_REASONING_EFFORTS) {
    const body = buildOracleRequestBody({
      question: "QUESTION-VISIBLE",
      cardTexts: [{
        id: "100",
        name: "CARD-NAME-VISIBLE",
        effectText: "COMPLETE-CARD-TEXT-VISIBLE",
        sourceUrl: "https://example.test/card/100",
      }],
      officialEvidence: [{
        id: "official-qa-visible",
        title: "OFFICIAL-QA-TITLE-VISIBLE",
        answer: "OFFICIAL-QA-ANSWER-VISIBLE",
        sourceUrl: "https://example.test/qa/1",
        authority: "KONAMI official card database",
      }],
      reasoningEffort,
    });
    assert.equal(body.reasoning_effort, reasoningEffort);
    assert.equal(body.model, "gpt-5.6-sol");
    assert.equal(body.max_completion_tokens, 4_096);
  }
});

test("Oracle model input contains only the question, card text and verified evidence", () => {
  const expectedAnswer = "EXPECTED-ANSWER-MUST-NEVER-BE-MODEL-VISIBLE";
  const previousCandidate = "OLD-CANDIDATE-MUST-NEVER-BE-MODEL-VISIBLE";
  const caseId = "case-999-must-not-be-model-visible";
  const body = buildOracleRequestBody({
    question: "QUESTION-VISIBLE",
    cardTexts: [{
      id: "100",
      name: "CARD-NAME-VISIBLE",
      cardType: "monster",
      attribute: "wind",
      level: 4,
      atk: 1500,
      def: 1000,
      effectText: "COMPLETE-CARD-TEXT-VISIBLE",
      sourceUrl: "https://example.test/card/100",
    }],
    officialEvidence: [{
      id: "official-qa-visible",
      title: "OFFICIAL-QA-TITLE-VISIBLE",
      answer: "OFFICIAL-QA-ANSWER-VISIBLE",
      sourceUrl: "https://example.test/qa/1",
      authority: "KONAMI official card database",
    }],
    caseId,
    referenceAnswer: expectedAnswer,
    candidateResponseText: previousCandidate,
  });

  const modelVisible = JSON.stringify(body.messages);
  const visibleEnvelope = JSON.parse(body.messages.find(
    (message) => message.role === "user",
  ).content);
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body.reasoning_effort, "low");
  assert.match(modelVisible, /QUESTION-VISIBLE/u);
  assert.match(modelVisible, /COMPLETE-CARD-TEXT-VISIBLE/u);
  assert.equal(visibleEnvelope.cardTexts[0].attribute, "wind");
  assert.equal(visibleEnvelope.cardTexts[0].level, 4);
  assert.equal(visibleEnvelope.cardTexts[0].atk, 1500);
  assert.match(modelVisible, /OFFICIAL-QA-ANSWER-VISIBLE/u);
  assert.doesNotMatch(modelVisible, new RegExp(expectedAnswer, "u"));
  assert.doesNotMatch(modelVisible, new RegExp(previousCandidate, "u"));
  assert.doesNotMatch(modelVisible, new RegExp(caseId, "u"));
});

test("Oracle diagnostic can scope cases and increase reasoning without changing evidence", async () => {
  const checkpointDirectory = await mkdtemp(join(tmpdir(), "oracle-evidence-medium-scope-"));
  try {
    const fixture = makeOracleFixture();
    const requestBodies = [];
    const result = await runOracleCases({
      ...fixture,
      checkpointDirectory,
      caseIds: ["case-004", "case-027", "case-028"],
      reasoningEffort: "medium",
      log: () => {},
      requestImpl: async (body) => {
        requestBodies.push(body);
        return {
          model: "gpt-5.6-sol",
          choices: [{ message: { content: "candidate" }, finish_reason: "stop" }],
        };
      },
    });
    assert.deepEqual([...result.generations.keys()], ["case-004", "case-027", "case-028"]);
    assert.equal(requestBodies.length, 3);
    assert.equal(requestBodies.every((body) => body.reasoning_effort === "medium"), true);
  } finally {
    await rm(checkpointDirectory, { recursive: true, force: true });
  }
});

test("Oracle cases execute strictly serially and exactly once per case", async () => {
  const checkpointDirectory = await mkdtemp(join(tmpdir(), "oracle-evidence-serial-"));
  try {
    const fixture = makeOracleFixture();
    const requestBodies = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    let overlapped = false;

    const result = await runOracleCases({
      ...fixture,
      checkpointDirectory,
      log: () => {},
      requestImpl: async (body) => {
        if (activeRequests !== 0) overlapped = true;
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        requestBodies.push(body);
        await new Promise((resolve) => setImmediate(resolve));
        activeRequests -= 1;
        return {
          id: `response-${requestBodies.length}`,
          model: "gpt-5.6-sol",
          choices: [{
            index: 0,
            message: { role: "assistant", content: `candidate-${requestBodies.length}` },
            finish_reason: "stop",
          }],
          usage: null,
        };
      },
    });

    assert.equal(overlapped, false);
    assert.equal(maximumActiveRequests, 1);
    assert.equal(requestBodies.length, ORACLE_CASE_IDS.length);
    assert.equal(result.generations.size, ORACLE_CASE_IDS.length);
    assert.deepEqual(
      requestBodies.map(readVisibleQuestion),
      fixture.dataset.cases.map((item) => item.question),
    );

    for (const [index, item] of fixture.dataset.cases.entries()) {
      const visibleRequest = JSON.stringify(requestBodies[index].messages);
      assert.equal(countOccurrences(
        requestBodies.map(readVisibleQuestion),
        item.question,
      ), 1);
      assert.doesNotMatch(visibleRequest, new RegExp(escapeRegExp(item.id), "u"));
      assert.doesNotMatch(visibleRequest, new RegExp(escapeRegExp(item.referenceAnswer), "u"));
      assert.doesNotMatch(visibleRequest, new RegExp(escapeRegExp(item.oldCandidateResponse), "u"));
      assert.equal(result.generations.get(item.id)?.requestCount, 1);
      assert.equal(result.generations.get(item.id)?.status, "generated");
    }
  } finally {
    await rm(checkpointDirectory, { recursive: true, force: true });
  }
});

test("Oracle transport failures are recorded once and are never retried", async () => {
  const checkpointDirectory = await mkdtemp(join(tmpdir(), "oracle-evidence-no-retry-"));
  try {
    const fixture = makeOracleFixture();
    const attemptsByQuestion = new Map();
    const result = await runOracleCases({
      ...fixture,
      checkpointDirectory,
      log: () => {},
      requestImpl: async (body) => {
        const question = readVisibleQuestion(body);
        attemptsByQuestion.set(question, (attemptsByQuestion.get(question) || 0) + 1);
        throw new Error("deliberate provider failure");
      },
    });

    assert.equal(attemptsByQuestion.size, ORACLE_CASE_IDS.length);
    for (const item of fixture.dataset.cases) {
      assert.equal(attemptsByQuestion.get(item.question), 1);
      assert.equal(result.generations.get(item.id)?.status, "generation_failed");
      assert.equal(result.generations.get(item.id)?.requestCount, 1);
    }

    let replayTransportCalls = 0;
    await assert.rejects(
      runOracleCases({
        ...fixture,
        checkpointDirectory,
        log: () => {},
        requestImpl: async () => {
          replayTransportCalls += 1;
          throw new Error("must not be called for an existing checkpoint");
        },
      }),
      /checkpoint already exists; refusing to resend/u,
    );
    assert.equal(replayTransportCalls, 0);
  } finally {
    await rm(checkpointDirectory, { recursive: true, force: true });
  }
});

test("Oracle validates all evidence before the first paid request", async () => {
  const checkpointDirectory = await mkdtemp(join(tmpdir(), "oracle-evidence-preflight-"));
  try {
    const fixture = makeOracleFixture();
    const lastEvidenceId = [...ORACLE_CASE_SPECS[ORACLE_CASE_IDS.at(-1)].evidenceIds].at(-1);
    fixture.qaRecords = fixture.qaRecords.filter((record) => record.id !== lastEvidenceId);
    let requestCount = 0;
    await assert.rejects(
      runOracleCases({
        ...fixture,
        checkpointDirectory,
        log: () => {},
        requestImpl: async () => {
          requestCount += 1;
          throw new Error("must not reach the paid transport");
        },
      }),
      new RegExp(`evidence record is missing: ${escapeRegExp(lastEvidenceId)}`, "u"),
    );
    assert.equal(requestCount, 0);
  } finally {
    await rm(checkpointDirectory, { recursive: true, force: true });
  }
});

function makeOracleFixture() {
  const cases = ORACLE_CASE_IDS.map((id, index) => ({
    id,
    question: `PRIVATE-QUESTION-${index + 1}`,
    referenceAnswer: `EXPECTED-ANSWER-${index + 1}`,
    oldCandidateResponse: `OLD-CANDIDATE-${index + 1}`,
  }));
  const cardIds = new Set(Object.values(ORACLE_CASE_SPECS)
    .flatMap((spec) => spec.cardIds));
  const evidenceIds = new Set(Object.values(ORACLE_CASE_SPECS)
    .flatMap((spec) => spec.evidenceIds));
  return {
    dataset: {
      schemaVersion: 1,
      datasetDigest: "oracle-test-dataset-digest",
      cases,
    },
    cardRecords: [...cardIds].map((id) => ({
      id,
      name: `CARD-NAME-${id}`,
      effectText: `COMPLETE-CARD-TEXT-${id}`,
      sourceUrl: `https://example.test/card/${id}`,
    })),
    qaRecords: [...evidenceIds].map((id) => ({
      id,
      title: `OFFICIAL-QA-${id}`,
      question: `OFFICIAL-QUESTION-${id}`,
      answer: `OFFICIAL-ANSWER-${id}`,
      sourceUrl: `https://example.test/qa/${id}`,
      authority: "KONAMI official card database",
    })),
  };
}

function readVisibleQuestion(body) {
  const userMessage = body.messages.find((message) => message.role === "user");
  return JSON.parse(userMessage.content).question;
}

function countOccurrences(values, expected) {
  return values.filter((value) => value === expected).length;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
