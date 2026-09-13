import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
function between(start, end) { return app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start))); }
function element(tagName) {
  return { tagName, textContent: '', childNodes: [], appendChild(child) { this.childNodes.push(child); return child; } };
}
const document = { createElement: element };
const ui = { sourcesList: element('div'), sourceTrace: element('div') };
function appendText(parent, tag, value) { const node = element(tag); node.textContent = value; return parent.appendChild(node); }
const api = new Function('ui', 'document', 'clearElement', 'appendText', [
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
  assert.deepEqual(descendants(ui.sourcesList, 'pre').map(node => node.textContent),
    ['first\nparagraph', 'second <script>not HTML</script>', 'source text']);
  assert.equal(ui.sourcesList.childNodes[1].childNodes[1].textContent, 'Source without URL');
});

test('serialized QA bodies display their original question, scene and answer strings', () => {
  const record = { recordType: 'qa', question: 'question\nwith newline', rawDetailedQuestion: 'scene', answer: 'answer', text: 'index text' };
  api.renderSources([{ title: 'QA', text: JSON.stringify(record) }]);
  assert.deepEqual(descendants(ui.sourcesList, 'pre').map(node => node.textContent),
    [record.question, record.rawDetailedQuestion, record.answer, record.text]);
});

test('bold bracket citations and stable evidence IDs resolve through supplied sources', () => {
  const node = element('div');
  const links = api.buildSourceLinkMap([{ id: 'R1.2', title: 'Rule title', sourceUrl: 'https://example.test/rules' }]);
  api.renderMarkdownInline(node, '**【Rule title】** / 【R1.2】', links);
  assert.deepEqual(descendants(node, 'a').map(node => node.href), ['https://example.test/rules', 'https://example.test/rules']);
});
