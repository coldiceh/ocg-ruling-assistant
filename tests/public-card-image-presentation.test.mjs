import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createLocalCardDataProvider } from "../backend/cardDataProvider.mjs";
import { toRagCard } from "../backend/ragEvidenceRetriever.mjs";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

function appFunction(from, to, dependencies = {}) {
  const source = app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)));
  return new Function(...Object.keys(dependencies), `${source}\nreturn { normalizeVisibleCards, buildLocalImageCandidates };`)(...Object.values(dependencies));
}

function cardDetailClient(fetchImpl) {
  const source = app.slice(app.indexOf("async function loadCardDetail"), app.indexOf("const ADMIN_STAGES"));
  return new Function("fetch", "cardDetailsCache", "getCardApiUrl", `${source}\nreturn { loadCardDetail };`)(
    fetchImpl,
    new Map(),
    () => "https://example.invalid/api/card",
  );
}

test("a local CID never becomes a card-image passcode", () => {
  const { normalizeVisibleCards, buildLocalImageCandidates } = appFunction(
    "function normalizeVisibleCards",
    "function cleanDisplayText",
    {
      normalizeText: (value) => String(value || "").trim(),
      appConfig: { answerApiUrl: "https://example.invalid/api/answer" },
    },
  );

  const [card] = normalizeVisibleCards([{
    id: "1234",
    name: "本地测试卡",
    imageUrl: "https://images.example.test/local-card.jpg",
  }]);

  assert.equal(card.passcode, "");
  assert.deepEqual(buildLocalImageCandidates(card), ["https://images.example.test/local-card.jpg"]);
});

test("the local card adapter does not derive an image number from its CID", () => {
  const provider = createLocalCardDataProvider({
    cards: [{ id: "1234", name: "本地测试卡" }],
  });
  const [card] = provider.searchCardByName("本地测试卡", 1);

  assert.equal(card.passcode, "");
  assert.deepEqual(card.imageCandidates, []);
});

test("the RAG card projection preserves an absent local passcode", () => {
  const card = toRagCard({ id: "1234", name: "本地测试卡", passcode: "" }, "本地测试卡", 1);

  assert.equal(card.id, "1234");
  assert.equal(card.passcode, "");
});

test("a local CID card loads detail by name so the card API can supply its real image passcode", async () => {
  let requestUrl = "";
  const client = cardDetailClient(async (url) => {
    requestUrl = String(url);
    return new Response(JSON.stringify({
      name: "本地测试卡",
      imageCandidates: ["https://images.example.test/real-passcode.jpg"],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const detail = await client.loadCardDetail({ id: "12345678", name: "本地测试卡", cnName: "本地测试卡" });

  const url = new URL(requestUrl);
  assert.equal(url.searchParams.get("id"), null);
  assert.equal(url.searchParams.get("name"), "本地测试卡");
  assert.deepEqual(detail.imageCandidates, ["https://images.example.test/real-passcode.jpg"]);
});

test("an explicit passcode remains available for the image proxy", () => {
  const { normalizeVisibleCards, buildLocalImageCandidates } = appFunction(
    "function normalizeVisibleCards",
    "function cleanDisplayText",
    {
      normalizeText: (value) => String(value || "").trim(),
      appConfig: { answerApiUrl: "https://example.invalid/api/answer" },
    },
  );

  const [card] = normalizeVisibleCards([{ id: "1234", passcode: "89631139", name: "百鸽测试卡" }]);
  const candidates = buildLocalImageCandidates(card);

  assert.equal(card.passcode, "89631139");
  assert.ok(candidates.includes("https://example.invalid/api/card-image?id=89631139"));
});
