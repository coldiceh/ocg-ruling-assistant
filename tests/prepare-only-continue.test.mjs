import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 仅准备证据包 is often clicked by people who want the answer. The prepared result offers 生成答案,
// which finalizes the same preparation (the final model only, no second retrieval), and the
// evidence package is no longer downloaded automatically (its button stays).
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const between = (from, to) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)));
const analyze = between("async function analyzeQuestion", "async function requestBackendAnswer");
const preparedOnly = between("function renderPreparedOnly", "async function continuePreparedAnswer");
const continueAnswer = between("async function continuePreparedAnswer", "function renderPending");

test("a prepare-only result is shown with its evidence and a 生成答案 button, without an automatic download", () => {
  assert.ok(analyze && preparedOnly && continueAnswer);
  assert.match(analyze, /renderPreparedOnly\(answer, \{ question: text, requestedRulingVersion \}\)/u);
  assert.doesNotMatch(analyze, /downloadPreparedEvidencePackage\(\)/u, "no automatic download");
  assert.match(app, /ui\.evidencePackageDownload\?\.addEventListener\("click", downloadPreparedEvidencePackage\)/u, "the button stays");
  assert.match(preparedOnly, /lt\("生成答案", "Generate the answer", "回答を生成"\)/u);
  assert.match(preparedOnly, /addEventListener\("click", \(\) => \{ void continuePreparedAnswer\(\); \}\)/u);
  assert.match(preparedOnly, /renderPreparedEvidence\(prepared\.evidencePreview, \{ writing: false \}\)/u);
});

test("生成答案 finalizes the stored preparation only while the question is unchanged", () => {
  assert.match(continueAnswer, /ui\.questionInput\.value\.trim\(\) !== prepared\.question/u);
  assert.match(continueAnswer, /requestPreparedAnswer\(prepared\.preparationId, prepared\.requestedRulingVersion/u);
  assert.doesNotMatch(continueAnswer, /requestBackendAnswer\(/u, "the evidence is not prepared again");
  assert.match(analyze, /preparedOnlyResult = null;/u, "a new question forgets the older preparation");
  const schedule = between("function scheduleAnalysis", "init();");
  assert.match(schedule, /preparedOnlyResult = null;/u, "editing the question forgets it too (the result area is reset)");
});

test("生成答案 after the preparation expired asks for a new 查询 instead of a generic failure", () => {
  const presentation = between("function publicRequestFailurePresentation", "function relayPreparationFailurePresentation");
  assert.match(presentation, /code === "answer_preparation_expired" \|\| code === "answer_preparation_deployment_changed"/u);
  assert.match(presentation, /lt\("准备好的证据已失效"/u);
  assert.match(presentation, /本次没有调用最终裁定模型/u);
  assert.match(presentation, /lt\("请重新点“查询”。"/u);
  assert.match(continueAnswer, /renderBackendVersionError\(error, prepared\.requestedRulingVersion\)/u, "the failure goes through the shared presentation");
});

test("the prepare-only button is secondary to 查询", () => {
  assert.match(css, /\.prepare-only-button \{\n  min-height: 36px;\n  padding: 6px 10px;\n  font-size: 13px;\n  font-weight: 600;/u);
  assert.doesNotMatch(css, /\.primary-button,\n  \.prepare-only-button \{\n    width: 100%;/u, "not a full-width twin of 查询 on phones");
});
