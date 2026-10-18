# OCG 引擎连接

本仓库保留独立 OCG sidecar 的 HTTP 客户端和本地启动脚本。引擎核心、卡片脚本和资源快照由 [ocg-sim-core](https://github.com/coldiceh/ocg-sim-core) 维护。

当前公开问答通过资料检索和最终模型生成回答，不调用模拟器、形式引擎或 Legacy Lua 旁路。配置 `OCG_ENGINE_URL` 或 `RAG_AUTO_ENGINE_SIMULATION` 不会改变这一公开路径。以下说明用于连接和检查独立 sidecar，不代表正式裁定能力验收。

## 本地启动

先按引擎仓库的说明安装依赖和资源，确保其中存在 `tools/serve.mjs`。本项目默认寻找相邻的 `游戏王游戏引擎` 目录，也可显式指定：

```powershell
$env:OCG_ENGINE_ROOT = "D:\Projects\ocg-sim-core"
pnpm dev:with-engine
```

启动脚本会检查引擎健康状态和 Legacy Lua 能力，启动或复用匹配的本地引擎，再启动后端和前端。已有监听进程不兼容、令牌不匹配或能力检查失败时，会报告错误。

默认端口：

| 服务 | 地址 | 可配置变量 |
| --- | --- | --- |
| 引擎 | `http://127.0.0.1:8790` | `OCG_ENGINE_PORT`、`OCG_ENGINE_URL` |
| 后端 | `http://127.0.0.1:8787` | `BACKEND_PORT` |
| 前端 | `http://127.0.0.1:4173` | `FRONTEND_PORT` |

引擎 profile 默认为 `ygopro`，可通过 `OCG_ENGINE_PROFILE` 设置。新启动的本地引擎使用自动生成的令牌；连接已有引擎时需提供对应的 `OCG_ENGINE_TOKEN`。

## 健康检查

本项目提供 `GET /api/engine`，转发 sidecar 的 `/health` 状态；引擎未配置或不可达时返回 503。Vercel 接口只接受 `GET` 和预检 `OPTIONS`，不公开模拟操作。

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/engine"
```

若服务端显式设置 `RAG_FORMAL_ENGINE_MODE=formal-shadow` 或 `shadow`，该健康接口还会查询形式引擎能力。这是能力探测，不会让公开答题请求开始执行形式裁定。

## 远程连接

在独立主机部署 sidecar，通过 HTTPS 入口访问它，并在后端环境中设置：

```text
OCG_ENGINE_URL=https://engine.example.com
OCG_ENGINE_TOKEN=<与sidecar一致的令牌>
OCG_ENGINE_TIMEOUT_MS=20000
```

令牌只保存在服务端环境变量中。Vercel 环境变量修改后需要重新部署，再通过 `https://<后端域名>/api/engine` 检查连接。

原生引擎运行在独立主机，本项目的 Vercel 函数仅作为 HTTP 客户端。引擎主机的资源安装、更新和对局运行方法以引擎仓库文档为准。

## 客户端边界

- `backend/ocgEngineClient.mjs` 保留显式提交场景到 `/simulate` 的客户端，并核对返回的资源标识和摘要；模拟结果固定为非官方来源。
- `backend/formalEngineClient.mjs` 保留能力协商和形式分析客户端；接口记录与证书的检查不等于对实际裁定正确性的验收。
- Legacy Lua 客户端用于独立的脚本资料读取，其结果不能充当官方裁定。
- 上述客户端的存在不表示它们接入了公开问答流程。公开路径隔离由测试覆盖。

## 引擎复现段的显示（2026-10-16）

实验性的引擎复现段（`ENGINE_REPRO_ENABLED` 打开时运行，代码在 `backend/engineRepro/`）跟在主回答后面。段落里点名所用引擎是 ygopro（MyCard 版核心）。主回答正文里只放给用户看的短段，逐步回放不再拼进正文：

```
【ygopro 引擎复现（实验性）】已复现
ygopro（MyCard 版核心）在下面的局面里：我方在主要阶段1可以选择「发动超融合」。
局面：我方手卡 超融合，额外卡组 埃翁；对方场上 对极英雄 混沌侠、毁灭凤凰人（表侧攻击）。
假设：双方无其他适用效果；我方有填充卡可供舍弃。
判断模型认为官方 Q&A【「超融合」の効果は…】与本题条件一致，以该官方 Q&A 为准；ygopro 的结果只作参考。
ygopro 只显示它运行的结果，卡片脚本可能有 bug，不代表官方裁定。
```

- 短段由 `backend/engineRepro/concise.mjs` 生成：`engineReproDigest(record)` 从复现记录的结构化字段（`summary.status` / `reasonCodes`、`plan.assumptions`、各分支的 `assumption`、引擎结果的 `probes` / `decisions`、分支的起始 `scenario`、`cards`、准入失败时的 `error.code`）取出要显示的内容，`engineReproConciseText(digest, { officialQaMatches })` 排成文字。只做机械转述，不读题面文字，不判断主回答与引擎是否一致，也不判断谁对。
- 状态只有四类：已复现、部分复现、未复现、不适用，标题行都是“【ygopro 引擎复现（实验性）】”加状态。未复现和不适用只给状态和一句原因（原因码翻成人话）。等待超时显示“未完成”，说明“ygopro 引擎复现在等待上限内未完成……”。
- 复现自己的每日预算桶（`ENGINE_REPRO_DAILY_LIMIT_USD`）或每分钟限频（`ENGINE_REPRO_MAX_PER_MINUTE`）拒绝时（`error.code` 为 `engine_repro_daily_budget_exceeded` / `engine_repro_rate_limited`），短段只有一行：“【ygopro 引擎复现（实验性）】今日额度已用完，本题没有完成 ygopro 复现。”或“【ygopro 引擎复现（实验性）】每分钟次数已达上限，本题没有运行 ygopro 复现。”原因码仍记为 `budget_exceeded`。
- 每个探测点一句话：出现、未出现、未到达、核心自动发动；只能确认到卡时注明。时点取自引擎窗口的阶段和回合玩家；战斗步骤和伤害步骤里引擎决策的阶段不变（停在“战斗阶段开始”），引擎报告了战斗时点（窗口的 `timing.at`，ocg-sim-core 2026-10-18 起）时改用它（“伤害计算前”“对方回合的伤害步骤开始时”等）。多个子问题、同题两种假设的对照分支各占一行。
- 局面只列题目点名的卡（主回答识别出的卡）及其区域和表示形式；填充卡和其他辅助卡只写“（另有填充卡）”或“（另有其他辅助卡）”。不写区域编号、基本分、卡组张数、先攻。假设最多列 3 条，多出的写“等”。
- 官方 Q&A 那一行（2026-10-18 起）只在“对应判断”说某条官方 Q&A 与本题正好对应时显示，否则整行不显示。原来按证据包计数分三态的写法（其中“本题没有找到官方 Q&A”在线上总是出现，因为 Gemini 证据包不填那两个计数）已删除。
  - 候选：最终模型实际拿到的证据（`selectedPromptEvidenceRefs`）里的官方 Q&A（`recordType`/`type` 为 `qa` 或 `official_qa`），只取题面字段（标题、问题、详细场景），官方答案不发；卡号占位符按离线实验的写法渲染成“日文名／中文名”。材料在准备阶段由 `buildOfficialQaJudgeInput`（`backend/officialQaCorrespondence.mjs`）生成，存在 `continuation.officialQaJudgeInput`，不进最终提示词，也不进回答对象。
  - 调用：`backend/engineRepro/officialQaJudge.mjs`，GPT-6 Luna、推理 low、输出上限 6000，请求 30 秒超时（加上预算预约 / 结算的存储调用，最坏约 39 秒），走引擎复现自己的官方 API 调用和每日预算桶（不占每分钟次数）。单次请求形态在证据准备好后、最终模型调用前启动；两步请求在 finalize 开始时启动，都与最终模型调用并行。
  - 等待：引擎段先就绪；只有已复现 / 部分复现（能显示这一行）时才等判断结果，而且最多等到原来的等待截止时间（`waitDeadlineAt`，同 `ENGINE_REPRO_WAIT_BUDGET_MS`），到点不显示（`officialQaJudge.error = judge_wait_deadline`）。未复现、不适用、额度/限频、未完成和没有复现段时不等，只记录已经拿到的结果。请求体与离线实验（ocg-sim-core `experiments/official-qa-correspondence`，run-v1.1，low：判为找到 20/20 正确、应找到 21 处找到 20 处）逐字节相同。
  - 只认完成状态、且每个候选恰好一个 EXACT / PARTIAL / NOT 的输出；只有 EXACT 显示（用户口径：部分对应算没找到）。行文：“判断模型认为官方 Q&A【标题】与本题条件一致，以该官方 Q&A 为准；ygopro 的结果只作参考。”最多列两个标题，更多写“等 N 条”。没有候选、开关关闭（`ENGINE_REPRO_OFFICIAL_QA_JUDGE=off`）、预算拒绝、超时、HTTP 错误、输出不合格都不显示。
  - 只加在已复现 / 部分复现的短段里；未复现、不适用、额度/限频、未完成的短段不加。
  - 实验每题只有 2–3 条候选；线上候选可能更多，精确率不能直接外推。
- 各行之间用空行分隔，网页和按 Markdown 显示的 Bot 都会分行。
- 完整逐步回放（引擎服务渲染的全文，含每个窗口“本可发动”、区域编号、基本分、版本号、跳过的窗口数等调试信息，标题为“【ygopro 引擎复现（实验性，未经评测）】”）保留在响应的 `engineRepro.rendered` 和历史记录的 `engineRepro.rendered` 里。网页端在短段下面放一个默认折叠的“展开 ygopro 完整回放”区域，用等宽预格式化显示，保留原有换行；管理员历史记录另有“ygopro 引擎复现完整回放”一栏。API/Bot 渠道的 `shortAnswer` 只含短段。
- 响应的 `engineRepro` 另带 `concise`（短段原文）、`officialQaJudge`（判断结果摘要：状态、候选数、各判定的条数、EXACT 的条目、逐条判定与理由、耗时、费用；不含请求文本；没有判断时为 null）和 `digest`（短段用到的结构化数据）。原来的 `officialQaState` / `officialQaDirect` 已删除。
- 计划提示词写明四种宣言步骤（`announce_card` 宣言卡名用卡号、`announce_number`、`announce_attrib` / `announce_race` 用位值），宣言的卡号与计划里其他卡号一样要在允许列表内；需要宣言不再是“搭不出局面”的理由。抹杀之指名者的决策顺序在固定版本的引擎上实测过。

### 公开显示（阶段 4，2026-10-16 起）

2026-10-16 起引擎复现段对公开请求显示，仍为实验性功能。是否运行只看 `ENGINE_REPRO_ENABLED`：打开时，单次请求（`POST /api/answer`）和准备+生成两步请求（`action: "prepare"` / `"finalize"`）都对所有访客运行并显示，不再检查管理员会话；关闭时两种形态都不运行、不显示。

保留不变的限制：

- 复现自己的每日预算桶 `ENGINE_REPRO_DAILY_LIMIT_USD`（默认 1 美元，按 UTC 日期计）和每分钟限频 `ENGINE_REPRO_MAX_PER_MINUTE`（默认 6 次，每次复现计一次），都存在 Upstash 的独立键里，不动主回答的额度。用尽时短段只有一行（见上）。
- 等待上限：响应最多等到本次函数调用开始后 `DEFAULT_WAIT_BUDGET_MS`（`vercel.json` 里 `api/answer.js` 的 `maxDuration` 减 20 秒），可用 `ENGINE_REPRO_WAIT_BUDGET_MS` 调小；超时显示“未完成”，结果仍写入历史记录。
- 没启动的复现不等待（主流程在取到卡文之前就结束的请求，例如范围检查拒绝）。
- 历史记录（`engineRepro` 字段）和响应里的诊断字段与管理员阶段相同。
