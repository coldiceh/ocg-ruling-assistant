# OCG 引擎接入

Windows 上进行临时公网联调时，可直接按
[Quick Tunnel 中文步骤](./ocg-engine-quick-tunnel.md) 操作。

## 两条严格分离的路径

当前规则助手同时保留两条接口，但权威边界不同：

1. 旧 `/simulate` 是 YGOPro/native 兼容模拟，只用于轨迹、差分和调试，固定 `canConfirmOfficialRuling=false`。
2. 正式规则内核只允许通过 `GET /formal/v1/capabilities` 与 `POST /formal/v1/analyze-scenario` 接入；绝不回退 `/simulate` 冒充形式证明。

形式路径按以下顺序执行：题面和已解析卡片 → 检查独立题面完整性 verifier 与公共 proof verifier 已真实接线 → capability/version handshake → 本地卡名/不可变定义绑定预检 → 默认的非权威结构化抽取器生成只含原文引用、观测状态事实、高层意图和查询的 `ScenarioDraft` → UTF-16、实体、效果定义和 Schema 绑定 → 独立的题面完整性 verifier → 形式分析 → 证明证书与异步公共 proof verifier → `formal_engine_proof` 证据 → 最终模型与答案门禁。缺任一 verifier 时在任何网络或付费模型调用前返回 typed `UNKNOWN`。默认抽取器只是转录器，不是裁定者；模型不能凭自己的草案取得形式权威。

模型只能输出逐字 `sourceQuote`，不得自报 `sourceSpan`；服务器再以 JavaScript 字符串索引确定性生成偏移。编码固定为 `UTF16_CODE_UNIT_HALF_OPEN`，即 UTF-16 code unit 的左闭右开区间，且切片必须逐字等于原题片段。重复片段必须提供从 0 开始的 occurrence；无法唯一绑定时返回 `FORMAL_SOURCE_SPAN_INVALID`。

卡片实例的 span 还必须与服务器卡名解析所得的 `cardId` 一一对应；交换两个合法 cardId 与卡名 span 也会返回 `FORMAL_CARD_MENTION_MISMATCH`。题面明确写出①②等编号时，query/event/intent 的 effectId 必须同时匹配最近的准确卡名与编号；无法唯一消解的“该效果”保持 `FORMAL_EFFECT_MENTION_UNVERIFIED`，不能猜。实例可用的全部印刷效果由不可变 EffectDefinition 自动绑定，草案不能通过省略 effectId 隐藏效果。

启用影子模式：

```text
RAG_FORMAL_ENGINE_MODE=formal-shadow
DEEPSEEK_API_KEY=server-side-secret
# 可选；默认 deepseek-v4-flash、3200 tokens、15 秒、关闭思考
RAG_FORMAL_SCENARIO_DRAFT_MODEL=deepseek-v4-flash
RAG_FORMAL_SCENARIO_DRAFT_MAX_OUTPUT_TOKENS=3200
RAG_FORMAL_SCENARIO_DRAFT_TIMEOUT_MS=15000
RAG_FORMAL_SCENARIO_DRAFT_THINKING_MODE=disabled
# 必填：完整性 verifier 回执必须同时匹配这两个预期值
RAG_FORMAL_SCENARIO_DRAFT_VERIFIER_ID=deployment-specific-verifier-id
RAG_FORMAL_SCENARIO_DRAFT_VERIFIER_VERSION=deployment-specific-verifier-version
```

影子模式仍保持公开问答可用。系统先检查两个 verifier 已接线，并要求预先配置 ScenarioDraft verifier 的预期 ID 与版本，再探测 formal capability；缺少任一预期身份字段时会在网络探测和付费草案抽取前以 `FORMAL_SCENARIO_DRAFT_VERIFIER_IDENTITY_UNCONFIGURED` 关闭形式分支。verifier 回执的实际 ID 或版本不匹配时返回 `FORMAL_SCENARIO_DRAFT_VERIFIER_IDENTITY_MISMATCH`，不得进入分析端点或产生 formal evidence；实际与预期身份会随 `draftVerification` 进入可观测状态和已验证证据。真正发起的草案调用计入现有公开 DeepSeek 日预算，而且远端已完成但返回坏 JSON 时费用仍会记账。无 key、预算耗尽、卡名有 unresolved/ambiguous/omitted、缺不可变卡片/效果定义、快照不一致、离线、超时、取消请求、坏 JSON、source quote 歧义、Schema/实体/效果绑定错误、缺 capability、版本不匹配、题面完整性未验证、执行/搜索不完整、存在 unresolved semantics、证书无效或没有独立 verifier 时，结果保持 `UNKNOWN`；`UNKNOWN` 绝不转换成 `FALSE`，普通 RAG/最终模型路径仍继续执行。`dryRun` 不会请求 formal 端点或草案模型，客户端取消也会向这些请求传播。

特别地，DeepSeek 默认草案标记为 `MODEL_EXTRACTED_UNVERIFIED`。Schema 可以拒绝模型乱写结论，却无法仅凭结构证明模型没有漏掉题面中的限制卡或状态，所以没有独立完整性 verifier 时固定返回 `FORMAL_SCENARIO_DRAFT_UNVERIFIED`，连 capability 与草案模型都不会调用，也不会生成 trusted evidence。verifier 收到的是深冻结副本；返回后服务器重新校验原题、原草案和规划后 Scenario 的三个哈希，防止校验期间改写输入。只有真实卡 fixture 与不含真实卡名的匿名同构 fixture 都通过后，形式内核校验成功的 TRUE/FALSE 才可约束最终答案。通过门禁的证据也会深冻结，不能在签发后改写 verdict。

