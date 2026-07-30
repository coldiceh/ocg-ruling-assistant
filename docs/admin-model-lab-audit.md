# 管理模型实验室工作区审计

> 历史审计快照：本文记录的是管理模型实验室开始实施前的基线状态，不代表当前实现状态。当前架构、部署和安全要求以同目录的 `admin-model-lab-architecture.md`、`admin-auth-security.md`、`openai-provider.md` 为准。

审计日期：2026-07-27
审计分支：`main`
审计基线：`b7e9ce32d7ae02f0493d57651deb5d888ca6f964`

## 1. 本轮边界

本轮是在现有规则助手中增加隔离的管理模型实验室，不重写公开问答流程，不接入另一个“游戏王模拟器”项目，也不把 OpenAI 自动设为公开默认模型。

产品的长期目标已进一步澄清为：

1. 确定性检索和较便宜的模型负责卡名候选、查询改写、FAQ/规则资料召回和整理。
2. 便宜模型不能静默删除候选资料，也不能自己决定“这题足够简单，所以由我给最终答案”。
3. 完整资料冻结为可复现的 `EvidenceSnapshot`。
4. 最终裁定由经过评测选定的 GPT-5.6 模型和推理档位生成。
5. 结构校验器检查引用、结论一致性和决定性资料缺口。

该长期目标不在本轮直接替换生产路径。本轮先取得同题、同证据条件下的质量、延迟和费用数据，再由管理员明确决定生产切换。

## 2. 审计方法

已执行：

- `git status --short --branch`
- `git diff --stat`
- `git diff --name-status`
- 与卡文分段、三值核心、公开 API、认证、查询记录、UI 和 RAG 相关的测试
- GitHub Pages 状态和最近工作流状态查询
- 当前 Vercel `/api/answer` 和公开 Pages `config.json` 查询
- 源码中常见 OpenAI Key 前缀和前端公开环境变量名扫描

基线测试结果：130 项通过，0 项失败。

## 3. 已由代码确认的事实

### 3.1 公开入口和部署结构

- 静态公开页面入口是 `index.html`，逻辑位于 `src/app.js`。
- `config.json` 把公开页面指向 `https://ocg-ruling-assistant.vercel.app/api/answer`。
- GitHub Pages 负责静态前端，Vercel `api/*.js` 负责生产 Serverless API。
- 本地开发另有 `backend/server.mjs`，它和 Vercel API 实现了相近但重复的路由。
- 公开浏览器只向 `/api/answer` 提交问题，不直接调用任何模型供应商。

### 3.2 当前公开模型路径

- `src/app.js` 中公开请求固定 `mode: "rag"`、`modelTier: "flash"`。
- `api/answer.js` 根据服务端环境变量解析供应商，浏览器请求体不能直接指定供应商。
- RAG 主路径当前只支持 DeepSeek、Gemini 和 Mock；没有把 OpenAI 接入当前 RAG 主调用链。
- `backend/ragModelClient.mjs` 的自动选择优先 DeepSeek。
- DeepSeek 最终生成使用 Chat Completions、非流式请求和 `json_object`，不是严格 JSON Schema Structured Output。
- 公开 API 仍保留显式的 `legacy` 和 `fastjudge` 内部模式；普通页面不会选择它们。

### 3.3 `?admin=1` 的真实含义

- `?admin=1` 仅由 `src/app.js:isAdminUiEnabled()` 用于显示“问题记录”面板。
- 它不是服务端身份认证。
- 当前没有“模型实验室”UI、模型选择器、reasoning effort/mode 控件、同题对比、人工评分或实验统计。
- 当前问题记录读取通过 `window.prompt()` 获取密码，并把密码放进每次 `/api/admin-queries` 请求体。
- 服务端确实使用常量时间比较验证密码或 Token，所以并非完全没有后端校验。
- 当前认证不是短期会话：没有登录端点、HttpOnly Cookie、会话过期、注销或 CSRF 令牌。
- `ALLOWED_ORIGIN` 未配置时默认为 `*`。这不适合带凭据的管理会话。

