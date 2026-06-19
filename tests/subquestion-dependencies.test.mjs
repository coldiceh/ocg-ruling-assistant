import assert from "node:assert/strict";
import test from "node:test";
import { buildSubQuestionDependencyGraph } from "../backend/subQuestionDependencies.mjs";

test("A. the send-to-graveyard question depends on the temporary-banish verdict", () => {
  const graph = buildSubQuestionDependencyGraph(query([
    question("q1", "temporary_banish", "完美世界-卡通世界", "能否除外该卡通怪兽？"),
    question("q2", "send_to_gy", "referenced_toon_monster", "该卡通怪兽还会不会送墓？"),
  ]));
  assert.ok(graph.edges.some((edge) => edge.fromQuestionId === "q1"
    && edge.toQuestionId === "q2"
    && edge.relation === "depends_on_verdict"));
});

test("B. activation location and current zone are linked in the same event chain", () => {
  const graph = buildSubQuestionDependencyGraph(query([
    question("q3", "activation_location", "青眼暴君龙", "这个效果是在墓地发动还是场上发动？"),
    question("q4", "location_change", "青眼暴君龙", "这个时候是否已经送墓？"),
  ]));
  assert.ok(graph.edges.some((edge) => edge.fromQuestionId === "q4"
    && edge.toQuestionId === "q3"
    && edge.relation === "depends_on_zone"));
  assert.ok(graph.edges.some((edge) => edge.fromQuestionId === "q3"
    && edge.toQuestionId === "q4"
    && edge.relation === "same_event_chain"));
});

test("C. unresolved pronouns produce explicit warnings", () => {
  const graph = buildSubQuestionDependencyGraph(query([
    question("q1", "unknown", "unknown", "这个时候该怪兽的这个效果怎样处理？"),
  ]), { timing: { currentWindow: "unknown" } });
  assert.ok(graph.warnings.some((item) => item.includes("该怪兽")));
  assert.ok(graph.warnings.some((item) => item.includes("这个时候")));
  assert.ok(graph.warnings.some((item) => item.includes("这个效果")));
});

function query(subQuestions) {
  return { originalText: subQuestions.map((item) => item.sourceText).join("\n"), cards: [], scenario: { rawContext: "" }, subQuestions };
}

function question(id, type, card, sourceText) {
  return { id, type, card, askedResult: "unknown", sourceText };
}
