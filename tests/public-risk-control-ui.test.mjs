import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("admin UI exposes authenticated risk status and CSRF-protected unlock only", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("src/app.js", root), "utf8"),
  ]);

  assert.match(html, /id="adminRiskControlStatus"/u);
  assert.match(html, /id="adminRiskControlUnlockButton"[^>]*disabled/u);
  assert.match(app, /fetch\(getAdminEndpointUrl\("\/api\/admin-risk-control"\)/u);
  assert.match(app, /headers\["x-csrf-token"\]\s*=\s*adminSession\.csrfToken/u);
  assert.match(app, /body:\s*JSON\.stringify\(\{ action: "unlock" \}\)/u);
  assert.match(app, /credentials:\s*"include"/u);
  assert.match(app, /loadAdminLabBootstrap[\s\S]*loadAdminRiskControlStatus\(\)/u);
});

test("risk-control answers render as an ordinary caution rather than a system failure", async () => {
  const app = await readFile(new URL("src/app.js", root), "utf8");
  assert.match(
    app,
    /risk_control:\s*\{[^}]*className:\s*"is-caution"[^}]*title:\s*"公开问答暂时受限"/u,
  );
  assert.match(app, /public_offtopic_risk_control:\s*"公开问答当前处于非规则问题风控状态。"/u);
  assert.doesNotMatch(app, /(?:adminUiEnabled|admin=1)[\s\S]{0,160}\/api\/answer/iu);
});
