import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Expanding a source shows the original only. A machine translation (a model call on the server)
// is requested with the 翻译 button under the expanded text, never by opening the source.
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const renderSources = app.slice(app.indexOf("function renderSources"), app.indexOf("function sourceEvidenceFields"));
const translate = app.slice(app.indexOf("async function translateExpandedSource"), app.indexOf("async function fetchSourceTranslation"));

test("opening a source never requests a translation; the 翻译 button does", () => {
  assert.ok(renderSources.length > 0 && translate.length > 0);
  assert.doesNotMatch(renderSources, /addEventListener\("toggle"/u, "no translation on expand");
  assert.match(renderSources, /appendText\(actions, "button", tr\("翻译"\)\)/u);
  assert.match(renderSources, /button\.addEventListener\("click", \(\) => \{\s*void translateExpandedSource\(/u);
  assert.match(renderSources, /entry\.sourceLanguage !== selectedUiLocale/u, "no button for a source already in the page language");
  assert.equal((app.match(/translateExpandedSource\(/gu) || []).length, 2, "the button is the only caller");
});

test("a requested translation is shown even if the source was collapsed while it loaded", () => {
  assert.doesNotMatch(translate, /!details\.open/u);
});

test("the button label is localized", () => {
  assert.match(app, /"翻译": "Translate"/u);
  assert.match(app, /"翻译": "翻訳"/u);
});
