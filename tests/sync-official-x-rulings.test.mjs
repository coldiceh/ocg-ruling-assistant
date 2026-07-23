import test from "node:test";
import assert from "node:assert/strict";
import {
  extractQuestionText,
  fetchOfficialXRulings,
  findOfficialFaqUrl,
  isOfficialRulingTweet,
  normalizeTweet,
  parseOfficialFaqId,
} from "../scripts/sync-official-x-rulings.mjs";

const officialTweet = {
  id: "2076652870695632997",
  author_id: "618646265",
  created_at: "2026-07-13T13:00:01.375Z",
  text: [
    "✨━━━━━━━━━━━━✨",
    "Ｑ＆Ａを考えてみよう",
    "「獄神影獣－ネルヴェド」と宣言して「神芸学都アルトメギア」②の効果を発動できますか？",
    "✅回答はこちら",
    "https://t.co/example",
  ].join("\n"),
  entities: {
    urls: [{
      url: "https://t.co/example",
      expanded_url: "https://www.db.yugioh-card.com/yugiohdb/faq_search.action?fid=24276&ope=5&request_locale=ja",
    }],
  },
};

test("extractQuestionText ignores changing decoration and answer CTA", () => {
  assert.equal(
    extractQuestionText(officialTweet.text),
    "「獄神影獣－ネルヴェド」と宣言して「神芸学都アルトメギア」②の効果を発動できますか？",
  );
  assert.equal(
    extractQuestionText("【Q&Aを考えてみよう】\nカードの効果は適用されますか？\n答えはこちら👇\nhttps://t.co/x"),
    "カードの効果は適用されますか？",
  );
});

test("official tweet filter requires exact account, series text and expanded official FAQ URL", () => {
  assert.equal(isOfficialRulingTweet(officialTweet), true);
  assert.equal(isOfficialRulingTweet({ ...officialTweet, author_id: "999" }), false);
  assert.equal(isOfficialRulingTweet({ ...officialTweet, entities: { urls: [] } }), false);
  assert.equal(isOfficialRulingTweet({ ...officialTweet, text: "通常のお知らせ" }), false);
});

test("official FAQ URL and id are parsed without guessing", () => {
  const url = findOfficialFaqUrl(officialTweet);
  assert.equal(parseOfficialFaqId(url), "24276");
  assert.equal(parseOfficialFaqId("https://example.com/yugiohdb/faq_search.action?fid=24276"), null);
  assert.equal(parseOfficialFaqId("https://www.db.yugioh-card.com/yugiohdb/faq_search.action?cid=24276"), null);
});

test("normalizeTweet produces a batch-compatible expected QA id", () => {
  const normalized = normalizeTweet(officialTweet);
  assert.equal(normalized.tweetId, officialTweet.id);
  assert.deepEqual(normalized.expectedQaIds, ["24276"]);
  assert.equal(normalized.officialFaqId, "24276");
  assert.equal(normalized.sourceUrl, `https://x.com/YuGiOh_OCG_INFO/status/${officialTweet.id}`);
});

test("full archive sync follows pagination and rejects lookalike posts", async () => {
  const requests = [];
  const secondTweet = {
    ...officialTweet,
    id: "2",
    created_at: "2024-01-01T00:00:00Z",
    text: officialTweet.text.replace("アルトメギア", "別のカード"),
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    const page = requests.length === 1
      ? {
          data: [officialTweet, { ...officialTweet, id: "lookalike", author_id: "999" }],
          meta: { next_token: "next-page" },
        }
      : { data: [secondTweet], meta: {} };
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const corpus = await fetchOfficialXRulings({ token: "secret", fetchImpl });
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /next_token=next-page/u);
  assert.equal(requests[0].init.headers.Authorization, "Bearer secret");
  assert.equal(corpus.cases.length, 2);
  assert.equal(corpus.collection.paginationExhausted, true);
  assert.equal(corpus.collection.rejectedTweetCount, 1);
  assert.equal(corpus.isCompleteCorpus, false);
});

test("full archive sync fails explicitly without credentials", async () => {
  await assert.rejects(
    fetchOfficialXRulings({ token: "", fetchImpl: async () => assert.fail("must not fetch") }),
    (error) => error.exitCode === 2 && /X_BEARER_TOKEN/u.test(error.message),
  );
});
