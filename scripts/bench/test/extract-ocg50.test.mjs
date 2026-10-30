import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildOcg50SetDocument,
  extractOcg50FromHtml,
  sha256Hex,
} from "../extract-ocg50.mjs";
import { decodeHtmlEntities } from "../lib/html-text.mjs";

function row(qid, cell, question, reference, extraCells = 1) {
  const cells = Array.from({ length: extraCells }, (_, index) => (
    `<td class="answer correct" data-cell="${cell}-F-M${index}" data-model="m"><pre>回答 &lt;/tr&gt; 文本</pre></td>`
  )).join("");
  return `<tr class="question" data-case="${qid}" id="${qid}"><th scope="row"><h2>${qid}</h2>`
    + `<p class="question-text">${question}</p></th><td class="reference">${reference}</td>${cells}</tr>`;
}

function table(rows) {
  return `<table><thead><tr><th>题目</th><th>参考答案</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

test("extracts rows in order with decoded text, cell id and source hash", () => {
  const html = table([
    row("Q1", "B01", "题面一 &amp; 「卡」\n第二行", "结论一；理由一。", 6),
    row("Q2", "B03", "题面二 &#x300C;引号&#12301;", "结论二。"),
  ]);
  const result = extractOcg50FromHtml(html, { expectedCount: 2 });
  assert.equal(result.sourceHtmlSha256, sha256Hex(Buffer.from(html, "utf8")));
  assert.deepEqual(result.items.map((item) => [item.qid, item.cellId]), [["Q1", "B01"], ["Q2", "B03"]]);
  assert.equal(result.items[0].question, "题面一 & 「卡」\n第二行");
  assert.equal(result.items[1].question, "题面二 「引号」");
  assert.equal(result.items[0].referenceAnswer, "结论一；理由一。");
  assert.ok(result.items.every((item) => item.sourceHtmlSha256 === result.sourceHtmlSha256));
  // A CRLF checkout (Git for Windows default) yields the same set and hash.
  assert.deepEqual(extractOcg50FromHtml(html.replaceAll("\n", "\r\n"), { expectedCount: 2 }), result);
});

test("fails loudly on wrong count, empty fields, markup, mixed cells and out-of-order ids", () => {
  const ok = row("Q1", "B01", "题", "答");
  assert.throws(() => extractOcg50FromHtml(table([ok]), { expectedCount: 2 }), /count:1!=2/u);
  assert.throws(() => extractOcg50FromHtml(table([row("Q1", "B01", "  ", "答")]), { expectedCount: 1 }),
    /empty:Q1:question/u);
  assert.throws(() => extractOcg50FromHtml(table([row("Q1", "B01", "题<br>面", "答")]), { expectedCount: 1 }),
    /html_cell_contains_markup/u);
  const mixed = row("Q1", "B01", "题", "答").replace("</tr>", '<td data-cell="B02-F-X"></td></tr>');
  assert.throws(() => extractOcg50FromHtml(table([mixed]), { expectedCount: 1 }), /cell_id_count_2/u);
  assert.throws(() => extractOcg50FromHtml(table([row("Q2", "B01", "题", "答")]), { expectedCount: 1 }),
    /order:0:Q2/u);
  assert.throws(() => decodeHtmlEntities("&bogus;"), /html_entity_unsupported/u);
});

test("committed 50-question set matches a fresh extraction of the published table", async () => {
  const html = await readFile(new URL("../../../assets/benchmarks/ocg-50-20260924.html", import.meta.url));
  const fresh = buildOcg50SetDocument(extractOcg50FromHtml(html));
  const committed = JSON.parse(await readFile(new URL("../sets/ocg-50-20260924.json", import.meta.url), "utf8"));
  assert.deepEqual(committed, fresh);
  assert.equal(committed.items.length, 50);
  const missing = ["B05", "B29", "B33", "B34", "B38", "B52"];
  assert.ok(missing.every((cell) => !committed.items.some((item) => item.cellId === cell)));
});