### 3.4 Secret 和存储

- 模型 API Key 从服务端环境变量读取。
- 源码扫描没有发现 OpenAI Key 值，也没有发现 `VITE_OPENAI_API_KEY`、`NEXT_PUBLIC_OPENAI_API_KEY` 或 `REACT_APP_OPENAI_API_KEY`。
- 当前查询历史使用 Upstash/KV REST 接口；仅保存问题、时间、模式和短 ID。
- 查询历史最多保存 100 条，默认保留 30 天。
- 当前查询历史认证可复用为新会话体系的迁移入口，但不能继续让浏览器在每个请求中重发长期密码。

### 3.5 检索、提示词和回答流程

当前 RAG 主要顺序是：

1. 读取数据。
2. 本地卡名解析和确定性预检查。
3. 卡名提取模型与规则查询提取模型并行运行。
4. 检索卡片文本、官方 Q&A/FAQ、规则资料和百鸽候选。
5. 本地规则/状态分析。
6. 必要时用模型判读检索到的规则片段。
7. 构建统一 RAG 提示词。
8. DeepSeek/Gemini 最终生成。
9. 多个确定性后处理器可能覆盖模型结论。

DeepSeek 与 Gemini 共用 RAG 资料和提示词构造。现有 `backend/openai.mjs` 属于另一条旧调用链，不是当前公开 RAG 的 OpenAI Provider。

### 3.6 Token、费用和耗时

- DeepSeek/Gemini 路径会读取上游 `usage` 并估算人民币费用。
- 当前公开预算逻辑和管理实验的未来计量不是同一个数据模型。
- 当前没有美元/人民币分项、价格版本、汇率版本、reasoning token 明细或每个实验的持久化费用记录。
- 当前 RAG 有若干 `timingsMs`，但使用 `Date.now()`，主要放在 debug 数据中。
- 当前没有统一单调时钟阶段追踪器。
- 当前没有首事件、首文本、上游接收、结构化输出完成等时间点。
- 当前没有 SSE、可恢复游标或异步 `runId`。

### 3.7 模拟器状态

- 当前 RAG 文件仍保留可选的 OCG Engine 客户端和诊断结果字段。
- 它是历史代码，不属于本轮管理实验室设计。
- 新管理实验路径必须完全绕开这些模块，不查询 capabilities，也不能因为模拟器不存在返回 `UNKNOWN`。
- 本轮不为此重写公开路径，以避免改变现有用户行为。

### 3.8 未提交修改

工作区包含大量已有未提交修改，包括：

- 卡名和百鸽检索改进；
- 卡文范式化和编号效果分段；
- 通用状态/效果处理尝试；
- 三值逻辑和最小证明核心；
- 对应回归测试；
- CI 和批量题集调整。

另有未跟踪的诊断目录和运行报告。它们不是本轮代码的一部分，不能被批量暂存。

必须保留：

- `backend/cardTextSections.mjs` 的编号效果分段修正；
- `backend/cardTextNormalizer.mjs` 及其测试；
- `backend/proofCore.mjs` 及其测试；
- 已有检索修复。

## 4. 已由线上响应或日志确认的事实

### 4.1 当前生产响应

2026-07-27 查询 Vercel `/api/answer` 得到：

- `provider: deepseek`
- 默认公布模型：`deepseek-v4-pro`
- 卡名模型：`deepseek-v4-flash`
- Flash/Pro 两个 DeepSeek tier
- 持久预算存储：Redis
- `engineEnabled: false`
- `pipeline: rag_baseline`

公开页面实际固定提交 Flash tier，因此普通页面的最终请求仍按 Flash 配置运行。

### 4.2 GitHub Pages

- Pages 地址：`https://coldiceh.github.io/ocg-ruling-assistant/`
- 来源：`main` 分支、GitHub Actions workflow
- HTTPS 已启用
- 最近一次 Pages 部署成功。

