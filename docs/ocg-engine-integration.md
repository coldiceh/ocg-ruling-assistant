# OCG 引擎接入

裁定助手已经可以选择性调用独立项目 [coldiceh/ocg-sim-core](https://github.com/coldiceh/ocg-sim-core)。本机默认使用相邻目录 `游戏王游戏引擎`；普通问题仍走原有 RAG，只有请求带 `engineScenario` 时才运行确定性模拟。

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
- `POST /api/answer`：照常传 `question`，可额外传 `engineScenario`。

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

成功响应包含 `engine.status=completed`、`engineSimulation.sourceType=engine_simulation`、core 消息语义摘要、区域数量、字段查询、`traceSha256` 与完整 `resourceBinding`，并固定 `canConfirmOfficialRuling=false`。

引擎未配置、超时或拒绝资源时，响应会明确给出 `disabled` 或 `unavailable`。原有 RAG 仍可回答，但会附带风险，不会伪造执行结果。

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

Vercel Serverless 函数不能直接启动本机 Windows DLL/EXE。若不配置 `OCG_ENGINE_URL`，裁定助手照常提供 RAG，模拟明确显示 disabled。线上需要在受控主机单独部署 sidecar，并给 Vercel 配置 HTTPS `OCG_ENGINE_URL` 与同一 `OCG_ENGINE_TOKEN`。

sidecar 默认只绑定 `127.0.0.1`。若改为远程绑定，必须使用 token、TLS、网络访问控制和请求超时，不应把无鉴权端口公开到互联网。

## 能力边界

当前接入已能运行真实 ocgcore 场景，但不会把任意自然语言自动补全为可靠对局。关键的玩家、阶段、区域、表示形式、连锁与历史缺失时，应先向用户澄清。复杂 `MSG_SELECT_*` 尚需逐类增加高层 response codec；上游单卡脚本也仍可能有 Bug。

