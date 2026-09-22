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
