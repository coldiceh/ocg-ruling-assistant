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

实验性的引擎复现段（`ENGINE_REPRO_ENABLED` 打开且为管理员会话时运行，代码在 `backend/engineRepro/`）跟在主回答后面。主回答正文里只放给用户看的短段，逐步回放不再拼进正文：

```
【引擎复现（实验性）】已复现
引擎在下面的局面里：我方在主要阶段1可以选择「发动超融合」。
局面：我方手卡 超融合，额外卡组 埃翁；对方场上 对极英雄 混沌侠、毁灭凤凰人（表侧攻击）。
假设：双方无其他适用效果；我方有填充卡可供舍弃。
本题没有找到直接对应的官方 Q&A：主回答是依据规则资料的分析，引擎结果是另一个独立来源，两者都可能有错。
引擎只显示它运行的结果，卡片脚本可能有 bug，不代表官方裁定。
```

- 短段由 `backend/engineRepro/concise.mjs` 生成：`engineReproDigest(record)` 从复现记录的结构化字段（`summary.status` / `reasonCodes`、`plan.assumptions`、各分支的 `assumption`、引擎结果的 `probes` / `decisions`、分支的起始 `scenario`、`cards`）取出要显示的内容，`engineReproConciseText(digest, { officialQaDirect })` 排成文字。只做机械转述，不读题面文字，不判断主回答与引擎是否一致，也不判断谁对。
- 状态只有四类：已复现、部分复现、未复现、不适用。未复现和不适用只给状态和一句原因（原因码翻成人话）。等待超时显示“未完成”。
- 每个探测点一句话：出现、未出现、未到达、核心自动发动；只能确认到卡时注明。时点取自引擎窗口的阶段和回合玩家。多个子问题、同题两种假设的对照分支各占一行。
- 局面只列题目点名的卡（主回答识别出的卡）及其区域和表示形式；填充卡和其他辅助卡只写“（另有填充卡）”或“（另有其他辅助卡）”。不写区域编号、基本分、卡组张数、先攻。假设最多列 3 条，多出的写“等”。
- 官方 Q&A 那一行是机械判断：看准备阶段证据包（`continuation.evidence`）里 `officialQaDirectCandidates` 是否为空，这个数由最终生成步骤原样写进回答的 `debug.retrievalCounts.officialQaDirectCandidates`，两种请求形态（单次、准备+生成）读的是同一个字段，与最终模型的措辞无关。读不到这个数时省略这一行。
- 各行之间用空行分隔，网页和按 Markdown 显示的 Bot 都会分行。
- 完整逐步回放（引擎服务渲染的全文，含每个窗口“本可发动”、区域编号、基本分、版本号、跳过的窗口数等调试信息）保留在响应的 `engineRepro.rendered` 和历史记录的 `engineRepro.rendered` 里。网页端在短段下面放一个默认折叠的“展开完整回放”区域，用等宽预格式化显示，保留原有换行；管理员历史记录另有“引擎复现完整回放”一栏。API/Bot 渠道的 `shortAnswer` 只含短段。
- 响应的 `engineRepro` 另带 `concise`（短段原文）、`officialQaDirect`（true / false / null）和 `digest`（短段用到的结构化数据）。
