import test from "node:test";
import assert from "node:assert/strict";

import { responsesOutputText } from "../backend/responsesOutputText.mjs";
import { extractOpenAIResponseOutputText } from "../backend/rulingModelProviders.mjs";
import { classifyPublicQueryScope } from "../backend/publicQueryScopeClassifier.mjs";

// Shape observed from b.ai GPT-6 Luna on 2026-10-11: the same JSON object was
// returned once as phase "commentary" and once as phase "final_answer".
function message(phase, text) {
  return {
    id: `msg_${phase}`, type: "message", status: "completed", role: "assistant", phase,
    content: [{ type: "output_text", annotations: [], logprobs: [], text }],
  };
}

const SCOPE_JSON = JSON.stringify({ scope: "in_scope", confidence: "high", reasonCode: "ruling_question" });

test("only the final_answer message is read when the payload labels phases", () => {
  const payload = { output: [message("commentary", SCOPE_JSON), message("final_answer", SCOPE_JSON)] };
  assert.equal(responsesOutputText(payload), SCOPE_JSON);
  assert.deepEqual(JSON.parse(responsesOutputText(payload)), JSON.parse(SCOPE_JSON));
  assert.equal(extractOpenAIResponseOutputText(payload), SCOPE_JSON);
});

test("payloads without phases keep the previous joined reading; commentary alone is not a reply", () => {
  const unlabeled = { output: [
    { type: "reasoning", summary: [] },
    { type: "message", content: [{ type: "output_text", text: "part one " }, { type: "refusal", refusal: "x" }] },
    { type: "message", content: [{ type: "output_text", text: "part two" }] },
  ] };
  assert.equal(responsesOutputText(unlabeled), "part one part two");
  assert.equal(responsesOutputText({ output: [message("commentary", "thinking aloud")] }), "");
  assert.equal(responsesOutputText({}), "");
  assert.equal(responsesOutputText(null), "");
});

test("the Luna scope classifier accepts a commentary + final_answer payload instead of failing as invalid JSON", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    id: "resp_scope_phases", status: "completed", model: "gpt-6-luna",
    output: [message("commentary", SCOPE_JSON), message("final_answer", SCOPE_JSON)],
    usage: { input_tokens: 300, output_tokens: 40 },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const result = await classifyPublicQueryScope({
    question: "密告支1500炸了张场地 手里有第二张可以继续贴吗？",
    env: { BAI_CARD_API_KEY: "test-bai-card-key", BAI_CARD_BASE_URL: "https://api.b.ai/v1", API_BUDGET_MODE: "off" },
    fetchImpl,
  });
  assert.equal(result.scope, "in_scope");
  assert.equal(result.provider, "bai");
});