### 4.3 当前同步告警

最近多次 `Sync ruling data` 工作流失败。最新日志显示：

- 卡片、别名、规则记录和索引同步本身完成；
- 数据质量检查为可用；
- 最后失败于 freshness gate；
- 具体原因是 `ygoresources_stale:54.5h` 超过 36 小时阈值。

因此手机收到的失败通知目前主要代表数据源新鲜度门禁失败，不等于公开站或 Vercel 回答接口宕机。但持续失败会阻止最新同步提交，应另行修复。

## 5. 合理推断

- 现有 Upstash/KV 可以作为管理会话、实验 Run、事件游标和 Evidence Snapshot 的持久化后端，但必须先验证生产环境具有所需变量和容量。
- GitHub Pages 与 Vercel 跨站部署意味着管理 Cookie 若继续跨站使用，需要 `Secure; HttpOnly; SameSite=None`、精确 Origin 白名单和 CSRF 防护；`SameSite=Strict` 会导致 GitHub Pages 无法携带该 Cookie。
- OpenAI Responses 的 background mode 适合长时 GPT 实验：创建后可轮询、取消和续流，并允许 `store=false`。这能避免把一次长推理绑定在单条浏览器 HTTP 连接上。
- DeepSeek 没有在当前代码中提供同等 background API。管理实验若要支持长 DeepSeek 运行，需要受托管平台限制的后台执行机制，或明确把 DeepSeek 实验限制为平台允许的同步执行时长；不能伪称无限。

## 6. 尚未确认的事项

- Vercel 当前套餐、单个 Function 的实际 `maxDuration` 和流式连接上限。
- 生产 Vercel 是否已配置 `OPENAI_API_KEY`。
- 当前 OpenAI Project 对 GPT-5.6 Sol/Terra/Luna、pro mode 和各 reasoning effort 的真实权限。
- Upstash 当前容量、数据保留政策和是否适合保存完整实验记录。
- 是否需要把管理实验页面迁移到与 Vercel 同站域名以使用更严格的 SameSite Cookie。
- OpenAI 后台响应在当前账号和区域的实际可用性与响应保留行为。
- 真模型质量、Token、费用、p50/p90/p95；普通 CI 不允许为了确认这些数据产生费用。

## 7. 现有测试仍未证明的风险

虽然基线测试全绿，但不能据此认为当前规则回答已经可靠：

- 若干确定性分支仍使用关键词或旁路正则识别机制。
- 某些旁路结果会直接覆盖模型答案，而不只是生成候选。
- 当前模型 JSON 失败后仍会尝试修复或从自由文本恢复；这不满足管理实验的严格 Structured Output 要求。
- 现有测试大量验证已知成功路径，不能证明表达变化、歧义卡名和新机制的覆盖率。
- 当前 debug timing 使用墙钟，不满足实验统计对单调时钟的要求。

管理实验必须原样保存模型结构化输出和校验错误，不允许用第二个模型润色，也不允许把 JSON 修复后的自由文本算作有效结果。

## 8. 实施结论

本轮可以在不改公开 DeepSeek 路径的前提下继续实施，顺序为：

1. 新建安全、短期、可注销的管理员会话。
2. 新建与 `/api/answer` 分离的管理模型实验 API。
3. 新建服务端模型能力表和允许列表。
4. 冻结 `EvidenceSnapshot`，保证同轮比较资料完全一致。
5. OpenAI 使用 Responses API、严格 Structured Output、`store=false` 和 background mode。
6. 以持久 `runId`、服务端单调计时、事件序列和人工取消管理长任务。
7. 记录真实 usage、价格版本、汇率版本、阶段耗时和人工评分。
8. 实验侧不设置应用预算、Token 或 30 秒自动终止；10 秒和 30 秒只作为统计标签。
9. 公开主路径继续固定 DeepSeek，直到管理员依据评测结果明确批准生产切换。
