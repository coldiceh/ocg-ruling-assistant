# OCG 引擎接入

规则助手可以调用独立项目 [coldiceh/ocg-sim-core](https://github.com/coldiceh/ocg-sim-core)。本机默认使用相邻目录 `游戏王游戏引擎`。配置 `OCG_ENGINE_URL` 后，普通问题会在卡片检索完成后自动生成一份尽力模拟场景并单独执行；请求显式传入 `engineScenario` 时仍以该场景为准。

模拟器核心、ocgcore host、资源快照和卡片脚本均在 `ocg-sim-core` 维护。本仓库只保留 HTTP 客户端、API 适配层和联调启动脚本，不复制模拟器实现。

## 本地直接运行

首次使用先在引擎项目完成安装与真实冒烟：

```powershell
cd "D:\Documents\游戏王游戏引擎"
npm run setup:local
npm run smoke:real -- ygopro
```

以后从本项目一次启动引擎和 backend：

```powershell
cd "D:\Documents\游戏王裁定问答"
pnpm dev:with-engine
```

默认引擎根目录是相邻的 `游戏王游戏引擎`，地址是 `http://127.0.0.1:8790`，profile 是 `ygopro`。可以用 `OCG_ENGINE_ROOT`、`OCG_ENGINE_URL`、`OCG_ENGINE_PORT`、`OCG_ENGINE_PROFILE=ygopro2`、`OCG_ENGINE_TOKEN`、`OCG_ENGINE_TIMEOUT_MS` 和 `OCG_ENGINE_STARTUP_TIMEOUT_MS` 覆盖。

## API

- `GET /api/engine`：返回 sidecar 健康状态、能力和资源锁。
- `POST /api/engine`：请求体为 `{ "scenario": { ... } }` 或场景本身，直接返回模拟结果。
- `POST /api/answer`：照常传 `question`；未传 `engineScenario` 时自动尽力编译场景，显式传入时覆盖自动场景。

示例：

```json
{
  "question": "这个局面下能否发动？",
  "engineScenario": {
    "schemaVersion": "ocg-executable-scenario/v1",
    "seed": "ruling-case-001",
    "setup": {
      "cards": [
        { "team": 0, "duelist": 0, "code": 32864, "con": 0, "loc": "deck", "seq": 0, "pos": "facedown_defense" },
        { "team": 1, "duelist": 0, "code": 32864, "con": 1, "loc": "deck", "seq": 0, "pos": "facedown_defense" }
      ]
    },
    "options": {
      "flags": "2e800",
      "team1": { "startingLP": 8000, "startingDrawCount": 0, "drawCountPerTurn": 1 },
      "team2": { "startingLP": 8000, "startingDrawCount": 0, "drawCountPerTurn": 1 }
    },
    "responses": []
  }
}
```

自动场景会标记 `bestEffort=true`。若某一步计划与真实 core prompt 不一致，引擎停止在该 prompt 并返回 `responseFailure` 和已执行的部分轨迹，不会把整次模拟丢弃。可用 `RAG_AUTO_ENGINE_SIMULATION=false` 关闭自动编译。

响应可以直接按操作和卡号描述，运行器会根据当前 core prompt 解析实际索引：

```json
{
  "responses": [
    { "encoding": "idle_command", "action": "summon", "cardCode": 89631139 },
    { "encoding": "yes_no", "value": true },
    { "encoding": "card_selection", "cardCodes": [68468459] },
    { "encoding": "chain", "action": "pass" }
  ]
}
```

`idle_command`、`chain`、`card_selection` 和 `card_toggle` 支持 `cardCode`；同一卡号有多个候选时可再指定 `controller`、`location`、`sequence` 或 `occurrence`。这比保存菜单索引稳定，资源更新改变候选顺序时不会误选。

成功响应包含 `engine.status=completed`、`engineSimulation.sourceType=engine_simulation`、core 消息语义摘要、区域数量、字段查询、`traceSha256` 与完整 `resourceBinding`，并固定 `canConfirmOfficialRuling=false`。

引擎未配置时不会编译或请求自动场景。超时或拒绝资源时，原有 RAG 仍可回答且不会伪造执行结果；公开 UI 只在拿到成功轨迹后显示模拟器，`?debug=1` 才显示内部不可用状态。

## 证据边界

- 模拟可用于规则推演、反例、likely answer 与 debug trace。
- 模拟不会加入 `usedEvidence` 的官方直接证据。
- 模拟本身不能把 `finalStatus` 提升为 confirmed。
- 官方规则、FAQ、数据库 Q&A 与事务局材料优先于任何单一引擎结果。
- 若官方材料与模拟冲突，应调查 core/CDB/Lua Bug，而不是覆盖官方结论。

这是硬编码的证据门，不依赖模型自觉。

## 萌卡与先行卡更新

萌卡更新完成后无需手工复制文件：

```powershell
cd "D:\Documents\游戏王游戏引擎"
npm run resources:sync
npm run resources:status
npm run smoke:real -- ygopro
```

运行中的旧轨迹保留旧资源锁，新对局使用新 activation；同步失败不会破坏上一份可用 snapshot。选择 YGOPro2 时把 smoke/serve profile 改为 `ygopro2`。

未发售新卡由引擎项目的 `card:new` 创建 overlay。只有 `card.json` 数据完整、`source.status=verified`、release status 可运行、Lua 不含 `TODO` 并已进入有效脚本集合时，runtime 才会把它作为 card-data override 和高优先级 Lua 使用。详见引擎项目的 `docs/RUNBOOK.zh-CN.md`。

## Vercel / 云端

模拟器依赖 Windows 原生 `ocgcore`、CDB 和 Lua 资源，不能运行在 Vercel Serverless 函数里。线上结构必须是：

```text
浏览器 -> Vercel /api/answer -> HTTPS + Bearer Token -> Windows 模拟器 sidecar
```

未配置 `OCG_ENGINE_URL` 时，后端不会编译或请求自动场景，公开页面也不会显示模拟器区域。

### 1. 准备 Windows 引擎主机

使用一台可持续在线的 Windows 主机或 Windows VPS。安装 Git、Node.js 20+、Visual Studio 2022 的“使用 C++ 的桌面开发”和 x64 工具集，并准备 YGOPro/YGOPro2 资源。随后执行：

```powershell
git clone https://github.com/coldiceh/ocg-sim-core.git "D:\Services\ocg-sim-core"
cd "D:\Services\ocg-sim-core"
npm run setup:local
npm run smoke:real -- ygopro
```

生成一条独立的强随机令牌，并仅保存在引擎主机和 Vercel 环境变量中：

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$token = [Convert]::ToBase64String($bytes)
$token
```

启动 sidecar：

```powershell
$env:OCG_ENGINE_BIND = "127.0.0.1"
$env:OCG_ENGINE_PORT = "8790"
$env:OCG_ENGINE_TOKEN = "<上一步生成的令牌>"
cd "D:\Services\ocg-sim-core"
npm run serve -- --profile ygopro
```

生产环境应使用 Windows 服务管理器或任务计划程序让该命令随系统启动，并使用固定服务账号保存环境变量。不要直接开放 `8790` 端口。

### 2. 提供 HTTPS 地址

推荐使用 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)：在 Cloudflare 控制台创建 Tunnel，按控制台给出的 Windows 命令安装 `cloudflared`，再添加一个 Published Application：

- Hostname：例如 `engine.example.com`。
- Service type：`HTTP`。
- Service URL：`http://localhost:8790`。

Tunnel 自身的 connector token 与 `OCG_ENGINE_TOKEN` 是两种不同凭据；Vercel 请求模拟器时使用后者。Cloudflare Tunnel 是出站连接，无需把引擎主机暴露为公网 IP。Windows 上的 `cloudflared` 需要按官方说明手动更新。

从另一台机器验证公网入口：

```powershell
$url = "https://engine.example.com"
$token = "<OCG_ENGINE_TOKEN>"
Invoke-RestMethod -Uri "$url/health" -Headers @{ Authorization = "Bearer $token" }
```

### 3. 连接 Vercel

在 Vercel 项目的 `Settings -> Environment Variables` 中为 Production（需要时也包括 Preview）添加：

```text
OCG_ENGINE_URL=https://engine.example.com
OCG_ENGINE_TOKEN=<同一条强随机令牌>
RAG_AUTO_ENGINE_SIMULATION=true
OCG_ENGINE_TIMEOUT_MS=20000
```

将 `OCG_ENGINE_TOKEN` 标记为 Sensitive。Vercel 环境变量只会进入新部署，因此保存后必须重新部署。可通过 `https://<规则助手域名>/api/engine` 检查 Vercel 到 sidecar 的健康状态。

若暂时不部署，不要设置 `OCG_ENGINE_URL`；也可以显式设置 `RAG_AUTO_ENGINE_SIMULATION=false`。

## 能力边界

当前接入已能运行真实 ocgcore 场景，也会从自然语言中尽力提取玩家、区域、表示形式和操作顺序。自动场景不是可靠的完整对局还原；缺失事实会造成场景偏差，复杂 `MSG_SELECT_*` 也可能使轨迹提前停止，上游单卡脚本仍可能有 Bug。因此自动模拟只单独展示执行结果，不参与官方证据等级或最终裁定确认。

