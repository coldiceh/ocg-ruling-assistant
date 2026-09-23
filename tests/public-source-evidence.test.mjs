import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
function between(start, end) { return app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start))); }
function element(tagName) {
  return { tagName, textContent: '', childNodes: [],
    appendChild(child) { this.childNodes.push(child); return child; },
    replaceChildren(...children) { this.childNodes = children; },
    addEventListener() {},
  };
}
const document = { createElement: element };
const ui = { sourcesList: element('div'), sourceTrace: element('div') };
function appendText(parent, tag, value) { const node = element(tag); node.textContent = value; return parent.appendChild(node); }
const api = new Function('ui', 'document', 'clearElement', 'appendText', [
  'const tr = value => value; const localeNames = {}; const lastRenderedBackendAnswer = null; let selectedUiLocale = "ja"; const syncedCards = [{ id: "22960", name: "サージ・ブリッツクリーク", jaName: "サージ・ブリッツクリーク", enName: "Surge Blitzclique" }];',
  between('function renderMarkdownInline', 'function startPendingStages'),
  between('function renderSources', 'function renderFeedbackPanel'),
  'return { renderSources, sourcePageUrl, buildSourceLinkMap, renderMarkdownInline };',
].join('\n'))(ui, document, node => { node.childNodes = []; }, appendText);
function descendants(node, tag) { return node.childNodes.flatMap(child => [...(child.tagName === tag ? [child] : []), ...descendants(child, tag)]); }

// Presentation only: URL identity, exact source strings, and DOM nodes. These
// checks do not judge the relevance or sufficiency of any evidence.
test('card FAQ API URLs open the corresponding official card FAQ page', () => {
  assert.equal(api.sourcePageUrl('https://db.ygoresources.com/data/card/12345'),
    'https://www.db.yugioh-card.com/yugiohdb/faq_search.action?cid=12345&ope=4&request_locale=ja');
  assert.equal(api.sourcePageUrl('https://db.ygoresources.com/data/card/12345?raw=1'),
    'https://db.ygoresources.com/data/card/12345?raw=1');
});

test('sources keep titles without URLs and group same document without losing paragraphs', () => {
  api.renderSources([
    { title: 'Document', label: '规则资料', url: 'https://example.test/rules', text: 'first\nparagraph' },
    { title: 'Document', label: '规则资料', url: 'https://example.test/rules', text: 'second <script>not HTML</script>' },
    { detail: 'Source without URL', text: 'source text' },
  ]);
  assert.equal(ui.sourcesList.childNodes.length, 2);
  assert.deepEqual(descendants(ui.sourcesList, 'p').map(node => node.textContent).filter(text => text !== 'Source without URL'),
    ['first\nparagraph', 'second <script>not HTML</script>', 'source text']);
  assert.equal(ui.sourcesList.childNodes[1].childNodes[1].textContent, 'Source without URL');
});

test('serialized QA bodies display their original question, scene and answer strings', () => {
  const record = { recordType: 'qa', question: 'question\nwith newline', rawDetailedQuestion: 'scene', answer: 'answer', text: 'index text',
    extra: { original: '"原文"\n日本語', path: String.raw`C:\tierra\qliphoth.exe` } };
  api.renderSources([{ title: 'QA', text: JSON.stringify(record) }]);
  assert.deepEqual(descendants(ui.sourcesList, 'p').map(node => node.textContent).filter(text => text !== 'QA'),
    [record.question, record.rawDetailedQuestion, record.answer, record.text]);
  api.renderSources([{ title: 'QA', sourceRecord: record }]);
  assert.deepEqual(descendants(ui.sourcesList, 'p').map(node => node.textContent).filter(text => text !== 'QA'),
    [record.question, record.rawDetailedQuestion, record.answer, record.text]);
});

test('confirmed CID markers become card links while unknown markers retain their numbers', () => {
  api.renderSources([{ title: '「<<22960>>」', text: '「<<22960>>」と「<<999999>>」' }]);
  const links = descendants(ui.sourcesList, 'a');
  assert.equal(descendants(ui.sourcesList, 'p')[0].textContent, '「サージ・ブリッツクリーク」');
  assert.deepEqual(links.map(node => node.textContent), ['サージ・ブリッツクリーク', 'CID 999999']);
  assert.equal(links[0].href,
    'https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid=22960&request_locale=ja');
});

test('bold bracket citations and stable evidence IDs resolve through supplied sources', () => {
  const node = element('div');
  const links = api.buildSourceLinkMap([{ id: 'R1.2', title: 'Rule title', sourceUrl: 'https://example.test/rules' }]);
  api.renderMarkdownInline(node, '**【Rule title】** / 【R1.2】', links);
  assert.deepEqual(descendants(node, 'a').map(node => node.href), ['https://example.test/rules', 'https://example.test/rules']);
});
