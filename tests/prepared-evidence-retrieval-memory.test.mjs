import test from "node:test";
import assert from "node:assert/strict";

import { retrieveRagEvidence } from "../backend/ragEvidenceRetriever.mjs";
import { registerCanonicalNormalizedRagData } from "../backend/ragNormalizedDataRegistry.mjs";

function trackedArray() {
  const values = [];
  let iterations = 0;
  const array = new Proxy(values, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        return function iterator() {
          iterations += 1;
          return target[Symbol.iterator]();
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { array, iterations: () => iterations };
}

test("prepared evidence retrieval does not build unused local ruling buckets", async () => {
  const records = trackedArray();
  const qaRecords = trackedArray();
  const data = registerCanonicalNormalizedRagData({
    cards: [],
    records: records.array,
    qaRecords: qaRecords.array,
  });

  const prepared = { marker: "prepared-provider-result" };
  const result = await retrieveRagEvidence({
    userQuery: "通常召唤有哪些步骤？",
    cardResolution: {
      resolvedCards: [],
      unresolvedMentions: [],
      ambiguousMentions: [],
    },
    ...data,
    preparedEvidenceProvider: async () => prepared,
    env: { RAG_LIVE_OFFICIAL_QA: "false" },
    fetchImpl: async () => {
      throw new Error("unexpected_network_call");
    },
  });

  assert.equal(result, prepared);
  // createLocalCardDataProvider owns the one existing pass used by card lookup.
  // A prepared provider never consumes local ruling buckets, so another full
  // pass over either corpus is request-scoped work with no consumer.
  assert.equal(records.iterations(), 1);
  assert.equal(qaRecords.iterations(), 1);
});
