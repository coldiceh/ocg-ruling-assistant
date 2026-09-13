import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const [html, app] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
]);

test("cross-site admin entry moves to the configured API site before login", () => {
  const source = app.match(/function redirectToAdminPage\(\) \{[^]*?\n\}/u)?.[0];
  assert.ok(source, "admin navigation must avoid third-party session cookies");
  const target = "https://backend.example.test/?admin=1";
  const context = vm.createContext({
    URL, adminUiEnabled: true,
    appConfig: { adminPageUrl: target, answerApiUrl: "https://backend.example.test/api/answer" },
    window: { location: {
      href: "https://pages.example.test/project/?admin=1&private=do-not-forward#private",
      origin: "https://pages.example.test",
      replace(url) { context.redirected = url; },
    } },
  });
  vm.runInContext(source, context);
  assert.equal(context.redirectToAdminPage(), true);
  assert.equal(context.redirected, target);
  context.redirected = undefined;
  context.window.location.origin = "https://backend.example.test";
  assert.equal(context.redirectToAdminPage(), false, "same-site page must not loop");
  context.window.location.origin = "https://pages.example.test";
  context.adminUiEnabled = false;
  assert.equal(context.redirectToAdminPage(), false, "public questions remain on Pages");
  context.adminUiEnabled = true;
  context.appConfig.answerApiUrl = "http://127.0.0.1:8787/api/answer";
  assert.equal(context.redirectToAdminPage(), false, "local API must not send admin to production");
  assert.equal(context.redirected, undefined);
  const init = app.match(/async function init\(\) \{[^]*?\n\}/u)?.[0] || "";
  assert.ok(init.indexOf("redirectToAdminPage()") > init.indexOf("await loadAppConfig()"));
  assert.ok(init.indexOf("redirectToAdminPage()") < init.indexOf("await initializeAdminLab()"));
});

test("missing cookie is distinct from expiry and ordinary backend errors keep the session", async () => {
  for (const name of ["requestAdminQuestionHistory", "requestAdminRiskControl", "requestAdminLab"]) {
    const source = app.match(new RegExp(`async function ${name}\\([^]*?\\n\\}(?=\\r?\\n|$)`, "u"))?.[0];
    assert.ok(source, name);
    const context = vm.createContext({
      URL, adminSession: { authenticated: true },
      getAdminEndpointUrl: pathname => `https://backend.example.test${pathname}`,
      stopFollowingAdminRun() {},
      setAdminAuthenticated(value) { context.adminSession.authenticated = value; },
      setAdminLoginStatus(value) { context.message = value; },
      fetch: async () => ({ status: 401, ok: false, json: async () => ({ error: "admin_session_required" }) }),
    });
    for (const helper of ["createAdminRequestError", "adminErrorMessage"]) {
      vm.runInContext(app.match(new RegExp(`function ${helper}\\([^]*?\\n\\}`, "u"))[0], context);
    }
    vm.runInContext(source, context);
    const call = () => context[name](name === "requestAdminLab" ? { action: "capabilities" } : undefined);
    await assert.rejects(call, { code: "admin_session_required" });
    assert.equal(context.adminSession.authenticated, false);
    assert.doesNotMatch(context.message, /过期/u, name);
    context.adminSession.authenticated = true;
    context.fetch = async () => ({ status: 503, ok: false, json: async () => ({ error: "admin_session_storage_unavailable" }) });
    await assert.rejects(call, { code: "admin_session_storage_unavailable" });
    assert.equal(context.adminSession.authenticated, true, name);
  }
});

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
