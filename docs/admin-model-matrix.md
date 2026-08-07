# 管理实验室模型矩阵 CLI

这个工具只在管理员实验室运行，不会改变公开回答所使用的模型。每道题只准备
一次证据，再通过后端 `fork` 接口让其他最终模型复用完全相同、带哈希校验的
冻结 Evidence Snapshot。标准答案文件不会被读取，也不会进入模型输入。

冻结快照保留完整 Evidence Archive；最终模型接收的是从 Archive 确定性生成的
Evidence Packet schema v2，默认最多 28 KiB / 16 项。Legacy Lua 的完整审计包也
保存在快照中，模型只接收最多 8 KiB、正式 `verdict` 始终为 `UNKNOWN` 的投影。
整个最终裁定输入另有 48 KiB UTF-8 硬上限。若复用的历史快照带有旧版大 Packet，
后端会校验并保留原快照，再从完整 Archive 按当前策略重投影，不会修改历史快照。

正式运行前，CLI 会登录并读取后端 capabilities；只有后端明确报告已配置
**持久化**管理模型预算账本，且证据准备池和所选最终模型池都有足够余额时，才允许创建运行。每个最终模型固定使用
`finalAttemptPolicy=single`，CLI 不进行模型重试或 JSON 修复调用；并发硬上限默认为
1。后端 Redis 预算账本仍是实际支出的最终硬门槛，CLI 的估算上限只是额外预检。
最终模型请求前，后端还会执行 `productionReadiness`：所有候选卡都必须唯一绑定，
且完整未节选卡文实际存在于模型可见 Packet；否则在 provider transport 前终止。

## 单题默认模型

当前默认只测试第三方中转的 Sol；DeepSeek V4 Flash（standard / none）负责准备检索提示。
Terra、Luna 和消融配置仍可由管理员显式传入，但在 Sol 四道门槛题全部通过前，不进入
默认批量或 GitHub Actions 工作流。中转模型身份和费率都未经本项目验证；报告会保留
requested model 与 returned model。

PowerShell：

```powershell
$env:ADMIN_MODEL_LAB_BASE_URL = "https://ocg-ruling-assistant.vercel.app"
$env:ADMIN_MODEL_LAB_ORIGIN = "https://coldiceh.github.io"
$Node = "C:\Users\11953\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

& $Node scripts/admin-model-matrix.mjs `
  --question "被禁止令宣言的怪兽能被仪式魔法解放吗？" `
  --format markdown `
  --output matrix.md
```

`$Node` 是可用的 Node.js 可执行文件。管理密码可以临时放在
`ADMIN_MODEL_LAB_PASSWORD`，也可以不设置；交互式终端会隐藏输入并询问密码。不要把
密码放在命令行参数、配置文件或提交记录中。

## 显式扩展边界

四题文件是
`tests/fixtures/admin-evidence-dry-run-cases.json`，只包含题面和候选卡，不包含标准
答案。标准答案位于另一个文件，模型矩阵不会加载它。

CLI 可以用重复的 `--config provider:model:reasoningMode:reasoningEffort` 显式扩大
矩阵，但不会自动启用五模型或执行四题全量实验。批量模式默认硬限制是 12 次最终
请求、10 元 CLI 估算上限和并发 1；超过任一上限会在创建运行前拒绝。若确实需要
更大实验，必须由管理员同时显式提高 `--max-final-requests` 与 `--max-cost-cny`，并
确保这仍符合 Redis 日额度，不能通过调低 `--estimated-cny-per-request` 规避预算。

配置可以追加第五段通用 Evidence 变体：
`provider:model:reasoningMode:reasoningEffort:evidenceVariant`。严格支持：

- `full`：完整决策资料包及 Lua 语义旁路；
- `card_text_only`：只保留题面、提供事实和完整准确卡文；
- `without_lua`：保留完整检索证据，但移除 Lua 语义旁路。

同一模型可以分别配置三种变体；它们 fork 同一冻结 Snapshot，并在报告中记录变体和
最终模型输入 SHA-256。标准答案只在调用完成后评分，不进入任何变体的模型输入。

创建新源运行时使用去重后配置列表的第一项；未传 `--config` 时只运行
Relay Sol / pro / high。显式配置矩阵时，
第一个 `--config` 就是新源配置，其余配置复用该源运行的冻结快照。
`--source-run-id` 是更窄的历史复用入口：它只允许单题模式复用严格匹配、已经冻结的
历史源运行。配置列表的第一项就是预期源配置；该 provider/model/mode/effort 必须由本次
capabilities 明确报告可用，并与历史运行的 execution profile、快照内请求、single 策略
及实际返回模型一致。其他模型即使在服务端 allowlist 中，也只有通过显式
`--config` 才会加入；capabilities 未配置、transport 不可用或预算池未就绪时记录为
`SKIPPED`，不会发请求。

例如复用一个已完成的 DeepSeek Flash（standard / none）运行，再只测试 Terra：

```powershell
& $Node scripts/admin-model-matrix.mjs `
  --question-file question.txt `
  --source-run-id "既有运行 ID" `
  --config deepseek:deepseek-v4-flash:standard:none `
  --config relay:relay-gpt-5.6-terra:pro:high
