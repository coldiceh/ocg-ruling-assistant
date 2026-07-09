import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/budget.js";

test("budget_reset_requires_owner_token", async () => {
  const previousToken = process.env.API_BUDGET_RESET_TOKEN;
  const previousBudget = process.env.API_DAILY_BUDGET_CNY;
  try {
    delete process.env.API_BUDGET_RESET_TOKEN;
    process.env.API_DAILY_BUDGET_CNY = "10";

    let response = createJsonResponse();
    await handler({ method: "GET", headers: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.resetEnabled, false);

    response = createJsonResponse();
    await handler({ method: "POST", headers: {} }, response);
    assert.equal(response.statusCode, 403);
    assert.equal(response.payload.error, "budget_reset_token_not_configured");

    process.env.API_BUDGET_RESET_TOKEN = "owner-secret";
    response = createJsonResponse();
    await handler({ method: "POST", headers: {} }, response);
    assert.equal(response.statusCode, 401);

    response = createJsonResponse();
    await handler({ method: "POST", headers: { "x-budget-reset-token": "wrong" } }, response);
    assert.equal(response.statusCode, 403);

    response = createJsonResponse();
    await handler({ method: "POST", headers: { authorization: "Bearer owner-secret" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.spentTodayCny, 0);
  } finally {
    if (previousToken === undefined) delete process.env.API_BUDGET_RESET_TOKEN;
    else process.env.API_BUDGET_RESET_TOKEN = previousToken;
    if (previousBudget === undefined) delete process.env.API_DAILY_BUDGET_CNY;
    else process.env.API_DAILY_BUDGET_CNY = previousBudget;
  }
});

function createJsonResponse() {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}