验收夹具分两层：`real-three-card.json` 和匿名同构件的 `question` 是明示了回合、阶段、开放行动时点、表示形式、可用区域、次数与其他适用效果的完全指定协议场景；其 `originalQuestion` 保留用户原始简写。原始简写不得偷用夹具默认值：在 `STRICT` 下固定因缺失开放时点、完整表示分支和相关状态而返回 `MISSING_STATE_FACT/UNKNOWN`；若用抽象裁定模式，必须把假设显示给用户，且证明只具有条件权威。mock completeness verifier 只测协议和哈希绑定，不代表引擎已完成语义验收。

`ScenarioDraft` 不能包含 `banishedByCardEffect`、`summonLegal`、`triggerActivates`、`finalChainNumber`、`canActivate`、`operationSuccessful`、`legal`、`verdict`、`trusted`、证书等内核派生结论。提交给 formal API 的 Scenario 顶层、题面、卡片实例、卡片/效果定义绑定、定义快照、source span、事实、事件、意图、查询、假设、回合和分支策略全部使用闭合字段 Schema；`forceOutcome`、`runtimeEffectOverrides` 等未声明字段在请求发出前即被拒绝。结果和证书中的 proof payload 仍按结果契约验证，不借此请求闭合规则删除证明数据。高层 `TRY_SUMMON_PROCEDURE` 只是意图，底层 operation 必须由引擎根据已绑定 EffectDefinition 编译。

### 当前精确阻塞项（2026-08-02）

只读审计相邻引擎后确认：声明式模块和部分谓词已经存在，但 HTTP service 目前仍只暴露 `/health` 与 `/simulate`。规则助手侧客户端、闭合 Schema、planner、默认非权威 draft 生成器、完整性门禁、shadow 管线和 mock contract 已可用；由于生产尚未接入两个独立 verifier，真实数据也尚无不可变 `formalDefinitionId`/snapshot/effect binding，现网正式请求会在付费草案调用前安全返回 `FORMAL_SCENARIO_DRAFT_VERIFIER_IDENTITY_UNCONFIGURED`、`FORMAL_SCENARIO_DRAFT_UNVERIFIED`、`FORMAL_PROOF_VERIFIER_UNAVAILABLE`、`ENGINE_FORMAL_API_UNAVAILABLE`、`FORMAL_DEFINITION_BINDING_MISSING` 或 `CAPABILITY_UNAVAILABLE`。引擎侧还需要：

- 实现上述两个 formal HTTP 端点；
- 发布与 capability 清单一致的版本号；
- 提供可独立调用的公共 proof verifier；
- 提供能证明题面抽取无遗漏、并绑定 question/draft/scenario 哈希的独立 ScenarioDraft completeness verifier（不能用两个 LLM 互相同意替代）；
- 为所需 EffectDefinition 提供稳定的 card/effect binding；
- 证明搜索、执行和响应分支完整，而不是仅执行调用方预先给出的 operation；
- 完整覆盖移动 provenance、手续离场后的最终目的地、TriggerWindow 与公开区/手牌诱发顺序。

本仓库不会复制这些规则语义，也不会为某道测试题伪造 TRUE。

规则助手可以调用独立项目 [coldiceh/ocg-sim-core](https://github.com/coldiceh/ocg-sim-core)。本机默认使用相邻目录 `游戏王游戏引擎`。旧模拟默认不自动运行；显式设置 `RAG_AUTO_ENGINE_SIMULATION=true` 后，普通问题才会在卡片检索完成后生成一份尽力模拟场景并单独执行。请求显式传入 `engineScenario` 时仍以该场景为准。

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

自动场景会标记 `bestEffort=true`。若某一步计划与真实 core prompt 不一致，引擎停止在该 prompt 并返回 `responseFailure` 和已执行的部分轨迹，不会把整次模拟丢弃。自动编译默认关闭，只能用 `RAG_AUTO_ENGINE_SIMULATION=true` 显式开启。

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
RAG_AUTO_ENGINE_SIMULATION=false
OCG_ENGINE_TIMEOUT_MS=20000
```

将 `OCG_ENGINE_TOKEN` 标记为 Sensitive。Vercel 环境变量只会进入新部署，因此保存后必须重新部署。可通过 `https://<规则助手域名>/api/engine` 检查 Vercel 到 sidecar 的健康状态。

旧 `/simulate` 默认关闭。只有需要兼容轨迹或差分调试时才显式设置
`RAG_AUTO_ENGINE_SIMULATION=true`；它仍然不参与最终裁定。

## 能力边界

当前接入已能运行真实 ocgcore 场景，也会从自然语言中尽力提取玩家、区域、表示形式和操作顺序。自动场景不是可靠的完整对局还原；缺失事实会造成场景偏差，复杂 `MSG_SELECT_*` 也可能使轨迹提前停止，上游单卡脚本仍可能有 Bug。因此自动模拟只单独展示执行结果，不参与官方证据等级或最终裁定确认。