```

这里第一个 `--config` 只用于声明并校验历史源身份，不会重新执行该源；只有后续配置
会创建 fork 和最终模型请求。任一身份或快照字段不一致时，CLI 会在 fork 前拒绝。

第三方 Relay 的模型身份与价格均未经项目验证，且只允许出现在隔离的管理员实验室。
报告必须同时保留 requested model 与 returned model；returned model 也不能被解释为
供应商身份认证。Relay 配置不会注册公开 profile、不会改写公开默认模型，也不能在
公开主页选择。

Redis 预算池并非一个共享 `RELAY`：DeepSeek Flash/Pro（包括证据准备）共用
`DEEPSEEK`；Relay Sol、Terra、Luna 分别使用 `RELAY_SOL`、`RELAY_TERRA`、
`RELAY_LUNA`。若四个池各配置 10 元，其合计理论日硬上限才是 40 元；实际实验只会
使用所选模型对应的池。

## 零费用证据验收

正式模型测试前先运行：

```powershell
& $Node scripts/admin-evidence-snapshot-dry-run.mjs `
  --cases tests/fixtures/admin-evidence-dry-run-cases.json `
  --allow-community-card-network `
  --compact
```

这个命令只允许向 `https://ygocdb.com/api/v0/` 发 GET 请求来补卡片身份，并用本地
sentinel 阻止所有最终模型 transport。验收时应看到：

- `realProviderTransportCalls: 0`
- `allSnapshotsFrozen: true`
- 每题 `paidGateBlocked: false`
- 每题 `productionReadiness.ready: true`
- 所有候选卡 `bindingStatus: RESOLVED`

离线本地唯一近似匹配不等于稳定身份验证。若题面译名与本地卡库只有近似对应，而
没有可验证的外部 CID/passcode 或用户完整卡文，`productionReadiness` 会保持
fail-closed；`--allow-community-card-network` 只开放上面的百鸽只读身份补全，不开放
任何模型请求。

## 报告内容与边界

报告记录每个模型的 `conciseAnswer`、`verdicts`、`timeline`、requested/returned model、
Evidence Snapshot 哈希、运行总耗时、最终裁定耗时、Token、finish reason 和后端可计算
的费用。某个模型失败不会自动调用第二次，也不会阻止后续可用模型。
Relay SSE 运行还会记录响应头、首字节、首个有效事件、首个可见正文与完成耗时，以及
网络块/事件和响应/可见正文字节计数；隐藏 reasoning 内容不会进入报告或运行审计。

“最终请求单次”不代表证据准备永远只有一个 HTTP 请求。DeepSeek 证据准备在已确认
HTTP 200 且内容为空或非法 JSON 时，最多执行一次带独立预算预约的内容恢复。另有一个
协议级兼容分支：仅当携带 `response_format` 的证据准备请求被明确以 HTTP 400 拒绝时，
去掉该字段重试一次；没有该字段的 400、网络、超时、取消、429 和 5xx 均不重试。
这些分支都不增加矩阵报告中的最终裁定请求数，最终裁定本身仍固定单次。

CLI 不让被测模型给自己评分。运行完成后可将报告与独立 golden 文件进行人工或本地
结构化检查；不得把 golden、正确答案或 canary 合并进 cases 文件后发送给模型。

其他常用选项：

- `--poll-ms 1500`：轮询间隔。
- `--timeout-ms 600000`：每个运行的最长等待时间。
- `--source-run-id ID`：单题模式复用与第一个 `--config` 及 capabilities 严格匹配的已冻结源运行。
- `--output report.json`：写入文件；省略时输出到终端。
- `--estimated-input-tokens` / `--estimated-output-tokens`：默认中转费率估算的 Token 包络。
- `--budget-usd-to-cny`：预算换算因子，不是实时汇率。
