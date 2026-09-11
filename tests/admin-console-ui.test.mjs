import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const [html, app] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
]);

test("admin page keeps only management controls and public question history", () => {
  for (const id of [
    "adminLabPanel",
    "adminLoginForm",
    "adminLogoutButton",
    "adminRiskControlUnlockButton",
    "budgetCapButton",
    "budgetResetButton",
    "adminQuestionHistoryList",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  for (const removedId of [
    "adminEvidenceCaptureForm",
    "adminStartButton",
    "adminComparisonSection",
    "adminHistoryList",
    "adminEvaluationSelect",
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${removedId}"`, "u"));
  }
  assert.match(html, /<h2 id="adminLabTitle">后台管理<\/h2>/u);
  assert.match(html, /提问、答案和连接 IP 会保存在管理员历史中，仅登录管理员可见/u);
});

test("logout clears private history and a late history response cannot repopulate it", async () => {
  let resolveHistory;
  let rendered = 0;
  const list = { children: ["private history"] };
  const context = vm.createContext({
    adminSession: { authenticated: true, csrfToken: "session-a" }, adminCapabilityState: null,
    ui: { adminQuestionHistoryList: list, adminQuestionHistoryStatus: {textContent:""}, adminQuestionHistoryRefreshButton: {} },
    clearElement: element => { element.children = []; },
    clearAdminRiskControlStatus() {}, setAdminLoginStatus() {}, formatAdminDate: () => "",
    setAdminControlsEnabled() {}, updateAdminComparisonAvailability() {},
    requestAdminQuestionHistory: () => new Promise(resolve => {resolveHistory = resolve;}),
    renderAdminQuestionHistory: () => {rendered++;},
    firstAdminArray: (...values) => values.find(Array.isArray) || [],
    adminErrorMessage: () => "fixture",
  });
  for (const name of ["setAdminAuthenticated", "loadAdminQuestionHistory"]) {
    const source = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`, "u"))?.[0];
    assert.ok(source, name);
    vm.runInContext(source, context);
  }
  const pending = context.loadAdminQuestionHistory();
  context.setAdminAuthenticated(false);
  assert.equal(list.children.length, 0);
  resolveHistory({entries:[{question:"private response"}]});
  await pending;
  assert.equal(rendered, 0);
  assert.equal(list.children.length, 0);
});

test("admin bootstrap does not read removed experiment modules", () => {
  const bootstrap = app.match(/async function loadAdminLabBootstrap\(\) \{[\s\S]*?\n\}/u)?.[0] || "";
  assert.match(bootstrap, /loadAdminRiskControlStatus\(\)/u);
  assert.match(bootstrap, /loadAdminQuestionHistory\(\)/u);
  assert.doesNotMatch(bootstrap, /loadAdminCapabilities|loadAdminHistory|loadAdminEvaluationCases|restoreStoredAdminRun/u);
});

test("question history renderer uses collapsed details and exposes full fields", () => {
  assert.match(app, /function renderAdminQuestionHistory\(entries\)/u);
  for (const label of ["问题全文", "结果 \/ 答案全文", "调用者 IP", "IP 来源", "请求 ID", "记录 ID", "最终模型", "所选档位", "推理档位", "耗时"]) {
    assert.match(app, new RegExp(label, "u"));
  }
  const renderer = app.match(/function renderAdminQuestionHistory\(entries\) \{[\s\S]*?\n\}/u)?.[0] || "";
  assert.match(renderer, /createElement\("details"\)/u);
  assert.match(renderer, /createElement\("summary"\)/u);
  assert.match(renderer, /adminHistoryPreview/u);
  assert.match(renderer, /appendAdminHistoryField/u);
  assert.doesNotMatch(renderer, /innerHTML/u);
  assert.match(app, /旧记录未保存的字段显示/u);
  assert.match(app, /characters\.slice\(0, 120\)/u);
  assert.match(app, /entry\?\.model\)/u);
  assert.match(app, /entry\?\.requestId\)/u);
  assert.match(app, /if \(ui\.adminQuestionHistoryList\) clearElement\(ui\.adminQuestionHistoryList\)/u);
  assert.match(app, /const historySessionToken = adminSession\.csrfToken/u);
  assert.match(app, /adminSession\.csrfToken !== historySessionToken/u);
});
