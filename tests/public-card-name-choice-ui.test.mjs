import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const debug = {
  modelCardNameCandidates: [{ name: '示例天', originalText: '示例天', source: 'model_card_name_extractor' }],
  unresolvedMentions: [{ input: '示例天', source: 'model_card_name_extractor' }],
  ambiguousMentions: [{ input: '示例天', candidateCards: [{ id: '10000910', name: '示例天 完整规范名', source: 'baige' }] }],
};

function runtime(question) {
  const start = app.indexOf('function collectPendingCardNameChoices');
  const end = app.indexOf('function renderCards', start);
  assert.ok(start >= 0 && end > start, 'the production UI must offer a card-name choice');
  const document = { createElement: tag => ({
    tag, children: [], textContent: '', handlers: {},
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(event, handler) { this.handlers[event] = handler; },
    setAttribute() {},
  }) };
  let submitted = 0;
  const ui = { questionInput: { value: question, focus() {} } };
  const api = new Function('ui', 'document', 'fetch', 'analyzeQuestion', `${app.slice(start, end)}
    return { collectPendingCardNameChoices, renderCardNameChoices };
  `)(ui, document, () => { submitted++; throw new Error('unexpected request'); }, () => { submitted++; });
  const host = document.createElement('div');
  api.renderCardNameChoices(host, debug, question);
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  return { ...api, ui, host, buttons: descendants(host).filter(node => node.tag === 'button'), submitted: () => submitted };
}

test('the unresolved provider candidate is actionable and selection does not submit a request', () => {
  const state = runtime('示例天能适用吗？');
  assert.equal(state.buttons.length, 1);
  assert.match(state.buttons[0].textContent, /示例天 完整规范名/u);
  assert.equal(state.ui.questionInput.value, '示例天能适用吗？');
  state.buttons[0].handlers.click();
  assert.equal(state.ui.questionInput.value, '示例天 完整规范名能适用吗？');
  assert.match(state.host.children.at(-1).textContent, /请点击.*查询/u);
  assert.equal(state.submitted(), 0);
});

test('choosing one literal occurrence leaves the other similar card name unchanged', () => {
  const state = runtime('示例天使与示例天分别处理。');
  assert.equal(state.buttons.length, 2);
  assert.match(state.buttons[1].textContent, /第 2 处/u);
  state.buttons[1].handlers.click();
  assert.equal(state.ui.questionInput.value, '示例天使与示例天 完整规范名分别处理。');
});

test('a stale result cannot replace text in a newly edited question', () => {
  const state = runtime('示例天能适用吗？');
  state.ui.questionInput.value = '另一个新问题';
  state.buttons[0].handlers.click();
  assert.equal(state.ui.questionInput.value, '另一个新问题');
  assert.match(state.host.children.at(-1).textContent, /问题已修改/u);
});

test('ordinary quoted phrases and records without a stable candidate id are not offered as choices', () => {
  const state = runtime('示例天能适用吗？');
  const result = state.collectPendingCardNameChoices({
    ...debug,
    ambiguousMentions: [
      { input: '示例天', candidateCards: [{ name: '没有身份的名称' }] },
      { input: '自己抽一张', candidateCards: [{ id: '2000', name: '无关候选' }] },
    ],
  }, '示例天，自己抽一张。');
  assert.deepEqual(result, []);
});

test('the answer renderer forwards existing diagnostics to the candidate controls', () => {
  assert.match(app, /pendingModelCardNames\(answer\?\.debug\),\s*answer\?\.debug/u);
  assert.match(app, /renderCardNameChoices\(choicesHost, debug, lastSubmittedQuestion\)/u);
});
